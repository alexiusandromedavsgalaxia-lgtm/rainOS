// ============================================================================
// lockscreen.jsx — Pantalla de bloqueo
// ----------------------------------------------------------------------------
// Capa intermedia entre "el sistema arrancó" y "el usuario entró".
// Responsabilidades:
//
// 1. AUTENTICACIÓN
//    - Contraseña (hash SHA-256 con fallback)
//    - Touch ID simulado (biometría)
//    - Intentos fallidos con retardo progresivo (throttling)
//    - Bloqueo temporal tras N fallos
//
// 2. CICLO DE VIDA
//    - Bloqueo manual
//    - Bloqueo por inactividad (idle timeout)
//    - Bloqueo por cierre de pestaña (visibilitychange)
//    - Bloqueo por suspensión
//    - Screensaver tras X min sin actividad
//    - Wake → mostrar lock screen
//
// 3. UX DE ESTADO
//    - Avatar del usuario
//    - Reloj grande con fecha
//    - Indicador de estado (banner)
//    - Cambio rápido de usuario
//    - Botones: apagar, reiniciar, dormir
//    - Shake al fallar
//
// 4. GANCHOS AL KERNEL
//    - Cede el foco al desktop al desbloquear
//    - Pausa la multitarea mientras está bloqueado
//
// Todo puro JS. UI opcional; expone estado + acciones.
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

import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

export const LOCK_STATE = Object.freeze({
  IDLE: "idle",
  LOCKED: "locked",
  UNLOCKING: "unlocking",
  UNLOCKED: "unlocked",
  SCREEN_SAVER: "screen-saver",
  CHANGING_USER: "changing-user",
  SHUTTING_DOWN: "shutting-down",
  RESTARTING: "restarting",
  SLEEPING: "sleeping",
  FAILED: "failed",
});

export const AUTH_METHOD = Object.freeze({
  PASSWORD: "password",
  TOUCH_ID: "touch-id",
  WATCH: "watch",
  RECOVERY: "recovery",
});

export const LOCK_EVENTS = Object.freeze({
  STARTED: "lock:started",
  LOCKED: "lock:locked",
  UNLOCKING: "lock:unlocking",
  UNLOCKED: "lock:unlocked",
  FAILED_ATTEMPT: "lock:failed-attempt",
  LOCKOUT: "lock:lockout",
  LOCKOUT_ENDED: "lock:lockout-ended",
  SCREEN_SAVER_ON: "lock:screen-saver-on",
  SCREEN_SAVER_OFF: "lock:screen-saver-off",
  USER_CHANGED: "lock:user-changed",
  USER_SWITCHING: "lock:user-switching",
  SLEEP: "lock:sleep",
  WAKE: "lock:wake",
  SHUTDOWN: "lock:shutdown",
  RESTART: "lock:restart",
  CANCEL: "lock:cancel",
  AUTH_STARTED: "lock:auth-started",
  AUTH_OK: "lock:auth-ok",
  AUTH_FAIL: "lock:auth-fail",
  BIOMETRY_STARTED: "lock:biometry-started",
  BIOMETRY_OK: "lock:biometry-ok",
  BIOMETRY_FAIL: "lock:biometry-fail",
  IDLE_TIMEOUT: "lock:idle-timeout",
  VISIBILITY_HIDDEN: "lock:visibility-hidden",
  VISIBILITY_VISIBLE: "lock:visibility-visible",
  LOG: "lock:log",
  ERROR: "lock:error",
  WARNING: "lock:warning",
  STATE_CHANGED: "lock:state-changed",
  CLOCK_TICK: "lock:clock-tick",
  RESET: "lock:reset",
});

export const DEFAULT_LOCK_OPTIONS = Object.freeze({
  idleTimeoutMs: 5 * 60 * 1000,
  screenSaverTimeoutMs: 10 * 60 * 1000,
  lockOnVisibilityHidden: true,
  lockOnSuspend: true,
  requirePasswordAfterMs: 0,
  maxFailedAttempts: 5,
  lockoutBaseMs: 30 * 1000,
  lockoutMultiplier: 2,
  gracePeriodMs: 5 * 1000,
  showClock: true,
  clockFormat: "24h",
  showBattery: true,
  showNetwork: true,
  enableTouchId: true,
  enableWatchUnlock: false,
  shakeOnFail: true,
  blurWallpaper: true,
  dimBackground: true,
});

// ============================================================================
// LOGGER
// ============================================================================

class LockLog {
  constructor(max = 200) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(LOCK_EVENTS.LOG, e);
    return e;
  }
  info(m, x) {
    return this.push("info", m, x);
  }
  warn(m, x) {
    return this.push("warn", m, x);
  }
  error(m, x) {
    return this.push("error", m, x);
  }
  all() {
    return [...this.entries];
  }
  clear() {
    this.entries = [];
  }
}

// ============================================================================
// HASH DE CONTRASEÑA
// ============================================================================

async function hashPassword(pw) {
  if (!pw) return null;
  try {
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const enc = new TextEncoder();
      const buf = await crypto.subtle.digest("SHA-256", enc.encode(pw));
      const bytes = new Uint8Array(buf);
      return Array.from(bytes, (b) =>
        b.toString(16).padStart(2, "0")
      ).join("");
    }
  } catch {
    /* fallback */
  }
  let h = 0;
  for (let i = 0; i < pw.length; i++) {
    h = (h << 5) - h + pw.charCodeAt(i);
    h |= 0;
  }
  return `fallback:${h.toString(16)}`;
}

function constantTimeEqual(a, b) {
  if (a == null || b == null) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ============================================================================
// USER REGISTRY (comparte datos con initialconfig)
// ============================================================================

class UserRegistry {
  constructor() {
    this.ls = typeof localStorage !== "undefined" ? localStorage : null;
    this.users = this._load();
    this.activeUserId = null;
  }

  _load() {
    if (!this.ls) {
      return [
        {
          id: "default",
          fullName: "Usuario",
          shortName: "usuario",
          photo: null,
          admin: true,
          passwordHash: null,
          touchId: false,
        },
      ];
    }
    try {
      const raw = this.ls.getItem("initialconfig.config");
      if (raw) {
        const cfg = JSON.parse(raw);
        const acc = cfg.account || {};
        return [
          {
            id: "default",
            fullName: acc.fullName || "Usuario",
            shortName: acc.shortName || "usuario",
            photo: acc.photo || null,
            admin: acc.admin !== false,
            passwordHash: acc.passwordHash || null,
            touchId: acc.touchId === true,
          },
        ];
      }
    } catch {
      /* noop */
    }
    return [
      {
        id: "default",
        fullName: "Usuario",
        shortName: "usuario",
        photo: null,
        admin: true,
        passwordHash: null,
        touchId: false,
      },
    ];
  }

  reload() {
    this.users = this._load();
  }

  list() {
    return [...this.users];
  }

  get(id) {
    return this.users.find((u) => u.id === id) ?? null;
  }

  getActive() {
    const id = this.activeUserId || this.users[0]?.id;
    return this.get(id);
  }

  setActive(id) {
    if (this.users.some((u) => u.id === id)) {
      this.activeUserId = id;
      return true;
    }
    return false;
  }

  hasPassword(user) {
    return !!(user && user.passwordHash);
  }
}

// ============================================================================
// IDLE MONITOR
// ============================================================================

class IdleMonitor {
  constructor({ onIdle, onActive, idleMs = 300000 } = {}) {
    this.idleMs = idleMs;
    this.onIdle = onIdle || (() => {});
    this.onActive = onActive || (() => {});
    this.timer = null;
    this.lastActivity = Date.now();
    this.idle = false;
    this.attach();
  }

  _reset = () => {
    this.lastActivity = Date.now();
    if (this.idle) {
      this.idle = false;
      this.onActive();
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.idle = true;
      this.onIdle();
    }, this.idleMs);
  };

  attach() {
    if (typeof window === "undefined") return;
    const events = [
      "mousemove",
      "mousedown",
      "keydown",
      "touchstart",
      "scroll",
      "wheel",
      "pointerdown",
    ];
    this._handlers = events.map((ev) => {
      const h = () => this._reset();
      window.addEventListener(ev, h, { passive: true });
      return { ev, h };
    });
    this._reset();
  }

  detach() {
    if (typeof window === "undefined") return;
    if (this.timer) clearTimeout(this.timer);
    if (this._handlers) {
      for (const { ev, h } of this._handlers) {
        window.removeEventListener(ev, h);
      }
      this._handlers = null;
    }
  }

  setIdleMs(ms) {
    this.idleMs = ms;
    this._reset();
  }

  isIdle() {
    return this.idle;
  }

  lastActivityAt() {
    return this.lastActivity;
  }
}

// ============================================================================
// ESTADO INICIAL
// ============================================================================

const initialState = {
  state: LOCK_STATE.IDLE,
  locked: false,
  showScreenSaver: false,
  currentUserId: null,
  unlocking: false,
  authMethod: null,
  failedAttempts: 0,
  lockoutUntil: null,
  lastError: null,
  now: Date.now(),
  banner: null,
  shakeKey: 0,
  graceUntil: null,
  lastUnlockAt: null,
  logs: [],
  options: { ...DEFAULT_LOCK_OPTIONS },
};

// ============================================================================
// REDUCER
// ============================================================================

function reducer(state, action) {
  switch (action.type) {
    case "SET_STATE":
      return { ...state, state: action.state };

    case "LOCK":
      return {
        ...state,
        state: LOCK_STATE.LOCKED,
        locked: true,
        showScreenSaver: false,
        graceUntil: action.graceUntil ?? null,
        lastError: null,
      };

    case "SHOW_SAVER":
      return {
        ...state,
        showScreenSaver: true,
        state: LOCK_STATE.SCREEN_SAVER,
      };

    case "HIDE_SAVER":
      return {
        ...state,
        showScreenSaver: false,
        state: state.locked ? LOCK_STATE.LOCKED : LOCK_STATE.IDLE,
      };

    case "AUTH_START":
      return {
        ...state,
        unlocking: true,
        authMethod: action.method,
        lastError: null,
        banner: null,
      };

    case "AUTH_OK":
      return {
        ...state,
        unlocking: false,
        authMethod: null,
        locked: false,
        state: LOCK_STATE.UNLOCKED,
        failedAttempts: 0,
        lockoutUntil: null,
        showScreenSaver: false,
        lastUnlockAt: Date.now(),
        banner: null,
      };

    case "AUTH_FAIL":
      return {
        ...state,
        unlocking: false,
        authMethod: null,
        failedAttempts: state.failedAttempts + 1,
        lastError: action.error || "Contraseña incorrecta",
        shakeKey: state.shakeKey + 1,
        banner: {
          type: "error",
          message: action.error || "Contraseña incorrecta",
        },
      };

    case "LOCKOUT":
      return {
        ...state,
        lockoutUntil: action.until,
        banner: {
          type: "warn",
          message: `Demasiados intentos. Espera ${Math.ceil(
            (action.until - Date.now()) / 1000
          )}s`,
        },
        shakeKey: state.shakeKey + 1,
      };

    case "LOCKOUT_END":
      return { ...state, lockoutUntil: null, banner: null };

    case "SET_USER":
      return { ...state, currentUserId: action.id };

    case "SWITCH_USER":
      return { ...state, state: LOCK_STATE.CHANGING_USER };

    case "SLEEP":
      return { ...state, state: LOCK_STATE.SLEEPING };

    case "WAKE":
      return {
        ...state,
        state: state.locked ? LOCK_STATE.LOCKED : LOCK_STATE.IDLE,
      };

    case "SHUTDOWN":
      return { ...state, state: LOCK_STATE.SHUTTING_DOWN };

    case "RESTART":
      return { ...state, state: LOCK_STATE.RESTARTING };

    case "FAIL":
      return {
        ...state,
        state: LOCK_STATE.FAILED,
        lastError: action.error,
      };

    case "CLOCK":
      return { ...state, now: action.now };

    case "BANNER":
      return { ...state, banner: action.banner };

    case "CLEAR_BANNER":
      return { ...state, banner: null };

    case "LOG":
      return { ...state, logs: [...state.logs.slice(-199), action.entry] };

    case "SET_OPTIONS":
      return { ...state, options: { ...state.options, ...action.options } };

    case "RESET":
      return { ...initialState, options: state.options };

    default:
      return state;
  }
}

// ============================================================================
// LOCK SCREEN (clase pura)
// ============================================================================

export class LockScreen {
  constructor(options = {}) {
    this.logger = new LockLog();
    this.users = new UserRegistry();
    this.options = { ...DEFAULT_LOCK_OPTIONS, ...options };

    this.idle = null;
    this.aborted = false;
    this.stateRef = null;
    this.dispatchRef = null;

    this.onUnlockedHandlers = new Set();
    this.onLockedHandlers = new Set();
    this.onShutdownHandlers = new Set();
    this.onRestartHandlers = new Set();
  }

  onUnlocked(fn) {
    this.onUnlockedHandlers.add(fn);
    return () => this.onUnlockedHandlers.delete(fn);
  }
  onLocked(fn) {
    this.onLockedHandlers.add(fn);
    return () => this.onLockedHandlers.delete(fn);
  }
  onShutdown(fn) {
    this.onShutdownHandlers.add(fn);
    return () => this.onShutdownHandlers.delete(fn);
  }
  onRestart(fn) {
    this.onRestartHandlers.add(fn);
    return () => this.onRestartHandlers.delete(fn);
  }

  _emitUnlocked(reason) {
    for (const fn of this.onUnlockedHandlers) {
      try {
        fn(reason);
      } catch (err) {
        this.logger.warn("unlocked handler error", err);
      }
    }
  }
  _emitLocked(reason) {
    for (const fn of this.onLockedHandlers) {
      try {
        fn(reason);
      } catch (err) {
        this.logger.warn("locked handler error", err);
      }
    }
  }
  _emitShutdown() {
    for (const fn of this.onShutdownHandlers) {
      try {
        fn();
      } catch (err) {
        this.logger.warn("shutdown handler error", err);
      }
    }
  }
  _emitRestart() {
    for (const fn of this.onRestartHandlers) {
      try {
        fn();
      } catch (err) {
        this.logger.warn("restart handler error", err);
      }
    }
  }

  attachIdleMonitor(dispatch) {
    if (this.idle) this.idle.detach();
    this.idle = new IdleMonitor({
      idleMs: this.options.idleTimeoutMs,
      onIdle: () => {
        kernelBus.emit(LOCK_EVENTS.IDLE_TIMEOUT, {});
        this.lock(dispatch, "idle-timeout");
      },
      onActive: () => {},
    });
  }

  detachIdleMonitor() {
    if (this.idle) this.idle.detach();
    this.idle = null;
  }

  lock(dispatch, reason = "manual", { grace = false } = {}) {
    const state = this.stateRef;
    if (state?.locked) return;

    const graceUntil = grace ? Date.now() + this.options.gracePeriodMs : null;

    dispatch({ type: "LOCK", graceUntil });
    kernelBus.emit(LOCK_EVENTS.LOCKED, { reason, graceUntil });

    try {
      kernelBus.emit("kernel:blur-all", { reason });
    } catch {
      /* noop */
    }

    this._emitLocked(reason);
    this.logger.info(`locked (${reason})`);
  }

  unlock(dispatch, method) {
    dispatch({ type: "AUTH_OK" });
    kernelBus.emit(LOCK_EVENTS.UNLOCKED, { method });
    this._emitUnlocked(method);
    this.logger.info(`unlocked via ${method}`);
  }

  async authenticate(dispatch, password) {
    const state = this.stateRef;
    if (state.lockoutUntil && Date.now() < state.lockoutUntil) {
      dispatch({
        type: "BANNER",
        banner: {
          type: "warn",
          message: "Bloqueado temporalmente por demasiados intentos",
        },
      });
      return false;
    }

    dispatch({ type: "AUTH_START", method: AUTH_METHOD.PASSWORD });
    kernelBus.emit(LOCK_EVENTS.AUTH_STARTED, {
      method: AUTH_METHOD.PASSWORD,
    });

    const user = this.users.getActive();
    if (!user) {
      dispatch({ type: "AUTH_FAIL", error: "Usuario no encontrado" });
      kernelBus.emit(LOCK_EVENTS.AUTH_FAIL, { error: "user-not-found" });
      return false;
    }

    if (!this.users.hasPassword(user)) {
      this.unlock(dispatch, AUTH_METHOD.PASSWORD);
      kernelBus.emit(LOCK_EVENTS.AUTH_OK, { method: AUTH_METHOD.PASSWORD });
      return true;
    }

    const hash = await hashPassword(password);
    const ok = constantTimeEqual(hash, user.passwordHash);

    if (ok) {
      kernelBus.emit(LOCK_EVENTS.AUTH_OK, { method: AUTH_METHOD.PASSWORD });
      this.unlock(dispatch, AUTH_METHOD.PASSWORD);
      return true;
    }

    this._registerFailedAttempt(dispatch);
    kernelBus.emit(LOCK_EVENTS.AUTH_FAIL, { method: AUTH_METHOD.PASSWORD });
    return false;
  }

  async authenticateBiometry(dispatch) {
    const state = this.stateRef;
    if (state.lockoutUntil && Date.now() < state.lockoutUntil) return false;

    const user = this.users.getActive();
    if (!user || !this.options.enableTouchId || !user.touchId) {
      dispatch({
        type: "BANNER",
        banner: {
          type: "info",
          message: "Touch ID no está disponible para este usuario",
        },
      });
      return false;
    }

    dispatch({ type: "AUTH_START", method: AUTH_METHOD.TOUCH_ID });
    kernelBus.emit(LOCK_EVENTS.BIOMETRY_STARTED, {
      method: AUTH_METHOD.TOUCH_ID,
    });

    const ok = await new Promise((resolve) =>
      setTimeout(() => resolve(true), 400)
    );

    if (ok) {
      kernelBus.emit(LOCK_EVENTS.BIOMETRY_OK, {});
      kernelBus.emit(LOCK_EVENTS.AUTH_OK, { method: AUTH_METHOD.TOUCH_ID });
      this.unlock(dispatch, AUTH_METHOD.TOUCH_ID);
      return true;
    }

    this._registerFailedAttempt(dispatch);
    kernelBus.emit(LOCK_EVENTS.BIOMETRY_FAIL, {});
    return false;
  }

  _registerFailedAttempt(dispatch) {
    const state = this.stateRef;
    const attempts = (state.failedAttempts || 0) + 1;
    const max = this.options.maxFailedAttempts;

    dispatch({
      type: "AUTH_FAIL",
      error:
        attempts >= max
          ? "Demasiados intentos. Espera antes de volver a intentarlo."
          : "Contraseña incorrecta",
    });

    kernelBus.emit(LOCK_EVENTS.FAILED_ATTEMPT, { attempts, max });

    if (attempts >= max) {
      const over = attempts - max;
      const base = this.options.lockoutBaseMs;
      const mult = Math.pow(this.options.lockoutMultiplier, over);
      const durationMs = Math.round(base * mult);
      const until = Date.now() + durationMs;

      dispatch({ type: "LOCKOUT", until });
      kernelBus.emit(LOCK_EVENTS.LOCKOUT, { until, durationMs });

      setTimeout(() => {
        dispatch({ type: "LOCKOUT_END" });
        kernelBus.emit(LOCK_EVENTS.LOCKOUT_END, {});
      }, durationMs);
    }
  }

  switchUser(dispatch, userId) {
    dispatch({ type: "SWITCH_USER" });
    kernelBus.emit(LOCK_EVENTS.USER_SWITCHING, {
      from: this.users.activeUserId,
      to: userId,
    });
    this.users.setActive(userId);
    dispatch({ type: "SET_USER", id: userId });
    kernelBus.emit(LOCK_EVENTS.USER_CHANGED, { id: userId });
    setTimeout(() => {
      dispatch({ type: "LOCK", graceUntil: null });
    }, 200);
  }

  showScreenSaver(dispatch) {
    const state = this.stateRef;
    if (!state.locked) {
      this.lock(dispatch, "screen-saver");
    }
    dispatch({ type: "SHOW_SAVER" });
    kernelBus.emit(LOCK_EVENTS.SCREEN_SAVER_ON, {});
  }

  hideScreenSaver(dispatch) {
    dispatch({ type: "HIDE_SAVER" });
    kernelBus.emit(LOCK_EVENTS.SCREEN_SAVER_OFF, {});
  }

  sleep(dispatch) {
    if (this.options.lockOnSuspend) {
      this.lock(dispatch, "suspend");
    }
    dispatch({ type: "SLEEP" });
    kernelBus.emit(LOCK_EVENTS.SLEEP, {});
  }

  wake(dispatch) {
    dispatch({ type: "WAKE" });
    kernelBus.emit(LOCK_EVENTS.WAKE, {});
    this.idle?._reset?.();
  }

  shutdown(dispatch) {
    dispatch({ type: "SHUTDOWN" });
    kernelBus.emit(LOCK_EVENTS.SHUTDOWN, {});
    this._emitShutdown();
  }

  restart(dispatch) {
    dispatch({ type: "RESTART" });
    kernelBus.emit(LOCK_EVENTS.RESTART, {});
    this._emitRestart();
  }

  cancel(dispatch) {
    kernelBus.emit(LOCK_EVENTS.CANCEL, {});
    dispatch({ type: "LOCK", graceUntil: null });
  }

  startClock(dispatch) {
    if (this._clockHandle) clearInterval(this._clockHandle);
    this._clockHandle = setInterval(() => {
      const now = Date.now();
      dispatch({ type: "CLOCK", now });
      kernelBus.emit(LOCK_EVENTS.CLOCK_TICK, { now });
    }, 1000);
  }

  stopClock() {
    if (this._clockHandle) clearInterval(this._clockHandle);
    this._clockHandle = null;
  }

  attachVisibility(dispatch) {
    if (typeof document === "undefined") return () => {};
    const handler = () => {
      if (document.hidden) {
        kernelBus.emit(LOCK_EVENTS.VISIBILITY_HIDDEN, {});
        if (this.options.lockOnVisibilityHidden) {
          this.lock(dispatch, "visibility-hidden");
        }
      } else {
        kernelBus.emit(LOCK_EVENTS.VISIBILITY_VISIBLE, {});
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }

  bootstrap(dispatch) {
    this.dispatchRef = dispatch;

    const active = this.users.getActive();
    if (active) dispatch({ type: "SET_USER", id: active.id });

    dispatch({ type: "SET_OPTIONS", options: this.options });
    dispatch({ type: "LOCK", graceUntil: null });
    dispatch({ type: "SET_STATE", state: LOCK_STATE.LOCKED });

    kernelBus.emit(LOCK_EVENTS.STARTED, { options: this.options });

    this.attachIdleMonitor(dispatch);
    this.startClock(dispatch);
    const offVis = this.attachVisibility(dispatch);

    this._cleanup = () => {
      this.detachIdleMonitor();
      this.stopClock();
      offVis();
    };
  }

  dispose() {
    if (this._cleanup) this._cleanup();
    this._cleanup = null;
  }
}

// ============================================================================
// CONTEXTO
// ============================================================================

const LockScreenContext = createContext(null);

export function LockScreenProvider({
  children,
  lock: external,
  options = {},
  autoLock = true,
  onUnlocked,
  onLocked,
  onShutdown,
  onRestart,
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new LockScreen(options);
  }
  const lock = ref.current;

  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
    lock.stateRef = state;
  }, [state, lock]);

  useEffect(() => {
    const off = kernelBus.on(LOCK_EVENTS.LOG, (entry) => {
      dispatch({ type: "LOG", entry });
    });
    return off;
  }, []);

  useEffect(() => {
    if (!autoLock) return;
    lock.bootstrap(dispatch);
    return () => lock.dispose();
  }, [autoLock]);

  useEffect(() => {
    const offU = lock.onUnlocked((reason) => onUnlocked?.(reason));
    const offL = lock.onLocked((reason) => onLocked?.(reason));
    const offS = lock.onShutdown(() => onShutdown?.());
    const offR = lock.onRestart(() => onRestart?.());
    return () => {
      offU();
      offL();
      offS();
      offR();
    };
  }, [onUnlocked, onLocked, onShutdown, onRestart]);

  const api = useMemo(
    () => ({
      lock,
      state,
      locked: state.locked,
      showScreenSaver: state.showScreenSaver,
      unlocking: state.unlocking,
      currentUserId: state.currentUserId,
      failedAttempts: state.failedAttempts,
      lockoutUntil: state.lockoutUntil,
      banner: state.banner,
      shakeKey: state.shakeKey,
      now: state.now,
      options: state.options,
      logs: state.logs,
      users: lock.users.list(),

      lockNow: () => lock.lock(dispatch, "manual"),
      lockIdle: () => lock.lock(dispatch, "idle"),
      lockGrace: () => lock.lock(dispatch, "manual", { grace: true }),
      unlock: () => lock.unlock(dispatch, "programmatic"),
      authenticate: (pw) => lock.authenticate(dispatch, pw),
      authenticateBiometry: () => lock.authenticateBiometry(dispatch),
      switchUser: (id) => lock.switchUser(dispatch, id),

      showScreenSaver: () => lock.showScreenSaver(dispatch),
      hideScreenSaver: () => lock.hideScreenSaver(dispatch),

      sleep: () => lock.sleep(dispatch),
      wake: () => lock.wake(dispatch),
      shutdown: () => lock.shutdown(dispatch),
      restart: () => lock.restart(dispatch),
      cancel: () => lock.cancel(dispatch),

      clearBanner: () => dispatch({ type: "CLEAR_BANNER" }),
      setOptions: (opts) => {
        lock.options = { ...lock.options, ...opts };
        dispatch({ type: "SET_OPTIONS", options: opts });
      },
      reloadUsers: () => {
        lock.users.reload();
        const active = lock.users.getActive();
        if (active) dispatch({ type: "SET_USER", id: active.id });
      },
    }),
    [lock, state]
  );

  return (
    <LockScreenContext.Provider value={api}>
      {children}
    </LockScreenContext.Provider>
  );
}

export function useLockScreen() {
  const ctx = useContext(LockScreenContext);
  if (!ctx)
    throw new Error("useLockScreen must be used within a LockScreenProvider");
  return ctx;
}

// ============================================================================
// VISTA VISUAL
// ============================================================================

export function LockScreenView({
  bg = "#000",
  fg = "#fff",
  onUnlocked,
  children,
}) {
  const api = useLockScreen();
  const [pw, setPw] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (!api.locked) return;
    inputRef.current?.focus?.();
  }, [api.locked]);

  useEffect(() => {
    if (api.state.state === LOCK_STATE.UNLOCKED) {
      onUnlocked?.();
    }
  }, [api.state.state, onUnlocked]);

  const time = useMemo(() => {
    const d = new Date(api.now);
    const h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, "0");
    if (api.options.clockFormat === "12h") {
      const hh = h % 12 || 12;
      const ampm = h >= 12 ? "PM" : "AM";
      return `${hh}:${m} ${ampm}`;
    }
    return `${String(h).padStart(2, "0")}:${m}`;
  }, [api.now, api.options.clockFormat]);

  const date = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
      }).format(new Date(api.now));
    } catch {
      return new Date(api.now).toDateString();
    }
  }, [api.now]);

  const user =
    api.users.find((u) => u.id === api.currentUserId) || api.users[0];

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!pw) return;
    await api.authenticate(pw);
    setPw("");
  };

  if (!api.locked && api.state.state !== LOCK_STATE.UNLOCKED) return null;
  if (api.state.state === LOCK_STATE.UNLOCKED) return null;

  return (
    <div
      className="lockscreen-root"
      style={{
        position: "fixed",
        inset: 0,
        background: bg,
        color: fg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        fontFamily:
          '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
        zIndex: 2147483000,
        userSelect: "none",
        backdropFilter: api.options.blurWallpaper ? "blur(30px)" : undefined,
        WebkitBackdropFilter: api.options.blurWallpaper
          ? "blur(30px)"
          : undefined,
      }}
    >
      <style>{`
        @keyframes lockscreen-shake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-8px); }
          40% { transform: translateX(8px); }
          60% { transform: translateX(-6px); }
          80% { transform: translateX(6px); }
        }
        @keyframes lockscreen-fadein {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .lockscreen-root * { box-sizing: border-box; }
      `}</style>

      <div style={{ textAlign: "center", marginBottom: 40 }}>
        <div
          style={{
            fontSize: 84,
            fontWeight: 200,
            letterSpacing: "0.01em",
            lineHeight: 1,
          }}
        >
          {time}
        </div>
        <div style={{ fontSize: 18, opacity: 0.7, marginTop: 8 }}>{date}</div>
      </div>

      {user && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 14,
            marginBottom: 28,
          }}
        >
          <div
            style={{
              width: 84,
              height: 84,
              borderRadius: "50%",
              background: "rgba(255,255,255,0.12)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 36,
              overflow: "hidden",
            }}
          >
            {user.photo ? (
              <img
                src={user.photo}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              <span>👤</span>
            )}
          </div>
          <div style={{ fontSize: 16, fontWeight: 500 }}>{user.fullName}</div>
        </div>
      )}

      <form
        onSubmit={submit}
        key={api.shakeKey}
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          animation: api.shakeKey
            ? "lockscreen-shake 0.35s ease-in-out"
            : undefined,
        }}
      >
        <input
          ref={inputRef}
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="Introduce la contraseña"
          disabled={!!api.lockoutUntil && Date.now() < api.lockoutUntil}
          style={{
            width: 240,
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.2)",
            background: "rgba(255,255,255,0.1)",
            color: fg,
            fontSize: 14,
            outline: "none",
          }}
        />
        <button
          type="submit"
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            border: "none",
            background: "rgba(255,255,255,0.9)",
            color: "#000",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          →
        </button>
      </form>

      {api.banner && (
        <div
          style={{
            marginTop: 20,
            fontSize: 13,
            color:
              api.banner.type === "error"
                ? "#fc8181"
                : api.banner.type === "warn"
                ? "#f6ad55"
                : "rgba(255,255,255,0.7)",
          }}
        >
          {api.banner.message}
        </div>
      )}

      <div
        style={{
          position: "absolute",
          bottom: 28,
          display: "flex",
          gap: 22,
          fontSize: 12,
          opacity: 0.55,
        }}
      >
        <button
          onClick={api.sleep}
          style={{
            background: "none",
            border: "none",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          Dormir
        </button>
        <button
          onClick={api.restart}
          style={{
            background: "none",
            border: "none",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          Reiniciar
        </button>
        <button
          onClick={api.shutdown}
          style={{
            background: "none",
            border: "none",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          Apagar
        </button>
      </div>

      {children}
    </div>
  );
}

// ============================================================================
// HOOKS AUXILIARES
// ============================================================================

export function useLocked() {
  const { locked } = useLockScreen();
  return locked;
}

export function useLockActions() {
  const { lockNow, sleep, shutdown, restart } = useLockScreen();
  return { lockNow, sleep, shutdown, restart };
}

// ============================================================================
// EXPORTS DEFAULT
// ============================================================================

export default {
  LockScreen,
  LockScreenProvider,
  LockScreenView,
  useLockScreen,
  useLocked,
  useLockActions,
  LOCK_STATE,
  AUTH_METHOD,
  LOCK_EVENTS,
  DEFAULT_LOCK_OPTIONS,
};
