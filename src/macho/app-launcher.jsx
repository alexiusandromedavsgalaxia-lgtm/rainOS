// ============================================================================
// app-launcher.jsx — Lanzador de binarios Mach-O
// ----------------------------------------------------------------------------
// Este módulo es el ÚLTIMO eslabón de la cadena de ejecución:
//
//   importer.jsx      → parsea el Mach-O, resuelve imports
//   dyld.jsx          → resuelve símbolos, reubica, enlaza librerías
//   objc-runtime.jsx  → registra clases/métodos/protocolos
//   swift-runtime.jsx → registra metadata Swift, protocol conformances
//   libsystem.jsx     → expone la libc + libsystem_* al binario
//   corefoundation.jsx→ expone CF* al binario
//   app-launcher.jsx  → EJECUTA el binario  ← este archivo
//
// Responsabilidades:
//   - Construir el entorno de proceso (argc/argv/envp, stack inicial)
//   - Invocar el entry point (LC_MAIN o LC_UNIXTHREAD → _main / _start)
//   - Gestionar ciclo de vida: task_t, PID, threads, exit code
//   - Cargar frameworks del sistema bajo demanda
//   - Emitir eventos de ciclo de vida en kernelBus
//
// Convención:
//   - Clase pura `AppLauncher` sin React.
//   - Provider React fino (`AppLauncherProvider`) + hook `useAppLauncher()`.
//   - Todos los accesos externos con `?.()`.
// ============================================================================

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { kernelBus } from "../kernel/kernel.jsx";
import { MachoParser } from "../dmginstaller/macho-loader.jsx";
import { Dyld } from "./dyld.jsx";
import { ObjcRuntime } from "./objc-runtime.jsx";
import { SwiftRuntime } from "./swift-runtime.jsx";
import { LibSystem } from "./libsystem.jsx";
import { CfRuntime } from "./corefoundation.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

// Valores tomados de <mach-o/loader.h> y <sys/errno.h>
const LC_REQ_DYLD           = 0x80000000;
const LC_MAIN               = 0x28 | LC_REQ_DYLD;
const LC_UNIXTHREAD         = 0x05;
const LC_LOAD_DYLIB         = 0x0c;
const LC_LOAD_WEAK_DYLIB    = 0x18 | LC_REQ_DYLD;
const LC_REEXPORT_DYLIB     = 0x1f | LC_REQ_DYLD;
const LC_ID_DYLIB           = 0x0d;

const MH_EXECUTE            = 0x2;
const MH_DYLIB              = 0x6;
const MH_BUNDLE             = 0x8;

const CPU_TYPE_ARM64         = 0x0100000c;
const CPU_TYPE_X86_64        = 0x01000007;

// Estados del proceso
const PROC_STATE = Object.freeze({
  NEW:         "new",
  LOADING:     "loading",
  LINKING:     "linking",
  READY:       "ready",
  RUNNING:     "running",
  EXITED:      "exited",
  CRASHED:     "crashed",
  ZOMBIE:      "zombie",
});

// Códigos de salida
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_CRASHED = 139; // 128 + SIGSEGV
const EXIT_KILLED  = 137; // 128 + SIGKILL

// Frameworks que sabemos cargar bajo demanda
const SYSTEM_FRAMEWORKS = Object.freeze({
  Foundation:        "/System/Library/Frameworks/Foundation.framework/Foundation",
  AppKit:            "/System/Library/Frameworks/AppKit.framework/AppKit",
  UIKit:             "/System/Library/Frameworks/UIKit.framework/UIKit",
  SwiftUI:           "/System/Library/Frameworks/SwiftUI.framework/SwiftUI",
  CfRuntime:    "/System/Library/Frameworks/CfRuntime.framework/CfRuntime",
  CoreGraphics:      "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",
  CoreAudio:         "/System/Library/Frameworks/CoreAudio.framework/CoreAudio",
  CoreVideo:         "/System/Library/Frameworks/CoreVideo.framework/CoreVideo",
  CoreImage:         "/System/Library/Frameworks/CoreImage.framework/CoreImage",
  AVFoundation:      "/System/Library/Frameworks/AVFoundation.framework/AVFoundation",
  Metal:             "/System/Library/Frameworks/Metal.framework/Metal",
  MetalKit:          "/System/Library/Frameworks/MetalKit.framework/MetalKit",
  Network:           "/System/Library/Frameworks/Network.framework/Network",
  Security:          "/System/Library/Frameworks/Security.framework/Security",
  IOKit:             "/System/Library/Frameworks/IOKit.framework/IOKit",
  WebKit:            "/System/Library/Frameworks/WebKit.framework/WebKit",
  Combine:           "/System/Library/Frameworks/Combine.framework/Combine",
});

// ============================================================================
// UTILIDADES
// ============================================================================

let _pidCounter = 100;
const nextPid = () => ++_pidCounter;

const now = () =>
  typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();

/**
 * Convierte una Uint8Array en string ASCII, cortando en el primer NUL.
 */
function readCString(bytes, offset = 0) {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return String.fromCharCode(...bytes.subarray(offset, end));
}

/**
 * Convierte un string a Uint8Array con terminador NUL.
 */
function writeCString(str) {
  const out = new Uint8Array(str.length + 1);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  out[str.length] = 0;
  return out;
}

/**
 * Formatea bytes como hex para logs.
 */
function hex(n, pad = 8) {
  return "0x" + (n >>> 0).toString(16).padStart(pad, "0");
}

// ============================================================================
// CLASE PURA: AppProcess — representa un proceso en ejecución
// ============================================================================

export class AppProcess {
  constructor({ pid, path, argv, envp, task, macho, dyld, objc, swift }) {
    this.pid = pid ?? nextPid();
    this.path = path;
    this.argv = argv ?? [path];
    this.envp = envp ?? {};
    this.task = task ?? null;      // task_t virtual
    this.macho = macho;
    this.dyld = dyld;
    this.objc = objc;
    this.swift = swift;

    this.state = PROC_STATE.NEW;
    this.exitCode = null;
    this.exitSignal = null;

    this.startedAt = null;
    this.endedAt = null;

    this.threads = new Map();
    this.mainThreadId = 1;
    this._threadCounter = 1;

    this.frameworks = new Set();
    this.handles = new Map();      // fd → { kind, target }

    this._listeners = new Set();
  }

  // ---------------------------------------------------------------- estado

  setState(next) {
    const prev = this.state;
    if (prev === next) return;
    this.state = next;

    if (next === PROC_STATE.RUNNING && !this.startedAt) {
      this.startedAt = now();
    }
    if (
      (next === PROC_STATE.EXITED ||
        next === PROC_STATE.CRASHED ||
        next === PROC_STATE.ZOMBIE) &&
      !this.endedAt
    ) {
      this.endedAt = now();
    }

    kernelBus.emit("process:state-changed", {
      pid: this.pid,
      path: this.path,
      from: prev,
      to: next,
      at: now(),
    });

    for (const fn of this._listeners) {
      try {
        fn(next, prev);
      } catch (_) {}
    }
  }

  onStateChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // ---------------------------------------------------------------- threads

  spawnThread({ name = "pthread", entry = null, arg = null, detached = false } = {}) {
    const tid = ++this._threadCounter;
    const thread = {
      tid,
      name,
      entry,
      arg,
      detached,
      state: "running",
      createdAt: now(),
      finishedAt: null,
      cpuTicks: 0,
      stackSize: 512 * 1024,        // 512 KiB por defecto (como pthread)
    };
    this.threads.set(tid, thread);
    kernelBus.emit("process:thread-spawned", {
      pid: this.pid,
      tid,
      name,
    });
    return thread;
  }

  joinThread(tid) {
    const thread = this.threads.get(tid);
    if (!thread) return null;
    thread.state = "finished";
    thread.finishedAt = now();
    kernelBus.emit("process:thread-joined", { pid: this.pid, tid });
    return thread;
  }

  // ---------------------------------------------------------------- recursos

  openHandle({ kind, target, mode = "r" }) {
    const fd = this.handles.size + 3; // 0/1/2 reservados a stdin/stdout/stderr
    this.handles.set(fd, { kind, target, mode, openedAt: now() });
    kernelBus.emit("process:handle-opened", {
      pid: this.pid,
      fd,
      kind,
      target,
    });
    return fd;
  }

  closeHandle(fd) {
    if (!this.handles.has(fd)) return false;
    const h = this.handles.get(fd);
    this.handles.delete(fd);
    kernelBus.emit("process:handle-closed", {
      pid: this.pid,
      fd,
      kind: h.kind,
    });
    return true;
  }

  // ---------------------------------------------------------------- exit

  exit(code = EXIT_SUCCESS) {
    this.exitCode = code;
    this.exitSignal = null;
    this.setState(PROC_STATE.EXITED);
    kernelBus.emit("process:exited", {
      pid: this.pid,
      path: this.path,
      code,
      runtimeMs: this.startedAt ? now() - this.startedAt : 0,
    });
  }

  kill(signal = 9) {
    this.exitSignal = signal;
    this.exitCode = null;
    this.setState(PROC_STATE.ZOMBIE);
    kernelBus.emit("process:killed", {
      pid: this.pid,
      path: this.path,
      signal,
    });
  }

  crash(reason = "unknown") {
    this.exitCode = EXIT_CRASHED;
    this.exitSignal = 11; // SIGSEGV
    this.setState(PROC_STATE.CRASHED);
    kernelBus.emit("process:crashed", {
      pid: this.pid,
      path: this.path,
      reason,
    });
  }

  // ---------------------------------------------------------------- inspect

  toJSON() {
    return {
      pid: this.pid,
      path: this.path,
      argv: this.argv,
      state: this.state,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      runtimeMs: this.startedAt
        ? (this.endedAt ?? now()) - this.startedAt
        : 0,
      threadCount: this.threads.size,
      frameworks: [...this.frameworks],
      handles: [...this.handles.entries()].map(([fd, h]) => ({
        fd,
        ...h,
      })),
    };
  }
}

// ============================================================================
// CLASE PURA: AppLauncher — orquestador
// ============================================================================

export class AppLauncher {
  constructor({ security = null, syslogs = null, verbose = false } = {}) {
    this.security = security;
    this.syslogs = syslogs;
    this.verbose = verbose;

    this.processes = new Map();     // pid → AppProcess
    this._pidIndex = new Map();     // path → pid (para deduplicar)
    this._loadedFrameworks = new Set();

    this._stats = {
      launches: 0,
      successes: 0,
      failures: 0,
      crashes: 0,
      totalRuntimeMs: 0,
    };
  }

  // ---------------------------------------------------------------- log helpers

  _log(level, category, message, payload) {
    const fn = this.syslogs?.[level];
    if (typeof fn === "function") {
      try {
        fn.call(this.syslogs, "com.rainos.app-launcher", category, message, payload);
      } catch (_) {}
    }
    if (this.verbose && typeof console !== "undefined") {
      const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
      // eslint-disable-next-line no-console
      console[method](
        `[app-launcher] ${level.toUpperCase()} ${category}: ${message}`,
        payload ?? ""
      );
    }
  }

  // ---------------------------------------------------------------- check security

  _verifySecurity(macho, path) {
    if (!this.security) return { ok: true, reason: "no-security" };

    // Code signing
    if (typeof this.security.codeSigning?.verify === "function") {
      try {
        const result = this.security.codeSigning.verify(macho, { path });
        if (!result?.valid) {
          kernelBus.emit("sec:codesign-failed", {
            path,
            reason: result?.reason ?? "invalid-signature",
          });
          return { ok: false, reason: "codesign-failed" };
        }
      } catch (err) {
        kernelBus.emit("sec:codesign-failed", {
          path,
          reason: String(err),
        });
        return { ok: false, reason: "codesign-error" };
      }
    }

    // Gatekeeper
    if (typeof this.security.gatekeeper?.assess === "function") {
      try {
        const result = this.security.gatekeeper.assess({ path });
        if (!result?.allowed) {
          kernelBus.emit("sec:gatekeeper-blocked", { path, reason: result?.reason });
          return { ok: false, reason: "gatekeeper-blocked" };
        }
      } catch (err) {
        kernelBus.emit("sec:gatekeeper-blocked", {
          path,
          reason: String(err),
        });
        return { ok: false, reason: "gatekeeper-error" };
      }
    }

    return { ok: true, reason: "allowed" };
  }

  // ---------------------------------------------------------------- load frameworks

  _resolveDylibPath(installName) {
    // Install names tipo "@rpath/Foundation.framework/Foundation"
    // o rutas absolutas "/usr/lib/libSystem.B.dylib"
    const clean = installName
      .replace(/^@rpath\//, "")
      .replace(/^@loader_path\//, "")
      .replace(/^@executable_path\//, "");

    // ¿Es uno de los frameworks conocidos?
    for (const [shortName, fullPath] of Object.entries(SYSTEM_FRAMEWORKS)) {
      if (
        clean === shortName ||
        clean === `${shortName}.framework/${shortName}` ||
        clean.includes(`${shortName}.framework/`)
      ) {
        return { shortName, path: fullPath };
      }
    }

    // Librerías de /usr/lib
    if (clean.startsWith("lib") || installName.startsWith("/usr/lib/")) {
      return { shortName: clean, path: `/usr/lib/${clean}` };
    }

    // Fallback: usar el nombre tal cual
    return { shortName: clean, path: clean };
  }

  _loadFrameworkForDylib(installName, process) {
    const { shortName, path } = this._resolveDylibPath(installName);

    if (this._loadedFrameworks.has(shortName)) {
      process.frameworks.add(shortName);
      return { ok: true, cached: true, shortName, path };
    }

    kernelBus.emit("dylib:will-load", {
      pid: process.pid,
      installName,
      resolved: path,
      shortName,
    });

    try {
      // Cada framework tiene un "loader" que expone sus símbolos al dyld.
      // Aquí solo emitimos el evento; el dyld ya resolvió la tabla de símbolos.
      this._loadedFrameworks.add(shortName);
      process.frameworks.add(shortName);

      kernelBus.emit("dylib:did-load", {
        pid: process.pid,
        installName,
        resolved: path,
        shortName,
        at: now(),
      });

      return { ok: true, cached: false, shortName, path };
    } catch (err) {
      kernelBus.emit("dylib:load-failed", {
        pid: process.pid,
        installName,
        resolved: path,
        shortName,
        error: String(err),
      });
      return { ok: false, error: String(err), shortName, path };
    }
  }

  // ---------------------------------------------------------------- build initial stack

  _buildInitialStack({ argv, envp, argc, entryPoint, stackSize = 8 * 1024 * 1024 }) {
    // Layout real (simplificado) del stack inicial en Darwin:
    //
    //   [high addresses]
    //     auxv[]              (AT_EXECFN, AT_ENTRY, AT_PAGESZ, ...)
    //     NULL
    //     envp[]
    //     NULL
    //     argv[]
    //     argc                ← sp apunta aquí
    //   [low addresses]
    //
    // En nuestro emulador, generamos un objeto que el VCPU-executor puede
    // leer como si fuera el stack inicial. No reservamos memoria real.

    const auxv = [
      { key: "AT_EXECFN", value: 0 },
      { key: "AT_ENTRY",  value: entryPoint ?? 0 },
      { key: "AT_PAGESZ", value: 4096 },
      { key: "AT_PHDR",   value: 0 },
      { key: "AT_PHNUM",  value: 0 },
      { key: "AT_BASE",   value: 0 },
      { key: "AT_FLAGS",  value: 0 },
      { key: "AT_HWCAP",  value: 0 },
      { key: "AT_CLKTCK", value: 100 },
      { key: "AT_RANDOM", value: 0 },
      { key: "AT_NULL",   value: 0 },
    ];

    return {
      kind: "initial-stack",
      size: stackSize,
      sp: stackSize - 64,          // puntero de pila inicial (top - red zone)
      argc,
      argv: [...argv],
      envp: { ...envp },
      auxv,
      // offsets de strings en el stack (para que el executor los resuelva)
      strings: {
        argv: argv.map((s) => ({ offset: 0, value: s })),
        envp: Object.entries(envp).map(([k, v]) => ({
          offset: 0,
          value: `${k}=${v}`,
        })),
      },
    };
  }

  // ---------------------------------------------------------------- find entry point

  _findEntryPoint(macho) {
    const loads = macho?.loadCommands ?? [];

    // 1. LC_MAIN (formato moderno)
    for (const lc of loads) {
      if (lc.cmd === LC_MAIN) {
        return {
          kind: "LC_MAIN",
          entryOffset: lc.entryoff ?? 0,
          stackSize: lc.stacksize ?? 0,
        };
      }
    }

    // 2. LC_UNIXTHREAD (formato antiguo)
    for (const lc of loads) {
      if (lc.cmd === LC_UNIXTHREAD) {
        return {
          kind: "LC_UNIXTHREAD",
          pc: lc.pc ?? 0,
          sp: lc.sp ?? 0,
          registers: lc.registers ?? {},
        };
      }
    }

    // 3. Fallback: buscar símbolo `_main` en la tabla de símbolos
    const mainSym =
      macho?.symbols?.find?.((s) => s.name === "_main") ??
      macho?.exports?.find?.((s) => s.name === "_main");

    if (mainSym) {
      return {
        kind: "symbol",
        name: "_main",
        address: mainSym.address ?? mainSym.value ?? 0,
      };
    }

    // 4. Nada encontrado
    return { kind: "none" };
  }

  // ---------------------------------------------------------------- create task

  _createTask({ path, macho }) {
    return {
      taskId: `${path}#${now()}`,
      vmRegions: new Map(),
      ports: new Map(),
      memoryUsed: 0,
      createdAt: now(),
      cpuType: macho?.header?.cputype ?? CPU_TYPE_ARM64,
      cpuSubtype: macho?.header?.cpusubtype ?? 0,
    };
  }

  // ---------------------------------------------------------------- LAUNCH (público)

  /**
   * Ejecuta un binario Mach-O.
   *
   * @param {object} opts
   * @param {string}   opts.path        Ruta del binario (para logs/deduplicación)
   * @param {Uint8Array|object} opts.binary  Bytes o Mach-O ya parseado
   * @param {string[]} [opts.argv]      Argumentos (sin contar argv[0])
   * @param {object}   [opts.envp]      Variables de entorno
   * @param {string}   [opts.cwd]       Working directory
   * @param {boolean}  [opts.wait]      Si true, espera a que termine (sync)
   * @param {boolean}  [opts.dryRun]    Si true, no ejecuta, solo valida
   *
   * @returns {AppProcess}
   */
  launch({
    path,
    binary,
    argv = [],
    envp = {},
    cwd = "/",
    wait = false,
    dryRun = false,
    uid = 501,          // usuario por defecto
    gid = 20,
  } = {}) {
    const t0 = now();
    this._stats.launches++;

    // ---------------------------------------------------------- validación básica
    if (!path) {
      this._stats.failures++;
      const err = new Error("launch: falta `path`");
      this._log("error", "launch", err.message);
      throw err;
    }

    // ---------------------------------------------------------- parseo Mach-O
    let macho;
    try {
      if (binary instanceof Uint8Array || binary instanceof ArrayBuffer) {
        const bytes =
          binary instanceof Uint8Array ? binary : new Uint8Array(binary);
        const parser = new MachoParser(bytes, { path });
        macho = parser.parse();
      } else if (binary && typeof binary === "object") {
        macho = binary;
      } else {
        throw new Error("binary debe ser Uint8Array/ArrayBuffer/Mach-O ya parseado");
      }
    } catch (err) {
      this._stats.failures++;
      this._log("error", "parse", `Mach-O inválido: ${err.message}`, { path });
      kernelBus.emit("process:launch-failed", {
        path,
        stage: "parse",
        error: String(err),
      });
      throw err;
    }

    // ---------------------------------------------------------- verificar tipo
    const fileType = macho?.header?.filetype;
    if (
      fileType !== MH_EXECUTE &&
      fileType !== MH_DYLIB &&
      fileType !== MH_BUNDLE
    ) {
      this._stats.failures++;
      const msg = `Tipo Mach-O no ejecutable: ${fileType}`;
      this._log("error", "launch", msg, { path, fileType });
      kernelBus.emit("process:launch-failed", {
        path,
        stage: "filetype",
        error: msg,
      });
      throw new Error(msg);
    }

    // ---------------------------------------------------------- seguridad
    const secCheck = this._verifySecurity(macho, path);
    if (!secCheck.ok) {
      this._stats.failures++;
      this._log("warn", "security", `Launch bloqueado: ${secCheck.reason}`, { path });
      kernelBus.emit("process:launch-failed", {
        path,
        stage: "security",
        error: secCheck.reason,
      });
      throw new Error(`Seguridad: ${secCheck.reason}`);
    }

    // ---------------------------------------------------------- task virtual
    const task = this._createTask({ path, macho });

    // ---------------------------------------------------------- proceso
    const fullArgv = [path, ...argv];
    const proc = new AppProcess({
      path,
      argv: fullArgv,
      envp: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: "/Users/rain",
        USER: "rain",
        SHELL: "/bin/zsh",
        TMPDIR: "/tmp",
        LANG: "es_ES.UTF-8",
        TERM: "xterm-256color",
        PWD: cwd,
        RAINOS: "1",
        ...envp,
      },
      task,
      macho,
      dyld: null,
      objc: null,
      swift: null,
    });

    this.processes.set(proc.pid, proc);
    proc.setState(PROC_STATE.LOADING);

    kernelBus.emit("process:spawned", {
      pid: proc.pid,
      path,
      argv: fullArgv,
      uid,
      gid,
    });

    this._log("info", "launch", `Spawn pid=${proc.pid} ${path}`, {
      pid: proc.pid,
      argv: fullArgv,
    });

    // ---------------------------------------------------------- dry run
    if (dryRun) {
      proc.setState(PROC_STATE.READY);
      return proc;
    }

    // ---------------------------------------------------------- dyld
    let dyld;
    try {
      dyld = new Dyld({
        macho,
        path,
        envp: proc.envp,
        security: this.security,
      });
      dyld.load();

      const dylibs =
        macho?.loadCommands
          ?.filter?.((lc) =>
            lc.cmd === LC_LOAD_DYLIB ||
            lc.cmd === LC_LOAD_WEAK_DYLIB ||
            lc.cmd === LC_REEXPORT_DYLIB
          )
          ?.map?.((lc) => lc.name)
          ?.filter?.(Boolean) ?? [];

      for (const installName of dylibs) {
        const r = this._loadFrameworkForDylib(installName, proc);
        if (!r.ok) {
          this._log(
            "warn",
            "dylib",
            `No se pudo cargar ${installName} (continuando)`,
            { pid: proc.pid, installName }
          );
        }
      }

      proc.dyld = dyld;
      proc.setState(PROC_STATE.LINKING);
    } catch (err) {
      this._stats.failures++;
      proc.crash(`dyld: ${err.message}`);
      this._log("error", "dyld", `Fallo en dyld: ${err.message}`, {
        pid: proc.pid,
      });
      throw err;
    }

    // ---------------------------------------------------------- ObjC
    try {
      const objc = new ObjcRuntime({ macho, dyld, process: proc });
      objc.initialize?.();
      proc.objc = objc;
    } catch (err) {
      this._log("warn", "objc", `Runtime ObjC falló: ${err.message}`, {
        pid: proc.pid,
      });
    }

    // ---------------------------------------------------------- Swift
    try {
      const swift = new SwiftRuntime({ macho, dyld, process: proc });
      swift.initialize?.();
      proc.swift = swift;
    } catch (err) {
      this._log("warn", "swift", `Runtime Swift falló: ${err.message}`, {
        pid: proc.pid,
      });
    }

    // ---------------------------------------------------------- LibSystem + CF
    try {
      const libsystem = new LibSystem({ process: proc, dyld });
      libsystem.install?.();
      const cf = new CfRuntime({ process: proc, dyld });
      cf.install?.();
    } catch (err) {
      this._log("warn", "libsystem", `LibSystem falló: ${err.message}`, {
        pid: proc.pid,
      });
    }

    // ---------------------------------------------------------- stack inicial
    const entry = this._findEntryPoint(macho);
    if (entry.kind === "none") {
      this._stats.failures++;
      proc.crash("entry-point-missing");
      const msg = "No se encontró entry point (LC_MAIN/LC_UNIXTHREAD/_main)";
      this._log("error", "launch", msg, { pid: proc.pid });
      throw new Error(msg);
    }

    proc.initialStack = this._buildInitialStack({
      argv: fullArgv,
      envp: proc.envp,
      argc: fullArgv.length,
      entryPoint: entry.entryOffset ?? entry.address ?? entry.pc ?? 0,
    });

    proc.entry = entry;

    kernelBus.emit("process:entry-resolved", {
      pid: proc.pid,
      path,
      entry,
    });

    // ---------------------------------------------------------- main thread
    proc.mainThread = proc.spawnThread({
      name: "main",
      entry,
      detached: false,
    });

    // ---------------------------------------------------------- RUNNING
    proc.setState(PROC_STATE.RUNNING);

    // ---------------------------------------------------------- ejecución real
    try {
      this._execute(proc, entry);
    } catch (err) {
      proc.crash(String(err));
      this._stats.crashes++;
      this._log("error", "exec", `Crash en ejecución: ${err.message}`, {
        pid: proc.pid,
      });
      throw err;
    }

    // ---------------------------------------------------------- finalización
    const runtimeMs = now() - t0;
    this._stats.totalRuntimeMs += runtimeMs;

    if (proc.state === PROC_STATE.CRASHED) {
      this._stats.crashes++;
    } else {
      this._stats.successes++;
    }

    this._log(
      "info",
      "launch",
      `Proceso pid=${proc.pid} terminado en ${runtimeMs.toFixed(1)}ms (code=${proc.exitCode ?? "sig:" + proc.exitSignal})`,
      { pid: proc.pid, runtimeMs }
    );

    return proc;
  }

  // ---------------------------------------------------------------- execute entry

  /**
   * Ejecuta el entry point del binario. En este SO virtual:
   *   1. Emite el evento `process:will-execute`.
   *   2. Llama al `entryFn` si el macho expone un entry point ejecutable
   *      (por ejemplo, un script embebido en un bundle de rainOS).
   *   3. Si no hay entryFn, simula la ejecución: marca el proceso como EXITED
   *      con código 0. Esto cubre el caso de que solo queramos validar el boot
   *      del binario sin tener un VCPU real detrás.
   *   4. Emite `process:did-execute` (o `process:crashed`).
   */
  _execute(proc, entry) {
    kernelBus.emit("process:will-execute", {
      pid: proc.pid,
      path: proc.path,
      entry,
    });

    // Un binario Mach-O puede traer un "entryFn" adjunto (bundle nativo de
    // rainOS). Lo respetamos.
    const entryFn = proc.macho?.entryFn ?? null;
    if (typeof entryFn === "function") {
      const result = entryFn({
        pid: proc.pid,
        argv: proc.argv,
        envp: proc.envp,
        task: proc.task,
        process: proc,
      });
      const code =
        typeof result === "number" ? result : result?.code ?? EXIT_SUCCESS;
      proc.exit(code);
    } else {
      // No hay entry nativo: simulamos terminación limpia.
      proc.exit(EXIT_SUCCESS);
    }

    kernelBus.emit("process:did-execute", {
      pid: proc.pid,
      path: proc.path,
      exitCode: proc.exitCode,
      exitSignal: proc.exitSignal,
      runtimeMs: proc.startedAt ? now() - proc.startedAt : 0,
    });
  }

  // ---------------------------------------------------------------- management

  listProcesses() {
    return [...this.processes.values()].map((p) => p.toJSON());
  }

  getProcess(pid) {
    return this.processes.get(pid) ?? null;
  }

  killProcess(pid, signal = 9) {
    const p = this.processes.get(pid);
    if (!p) return false;
    p.kill(signal);
    return true;
  }

  reap() {
    // Limpia procesos zombis/exited
    let reaped = 0;
    for (const [pid, p] of [...this.processes.entries()]) {
      if (
        p.state === PROC_STATE.EXITED ||
        p.state === PROC_STATE.CRASHED ||
        p.state === PROC_STATE.ZOMBIE
      ) {
        this.processes.delete(pid);
        reaped++;
      }
    }
    return reaped;
  }

  stats() {
    return { ...this._stats };
  }

  reset() {
    this.processes.clear();
    this._loadedFrameworks.clear();
    this._stats = {
      launches: 0,
      successes: 0,
      failures: 0,
      crashes: 0,
      totalRuntimeMs: 0,
    };
  }
}

// ============================================================================
// PROVIDER REACT
// ============================================================================

const AppLauncherContext = createContext(null);

export function AppLauncherProvider({
  children,
  security = null,
  syslogs = null,
  verbose = false,
  autoReap = true,
  reapEveryMs = 60_000,
}) {
  const launcherRef = useRef(null);

  if (!launcherRef.current) {
    launcherRef.current = new AppLauncher({ security, syslogs, verbose });
  }

  const launcher = launcherRef.current;

  // Reap periódico de procesos terminados
  useEffect(() => {
    if (!autoReap) return;
    const t = setInterval(() => {
      try {
        const reaped = launcher.reap();
        if (reaped > 0) {
          kernelBus.emit("process:reaped", { count: reaped });
        }
      } catch (_) {}
    }, reapEveryMs);
    return () => clearInterval(t);
  }, [launcher, autoReap, reapEveryMs]);

  // Log de montaje
  useEffect(() => {
    kernelBus.emit("app-launcher:ready", { verbose });
    if (typeof syslogs?.info === "function") {
      syslogs.info(
        "com.rainos.app-launcher",
        "lifecycle",
        "AppLauncher listo",
        { verbose }
      );
    }
  }, [launcher, syslogs, verbose]);

  const value = useMemo(() => {
    return {
      launcher,
      launch: (opts) => launcher.launch(opts),
      listProcesses: () => launcher.listProcesses(),
      getProcess: (pid) => launcher.getProcess(pid),
      killProcess: (pid, sig) => launcher.killProcess(pid, sig),
      reap: () => launcher.reap(),
      stats: () => launcher.stats(),
      reset: () => launcher.reset(),
    };
  }, [launcher]);

  return (
    <AppLauncherContext.Provider value={value}>
      {children}
    </AppLauncherContext.Provider>
  );
}

export function useAppLauncher() {
  const ctx = useContext(AppLauncherContext);
  if (!ctx) {
    throw new Error(
      "useAppLauncher must be used within AppLauncherProvider"
    );
  }
  return ctx;
}

// ============================================================================
// EXPORTS AUXILIARES
// ============================================================================

export { PROC_STATE, EXIT_SUCCESS, EXIT_FAILURE, EXIT_CRASHED, EXIT_KILLED };
export { SYSTEM_FRAMEWORKS, MH_EXECUTE, MH_DYLIB, MH_BUNDLE, LC_MAIN, LC_UNIXTHREAD };
export { readCString, writeCString, hex };
