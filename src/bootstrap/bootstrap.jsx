// ============================================================================
// bootstrap.jsx — Bootstrap del kernel de macOS
// ----------------------------------------------------------------------------
// El primer código en ejecutarse. Sus responsabilidades:
// - Ejecutarse ANTES que React (función pura fuera de componentes)
// - Validar precondiciones absolutas (document, window, etc.)
// - Instalar polyfills mínimos (RAF, performance.now, crypto.randomUUID)
// - Capturar errores globales (window.onerror, unhandledrejection)
// - Congelar objetos críticos para evitar mutaciones externas
// - Registrar un manifest de módulos del sistema
// - Cargar módulos iniciales en orden determinista
// - Detectar SSR/CSR y abortar limpiamente en SSR
// - Configurar el bus de eventos raíz
// - Registrar el Service Worker si procede
// - Guardar trazas de arranque en memoria (ring buffer)
// - Entregar el control al BootLoader
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

// ============================================================================
// CONSTANTES
// ============================================================================

export const BOOTSTRAP_STATE = Object.freeze({
  PENDING: "pending",
  VALIDATING: "validating",
  POLYFILLING: "polyfilling",
  FREEZING: "freezing",
  MODULES: "modules",
  READY: "ready",
  FAILED: "failed",
  SKIPPED_SSR: "skipped-ssr",
  ABORTED: "aborted",
});

export const BOOTSTRAP_EVENTS = Object.freeze({
  STARTED: "bootstrap:started",
  STATE_CHANGED: "bootstrap:state-changed",
  VALIDATION_OK: "bootstrap:validation-ok",
  VALIDATION_FAIL: "bootstrap:validation-fail",
  POLYFILL_INSTALLED: "bootstrap:polyfill-installed",
  POLYFILL_SKIPPED: "bootstrap:polyfill-skipped",
  FROZEN: "bootstrap:frozen",
  MODULE_REGISTERED: "bootstrap:module-registered",
  MODULE_LOADED: "bootstrap:module-loaded",
  MODULE_FAILED: "bootstrap:module-failed",
  GLOBAL_ERROR: "bootstrap:global-error",
  GLOBAL_REJECTION: "bootstrap:global-rejection",
  SW_REGISTERED: "bootstrap:sw-registered",
  SW_FAILED: "bootstrap:sw-failed",
  READY: "bootstrap:ready",
  FAILED: "bootstrap:failed",
  TRACE: "bootstrap:trace",
});

export const BOOTSTRAP_PRIORITY = Object.freeze({
  CRITICAL: 0,
  HIGH: 10,
  NORMAL: 20,
  LOW: 30,
  IDLE: 40,
});

// ============================================================================
// BUS DE EVENTOS PROPIO
// ============================================================================

class BootstrapEventBus {
  constructor() {
    this.listeners = new Map();
    this.history = [];
    this.maxHistory = 1000;
  }

  on(event, handler) {
    if (typeof handler !== "function") return () => {};
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const set = this.listeners.get(event);
    if (set) set.delete(handler);
  }

  emit(event, payload) {
    const record = { ts: Date.now(), event, payload: payload ?? null };
    this.history.push(record);
    if (this.history.length > this.maxHistory) this.history.shift();

    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const handler of Array.from(set)) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[bootstrap] listener error on "${event}"`, err);
      }
    }
  }

  clear() {
    this.listeners.clear();
    this.history = [];
  }

  getHistory() {
    return [...this.history];
  }
}

export const bootstrapBus = new BootstrapEventBus();

// ============================================================================
// TRACE LOGGER
// ============================================================================

class TraceLog {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
    this.startTs = Date.now();
  }

  push(level, message, meta) {
    const entry = {
      ts: Date.now(),
      delta: Date.now() - this.startTs,
      level,
      message,
      meta: meta ?? null,
    };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();
    bootstrapBus.emit(BOOTSTRAP_EVENTS.TRACE, entry);
    return entry;
  }

  info(msg, meta) {
    return this.push("info", msg, meta);
  }
  warn(msg, meta) {
    return this.push("warn", msg, meta);
  }
  error(msg, meta) {
    return this.push("error", msg, meta);
  }
  debug(msg, meta) {
    return this.push("debug", msg, meta);
  }

  all() {
    return [...this.entries];
  }

  clear() {
    this.entries = [];
    this.startTs = Date.now();
  }

  dump() {
    return this.entries
      .map(
        (e) =>
          `[+${String(e.delta).padStart(6, " ")}ms] ${e.level.toUpperCase()} ${e.message}`
      )
      .join("\n");
  }
}

export const bootstrapTrace = new TraceLog();

// ============================================================================
// VALIDADORES DE PRECONDICIONES
// ============================================================================

const REQUIRED_GLOBALS = [
  { name: "window", required: true, ssrSafe: true },
  { name: "document", required: true, ssrSafe: true },
  { name: "navigator", required: false, ssrSafe: true },
  { name: "localStorage", required: false, ssrSafe: false },
  { name: "sessionStorage", required: false, ssrSafe: false },
];

export function validateEnvironment() {
  const results = [];
  let allOk = true;

  const isSSR =
    typeof window === "undefined" || typeof document === "undefined";

  for (const g of REQUIRED_GLOBALS) {
    let exists = false;
    try {
      exists = typeof globalThis[g.name] !== "undefined";
    } catch {
      exists = false;
    }

    const ok = exists || !g.required || isSSR;
    if (!ok) allOk = false;

    results.push({
      name: g.name,
      required: g.required,
      exists,
      ok,
    });
  }

  return {
    ok: allOk,
    isSSR,
    results,
  };
}

// ============================================================================
// POLYFILLS
// ============================================================================

const polyfills = [
  {
    id: "raf",
    check: () =>
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function",
    install: () => {
      if (typeof window === "undefined") return;
      const raf = (cb) => setTimeout(() => cb(Date.now()), 16);
      const caf = (id) => clearTimeout(id);
      if (!window.requestAnimationFrame) window.requestAnimationFrame = raf;
      if (!window.cancelAnimationFrame) window.cancelAnimationFrame = caf;
      if (typeof globalThis !== "undefined") {
        if (!globalThis.requestAnimationFrame)
          globalThis.requestAnimationFrame = raf;
        if (!globalThis.cancelAnimationFrame)
          globalThis.cancelAnimationFrame = caf;
      }
    },
  },
  {
    id: "performance-now",
    check: () =>
      typeof performance !== "undefined" &&
      typeof performance.now === "function",
    install: () => {
      if (typeof globalThis === "undefined") return;
      if (typeof globalThis.performance === "undefined") {
        globalThis.performance = {};
      }
      if (typeof globalThis.performance.now !== "function") {
        const start = Date.now();
        globalThis.performance.now = () => Date.now() - start;
      }
    },
  },
  {
    id: "crypto-randomUUID",
    check: () =>
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function",
    install: () => {
      if (typeof globalThis === "undefined") return;
      if (typeof globalThis.crypto === "undefined") {
        globalThis.crypto = {};
      }
      const c = globalThis.crypto;
      if (typeof c.getRandomValues !== "function") {
        c.getRandomValues = (arr) => {
          for (let i = 0; i < arr.length; i++) {
            arr[i] = Math.floor(Math.random() * 256);
          }
          return arr;
        };
      }
      if (typeof c.randomUUID !== "function") {
        c.randomUUID = () => {
          const bytes = new Uint8Array(16);
          c.getRandomValues(bytes);
          bytes[6] = (bytes[6] & 0x0f) | 0x40;
          bytes[8] = (bytes[8] & 0x3f) | 0x80;
          const hex = Array.from(bytes, (b) =>
            b.toString(16).padStart(2, "0")
          ).join("");
          return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
            12,
            16
          )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        };
      }
    },
  },
  {
    id: "array-at",
    check: () => typeof Array.prototype.at === "function",
    install: () => {
      if (typeof Array.prototype.at !== "function") {
        Object.defineProperty(Array.prototype, "at", {
          value: function at(n) {
            const len = this.length;
            const i = Math.trunc(n) || 0;
            const idx = i >= 0 ? i : len + i;
            if (idx < 0 || idx >= len) return undefined;
            return this[idx];
          },
          writable: true,
          configurable: true,
          enumerable: false,
        });
      }
    },
  },
  {
    id: "object-hasOwn",
    check: () => typeof Object.hasOwn === "function",
    install: () => {
      if (typeof Object.hasOwn !== "function") {
        Object.hasOwn = (obj, prop) =>
          Object.prototype.hasOwnProperty.call(obj, prop);
      }
    },
  },
  {
    id: "structuredClone",
    check: () => typeof globalThis.structuredClone === "function",
    install: () => {
      if (typeof globalThis.structuredClone !== "function") {
        globalThis.structuredClone = (value) => {
          if (value === null || typeof value !== "object") return value;
          if (typeof value === "function") return value;
          if (value instanceof Date) return new Date(value.getTime());
          if (value instanceof RegExp) return new RegExp(value);
          if (value instanceof Map) {
            const m = new Map();
            value.forEach((v, k) =>
              m.set(
                globalThis.structuredClone(k),
                globalThis.structuredClone(v)
              )
            );
            return m;
          }
          if (value instanceof Set) {
            const s = new Set();
            value.forEach((v) => s.add(globalThis.structuredClone(v)));
            return s;
          }
          if (Array.isArray(value))
            return value.map(globalThis.structuredClone);
          const out = {};
          for (const k of Object.keys(value)) {
            out[k] = globalThis.structuredClone(value[k]);
          }
          return out;
        };
      }
    },
  },
  {
    id: "queue-microtask",
    check: () => typeof globalThis.queueMicrotask === "function",
    install: () => {
      if (typeof globalThis.queueMicrotask !== "function") {
        globalThis.queueMicrotask = (cb) => Promise.resolve().then(cb);
      }
    },
  },
];

export function installPolyfills() {
  const installed = [];
  const skipped = [];
  const failed = [];

  for (const p of polyfills) {
    try {
      if (p.check()) {
        skipped.push(p.id);
        bootstrapBus.emit(BOOTSTRAP_EVENTS.POLYFILL_SKIPPED, { id: p.id });
        continue;
      }
      p.install();
      installed.push(p.id);
      bootstrapBus.emit(BOOTSTRAP_EVENTS.POLYFILL_INSTALLED, { id: p.id });
      bootstrapTrace.info(`polyfill installed: ${p.id}`);
    } catch (err) {
      failed.push({ id: p.id, error: String(err) });
      bootstrapTrace.error(`polyfill failed: ${p.id}`, err);
    }
  }

  return { installed, skipped, failed };
}

// ============================================================================
// FREEZE DE OBJETOS CRÍTICOS
// ============================================================================

export function freezeCriticalObjects() {
  const frozen = [];

  const tryFreeze = (label, obj) => {
    try {
      if (obj && !Object.isFrozen(obj)) {
        Object.freeze(obj);
        frozen.push(label);
      }
    } catch {
      /* noop */
    }
  };

  tryFreeze("BOOTSTRAP_STATE", BOOTSTRAP_STATE);
  tryFreeze("BOOTSTRAP_EVENTS", BOOTSTRAP_EVENTS);
  tryFreeze("BOOTSTRAP_PRIORITY", BOOTSTRAP_PRIORITY);

  bootstrapBus.emit(BOOTSTRAP_EVENTS.FROZEN, { frozen });
  bootstrapTrace.info("critical objects frozen", frozen);
  return frozen;
}

// ============================================================================
// CAPTURA GLOBAL DE ERRORES
// ============================================================================

export function installGlobalErrorHandlers() {
  if (typeof window === "undefined") return () => {};

  const onError = (event) => {
    const info = {
      message: event?.message || "unknown error",
      filename: event?.filename || null,
      lineno: event?.lineno || null,
      colno: event?.colno || null,
      error: event?.error ? String(event.error) : null,
      stack: event?.error?.stack || null,
    };
    bootstrapTrace.error("window.onerror", info);
    bootstrapBus.emit(BOOTSTRAP_EVENTS.GLOBAL_ERROR, info);
  };

  const onRejection = (event) => {
    const info = {
      reason: event?.reason ? String(event.reason) : "unhandled rejection",
      stack: event?.reason?.stack || null,
    };
    bootstrapTrace.error("unhandledrejection", info);
    bootstrapBus.emit(BOOTSTRAP_EVENTS.GLOBAL_REJECTION, info);
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

// ============================================================================
// MANIFEST DE MÓDULOS
// ============================================================================

export class ModuleManifest {
  constructor() {
    this.modules = new Map();
    this.loaded = new Set();
    this.failed = new Map();
  }

  register(id, mod) {
    if (this.modules.has(id)) {
      bootstrapTrace.warn(`module already registered: ${id}`);
      return false;
    }
    this.modules.set(id, {
      id,
      priority: mod.priority ?? BOOTSTRAP_PRIORITY.NORMAL,
      critical: !!mod.critical,
      deps: mod.deps || [],
      loader: mod.loader || (async () => {}),
      timeout: mod.timeout ?? 8000,
      retries: mod.retries ?? 0,
    });
    bootstrapBus.emit(BOOTSTRAP_EVENTS.MODULE_REGISTERED, { id });
    bootstrapTrace.info(`module registered: ${id}`);
    return true;
  }

  get(id) {
    return this.modules.get(id) ?? null;
  }

  order() {
    const visited = new Set();
    const temp = new Set();
    const out = [];

    const visit = (id) => {
      if (visited.has(id)) return;
      if (temp.has(id)) {
        throw new Error(`[bootstrap] circular dependency at "${id}"`);
      }
      temp.add(id);
      const m = this.modules.get(id);
      if (!m) throw new Error(`[bootstrap] missing module "${id}"`);
      for (const d of m.deps) visit(d);
      temp.delete(id);
      visited.add(id);
      out.push(m);
    };

    for (const id of this.modules.keys()) visit(id);
    out.sort((a, b) => a.priority - b.priority);
    return out;
  }

  async load(id) {
    const m = this.modules.get(id);
    if (!m) throw new Error(`[bootstrap] module not found: ${id}`);
    if (this.loaded.has(id)) return true;

    let attempt = 0;
    let lastError = null;

    while (attempt <= m.retries) {
      try {
        await withTimeout(m.loader(), m.timeout, id);
        this.loaded.add(id);
        this.failed.delete(id);
        bootstrapBus.emit(BOOTSTRAP_EVENTS.MODULE_LOADED, { id });
        bootstrapTrace.info(`module loaded: ${id}`);
        return true;
      } catch (err) {
        lastError = err;
        attempt++;
        if (attempt <= m.retries) {
          bootstrapTrace.warn(
            `retrying module ${id} (${attempt}/${m.retries})`
          );
          await sleep(80 * attempt);
        }
      }
    }

    this.failed.set(id, lastError);
    bootstrapBus.emit(BOOTSTRAP_EVENTS.MODULE_FAILED, {
      id,
      error: String(lastError),
    });
    bootstrapTrace.error(`module failed: ${id}`, lastError);
    if (m.critical) throw lastError;
    return false;
  }

  async loadAll() {
    const order = this.order();
    const results = { ok: [], failed: [] };

    for (const m of order) {
      try {
        const ok = await this.load(m.id);
        if (ok) results.ok.push(m.id);
        else results.failed.push(m.id);
      } catch (err) {
        results.failed.push(m.id);
        throw err;
      }
    }

    return results;
  }

  reset() {
    this.loaded.clear();
    this.failed.clear();
  }

  all() {
    return Array.from(this.modules.values());
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(new Error(`[bootstrap] timeout in "${label}" (${ms}ms)`)),
      ms
    );
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

// ============================================================================
// SERVICE WORKER
// ============================================================================

export async function registerServiceWorker(url, options = {}) {
  if (
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator) ||
    typeof window === "undefined"
  ) {
    bootstrapTrace.warn("service worker not supported");
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.register(url, options);
    bootstrapBus.emit(BOOTSTRAP_EVENTS.SW_REGISTERED, {
      scope: reg.scope,
    });
    bootstrapTrace.info("service worker registered", { scope: reg.scope });
    return reg;
  } catch (err) {
    bootstrapBus.emit(BOOTSTRAP_EVENTS.SW_FAILED, { error: String(err) });
    bootstrapTrace.error("service worker failed", err);
    return null;
  }
}

// ============================================================================
// ESTADO / REDUCER
// ============================================================================

const initialBootstrapState = {
  state: BOOTSTRAP_STATE.PENDING,
  isSSR: null,
  validation: null,
  polyfills: { installed: [], skipped: [], failed: [] },
  frozen: [],
  modules: { registered: [], loaded: [], failed: [] },
  globalErrors: [],
  globalRejections: [],
  sw: null,
  startedAt: null,
  finishedAt: null,
  durationMs: 0,
  error: null,
};

function bootstrapReducer(state, action) {
  switch (action.type) {
    case "SET_STATE":
      return { ...state, state: action.state };

    case "START":
      return {
        ...initialBootstrapState,
        state: BOOTSTRAP_STATE.VALIDATING,
        startedAt: Date.now(),
      };

    case "VALIDATION":
      return {
        ...state,
        validation: action.validation,
        isSSR: action.validation.isSSR,
      };

    case "POLYFILLS":
      return { ...state, polyfills: action.polyfills };

    case "FROZEN":
      return { ...state, frozen: action.frozen };

    case "MODULE_REGISTERED":
      return {
        ...state,
        modules: {
          ...state.modules,
          registered: [...state.modules.registered, action.id],
        },
      };

    case "MODULE_LOADED":
      return {
        ...state,
        modules: {
          ...state.modules,
          loaded: [...state.modules.loaded, action.id],
        },
      };

    case "MODULE_FAILED":
      return {
        ...state,
        modules: {
          ...state.modules,
          failed: [...state.modules.failed, action.id],
        },
      };

    case "GLOBAL_ERROR":
      return {
        ...state,
        globalErrors: [...state.globalErrors, action.info],
      };

    case "GLOBAL_REJECTION":
      return {
        ...state,
        globalRejections: [...state.globalRejections, action.info],
      };

    case "SW":
      return { ...state, sw: action.sw };

    case "READY":
      return {
        ...state,
        state: action.skipped
          ? BOOTSTRAP_STATE.SKIPPED_SSR
          : BOOTSTRAP_STATE.READY,
        finishedAt: Date.now(),
        durationMs: state.startedAt ? Date.now() - state.startedAt : 0,
      };

    case "FAIL":
      return {
        ...state,
        state: BOOTSTRAP_STATE.FAILED,
        error: action.error,
        finishedAt: Date.now(),
        durationMs: state.startedAt ? Date.now() - state.startedAt : 0,
      };

    case "ABORT":
      return { ...state, state: BOOTSTRAP_STATE.ABORTED };

    default:
      return state;
  }
}

// ============================================================================
// BOOTSTRAP CORE
// ============================================================================

export class Bootstrap {
  constructor(options = {}) {
    this.options = {
      serviceWorkerUrl: null,
      serviceWorkerOptions: {},
      installErrorHandlers: true,
      installPolyfills: true,
      freeze: true,
      allowSSR: true,
      strict: false,
      ...options,
    };

    this.manifest = new ModuleManifest();
    this.cleanupFns = [];
    this.booted = false;
    this.aborted = false;
  }

  registerModule(id, mod) {
    return this.manifest.register(id, mod);
  }

  registerModules(list) {
    for (const [id, mod] of list) {
      this.manifest.register(id, mod);
    }
  }

  abort() {
    this.aborted = true;
    bootstrapTrace.warn("bootstrap aborted");
  }

  _cleanup() {
    for (const fn of this.cleanupFns) {
      try {
        fn();
      } catch (err) {
        bootstrapTrace.warn("cleanup error", err);
      }
    }
    this.cleanupFns = [];
  }

  async run({ dispatch, onReady, onFail } = {}) {
    bootstrapBus.emit(BOOTSTRAP_EVENTS.STARTED, {
      options: { ...this.options },
    });
    bootstrapTrace.info("bootstrap started");

    dispatch?.({ type: "START" });

    try {
      // 1. VALIDACIÓN
      dispatch?.({ type: "SET_STATE", state: BOOTSTRAP_STATE.VALIDATING });
      const validation = validateEnvironment();
      dispatch?.({ type: "VALIDATION", validation });

      if (!validation.ok) {
        bootstrapBus.emit(BOOTSTRAP_EVENTS.VALIDATION_FAIL, { validation });
        if (!this.options.allowSSR || !validation.isSSR) {
          throw new Error("[bootstrap] environment validation failed");
        }
      } else {
        bootstrapBus.emit(BOOTSTRAP_EVENTS.VALIDATION_OK, { validation });
      }

      if (validation.isSSR) {
        bootstrapTrace.info(
          "SSR detected, skipping browser-specific steps"
        );
        dispatch?.({ type: "READY", skipped: true });
        bootstrapBus.emit(BOOTSTRAP_EVENTS.READY, { ssr: true });
        onReady?.({ ssr: true });
        this.booted = true;
        return { ok: true, ssr: true };
      }

      if (this.aborted) throw new Error("aborted");

      // 2. POLYFILLS
      dispatch?.({ type: "SET_STATE", state: BOOTSTRAP_STATE.POLYFILLING });
      let polyfillResult = { installed: [], skipped: [], failed: [] };
      if (this.options.installPolyfills) {
        polyfillResult = installPolyfills();
      }
      dispatch?.({ type: "POLYFILLS", polyfills: polyfillResult });

      if (polyfillResult.failed.length > 0 && this.options.strict) {
        throw new Error(
          `[bootstrap] polyfills failed: ${polyfillResult.failed
            .map((f) => f.id)
            .join(", ")}`
        );
      }

      if (this.aborted) throw new Error("aborted");

      // 3. FREEZE
      dispatch?.({ type: "SET_STATE", state: BOOTSTRAP_STATE.FREEZING });
      let frozen = [];
      if (this.options.freeze) {
        frozen = freezeCriticalObjects();
      }
      dispatch?.({ type: "FROZEN", frozen });

      // 4. ERROR HANDLERS
      if (this.options.installErrorHandlers) {
        const cleanup = installGlobalErrorHandlers();
        this.cleanupFns.push(cleanup);
      }

      if (this.aborted) throw new Error("aborted");

      // 5. MÓDULOS
      dispatch?.({ type: "SET_STATE", state: BOOTSTRAP_STATE.MODULES });

      const offReg = bootstrapBus.on(
        BOOTSTRAP_EVENTS.MODULE_REGISTERED,
        (p) => dispatch?.({ type: "MODULE_REGISTERED", id: p.id })
      );
      const offLoaded = bootstrapBus.on(
        BOOTSTRAP_EVENTS.MODULE_LOADED,
        (p) => dispatch?.({ type: "MODULE_LOADED", id: p.id })
      );
      const offFailed = bootstrapBus.on(
        BOOTSTRAP_EVENTS.MODULE_FAILED,
        (p) => dispatch?.({ type: "MODULE_FAILED", id: p.id })
      );
      this.cleanupFns.push(offReg, offLoaded, offFailed);

      for (const m of this.manifest.all()) {
        dispatch?.({ type: "MODULE_REGISTERED", id: m.id });
      }

      const moduleResults = await this.manifest.loadAll();
      bootstrapTrace.info("modules loaded", moduleResults);

      if (moduleResults.failed.length > 0 && this.options.strict) {
        throw new Error(
          `[bootstrap] modules failed: ${moduleResults.failed.join(", ")}`
        );
      }

      if (this.aborted) throw new Error("aborted");

      // 6. SERVICE WORKER
      if (
        this.options.serviceWorkerUrl &&
        typeof navigator !== "undefined" &&
        "serviceWorker" in navigator
      ) {
        const reg = await registerServiceWorker(
          this.options.serviceWorkerUrl,
          this.options.serviceWorkerOptions
        );
        dispatch?.({
          type: "SW",
          sw: reg ? { scope: reg.scope } : null,
        });
      }

      // 7. READY
      dispatch?.({ type: "READY", skipped: false });
      bootstrapBus.emit(BOOTSTRAP_EVENTS.READY, { ssr: false });
      bootstrapTrace.info("bootstrap ready");
      this.booted = true;

      onReady?.({ ssr: false, moduleResults });
      return { ok: true, ssr: false, moduleResults };
    } catch (err) {
      bootstrapTrace.error("bootstrap failed", err);
      bootstrapBus.emit(BOOTSTRAP_EVENTS.FAILED, { error: String(err) });
      dispatch?.({ type: "FAIL", error: String(err) });
      onFail?.(err);
      return { ok: false, error: err };
    }
  }

  dispose() {
    this._cleanup();
    this.booted = false;
  }
}

// ============================================================================
// CONTEXTO + PROVIDER
// ============================================================================

const BootstrapContext = createContext(null);

export function BootstrapProvider({
  children,
  bootstrap: external,
  autoRun = true,
  options = {},
  onReady,
  onFail,
}) {
  const bootstrapRef = useRef(null);
  if (!bootstrapRef.current) {
    bootstrapRef.current = external || new Bootstrap(options);
  }
  const bootstrap = bootstrapRef.current;

  const [state, dispatch] = useReducer(
    bootstrapReducer,
    initialBootstrapState
  );

  useEffect(() => {
    if (!autoRun) return;
    let cancelled = false;

    (async () => {
      const result = await bootstrap.run({
        dispatch,
        onReady: (info) => {
          if (!cancelled) onReady?.(info);
        },
        onFail: (err) => {
          if (!cancelled) onFail?.(err);
        },
      });
      if (cancelled) return;
      void result;
    })();

    return () => {
      cancelled = true;
    };
  }, [autoRun]);

  useEffect(() => {
    return () => {
      bootstrap.dispose();
    };
  }, [bootstrap]);

  const api = useMemo(
    () => ({
      bootstrap,
      state,
      phase: state.state,
      isReady:
        state.state === BOOTSTRAP_STATE.READY ||
        state.state === BOOTSTRAP_STATE.SKIPPED_SSR,
      isFailed: state.state === BOOTSTRAP_STATE.FAILED,
      isSSR: state.isSSR,
      validation: state.validation,
      polyfills: state.polyfills,
      frozen: state.frozen,
      modules: state.modules,
      globalErrors: state.globalErrors,
      globalRejections: state.globalRejections,
      sw: state.sw,
      durationMs: state.durationMs,
      error: state.error,
      trace: bootstrapTrace,

      run: (opts) => bootstrap.run({ dispatch, ...opts }),
      abort: () => bootstrap.abort(),
      dispose: () => bootstrap.dispose(),

      registerModule: (id, mod) => bootstrap.registerModule(id, mod),
      registerModules: (list) => bootstrap.registerModules(list),

      onEvent: (event, handler) => bootstrapBus.on(event, handler),
    }),
    [bootstrap, state]
  );

  return (
    <BootstrapContext.Provider value={api}>
      {children}
    </BootstrapContext.Provider>
  );
}

export function useBootstrap() {
  const ctx = useContext(BootstrapContext);
  if (!ctx)
    throw new Error(
      "useBootstrap must be used within a BootstrapProvider"
    );
  return ctx;
}

// ============================================================================
// HOOKS AUXILIARES
// ============================================================================

export function useBootstrapTrace() {
  const { trace } = useBootstrap();
  return trace;
}

export function useGlobalErrors() {
  const { globalErrors, globalRejections } = useBootstrap();
  return { globalErrors, globalRejections };
}

export function useSystemModule(id, mod) {
  const { registerModule } = useBootstrap();
  const [registered, setRegistered] = useState(false);

  useEffect(() => {
    if (!id || !mod) return;
    try {
      registerModule(id, mod);
      setRegistered(true);
    } catch (err) {
      console.error(`[bootstrap] failed to register module ${id}`, err);
    }
  }, [id]);

  return registered;
}

// ============================================================================
// FUNCIONES DE ARRANQUE FUERA DE REACT
// ============================================================================

export async function bootstrapSystem(options = {}) {
  const bootstrap = new Bootstrap(options);
  bootstrapTrace.info("bootstrapSystem (headless) started");
  const result = await bootstrap.run({});
  return { bootstrap, result };
}

// ============================================================================
// EXPORTS DEFAULT
// ============================================================================

export default {
  Bootstrap,
  BootstrapProvider,
  useBootstrap,
  useBootstrapTrace,
  useGlobalErrors,
  useSystemModule,
  bootstrapBus,
  bootstrapTrace,
  bootstrapSystem,
  registerServiceWorker,
  installPolyfills,
  freezeCriticalObjects,
  installGlobalErrorHandlers,
  validateEnvironment,
  ModuleManifest,
  BOOTSTRAP_STATE,
  BOOTSTRAP_EVENTS,
  BOOTSTRAP_PRIORITY,
};
