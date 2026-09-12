// ============================================================================
// sysdiagnose.jsx — Recolector de diagnóstico del sistema
// ----------------------------------------------------------------------------
// Genera un "sysdiagnose" completo del SO virtual, replicando el
// comportamiento de iPadOS/macOS cuando pulsas el atajo de diagnóstico.
//
// FASES
//
//   1. TIME SENSITIVE
//      - Snapshot inmediato de procesos, memoria, uptime
//      - Recolecta info de hardware (navigator.*)
//
//   2. LOG GENERATION
//      - Ejecuta tareas de introspección sobre el sistema
//      - Sistema de archivos, red, batería, seguridad, keychain
//
//   3. LOG COPYING
//      - Copia logs históricos de syslogs/syscalls
//      - Recolecta crash reports y spindumps
//
//   4. LOG ARCHIVE
//      - Empaqueta todo en un objeto JSON grande
//      - Genera un Blob descargable (.json o .tar.gz simulado)
//
// RESULTADO
//
//   Un objeto con:
//     { id, startedAt, finishedAt, durationMs, phase, tasks, results, errors }
//
//   Y un método para exportar a Blob / JSON / texto plano.
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// FASES
// ============================================================================

export const DIAGNOSE_PHASE = Object.freeze({
  IDLE: "idle",
  TIME_SENSITIVE: "time-sensitive",
  LOG_GENERATION: "log-generation",
  LOG_COPYING: "log-copying",
  LOG_ARCHIVE: "log-archive",
  COMPLETE: "complete",
  FAILED: "failed",
  ABORTED: "aborted",
});

export const DIAGNOSE_EVENTS = Object.freeze({
  STARTED: "diagnose:started",
  PHASE_START: "diagnose:phase-start",
  PHASE_END: "diagnose:phase-end",
  TASK_START: "diagnose:task-start",
  TASK_END: "diagnose:task-end",
  TASK_FAILED: "diagnose:task-failed",
  PROGRESS: "diagnose:progress",
  COMPLETE: "diagnose:complete",
  FAILED: "diagnose:failed",
  ABORTED: "diagnose:aborted",
  LOG: "diagnose:log",
});

let _sessionCounter = 0;

// ============================================================================
// SESSION
// ============================================================================

class DiagnoseSession {
  constructor({ mode = "standard" } = {}) {
    this.id = `sysdiagnose_${new Date().toISOString().replace(/[:.]/g, "-")}_${++_sessionCounter}`;
    this.mode = mode;
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.phase = DIAGNOSE_PHASE.IDLE;
    this.tasks = [];
    this.results = {};
    this.errors = [];
    this.subsystemLog = [];
    this.progress = 0;
  }

  log(level, message, meta = null) {
    const entry = { ts: Date.now(), level, message, meta };
    this.subsystemLog.push(entry);
    kernelBus.emit(DIAGNOSE_EVENTS.LOG, entry);
  }

  toJSON() {
    return {
      id: this.id,
      mode: this.mode,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      durationMs: (this.finishedAt ?? Date.now()) - this.startedAt,
      phase: this.phase,
      tasks: this.tasks,
      results: this.results,
      errors: this.errors,
      subsystemLog: this.subsystemLog,
    };
  }
}

// ============================================================================
// CATÁLOGO DE TAREAS
// ============================================================================

const DIAGNOSE_TASKS = [
  // ---------------------------------------------- TIME SENSITIVE
  {
    id: "uptime",
    phase: DIAGNOSE_PHASE.TIME_SENSITIVE,
    category: "system",
    label: "Uptime del sistema",
    run: async (ctx) => ({
      uptimeMs: (typeof performance !== "undefined" ? performance.now() : Date.now()),
      bootTime: ctx.bootTime || null,
    }),
  },
  {
    id: "ps",
    phase: DIAGNOSE_PHASE.TIME_SENSITIVE,
    category: "process",
    label: "Listado de procesos",
    run: async (ctx) => {
      const processes = ctx.runtime?.getProcesses?.() ?? [];
      return {
        count: processes.length,
        processes: processes.map((p) => ({
          pid: p.pid,
          appId: p.appId,
          state: p.state,
          windows: p.windows?.length ?? 0,
        })),
      };
    },
  },
  {
    id: "vm_stat",
    phase: DIAGNOSE_PHASE.TIME_SENSITIVE,
    category: "memory",
    label: "Estadísticas de memoria",
    run: async () => {
      const mem = performance.memory;
      if (!mem) return { note: "performance.memory no disponible" };
      return {
        usedJSHeapSize: mem.usedJSHeapSize,
        totalJSHeapSize: mem.totalJSHeapSize,
        jsHeapSizeLimit: mem.jsHeapSizeLimit,
        usagePct: ((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100).toFixed(2),
      };
    },
  },
  {
    id: "sysctl",
    phase: DIAGNOSE_PHASE.TIME_SENSITIVE,
    category: "system",
    label: "sysctl",
    run: async () => ({
      kern: {
        osrelease: "27.0.0",
        osrevision: "24A5380l",
        hostname: "rainos.local",
        ostype: "rainOS",
      },
      hw: {
        ncpu: navigator.hardwareConcurrency || 4,
        memsize: (navigator.deviceMemory || 4) * 1024 ** 3,
        model: "RainOS Virtual Machine",
        machine: "x86_64-rain",
      },
    }),
  },
  {
    id: "df",
    phase: DIAGNOSE_PHASE.TIME_SENSITIVE,
    category: "storage",
    label: "Uso de disco",
    run: async () => {
      if (!navigator.storage?.estimate) return { note: "StorageManager no disponible" };
      const est = await navigator.storage.estimate();
      return {
        quotaBytes: est.quota,
        usageBytes: est.usage,
        usagePct: ((est.usage / est.quota) * 100).toFixed(2),
      };
    },
  },
  {
    id: "taskinfo",
    phase: DIAGNOSE_PHASE.TIME_SENSITIVE,
    category: "system",
    label: "Info de tareas y CPUs",
    run: async () => ({
      cores: navigator.hardwareConcurrency || 4,
      memoryGB: navigator.deviceMemory || 4,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  },

  // ---------------------------------------------- LOG GENERATION
  {
    id: "syslogs_snapshot",
    phase: DIAGNOSE_PHASE.LOG_GENERATION,
    category: "logs",
    label: "Snapshot de syslogs",
    run: async (ctx) => {
      const syslogs = ctx.syslogs;
      if (!syslogs) return { note: "SyslogSystem no disponible" };
      return {
        snapshot: syslogs.snapshot(),
        channels: syslogs.listChannels(),
        histogramLevel: syslogs.histogramByLevel(),
        histogramSubsystem: syslogs.histogramBySubsystem(),
      };
    },
  },
  {
    id: "syscalls_snapshot",
    phase: DIAGNOSE_PHASE.LOG_GENERATION,
    category: "syscalls",
    label: "Snapshot de syscalls",
    run: async (ctx) => {
      const syscalls = ctx.syscalls;
      if (!syscalls) return { note: "SyscallTable no disponible" };
      return {
        snapshot: syscalls.snapshot(),
        top: syscalls.topSyscalls(20),
      };
    },
  },
  {
    id: "battery",
    phase: DIAGNOSE_PHASE.LOG_GENERATION,
    category: "battery",
    label: "Info de batería",
    run: async (ctx) => {
      if (ctx.battery?.snapshot) return ctx.battery.snapshot();
      if (!navigator.getBattery) return { note: "Battery API no disponible" };
      try {
        const b = await navigator.getBattery();
        return {
          level: b.level,
          charging: b.charging,
          chargingTime: b.chargingTime,
          dischargingTime: b.dischargingTime,
        };
      } catch {
        return { note: "Battery API bloqueada" };
      }
    },
  },
  {
    id: "network",
    phase: DIAGNOSE_PHASE.LOG_GENERATION,
    category: "network",
    label: "Estado de red",
    run: async () => {
      const conn = navigator.connection;
      return {
        online: navigator.onLine,
        effectiveType: conn?.effectiveType ?? null,
        downlinkMbps: conn?.downlink ?? null,
        rttMs: conn?.rtt ?? null,
        saveData: conn?.saveData ?? null,
      };
    },
  },
  {
    id: "storage_local",
    phase: DIAGNOSE_PHASE.LOG_GENERATION,
    category: "storage",
    label: "LocalStorage",
    run: async () => {
      const keys = [];
      let totalBytes = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const v = localStorage.getItem(k) ?? "";
        keys.push({ key: k, size: v.length + k.length });
        totalBytes += v.length + k.length;
      }
      keys.sort((a, b) => b.size - a.size);
      return {
        entries: keys.length,
        totalBytes,
        top: keys.slice(0, 30),
      };
    },
  },
  {
    id: "window",
    phase: DIAGNOSE_PHASE.LOG_GENERATION,
    category: "graphics",
    label: "Info de pantalla y ventana",
    run: async () => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      availWidth: window.screen.availWidth,
      availHeight: window.screen.availHeight,
      colorDepth: window.screen.colorDepth,
      pixelDepth: window.screen.pixelDepth,
    }),
  },
  {
    id: "keychain",
    phase: DIAGNOSE_PHASE.LOG_GENERATION,
    category: "security",
    label: "Keychain",
    run: async (ctx) => {
      if (!ctx.security?.keychain) return { note: "keychain no disponible" };
      return ctx.security.keychain.snapshot();
    },
  },
  {
    id: "tcc",
    phase: DIAGNOSE_PHASE.LOG_GENERATION,
    category: "security",
    label: "TCC database",
    run: async (ctx) => {
      if (!ctx.security?.tcc) return { note: "TCC no disponible" };
      return ctx.security.tcc.snapshot();
    },
  },
  {
    id: "filevault",
    phase: DIAGNOSE_PHASE.LOG_GENERATION,
    category: "security",
    label: "FileVault",
    run: async (ctx) => {
      if (!ctx.security?.fileVault) return { note: "FileVault no disponible" };
      return ctx.security.fileVault.snapshot();
    },
  },
  {
    id: "sip",
    phase: DIAGNOSE_PHASE.LOG_GENERATION,
    category: "security",
    label: "System Integrity Protection",
    run: async (ctx) => {
      if (!ctx.security?.sip) return { note: "SIP no disponible" };
      return ctx.security.sip.snapshot();
    },
  },

  // ---------------------------------------------- LOG COPYING
  {
    id: "crashes",
    phase: DIAGNOSE_PHASE.LOG_COPYING,
    category: "crashes",
    label: "Crash reports",
    run: async (ctx) => ({
      count: ctx.crashes?.length ?? 0,
      crashes: (ctx.crashes || []).slice(-50),
    }),
  },
  {
    id: "spindumps",
    phase: DIAGNOSE_PHASE.LOG_COPYING,
    category: "crashes",
    label: "Spindumps",
    run: async (ctx) => ({
      count: ctx.spindumps?.length ?? 0,
      spindumps: (ctx.spindumps || []).slice(-20),
    }),
  },
  {
    id: "syslogs_full",
    phase: DIAGNOSE_PHASE.LOG_COPYING,
    category: "logs",
    label: "Logs completos (dump)",
    run: async (ctx) => {
      const syslogs = ctx.syslogs;
      if (!syslogs) return { note: "SyslogSystem no disponible" };
      return {
        text: syslogs.export({ format: "text", limit: 5000 }),
        syslog: syslogs.export({ format: "syslog", limit: 5000 }),
      };
    },
  },
  {
    id: "preferences",
    phase: DIAGNOSE_PHASE.LOG_COPYING,
    category: "config",
    label: "Preferencias",
    run: async () => {
      const prefs = {};
      const KEYS = [
        "initialconfig.config",
        "lockscreen.options",
        "tcc.db",
        "updater.settings",
        "notes.v1",
        "photos.library.v1",
        "music.library.v1",
      ];
      for (const k of KEYS) {
        try {
          const v = localStorage.getItem(k);
          if (v) prefs[k] = JSON.parse(v);
        } catch {}
      }
      return prefs;
    },
  },

  // ---------------------------------------------- LOG ARCHIVE
  {
    id: "archive",
    phase: DIAGNOSE_PHASE.LOG_ARCHIVE,
    category: "archive",
    label: "Empaquetado final",
    run: async (ctx) => {
      const json = JSON.stringify(ctx.session.toJSON());
      return {
        approxBytes: json.length,
        entryCount: Object.keys(ctx.session.results).length,
      };
    },
  },
];

// ============================================================================
// DIAGNOSE ENGINE
// ============================================================================

export class DiagnoseEngine {
  constructor({ ctxFactory } = {}) {
    this.ctxFactory = ctxFactory || (() => ({}));
    this.sessions = [];
    this.current = null;
    this.aborted = false;
    this.listeners = new Set();
    this.persist = true;
    this.storageKey = "rainos.diagnose.sessions";
    if (this.persist) this._loadSessions();
  }

  // -------------------------------------------------------------- subscribir
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(event, payload) {
    kernelBus.emit(event, payload);
    for (const fn of this.listeners) {
      try { fn(event, payload); } catch {}
    }
  }

  // -------------------------------------------------------------- storage
  _loadSessions() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.sessions = parsed.slice(-10);
    } catch {}
  }

  _saveSessions() {
    if (!this.persist) return;
    try {
      const trimmed = this.sessions.slice(-10).map((s) => ({
        id: s.id,
        mode: s.mode,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        durationMs: s.durationMs,
        phase: s.phase,
        errorCount: s.errors?.length ?? 0,
      }));
      localStorage.setItem(this.storageKey, JSON.stringify(trimmed));
    } catch {}
  }

  // -------------------------------------------------------------- abort
  abort() {
    this.aborted = true;
    this._emit(DIAGNOSE_EVENTS.ABORTED, {});
  }

  // -------------------------------------------------------------- main
  async run({ mode = "standard", onProgress = null } = {}) {
    this.aborted = false;
    const session = new DiagnoseSession({ mode });
    this.current = session;
    this.sessions.push(session);

    this._emit(DIAGNOSE_EVENTS.STARTED, { id: session.id, mode });

    // Contexto para las tareas
    const ctx = {
      ...this.ctxFactory(),
      session,
      bootTime: ctx.bootTime ?? null,
    };

    const totalTasks = DIAGNOSE_TASKS.length;
    let completed = 0;

    try {
      // Ejecutar fase por fase
      const phases = [
        DIAGNOSE_PHASE.TIME_SENSITIVE,
        DIAGNOSE_PHASE.LOG_GENERATION,
        DIAGNOSE_PHASE.LOG_COPYING,
        DIAGNOSE_PHASE.LOG_ARCHIVE,
      ];

      for (const phase of phases) {
        if (this.aborted) throw new Error("aborted");

        session.phase = phase;
        this._emit(DIAGNOSE_EVENTS.PHASE_START, { phase });
        session.log("info", `Begin phase: ${phase}`);

        const phaseTasks = DIAGNOSE_TASKS.filter((t) => t.phase === phase);

        for (const task of phaseTasks) {
          if (this.aborted) throw new Error("aborted");

          const started = Date.now();
          this._emit(DIAGNOSE_EVENTS.TASK_START, {
            taskId: task.id,
            category: task.category,
          });

          try {
            const result = await task.run(ctx);
            session.results[task.id] = {
              taskId: task.id,
              category: task.category,
              label: task.label,
              ok: true,
              durationMs: Date.now() - started,
              result,
            };
            this._emit(DIAGNOSE_EVENTS.TASK_END, {
              taskId: task.id,
              durationMs: Date.now() - started,
            });
            session.log("info", `Task ${task.id} ok`, { durationMs: Date.now() - started });
          } catch (err) {
            session.results[task.id] = {
              taskId: task.id,
              category: task.category,
              label: task.label,
              ok: false,
              error: String(err),
              durationMs: Date.now() - started,
            };
            session.errors.push({ taskId: task.id, error: String(err) });
            this._emit(DIAGNOSE_EVENTS.TASK_FAILED, {
              taskId: task.id,
              error: String(err),
            });
            session.log("error", `Task ${task.id} failed: ${err}`);
          }

          completed++;
          session.progress = Math.round((completed / totalTasks) * 100);
          this._emit(DIAGNOSE_EVENTS.PROGRESS, {
            progress: session.progress,
            current: completed,
            total: totalTasks,
          });
          onProgress?.(session.progress);
        }

        this._emit(DIAGNOSE_EVENTS.PHASE_END, { phase });
        session.log("info", `End phase: ${phase}`);
      }

      session.phase = DIAGNOSE_PHASE.COMPLETE;
      session.finishedAt = Date.now();
      this._emit(DIAGNOSE_EVENTS.COMPLETE, { id: session.id });
      this._saveSessions();
      return session;
    } catch (err) {
      session.phase = DIAGNOSE_PHASE.FAILED;
      session.finishedAt = Date.now();
      session.errors.push({ error: String(err) });
      this._emit(DIAGNOSE_EVENTS.FAILED, { error: String(err) });
      this._saveSessions();
      return session;
    }
  }

  // -------------------------------------------------------------- helpers
  listSessions() {
    return this.sessions.map((s) => ({
      id: s.id,
      mode: s.mode,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      phase: s.phase,
      errors: s.errors.length,
    }));
  }

  getCurrent() {
    return this.current;
  }

  /**
   * Devuelve el contenido completo del sysdiagnose como texto (JSON grande).
   */
  exportJSON(session = this.current) {
    if (!session) return "";
    return JSON.stringify(session.toJSON(), null, 2);
  }

  /**
   * Crea un Blob descargable del sysdiagnose.
   */
  exportBlob(session = this.current, { format = "json" } = {}) {
    if (!session) return null;
    const json = this.exportJSON(session);
    const mime = format === "json" ? "application/json" : "text/plain";
    return new Blob([json], { type: mime });
  }

  /**
   * Dispara una descarga en el navegador.
   */
  download(session = this.current, { format = "json" } = {}) {
    const blob = this.exportBlob(session, { format });
    if (!blob) return false;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${session.id}.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
}

// ============================================================================
// PROVIDER + HOOK
// ============================================================================

const DiagnoseContext = React.createContext(null);

export function DiagnoseProvider({
  children,
  engine: external,
  ctxFactory,
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new DiagnoseEngine({ ctxFactory });
  }
  const engine = ref.current;

  const [state, setState] = useState({
    running: false,
    progress: 0,
    phase: DIAGNOSE_PHASE.IDLE,
    currentId: null,
  });

  useEffect(() => {
    const off = engine.subscribe((event, payload) => {
      switch (event) {
        case DIAGNOSE_EVENTS.STARTED:
          setState({ running: true, progress: 0, phase: DIAGNOSE_PHASE.IDLE, currentId: payload.id });
          break;
        case DIAGNOSE_EVENTS.PHASE_START:
          setState((s) => ({ ...s, phase: payload.phase }));
          break;
        case DIAGNOSE_EVENTS.PROGRESS:
          setState((s) => ({ ...s, progress: payload.progress }));
          break;
        case DIAGNOSE_EVENTS.COMPLETE:
          setState({ running: false, progress: 100, phase: DIAGNOSE_PHASE.COMPLETE, currentId: payload.id });
          break;
        case DIAGNOSE_EVENTS.FAILED:
          setState((s) => ({ ...s, running: false, phase: DIAGNOSE_PHASE.FAILED }));
          break;
        case DIAGNOSE_EVENTS.ABORTED:
          setState((s) => ({ ...s, running: false, phase: DIAGNOSE_PHASE.ABORTED }));
          break;
        default:
          break;
      }
    });
    return off;
  }, [engine]);

  const api = useMemo(
    () => ({
      engine,
      ...state,
      run: (opts) => engine.run(opts),
      abort: () => engine.abort(),
      listSessions: () => engine.listSessions(),
      getCurrent: () => engine.getCurrent(),
      exportJSON: (s) => engine.exportJSON(s),
      exportBlob: (s, opts) => engine.exportBlob(s, opts),
      download: (s, opts) => engine.download(s, opts),
      phases: DIAGNOSE_PHASE,
      events: DIAGNOSE_EVENTS,
    }),
    [engine, state]
  );

  return (
    <DiagnoseContext.Provider value={api}>{children}</DiagnoseContext.Provider>
  );
}

export function useDiagnose() {
  const ctx = React.useContext(DiagnoseContext);
  if (!ctx) throw new Error("useDiagnose must be used within DiagnoseProvider");
  return ctx;
}

export default {
  DiagnoseEngine,
  DiagnoseSession,
  DiagnoseProvider,
  useDiagnose,
  DIAGNOSE_PHASE,
  DIAGNOSE_EVENTS,
  DIAGNOSE_TASKS,
};
