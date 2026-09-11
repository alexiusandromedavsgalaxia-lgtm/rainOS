// ============================================================================
// bootloader.jsx — BootLoader del kernel de macOS
// ----------------------------------------------------------------------------
// Etapa previa al SafeBoot. Se encarga de:
// - Detección y validación de entorno (browser / plataforma / capabilities)
// - Comprobación de precondiciones (Web APIs requeridas)
// - Escaneo de "volúmenes" de arranque (sesiones guardadas / perfiles)
// - Cuenta atrás configurable con cancelación por tecla
// - Flags de arranque: verbose (-v), safe (-x), single-user (-s),
//   recovery (⌘R), target-disk, network-boot, no-graphics
// - Cadena de arranque (chainload) hacia SafeBoot
// - Fallback a Recovery si el arranque normal falla
// - Modo verbose con logs a consola
// - Persistencia del "NVRAM" (opciones de arranque entre sesiones)
// - Watchdog global de arranque
// - Todo sin UI. Solo lógica.
// ============================================================================

import React, {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";

import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// ESTADOS DEL BOOTLOADER
// ============================================================================

export const LOADER_STATE = Object.freeze({
  IDLE: "idle",
  DETECTING: "detecting",
  SCANNING: "scanning",
  COUNTDOWN: "countdown",
  WAITING_INPUT: "waiting-input",
  LOADING: "loading",
  CHAINLOADING: "chainloading",
  HANDOFF: "handoff",
  RECOVERY: "recovery",
  FAILED: "failed",
  ABORTED: "aborted",
});

// ============================================================================
// FLAGS DE ARRANQUE
// ============================================================================

export const BOOT_FLAG = Object.freeze({
  VERBOSE: "verbose",
  SAFE: "safe",
  SINGLE_USER: "single-user",
  RECOVERY: "recovery",
  TARGET_DISK: "target-disk",
  NETWORK: "network",
  NO_GRAPHICS: "no-graphics",
  RESET_NVRAM: "reset-nvram",
  DIAGNOSTICS: "diagnostics",
});

// ============================================================================
// EVENTOS DEL BOOTLOADER
// ============================================================================

export const LOADER_EVENTS = Object.freeze({
  STARTED: "loader:started",
  STATE_CHANGED: "loader:state-changed",
  ENV_DETECTED: "loader:env-detected",
  ENV_UNSUPPORTED: "loader:env-unsupported",
  VOLUMES_SCANNED: "loader:volumes-scanned",
  VOLUME_SELECTED: "loader:volume-selected",
  COUNTDOWN_TICK: "loader:countdown-tick",
  COUNTDOWN_CANCELLED: "loader:countdown-cancelled",
  FLAG_TOGGLED: "loader:flag-toggled",
  FLAGS_UPDATED: "loader:flags-updated",
  KEY_PRESSED: "loader:key-pressed",
  CHAINLOAD_START: "loader:chainload-start",
  CHAINLOAD_END: "loader:chainload-end",
  HANDOFF: "loader:handoff",
  RECOVERY_ENTERED: "loader:recovery-entered",
  RECOVERY_EXITED: "loader:recovery-exited",
  FAILED: "loader:failed",
  ABORTED: "loader:aborted",
  WATCHDOG_TIMEOUT: "loader:watchdog-timeout",
  NVRAM_SAVED: "loader:nvram-saved",
  NVRAM_LOADED: "loader:nvram-loaded",
  VERBOSE_LOG: "loader:verbose-log",
  LOG: "loader:log",
  WARNING: "loader:warning",
  ERROR: "loader:error",
});

// ============================================================================
// NVRAM
// ============================================================================

class NVRAM {
  constructor(key = "bootloader.nvram.v1", storage = null) {
    this.key = key;
    this.storage =
      storage ||
      (typeof localStorage !== "undefined" ? localStorage : null);
    this.data = this._load();
  }

  _load() {
    if (!this.storage) return {};
    try {
      const raw = this.storage.getItem(this.key);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  save() {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.key, JSON.stringify(this.data));
      kernelBus.emit(LOADER_EVENTS.NVRAM_SAVED, { data: { ...this.data } });
    } catch (err) {
      console.warn("[bootloader] nvram save failed", err);
    }
  }

  load() {
    this.data = this._load();
    kernelBus.emit(LOADER_EVENTS.NVRAM_LOADED, { data: { ...this.data } });
    return { ...this.data };
  }

  get(k, def = null) {
    return Object.prototype.hasOwnProperty.call(this.data, k)
      ? this.data[k]
      : def;
  }

  set(k, v) {
    this.data[k] = v;
    this.save();
  }

  remove(k) {
    delete this.data[k];
    this.save();
  }

  reset() {
    this.data = {};
    if (this.storage) {
      try {
        this.storage.removeItem(this.key);
      } catch {
        /* noop */
      }
    }
    kernelBus.emit(LOADER_EVENTS.NVRAM_SAVED, { data: {} });
  }

  all() {
    return { ...this.data };
  }
}

// ============================================================================
// DETECCIÓN DE ENTORNO
// ============================================================================

async function detectEnvironment() {
  const env = {
    userAgent:
      typeof navigator !== "undefined" ? navigator.userAgent || "" : "",
    platform:
      typeof navigator !== "undefined" ? navigator.platform || "" : "",
    language:
      typeof navigator !== "undefined" ? navigator.language || "en" : "en",
    viewport: {
      width: typeof window !== "undefined" ? window.innerWidth : 0,
      height: typeof window !== "undefined" ? window.innerHeight : 0,
    },
    dpr: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
    online:
      typeof navigator !== "undefined" ? navigator.onLine !== false : true,
    capabilities: {
      localStorage: false,
      sessionStorage: false,
      indexedDB: false,
      crypto: false,
      raf: false,
      performance: false,
      fetch: false,
      workers: false,
      webgl: false,
      touch: false,
      pointer: false,
      clipboard: false,
      notifications: false,
      fullscreen: false,
    },
    supported: true,
    reasons: [],
  };

  try {
    localStorage.setItem("__probe__", "1");
    localStorage.removeItem("__probe__");
    env.capabilities.localStorage = true;
  } catch {
    env.reasons.push("localStorage unavailable");
  }
  try {
    sessionStorage.setItem("__probe__", "1");
    sessionStorage.removeItem("__probe__");
    env.capabilities.sessionStorage = true;
  } catch {
    env.reasons.push("sessionStorage unavailable");
  }

  env.capabilities.indexedDB = typeof indexedDB !== "undefined";
  env.capabilities.crypto =
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function";
  env.capabilities.raf =
    typeof requestAnimationFrame === "function";
  env.capabilities.performance = typeof performance !== "undefined";
  env.capabilities.fetch = typeof fetch === "function";
  env.capabilities.workers = typeof Worker !== "undefined";
  env.capabilities.pointer =
    typeof window !== "undefined" && "PointerEvent" in window;
  env.capabilities.touch =
    typeof window !== "undefined" &&
    ("ontouchstart" in window ||
      (navigator && navigator.maxTouchPoints > 0));
  env.capabilities.clipboard =
    typeof navigator !== "undefined" && !!navigator.clipboard;
  env.capabilities.notifications = typeof Notification !== "undefined";
  env.capabilities.fullscreen =
    typeof document !== "undefined" &&
    (!!document.documentElement.requestFullscreen ||
      !!document.documentElement.webkitRequestFullscreen);

  try {
    if (typeof document !== "undefined") {
      const c = document.createElement("canvas");
      const gl =
        c.getContext("webgl") || c.getContext("experimental-webgl");
      env.capabilities.webgl = !!gl;
    }
  } catch {
    /* noop */
  }

  if (!env.capabilities.raf) {
    env.supported = false;
    env.reasons.push("requestAnimationFrame missing");
  }
  if (!env.capabilities.performance) {
    env.supported = false;
    env.reasons.push("performance API missing");
  }
  if (typeof document === "undefined") {
    env.supported = false;
    env.reasons.push("document missing (SSR context)");
  }

  return env;
}

// ============================================================================
// ESCANEO DE VOLÚMENES
// ============================================================================

class VolumeScanner {
  constructor(storage = null) {
    this.storage =
      storage ||
      (typeof localStorage !== "undefined" ? localStorage : null);
  }

  async scan() {
    const volumes = [];

    volumes.push({
      id: "main",
      name: "Macintosh HD",
      type: "system",
      bootable: true,
      safeModeCompatible: true,
      recoveryCompatible: true,
      order: 0,
    });

    if (this.storage) {
      try {
        const sessionRaw = this.storage.getItem("safeboot.session.v1");
        if (sessionRaw) {
          let winCount = 0;
          try {
            const parsed = JSON.parse(sessionRaw);
            winCount = Array.isArray(parsed?.windows)
              ? parsed.windows.length
              : 0;
          } catch {
            /* noop */
          }
          volumes.push({
            id: "session",
            name: `Sesión anterior (${winCount} ventanas)`,
            type: "session",
            bootable: true,
            safeModeCompatible: true,
            recoveryCompatible: true,
            order: 1,
          });
        }
      } catch {
        /* noop */
      }

      try {
        const profilesRaw = this.storage.getItem("bootloader.profiles.v1");
        if (profilesRaw) {
          const profiles = JSON.parse(profilesRaw);
          if (Array.isArray(profiles)) {
            profiles.forEach((p, i) => {
              volumes.push({
                id: `profile:${p.id || i}`,
                name: p.name || `Perfil ${i + 1}`,
                type: "profile",
                bootable: true,
                safeModeCompatible: true,
                recoveryCompatible: true,
                order: 10 + i,
              });
            });
          }
        }
      } catch {
        /* noop */
      }
    }

    volumes.push({
      id: "recovery",
      name: "Recovery",
      type: "recovery",
      bootable: true,
      safeModeCompatible: true,
      recoveryCompatible: true,
      order: 900,
    });

    if (typeof navigator !== "undefined" && navigator.onLine !== false) {
      volumes.push({
        id: "network",
        name: "Network Boot",
        type: "network",
        bootable: true,
        safeModeCompatible: false,
        recoveryCompatible: true,
        order: 950,
      });
    }

    volumes.sort((a, b) => a.order - b.order);
    return volumes;
  }
}

// ============================================================================
// GESTOR DE FLAGS DE ARRANQUE
// ============================================================================

class BootFlags {
  constructor(initial = {}) {
    this.flags = new Set(
      Object.values(BOOT_FLAG).filter((f) => initial[f])
    );
  }

  has(flag) {
    return this.flags.has(flag);
  }

  add(flag) {
    const changed = !this.flags.has(flag);
    this.flags.add(flag);
    if (changed)
      kernelBus.emit(LOADER_EVENTS.FLAG_TOGGLED, { flag, enabled: true });
    return changed;
  }

  remove(flag) {
    const changed = this.flags.delete(flag);
    if (changed)
      kernelBus.emit(LOADER_EVENTS.FLAG_TOGGLED, { flag, enabled: false });
    return changed;
  }

  toggle(flag) {
    if (this.flags.has(flag)) this.remove(flag);
    else this.add(flag);
  }

  set(list) {
    this.flags = new Set(list);
    kernelBus.emit(LOADER_EVENTS.FLAGS_UPDATED, { flags: this.list() });
  }

  list() {
    return Array.from(this.flags);
  }

  clear() {
    this.flags.clear();
    kernelBus.emit(LOADER_EVENTS.FLAGS_UPDATED, { flags: [] });
  }
}

// ============================================================================
// WATCHDOG GLOBAL
// ============================================================================

class Watchdog {
  constructor(timeoutMs = 30000) {
    this.timeoutMs = timeoutMs;
    this.timer = null;
    this.onTimeout = null;
    this.startedAt = null;
  }

  start(onTimeout) {
    this.stop();
    this.onTimeout = onTimeout;
    this.startedAt = Date.now();
    this._schedule();
  }

  _schedule() {
    this.timer = setTimeout(() => {
      kernelBus.emit(LOADER_EVENTS.WATCHDOG_TIMEOUT, {
        after: this.timeoutMs,
      });
      this.onTimeout?.();
    }, this.timeoutMs);
  }

  kick() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this._schedule();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.startedAt = null;
  }

  elapsed() {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }
}

// ============================================================================
// ESTADO INICIAL
// ============================================================================

const initialState = {
  state: LOADER_STATE.IDLE,
  env: null,
  volumes: [],
  selectedVolumeId: "main",
  countdown: null,
  flags: [],
  verbose: false,
  errors: [],
  warnings: [],
  logs: [],
  chainloadTarget: null,
  recovery: false,
  handoffDone: false,
  startedAt: null,
  finishedAt: null,
  durationMs: 0,
};

// ============================================================================
// REDUCER
// ============================================================================

function loaderReducer(state, action) {
  switch (action.type) {
    case "SET_STATE":
      return { ...state, state: action.state };

    case "START":
      return {
        ...initialState,
        state: LOADER_STATE.DETECTING,
        startedAt: Date.now(),
      };

    case "ENV_DETECTED":
      return { ...state, env: action.env };

    case "VOLUMES_SCANNED":
      return {
        ...state,
        volumes: action.volumes,
        selectedVolumeId:
          action.volumes.find((v) => v.id === state.selectedVolumeId)?.id ||
          action.volumes[0]?.id ||
          null,
      };

    case "SELECT_VOLUME":
      return { ...state, selectedVolumeId: action.id };

    case "COUNTDOWN":
      return { ...state, countdown: action.value };

    case "FLAGS":
      return { ...state, flags: action.flags };

    case "VERBOSE":
      return { ...state, verbose: action.value };

    case "WARNING":
      return { ...state, warnings: [...state.warnings, action.warning] };

    case "ERROR":
      return { ...state, errors: [...state.errors, action.error] };

    case "CHAINLOAD":
      return { ...state, chainloadTarget: action.target };

    case "RECOVERY":
      return { ...state, recovery: action.value };

    case "HANDOFF":
      return { ...state, handoffDone: true };

    case "LOG":
      return { ...state, logs: [...state.logs.slice(-299), action.entry] };

    case "COMPLETE":
      return {
        ...state,
        finishedAt: Date.now(),
        durationMs: state.startedAt ? Date.now() - state.startedAt : 0,
      };

    default:
      return state;
  }
}

// ============================================================================
// BOOTLOADER
// ============================================================================

export class BootLoader {
  constructor(options = {}) {
    this.options = {
      countdownMs: 3000,
      watchdogMs: 30000,
      nvramKey: "bootloader.nvram.v1",
      autoStart: true,
      defaultVolumeId: "main",
      forceFlags: [],
      ...options,
    };

    this.nvram = new NVRAM(this.options.nvramKey, options.storage);
    this.scanner = new VolumeScanner(options.storage);
    this.flags = new BootFlags();
    this.watchdog = new Watchdog(this.options.watchdogMs);

    this.subscribers = new Set();
    this.env = null;
    this.volumes = [];
    this.state = LOADER_STATE.IDLE;
    this.countdownHandle = null;
    this.countdownCancelled = false;
    this.keyHandler = null;
    this.safeBoot = null;
    this.safeBootDispatch = null;
    this.safeBootGetState = null;
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _logVerbose(message, meta) {
    if (!this.flags.has(BOOT_FLAG.VERBOSE)) return;
    console.log(`[bootloader -v] ${message}`, meta ?? "");
    kernelBus.emit(LOADER_EVENTS.VERBOSE_LOG, { message, meta });
  }

  _setState(dispatch, state) {
    this.state = state;
    dispatch({ type: "SET_STATE", state });
    kernelBus.emit(LOADER_EVENTS.STATE_CHANGED, { state });
  }

  _log(dispatch, level, message, meta) {
    const entry = { ts: Date.now(), level, message, meta: meta ?? null };
    dispatch({ type: "LOG", entry });
    kernelBus.emit(LOADER_EVENTS.LOG, entry);
  }

  async detect(dispatch) {
    this._setState(dispatch, LOADER_STATE.DETECTING);
    this._logVerbose("detecting environment");

    const env = await detectEnvironment();
    this.env = env;
    dispatch({ type: "ENV_DETECTED", env });
    kernelBus.emit(LOADER_EVENTS.ENV_DETECTED, { env });

    this._logVerbose("environment detected", env);

    if (!env.supported) {
      kernelBus.emit(LOADER_EVENTS.ENV_UNSUPPORTED, { env });
      dispatch({
        type: "WARNING",
        warning: "environment not fully supported",
      });
      return false;
    }
    return true;
  }

  async scan(dispatch) {
    this._setState(dispatch, LOADER_STATE.SCANNING);
    this._logVerbose("scanning volumes");

    const volumes = await this.scanner.scan();
    this.volumes = volumes;
    dispatch({ type: "VOLUMES_SCANNED", volumes });
    kernelBus.emit(LOADER_EVENTS.VOLUMES_SCANNED, { volumes });

    const stored = this.nvram.get("defaultVolumeId", null);
    const preferred =
      this.options.defaultVolumeId ||
      (stored && volumes.find((v) => v.id === stored) ? stored : null);

    if (preferred && volumes.find((v) => v.id === preferred)) {
      dispatch({ type: "SELECT_VOLUME", id: preferred });
      kernelBus.emit(LOADER_EVENTS.VOLUME_SELECTED, { id: preferred });
    } else {
      kernelBus.emit(LOADER_EVENTS.VOLUME_SELECTED, {
        id: volumes[0]?.id,
      });
    }

    this._logVerbose("volumes scanned", volumes);
    return volumes;
  }

  loadFlagsFromNVRAM(dispatch) {
    const stored = this.nvram.get("flags", []);
    const force = this.options.forceFlags || [];
    const merged = Array.from(new Set([...stored, ...force]));
    this.flags.set(merged);
    dispatch({ type: "FLAGS", flags: merged });

    const verbose = this.nvram.get("verbose", false);
    if (verbose) this.flags.add(BOOT_FLAG.VERBOSE);
    dispatch({
      type: "VERBOSE",
      value: this.flags.has(BOOT_FLAG.VERBOSE),
    });

    this._logVerbose("flags loaded from nvram", merged);
  }

  saveFlagsToNVRAM() {
    this.nvram.set("flags", this.flags.list());
    this.nvram.set("verbose", this.flags.has(BOOT_FLAG.VERBOSE));
  }

  attachKeyHandler(dispatch, onAbort) {
    this.detachKeyHandler();

    const handler = (e) => {
      kernelBus.emit(LOADER_EVENTS.KEY_PRESSED, {
        key: e.key,
        altKey: e.altKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
      });

      if (e.altKey) {
        this.cancelCountdown(dispatch, "alt");
        return;
      }

      if (e.metaKey && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        this.flags.add(BOOT_FLAG.VERBOSE);
        dispatch({ type: "FLAGS", flags: this.flags.list() });
        dispatch({ type: "VERBOSE", value: true });
        this.saveFlagsToNVRAM();
        return;
      }

      if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        this.flags.add(BOOT_FLAG.SAFE);
        dispatch({ type: "FLAGS", flags: this.flags.list() });
        this.saveFlagsToNVRAM();
        return;
      }

      if (e.metaKey && (e.key === "r" || e.key === "R")) {
        e.preventDefault();
        this.flags.add(BOOT_FLAG.RECOVERY);
        dispatch({ type: "FLAGS", flags: this.flags.list() });
        this.saveFlagsToNVRAM();
        return;
      }

      if (e.metaKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        this.flags.add(BOOT_FLAG.SINGLE_USER);
        dispatch({ type: "FLAGS", flags: this.flags.list() });
        this.saveFlagsToNVRAM();
        return;
      }

      if (e.metaKey && e.altKey && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        this.nvram.reset();
        this.flags.clear();
        dispatch({ type: "FLAGS", flags: [] });
        dispatch({ type: "VERBOSE", value: false });
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        onAbort?.();
      }

      this.cancelCountdown(dispatch, "key");
    };

    this.keyHandler = handler;
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", handler, { capture: true });
    }
  }

  detachKeyHandler() {
    if (this.keyHandler && typeof window !== "undefined") {
      window.removeEventListener("keydown", this.keyHandler, {
        capture: true,
      });
    }
    this.keyHandler = null;
  }

  async countdown(dispatch, ms) {
    this._setState(dispatch, LOADER_STATE.COUNTDOWN);
    this.countdownCancelled = false;

    const total = ms;
    const step = 100;
    let elapsed = 0;

    return new Promise((resolve) => {
      const tick = () => {
        if (this.countdownCancelled) {
          resolve(false);
          return;
        }
        elapsed += step;
        const remaining = Math.max(0, total - elapsed);
        const seconds = Math.ceil(remaining / 1000);
        dispatch({ type: "COUNTDOWN", value: seconds });
        kernelBus.emit(LOADER_EVENTS.COUNTDOWN_TICK, {
          remainingMs: remaining,
          seconds,
        });
        if (remaining <= 0) {
          resolve(true);
          return;
        }
        this.countdownHandle = setTimeout(tick, step);
      };

      this.countdownHandle = setTimeout(tick, step);
    });
  }

  cancelCountdown(dispatch, reason = "user") {
    if (this.countdownHandle) {
      clearTimeout(this.countdownHandle);
      this.countdownHandle = null;
    }
    if (!this.countdownCancelled) {
      this.countdownCancelled = true;
      this._setState(dispatch, LOADER_STATE.WAITING_INPUT);
      kernelBus.emit(LOADER_EVENTS.COUNTDOWN_CANCELLED, { reason });
    }
  }

  async chainload(dispatch) {
    const selectedId = this._getSelectedVolumeId();
    const selected = this.volumes.find((v) => v.id === selectedId);

    this._setState(dispatch, LOADER_STATE.CHAINLOADING);
    dispatch({ type: "CHAINLOAD", target: selectedId });
    kernelBus.emit(LOADER_EVENTS.CHAINLOAD_START, { target: selectedId });

    this._logVerbose("chainload start", { selected });

    if (selectedId) {
      this.nvram.set("defaultVolumeId", selectedId);
    }
    this.saveFlagsToNVRAM();

    return selected;
  }

  endChainload(dispatch) {
    kernelBus.emit(LOADER_EVENTS.CHAINLOAD_END, {});
    this._setState(dispatch, LOADER_STATE.HANDOFF);
  }

  async handoff(dispatch, safeBoot, safeBootDispatch, safeBootGetState) {
    this._setState(dispatch, LOADER_STATE.HANDOFF);

    const safeMode =
      this.flags.has(BOOT_FLAG.SAFE) ||
      this.flags.has(BOOT_FLAG.RECOVERY) ||
      this.flags.has(BOOT_FLAG.SINGLE_USER);

    if (safeBoot) {
      safeBoot.options = {
        ...(safeBoot.options || {}),
        forceSafeMode: safeMode,
      };
    }

    kernelBus.emit(LOADER_EVENTS.HANDOFF, {
      flags: this.flags.list(),
      safeMode,
    });

    dispatch({ type: "HANDOFF" });

    try {
      if (safeBoot && typeof safeBoot.boot === "function") {
        await safeBoot.boot(safeBootDispatch, safeBootGetState);
      }
      dispatch({ type: "COMPLETE" });
      return true;
    } catch (err) {
      dispatch({ type: "ERROR", error: String(err) });
      kernelBus.emit(LOADER_EVENTS.FAILED, { error: err });
      return false;
    }
  }

  async enterRecovery(dispatch) {
    this._setState(dispatch, LOADER_STATE.RECOVERY);
    dispatch({ type: "RECOVERY", value: true });
    kernelBus.emit(LOADER_EVENTS.RECOVERY_ENTERED, {});
    this.flags.add(BOOT_FLAG.RECOVERY);

    this.nvram.remove("flags");
    this.nvram.remove("verbose");

    return true;
  }

  exitRecovery(dispatch) {
    dispatch({ type: "RECOVERY", value: false });
    kernelBus.emit(LOADER_EVENTS.RECOVERY_EXITED, {});
  }

  abort(dispatch) {
    this.cancelCountdown(dispatch, "abort");
    this.detachKeyHandler();
    this.watchdog.stop();
    this._setState(dispatch, LOADER_STATE.ABORTED);
    kernelBus.emit(LOADER_EVENTS.ABORTED, {});
  }

  _getSelectedVolumeId() {
    return this.nvram.get("lastSelected", this.options.defaultVolumeId);
  }

  setSelectedVolume(id, dispatch) {
    this.nvram.set("lastSelected", id);
    dispatch({ type: "SELECT_VOLUME", id });
    kernelBus.emit(LOADER_EVENTS.VOLUME_SELECTED, { id });
  }

  toggleFlag(flag, dispatch) {
    this.flags.toggle(flag);
    const list = this.flags.list();
    dispatch({ type: "FLAGS", flags: list });
    dispatch({
      type: "VERBOSE",
      value: this.flags.has(BOOT_FLAG.VERBOSE),
    });
    this.saveFlagsToNVRAM();
    kernelBus.emit(LOADER_EVENTS.FLAGS_UPDATED, { flags: list });
  }

  async run({
    dispatch,
    safeBoot,
    safeBootDispatch,
    safeBootGetState,
    onAbort,
  }) {
    kernelBus.emit(LOADER_EVENTS.STARTED, {
      options: { ...this.options },
    });

    dispatch({ type: "START" });
    this.watchdog.start(() => {
      dispatch({ type: "ERROR", error: "watchdog timeout" });
      kernelBus.emit(LOADER_EVENTS.FAILED, { reason: "watchdog" });
      this.abort(dispatch);
    });

    try {
      const envOk = await this.detect(dispatch);
      this.watchdog.kick();

      this.loadFlagsFromNVRAM(dispatch);
      this.watchdog.kick();

      await this.scan(dispatch);
      this.watchdog.kick();

      if (!envOk) {
        await this.enterRecovery(dispatch);
        this.endChainload(dispatch);
        return await this.handoff(
          dispatch,
          safeBoot,
          safeBootDispatch,
          safeBootGetState
        );
      }

      this.attachKeyHandler(dispatch, () => {
        this.abort(dispatch);
        onAbort?.();
      });

      this._setState(dispatch, LOADER_STATE.COUNTDOWN);
      const completed = await this.countdown(
        dispatch,
        this.options.countdownMs
      );

      if (!completed) {
        this._setState(dispatch, LOADER_STATE.WAITING_INPUT);
        await new Promise((r) => setTimeout(r, 1200));
      }

      this.watchdog.kick();

      const selected = await this.chainload(dispatch);
      if (!selected) {
        throw new Error("no bootable volume selected");
      }
      this.watchdog.kick();

      if (this.flags.has(BOOT_FLAG.RECOVERY)) {
        await this.enterRecovery(dispatch);
      }

      this.endChainload(dispatch);

      const ok = await this.handoff(
        dispatch,
        safeBoot,
        safeBootDispatch,
        safeBootGetState
      );
      this.watchdog.stop();
      return ok;
    } catch (err) {
      this.watchdog.stop();
      dispatch({ type: "ERROR", error: String(err) });
      kernelBus.emit(LOADER_EVENTS.FAILED, { error: err });
      this._setState(dispatch, LOADER_STATE.FAILED);
      return false;
    } finally {
      this.detachKeyHandler();
    }
  }
}

// ============================================================================
// CONTEXTO + PROVIDER
// ============================================================================

const BootLoaderContext = createContext(null);

export function BootLoaderProvider({
  children,
  loader: externalLoader,
  safeBoot,
  autoRun = true,
  onAbort,
  options = {},
}) {
  const loaderRef = useRef(null);
  if (!loaderRef.current) {
    loaderRef.current = externalLoader || new BootLoader(options);
  }
  const loader = loaderRef.current;

  const [state, dispatch] = useReducer(loaderReducer, initialState);

  const safeBootRef = useRef(safeBoot);
  const safeBootDispatchRef = useRef(null);
  const safeBootGetStateRef = useRef(null);

  useEffect(() => {
    safeBootRef.current = safeBoot;
  }, [safeBoot]);

  useEffect(() => {
    if (!autoRun) return;
    let cancelled = false;

    (async () => {
      await loader.run({
        dispatch,
        safeBoot: safeBootRef.current,
        safeBootDispatch: safeBootDispatchRef.current,
        safeBootGetState: safeBootGetStateRef.current,
        onAbort,
      });
      if (cancelled) return;
    })();

    return () => {
      cancelled = true;
      loader.detachKeyHandler();
      loader.watchdog.stop();
    };
  }, [autoRun]);

  const api = useMemo(
    () => ({
      loader,
      state,
      phase: state.state,
      isReady:
        state.state === LOADER_STATE.HANDOFF ||
        state.state === LOADER_STATE.RECOVERY,
      isFailed: state.state === LOADER_STATE.FAILED,
      env: state.env,
      volumes: state.volumes,
      selectedVolumeId: state.selectedVolumeId,
      countdown: state.countdown,
      flags: state.flags,
      verbose: state.verbose,
      recovery: state.recovery,
      errors: state.errors,
      warnings: state.warnings,
      logs: state.logs,
      durationMs: state.durationMs,

      abort: () => loader.abort(dispatch),
      setSelectedVolume: (id) => loader.setSelectedVolume(id, dispatch),
      toggleFlag: (flag) => loader.toggleFlag(flag, dispatch),
      enterRecovery: () => loader.enterRecovery(dispatch),
      exitRecovery: () => loader.exitRecovery(dispatch),
      hasFlag: (flag) => loader.flags.has(flag),
      getFlagList: () => loader.flags.list(),

      nvramGet: (k, d) => loader.nvram.get(k, d),
      nvramSet: (k, v) => loader.nvram.set(k, v),
      nvramReset: () => loader.nvram.reset(),
    }),
    [loader, state]
  );

  return (
    <BootLoaderContext.Provider value={api}>
      {children}
    </BootLoaderContext.Provider>
  );
}

export function useBootLoader() {
  const ctx = useContext(BootLoaderContext);
  if (!ctx)
    throw new Error(
      "useBootLoader must be used within a BootLoaderProvider"
    );
  return ctx;
}

// ============================================================================
// HOOKS AUXILIARES
// ============================================================================

export function useBootFlags() {
  const { flags, toggleFlag, hasFlag } = useBootLoader();
  return { flags, toggleFlag, hasFlag };
}

export function useCountdown() {
  const { countdown } = useBootLoader();
  return countdown;
}

// ============================================================================
// EXPORTS DEFAULT
// ============================================================================

export default {
  BootLoader,
  BootLoaderProvider,
  useBootLoader,
  useBootFlags,
  useCountdown,
  LOADER_STATE,
  LOADER_EVENTS,
  BOOT_FLAG,
};
