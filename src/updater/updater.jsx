// ============================================================================
// updater.jsx — Motor de actualizaciones del sistema
// ----------------------------------------------------------------------------
// Responsabilidades:
// 1. COMPROBAR
//    - Fetch a un manifest JSON con la última versión
//    - Comparar semver contra la versión actual del sistema
//    - Canales: stable / beta / dev
//    - Throttling: no comprobar más de X veces al día
//
// 2. DESCARGAR
//    - Descarga simulada con progreso (o real si hay URL)
//    - Pausa / reanudar / cancelar
//    - Verificación de checksum
//
// 3. APLICAR
//    - Instalación con progreso
//    - Rollback automático si falla
//    - Aviso "requiere reinicio" si el kernel debe recargar
//
// 4. CONFIGURACIÓN
//    - autoCheck: comprobar automáticamente al arrancar
//    - autoDownload: descargar cuando hay algo nuevo
//    - autoInstall: instalar automáticamente
//    - channel: stable | beta | dev
//    - lastCheck: timestamp de la última comprobación
//
// 5. HISTORIAL
//    - Lista de actualizaciones aplicadas (versión, fecha, notas)
//
// 6. EVENTOS
//    - update:checking, update:available, update:not-available,
//    - update:downloading, update:downloaded, update:ready,
//    - update:applying, update:applied, update:failed, update:rolledback
//
// Persistencia en localStorage bajo "updater.*"
// Todo sin UI obligatoria: expone estado + acciones.
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
import { toast } from "../toast/toast.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

export const UPDATE_STATE = Object.freeze({
  IDLE: "idle",
  CHECKING: "checking",
  AVAILABLE: "available",
  NOT_AVAILABLE: "not-available",
  DOWNLOADING: "downloading",
  DOWNLOADED: "downloaded",
  READY: "ready",
  APPLYING: "applying",
  APPLIED: "applied",
  ROLLING_BACK: "rolling-back",
  ROLLED_BACK: "rolled-back",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const UPDATE_CHANNEL = Object.freeze({
  STABLE: "stable",
  BETA: "beta",
  DEV: "dev",
});

export const UPDATE_EVENTS = Object.freeze({
  CHECKING: "update:checking",
  AVAILABLE: "update:available",
  NOT_AVAILABLE: "update:not-available",
  DOWNLOADING: "update:downloading",
  DOWNLOADED: "update:downloaded",
  READY: "update:ready",
  APPLYING: "update:applying",
  APPLIED: "update:applied",
  ROLLING_BACK: "update:rolling-back",
  ROLLED_BACK: "update:rolled-back",
  FAILED: "update:failed",
  CANCELLED: "update:cancelled",
  SETTINGS_CHANGED: "update:settings-changed",
  HISTORY_CHANGED: "update:history-changed",
  LOG: "update:log",
});

// Versión actual del sistema (debe coincidir con package.json)
export const SYSTEM_VERSION = "0.1.0";

// ============================================================================
// LOGGER
// ============================================================================

class UpdaterLog {
  constructor(max = 200) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(UPDATE_EVENTS.LOG, e);
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
// HELPERS
// ============================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const semver = {
  parse: (v) => {
    const [main, pre] = String(v || "0.0.0").split("-");
    const [major, minor, patch] = main.split(".").map((n) => parseInt(n, 10) || 0);
    return { major, minor, patch, prerelease: pre || null };
  },
  compare: (a, b) => {
    const pa = semver.parse(a);
    const pb = semver.parse(b);
    if (pa.major !== pb.major) return pa.major - pb.major;
    if (pa.minor !== pb.minor) return pa.minor - pb.minor;
    if (pa.patch !== pb.patch) return pa.patch - pb.patch;
    // prerelease: "1.0.0-beta" < "1.0.0"
    if (pa.prerelease && !pb.prerelease) return -1;
    if (!pa.prerelease && pb.prerelease) return 1;
    if (pa.prerelease && pb.prerelease) {
      return pa.prerelease < pb.prerelease ? -1 : pa.prerelease > pb.prerelease ? 1 : 0;
    }
    return 0;
  },
  isNewer: (candidate, current) => semver.compare(candidate, current) > 0,
};

const ONE_HOUR = 60 * 60 * 1000;

// ============================================================================
// STORAGE
// ============================================================================

class UpdaterStorage {
  constructor(ns = "updater") {
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
// DEFAULT SETTINGS
// ============================================================================

const DEFAULT_SETTINGS = Object.freeze({
  autoCheck: true,
  autoDownload: false,
  autoInstall: false,
  channel: UPDATE_CHANNEL.STABLE,
  checkIntervalMs: 24 * ONE_HOUR,   // una vez al día
  notifyOnAvailable: true,
  allowRollback: true,
  betaOptIn: false,
});

// ============================================================================
// ESTADO INICIAL
// ============================================================================

const initialState = {
  state: UPDATE_STATE.IDLE,
  currentVersion: SYSTEM_VERSION,
  availableVersion: null,
  availableManifest: null,
  progress: 0,
  phase: null,       // "downloading" | "applying"
  error: null,
  settings: { ...DEFAULT_SETTINGS },
  lastCheck: null,
  pendingUpdate: null,   // manifest descargado, esperando aplicar
  history: [],
  logs: [],
};

// ============================================================================
// REDUCER
// ============================================================================

function reducer(state, action) {
  switch (action.type) {
    case "SET_STATE":
      return { ...state, state: action.state };
    case "CHECKING":
      return {
        ...state,
        state: UPDATE_STATE.CHECKING,
        error: null,
        lastCheck: Date.now(),
      };
    case "AVAILABLE":
      return {
        ...state,
        state: UPDATE_STATE.AVAILABLE,
        availableVersion: action.manifest.version,
        availableManifest: action.manifest,
      };
    case "NOT_AVAILABLE":
      return {
        ...state,
        state: UPDATE_STATE.NOT_AVAILABLE,
        availableVersion: null,
        availableManifest: null,
        lastCheck: Date.now(),
      };
    case "DOWNLOADING":
      return {
        ...state,
        state: UPDATE_STATE.DOWNLOADING,
        progress: 0,
        phase: "downloading",
      };
    case "PROGRESS":
      return { ...state, progress: action.value, phase: action.phase };
    case "DOWNLOADED":
      return {
        ...state,
        state: UPDATE_STATE.DOWNLOADED,
        pendingUpdate: action.manifest,
        progress: 100,
      };
    case "READY":
      return { ...state, state: UPDATE_STATE.READY };
    case "APPLYING":
      return {
        ...state,
        state: UPDATE_STATE.APPLYING,
        progress: 0,
        phase: "applying",
      };
    case "APPLIED":
      return {
        ...state,
        state: UPDATE_STATE.APPLIED,
        currentVersion: action.version,
        availableManifest: null,
        availableVersion: null,
        pendingUpdate: null,
        progress: 100,
      };
    case "ROLLING_BACK":
      return {
        ...state,
        state: UPDATE_STATE.ROLLING_BACK,
        phase: "rolling-back",
      };
    case "ROLLED_BACK":
      return {
        ...state,
        state: UPDATE_STATE.ROLLED_BACK,
        pendingUpdate: null,
      };
    case "FAILED":
      return {
        ...state,
        state: UPDATE_STATE.FAILED,
        error: action.error,
        phase: null,
      };
    case "CANCELLED":
      return {
        ...state,
        state: UPDATE_STATE.IDLE,
        progress: 0,
        phase: null,
      };
    case "SET_SETTINGS":
      return {
        ...state,
        settings: { ...state.settings, ...action.settings },
      };
    case "SET_LAST_CHECK":
      return { ...state, lastCheck: action.ts };
    case "SET_HISTORY":
      return { ...state, history: action.history };
    case "ADD_HISTORY":
      return {
        ...state,
        history: [action.entry, ...state.history].slice(0, 50),
      };
    case "LOG":
      return { ...state, logs: [...state.logs.slice(-199), action.entry] };
    default:
      return state;
  }
}

// ============================================================================
// UPDATER (clase pura)
// ============================================================================

export class Updater {
  constructor(options = {}) {
    this.options = {
      currentVersion: SYSTEM_VERSION,
      storageNamespace: "updater",
      manifestUrl: null,
      simulateManifest: null,
      allowRealDownload: false,
      ...options,
    };

    this.logger = new UpdaterLog();
    this.storage = new UpdaterStorage(this.options.storageNamespace);
    this.currentVersion = this.options.currentVersion;
    this.settings = { ...DEFAULT_SETTINGS };
    this.history = [];
    this.listeners = new Set();
    this.activeOperation = null;

    this._loadFromStorage();
  }

  // ------------------------------------------------------------ suscripción
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify() {
    for (const fn of this.listeners) {
      try {
        fn(this.getState());
      } catch (err) {
        console.error("[updater] subscriber error", err);
      }
    }
  }

  getState() {
    return {
      currentVersion: this.currentVersion,
      settings: { ...this.settings },
      history: [...this.history],
    };
  }

  // ------------------------------------------------------------ storage
  _loadFromStorage() {
    try {
      const s = this.storage.get("settings", null);
      if (s) this.settings = { ...DEFAULT_SETTINGS, ...s };
      const h = this.storage.get("history", []);
      if (Array.isArray(h)) this.history = h;
      this.logger.info("updater state loaded");
    } catch (err) {
      this.logger.warn("failed to load updater state", err);
    }
  }

  _saveSettings() {
    this.storage.set("settings", this.settings);
  }

  _saveHistory() {
    this.storage.set("history", this.history);
  }

  _saveLastCheck() {
    this.storage.set("lastCheck", Date.now());
  }

  getLastCheck() {
    return this.storage.get("lastCheck", null);
  }

  // ------------------------------------------------------------ settings
  setSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this._saveSettings();
    kernelBus.emit(UPDATE_EVENTS.SETTINGS_CHANGED, {
      settings: this.settings,
    });
    this.logger.info("settings updated", patch);
    this._notify();
    return this.settings;
  }

  getSettings() {
    return { ...this.settings };
  }

  // ------------------------------------------------------------ check
  /**
   * Comprueba si hay actualización disponible.
   * Orden:
   *   1. Si hay manifestUrl, hace fetch real
   *   2. Si hay simulateManifest, lo usa
   *   3. Si no, genera un manifest falso en dev
   */
  async _fetchManifest() {
    const channel = this.settings.channel;
    const url =
      typeof this.options.manifestUrl === "function"
        ? this.options.manifestUrl(channel)
        : this.options.manifestUrl;

    if (url) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return data;
      } catch (err) {
        this.logger.warn("fetch manifest failed", err);
        // caer al simulateManifest
      }
    }

    if (this.options.simulateManifest) {
      return this.options.simulateManifest;
    }

    // Simulación por defecto: nunca hay update en dev
    return {
      version: this.currentVersion,
      channel,
      releasedAt: Date.now(),
      notes: "",
      size: 0,
      checksum: null,
      requiresRestart: false,
    };
  }

  async check({ force = false } = {}) {
    if (this.activeOperation === "checking") {
      return { ok: false, error: "already checking" };
    }
    if (this.activeOperation === "applying" || this.activeOperation === "downloading") {
      return { ok: false, error: "operation in progress" };
    }

    // Throttle
    const lastCheck = this.getLastCheck();
    if (
      !force &&
      lastCheck &&
      Date.now() - lastCheck < this.settings.checkIntervalMs
    ) {
      this.logger.info("check throttled");
      return { ok: false, throttled: true };
    }

    this.activeOperation = "checking";
    kernelBus.emit(UPDATE_EVENTS.CHECKING, {
      currentVersion: this.currentVersion,
      channel: this.settings.channel,
    });
    this.logger.info("checking for updates");

    try {
      await sleep(500);

      const manifest = await this._fetchManifest();

      if (!manifest || !manifest.version) {
        throw new Error("invalid manifest");
      }

      this._saveLastCheck();

      if (semver.isNewer(manifest.version, this.currentVersion)) {
        this.logger.info(
          `update available: ${manifest.version} (current ${this.currentVersion})`
        );
        kernelBus.emit(UPDATE_EVENTS.AVAILABLE, { manifest });

        if (this.settings.notifyOnAvailable) {
          toast.info(
            "Actualización disponible",
            `rainOS ${manifest.version} — abre Ajustes para instalarla`
          );
        }

        if (this.settings.autoDownload) {
          // lanzar descarga en background
          this.download(manifest).catch(() => {});
        }

        this._notify();
        return { ok: true, available: true, manifest };
      }

      this.logger.info("no updates available");
      kernelBus.emit(UPDATE_EVENTS.NOT_AVAILABLE, {
        currentVersion: this.currentVersion,
      });
      this._notify();
      return { ok: true, available: false };
    } catch (err) {
      this.logger.error("check failed", err);
      kernelBus.emit(UPDATE_EVENTS.FAILED, { stage: "check", error: String(err) });
      this._notify();
      return { ok: false, error: err };
    } finally {
      this.activeOperation = null;
    }
  }

  // ------------------------------------------------------------ download
  async download(manifest = null, { dispatch } = {}) {
    if (this.activeOperation === "downloading") {
      return { ok: false, error: "already downloading" };
    }

    const target = manifest || (await this._fetchManifest());
    if (!target) return { ok: false, error: "no manifest" };

    this.activeOperation = "downloading";
    kernelBus.emit(UPDATE_EVENTS.DOWNLOADING, { manifest: target });
    this.logger.info(`downloading update: ${target.version}`);

    try {
      const steps = 20;
      for (let i = 1; i <= steps; i++) {
        if (this.activeOperation !== "downloading") {
          // cancelado
          kernelBus.emit(UPDATE_EVENTS.CANCELLED, {});
          return { ok: false, cancelled: true };
        }
        await sleep(100 + Math.random() * 60);
        const progress = Math.round((i / steps) * 100);
        dispatch?.({
          type: "PROGRESS",
          value: progress,
          phase: "downloading",
        });
      }

      // verificar checksum (simulado)
      if (target.checksum) {
        await sleep(200);
      }

      this.logger.info(`download complete: ${target.version}`);
      kernelBus.emit(UPDATE_EVENTS.DOWNLOADED, { manifest: target });
      dispatch?.({ type: "DOWNLOADED", manifest: target });

      if (this.settings.autoInstall) {
        await this.apply(target, { dispatch });
      }

      this._notify();
      return { ok: true, manifest: target };
    } catch (err) {
      this.logger.error("download failed", err);
      kernelBus.emit(UPDATE_EVENTS.FAILED, {
        stage: "download",
        error: String(err),
      });
      dispatch?.({ type: "FAILED", error: String(err) });
      return { ok: false, error: err };
    } finally {
      this.activeOperation = null;
    }
  }

  cancelDownload() {
    if (this.activeOperation === "downloading") {
      this.activeOperation = "cancelled";
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ apply
  async apply(manifest = null, { dispatch } = {}) {
    const target = manifest || this.pendingUpdate;
    if (!target) return { ok: false, error: "no update to apply" };

    if (this.activeOperation === "applying") {
      return { ok: false, error: "already applying" };
    }

    this.activeOperation = "applying";
    kernelBus.emit(UPDATE_EVENTS.APPLYING, { manifest: target });
    this.logger.info(`applying update: ${target.version}`);

    const previousVersion = this.currentVersion;

    try {
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        if (this.activeOperation !== "applying") {
          throw new Error("cancelled during apply");
        }
        await sleep(150 + Math.random() * 80);
        const progress = Math.round((i / steps) * 100);
        dispatch?.({
          type: "PROGRESS",
          value: progress,
          phase: "applying",
        });
      }

      // Simular posibilidad de fallo del 5 % para probar el rollback
      const simulateFailure = false; // cambiar a true en dev si quieres probar
      if (simulateFailure) {
        throw new Error("simulated apply failure");
      }

      this.currentVersion = target.version;
      this.logger.info(`update applied: ${previousVersion} → ${target.version}`);

      const entry = {
        from: previousVersion,
        to: target.version,
        ts: Date.now(),
        notes: target.notes || "",
        channel: target.channel || this.settings.channel,
      };
      this.history = [entry, ...this.history].slice(0, 50);
      this._saveHistory();

      kernelBus.emit(UPDATE_EVENTS.APPLIED, { entry });
      kernelBus.emit(UPDATE_EVENTS.HISTORY_CHANGED, { history: this.history });
      dispatch?.({ type: "APPLIED", version: target.version });
      dispatch?.({ type: "ADD_HISTORY", entry });

      toast.success(
        "Sistema actualizado",
        `rainOS ${target.version} instalado correctamente`
      );

      if (target.requiresRestart) {
        toast.warning(
          "Reinicio recomendado",
          "Reinicia el sistema para aplicar todos los cambios"
        );
      }

      this._notify();
      return { ok: true };
    } catch (err) {
      this.logger.error("apply failed", err);
      kernelBus.emit(UPDATE_EVENTS.FAILED, {
        stage: "apply",
        error: String(err),
      });

      // Rollback
      if (this.settings.allowRollback) {
        await this._rollback(previousVersion, { dispatch });
      } else {
        dispatch?.({ type: "FAILED", error: String(err) });
      }

      return { ok: false, error: err };
    } finally {
      this.activeOperation = null;
    }
  }

  async _rollback(previousVersion, { dispatch } = {}) {
    dispatch?.({ type: "ROLLING_BACK" });
    kernelBus.emit(UPDATE_EVENTS.ROLLING_BACK, { to: previousVersion });
    this.logger.warn(`rolling back to ${previousVersion}`);

    try {
      await sleep(800);
      this.currentVersion = previousVersion;
      kernelBus.emit(UPDATE_EVENTS.ROLLED_BACK, { version: previousVersion });
      dispatch?.({ type: "ROLLED_BACK" });

      toast.warning(
        "Actualización revertida",
        `Se ha vuelto a la versión ${previousVersion}`
      );

      this._notify();
      return { ok: true };
    } catch (err) {
      this.logger.error("rollback failed", err);
      dispatch?.({ type: "FAILED", error: "rollback failed" });
      return { ok: false, error: err };
    }
  }

  // ------------------------------------------------------------ history
  getHistory() {
    return [...this.history];
  }

  clearHistory() {
    this.history = [];
    this._saveHistory();
    kernelBus.emit(UPDATE_EVENTS.HISTORY_CHANGED, { history: [] });
    this._notify();
  }

  // ------------------------------------------------------------ info
  getCurrentVersion() {
    return this.currentVersion;
  }

  getChannel() {
    return this.settings.channel;
  }
}

// ============================================================================
// CONTEXTO
// ============================================================================

const UpdaterContext = createContext(null);

export function UpdaterProvider({
  children,
  updater: external,
  options = {},
  autoCheckOnMount = true,
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new Updater(options);
  }
  const updater = ref.current;

  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    currentVersion: updater.getCurrentVersion(),
    settings: updater.getSettings(),
    history: updater.getHistory(),
    lastCheck: updater.getLastCheck(),
  });

  // suscripción a cambios de la clase
  useEffect(() => {
    const unsub = updater.subscribe((snap) => {
      dispatch({
        type: "SET_SETTINGS",
        settings: snap.settings,
      });
      dispatch({
        type: "SET_HISTORY",
        history: snap.history,
      });
    });
    const offLog = kernelBus.on(UPDATE_EVENTS.LOG, (entry) => {
      dispatch({ type: "LOG", entry });
    });

    const offChecking = kernelBus.on(UPDATE_EVENTS.CHECKING, () => {
      dispatch({ type: "CHECKING" });
    });
    const offAvailable = kernelBus.on(UPDATE_EVENTS.AVAILABLE, ({ manifest }) => {
      dispatch({ type: "AVAILABLE", manifest });
    });
    const offNotAvailable = kernelBus.on(UPDATE_EVENTS.NOT_AVAILABLE, () => {
      dispatch({ type: "NOT_AVAILABLE" });
    });
    const offDownloading = kernelBus.on(UPDATE_EVENTS.DOWNLOADING, () => {
      dispatch({ type: "DOWNLOADING" });
    });
    const offDownloaded = kernelBus.on(UPDATE_EVENTS.DOWNLOADED, ({ manifest }) => {
      dispatch({ type: "DOWNLOADED", manifest });
    });
    const offApplying = kernelBus.on(UPDATE_EVENTS.APPLYING, () => {
      dispatch({ type: "APPLYING" });
    });
    const offApplied = kernelBus.on(UPDATE_EVENTS.APPLIED, ({ entry }) => {
      dispatch({ type: "APPLIED", version: entry.to });
    });
    const offFailed = kernelBus.on(UPDATE_EVENTS.FAILED, ({ error }) => {
      dispatch({ type: "FAILED", error });
    });

    return () => {
      unsub();
      offLog();
      offChecking();
      offAvailable();
      offNotAvailable();
      offDownloading();
      offDownloaded();
      offApplying();
      offApplied();
      offFailed();
    };
  }, [updater]);

  // Auto check al montar
  useEffect(() => {
    if (!autoCheckOnMount) return;
    if (!updater.getSettings().autoCheck) return;
    // pequeña espera para no bloquear el arranque
    const t = setTimeout(() => {
      updater.check().catch(() => {});
    }, 2000);
    return () => clearTimeout(t);
  }, [autoCheckOnMount, updater]);

  const api = useMemo(
    () => ({
      updater,
      state: state.state,
      currentVersion: state.currentVersion,
      availableVersion: state.availableVersion,
      availableManifest: state.availableManifest,
      pendingUpdate: state.pendingUpdate,
      progress: state.progress,
      phase: state.phase,
      error: state.error,
      settings: state.settings,
      lastCheck: state.lastCheck,
      history: state.history,
      logs: state.logs,

      // acciones
      check: (opts) => updater.check(opts),
      download: (manifest) => updater.download(manifest, { dispatch }),
      cancelDownload: () => updater.cancelDownload(),
      apply: (manifest) => updater.apply(manifest, { dispatch }),
      setSettings: (patch) => updater.setSettings(patch),
      clearHistory: () => updater.clearHistory(),

      // helpers
      isChecking: state.state === UPDATE_STATE.CHECKING,
      isAvailable: state.state === UPDATE_STATE.AVAILABLE,
      isDownloading: state.state === UPDATE_STATE.DOWNLOADING,
      isReady: state.state === UPDATE_STATE.READY || state.state === UPDATE_STATE.DOWNLOADED,
      isApplying: state.state === UPDATE_STATE.APPLYING,
      hasUpdate: !!state.availableVersion,
      canApply: !!(state.pendingUpdate || state.availableManifest),
    }),
    [updater, state]
  );

  return (
    <UpdaterContext.Provider value={api}>
      {children}
    </UpdaterContext.Provider>
  );
}

export function useUpdater() {
  const ctx = useContext(UpdaterContext);
  if (!ctx)
    throw new Error("useUpdater must be used within an UpdaterProvider");
  return ctx;
}

// ============================================================================
// HOOKS AUXILIARES
// ============================================================================

export function useUpdateAvailable() {
  const { hasUpdate, availableVersion } = useUpdater();
  return { hasUpdate, availableVersion };
}

// ============================================================================
// EXPORTS DEFAULT
// ============================================================================

export default {
  Updater,
  UpdaterProvider,
  useUpdater,
  useUpdateAvailable,
  UPDATE_STATE,
  UPDATE_CHANNEL,
  UPDATE_EVENTS,
  SYSTEM_VERSION,
};
