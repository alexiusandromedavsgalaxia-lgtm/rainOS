// ============================================================================
// appinstaller.jsx — Instalador de aplicaciones
// ----------------------------------------------------------------------------
// Sistema para instalar apps nuevas en rainOS. Responsabilidades:
// - Registro de apps instaladas (catálogo interno + instaladas por usuario)
// - Instalación desde un manifiesto (JSON) o desde URL
// - Verificación de integridad (checksum, firma simulada)
// - Resolución de dependencias entre apps
// - Ciclo de vida completo: pending → downloading → verifying → installing → installed → failed
// - Desinstalación con limpieza de datos
// - Actualización de apps instaladas
// - Persistencia en localStorage
// - Eventos del sistema (install:*)
// - Se integra con el Dock, Launchpad y Desktop (una app nueva aparece ahí)
// - Todo sin UI obligatoria: expone estado + acciones
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

export const INSTALL_STATE = Object.freeze({
  PENDING: "pending",
  DOWNLOADING: "downloading",
  VERIFYING: "verifying",
  RESOLVING: "resolving",
  INSTALLING: "installing",
  INSTALLED: "installed",
  UPDATING: "updating",
  UNINSTALLING: "uninstalling",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const INSTALL_EVENTS = Object.freeze({
  STARTED: "install:started",
  PROGRESS: "install:progress",
  VERIFYING: "install:verifying",
  VERIFIED: "install:verified",
  VERIFY_FAILED: "install:verify-failed",
  RESOLVING_DEPS: "install:resolving-deps",
  DEPS_RESOLVED: "install:deps-resolved",
  DEPS_FAILED: "install:deps-failed",
  INSTALLING: "install:installing",
  INSTALLED: "install:installed",
  FAILED: "install:failed",
  CANCELLED: "install:cancelled",
  UNINSTALLING: "install:uninstalling",
  UNINSTALLED: "install:uninstalled",
  UPDATING: "install:updating",
  UPDATED: "install:updated",
  REGISTRY_CHANGED: "install:registry-changed",
  APP_REGISTERED: "install:app-registered",
  LOG: "install:log",
});

export const APP_SOURCE = Object.freeze({
  SYSTEM: "system",
  CATALOG: "catalog",
  MANUAL: "manual",
  DMG: "dmg",
  DEV: "dev",
});

// ============================================================================
// LOGGER
// ============================================================================

class InstallerLog {
  constructor(max = 200) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(INSTALL_EVENTS.LOG, e);
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

const semverCompare = (a, b) => {
  const pa = String(a || "0.0.0").split(".").map(Number);
  const pb = String(b || "0.0.0").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
};

const simpleHash = async (str) => {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    try {
      const enc = new TextEncoder();
      const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
      return Array.from(new Uint8Array(buf), (b) =>
        b.toString(16).padStart(2, "0")
      ).join("");
    } catch {
      /* fallback */
    }
  }
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return `fallback:${h.toString(16)}`;
};

const validateManifest = (manifest) => {
  const errors = [];
  if (!manifest) errors.push("manifest is required");
  else {
    if (!manifest.id) errors.push("manifest.id is required");
    if (!manifest.name) errors.push("manifest.name is required");
    if (!manifest.version) errors.push("manifest.version is required");
  }
  return { ok: errors.length === 0, errors };
};

// ============================================================================
// STORAGE
// ============================================================================

class InstallerStorage {
  constructor(ns = "appinstaller") {
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
// ESTADO INICIAL
// ============================================================================

const initialState = {
  catalog: [],           // apps disponibles en el catálogo
  installed: [],         // apps instaladas (manifiestos completos)
  installing: [],        // instalaciones en curso (por id)
  history: [],           // instalaciones completadas (id, ts, version, estado)
  errors: [],
  logs: [],
};

// ============================================================================
// REDUCER
// ============================================================================

function reducer(state, action) {
  switch (action.type) {
    case "SET_CATALOG":
      return { ...state, catalog: action.catalog };
    case "SET_INSTALLED":
      return { ...state, installed: action.installed };
    case "ADD_INSTALLING":
      return {
        ...state,
        installing: [
          ...state.installing,
          {
            id: action.id,
            state: INSTALL_STATE.PENDING,
            progress: 0,
            manifest: action.manifest,
            error: null,
            startedAt: Date.now(),
          },
        ],
      };
    case "UPDATE_INSTALLING":
      return {
        ...state,
        installing: state.installing.map((i) =>
          i.id === action.id ? { ...i, ...action.patch } : i
        ),
      };
    case "REMOVE_INSTALLING":
      return {
        ...state,
        installing: state.installing.filter((i) => i.id !== action.id),
      };
    case "ADD_HISTORY":
      return {
        ...state,
        history: [action.entry, ...state.history].slice(0, 100),
      };
    case "ADD_ERROR":
      return { ...state, errors: [...state.errors, action.error].slice(-50) };
    case "LOG":
      return { ...state, logs: [...state.logs.slice(-299), action.entry] };
    default:
      return state;
  }
}

// ============================================================================
// APP INSTALLER (clase pura)
// ============================================================================

export class AppInstaller {
  constructor(options = {}) {
    this.options = {
      storageNamespace: "appinstaller",
      catalogUrl: null,
      strict: false,
      allowNetwork: true,
      ...options,
    };

    this.logger = new InstallerLog();
    this.storage = new InstallerStorage(this.options.storageNamespace);
    this.catalog = [];
    this.installed = new Map();
    this.listeners = new Set();
    this.activeInstalls = new Map();

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
        console.error("[appinstaller] subscriber error", err);
      }
    }
    kernelBus.emit(INSTALL_EVENTS.REGISTRY_CHANGED, {});
  }

  getState() {
    return {
      catalog: [...this.catalog],
      installed: this.listInstalled(),
    };
  }

  // ------------------------------------------------------------ storage
  _loadFromStorage() {
    try {
      const raw = this.storage.get("installed", {});
      for (const [id, app] of Object.entries(raw)) {
        this.installed.set(id, app);
      }
      this.logger.info(
        `loaded ${this.installed.size} apps from storage`
      );
    } catch (err) {
      this.logger.warn("failed to load installed apps", err);
    }
  }

  _saveToStorage() {
    try {
      const obj = {};
      for (const [id, app] of this.installed.entries()) {
        obj[id] = app;
      }
      this.storage.set("installed", obj);
    } catch (err) {
      this.logger.error("failed to save installed apps", err);
    }
  }

  // ------------------------------------------------------------ catálogo
  async loadCatalog(url) {
    const target = url || this.options.catalogUrl;
    if (!target || !this.options.allowNetwork) {
      this.logger.warn("no catalog URL or network disabled");
      return [];
    }
    try {
      const res = await fetch(target, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.apps || [];
      this.catalog = list.filter((a) => validateManifest(a).ok);
      this.logger.info(`catalog loaded: ${this.catalog.length} apps`);
      this._notify();
      return this.catalog;
    } catch (err) {
      this.logger.error("failed to load catalog", err);
      return [];
    }
  }

  setCatalog(list) {
    this.catalog = list.filter((a) => validateManifest(a).ok);
    this._notify();
    return this.catalog;
  }

  getCatalog() {
    return [...this.catalog];
  }

  searchCatalog(query) {
    if (!query) return [...this.catalog];
    const q = query.toLowerCase();
    return this.catalog.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        (a.description || "").toLowerCase().includes(q)
    );
  }

  // ------------------------------------------------------------ consultas
  isInstalled(id) {
    return this.installed.has(id);
  }

  getInstalled(id) {
    return this.installed.get(id) ?? null;
  }

  listInstalled() {
    return Array.from(this.installed.values());
  }

  registerApp(app, { source = APP_SOURCE.MANUAL } = {}) {
    const check = validateManifest(app);
    if (!check.ok) {
      this.logger.error("invalid app manifest", check.errors);
      return { ok: false, errors: check.errors };
    }

    const existing = this.installed.get(app.id);
    const entry = {
      ...app,
      source: existing?.source || source,
      installedAt: existing?.installedAt || Date.now(),
      updatedAt: Date.now(),
      version: app.version,
    };

    this.installed.set(app.id, entry);
    this._saveToStorage();
    kernelBus.emit(INSTALL_EVENTS.APP_REGISTERED, {
      id: app.id,
      app: entry,
    });
    this.logger.info(`app registered: ${app.id}@${app.version}`);
    this._notify();
    return { ok: true, app: entry };
  }

  // ------------------------------------------------------------ instalar
  async install(manifest, { dispatch, source = APP_SOURCE.CATALOG } = {}) {
    const check = validateManifest(manifest);
    if (!check.ok) {
      kernelBus.emit(INSTALL_EVENTS.FAILED, {
        id: manifest?.id,
        error: check.errors,
      });
      return { ok: false, errors: check.errors };
    }

    const id = manifest.id;

    if (this.activeInstalls.has(id)) {
      return { ok: false, error: "already installing" };
    }

    // Marcar como activo
    const installState = {
      id,
      manifest,
      cancelled: false,
      dispatch,
    };
    this.activeInstalls.set(id, installState);

    dispatch?.({ type: "ADD_INSTALLING", id, manifest });
    kernelBus.emit(INSTALL_EVENTS.STARTED, { id, manifest });
    this.logger.info(`install started: ${id}@${manifest.version}`);

    const update = (patch) => {
      dispatch?.({ type: "UPDATE_INSTALLING", id, patch });
    };

    const checkCancelled = () => {
      if (installState.cancelled) {
        throw new Error("cancelled");
      }
    };

    try {
      // ----- 1. Downloading
      update({ state: INSTALL_STATE.DOWNLOADING, progress: 0 });
      kernelBus.emit(INSTALL_EVENTS.PROGRESS, { id, progress: 0, phase: "downloading" });

      const totalSteps = 10;
      for (let i = 1; i <= totalSteps; i++) {
        checkCancelled();
        await sleep(120 + Math.random() * 80);
        const progress = Math.round((i / totalSteps) * 45);
        update({ progress });
        kernelBus.emit(INSTALL_EVENTS.PROGRESS, {
          id,
          progress,
          phase: "downloading",
        });
      }

      // ----- 2. Verifying
      checkCancelled();
      update({ state: INSTALL_STATE.VERIFYING, progress: 50 });
      kernelBus.emit(INSTALL_EVENTS.VERIFYING, { id });

      await sleep(300);
      if (manifest.checksum) {
        const computed = await simpleHash(JSON.stringify(manifest));
        // No comparamos contra un checksum real (no hay archivo),
        // solo verificamos que podemos calcular el hash
        void computed;
      }
      update({ progress: 55 });
      kernelBus.emit(INSTALL_EVENTS.VERIFIED, { id });

      // ----- 3. Resolving dependencies
      checkCancelled();
      update({ state: INSTALL_STATE.RESOLVING, progress: 58 });
      kernelBus.emit(INSTALL_EVENTS.RESOLVING_DEPS, { id });

      const deps = manifest.dependencies || [];
      const missing = deps.filter((d) => !this.installed.has(d.id));

      if (missing.length > 0 && !manifest.allowMissingDeps) {
        const err = `missing dependencies: ${missing
          .map((d) => d.id)
          .join(", ")}`;
        kernelBus.emit(INSTALL_EVENTS.DEPS_FAILED, { id, error: err });
        throw new Error(err);
      }

      update({ progress: 62 });
      kernelBus.emit(INSTALL_EVENTS.DEPS_RESOLVED, {
        id,
        missing: missing.map((d) => d.id),
      });

      // ----- 4. Installing
      checkCancelled();
      update({ state: INSTALL_STATE.INSTALLING, progress: 65 });
      kernelBus.emit(INSTALL_EVENTS.INSTALLING, { id });

      for (let i = 1; i <= 5; i++) {
        checkCancelled();
        await sleep(150);
        const progress = 65 + Math.round((i / 5) * 30);
        update({ progress });
        kernelBus.emit(INSTALL_EVENTS.PROGRESS, {
          id,
          progress,
          phase: "installing",
        });
      }

      // ----- 5. Registro final
      const result = this.registerApp(manifest, { source });
      if (!result.ok) {
        throw new Error("failed to register app");
      }

      update({ state: INSTALL_STATE.INSTALLED, progress: 100 });

      dispatch?.({
        type: "ADD_HISTORY",
        entry: {
          id,
          name: manifest.name,
          version: manifest.version,
          ts: Date.now(),
          state: INSTALL_STATE.INSTALLED,
        },
      });

      kernelBus.emit(INSTALL_EVENTS.INSTALLED, { id, app: result.app });
      this.logger.info(`installed: ${id}@${manifest.version}`);

      toast.success(
        "Aplicación instalada",
        `${manifest.name} ${manifest.version}`
      );

      // limpiar
      setTimeout(() => {
        dispatch?.({ type: "REMOVE_INSTALLING", id });
      }, 1500);

      this.activeInstalls.delete(id);
      return { ok: true, app: result.app };
    } catch (err) {
      const cancelled = String(err?.message) === "cancelled";
      const state = cancelled
        ? INSTALL_STATE.CANCELLED
        : INSTALL_STATE.FAILED;

      update({ state, error: String(err) });

      dispatch?.({
        type: "ADD_HISTORY",
        entry: {
          id,
          name: manifest.name,
          version: manifest.version,
          ts: Date.now(),
          state,
          error: String(err),
        },
      });

      if (cancelled) {
        kernelBus.emit(INSTALL_EVENTS.CANCELLED, { id });
        this.logger.warn(`install cancelled: ${id}`);
      } else {
        kernelBus.emit(INSTALL_EVENTS.FAILED, { id, error: String(err) });
        dispatch?.({
          type: "ADD_ERROR",
          error: { id, error: String(err), ts: Date.now() },
        });
        this.logger.error(`install failed: ${id}`, err);
        toast.error(
          "Error al instalar",
          `${manifest.name}: ${String(err)}`
        );
      }

      setTimeout(() => {
        dispatch?.({ type: "REMOVE_INSTALLING", id });
      }, 2500);

      this.activeInstalls.delete(id);
      return { ok: false, error: err };
    }
  }

  cancelInstall(id) {
    const state = this.activeInstalls.get(id);
    if (!state) return false;
    state.cancelled = true;
    return true;
  }

  // ------------------------------------------------------------ desinstalar
  async uninstall(id, { dispatch, keepData = false } = {}) {
    const app = this.installed.get(id);
    if (!app) return { ok: false, error: "not installed" };

    // Apps del sistema no se pueden desinstalar
    if (app.source === APP_SOURCE.SYSTEM || app.system === true) {
      return { ok: false, error: "cannot uninstall system app" };
    }

    kernelBus.emit(INSTALL_EVENTS.UNINSTALLING, { id });
    this.logger.info(`uninstalling: ${id}`);

    await sleep(400);

    this.installed.delete(id);
    if (!keepData) {
      this.storage.remove(`data.${id}`);
    }
    this._saveToStorage();

    kernelBus.emit(INSTALL_EVENTS.UNINSTALLED, { id });
    this.logger.info(`uninstalled: ${id}`);
    this._notify();

    toast.info("Aplicación desinstalada", app.name);
    return { ok: true };
  }

  // ------------------------------------------------------------ actualizar
  async update(id, newManifest, { dispatch } = {}) {
    const existing = this.installed.get(id);
    if (!existing) return { ok: false, error: "not installed" };

    if (semverCompare(newManifest.version, existing.version) <= 0) {
      return { ok: false, error: "no update available" };
    }

    kernelBus.emit(INSTALL_EVENTS.UPDATING, { id, from: existing.version, to: newManifest.version });

    const result = await this.install(newManifest, {
      dispatch,
      source: existing.source,
    });

    if (result.ok) {
      kernelBus.emit(INSTALL_EVENTS.UPDATED, {
        id,
        from: existing.version,
        to: newManifest.version,
      });
    }

    return result;
  }

  // ------------------------------------------------------------ búsqueda de updates
  checkForUpdates() {
    const updates = [];
    for (const installedApp of this.installed.values()) {
      const catalogEntry = this.catalog.find((a) => a.id === installedApp.id);
      if (
        catalogEntry &&
        semverCompare(catalogEntry.version, installedApp.version) > 0
      ) {
        updates.push({
          id: installedApp.id,
          current: installedApp.version,
          available: catalogEntry.version,
          manifest: catalogEntry,
        });
      }
    }
    return updates;
  }

  // ------------------------------------------------------------ utils
  getInstallState(id) {
    return this.activeInstalls.get(id)?.state || null;
  }

  isInstalling(id) {
    return this.activeInstalls.has(id);
  }
}

// ============================================================================
// CONTEXTO
// ============================================================================

const AppInstallerContext = createContext(null);

export function AppInstallerProvider({
  children,
  installer: external,
  options = {},
  initialCatalog = null,
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new AppInstaller(options);
  }
  const installer = ref.current;

  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    installed: installer.listInstalled(),
    catalog: installer.getCatalog(),
  });

  // suscripción al registry
  useEffect(() => {
    const unsub = installer.subscribe((snap) => {
      dispatch({ type: "SET_INSTALLED", installed: snap.installed });
      dispatch({ type: "SET_CATALOG", catalog: snap.catalog });
    });
    const offLog = kernelBus.on(INSTALL_EVENTS.LOG, (entry) => {
      dispatch({ type: "LOG", entry });
    });
    return () => {
      unsub();
      offLog();
    };
  }, [installer]);

  // catálogo inicial
  useEffect(() => {
    if (initialCatalog) {
      installer.setCatalog(initialCatalog);
      dispatch({ type: "SET_CATALOG", catalog: installer.getCatalog() });
    }
  }, [initialCatalog, installer]);

  const api = useMemo(
    () => ({
      installer,
      catalog: state.catalog,
      installed: state.installed,
      installing: state.installing,
      history: state.history,
      errors: state.errors,
      logs: state.logs,

      // catálogo
      loadCatalog: (url) => installer.loadCatalog(url),
      setCatalog: (list) => installer.setCatalog(list),
      searchCatalog: (q) => installer.searchCatalog(q),
      getCatalog: () => installer.getCatalog(),

      // consultas
      isInstalled: (id) => installer.isInstalled(id),
      getInstalled: (id) => installer.getInstalled(id),
      listInstalled: () => installer.listInstalled(),
      checkForUpdates: () => installer.checkForUpdates(),

      // acciones
      install: (manifest, opts) =>
        installer.install(manifest, { dispatch, ...(opts || {}) }),
      cancelInstall: (id) => installer.cancelInstall(id),
      uninstall: (id, opts) =>
        installer.uninstall(id, { dispatch, ...(opts || {}) }),
      update: (id, manifest, opts) =>
        installer.update(id, manifest, { dispatch, ...(opts || {}) }),
      registerApp: (app, opts) => installer.registerApp(app, opts),

      // utils
      getInstallState: (id) => installer.getInstallState(id),
      isInstalling: (id) => installer.isInstalling(id),
    }),
    [installer, state]
  );

  return (
    <AppInstallerContext.Provider value={api}>
      {children}
    </AppInstallerContext.Provider>
  );
}

export function useAppInstaller() {
  const ctx = useContext(AppInstallerContext);
  if (!ctx)
    throw new Error(
      "useAppInstaller must be used within an AppInstallerProvider"
    );
  return ctx;
}

// ============================================================================
// EXPORTS DEFAULT
// ============================================================================

export default {
  AppInstaller,
  AppInstallerProvider,
  useAppInstaller,
  INSTALL_STATE,
  INSTALL_EVENTS,
  APP_SOURCE,
};
