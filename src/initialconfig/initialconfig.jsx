// ============================================================================
// initialconfig.jsx — Configuración inicial completa (Setup Assistant)
// ----------------------------------------------------------------------------
// Corre tras StartupInstaller y antes de Bootstrap final. Responsabilidades:
//
// 1. IDIOMA Y REGIÓN
// 2. CUENTA DE USUARIO
// 3. APARIENCIA
// 4. RED
// 5. PRIVACIDAD
// 6. ATAJOS Y GESTOS DEL SISTEMA
// 7. MIGRACIÓN (opcional)
// 8. RESUMEN Y FIN
//
// Todo puro JS. Sin UI obligatoria: expone estado + acciones.
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
import { bootstrapBus } from "../bootstrap/bootstrap.jsx";

// ============================================================================
// PASOS DEL ASISTENTE
// ============================================================================

export const SETUP_STEP = Object.freeze({
  IDLE: "idle",
  WELCOME: "welcome",
  LANGUAGE: "language",
  REGION: "region",
  KEYBOARD: "keyboard",
  NETWORK: "network",
  MIGRATION: "migration",
  ACCOUNT: "account",
  APPEARANCE: "appearance",
  DOCK: "dock",
  PRIVACY: "privacy",
  SHORTCUTS: "shortcuts",
  SUMMARY: "summary",
  APPLYING: "applying",
  DONE: "done",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const SETUP_ORDER = Object.freeze([
  SETUP_STEP.WELCOME,
  SETUP_STEP.LANGUAGE,
  SETUP_STEP.REGION,
  SETUP_STEP.KEYBOARD,
  SETUP_STEP.NETWORK,
  SETUP_STEP.MIGRATION,
  SETUP_STEP.ACCOUNT,
  SETUP_STEP.APPEARANCE,
  SETUP_STEP.DOCK,
  SETUP_STEP.PRIVACY,
  SETUP_STEP.SHORTCUTS,
  SETUP_STEP.SUMMARY,
  SETUP_STEP.APPLYING,
  SETUP_STEP.DONE,
]);

// ============================================================================
// EVENTOS
// ============================================================================

export const SETUP_EVENTS = Object.freeze({
  STARTED: "setup:started",
  STEP_ENTER: "setup:step-enter",
  STEP_EXIT: "setup:step-exit",
  STEP_CHANGED: "setup:step-changed",
  VALUE_CHANGED: "setup:value-changed",
  LANGUAGE_SET: "setup:language-set",
  REGION_SET: "setup:region-set",
  KEYBOARD_SET: "setup:keyboard-set",
  NETWORK_SET: "setup:network-set",
  MIGRATION_SET: "setup:migration-set",
  ACCOUNT_SET: "setup:account-set",
  APPEARANCE_SET: "setup:appearance-set",
  DOCK_SET: "setup:dock-set",
  PRIVACY_SET: "setup:privacy-set",
  SHORTCUTS_SET: "setup:shortcuts-set",
  APPLYING: "setup:applying",
  APPLIED: "setup:applied",
  VALIDATION_ERROR: "setup:validation-error",
  LOG: "setup:log",
  WARNING: "setup:warning",
  ERROR: "setup:error",
  PROGRESS: "setup:progress",
  COMPLETE: "setup:complete",
  FAILED: "setup:failed",
  CANCELLED: "setup:cancelled",
  RESET: "setup:reset",
});

// ============================================================================
// DATOS: IDIOMAS, REGIONES, TECLADOS, ZONAS HORARIAS, ACENTOS, FONDOS
// ============================================================================

export const LANGUAGES = Object.freeze([
  { code: "es-ES", name: "Español (España)", nativeName: "Español" },
  { code: "es-MX", name: "Español (México)", nativeName: "Español" },
  { code: "es-AR", name: "Español (Argentina)", nativeName: "Español" },
  { code: "en-US", name: "English (United States)", nativeName: "English" },
  { code: "en-GB", name: "English (United Kingdom)", nativeName: "English" },
  { code: "fr-FR", name: "Français", nativeName: "Français" },
  { code: "de-DE", name: "Deutsch", nativeName: "Deutsch" },
  { code: "it-IT", name: "Italiano", nativeName: "Italiano" },
  { code: "pt-BR", name: "Português (Brasil)", nativeName: "Português" },
  { code: "pt-PT", name: "Português (Portugal)", nativeName: "Português" },
  { code: "ja-JP", name: "日本語", nativeName: "日本語" },
  { code: "zh-CN", name: "中文 (简体)", nativeName: "中文" },
  { code: "ko-KR", name: "한국어", nativeName: "한국어" },
  { code: "ru-RU", name: "Русский", nativeName: "Русский" },
  { code: "ar-SA", name: "العربية", nativeName: "العربية" },
]);

export const REGIONS = Object.freeze([
  { code: "ES", name: "España" },
  { code: "MX", name: "México" },
  { code: "AR", name: "Argentina" },
  { code: "CO", name: "Colombia" },
  { code: "CL", name: "Chile" },
  { code: "PE", name: "Perú" },
  { code: "US", name: "Estados Unidos" },
  { code: "GB", name: "Reino Unido" },
  { code: "FR", name: "Francia" },
  { code: "DE", name: "Alemania" },
  { code: "IT", name: "Italia" },
  { code: "PT", name: "Portugal" },
  { code: "BR", name: "Brasil" },
  { code: "JP", name: "Japón" },
  { code: "CN", name: "China" },
  { code: "KR", name: "Corea del Sur" },
  { code: "RU", name: "Rusia" },
]);

export const TIMEZONES = Object.freeze([
  { id: "Europe/Madrid", name: "Madrid", offset: "+01:00" },
  { id: "Europe/London", name: "Londres", offset: "+00:00" },
  { id: "Europe/Paris", name: "París", offset: "+01:00" },
  { id: "Europe/Berlin", name: "Berlín", offset: "+01:00" },
  { id: "Europe/Lisbon", name: "Lisboa", offset: "+00:00" },
  { id: "America/Mexico_City", name: "Ciudad de México", offset: "-06:00" },
  { id: "America/Bogota", name: "Bogotá", offset: "-05:00" },
  { id: "America/Lima", name: "Lima", offset: "-05:00" },
  { id: "America/Santiago", name: "Santiago", offset: "-03:00" },
  { id: "America/Buenos_Aires", name: "Buenos Aires", offset: "-03:00" },
  { id: "America/New_York", name: "Nueva York", offset: "-05:00" },
  { id: "America/Los_Angeles", name: "Los Ángeles", offset: "-08:00" },
  { id: "Asia/Tokyo", name: "Tokio", offset: "+09:00" },
  { id: "Asia/Shanghai", name: "Shanghái", offset: "+08:00" },
  { id: "Asia/Seoul", name: "Seúl", offset: "+09:00" },
  { id: "UTC", name: "UTC", offset: "+00:00" },
]);

export const KEYBOARDS = Object.freeze([
  { id: "es", name: "Español — QWERTY" },
  { id: "es-ISO", name: "Español (ISO)" },
  { id: "en-US", name: "Inglés (EE. UU.)" },
  { id: "en-GB", name: "Inglés (Reino Unido)" },
  { id: "fr", name: "Francés — AZERTY" },
  { id: "de", name: "Alemán — QWERTZ" },
  { id: "it", name: "Italiano" },
  { id: "pt", name: "Portugués" },
  { id: "ja", name: "Japonés — Kana" },
  { id: "zh", name: "Chino — Pinyin" },
]);

export const DATE_FORMATS = Object.freeze([
  { id: "DD/MM/YYYY", example: "31/12/2026" },
  { id: "MM/DD/YYYY", example: "12/31/2026" },
  { id: "YYYY-MM-DD", example: "2026-12-31" },
]);

export const NUMBER_FORMATS = Object.freeze([
  { id: "1.234,56", name: "1.234,56 (Europa)" },
  { id: "1,234.56", name: "1,234.56 (EE. UU.)" },
  { id: "1 234,56", name: "1 234,56 (Francia)" },
]);

export const ACCENT_COLORS = Object.freeze([
  { id: "blue", name: "Azul", hex: "#0a84ff" },
  { id: "purple", name: "Púrpura", hex: "#bf5af2" },
  { id: "pink", name: "Rosa", hex: "#ff375f" },
  { id: "red", name: "Rojo", hex: "#ff453a" },
  { id: "orange", name: "Naranja", hex: "#ff9f0a" },
  { id: "yellow", name: "Amarillo", hex: "#ffd60a" },
  { id: "green", name: "Verde", hex: "#32d74b" },
  { id: "graphite", name: "Grafito", hex: "#8e8e93" },
]);

export const WALLPAPERS = Object.freeze([
  {
    id: "sonoma",
    name: "Sonoma",
    type: "gradient",
    css: "linear-gradient(135deg,#1e3a8a 0%,#6d28d9 50%,#db2777 100%)",
  },
  {
    id: "ventura",
    name: "Ventura",
    type: "gradient",
    css: "linear-gradient(135deg,#0f172a 0%,#1e40af 50%,#0891b2 100%)",
  },
  {
    id: "monterey",
    name: "Monterey",
    type: "gradient",
    css: "linear-gradient(135deg,#7c3aed 0%,#ec4899 50%,#f59e0b 100%)",
  },
  {
    id: "bigsur",
    name: "Big Sur",
    type: "gradient",
    css: "linear-gradient(135deg,#fb7185 0%,#a78bfa 50%,#38bdf8 100%)",
  },
  { id: "graphite", name: "Grafito", type: "solid", css: "#1c1c1e" },
  { id: "midnight", name: "Medianoche", type: "solid", css: "#0a0a0a" },
  { id: "snow", name: "Nieve", type: "solid", css: "#f5f5f7" },
]);

export const DOCK_POSITIONS = Object.freeze(["bottom", "left", "right"]);
export const DOCK_SIZES = Object.freeze(["small", "medium", "large"]);

// ============================================================================
// LOGGER
// ============================================================================

class SetupLog {
  constructor(max = 300) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(SETUP_EVENTS.LOG, e);
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
// CONFIG POR DEFECTO
// ============================================================================

export const DEFAULT_CONFIG = Object.freeze({
  language: "es-ES",
  region: "ES",
  timezone: "Europe/Madrid",
  dateFormat: "DD/MM/YYYY",
  numberFormat: "1.234,56",
  use24Hour: true,
  keyboard: "es",

  network: {
    mode: "wifi",
    ssid: null,
    security: "wpa2",
    hostname: "mac.local",
    dns: "automatic",
    ntpSync: true,
  },

  migration: {
    mode: "none",
    sourceId: null,
  },

  account: {
    fullName: "",
    shortName: "",
    photo: null,
    passwordHash: null,
    passwordHint: "",
    admin: true,
    touchId: false,
    securityQuestions: [],
  },

  appearance: {
    theme: "auto",
    accent: "blue",
    wallpaper: "sonoma",
    transparency: true,
    reduceMotion: false,
    increaseContrast: false,
  },

  dock: {
    position: "bottom",
    size: "medium",
    magnification: true,
    magnificationAmount: 1.35,
    autohide: false,
    showRecents: true,
    minimizeEffect: "genie",
  },

  menuBar: {
    showBattery: true,
    showClock: true,
    showWifi: true,
    showBluetooth: true,
    showControlCenter: true,
    showSpotlight: true,
    autoHide: false,
  },

  privacy: {
    analytics: false,
    location: false,
    siri: false,
    personalizedAds: false,
    crashReports: true,
    appTrackingTransparency: "ask",
  },

  shortcuts: {
    missionControl: "ctrl+ArrowUp",
    launchpad: "F4",
    spotlight: "meta+Space",
    switchSpaceLeft: "ctrl+ArrowLeft",
    switchSpaceRight: "ctrl+ArrowRight",
    screenshotFull: "meta+shift+3",
    screenshotArea: "meta+shift+4",
    lockScreen: "ctrl+meta+Q",
    forceQuit: "meta+alt+Escape",
    hideApp: "meta+H",
    quitApp: "meta+Q",
    expose: "F3",
  },
});

// ============================================================================
// VALIDADORES
// ============================================================================

function validateShortName(s) {
  if (!s) return "El nombre corto es obligatorio";
  if (!/^[a-z][a-z0-9_-]{1,31}$/i.test(s))
    return "Solo letras, números, guion y guion bajo (2-32)";
  return null;
}

function validateFullName(s) {
  if (!s || !s.trim()) return "El nombre completo es obligatorio";
  if (s.trim().length < 2) return "Mínimo 2 caracteres";
  if (s.length > 64) return "Máximo 64 caracteres";
  return null;
}

function validatePassword(pw, confirm) {
  if (!pw) return "La contraseña es obligatoria";
  if (pw.length < 4) return "Mínimo 4 caracteres";
  if (pw !== confirm) return "Las contraseñas no coinciden";
  return null;
}

export function validateConfig(config, step) {
  const errors = {};
  switch (step) {
    case SETUP_STEP.LANGUAGE:
      if (!config.language) errors.language = "Selecciona un idioma";
      break;
    case SETUP_STEP.REGION:
      if (!config.region) errors.region = "Selecciona una región";
      if (!config.timezone) errors.timezone = "Selecciona una zona horaria";
      break;
    case SETUP_STEP.KEYBOARD:
      if (!config.keyboard) errors.keyboard = "Selecciona un teclado";
      break;
    case SETUP_STEP.ACCOUNT: {
      const nameErr = validateFullName(config.account.fullName);
      const shortErr = validateShortName(config.account.shortName);
      if (nameErr) errors.fullName = nameErr;
      if (shortErr) errors.shortName = shortErr;
      break;
    }
    default:
      break;
  }
  return { ok: Object.keys(errors).length === 0, errors };
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

// ============================================================================
// STORAGE
// ============================================================================

class SetupStorage {
  constructor(ns = "initialconfig") {
    this.ns = ns;
    this.ls = typeof localStorage !== "undefined" ? localStorage : null;
    this.mem = new Map();
  }
  _k(k) {
    return `${this.ns}.${k}`;
  }
  get(k, def = null) {
    try {
      if (this.ls) {
        const raw = this.ls.getItem(this._k(k));
        return raw == null ? def : JSON.parse(raw);
      }
      return this.mem.has(k) ? this.mem.get(k) : def;
    } catch {
      return def;
    }
  }
  set(k, v) {
    try {
      if (this.ls) this.ls.setItem(this._k(k), JSON.stringify(v));
      else this.mem.set(k, v);
      return true;
    } catch {
      return false;
    }
  }
  remove(k) {
    try {
      if (this.ls) this.ls.removeItem(this._k(k));
      else this.mem.delete(k);
      return true;
    } catch {
      return false;
    }
  }
  clear() {
    try {
      if (this.ls) {
        const keys = [];
        for (let i = 0; i < this.ls.length; i++) {
          const key = this.ls.key(i);
          if (key && key.startsWith(`${this.ns}.`)) keys.push(key);
        }
        keys.forEach((k) => this.ls.removeItem(k));
      }
      this.mem.clear();
      return true;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// HELPERS: get/set por path
// ============================================================================

function deepGet(obj, path) {
  if (!path) return obj;
  const parts = Array.isArray(path) ? path : path.split(".");
  return parts.reduce((acc, p) => (acc == null ? acc : acc[p]), obj);
}

function deepSet(obj, path, value) {
  const parts = Array.isArray(path) ? path : path.split(".");
  const clone = Array.isArray(obj) ? [...obj] : { ...obj };
  let cur = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    cur[p] = Array.isArray(cur[p]) ? [...cur[p]] : { ...(cur[p] || {}) };
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return clone;
}

// ============================================================================
// ESTADO INICIAL
// ============================================================================

const initialState = {
  step: SETUP_STEP.IDLE,
  progress: 0,
  config: { ...DEFAULT_CONFIG },
  errors: {},
  warnings: [],
  error: null,
  logs: [],
  startedAt: null,
  finishedAt: null,
  durationMs: 0,
  completed: false,
};

// ============================================================================
// REDUCER
// ============================================================================

function reducer(state, action) {
  switch (action.type) {
    case "SET_STEP":
      return { ...state, step: action.step, errors: {} };

    case "START":
      return {
        ...initialState,
        step: SETUP_STEP.WELCOME,
        config: action.config || state.config,
        startedAt: Date.now(),
      };

    case "SET_VALUE": {
      const { path, value } = action;
      const next = deepSet(state.config, path, value);
      return { ...state, config: next };
    }

    case "SET_ERRORS":
      return { ...state, errors: action.errors || {} };

    case "ADD_WARNING":
      return { ...state, warnings: [...state.warnings, action.warning] };

    case "SET_ERROR":
      return { ...state, error: action.error };

    case "PROGRESS":
      return { ...state, progress: Math.max(state.progress, action.value) };

    case "LOG":
      return { ...state, logs: [...state.logs.slice(-299), action.entry] };

    case "APPLYING":
      return { ...state, step: SETUP_STEP.APPLYING, progress: 0 };

    case "COMPLETE":
      return {
        ...state,
        step: SETUP_STEP.DONE,
        progress: 100,
        completed: true,
        finishedAt: Date.now(),
        durationMs: state.startedAt ? Date.now() - state.startedAt : 0,
      };

    case "FAIL":
      return {
        ...state,
        step: SETUP_STEP.FAILED,
        error: action.error,
        finishedAt: Date.now(),
      };

    case "CANCEL":
      return { ...state, step: SETUP_STEP.CANCELLED };

    case "RESET":
      return {
        ...initialState,
        config: action.config || { ...DEFAULT_CONFIG },
      };

    default:
      return state;
  }
}

// ============================================================================
// INITIAL CONFIG
// ============================================================================

export class InitialConfig {
  constructor(options = {}) {
    this.options = {
      storageNamespace: "initialconfig",
      autoDetect: true,
      strict: false,
      ...options,
    };

    this.logger = new SetupLog();
    this.storage = new SetupStorage(this.options.storageNamespace);
    this.aborted = false;
    this.phaseHandlers = new Map();
  }

  onStep(step, handler) {
    if (!this.phaseHandlers.has(step)) this.phaseHandlers.set(step, []);
    this.phaseHandlers.get(step).push(handler);
    return () => {
      const arr = this.phaseHandlers.get(step);
      if (arr) {
        const i = arr.indexOf(handler);
        if (i >= 0) arr.splice(i, 1);
      }
    };
  }

  _runStepHandlers(step, config) {
    const handlers = this.phaseHandlers.get(step) || [];
    for (const h of handlers) {
      try {
        h({ step, config, logger: this.logger });
      } catch (err) {
        this.logger.warn(`step handler failed for ${step}`, err);
      }
    }
  }

  async autoDetect() {
    const detected = {};
    try {
      const lang =
        (typeof navigator !== "undefined" && navigator.language) || "es-ES";
      detected.language = lang;
      const region = lang.split("-")[1] || "ES";
      detected.region = region;
      detected.timezone =
        Intl?.DateTimeFormat?.().resolvedOptions?.().timeZone || "UTC";
      detected.use24Hour = !Intl?.DateTimeFormat?.(lang, { hour: "numeric" })
        ?.resolvedOptions?.()
        ?.hour12;
    } catch {
      /* noop */
    }
    return detected;
  }

  save(config) {
    const toSave = {
      ...config,
      account: {
        ...config.account,
        passwordHash: config.account.passwordHash
          ? config.account.passwordHash
          : null,
      },
    };
    const ok = this.storage.set("config", toSave);
    this.storage.set("configured", true);
    this.storage.set("configuredAt", Date.now());
    return ok;
  }

  load() {
    const stored = this.storage.get("config", null);
    if (!stored) return null;
    return { ...DEFAULT_CONFIG, ...stored };
  }

  isConfigured() {
    return this.storage.get("configured", false) === true;
  }

  reset() {
    this.storage.clear();
    kernelBus.emit(SETUP_EVENTS.RESET, {});
  }

  async apply(config, dispatch) {
    dispatch({ type: "APPLYING" });
    kernelBus.emit(SETUP_EVENTS.APPLYING, {});

    const totalSteps = 10;
    let applied = 0;
    const tick = (label) => {
      applied++;
      const pct = Math.round((applied / totalSteps) * 100);
      dispatch({ type: "PROGRESS", value: pct });
      kernelBus.emit(SETUP_EVENTS.PROGRESS, { value: pct, label });
      this.logger.info(`applying: ${label} (${pct}%)`);
    };

    try {
      if (typeof document !== "undefined") {
        document.documentElement.lang = config.language;
      }
    } catch {
      /* noop */
    }
    kernelBus.emit(SETUP_EVENTS.LANGUAGE_SET, {
      language: config.language,
    });
    tick("language");

    kernelBus.emit(SETUP_EVENTS.REGION_SET, {
      region: config.region,
      timezone: config.timezone,
      dateFormat: config.dateFormat,
      numberFormat: config.numberFormat,
      use24Hour: config.use24Hour,
    });
    tick("region");

    kernelBus.emit(SETUP_EVENTS.KEYBOARD_SET, {
      keyboard: config.keyboard,
    });
    tick("keyboard");

    kernelBus.emit(SETUP_EVENTS.NETWORK_SET, { network: config.network });
    tick("network");

    kernelBus.emit(SETUP_EVENTS.MIGRATION_SET, {
      migration: config.migration,
    });
    tick("migration");

    let account = { ...config.account };
    if (account.passwordHash == null && account._plainPassword) {
      account.passwordHash = await hashPassword(account._plainPassword);
    }
    delete account._plainPassword;
    delete account._passwordConfirm;
    kernelBus.emit(SETUP_EVENTS.ACCOUNT_SET, { account });
    tick("account");

    this._applyAppearance(config.appearance);
    kernelBus.emit(SETUP_EVENTS.APPEARANCE_SET, {
      appearance: config.appearance,
    });
    tick("appearance");

    this._applyDock(config.dock);
    kernelBus.emit(SETUP_EVENTS.DOCK_SET, { dock: config.dock });
    tick("dock");

    kernelBus.emit(SETUP_EVENTS.PRIVACY_SET, { privacy: config.privacy });
    tick("privacy");

    this._applyShortcuts(config.shortcuts);
    kernelBus.emit(SETUP_EVENTS.SHORTCUTS_SET, {
      shortcuts: config.shortcuts,
    });
    tick("shortcuts");

    kernelBus.emit(SETUP_EVENTS.APPLIED, {});
    this.logger.info("config applied");
  }

  _applyAppearance(appearance) {
    try {
      if (typeof document === "undefined") return;
      const root = document.documentElement;
      const theme = appearance.theme;
      if (theme === "dark") root.dataset.theme = "dark";
      else if (theme === "light") root.dataset.theme = "light";
      else {
        const prefersDark =
          typeof window !== "undefined" &&
          window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
        root.dataset.theme = prefersDark ? "dark" : "light";
      }
      root.dataset.accent = appearance.accent;
      if (appearance.reduceMotion) root.dataset.reduceMotion = "1";
      if (appearance.increaseContrast) root.dataset.increaseContrast = "1";
    } catch {
      /* noop */
    }
  }

  _applyDock(dock) {
    try {
      if (typeof document === "undefined") return;
      const root = document.documentElement;
      root.dataset.dockPosition = dock.position;
      root.dataset.dockSize = dock.size;
      root.dataset.dockAutohide = dock.autohide ? "1" : "0";
      root.dataset.dockMagnify = dock.magnification ? "1" : "0";
    } catch {
      /* noop */
    }
  }

  _applyShortcuts(shortcuts) {
    void shortcuts;
  }

  abort() {
    this.aborted = true;
    this.logger.warn("setup aborted");
  }
}

// ============================================================================
// CONTEXTO
// ============================================================================

const InitialConfigContext = createContext(null);

export function InitialConfigProvider({
  children,
  initialConfig: external,
  options = {},
  autoStart = true,
  onComplete,
  onFail,
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new InitialConfig(options);
  }
  const installer = ref.current;

  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const off = kernelBus.on(SETUP_EVENTS.LOG, (entry) => {
      dispatch({ type: "LOG", entry });
    });
    return off;
  }, []);

  useEffect(() => {
    if (!autoStart) return;
    let cancelled = false;
    (async () => {
      const base = { ...DEFAULT_CONFIG, ...(options.initialConfig || {}) };
      let merged = base;

      if (installer.options.autoDetect) {
        const detected = await installer.autoDetect();
        merged = {
          ...merged,
          language: detected.language || merged.language,
          region: detected.region || merged.region,
          timezone: detected.timezone || merged.timezone,
          use24Hour:
            detected.use24Hour != null
              ? detected.use24Hour
              : merged.use24Hour,
        };
      }

      if (installer.isConfigured()) {
        const stored = installer.load();
        if (stored) merged = { ...merged, ...stored };
      }

      if (cancelled) return;
      dispatch({ type: "START", config: merged });
      kernelBus.emit(SETUP_EVENTS.STARTED, { config: merged });
    })();
    return () => {
      cancelled = true;
    };
  }, [autoStart]);

  const goTo = useCallback((step) => {
    kernelBus.emit(SETUP_EVENTS.STEP_ENTER, { step });
    dispatch({ type: "SET_STEP", step });
    kernelBus.emit(SETUP_EVENTS.STEP_CHANGED, { step });
  }, []);

  const next = useCallback(() => {
    const cur = stateRef.current.step;
    const idx = SETUP_ORDER.indexOf(cur);
    if (idx < 0 || idx >= SETUP_ORDER.length - 1) return;
    const target = SETUP_ORDER[idx + 1];
    kernelBus.emit(SETUP_EVENTS.STEP_EXIT, { step: cur });
    goTo(target);
  }, [goTo]);

  const prev = useCallback(() => {
    const cur = stateRef.current.step;
    const idx = SETUP_ORDER.indexOf(cur);
    if (idx <= 0) return;
    const target = SETUP_ORDER[idx - 1];
    kernelBus.emit(SETUP_EVENTS.STEP_EXIT, { step: cur });
    goTo(target);
  }, [goTo]);

  const setValue = useCallback((path, value) => {
    dispatch({ type: "SET_VALUE", path, value });
    kernelBus.emit(SETUP_EVENTS.VALUE_CHANGED, { path, value });
  }, []);

  const setValues = useCallback((partial) => {
    for (const [k, v] of Object.entries(partial)) {
      dispatch({ type: "SET_VALUE", path: k, value: v });
    }
  }, []);

  const validate = useCallback((step) => {
    const result = validateConfig(stateRef.current.config, step);
    dispatch({ type: "SET_ERRORS", errors: result.errors });
    if (!result.ok) {
      kernelBus.emit(SETUP_EVENTS.VALIDATION_ERROR, { step, errors: result.errors });
    }
    return result;
  }, []);

  const apply = useCallback(async () => {
    try {
      await installer.apply(stateRef.current.config, dispatch);
      installer.save(stateRef.current.config);
      dispatch({ type: "COMPLETE" });
      kernelBus.emit(SETUP_EVENTS.COMPLETE, {});
      onComplete?.();
      return true;
    } catch (err) {
      dispatch({ type: "FAIL", error: String(err) });
      kernelBus.emit(SETUP_EVENTS.FAILED, { error: String(err) });
      onFail?.(err);
      return false;
    }
  }, [installer, onComplete, onFail]);

  const reset = useCallback(() => {
    installer.reset();
    dispatch({ type: "RESET" });
  }, [installer]);

  const api = useMemo(
    () => ({
      installer,
      state,
      step: state.step,
      progress: state.progress,
      config: state.config,
      values: state.config,
      errors: state.errors,
      warnings: state.warnings,
      error: state.error,
      logs: state.logs,
      isComplete: state.completed,
      isFailed: state.step === SETUP_STEP.FAILED,

      goTo,
      next,
      prev,
      setValue,
      setValues,
      validate,
      apply,
      reset,
    }),
    [installer, state, goTo, next, prev, setValue, setValues, validate, apply, reset]
  );

  return (
    <InitialConfigContext.Provider value={api}>
      {children}
    </InitialConfigContext.Provider>
  );
}

export function useInitialConfig() {
  const ctx = useContext(InitialConfigContext);
  if (!ctx)
    throw new Error(
      "useInitialConfig must be used within an InitialConfigProvider"
    );
  return ctx;
}

// ============================================================================
// EXPORTS DEFAULT
// ============================================================================

export default {
  InitialConfig,
  InitialConfigProvider,
  useInitialConfig,
  SETUP_STEP,
  SETUP_ORDER,
  SETUP_EVENTS,
  DEFAULT_CONFIG,
  LANGUAGES,
  REGIONS,
  TIMEZONES,
  KEYBOARDS,
  DATE_FORMATS,
  NUMBER_FORMATS,
  ACCENT_COLORS,
  WALLPAPERS,
  DOCK_POSITIONS,
  DOCK_SIZES,
  validateConfig,
};
