// ============================================================================
// app-launcher.jsx — Lanzador de apps Mach-O
// ----------------------------------------------------------------------------
// El pegamento entre el sistema operativo (rainOS) y una app de macOS real.
//
// Flujo completo:
//
//   1. Recibe bytes de un .app (o .dmg, o un binario suelto)
//   2. Detecta el Info.plist → identifica CFBundleExecutable
//   3. Extrae el binario Mach-O del bundle
//   4. Crea una VCPU nueva para este proceso
//   5. Instancia un Dyld con todos los subsistemas
//   6. Carga el binario + dependencias
//   7. Linkea, resuelve símbolos, ejecuta constructores
//   8. Llama a main()
//   9. Renderiza el output (si es GUI → se conecta al VGPU)
//
// El launcher expone una API simple:
//   await launch({ bundleBytes, vcpu, onOutput })
// ============================================================================

import { kernelBus } from "../kernel/kernel.jsx";
import { VCPU } from "../vcpu/vcpu.jsx";
import { Dyld } from "./dyld.jsx";
import { createExecutor } from "./xcode-executor.jsx";
import { MachoParser } from "./macho-loader.jsx";

export const LAUNCHER_EVENTS = Object.freeze({
  BUNDLE_RECEIVED: "launcher:bundle-received",
  INFO_PARSED: "launcher:info-parsed",
  EXECUTABLE_FOUND: "launcher:executable-found",
  PROCESS_SPAWNED: "launcher:process-spawned",
  READY: "launcher:ready",
  OUTPUT: "launcher:output",
  EXITED: "launcher:exited",
  CRASHED: "launcher:crashed",
  LOG: "launcher:log",
});

class LauncherLogger {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(LAUNCHER_EVENTS.LOG, e);
  }
  info(m, x) { this.push("info", m, x); }
  warn(m, x) { this.push("warn", m, x); }
  error(m, x) { this.push("error", m, x); }
}

// ============================================================================
// PLIST PARSER (binario + XML)
// ============================================================================

export class PlistParser {
  static parse(data) {
    if (typeof data === "string") return this._parseXML(data);
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    // Detectar binario
    if (bytes.length >= 8) {
      const magic = String.fromCharCode(...bytes.slice(0, 6));
      if (magic === "bplist") return this._parseBinary(bytes);
    }
    const text = new TextDecoder().decode(bytes);
    return this._parseXML(text);
  }

  static _parseXML(xml) {
    // Simple XML plist parser (no usa DOMParser para portabilidad)
    const out = {};
    const tagRe = /<(\/?)(\w+)[^>]*>([^<]*)<\/\2>|<(\w+)\/>/g;

    // Simplificación: solo soporta <key>...</key> seguido de un valor
    const lines = xml.split(/<(?=\w)/).map((l) => "<" + l.trim());
    let i = 0;
    const parseValue = (str) => {
      if (str.startsWith("<string>")) {
        const m = str.match(/<string>([\s\S]*?)<\/string>/);
        return m ? m[1] : "";
      }
      if (str.startsWith("<integer>")) {
        const m = str.match(/<integer>([\s\S]*?)<\/integer>/);
        return m ? parseInt(m[1], 10) : 0;
      }
      if (str.startsWith("<real>")) {
        const m = str.match(/<real>([\s\S]*?)<\/real>/);
        return m ? parseFloat(m[1]) : 0;
      }
      if (str.startsWith("<true")) return true;
      if (str.startsWith("<false")) return false;
      if (str.startsWith("<array>")) {
        const items = [];
        const inner = str.slice(7, -8);
        const parts = inner.split("<").map((p) => "<" + p);
        for (const p of parts) {
          if (p.length > 1) items.push(parseValue(p));
        }
        return items;
      }
      if (str.startsWith("<dict>")) {
        const dict = {};
        const inner = str.slice(6, -7);
        const entries = inner.split("<key>").filter(Boolean);
        for (const e of entries) {
          const keyMatch = e.match(/^([^<]*)<\/key>([\s\S]*)$/);
          if (keyMatch) {
            dict[keyMatch[1]] = parseValue("<" + keyMatch[2]);
          }
        }
        return dict;
      }
      return null;
    };

    const topMatch = xml.match(/<dict>([\s\S]*)<\/dict>/);
    if (topMatch) {
      return parseValue("<dict>" + topMatch[1] + "</dict>");
    }
    return out;
  }

  static _parseBinary(bytes) {
    // Binary plist parser completo (simplificado)
    // Header: "bplist00" + offset table + object table
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = String.fromCharCode(...bytes.slice(0, 8));
    if (magic !== "bplist00" && !magic.startsWith("bplist")) {
      throw new Error("invalid binary plist");
    }

    // El trailer está en los últimos 32 bytes
    const trailerOffset = bytes.length - 32;
    const offsetIntSize = view.getUint8(trailerOffset + 6);
    const objectRefSize = view.getUint8(trailerOffset + 7);
    const numObjects = Number(view.getBigUint64(trailerOffset + 8));
    const topObject = Number(view.getBigUint64(trailerOffset + 16));
    const offsetTableOffset = Number(view.getBigUint64(trailerOffset + 24));

    const readOffset = (index) => {
      const off = offsetTableOffset + index * offsetIntSize;
      let v = 0;
      for (let i = 0; i < offsetIntSize; i++) {
        v = (v << 8) | view.getUint8(off + i);
      }
      return v;
    };

    const readObject = (index, depth = 0) => {
      if (depth > 100) return null;
      const off = readOffset(index);
      const marker = view.getUint8(off);
      const type = marker >> 4;
      const info = marker & 0xf;

      switch (type) {
        case 0x0: {
          if (info === 0x0) return null;
          if (info === 0x8) return false;
          if (info === 0x9) return true;
          return null;
        }
        case 0x1: { // int
          const size = 1 << info;
          let v = 0n;
          for (let i = 0; i < size; i++) {
            v = (v << 8n) | BigInt(view.getUint8(off + 1 + i));
          }
          return Number(v);
        }
        case 0x2: { // real
          const size = 1 << info;
          if (size === 4) return view.getFloat32(off + 1, false);
          return view.getFloat64(off + 1, false);
        }
        case 0x3: { // date
          const seconds = view.getFloat64(off + 1, false);
          return new Date((seconds + 978307200) * 1000);
        }
        case 0x4: { // data
          const len = info === 0xf
            ? (() => {
                const sizeMarker = view.getUint8(off + 1);
                const sizeSize = 1 << (sizeMarker & 0xf);
                let v = 0;
                for (let i = 0; i < sizeSize; i++) v = (v << 8) | view.getUint8(off + 2 + i);
                return v;
              })()
            : info;
          const dataStart = info === 0xf ? off + 2 + (1 << (view.getUint8(off + 1) & 0xf)) : off + 1;
          return bytes.slice(dataStart, dataStart + len);
        }
        case 0x5: { // ASCII string
          const len = info === 0xf
            ? (() => {
                const sizeMarker = view.getUint8(off + 1);
                const sizeSize = 1 << (sizeMarker & 0xf);
                let v = 0;
                for (let i = 0; i < sizeSize; i++) v = (v << 8) | view.getUint8(off + 2 + i);
                return v;
              })()
            : info;
          const strStart = info === 0xf ? off + 2 + (1 << (view.getUint8(off + 1) & 0xf)) : off + 1;
          return String.fromCharCode(...bytes.slice(strStart, strStart + len));
        }
        case 0x6: { // UTF-16 string
          const len = info === 0xf ? view.getUint8(off + 2) : info;
          const strStart = info === 0xf ? off + 3 : off + 1;
          let s = "";
          for (let i = 0; i < len; i++) {
            s += String.fromCharCode(view.getUint16(strStart + i * 2, false));
          }
          return s;
        }
        case 0xa: { // array
          const count = info === 0xf
            ? (() => {
                const sizeMarker = view.getUint8(off + 1);
                const sizeSize = 1 << (sizeMarker & 0xf);
                let v = 0;
                for (let i = 0; i < sizeSize; i++) v = (v << 8) | view.getUint8(off + 2 + i);
                return v;
              })()
            : info;
          const arrStart = info === 0xf ? off + 2 + (1 << (view.getUint8(off + 1) & 0xf)) : off + 1;
          const items = [];
          for (let i = 0; i < count; i++) {
            let ref = 0;
            for (let j = 0; j < objectRefSize; j++) {
              ref = (ref << 8) | view.getUint8(arrStart + i * objectRefSize + j);
            }
            items.push(readObject(ref, depth + 1));
          }
          return items;
        }
        case 0xd: { // dict
          const count = info === 0xf
            ? (() => {
                const sizeMarker = view.getUint8(off + 1);
                const sizeSize = 1 << (sizeMarker & 0xf);
                let v = 0;
                for (let i = 0; i < sizeSize; i++) v = (v << 8) | view.getUint8(off + 2 + i);
                return v;
              })()
            : info;
          const dictStart = info === 0xf ? off + 2 + (1 << (view.getUint8(off + 1) & 0xf)) : off + 1;
          const dict = {};
          for (let i = 0; i < count; i++) {
            let keyRef = 0, valRef = 0;
            for (let j = 0; j < objectRefSize; j++) {
              keyRef = (keyRef << 8) | view.getUint8(dictStart + i * objectRefSize + j);
            }
            for (let j = 0; j < objectRefSize; j++) {
              valRef = (valRef << 8) | view.getUint8(dictStart + (count + i) * objectRefSize + j);
            }
            const key = readObject(keyRef, depth + 1);
            const val = readObject(valRef, depth + 1);
            if (key != null) dict[key] = val;
          }
          return dict;
        }
        default:
          return null;
      }
    };

    return readObject(topObject);
  }
}

// ============================================================================
// BUNDLE EXTRACTOR
// ============================================================================

export class AppBundle {
  constructor(bytes) {
    this.bytes = bytes;
    this.info = null;
    this.executable = null;
    this.resources = new Map();
  }

  async parse() {
    // Detectar si es un ZIP (los .app suelen estar comprimidos en un .zip o .dmg)
    if (this.bytes[0] === 0x50 && this.bytes[1] === 0x4b) {
      await this._parseZip();
    } else if (this.bytes[0] === 0xcf && this.bytes[1] === 0xfa) {
      // Mach-O comprimido o algo así
      throw new Error("unsupported container format");
    } else {
      // Asumimos que es el ejecutable directamente
      this.executable = this.bytes;
    }
    return this;
  }

  async _parseZip() {
    // Implementación minimal de ZIP para extraer .app
    // (usaríamos una librería real en producción)
    // Aquí hacemos un escaneo de las entradas del ZIP
    const entries = this._scanZipEntries();
    for (const entry of entries) {
      if (entry.name.endsWith("Info.plist")) {
        this.info = PlistParser.parse(entry.data);
      } else if (entry.name.includes("Contents/MacOS/")) {
        this.executable = entry.data;
        this.executableName = entry.name.split("/").pop();
      } else {
        this.resources.set(entry.name, entry.data);
      }
    }
    if (this.info) {
      kernelBus.emit(LAUNCHER_EVENTS.INFO_PARSED, {
        bundleId: this.info.CFBundleIdentifier,
        executable: this.info.CFBundleExecutable,
      });
    }
  }

  _scanZipEntries() {
    // Escaneo muy básico: buscamos los headers PK\x03\x04
    const entries = [];
    let i = 0;
    while (i < this.bytes.length - 4) {
      if (this.bytes[i] === 0x50 && this.bytes[i + 1] === 0x4b &&
          this.bytes[i + 2] === 0x03 && this.bytes[i + 3] === 0x04) {
        // Central directory entry
        const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + i);
        const compression = view.getUint16(8, true);
        const compressedSize = view.getUint32(18, true);
        const uncompressedSize = view.getUint32(22, true);
        const nameLen = view.getUint16(26, true);
        const extraLen = view.getUint16(28, true);
        const name = new TextDecoder().decode(this.bytes.slice(i + 30, i + 30 + nameLen));
        const dataStart = i + 30 + nameLen + extraLen;
        const data = this.bytes.slice(dataStart, dataStart + compressedSize);
        entries.push({ name, data, compression, compressedSize });
        i = dataStart + compressedSize;
      } else {
        i++;
      }
    }
    return entries;
  }
}

// ============================================================================
// APP LAUNCHER
// ============================================================================

export class AppLauncher {
  constructor({ onOutput = null, onEvent = null } = {}) {
    this.log = new LauncherLogger();
    this.onOutput = onOutput;
    this.onEvent = onEvent;
    this.running = new Map(); // pid → { vcpu, dyld, executor }
    this.pidCounter = 100;
    this.stats = {
      appsLaunched: 0,
      appsExited: 0,
      appsCrashed: 0,
    };
  }

  /**
   * Lanza una app desde bytes de un .app (ZIP) o desde un binario Mach-O directo.
   *
   * @param {Object} opts
   *   - bundleBytes: Uint8Array del .app (ZIP) o del ejecutable
   *   - bundlePath: ruta del bundle (para @executable_path)
   *   - argv: argumentos
   *   - env: variables de entorno
   *   - libraryResolver: función para resolver dylibs
   */
  async launch({
    bundleBytes,
    bundlePath = "/Applications/App.app",
    argv = [],
    env = {},
    libraryResolver = null,
    preferArch = "arm64",
  }) {
    const pid = ++this.pidCounter;
    kernelBus.emit(LAUNCHER_EVENTS.BUNDLE_RECEIVED, { pid, path: bundlePath });

    // 1. Parsear bundle
    const bundle = await new AppBundle(bundleBytes).parse();

    if (!bundle.executable) {
      throw new Error("no executable found in bundle");
    }

    kernelBus.emit(LAUNCHER_EVENTS.EXECUTABLE_FOUND, {
      pid,
      name: bundle.executableName || bundle.info?.CFBundleExecutable || "app",
    });

    // 2. Crear VCPU nueva para este proceso
    const vcpu = new VCPU({ id: pid });
    vcpu.init();

    // 3. Crear Dyld con todos los subsistemas
    const dyld = new Dyld({
      vcpu,
      searchPaths: [
        `${bundlePath}/Contents/Frameworks`,
        `${bundlePath}/Contents/MacOS`,
        "/usr/lib",
        "/System/Library/Frameworks",
      ],
    });
    dyld.init();

    // 4. Cargar
    await dyld.load({
      mainPath: `${bundlePath}/Contents/MacOS/${bundle.executableName || "App"}`,
      mainBytes: bundle.executable,
      mainSlide: 0x100000000n,
      libraryResolver,
    });

    // 5. Linkear
    await dyld.link();

    // 6. Crear executor según arquitectura
    const mainImage = dyld.mainExecutable;
    const arch = mainImage.macho.arch;
    const executor = createExecutor(vcpu, arch);

    // 7. Redirigir syscall write a nuestro callback
    const originalWrite = executor.syscalls.get(arch.startsWith("arm64") ? 0x04 : 0x2000004);
    executor.registerSyscall(
      arch.startsWith("arm64") ? 0x04 : 0x2000004,
      (cpu) => {
        const fd = arch.startsWith("arm64")
          ? Number(cpu.regs.gpr[0])
          : Number(cpu.regs.gpr[7]);
        const buf = arch.startsWith("arm64")
          ? Number(cpu.regs.gpr[1])
          : Number(cpu.regs.gpr[6]);
        const count = arch.startsWith("arm64")
          ? Number(cpu.regs.gpr[2])
          : Number(cpu.regs.gpr[2]);
        const bytes = executor.readMemory(buf, count);
        const text = new TextDecoder().decode(bytes);
        if (this.onOutput) {
          try { this.onOutput(text, { pid, fd }); } catch {}
        } else {
          console.log(`[app ${pid}]`, text);
        }
        kernelBus.emit(LAUNCHER_EVENTS.OUTPUT, { pid, fd, text });
        cpu.regs.gpr[0] = BigInt(count);
      }
    );

    this.running.set(pid, { vcpu, dyld, executor, bundle });

    kernelBus.emit(LAUNCHER_EVENTS.PROCESS_SPAWNED, {
      pid,
      arch,
      bundleId: bundle.info?.CFBundleIdentifier,
    });

    this.log.info(`process spawned: pid=${pid} arch=${arch}`);
    this.stats.appsLaunched++;

    // 8. Ejecutar main (en background)
    this._runAsync(pid, { argv, env });

    return pid;
  }

  async _runAsync(pid, { argv, env }) {
    const proc = this.running.get(pid);
    if (!proc) return;
    try {
      const result = await proc.dyld.run({
        executor: proc.executor,
        argv,
        env,
      });

      kernelBus.emit(LAUNCHER_EVENTS.EXITED, {
        pid,
        exitCode: 0,
        instructions: result.instructions,
      });
      this.stats.appsExited++;
    } catch (err) {
      kernelBus.emit(LAUNCHER_EVENTS.CRASHED, {
        pid,
        error: String(err),
      });
      this.log.error(`app crashed (pid ${pid})`, err);
      this.stats.appsCrashed++;
    } finally {
      this.running.delete(pid);
    }
  }

  kill(pid) {
    const proc = this.running.get(pid);
    if (!proc) return false;
    proc.vcpu.halt();
    this.running.delete(pid);
    return true;
  }

  list() {
    return Array.from(this.running.keys());
  }

  snapshot() {
    return {
      running: this.running.size,
      pids: this.list(),
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// HELPER: render GUI output al VGPU
// ============================================================================

export function connectGuiOutput(appLauncher, vgpu) {
  // Cuando la app llama a CoreGraphics/UIKit/AppKit, se traducen
  // a operaciones del VGPU. Este helper engancha el sistema.
  //
  // En una implementación completa, se registrarían símbolos como:
  //   - CGContextFillRect → vgpu.commandBuffer.fillRect
  //   - CGContextDrawImage → vgpu.commandBuffer.drawTexture
  //   - [UIView drawRect:] → vgpu.commandBuffer.drawQuad
  //   - [NSView display] → vgpu.commandBuffer.present
  //
  // Aquí dejamos un hook básico.
  return () => {
    // no-op
  };
}

export default {
  AppLauncher,
  AppBundle,
  PlistParser,
  connectGuiOutput,
  LAUNCHER_EVENTS,
};
