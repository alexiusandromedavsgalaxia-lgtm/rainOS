// ============================================================================
// startupinstaller.jsx — Instalador de assets y runtime gráfico
// ----------------------------------------------------------------------------
// Instala SOLO lo necesario para que el sistema tenga UI:
//
// 1. IMAGE RUNTIME (ejecutor de imágenes)
//    - Registro de formatos (png, jpg, svg, webp, gif, avif, bmp, ico)
//    - Decoder con createImageBitmap + fallback HTMLImageElement
//    - Cache LRU con límite de memoria
//    - Precarga con concurrencia controlada
//    - Decode / preload / release
//
// 2. WINDOW RUNTIME (sistema de ventanas)
//    - Registro de estilos de ventana
//    - Registro de cursores por zona (drag, resize, close, min, max)
//    - Registro de efectos visuales (blur, vibrancy, sombras)
//    - Registro de traffic lights
//
// 3. MULTITASK RUNTIME (motor de multitarea)
//    - Registro de espacios (Spaces)
//    - Registro de hot corners
//    - Registro de gestos (swipe, pinch, rotate)
//    - Registro de atajos de teclado
//    - Registro de transiciones
//    - Configuración de Mission Control
//
// Todo puro JS. Cero UI obligatoria. Expone estado + acciones.
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
// CONSTANTES
// ============================================================================

export const INSTALL_STATE = Object.freeze({
  IDLE: "idle",
  LOADING_IMAGES: "loading-images",
  LOADING_WINDOWS: "loading-windows",
  LOADING_MULTITASK: "loading-multitask",
  WIRING: "wiring",
  VERIFYING: "verifying",
  READY: "ready",
  FAILED: "failed",
  ABORTED: "aborted",
});

export const INSTALL_EVENTS = Object.freeze({
  STARTED: "assets:started",
  STATE_CHANGED: "assets:state-changed",
  IMAGE_FORMAT_REGISTERED: "assets:image-format-registered",
  IMAGE_ASSET_REGISTERED: "assets:image-asset-registered",
  IMAGE_PRELOADED: "assets:image-preloaded",
  IMAGE_DECODED: "assets:image-decoded",
  IMAGE_FAILED: "assets:image-failed",
  IMAGE_CACHE_HIT: "assets:image-cache-hit",
  IMAGE_CACHE_MISS: "assets:image-cache-miss",
  IMAGE_EVICTED: "assets:image-evicted",
  WINDOW_STYLE_REGISTERED: "assets:window-style-registered",
  WINDOW_CURSOR_REGISTERED: "assets:window-cursor-registered",
  WINDOW_EFFECT_REGISTERED: "assets:window-effect-registered",
  SPACE_REGISTERED: "assets:space-registered",
  HOT_CORNER_REGISTERED: "assets:hot-corner-registered",
  GESTURE_REGISTERED: "assets:gesture-registered",
  SHORTCUT_REGISTERED: "assets:shortcut-registered",
  TRANSITION_REGISTERED: "assets:transition-registered",
  PROGRESS: "assets:progress",
  LOG: "assets:log",
  WARNING: "assets:warning",
  ERROR: "assets:error",
  VERIFY_OK: "assets:verify-ok",
  VERIFY_FAIL: "assets:verify-fail",
  READY: "assets:ready",
  FAILED: "assets:failed",
  ABORTED: "assets:aborted",
});

export const ASSET_KIND = Object.freeze({
  IMAGE: "image",
  SVG: "svg",
  SPRITE: "sprite",
  SOUND: "sound",
  FONT: "font",
});

export const WINDOW_ZONE = Object.freeze({
  TITLEBAR: "titlebar",
  CONTENT: "content",
  RESIZE_N: "resize-n",
  RESIZE_S: "resize-s",
  RESIZE_E: "resize-e",
  RESIZE_W: "resize-w",
  RESIZE_NE: "resize-ne",
  RESIZE_NW: "resize-nw",
  RESIZE_SE: "resize-se",
  RESIZE_SW: "resize-sw",
  CLOSE: "close",
  MINIMIZE: "minimize",
  MAXIMIZE: "maximize",
});

// ============================================================================
// LOGGER
// ============================================================================

class InstallerLog {
  constructor(max = 400) {
    this.max = max;
    this.entries = [];
  }

  push(level, message, meta) {
    const entry = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(INSTALL_EVENTS.LOG, entry);
    return entry;
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
  debug(m, x) {
    return this.push("debug", m, x);
  }

  all() {
    return [...this.entries];
  }
  clear() {
    this.entries = [];
  }
}

// ============================================================================
// ICONOS SVG DEL SISTEMA
// ============================================================================

const SYSTEM_SVG_ICONS = {
  "icon.finder": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1d9bf0"/><circle cx="10" cy="13" r="1.6" fill="#fff"/><circle cx="22" cy="13" r="1.6" fill="#fff"/><path d="M9 20c3 3 11 3 14 0" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`,
  "icon.terminal": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1e1e1e"/><path d="M8 12l4 4-4 4" stroke="#7ee787" stroke-width="2" fill="none" stroke-linecap="round"/><line x1="14" y1="20" x2="22" y2="20" stroke="#7ee787" stroke-width="2" stroke-linecap="round"/></svg>`,
  "icon.notes": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#fff8dc"/><rect x="7" y="7" width="18" height="18" rx="2" fill="#fff"/><line x1="11" y1="12" x2="21" y2="12" stroke="#f0b429" stroke-width="1.6"/><line x1="11" y1="16" x2="21" y2="16" stroke="#f0b429" stroke-width="1.6"/><line x1="11" y1="20" x2="18" y2="20" stroke="#f0b429" stroke-width="1.6"/></svg>`,
  "icon.settings": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#8e8e93"/><circle cx="16" cy="16" r="6" fill="none" stroke="#fff" stroke-width="2"/><circle cx="16" cy="16" r="2" fill="#fff"/></svg>`,
  "icon.trash": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#e5e5ea"/><path d="M9 11h14l-1.5 15a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2z" fill="#8e8e93"/><rect x="13" y="7" width="6" height="2" rx="1" fill="#8e8e93"/></svg>`,
  "icon.folder": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M4 9a2 2 0 0 1 2-2h6l2 3h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="#1d9bf0"/></svg>`,
  "icon.file": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M8 6h12l6 6v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" fill="#f2f2f7"/><path d="M20 6v6h6" fill="#c7c7cc"/></svg>`,
};

const SYSTEM_SVG_DATA_URLS = Object.fromEntries(
  Object.entries(SYSTEM_SVG_ICONS).map(([id, svg]) => [
    id,
    `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
  ])
);

// ============================================================================
// 1. IMAGE RUNTIME
// ============================================================================

class ImageRuntime {
  constructor({ maxBytes = 64 * 1024 * 1024, concurrency = 4 } = {}) {
    this.formats = new Map();
    this.assets = new Map();
    this.cache = new Map();
    this.maxBytes = maxBytes;
    this.currentBytes = 0;
    this.concurrency = concurrency;
  }

  registerFormat(mime, { ext = [], decoder } = {}) {
    this.formats.set(mime, {
      mime,
      ext: Array.isArray(ext) ? ext : [ext],
      decoder: decoder || this._defaultDecoder.bind(this),
    });
    kernelBus.emit(INSTALL_EVENTS.IMAGE_FORMAT_REGISTERED, { mime, ext });
  }

  hasFormat(mime) {
    return this.formats.has(mime);
  }

  formatsList() {
    return Array.from(this.formats.keys());
  }

  _detectMimeFromSrc(src, explicit) {
    if (explicit) return explicit;
    if (typeof src !== "string") return null;
    if (src.startsWith("data:")) {
      const m = src.slice(5).match(/^([^;,]+)/);
      return m ? m[1] : null;
    }
    const dot = src.lastIndexOf(".");
    if (dot < 0) return null;
    const ext = src.slice(dot + 1).toLowerCase();
    for (const [mime, info] of this.formats.entries()) {
      if (info.ext.includes(ext)) return mime;
    }
    return null;
  }

  async _defaultDecoder(src, { width, height } = {}) {
    if (
      typeof createImageBitmap === "function" &&
      !src.startsWith("data:image/svg")
    ) {
      try {
        const res = await fetch(src, { mode: "cors" });
        if (res.ok) {
          const blob = await res.blob();
          const opts = {};
          if (width) opts.resizeWidth = width;
          if (height) opts.resizeHeight = height;
          return await createImageBitmap(blob, opts);
        }
      } catch {
        /* fallback */
      }
    }

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`image load failed: ${src}`));
      img.src = src;
    });
  }

  registerAsset(id, asset) {
    const {
      src,
      kind = ASSET_KIND.IMAGE,
      mime,
      size = 0,
      meta = null,
    } = asset || {};
    if (!id || !src) throw new Error("[assets] asset requires id and src");
    const resolvedMime = this._detectMimeFromSrc(src, mime);
    this.assets.set(id, {
      id,
      src,
      kind,
      mime: resolvedMime,
      size,
      meta,
    });
    kernelBus.emit(INSTALL_EVENTS.IMAGE_ASSET_REGISTERED, {
      id,
      kind,
      mime: resolvedMime,
    });
  }

  registerAssets(map) {
    for (const [id, asset] of Object.entries(map)) {
      this.registerAsset(id, asset);
    }
  }

  hasAsset(id) {
    return this.assets.has(id);
  }

  getAsset(id) {
    return this.assets.get(id) ?? null;
  }

  listAssets() {
    return Array.from(this.assets.values());
  }

  _touch(key) {
    const e = this.cache.get(key);
    if (e) e.lastUsed = Date.now();
  }

  _evictIfNeeded() {
    if (this.currentBytes <= this.maxBytes) return;
    const entries = Array.from(this.cache.entries()).sort(
      (a, b) => a[1].lastUsed - b[1].lastUsed
    );
    for (const [key, e] of entries) {
      if (this.currentBytes <= this.maxBytes) break;
      this.cache.delete(key);
      this.currentBytes -= e.size || 0;
      kernelBus.emit(INSTALL_EVENTS.IMAGE_EVICTED, {
        src: e.src,
        size: e.size,
      });
    }
  }

  async decode(src, { mime, width, height, cache = true } = {}) {
    const resolvedMime = this._detectMimeFromSrc(src, mime);
    const cacheKey = `${src}|${width || ""}x${height || ""}`;

    if (cache && this.cache.has(cacheKey)) {
      this._touch(cacheKey);
      kernelBus.emit(INSTALL_EVENTS.IMAGE_CACHE_HIT, { src, cacheKey });
      return this.cache.get(cacheKey).bitmap;
    }

    kernelBus.emit(INSTALL_EVENTS.IMAGE_CACHE_MISS, { src, cacheKey });

    const format = resolvedMime && this.formats.get(resolvedMime);
    const decoder = format?.decoder || this._defaultDecoder.bind(this);

    const bitmap = await decoder(src, { width, height });
    const size = this._estimateBitmapSize(bitmap);

    if (cache) {
      this.cache.set(cacheKey, {
        bitmap,
        size,
        lastUsed: Date.now(),
        src,
      });
      this.currentBytes += size;
      this._evictIfNeeded();
    }

    kernelBus.emit(INSTALL_EVENTS.IMAGE_DECODED, {
      src,
      cacheKey,
      size,
    });
    return bitmap;
  }

  _estimateBitmapSize(bitmap) {
    if (!bitmap) return 0;
    const w = bitmap.width || bitmap.naturalWidth || 0;
    const h = bitmap.height || bitmap.naturalHeight || 0;
    return w * h * 4;
  }

  preload(list, { concurrency } = {}) {
    const jobs = list.map((item) =>
      typeof item === "string" ? { src: item } : item
    );
    return this._runWithConcurrency(jobs, concurrency || this.concurrency);
  }

  preloadAssets(ids, opts) {
    const jobs = [];
    for (const id of ids) {
      const a = this.assets.get(id);
      if (a) jobs.push({ src: a.src, mime: a.mime });
    }
    return this._runWithConcurrency(
      jobs,
      opts?.concurrency || this.concurrency
    );
  }

  async _runWithConcurrency(jobs, limit) {
    const results = [];
    let index = 0;

    const worker = async () => {
      while (index < jobs.length) {
        const i = index++;
        const job = jobs[i];
        try {
          const bitmap = await this.decode(job.src, job);
          results.push({ ok: true, src: job.src, bitmap });
          kernelBus.emit(INSTALL_EVENTS.IMAGE_PRELOADED, { src: job.src });
        } catch (err) {
          results.push({ ok: false, src: job.src, error: String(err) });
          kernelBus.emit(INSTALL_EVENTS.IMAGE_FAILED, {
            src: job.src,
            error: String(err),
          });
        }
      }
    };

    const workers = Array.from({ length: Math.max(1, limit) }, worker);
    await Promise.all(workers);
    return results;
  }

  async load(idOrSrc, opts) {
    const asset = this.assets.get(idOrSrc);
    if (asset) return this.decode(asset.src, { mime: asset.mime, ...opts });
    return this.decode(idOrSrc, opts);
  }

  release(src, { width, height } = {}) {
    const key = `${src}|${width || ""}x${height || ""}`;
    const e = this.cache.get(key);
    if (!e) return false;
    this.cache.delete(key);
    this.currentBytes -= e.size || 0;
    try {
      e.bitmap?.close?.();
    } catch {
      /* noop */
    }
    return true;
  }

  clearCache() {
    for (const [, e] of this.cache.entries()) {
      try {
        e.bitmap?.close?.();
      } catch {
        /* noop */
      }
    }
    this.cache.clear();
    this.currentBytes = 0;
  }

  stats() {
    return {
      formats: this.formats.size,
      assets: this.assets.size,
      cacheEntries: this.cache.size,
      cacheBytes: this.currentBytes,
      maxBytes: this.maxBytes,
    };
  }
}

// ============================================================================
// 2. WINDOW RUNTIME
// ============================================================================

class WindowRuntime {
  constructor() {
    this.styles = new Map();
    this.cursors = new Map();
    this.effects = new Map();
    this.trafficLights = new Map();
    this.zones = new Set(Object.values(WINDOW_ZONE));
  }

  registerStyle(id, style) {
    this.styles.set(id, {
      id,
      radius: style.radius ?? 12,
      shadow: style.shadow ?? "0 20px 50px rgba(0,0,0,0.35)",
      border: style.border ?? "0.5px solid rgba(0,0,0,0.2)",
      padding: style.padding ?? 0,
      titlebarHeight: style.titlebarHeight ?? 32,
      chrome: style.chrome ?? "default",
    });
    kernelBus.emit(INSTALL_EVENTS.WINDOW_STYLE_REGISTERED, { id });
  }

  getStyle(id) {
    return this.styles.get(id) ?? null;
  }

  registerCursor(zone, cursor) {
    this.cursors.set(zone, cursor);
    kernelBus.emit(INSTALL_EVENTS.WINDOW_CURSOR_REGISTERED, { zone, cursor });
  }

  getCursor(zone) {
    return this.cursors.get(zone) ?? "default";
  }

  registerEffect(id, effect) {
    this.effects.set(id, {
      id,
      name: effect.name || id,
      css: effect.css || {},
      params: effect.params || {},
    });
    kernelBus.emit(INSTALL_EVENTS.WINDOW_EFFECT_REGISTERED, { id });
  }

  getEffect(id) {
    return this.effects.get(id) ?? null;
  }

  registerTrafficLights(id, config) {
    this.trafficLights.set(id, {
      id,
      size: config.size ?? 12,
      gap: config.gap ?? 8,
      colors: config.colors || {
        close: "#ff5f57",
        minimize: "#febc2e",
        maximize: "#28c840",
      },
    });
  }

  getTrafficLights(id) {
    return this.trafficLights.get(id) ?? null;
  }
}

// ============================================================================
// 3. MULTITASK RUNTIME
// ============================================================================

class MultitaskRuntime {
  constructor() {
    this.spaces = new Map();
    this.hotCorners = new Map();
    this.gestures = new Map();
    this.shortcuts = new Map();
    this.transitions = new Map();
    this.missionControl = {
      enabled: true,
      animationMs: 300,
      layout: "grid",
    };
  }

  registerSpace(id, space) {
    this.spaces.set(id, {
      id,
      name: space.name || id,
      index: space.index ?? this.spaces.size,
      shortcut: space.shortcut ?? null,
    });
    kernelBus.emit(INSTALL_EVENTS.SPACE_REGISTERED, { id });
  }

  getSpace(id) {
    return this.spaces.get(id) ?? null;
  }

  listSpaces() {
    return Array.from(this.spaces.values()).sort((a, b) => a.index - b.index);
  }

  registerHotCorner(corner, config) {
    this.hotCorners.set(corner, {
      corner,
      action: config.action || (() => {}),
      threshold: config.threshold ?? 4,
      description: config.description || "",
    });
    kernelBus.emit(INSTALL_EVENTS.HOT_CORNER_REGISTERED, { corner });
  }

  getHotCorner(corner) {
    return this.hotCorners.get(corner) ?? null;
  }

  listHotCorners() {
    return Array.from(this.hotCorners.values());
  }

  registerGesture(id, gesture) {
    this.gestures.set(id, {
      id,
      type: gesture.type,
      fingers: gesture.fingers ?? 3,
      direction: gesture.direction ?? "any",
      action: gesture.action || (() => {}),
      description: gesture.description || "",
    });
    kernelBus.emit(INSTALL_EVENTS.GESTURE_REGISTERED, { id });
  }

  getGesture(id) {
    return this.gestures.get(id) ?? null;
  }

  listGestures() {
    return Array.from(this.gestures.values());
  }

  registerShortcut(combo, shortcut) {
    this.shortcuts.set(combo, {
      combo,
      action: shortcut.action || (() => {}),
      description: shortcut.description || "",
      global: shortcut.global !== false,
    });
    kernelBus.emit(INSTALL_EVENTS.SHORTCUT_REGISTERED, { combo });
  }

  getShortcut(combo) {
    return this.shortcuts.get(combo) ?? null;
  }

  listShortcuts() {
    return Array.from(this.shortcuts.values());
  }

  registerTransition(id, transition) {
    this.transitions.set(id, {
      id,
      from: transition.from,
      to: transition.to,
      durationMs: transition.durationMs ?? 300,
      easing: transition.easing ?? "ease-out",
    });
    kernelBus.emit(INSTALL_EVENTS.TRANSITION_REGISTERED, { id });
  }

  getTransition(id) {
    return this.transitions.get(id) ?? null;
  }

  listTransitions() {
    return Array.from(this.transitions.values());
  }

  setMissionControl(cfg) {
    this.missionControl = { ...this.missionControl, ...cfg };
  }

  getMissionControl() {
    return { ...this.missionControl };
  }
}

// ============================================================================
// ESTADO / REDUCER
// ============================================================================

const initialState = {
  state: INSTALL_STATE.IDLE,
  progress: 0,
  steps: {
    images: { done: false, count: 0, error: null },
    windows: { done: false, count: 0, error: null },
    multitask: { done: false, count: 0, error: null },
    wiring: { done: false },
    verifying: { done: false, ok: null },
  },
  stats: {
    imageFormats: 0,
    imageAssets: 0,
    windowStyles: 0,
    windowCursors: 0,
    windowEffects: 0,
    spaces: 0,
    hotCorners: 0,
    gestures: 0,
    shortcuts: 0,
    transitions: 0,
  },
  errors: [],
  warnings: [],
  logs: [],
  startedAt: null,
  finishedAt: null,
  durationMs: 0,
};

function reducer(state, action) {
  switch (action.type) {
    case "SET_STATE":
      return { ...state, state: action.state };

    case "START":
      return {
        ...initialState,
        state: INSTALL_STATE.LOADING_IMAGES,
        startedAt: Date.now(),
      };

    case "PROGRESS":
      return { ...state, progress: Math.max(state.progress, action.value) };

    case "STEP_DONE":
      return {
        ...state,
        steps: {
          ...state.steps,
          [action.step]: {
            ...state.steps[action.step],
            done: true,
            count: action.count ?? state.steps[action.step]?.count,
            error: null,
          },
        },
      };

    case "STEP_FAIL":
      return {
        ...state,
        steps: {
          ...state.steps,
          [action.step]: {
            ...state.steps[action.step],
            done: false,
            error: action.error,
          },
        },
        errors: [
          ...state.errors,
          { step: action.step, error: action.error },
        ],
      };

    case "WARNING":
      return { ...state, warnings: [...state.warnings, action.warning] };

    case "ERROR":
      return { ...state, errors: [...state.errors, action.error] };

    case "STATS":
      return { ...state, stats: { ...state.stats, ...action.stats } };

    case "VERIFY":
      return {
        ...state,
        steps: {
          ...state.steps,
          verifying: { done: true, ok: action.ok },
        },
      };

    case "LOG":
      return { ...state, logs: [...state.logs.slice(-399), action.entry] };

    case "READY":
      return {
        ...state,
        state: INSTALL_STATE.READY,
        progress: 100,
        finishedAt: Date.now(),
        durationMs: state.startedAt ? Date.now() - state.startedAt : 0,
      };

    case "FAIL":
      return {
        ...state,
        state: INSTALL_STATE.FAILED,
        errors: [...state.errors, action.error],
        finishedAt: Date.now(),
        durationMs: state.startedAt ? Date.now() - state.startedAt : 0,
      };

    case "ABORT":
      return { ...state, state: INSTALL_STATE.ABORTED };

    default:
      return state;
  }
}

// ============================================================================
// STARTUP INSTALLER
// ============================================================================

export class StartupInstaller {
  constructor(options = {}) {
    this.options = {
      imageMaxBytes: 64 * 1024 * 1024,
      imageConcurrency: 4,
      strict: false,
      assets: null,
      preload: null,
      ...options,
    };

    this.logger = new InstallerLog();
    this.imageRuntime = new ImageRuntime({
      maxBytes: this.options.imageMaxBytes,
      concurrency: this.options.imageConcurrency,
    });
    this.windowRuntime = new WindowRuntime();
    this.multitaskRuntime = new MultitaskRuntime();
    this.aborted = false;
    this.installed = false;
  }

  abort() {
    this.aborted = true;
    this.logger.warn("install aborted");
  }

  async _installImageRuntime(dispatch) {
    this.logger.info("installing image runtime");

    const check = (phase) => {
      if (this.aborted) throw new Error(`aborted during ${phase}`);
    };

    const formats = [
      { mime: "image/png", ext: ["png"] },
      { mime: "image/jpeg", ext: ["jpg", "jpeg"] },
      { mime: "image/gif", ext: ["gif"] },
      { mime: "image/webp", ext: ["webp"] },
      { mime: "image/svg+xml", ext: ["svg"] },
      { mime: "image/avif", ext: ["avif"] },
      { mime: "image/bmp", ext: ["bmp"] },
      { mime: "image/x-icon", ext: ["ico"] },
    ];
    for (const f of formats) {
      check("formats");
      this.imageRuntime.registerFormat(f.mime, { ext: f.ext });
    }

    check("system-icons");
    for (const [id, src] of Object.entries(SYSTEM_SVG_DATA_URLS)) {
      this.imageRuntime.registerAsset(id, {
        src,
        kind: ASSET_KIND.SVG,
        mime: "image/svg+xml",
      });
    }

    if (this.options.assets) {
      check("user-assets");
      this.imageRuntime.registerAssets(this.options.assets);
    }

    if (this.options.preload) {
      check("preload");
      const results = await this.imageRuntime.preload(this.options.preload);
      const failed = results.filter((r) => !r.ok);
      for (const f of failed) {
        dispatch({
          type: "WARNING",
          warning: `preload failed: ${f.src} (${f.error})`,
        });
      }
    }

    const stats = this.imageRuntime.stats();
    dispatch({
      type: "STEP_DONE",
      step: "images",
      count: stats.formats + stats.assets,
    });
    dispatch({
      type: "STATS",
      stats: {
        imageFormats: stats.formats,
        imageAssets: stats.assets,
      },
    });
    this.logger.info("image runtime installed", stats);
  }

  async _installWindowRuntime(dispatch) {
    this.logger.info("installing window runtime");

    if (this.aborted) throw new Error("aborted before window runtime");

    const styles = {
      default: {
        radius: 12,
        shadow:
          "0 20px 50px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(0,0,0,0.2)",
        border: "0.5px solid rgba(0,0,0,0.15)",
        titlebarHeight: 32,
      },
      compact: {
        radius: 8,
        shadow: "0 10px 30px rgba(0,0,0,0.3)",
        titlebarHeight: 26,
      },
      panel: {
        radius: 16,
        shadow: "0 30px 80px rgba(0,0,0,0.5)",
        titlebarHeight: 36,
      },
      utility: {
        radius: 10,
        shadow: "0 12px 30px rgba(0,0,0,0.28)",
        titlebarHeight: 28,
      },
    };
    for (const [id, style] of Object.entries(styles)) {
      this.windowRuntime.registerStyle(id, style);
    }

    const cursors = {
      [WINDOW_ZONE.RESIZE_N]: "ns-resize",
      [WINDOW_ZONE.RESIZE_S]: "ns-resize",
      [WINDOW_ZONE.RESIZE_E]: "ew-resize",
      [WINDOW_ZONE.RESIZE_W]: "ew-resize",
      [WINDOW_ZONE.RESIZE_NE]: "nesw-resize",
      [WINDOW_ZONE.RESIZE_NW]: "nwse-resize",
      [WINDOW_ZONE.RESIZE_SE]: "nwse-resize",
      [WINDOW_ZONE.RESIZE_SW]: "nesw-resize",
      [WINDOW_ZONE.TITLEBAR]: "grab",
      [WINDOW_ZONE.CONTENT]: "default",
      [WINDOW_ZONE.CLOSE]: "pointer",
      [WINDOW_ZONE.MINIMIZE]: "pointer",
      [WINDOW_ZONE.MAXIMIZE]: "pointer",
    };
    for (const [zone, cursor] of Object.entries(cursors)) {
      this.windowRuntime.registerCursor(zone, cursor);
    }

    const effects = [
      {
        id: "blur",
        name: "Background Blur",
        css: {
          backdropFilter: "blur(30px)",
          WebkitBackdropFilter: "blur(30px)",
        },
      },
      {
        id: "vibrancy",
        name: "Vibrancy",
        css: { background: "rgba(240,240,240,0.85)" },
      },
      {
        id: "shadow",
        name: "Drop Shadow",
        css: { boxShadow: "0 20px 50px rgba(0,0,0,0.35)" },
      },
    ];
    for (const e of effects) {
      this.windowRuntime.registerEffect(e.id, e);
    }

    this.windowRuntime.registerTrafficLights("default", {
      size: 12,
      gap: 8,
    });

    const stats = {
      windowStyles: this.windowRuntime.styles.size,
      windowCursors: this.windowRuntime.cursors.size,
      windowEffects: this.windowRuntime.effects.size,
    };

    dispatch({ type: "STEP_DONE", step: "windows", count: stats.windowStyles });
    dispatch({ type: "STATS", stats });
    this.logger.info("window runtime installed", stats);
  }

  async _installMultitaskRuntime(dispatch) {
    this.logger.info("installing multitask runtime");

    if (this.aborted) throw new Error("aborted before multitask runtime");

    this.multitaskRuntime.registerSpace("space-1", { name: "Desktop 1", index: 0 });
    this.multitaskRuntime.registerSpace("space-2", { name: "Desktop 2", index: 1 });
    this.multitaskRuntime.registerSpace("space-3", { name: "Desktop 3", index: 2 });

    this.multitaskRuntime.registerHotCorner("top-left", {
      description: "Mission Control",
    });
    this.multitaskRuntime.registerHotCorner("top-right", {
      description: "Notifications",
    });
    this.multitaskRuntime.registerHotCorner("bottom-left", {
      description: "Launchpad",
    });
    this.multitaskRuntime.registerHotCorner("bottom-right", {
      description: "Show Desktop",
    });

    this.multitaskRuntime.registerGesture("swipe-h", {
      type: "swipe",
      fingers: 3,
      direction: "horizontal",
      description: "Switch spaces",
    });
    this.multitaskRuntime.registerGesture("swipe-up", {
      type: "swipe",
      fingers: 3,
      direction: "up",
      description: "Mission Control",
    });
    this.multitaskRuntime.registerGesture("swipe-down", {
      type: "swipe",
      fingers: 3,
      direction: "down",
      description: "App Exposé",
    });
    this.multitaskRuntime.registerGesture("pinch", {
      type: "pinch",
      fingers: 4,
      description: "Show Launchpad",
    });

    this.multitaskRuntime.registerShortcut("meta+ArrowLeft", {
      description: "Move left a space",
    });
    this.multitaskRuntime.registerShortcut("meta+ArrowRight", {
      description: "Move right a space",
    });
    this.multitaskRuntime.registerShortcut("ctrl+ArrowUp", {
      description: "Mission Control",
    });
    this.multitaskRuntime.registerShortcut("meta+Space", {
      description: "Spotlight",
    });
    this.multitaskRuntime.registerShortcut("meta+shift+3", {
      description: "Screenshot full",
    });
    this.multitaskRuntime.registerShortcut("meta+shift+4", {
      description: "Screenshot area",
    });

    this.multitaskRuntime.registerTransition("space-slide-left", {
      from: "any",
      to: "any",
      durationMs: 300,
      easing: "ease-out",
    });
    this.multitaskRuntime.registerTransition("space-slide-right", {
      from: "any",
      to: "any",
      durationMs: 300,
      easing: "ease-out",
    });

    this.multitaskRuntime.setMissionControl({
      enabled: true,
      animationMs: 300,
      layout: "grid",
    });

    const stats = {
      spaces: this.multitaskRuntime.spaces.size,
      hotCorners: this.multitaskRuntime.hotCorners.size,
      gestures: this.multitaskRuntime.gestures.size,
      shortcuts: this.multitaskRuntime.shortcuts.size,
      transitions: this.multitaskRuntime.transitions.size,
    };

    dispatch({
      type: "STEP_DONE",
      step: "multitask",
      count: stats.spaces + stats.gestures + stats.shortcuts,
    });
    dispatch({ type: "STATS", stats });
    this.logger.info("multitask runtime installed", stats);
  }

  async _wire(dispatch) {
    dispatch({ type: "SET_STATE", state: INSTALL_STATE.WIRING });
    this.logger.info("wiring runtimes");
    dispatch({ type: "STEP_DONE", step: "wiring" });
  }

  async _verify(dispatch) {
    dispatch({ type: "SET_STATE", state: INSTALL_STATE.VERIFYING });

    const checks = [
      this.imageRuntime.formatsList().length > 0,
      this.imageRuntime.listAssets().length > 0,
      this.windowRuntime.styles.size > 0,
      this.windowRuntime.cursors.size > 0,
      this.multitaskRuntime.spaces.size > 0,
    ];

    const ok = checks.every(Boolean);
    dispatch({ type: "VERIFY", ok });

    kernelBus.emit(
      ok ? INSTALL_EVENTS.VERIFY_OK : INSTALL_EVENTS.VERIFY_FAIL,
      { ok }
    );

    if (!ok && this.options.strict) {
      throw new Error("verification failed");
    }

    return ok;
  }

  async run({ dispatch }) {
    this.installed = false;
    this.aborted = false;

    kernelBus.emit(INSTALL_EVENTS.STARTED, {});

    dispatch({ type: "START" });

    try {
      dispatch({ type: "SET_STATE", state: INSTALL_STATE.LOADING_IMAGES });
      await this._installImageRuntime(dispatch);
      dispatch({ type: "PROGRESS", value: 30 });

      if (this.aborted) throw new Error("aborted");

      dispatch({ type: "SET_STATE", state: INSTALL_STATE.LOADING_WINDOWS });
      await this._installWindowRuntime(dispatch);
      dispatch({ type: "PROGRESS", value: 60 });

      if (this.aborted) throw new Error("aborted");

      dispatch({
        type: "SET_STATE",
        state: INSTALL_STATE.LOADING_MULTITASK,
      });
      await this._installMultitaskRuntime(dispatch);
      dispatch({ type: "PROGRESS", value: 85 });

      if (this.aborted) throw new Error("aborted");

      await this._wire(dispatch);
      dispatch({ type: "PROGRESS", value: 92 });

      await this._verify(dispatch);
      dispatch({ type: "PROGRESS", value: 100 });

      dispatch({ type: "READY" });
      this.installed = true;
      kernelBus.emit(INSTALL_EVENTS.READY, {});
      this.logger.info("assets ready");
      return { ok: true };
    } catch (err) {
      dispatch({ type: "FAIL", error: String(err) });
      kernelBus.emit(INSTALL_EVENTS.FAILED, { error: String(err) });
      this.logger.error("install failed", err);
      return { ok: false, error: err };
    }
  }
}

// ============================================================================
// CONTEXTO + PROVIDER
// ============================================================================

const StartupInstallerContext = createContext(null);

export function StartupInstallerProvider({
  children,
  installer: external,
  options = {},
  autoRun = true,
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new StartupInstaller(options);
  }
  const installer = ref.current;

  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    const off = kernelBus.on(INSTALL_EVENTS.LOG, (entry) => {
      dispatch({ type: "LOG", entry });
    });
    return off;
  }, []);

  useEffect(() => {
    if (!autoRun) return;
    let cancelled = false;
    (async () => {
      const result = await installer.run({ dispatch });
      if (cancelled) return;
      void result;
    })();
    return () => {
      cancelled = true;
    };
  }, [autoRun]);

  const api = useMemo(
    () => ({
      installer,
      state,
      progress: state.progress,
      isReady: state.state === INSTALL_STATE.READY,
      isFailed: state.state === INSTALL_STATE.FAILED,
      steps: state.steps,
      stats: state.stats,
      errors: state.errors,
      warnings: state.warnings,
      logs: state.logs,
      durationMs: state.durationMs,

      imageRuntime: installer.imageRuntime,
      windowRuntime: installer.windowRuntime,
      multitaskRuntime: installer.multitaskRuntime,

      run: () => installer.run({ dispatch }),
      abort: () => installer.abort(),

      decode: (src, opts) => installer.imageRuntime.decode(src, opts),
      preload: (list, opts) => installer.imageRuntime.preload(list, opts),
      registerAsset: (id, asset) =>
        installer.imageRuntime.registerAsset(id, asset),
      registerAssets: (map) =>
        installer.imageRuntime.registerAssets(map),
      getAsset: (id) => installer.imageRuntime.getAsset(id),
      listAssets: () => installer.imageRuntime.listAssets(),
      clearCache: () => installer.imageRuntime.clearCache(),
      imageStats: () => installer.imageRuntime.stats(),

      getStyle: (id) => installer.windowRuntime.getStyle(id),
      getCursor: (zone) => installer.windowRuntime.getCursor(zone),
      getEffect: (id) => installer.windowRuntime.getEffect(id),
      getTrafficLights: (id) =>
        installer.windowRuntime.getTrafficLights(id),

      registerSpace: (id, space) =>
        installer.multitaskRuntime.registerSpace(id, space),
      registerHotCorner: (corner, cfg) =>
        installer.multitaskRuntime.registerHotCorner(corner, cfg),
      registerGesture: (id, gesture) =>
        installer.multitaskRuntime.registerGesture(id, gesture),
      registerShortcut: (combo, shortcut) =>
        installer.multitaskRuntime.registerShortcut(combo, shortcut),
      registerTransition: (id, transition) =>
        installer.multitaskRuntime.registerTransition(id, transition),
      setMissionControl: (cfg) =>
        installer.multitaskRuntime.setMissionControl(cfg),
      getMissionControl: () => installer.multitaskRuntime.getMissionControl(),
    }),
    [installer, state]
  );

  return (
    <StartupInstallerContext.Provider value={api}>
      {children}
    </StartupInstallerContext.Provider>
  );
}

export function useStartupInstaller() {
  const ctx = useContext(StartupInstallerContext);
  if (!ctx)
    throw new Error(
      "useStartupInstaller must be used within a StartupInstallerProvider"
    );
  return ctx;
}

// ============================================================================
// EXPORTS DEFAULT
// ============================================================================

export default {
  StartupInstaller,
  StartupInstallerProvider,
  useStartupInstaller,
  ImageRuntime,
  WindowRuntime,
  MultitaskRuntime,
  INSTALL_STATE,
  INSTALL_EVENTS,
  ASSET_KIND,
  WINDOW_ZONE,
};
