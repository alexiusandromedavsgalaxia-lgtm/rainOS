// ============================================================================
// dmginstaller.jsx — Instalador de DMG (imagen de disco)
// ----------------------------------------------------------------------------
// Simula el flujo de instalación de apps en macOS:
// 1. El usuario arrastra un archivo .dmg al escritorio (o hace doble clic)
// 2. Se "monta" la imagen → aparece como un volumen virtual
// 3. Se abre una ventana Finder con el contenido del DMG
// 4. El usuario arrastra la app al icono de "Aplicaciones"
// 5. Se "desmonta" el DMG automáticamente
// 6. La app queda instalada en el sistema (via AppInstaller)
//
// Este módulo gestiona la parte de DMG:
// - Montar/desmontar imágenes virtuales
// - Estado de volúmenes montados
// - Contenido del volumen (lista de apps/archivos)
// - Verificación de firma (simulada)
// - Copia de la app desde el volumen a /Applications
// - Detección de .dmg al abrir desde el Finder
// - UI opcional: ventana con el DMG montado, aviso legal, arrastrar
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
import { useWindowManager } from "../kernel/kernel.jsx";
import { useAppInstaller } from "../appinstaller/appinstaller.jsx";
import { toast } from "../toast/toast.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

export const DMG_STATE = Object.freeze({
  IDLE: "idle",
  MOUNTING: "mounting",
  MOUNTED: "mounted",
  VERIFYING: "verifying",
  COPYING: "copying",
  UNMOUNTING: "unmounting",
  UNMOUNTED: "unmounted",
  FAILED: "failed",
});

export const DMG_EVENTS = Object.freeze({
  MOUNT_START: "dmg:mount-start",
  MOUNT_PROGRESS: "dmg:mount-progress",
  MOUNTED: "dmg:mounted",
  UNMOUNT_START: "dmg:unmount-start",
  UNMOUNTED: "dmg:unmounted",
  VERIFY_START: "dmg:verify-start",
  VERIFIED: "dmg:verified",
  VERIFY_FAILED: "dmg:verify-failed",
  COPY_START: "dmg:copy-start",
  COPY_PROGRESS: "dmg:copy-progress",
  COPY_COMPLETE: "dmg:copy-complete",
  APP_INSTALLED: "dmg:app-installed",
  REJECTED: "dmg:rejected",
  FAILED: "dmg:failed",
  LOG: "dmg:log",
  REGISTRY_CHANGED: "dmg:registry-changed",
});

// ============================================================================
// LOGGER
// ============================================================================

class DMGLog {
  constructor(max = 200) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(DMG_EVENTS.LOG, e);
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

let _mountId = 0;
const nextMountId = () => `dmg-${++_mountId}`;

// Verificación de firma simulada: acepta cualquier .dmg con un
// developerId reconocido, rechaza lo que parezca malware o desconocido.
const KNOWN_DEVELOPERS = [
  "Apple",
  "Microsoft",
  "Google",
  "Mozilla",
  "JetBrains",
  "Adobe",
  "Figma",
  "Slack",
  "Discord",
  "Spotify",
  "VLC",
  "1Password",
  "RainOS",
  "RainSoft",
];

async function verifySignature(manifest) {
  await sleep(300);
  if (!manifest.developerId) {
    return { ok: false, reason: "unsigned" };
  }
  const known = KNOWN_DEVELOPERS.some((d) =>
    manifest.developerId.toLowerCase().includes(d.toLowerCase())
  );
  if (!known) {
    return { ok: false, reason: "unknown-developer" };
  }
  return { ok: true, developer: manifest.developerId };
}

// ============================================================================
// ESTADO INICIAL
// ============================================================================

const initialState = {
  mounts: [],        // volúmenes montados
  mounting: null,    // { id, manifest, state, progress }
  history: [],
  errors: [],
  logs: [],
};

// ============================================================================
// REDUCER
// ============================================================================

function reducer(state, action) {
  switch (action.type) {
    case "SET_MOUNTS":
      return { ...state, mounts: action.mounts };
    case "START_MOUNT":
      return {
        ...state,
        mounting: {
          id: action.id,
          manifest: action.manifest,
          state: DMG_STATE.MOUNTING,
          progress: 0,
          error: null,
          startedAt: Date.now(),
        },
      };
    case "UPDATE_MOUNT":
      return {
        ...state,
        mounting: state.mounting
          ? { ...state.mounting, ...action.patch }
          : null,
      };
    case "FINISH_MOUNT":
      return { ...state, mounting: null };
    case "ADD_HISTORY":
      return {
        ...state,
        history: [action.entry, ...state.history].slice(0, 100),
      };
    case "ADD_ERROR":
      return {
        ...state,
        errors: [...state.errors, action.error].slice(-50),
      };
    case "LOG":
      return { ...state, logs: [...state.logs.slice(-299), action.entry] };
    default:
      return state;
  }
}

// ============================================================================
// DMG INSTALLER (clase pura)
// ============================================================================

export class DMGInstaller {
  constructor(options = {}) {
    this.options = {
      autoUnmountAfterCopy: true,
      autoUnmountDelayMs: 800,
      strictSignature: true,
      ...options,
    };

    this.logger = new DMGLog();
    this.mounts = new Map();
    this.listeners = new Set();
    this.activeMounts = new Map();
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
        console.error("[dmginstaller] subscriber error", err);
      }
    }
    kernelBus.emit(DMG_EVENTS.REGISTRY_CHANGED, {});
  }

  getState() {
    return {
      mounts: Array.from(this.mounts.values()),
    };
  }

  // ------------------------------------------------------------ montar DMG
  /**
   * Monta un DMG virtual. El manifest es:
   * {
   *   id: "myapp",
   *   name: "My App",
   *   version: "1.0.0",
   *   developerId: "Apple Inc.",
   *   size: 12345678,
   *   contents: [
   *     { type: "app", id: "myapp", name: "My App.app", icon: "📦", manifest: {...} },
   *     { type: "symlink", name: "Applications", target: "/Applications" },
   *     { type: "file", name: "README.txt", size: 1234 }
   *   ],
   *   license: "MIT" | null,
   *   background: "#ffffff",
   *   icon: "💿",
   * }
   */
  async mount(manifest, { dispatch } = {}) {
    if (!manifest || !manifest.id) {
      return { ok: false, error: "manifest.id required" };
    }

    const id = nextMountId();
    const mountState = {
      id,
      manifest,
      cancelled: false,
      dispatch,
    };
    this.activeMounts.set(id, mountState);

    dispatch?.({ type: "START_MOUNT", id, manifest });
    kernelBus.emit(DMG_EVENTS.MOUNT_START, { id, manifest });
    this.logger.info(`mounting DMG: ${manifest.name}`);

    const update = (patch) =>
      dispatch?.({ type: "UPDATE_MOUNT", id, patch });

    const checkCancelled = () => {
      if (mountState.cancelled) throw new Error("cancelled");
    };

    try {
      // ----- 1. Simular descarga/preparación (opcional)
      const totalSteps = 8;
      for (let i = 1; i <= totalSteps; i++) {
        checkCancelled();
        await sleep(80 + Math.random() * 60);
        const progress = Math.round((i / totalSteps) * 60);
        update({ progress });
        kernelBus.emit(DMG_EVENTS.MOUNT_PROGRESS, { id, progress });
      }

      // ----- 2. Verificar firma
      update({ state: DMG_STATE.VERIFYING, progress: 70 });
      kernelBus.emit(DMG_EVENTS.VERIFY_START, { id });

      if (this.options.strictSignature) {
        const verification = await verifySignature(manifest);
        if (!verification.ok) {
          kernelBus.emit(DMG_EVENTS.VERIFY_FAILED, {
            id,
            reason: verification.reason,
          });
          kernelBus.emit(DMG_EVENTS.REJECTED, {
            id,
            reason: verification.reason,
          });
          this.logger.warn(
            `DMG rejected: ${manifest.name} (${verification.reason})`
          );
          throw new Error(`signature: ${verification.reason}`);
        }
        update({ developer: verification.developer });
        kernelBus.emit(DMG_EVENTS.VERIFIED, {
          id,
          developer: verification.developer,
        });
      } else {
        kernelBus.emit(DMG_EVENTS.VERIFIED, { id, developer: "unchecked" });
      }

      // ----- 3. Registrar el volumen montado
      const volume = {
        id,
        name: manifest.name || manifest.id,
        manifest,
        mountedAt: Date.now(),
        contents: manifest.contents || [],
        icon: manifest.icon || "💿",
      };

      this.mounts.set(id, volume);
      update({ state: DMG_STATE.MOUNTED, progress: 100 });

      kernelBus.emit(DMG_EVENTS.MOUNTED, { id, volume });
      this.logger.info(`DMG mounted: ${volume.name} (${id})`);

      toast.success(
        "Imagen de disco montada",
        `${volume.name} — arrastra la app a Aplicaciones`
      );

      setTimeout(() => dispatch?.({ type: "FINISH_MOUNT" }), 500);

      this.activeMounts.delete(id);
      this._notify();

      return { ok: true, volume };
    } catch (err) {
      const cancelled = String(err?.message) === "cancelled";
      update({
        state: cancelled ? DMG_STATE.IDLE : DMG_STATE.FAILED,
        error: String(err),
      });
      dispatch?.({
        type: "ADD_HISTORY",
        entry: {
          id,
          name: manifest.name || manifest.id,
          ts: Date.now(),
          state: cancelled ? "cancelled" : "failed",
          error: String(err),
        },
      });
      if (!cancelled) {
        kernelBus.emit(DMG_EVENTS.FAILED, { id, error: String(err) });
        dispatch?.({
          type: "ADD_ERROR",
          error: { id, error: String(err), ts: Date.now() },
        });
        this.logger.error(`DMG mount failed: ${manifest.name}`, err);
        toast.error("No se pudo montar la imagen", String(err));
      }
      setTimeout(() => dispatch?.({ type: "FINISH_MOUNT" }), 2000);
      this.activeMounts.delete(id);
      return { ok: false, error: err };
    }
  }

  cancelMount(id) {
    const s = this.activeMounts.get(id);
    if (!s) return false;
    s.cancelled = true;
    return true;
  }

  // ------------------------------------------------------------ desmontar
  async unmount(id, { dispatch, force = false } = {}) {
    const volume = this.mounts.get(id);
    if (!volume) return { ok: false, error: "not mounted" };

    kernelBus.emit(DMG_EVENTS.UNMOUNT_START, { id });
    this.logger.info(`unmounting: ${volume.name}`);

    await sleep(350);

    this.mounts.delete(id);
    kernelBus.emit(DMG_EVENTS.UNMOUNTED, { id });
    this.logger.info(`unmounted: ${volume.name}`);
    this._notify();

    if (!force) {
      toast.info("Imagen desmontada", volume.name);
    }

    return { ok: true };
  }

  // ------------------------------------------------------------ copiar app desde DMG
  async copyToApplications(
    mountId,
    contentId,
    { dispatch, appInstaller } = {}
  ) {
    const volume = this.mounts.get(mountId);
    if (!volume) return { ok: false, error: "mount not found" };

    const content = volume.contents.find(
      (c) => (c.id || c.name) === contentId
    );
    if (!content) return { ok: false, error: "content not found" };
    if (content.type !== "app" && content.type !== "application") {
      return { ok: false, error: "not an app" };
    }

    kernelBus.emit(DMG_EVENTS.COPY_START, {
      mountId,
      contentId,
      app: content.name,
    });
    this.logger.info(`copying ${content.name} to /Applications`);

    // Simular copia con progreso
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      await sleep(80 + Math.random() * 60);
      kernelBus.emit(DMG_EVENTS.COPY_PROGRESS, {
        mountId,
        contentId,
        progress: Math.round((i / steps) * 100),
      });
    }

    // Registrar la app en el AppInstaller
    if (appInstaller && content.manifest) {
      const result = await appInstaller.install(content.manifest, {
        dispatch: dispatch,
        source: "dmg",
      });
      if (!result.ok) {
        kernelBus.emit(DMG_EVENTS.FAILED, {
          mountId,
          error: "app install failed",
        });
        return result;
      }
    }

    kernelBus.emit(DMG_EVENTS.COPY_COMPLETE, {
      mountId,
      contentId,
      app: content.name,
    });
    kernelBus.emit(DMG_EVENTS.APP_INSTALLED, {
      mountId,
      app: content.name,
      manifest: content.manifest,
    });

    this.logger.info(`installed from DMG: ${content.name}`);
    toast.success(
      "Aplicación instalada",
      `${content.name} — se ha copiado a Aplicaciones`
    );

    // Auto-desmontar el DMG si está configurado
    if (this.options.autoUnmountAfterCopy) {
      setTimeout(() => {
        this.unmount(mountId, { dispatch }).catch(() => {});
      }, this.options.autoUnmountDelayMs);
    }

    return { ok: true };
  }

  // ------------------------------------------------------------ consultas
  getMount(id) {
    return this.mounts.get(id) ?? null;
  }

  listMounts() {
    return Array.from(this.mounts.values());
  }

  isMounted(id) {
    return this.mounts.has(id);
  }

  getMountContents(id) {
    const v = this.mounts.get(id);
    return v ? [...v.contents] : [];
  }
}

// ============================================================================
// CONTEXTO
// ============================================================================

const DMGInstallerContext = createContext(null);

export function DMGInstallerProvider({
  children,
  installer: external,
  options = {},
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new DMGInstaller(options);
  }
  const installer = ref.current;
  const appInstaller = useAppInstaller?.() ?? null;

  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    const unsub = installer.subscribe((snap) => {
      dispatch({ type: "SET_MOUNTS", mounts: snap.mounts });
    });
    const offLog = kernelBus.on(DMG_EVENTS.LOG, (entry) => {
      dispatch({ type: "LOG", entry });
    });
    return () => {
      unsub();
      offLog();
    };
  }, [installer]);

  const api = useMemo(
    () => ({
      installer,
      mounts: state.mounts,
      mounting: state.mounting,
      history: state.history,
      errors: state.errors,
      logs: state.logs,

      mount: (manifest) => installer.mount(manifest, { dispatch }),
      unmount: (id) => installer.unmount(id, { dispatch }),
      cancelMount: (id) => installer.cancelMount(id),

      copyToApplications: (mountId, contentId) =>
        installer.copyToApplications(mountId, contentId, {
          dispatch,
          appInstaller: appInstaller?.installer || null,
        }),

      getMount: (id) => installer.getMount(id),
      listMounts: () => installer.listMounts(),
      isMounted: (id) => installer.isMounted(id),
      getMountContents: (id) => installer.getMountContents(id),
    }),
    [installer, state, appInstaller]
  );

  return (
    <DMGInstallerContext.Provider value={api}>
      {children}
    </DMGInstallerContext.Provider>
  );
}

export function useDMGInstaller() {
  const ctx = useContext(DMGInstallerContext);
  if (!ctx)
    throw new Error(
      "useDMGInstaller must be used within a DMGInstallerProvider"
    );
  return ctx;
}

// ============================================================================
// VENTANA VISUAL DEL DMG (opcional)
// ============================================================================

export function DMGMountWindow({ mountId }) {
  const dmg = useDMGInstaller();
  const wm = useWindowManager();

  const volume = dmg.getMount(mountId);
  const [selectedContent, setSelectedContent] = React.useState(null);
  const [copied, setCopied] = React.useState(false);

  // Abrir la ventana al montar
  useEffect(() => {
    if (!volume) return;
    const id = wm.open({
      title: volume.name,
      width: 640,
      height: 440,
      component: () => null, // se renderiza via children
      data: { dmgMountId: mountId },
      minimizable: false,
    });

    return () => {
      if (wm.has?.(id)) wm.close(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountId]);

  if (!volume) return null;

  const handleCopy = async () => {
    if (!selectedContent) return;
    setCopied(true);
    await dmg.copyToApplications(mountId, selectedContent.id || selectedContent.name);
  };

  return null; // el contenido visual real lo pinta el Desktop
}

// ============================================================================
// EXPORTS DEFAULT
// ============================================================================

export default {
  DMGInstaller,
  DMGInstallerProvider,
  useDMGInstaller,
  DMGMountWindow,
  DMG_STATE,
  DMG_EVENTS,
};
