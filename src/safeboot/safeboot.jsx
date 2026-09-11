// ============================================================================
// safeboot.jsx — SafeBoot del kernel de macOS
// ----------------------------------------------------------------------------
// Gestiona el arranque del sistema operativo virtual:
// - Secuencia de fases (power-on → POST → kernel init → services → UI ready)
// - Carga de servicios con dependencias (grafo topológico)
// - Registro de extensiones (kexts)
// - Comprobación de integridad (checksums / validaciones)
// - Recuperación de sesión previa (restore desde snapshot)
// - Fallback a Safe Mode si algo falla
// - Watchdog por servicio con timeout
// - Telemetría de tiempos de arranque
// - Todo sin UI. Solo lógica.
// ============================================================================

import React, {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";

import { kernelBus, KERNEL_EVENTS, WindowManager } from "../kernel/kernel.jsx";

// ============================================================================
// FASES DE ARRANQUE
// ============================================================================

export const BOOT_PHASE = Object.freeze({
  OFF: "off",
  POWER_ON: "power-on",
  POST: "post",
  LOADER: "loader",
  KERNEL_INIT: "kernel-init",
  LOAD_EXTENSIONS: "load-extensions",
  LOAD_SERVICES: "load-services",
  RESTORE_SESSION: "restore-session",
  START_WINDOW_MANAGER: "start-window-manager",
  READY: "ready",
  SAFE_MODE: "safe-mode",
  FAILED: "failed",
});

export const BOOT_ORDER = Object.freeze([
  BOOT_PHASE.OFF,
  BOOT_PHASE.POWER_ON,
  BOOT_PHASE.POST,
  BOOT_PHASE.LOADER,
  BOOT_PHASE.KERNEL_INIT,
  BOOT_PHASE.LOAD_EXTENSIONS,
  BOOT_PHASE.LOAD_SERVICES,
  BOOT_PHASE.RESTORE_SESSION,
  BOOT_PHASE.START_WINDOW_MANAGER,
  BOOT_PHASE.READY,
]);

export const SAFE_BOOT_PHASES = Object.freeze([
  BOOT_PHASE.OFF,
  BOOT_PHASE.POWER_ON,
  BOOT_PHASE.POST,
  BOOT_PHASE.KERNEL_INIT,
  BOOT_PHASE.START_WINDOW_MANAGER,
  BOOT_PHASE.SAFE_MODE,
]);

// ============================================================================
// EVENTOS DEL SAFEBOOT
// ============================================================================

export const BOOT_EVENTS = Object.freeze({
  BOOT_STARTED: "boot:started",
  BOOT_PHASE_ENTER: "boot:phase-enter",
  BOOT_PHASE_EXIT: "boot:phase-exit",
  BOOT_PROGRESS: "boot:progress",
  BOOT_LOG: "boot:log",
  BOOT_WARNING: "boot:warning",
  BOOT_ERROR: "boot:error",
  SERVICE_REGISTERED: "boot:service-registered",
  SERVICE_STARTED: "boot:service-started",
  SERVICE_FAILED: "boot:service-failed",
  SERVICE_STOPPED: "boot:service-stopped",
  EXTENSION_LOADED: "boot:extension-loaded",
  EXTENSION_FAILED: "boot:extension-failed",
  INTEGRITY_OK: "boot:integrity-ok",
  INTEGRITY_FAIL: "boot:integrity-fail",
  SESSION_RESTORED: "boot:session-restored",
  SESSION_RESTORE_FAILED: "boot:session-restore-failed",
  SAFE_MODE_ENTERED: "boot:safe-mode-entered",
  SAFE_MODE_EXITED: "boot:safe-mode-exited",
  BOOT_COMPLETE: "boot:complete",
  BOOT_FAILED: "boot:failed",
  SHUTDOWN_STARTED: "boot:shutdown-started",
  SHUTDOWN_COMPLETE: "boot:shutdown-complete",
});

// ============================================================================
// LOGGER
// ============================================================================

class BootLogger {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
  }

  log(level, message, meta) {
    const entry = {
      ts: Date.now(),
      level,
      message,
      meta: meta ?? null,
    };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();

    if (level === "error") {
      console.error(`[safeboot] ${message}`, meta ?? "");
    } else if (level === "warn") {
      console.warn(`[safeboot] ${message}`, meta ?? "");
    }
    kernelBus.emit(BOOT_EVENTS.BOOT_LOG, entry);
  }

  info(msg, meta) {
    this.log("info", msg, meta);
  }
  warn(msg, meta) {
    this.log("warn", msg, meta);
  }
  error(msg, meta) {
    this.log("error", msg, meta);
  }
  debug(msg, meta) {
    this.log("debug", msg, meta);
  }

  getEntries() {
    return [...this.entries];
  }

  clear() {
    this.entries = [];
  }
}

// ============================================================================
// SERVICE REGISTRY
// ============================================================================

class ServiceRegistry {
  constructor() {
    this.services = new Map();
    this.started = new Set();
    this.failed = new Set();
  }

  register(name, service) {
    if (this.services.has(name)) {
      throw new Error(`[safeboot] service "${name}" already registered`);
    }
    this.services.set(name, {
      name,
      deps: service.deps || [],
      critical: !!service.critical,
      safeMode: service.safeMode !== false,
      start: service.start || (async () => {}),
      stop: service.stop || (async () => {}),
      timeout: service.timeout || 5000,
      retries: service.retries || 0,
    });
  }

  get(name) {
    return this.services.get(name) ?? null;
  }

  all() {
    return Array.from(this.services.values());
  }

  order() {
    const visited = new Set();
    const temp = new Set();
    const out = [];

    const visit = (name) => {
      if (visited.has(name)) return;
      if (temp.has(name)) {
        throw new Error(`[safeboot] circular dependency at "${name}"`);
      }
      temp.add(name);
      const svc = this.services.get(name);
      if (!svc) throw new Error(`[safeboot] missing dependency "${name}"`);
      for (const dep of svc.deps) visit(dep);
      temp.delete(name);
      visited.add(name);
      out.push(name);
    };

    for (const name of this.services.keys()) visit(name);
    return out;
  }

  markStarted(name) {
    this.started.add(name);
    this.failed.delete(name);
  }

  markFailed(name) {
    this.failed.add(name);
  }

  isStarted(name) {
    return this.started.has(name);
  }

  isFailed(name) {
    return this.failed.has(name);
  }

  reset() {
    this.started.clear();
    this.failed.clear();
  }
}

// ============================================================================
// EXTENSION REGISTRY
// ============================================================================

class ExtensionRegistry {
  constructor() {
    this.extensions = new Map();
  }

  register(id, ext) {
    this.extensions.set(id, {
      id,
      version: ext.version || "1.0.0",
      mandatory: !!ext.mandatory,
      compatibleSafeMode: ext.compatibleSafeMode !== false,
      load: ext.load || (() => {}),
    });
  }

  all() {
    return Array.from(this.extensions.values());
  }

  get(id) {
    return this.extensions.get(id) ?? null;
  }
}

// ============================================================================
// ESTADO INICIAL
// ============================================================================

const initialBootState = {
  phase: BOOT_PHASE.OFF,
  safeMode: false,
  progress: 0,
  startedAt: null,
  completedAt: null,
  durationMs: 0,
  servicesStarted: [],
  servicesFailed: [],
  extensionsLoaded: [],
  extensionsFailed: [],
  errors: [],
  warnings: [],
  integrityOk: null,
  sessionRestored: false,
  logs: [],
  aborted: false,
};

// ============================================================================
// REDUCER
// ============================================================================

function bootReducer(state, action) {
  switch (action.type) {
    case "SET_PHASE":
      return { ...state, phase: action.phase };

    case "SET_PROGRESS":
      return { ...state, progress: Math.max(state.progress, action.value) };

    case "START":
      return {
        ...initialBootState,
        phase: BOOT_PHASE.POWER_ON,
        startedAt: Date.now(),
        safeMode: !!action.safeMode,
      };

    case "SERVICE_STARTED":
      return {
        ...state,
        servicesStarted: [...state.servicesStarted, action.name],
      };

    case "SERVICE_FAILED":
      return {
        ...state,
        servicesFailed: [
          ...state.servicesFailed,
          { name: action.name, error: action.error },
        ],
        errors: [...state.errors, { name: action.name, error: action.error }],
      };

    case "EXTENSION_LOADED":
      return {
        ...state,
        extensionsLoaded: [...state.extensionsLoaded, action.id],
      };

    case "EXTENSION_FAILED":
      return {
        ...state,
        extensionsFailed: [
          ...state.extensionsFailed,
          { id: action.id, error: action.error },
        ],
        errors: [...state.errors, { id: action.id, error: action.error }],
      };

    case "ADD_WARNING":
      return { ...state, warnings: [...state.warnings, action.warning] };

    case "ADD_ERROR":
      return { ...state, errors: [...state.errors, action.error] };

    case "INTEGRITY":
      return { ...state, integrityOk: action.ok };

    case "SESSION_RESTORED":
      return { ...state, sessionRestored: true };

    case "ADD_LOG":
      return {
        ...state,
        logs: [...state.logs.slice(-499), action.entry],
      };

    case "COMPLETE":
      return {
        ...state,
        phase: state.safeMode ? BOOT_PHASE.SAFE_MODE : BOOT_PHASE.READY,
        completedAt: Date.now(),
        durationMs: state.startedAt ? Date.now() - state.startedAt : 0,
        progress: 100,
      };

    case "FAIL":
      return {
        ...state,
        phase: BOOT_PHASE.FAILED,
        completedAt: Date.now(),
        errors: [...state.errors, action.error],
        progress: 100,
      };

    case "ABORT":
      return { ...state, aborted: true };

    default:
      return state;
  }
}

// ============================================================================
// SAFE BOOT MANAGER
// ============================================================================

export class SafeBoot {
  constructor(options = {}) {
    this.options = {
      forceSafeMode: false,
      ...options,
    };
    this.logger = new BootLogger(options.maxLogs || 500);
    this.services = new ServiceRegistry();
    this.extensions = new ExtensionRegistry();
    this.windowManager = options.windowManager || new WindowManager();
    this.storage =
      options.storage ||
      (typeof localStorage !== "undefined" ? localStorage : null);
    this.storageKey = options.storageKey || "safeboot.session.v1";
    this.sessionKey = options.sessionKey || "safeboot.enabled";
    this.phaseHandlers = new Map();
    this.subscribers = new Set();
    this.aborted = false;
    this.booted = false;
    this.integrityChecks = [];

    this._registerDefaultIntegrityChecks();
  }

  onPhase(phase, handler) {
    if (!this.phaseHandlers.has(phase)) this.phaseHandlers.set(phase, []);
    this.phaseHandlers.get(phase).push(handler);
    return () => {
      const arr = this.phaseHandlers.get(phase);
      if (arr) {
        const i = arr.indexOf(handler);
        if (i >= 0) arr.splice(i, 1);
      }
    };
  }

  registerService(name, service) {
    this.services.register(name, service);
    this.logger.info(`service registered: ${name}`);
    kernelBus.emit(BOOT_EVENTS.SERVICE_REGISTERED, { name });
  }

  registerExtension(id, ext) {
    this.extensions.register(id, ext);
    this.logger.info(`extension registered: ${id}`);
  }

  registerIntegrityCheck(name, fn) {
    this.integrityChecks.push({ name, fn });
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _notify(state) {
    for (const fn of this.subscribers) {
      try {
        fn(state);
      } catch (err) {
        console.error("[safeboot] subscriber error", err);
      }
    }
  }

  isSafeModeEnabled() {
    if (!this.storage) return false;
    return this.storage.getItem(this.sessionKey) === "1";
  }

  enableSafeModeForNextBoot() {
    if (!this.storage) return;
    this.storage.setItem(this.sessionKey, "1");
    this.logger.warn("safe mode enabled for next boot");
  }

  disableSafeModeForNextBoot() {
    if (!this.storage) return;
    this.storage.removeItem(this.sessionKey);
  }

  hasSavedSession() {
    if (!this.storage) return false;
    return !!this.storage.getItem(this.storageKey);
  }

  clearSavedSession() {
    if (!this.storage) return;
    this.storage.removeItem(this.storageKey);
  }

  saveCurrentSession() {
    if (!this.storage) return;
    try {
      const data = this.windowManager.serialize();
      this.storage.setItem(this.storageKey, data);
      this.logger.info("session saved");
    } catch (err) {
      this.logger.error("session save failed", err);
    }
  }

  loadSavedSession() {
    if (!this.storage) return false;
    const raw = this.storage.getItem(this.storageKey);
    if (!raw) return false;
    return this.windowManager.hydrate(raw);
  }

  abort() {
    this.aborted = true;
    this.logger.warn("boot aborted by user");
  }

  async _enterPhase(phase, dispatch, state) {
    if (this.aborted) throw new Error("boot aborted");

    this.logger.info(`entering phase: ${phase}`);
    kernelBus.emit(BOOT_EVENTS.BOOT_PHASE_ENTER, { phase });
    dispatch({ type: "SET_PHASE", phase });

    const handlers = this.phaseHandlers.get(phase) || [];
    for (const h of handlers) {
      await h({ phase, state, logger: this.logger });
    }

    kernelBus.emit(BOOT_EVENTS.BOOT_PHASE_EXIT, { phase });
  }

  _updateProgress(dispatch, value) {
    dispatch({ type: "SET_PROGRESS", value });
    kernelBus.emit(BOOT_EVENTS.BOOT_PROGRESS, { value });
  }

  async _withTimeout(promise, ms, name) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error(`[safeboot] timeout in "${name}" (${ms}ms)`));
      }, ms);
      Promise.resolve(promise)
        .then((v) => {
          clearTimeout(t);
          resolve(v);
        })
        .catch((err) => {
          clearTimeout(t);
          reject(err);
        });
    });
  }

  _registerDefaultIntegrityChecks() {
    this.integrityChecks.push({
      name: "storage-available",
      fn: () => {
        if (typeof localStorage === "undefined")
          return { ok: true, note: "no storage" };
        try {
          localStorage.setItem("__safeboot_probe__", "1");
          localStorage.removeItem("__safeboot_probe__");
          return { ok: true };
        } catch {
          return { ok: false, reason: "storage blocked" };
        }
      },
    });

    this.integrityChecks.push({
      name: "crypto-available",
      fn: () => {
        if (typeof crypto === "undefined")
          return { ok: true, note: "no crypto" };
        if (typeof crypto.getRandomValues !== "function")
          return { ok: false, reason: "crypto.getRandomValues missing" };
        return { ok: true };
      },
    });

    this.integrityChecks.push({
      name: "raf-available",
      fn: () => {
        const has = typeof requestAnimationFrame === "function";
        return has
          ? { ok: true }
          : { ok: false, reason: "requestAnimationFrame missing" };
      },
    });

    this.integrityChecks.push({
      name: "performance-available",
      fn: () => {
        if (typeof performance === "undefined")
          return { ok: true, note: "using Date fallback" };
        return { ok: true };
      },
    });
  }

  async _runIntegrityChecks(dispatch) {
    const results = [];
    for (const check of this.integrityChecks) {
      try {
        const r = await check.fn();
        results.push({ name: check.name, ...r });
        if (!r.ok) {
          this.logger.warn(`integrity check failed: ${check.name}`, r);
          dispatch({
            type: "ADD_WARNING",
            warning: { name: check.name, ...r },
          });
        }
      } catch (err) {
        results.push({ name: check.name, ok: false, reason: String(err) });
        dispatch({
          type: "ADD_WARNING",
          warning: { name: check.name, reason: String(err) },
        });
      }
    }
    const ok = results.every((r) => r.ok !== false);
    dispatch({ type: "INTEGRITY", ok });
    kernelBus.emit(
      ok ? BOOT_EVENTS.INTEGRITY_OK : BOOT_EVENTS.INTEGRITY_FAIL,
      { results }
    );
    return ok;
  }

  async _loadExtensions(dispatch, safeMode) {
    for (const ext of this.extensions.all()) {
      if (this.aborted) throw new Error("boot aborted");

      if (safeMode && !ext.compatibleSafeMode) {
        this.logger.warn(`skipping extension in safe mode: ${ext.id}`);
        continue;
      }

      try {
        await ext.load();
        dispatch({ type: "EXTENSION_LOADED", id: ext.id });
        kernelBus.emit(BOOT_EVENTS.EXTENSION_LOADED, { id: ext.id });
        this.logger.info(`extension loaded: ${ext.id}`);
      } catch (err) {
        dispatch({
          type: "EXTENSION_FAILED",
          id: ext.id,
          error: String(err),
        });
        kernelBus.emit(BOOT_EVENTS.EXTENSION_FAILED, {
          id: ext.id,
          error: err,
        });
        this.logger.error(`extension failed: ${ext.id}`, err);
        if (ext.mandatory) throw err;
      }
    }
  }

  async _loadServices(dispatch, safeMode) {
    const order = this.services.order();
    const total = order.length;
    let done = 0;

    for (const name of order) {
      if (this.aborted) throw new Error("boot aborted");

      const svc = this.services.get(name);
      if (!svc) continue;

      if (safeMode && !svc.safeMode) {
        this.logger.warn(`skipping service in safe mode: ${name}`);
        done++;
        this._updateProgress(dispatch, 40 + (done / total) * 40);
        continue;
      }

      const failedDeps = svc.deps.filter((d) => this.services.isFailed(d));
      if (failedDeps.length > 0) {
        const err = new Error(
          `[safeboot] service "${name}" has failed deps: ${failedDeps.join(
            ", "
          )}`
        );
        dispatch({ type: "SERVICE_FAILED", name, error: String(err) });
        this.services.markFailed(name);
        kernelBus.emit(BOOT_EVENTS.SERVICE_FAILED, { name, error: err });
        this.logger.error(`service failed: ${name} (missing deps)`, {
          failedDeps,
        });
        if (svc.critical) throw err;
        continue;
      }

      let attempt = 0;
      let lastError = null;
      let started = false;

      while (attempt <= svc.retries && !started) {
        try {
          await this._withTimeout(
            svc.start({ logger: this.logger }),
            svc.timeout,
            name
          );
          started = true;
        } catch (err) {
          lastError = err;
          attempt++;
          if (attempt <= svc.retries) {
            this.logger.warn(`retrying service "${name}" (${attempt})`);
            await new Promise((r) => setTimeout(r, 100 * attempt));
          }
        }
      }

      if (started) {
        this.services.markStarted(name);
        dispatch({ type: "SERVICE_STARTED", name });
        kernelBus.emit(BOOT_EVENTS.SERVICE_STARTED, { name });
        this.logger.info(`service started: ${name}`);
      } else {
        dispatch({ type: "SERVICE_FAILED", name, error: String(lastError) });
        this.services.markFailed(name);
        kernelBus.emit(BOOT_EVENTS.SERVICE_FAILED, {
          name,
          error: lastError,
        });
        this.logger.error(`service failed: ${name}`, lastError);
        if (svc.critical) throw lastError;
      }

      done++;
      this._updateProgress(dispatch, 40 + (done / total) * 40);
    }
  }

  async _stopServices() {
    const order = this.services.order().reverse();
    for (const name of order) {
      const svc = this.services.get(name);
      if (!svc || !this.services.isStarted(name)) continue;
      try {
        await svc.stop({ logger: this.logger });
        kernelBus.emit(BOOT_EVENTS.SERVICE_STOPPED, { name });
        this.logger.info(`service stopped: ${name}`);
      } catch (err) {
        this.logger.warn(`service stop failed: ${name}`, err);
      }
    }
    this.services.reset();
  }

  async boot(dispatch, getState) {
    this.booted = false;
    this.aborted = false;

    const safeModeRequested = this.isSafeModeEnabled();
    const safeMode = safeModeRequested || this.options?.forceSafeMode;

    dispatch({ type: "START", safeMode });

    kernelBus.emit(BOOT_EVENTS.BOOT_STARTED, { safeMode });

    try {
      await this._enterPhase(BOOT_PHASE.POWER_ON, dispatch, getState());
      this._updateProgress(dispatch, 5);

      await this._enterPhase(BOOT_PHASE.POST, dispatch, getState());
      const integrityOk = await this._runIntegrityChecks(dispatch);
      this._updateProgress(dispatch, 15);

      if (!integrityOk && !safeMode) {
        this.logger.warn(
          "integrity issues detected; falling back to safe mode"
        );
        dispatch({ type: "SET_PHASE", phase: BOOT_PHASE.KERNEL_INIT });
        return await this._runSafeMode(dispatch, getState);
      }

      await this._enterPhase(BOOT_PHASE.LOADER, dispatch, getState());
      this._updateProgress(dispatch, 22);

      await this._enterPhase(BOOT_PHASE.KERNEL_INIT, dispatch, getState());
      this._updateProgress(dispatch, 30);

      if (safeMode) {
        return await this._runSafeMode(dispatch, getState);
      }

      await this._enterPhase(
        BOOT_PHASE.LOAD_EXTENSIONS,
        dispatch,
        getState()
      );
      await this._loadExtensions(dispatch, false);
      this._updateProgress(dispatch, 40);

      await this._enterPhase(
        BOOT_PHASE.LOAD_SERVICES,
        dispatch,
        getState()
      );
      await this._loadServices(dispatch, false);
      this._updateProgress(dispatch, 80);

      await this._enterPhase(
        BOOT_PHASE.RESTORE_SESSION,
        dispatch,
        getState()
      );
      if (this.hasSavedSession()) {
        const ok = this.loadSavedSession();
        if (ok) {
          dispatch({ type: "SESSION_RESTORED" });
          kernelBus.emit(BOOT_EVENTS.SESSION_RESTORED, {});
          this.logger.info("session restored");
        } else {
          kernelBus.emit(BOOT_EVENTS.SESSION_RESTORE_FAILED, {});
          this.logger.warn("session restore failed");
        }
      }
      this._updateProgress(dispatch, 90);

      await this._enterPhase(
        BOOT_PHASE.START_WINDOW_MANAGER,
        dispatch,
        getState()
      );
      this._updateProgress(dispatch, 96);

      await this._enterPhase(BOOT_PHASE.READY, dispatch, getState());
      dispatch({ type: "COMPLETE" });
      this._updateProgress(dispatch, 100);

      this.booted = true;
      kernelBus.emit(BOOT_EVENTS.BOOT_COMPLETE, { safeMode: false });
      this.logger.info("boot complete");
    } catch (err) {
      this.logger.error("boot failed", err);
      dispatch({ type: "FAIL", error: String(err) });
      kernelBus.emit(BOOT_EVENTS.BOOT_FAILED, { error: err });
    }
  }

  async _runSafeMode(dispatch, getState) {
    this.logger.warn("entering safe mode");
    kernelBus.emit(BOOT_EVENTS.SAFE_MODE_ENTERED, {});

    try {
      await this._enterPhase(
        BOOT_PHASE.START_WINDOW_MANAGER,
        dispatch,
        getState()
      );
      this._updateProgress(dispatch, 80);

      this.clearSavedSession();

      await this._enterPhase(BOOT_PHASE.SAFE_MODE, dispatch, getState());
      dispatch({ type: "COMPLETE" });
      this._updateProgress(dispatch, 100);

      this.booted = true;
      kernelBus.emit(BOOT_EVENTS.BOOT_COMPLETE, { safeMode: true });
      this.logger.info("safe mode boot complete");
    } catch (err) {
      this.logger.error("safe mode boot failed", err);
      dispatch({ type: "FAIL", error: String(err) });
      kernelBus.emit(BOOT_EVENTS.BOOT_FAILED, { error: err });
    }
  }

  async shutdown() {
    if (!this.booted) return;
    kernelBus.emit(BOOT_EVENTS.SHUTDOWN_STARTED, {});
    this.logger.info("shutdown started");

    try {
      this.saveCurrentSession();
      this.windowManager.closeAll();
      await this._stopServices();
      this.booted = false;
      kernelBus.emit(BOOT_EVENTS.SHUTDOWN_COMPLETE, {});
      this.logger.info("shutdown complete");
    } catch (err) {
      this.logger.error("shutdown error", err);
    }
  }

  async reboot(dispatch, getState) {
    await this.shutdown();
    await this.boot(dispatch, getState);
  }
}

// ============================================================================
// CONTEXTO + PROVIDER
// ============================================================================

const SafeBootContext = createContext(null);

export function SafeBootProvider({
  children,
  boot: externalBoot,
  autoStart = true,
  windowManager,
  forceSafeMode = false,
}) {
  const bootRef = useRef(null);

  if (!bootRef.current) {
    const inst = externalBoot || new SafeBoot({ windowManager });
    inst.options = { forceSafeMode };
    bootRef.current = inst;
  }

  const boot = bootRef.current;

  const [state, dispatch] = useReducer(bootReducer, initialBootState);
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const off = kernelBus.on(BOOT_EVENTS.BOOT_LOG, (entry) => {
      dispatch({ type: "ADD_LOG", entry });
    });
    return off;
  }, []);

  useEffect(() => {
    const unsub = boot.subscribe(() => {});
    return () => unsub();
  }, [boot]);

  useEffect(() => {
    if (!autoStart) return;
    const getState = () => stateRef.current;
    boot.boot(dispatch, getState);
  }, [autoStart]);

  const api = useMemo(
    () => ({
      boot,
      state,
      phase: state.phase,
      progress: state.progress,
      safeMode: state.safeMode,
      isReady: state.phase === BOOT_PHASE.READY,
      isSafeMode: state.phase === BOOT_PHASE.SAFE_MODE,
      isFailed: state.phase === BOOT_PHASE.FAILED,
      errors: state.errors,
      warnings: state.warnings,
      logs: state.logs,

      start: () => boot.boot(dispatch, () => stateRef.current),
      shutdown: () => boot.shutdown(),
      reboot: () => boot.reboot(dispatch, () => stateRef.current),
      abort: () => boot.abort(),

      enableSafeModeForNextBoot: () => boot.enableSafeModeForNextBoot(),
      disableSafeModeForNextBoot: () => boot.disableSafeModeForNextBoot(),
      isSafeModeEnabled: () => boot.isSafeModeEnabled(),

      hasSavedSession: () => boot.hasSavedSession(),
      saveCurrentSession: () => boot.saveCurrentSession(),
      loadSavedSession: () => boot.loadSavedSession(),
      clearSavedSession: () => boot.clearSavedSession(),

      registerService: (name, svc) => boot.registerService(name, svc),
      registerExtension: (id, ext) => boot.registerExtension(id, ext),
      registerIntegrityCheck: (name, fn) =>
        boot.registerIntegrityCheck(name, fn),
      onPhase: (phase, handler) => boot.onPhase(phase, handler),
    }),
    [boot, state]
  );

  return (
    <SafeBootContext.Provider value={api}>
      {children}
    </SafeBootContext.Provider>
  );
}

export function useSafeBoot() {
  const ctx = useContext(SafeBootContext);
  if (!ctx)
    throw new Error("useSafeBoot must be used within a SafeBootProvider");
  return ctx;
}

// ============================================================================
// HOOKS AUXILIARES
// ============================================================================

export function useBootPhase(targetPhase) {
  const { phase } = useSafeBoot();
  return phase === targetPhase;
}

export function useBootProgress() {
  const { progress } = useSafeBoot();
  return progress;
}

// ============================================================================
// EXPORTS DEFAULT
// ============================================================================

export default {
  SafeBoot,
  SafeBootProvider,
  useSafeBoot,
  useBootPhase,
  useBootProgress,
  BOOT_PHASE,
  BOOT_ORDER,
  SAFE_BOOT_PHASES,
  BOOT_EVENTS,
};
