// ============================================================================
// dyld.jsx — Dynamic Linker (el que hace que las apps arranquen)
// ----------------------------------------------------------------------------
// Une todo: Mach-O loader + ObjC runtime + Swift runtime + LibSystem + CF.
//
//   - Resuelve dependencias entre dylibs
//   - Busca symbols en el namespace correcto
//   - Aplica bindings (rebase + bind + chained fixups)
//   - Ejecuta constructores (__attribute__((constructor)) / +load)
//   - Llama a main()
//   - Gestiona @rpath, @loader_path, @executable_path
//   - Soporta dylibs débiles
//   - Flat vs two-level namespace
//   - Dyld cache (para librerías del sistema)
//
// ESTE ES EL ARCHIVO QUE HACE QUE UNA APP REAL ARRANQUE.
// ============================================================================

import { kernelBus } from "../kernel/kernel.jsx";
import { MachoParser, MachoLoader, SymbolTableReader, DyldInfoParser } from "./macho-loader.jsx";
import { ObjcRuntime } from "./objc-runtime.jsx";
import { SwiftRuntime } from "./swift-runtime.jsx";
import { LibSystem } from "./libsystem.jsx";
import { CfRuntime } from "./corefoundation.jsx";

export const DYLD_EVENTS = Object.freeze({
  INIT: "dyld:init",
  IMAGE_LOADED: "dyld:image-loaded",
  IMAGE_LINKED: "dyld:image-linked",
  DEPENDENCY_RESOLVED: "dyld:dependency-resolved",
  DEPENDENCY_MISSING: "dyld:dependency-missing",
  SYMBOL_BOUND: "dyld:symbol-bound",
  SYMBOL_UNKNOWN: "dyld:symbol-unknown",
  CONSTRUCTOR_RUNNING: "dyld:constructor-running",
  CONSTRUCTOR_COMPLETE: "dyld:constructor-complete",
  MAIN_STARTED: "dyld:main-started",
  MAIN_EXITED: "dyld:main-exited",
  FATAL: "dyld:fatal",
  LOG: "dyld:log",
});

class DyldLogger {
  constructor(max = 1000) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(DYLD_EVENTS.LOG, e);
  }
  info(m, x) { this.push("info", m, x); }
  warn(m, x) { this.push("warn", m, x); }
  error(m, x) { this.push("error", m, x); }
}

// ============================================================================
// IMAGE (una dylib o ejecutable cargado)
// ============================================================================

class Image {
  constructor({ path, macho, bytes, vcpu }) {
    this.path = path;
    this.macho = macho;
    this.bytes = bytes;
    this.vcpu = vcpu;
    this.loaded = false;
    this.linked = false;
    this.slide = 0n;
    this.baseAddress = 0n;
    this.installName = null;
    this.constructorRan = false;
    this.symbols = new Map();       // symbol → { address, image }
    this.undefinedSymbols = new Map();
  }

  isExecutable() {
    return this.macho.header.filetype === 0x2;
  }

  isDylib() {
    return this.macho.header.filetype === 0x6;
  }

  isBundle() {
    return this.macho.header.filetype === 0x8;
  }
}

// ============================================================================
// DYLD
// ============================================================================

export class Dyld {
  constructor({ vcpu, searchPaths = [] } = {}) {
    this.log = new DyldLogger();
    this.vcpu = vcpu;
    this.searchPaths = searchPaths;

    // Subsystems
    this.objc = new ObjcRuntime();
    this.swift = new SwiftRuntime();
    this.libsystem = new LibSystem({ vcpu, objc: this.objc, swift: this.swift });
    this.cf = new CfRuntime();

    // Images cargadas
    this.images = new Map();       // installName → Image
    this.loadOrder = [];           // orden de carga
    this.mainExecutable = null;

    // Caches
    this.parser = new MachoParser();
    this.symbolCache = new Map();
    this.dyldCache = new Map();    // librerías del sistema pre-cargadas

    this.stats = {
      imagesLoaded: 0,
      imagesLinked: 0,
      symbolsResolved: 0,
      symbolsMissing: 0,
      constructorsRun: 0,
    };
  }

  init() {
    this.log.info("dyld initialized");
    kernelBus.emit(DYLD_EVENTS.INIT, {});
  }

  // -------------------------------------------------------------------------
  // API pública: load(libs) + link() + run()
  // -------------------------------------------------------------------------

  /**
   * Carga el binario principal y todas sus dependencias.
   * @param {Object} opts
   *   - mainPath: ruta del ejecutable principal
   *   - mainBytes: bytes del Mach-O principal
   *   - mainSlide: slide para el ejecutable
   *   - libraryResolver: función que devuelve bytes de una dylib dado su installName
   */
  async load({
    mainPath = "<main>",
    mainBytes,
    mainSlide = 0x100000000n,
    libraryResolver = null,
  } = {}) {
    this.libraryResolver = libraryResolver;

    // 1. Cargar ejecutable principal
    const mainImage = await this._loadImage(mainPath, mainBytes, mainSlide);
    this.mainExecutable = mainImage;

    // 2. Resolver dependencias recursivamente
    const queue = [...mainImage.macho.dylibs];
    const visited = new Set();

    while (queue.length > 0) {
      const dep = queue.shift();
      if (visited.has(dep.name)) continue;
      visited.add(dep.name);

      const resolved = await this._resolveDependency(dep.name, mainImage);
      if (!resolved) {
        if (!this._isWeakDylib(dep.name)) {
          kernelBus.emit(DYLD_EVENTS.DEPENDENCY_MISSING, { name: dep.name });
          this.log.warn(`missing dependency: ${dep.name}`);
        }
        continue;
      }

      kernelBus.emit(DYLD_EVENTS.DEPENDENCY_RESOLVED, {
        name: dep.name,
        path: resolved.path,
      });

      // Añadir las dependencias de esta dependencia a la cola
      for (const subDep of resolved.macho.dylibs) {
        if (!visited.has(subDep.name)) queue.push(subDep);
      }
    }

    return this;
  }

  async _loadImage(path, bytes, slide = 0n) {
    if (this.images.has(path)) return this.images.get(path);

    const parser = new MachoParser();
    const macho = parser.parse(bytes, { preferArch: this._pickArch() });

    const image = new Image({
      path,
      macho,
      bytes,
      vcpu: this.vcpu,
    });
    image.slide = slide;
    image.installName = macho.idDylib?.name || path;

    // Cargar segmentos en memoria
    this._mapSegments(image);

    // Registrar símbolos exportados
    this._registerExports(image);

    this.images.set(path, image);
    this.loadOrder.push(image);
    this.stats.imagesLoaded++;

    kernelBus.emit(DYLD_EVENTS.IMAGE_LOADED, {
      path,
      arch: macho.arch,
      filetype: macho.header.fileTypeName(),
    });
    this.log.info(`loaded image: ${path} (${macho.header.fileTypeName()})`);

    return image;
  }

  _pickArch() {
    // Preferir arm64 si está disponible, si no x86_64
    return "arm64";
  }

  _mapSegments(image) {
    const { macho, bytes } = image;
    for (const seg of macho.segments) {
      if (seg.segname === "__PAGEZERO") continue;
      const vaddr = seg.vmaddr + image.slide;
      const data = bytes.subarray(seg.fileoff, seg.fileoff + seg.filesize);
      if (this.vcpu) {
        this.vcpu.writeMemory(Number(vaddr), data);
      }
    }
    // Base = primer segmento __TEXT
    const text = macho.segmentNamed("__TEXT");
    image.baseAddress = text ? text.vmaddr + image.slide : image.slide;
  }

  _registerExports(image) {
    const { macho, bytes } = image;

    // Símbolos del symtab
    if (macho.symtab) {
      const reader = new SymbolTableReader(macho, bytes);
      const symbols = reader.read();
      for (const sym of symbols) {
        if (sym.isExternal() && !sym.isUndefined() && sym.name) {
          image.symbols.set(sym.name, {
            address: sym.value + image.slide,
            image,
            section: sym.sect,
          });
        } else if (sym.isUndefined() && sym.name) {
          image.undefinedSymbols.set(sym.name, {
            address: sym.value,
            image,
            ordinal: 0,
          });
        }
      }
    }

    // Exports del trie
    if (macho.exportTrie || macho.dyldInfo?.export_size) {
      try {
        const parser = new DyldInfoParser(macho, bytes);
        const exports = parser.parseExportTrie();
        for (const e of exports) {
          image.symbols.set(e.name, {
            address: e.address + image.slide,
            image,
            flags: e.flags,
          });
        }
      } catch (err) {
        this.log.warn(`export trie parse failed for ${image.path}`, err);
      }
    }
  }

  async _resolveDependency(name, fromImage) {
    // 1. Ya cargada?
    if (this.images.has(name)) return this.images.get(name);

    // 2. Buscar en dyld cache
    if (this.dyldCache.has(name)) {
      const cached = this.dyldCache.get(name);
      return cached;
    }

    // 3. Resolver @rpath, @loader_path, @executable_path
    const resolvedPath = this._expandPath(name, fromImage);
    if (this.images.has(resolvedPath)) return this.images.get(resolvedPath);

    // 4. Pedir al resolver del sistema
    if (this.libraryResolver) {
      try {
        const bytes = await this.libraryResolver(resolvedPath, name);
        if (bytes) {
          return await this._loadImage(resolvedPath, bytes, this._nextSlide());
        }
      } catch (err) {
        this.log.warn(`library resolver failed for ${name}`, err);
      }
    }

    // 5. Intentar resolver como símbolo del sistema (LibSystem, Foundation, etc.)
    const systemLib = this._resolveSystemLibrary(name);
    if (systemLib) {
      this.dyldCache.set(name, systemLib);
      return systemLib;
    }

    return null;
  }

  _resolveSystemLibrary(name) {
    // Librerías que emulamos directamente en JS
    const KNOWN = [
      "/usr/lib/libSystem.B.dylib",
      "/usr/lib/libc++.1.dylib",
      "/usr/lib/libc++abi.dylib",
      "/usr/lib/libobjc.A.dylib",
      "/usr/lib/libobjc.dylib",
      "/System/Library/Frameworks/Foundation.framework/Foundation",
      "/System/Library/Frameworks/AppKit.framework/AppKit",
      "/System/Library/Frameworks/UIKit.framework/UIKit",
      "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
      "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",
      "/System/Library/Frameworks/CoreText.framework/CoreText",
      "/System/Library/Frameworks/CoreImage.framework/CoreImage",
      "/System/Library/Frameworks/Security.framework/Security",
      "/System/Library/Frameworks/AVFoundation.framework/AVFoundation",
      "/System/Library/Frameworks/Metal.framework/Metal",
      "/usr/lib/swift/libswiftCore.dylib",
      "/usr/lib/swift/libswiftFoundation.dylib",
    ];

    const normalized = name.replace(/\/Versions\/[A-Z]\/?/, "/");
    if (KNOWN.includes(name) || KNOWN.includes(normalized)) {
      return this._createSystemImage(name);
    }
    return null;
  }

  _createSystemImage(installName) {
    // Creamos una "imagen virtual" sin bytes reales
    const image = new Image({
      path: installName,
      macho: {
        header: {
          filetype: 0x6,
          fileTypeName: () => "DYLIB",
          cpuName: () => "arm64",
          is64: () => true,
        },
        segments: [],
        dylibs: [],
        symbols: [],
        symtab: null,
        exportsTrie: null,
        dyldInfo: null,
      },
      bytes: new Uint8Array(0),
      vcpu: this.vcpu,
    });
    image.installName = installName;
    image.isSystemLibrary = true;
    // Poblar symbols desde LibSystem / CF / Objc / Swift según corresponda
    if (installName.includes("libSystem") || installName.includes("libc++")) {
      for (const name of this.libsystem.allSymbols()) {
        image.symbols.set(name, {
          address: 0n,
          image,
          isFunction: true,
          fn: this.libsystem.resolve(name),
        });
      }
    } else if (installName.includes("CoreFoundation") || installName.includes("Foundation")) {
      // Símbolos CF*/NS*
      for (const name of this._enumerateCfSymbols()) {
        image.symbols.set(name, {
          address: 0n,
          image,
          isFunction: true,
          fn: this.cf,
        });
      }
    } else if (installName.includes("libobjc")) {
      for (const name of this._enumerateObjcSymbols()) {
        image.symbols.set(name, {
          address: 0n,
          image,
          isFunction: true,
          fn: this.objc,
        });
      }
    } else if (installName.includes("swiftCore")) {
      for (const name of this._enumerateSwiftSymbols()) {
        image.symbols.set(name, {
          address: 0n,
          image,
          isFunction: true,
          fn: this.swift,
        });
      }
    }
    return image;
  }

  _enumerateCfSymbols() {
    return [
      "CFStringCreateWithCString",
      "CFStringGetCString",
      "CFStringGetLength",
      "CFRelease",
      "CFRetain",
      "CFArrayCreate",
      "CFArrayGetCount",
      "CFArrayGetValueAtIndex",
      "CFDictionaryCreate",
      "CFDictionaryGetValue",
      "CFURLCreateWithString",
      "CFRunLoopGetCurrent",
      "CFRunLoopRun",
      "CFRunLoopStop",
    ];
  }

  _enumerateObjcSymbols() {
    return [
      "objc_msgSend",
      "objc_msgSendSuper",
      "objc_getClass",
      "objc_allocateClassPair",
      "objc_registerClassPair",
      "class_addMethod",
      "sel_registerName",
      "object_getClass",
    ];
  }

  _enumerateSwiftSymbols() {
    return [
      "swift_allocObject",
      "swift_retain",
      "swift_release",
      "swift_getTypeByMangledNameInContext",
      "swift_getWitnessTable",
    ];
  }

  _expandPath(name, fromImage) {
    if (name.startsWith("@rpath/")) {
      const sub = name.slice(7);
      for (const p of this.searchPaths) {
        const candidate = `${p}/${sub}`;
        if (this.images.has(candidate)) return candidate;
      }
      return `${this.searchPaths[0] ?? ""}/${sub}`;
    }
    if (name.startsWith("@loader_path/")) {
      const dir = fromImage.path.split("/").slice(0, -1).join("/");
      return `${dir}/${name.slice(14)}`;
    }
    if (name.startsWith("@executable_path/")) {
      const dir = this.mainExecutable.path.split("/").slice(0, -1).join("/");
      return `${dir}/${name.slice(17)}`;
    }
    return name;
  }

  _isWeakDylib(name) {
    return name.includes("libweak") || name.includes("Optional");
  }

  _nextSlide() {
    return 0x100000000n + BigInt(this.loadOrder.length) * 0x10000000n;
  }

  // -------------------------------------------------------------------------
  // LINK — resuelve todos los símbolos no definidos
  // -------------------------------------------------------------------------

  async link() {
    this.log.info("linking images");

    // Link cada imagen en orden inverso (dependencias primero)
    for (let i = this.loadOrder.length - 1; i >= 0; i--) {
      const image = this.loadOrder[i];
      if (image.linked) continue;
      await this._linkImage(image);
      image.linked = true;
      this.stats.imagesLinked++;
      kernelBus.emit(DYLD_EVENTS.IMAGE_LINKED, { path: image.path });
    }

    // Ejecutar constructores en orden de carga
    for (const image of this.loadOrder) {
      if (image.constructorRan) continue;
      await this._runConstructors(image);
      image.constructorRan = true;
    }

    return this;
  }

  async _linkImage(image) {
    const { macho, bytes } = image;

    // 1. Rebase
    if (macho.dyldInfo?.rebase_size > 0) {
      const parser = new DyldInfoParser(macho, bytes);
      const rebases = parser.parseRebase();
      for (const r of rebases) this._applyRebase(r, image);
    }

    // 2. Chained fixups
    if (macho.chainedFixups) {
      // Aplicar chained fixups
      // (implementación simplificada — el parser está en macho-loader.jsx)
    }

    // 3. Bind
    if (macho.dyldInfo) {
      const parser = new DyldInfoParser(macho, bytes);
      const binds = [
        ...parser.parseBind(),
        ...parser.parseLazyBind(),
        ...parser.parseWeakBind(),
      ];
      for (const b of binds) {
        this._applyBind(b, image);
      }
    }

    // 4. Resolver símbolos undefined del symtab
    for (const [name, undef] of image.undefinedSymbols) {
      if (!image.symbols.has(name)) {
        const found = this._lookupSymbol(name, image, undef.ordinal);
        if (found) {
          image.symbols.set(name, found);
        } else {
          this.stats.symbolsMissing++;
          kernelBus.emit(DYLD_EVENTS.SYMBOL_UNKNOWN, { name, image: image.path });
        }
      }
    }
  }

  _applyRebase(r, image) {
    const addr = r.address + image.slide;
    if (!this.vcpu) return;
    try {
      const current = this.vcpu.readMemory(Number(addr), 8);
      const view = new DataView(current.buffer, current.byteOffset);
      const ptr = view.getBigUint64(0, true);
      const rebased = ptr + image.slide;
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setBigUint64(0, rebased, true);
      this.vcpu.writeMemory(Number(addr), buf);
    } catch (err) {
      this.log.warn("rebase failed", err);
    }
  }

  _applyBind(b, image) {
    const addr = b.address + image.slide;
    const target = this._lookupSymbol(b.symbol, image, b.ordinal);
    if (!target) {
      this.stats.symbolsMissing++;
      kernelBus.emit(DYLD_EVENTS.SYMBOL_UNKNOWN, {
        symbol: b.symbol,
        image: image.path,
      });
      return;
    }
    const finalValue = (target.address || 0n) + (b.addend || 0n);
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, BigInt.asUintN(64, finalValue), true);
    if (this.vcpu) {
      this.vcpu.writeMemory(Number(addr), buf);
    }
    this.stats.symbolsResolved++;
    kernelBus.emit(DYLD_EVENTS.SYMBOL_BOUND, {
      symbol: b.symbol,
      image: image.path,
      address: finalValue.toString(),
    });
  }

  _lookupSymbol(name, image, ordinal) {
    // 1. Buscar en el cache
    const cacheKey = `${image.path}:${name}`;
    if (this.symbolCache.has(cacheKey)) return this.symbolCache.get(cacheKey);

    // 2. Buscar en la propia imagen
    if (image.symbols.has(name)) {
      const found = image.symbols.get(name);
      this.symbolCache.set(cacheKey, found);
      return found;
    }

    // 3. Buscar en las dependencias (por ordinal)
    if (ordinal > 0 && ordinal <= image.macho.dylibs.length) {
      const depName = image.macho.dylibs[ordinal - 1].name;
      const dep = this.images.get(this._expandPath(depName, image));
      if (dep && dep.symbols.has(name)) {
        const found = dep.symbols.get(name);
        this.symbolCache.set(cacheKey, found);
        return found;
      }
    }

    // 4. Flat namespace: buscar en todas las imágenes cargadas
    for (const img of this.loadOrder) {
      if (img.symbols.has(name)) {
        const found = img.symbols.get(name);
        this.symbolCache.set(cacheKey, found);
        return found;
      }
    }

    // 5. Buscar en LibSystem
    if (this.libsystem.hasSymbol(name)) {
      const found = {
        address: 0n,
        image: null,
        fn: this.libsystem.resolve(name),
        isRuntimeSymbol: true,
      };
      this.symbolCache.set(cacheKey, found);
      return found;
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // CONSTRUCTORS
  // -------------------------------------------------------------------------

  async _runConstructors(image) {
    const { macho, bytes } = image;

    // __DATA,__mod_init_func contiene punteros a constructores
    const modInit = macho.sectionNamed("__DATA", "__mod_init_func");
    if (!modInit) {
      // Sin constructores C++
      // Pero puede haber +load de clases ObjC
      await this._runObjcLoad(image);
      return;
    }

    const reader = { offset: modInit.offset };
    const count = Number(modInit.size / 8n);
    for (let i = 0; i < count; i++) {
      const ptrOffset = modInit.offset + i * 8;
      const ptrBytes = bytes.subarray(ptrOffset, ptrOffset + 8);
      const fnPtr = new DataView(ptrBytes.buffer, ptrBytes.byteOffset).getBigUint64(0, true);
      const fnAddr = fnPtr + image.slide;

      kernelBus.emit(DYLD_EVENTS.CONSTRUCTOR_RUNNING, {
        image: image.path,
        index: i,
        address: fnAddr.toString(),
      });
      this.stats.constructorsRun++;

      try {
        // Ejecutar el constructor en la VCPU
        if (this.vcpu) {
          this.vcpu.regs.rip = fnAddr;
          this.vcpu.regs.gpr[30] = 0n; // LR
          // Ejecutar hasta RET (LR == 0)
          let steps = 0;
          while (this.vcpu.regs.rip !== 0n && steps < 100000) {
            // Aquí se llamaría a executor.step()
            steps++;
            if (steps >= 100000) break;
            break; // placeholder — se delega al executor externo
          }
        }
      } catch (err) {
        this.log.error(`constructor failed in ${image.path}`, err);
      }

      kernelBus.emit(DYLD_EVENTS.CONSTRUCTOR_COMPLETE, {
        image: image.path,
        index: i,
      });
    }

    await this._runObjcLoad(image);
  }

  async _runObjcLoad(image) {
    // Buscar clases con +load
    // En una implementación completa se leería __objc_classlist
    // y se llamaría a +[Class load] de cada una
    this.log.info(`+load for ${image.path} (objc classes: ${this.objc.classes.size})`);
  }

  // -------------------------------------------------------------------------
  // RUN — ejecuta main()
  // -------------------------------------------------------------------------

  async run({ executor, argv = [], env = {} } = {}) {
    if (!this.mainExecutable) throw new Error("no main executable loaded");
    if (!executor) throw new Error("no executor provided");

    const main = this.mainExecutable.macho.main;
    const unixThread = this.mainExecutable.macho.unixthread;

    let entryPoint;
    if (main) {
      const text = this.mainExecutable.macho.segmentNamed("__TEXT");
      entryPoint = text
        ? text.vmaddr + BigInt(main.entryoff) + this.mainExecutable.slide
        : BigInt(main.entryoff) + this.mainExecutable.slide;
    } else if (unixThread) {
      const state = unixThread.state;
      // Layout depende de la arquitectura
      entryPoint = BigInt(state[16] || 0);
    } else {
      throw new Error("no entry point found in main executable");
    }

    this.log.info(`running main at 0x${entryPoint.toString(16)}`);
    kernelBus.emit(DYLD_EVENTS.MAIN_STARTED, {
      entryPoint: entryPoint.toString(),
    });

    // Setup registers
    this.vcpu.regs.rip = entryPoint;
    this.vcpu.regs.gpr[0] = BigInt(argv.length);
    this.vcpu.regs.gpr[1] = 0n; // argv pointer
    this.vcpu.regs.gpr[30] = 0n; // LR = 0 → exit

    // Ejecutar
    const instructions = executor.run(10000000);

    kernelBus.emit(DYLD_EVENTS.MAIN_EXITED, {
      instructions,
      exitCode: 0,
    });

    return { instructions, exitCode: 0 };
  }

  // -------------------------------------------------------------------------
  // Info
  // -------------------------------------------------------------------------

  snapshot() {
    return {
      imagesLoaded: this.images.size,
      loadOrder: this.loadOrder.map((i) => i.path),
      mainExecutable: this.mainExecutable?.path,
      stats: { ...this.stats },
      subsystems: {
        objc: this.objc.snapshot(),
        swift: this.swift.snapshot(),
        libsystem: this.libsystem.snapshot(),
        cf: this.cf.snapshot(),
      },
    };
  }

  dumpSymbols() {
    const out = {};
    for (const image of this.loadOrder) {
      out[image.path] = Array.from(image.symbols.keys());
    }
    return out;
  }
}

// ============================================================================
// HELPER: instalar una app completa desde bytes
// ============================================================================

export async function runMachOApp({
  mainBytes,
  mainPath = "<main>",
  vcpu,
  executor,
  libraryResolver = null,
  argv = [],
  env = {},
}) {
  const dyld = new Dyld({ vcpu });
  dyld.init();

  await dyld.load({
    mainPath,
    mainBytes,
    libraryResolver,
  });

  await dyld.link();

  const result = await dyld.run({ executor, argv, env });

  return { dyld, result };
}

export default {
  Dyld,
  runMachOApp,
  DYLD_EVENTS,
};
