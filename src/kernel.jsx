// ============================================================================
// kernel.jsx — Kernel de ventanas estilo macOS
// ----------------------------------------------------------------------------
// - Gestión completa de ventanas (abrir, cerrar, enfocar, mover, redimensionar)
// - Pila de foco con z-index dinámico
// - Estados: normal, minimizada, maximizada, fullscreen
// - Snapping a bordes con umbral configurable
// - Drag y resize por 8 direcciones con mínimos
// - Clamping al viewport (no se pierden ventanas)
// - Hit-testing por coordenadas
// - EventBus desacoplado
// - Persistencia (serialize / hydrate)
// - Provider React + hook useWindowManager
// - Hooks useDraggable / useResizable
// - Todo sin UI. Solo lógica.
// ============================================================================

import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
} from "react";

// ============================================================================
// CONSTANTES
// ============================================================================

export const Z_BASE = 100;
export const Z_STEP = 1;
export const Z_MENUBAR = 10000;
export const Z_DOCK = 9000;

export const MIN_WIDTH = 320;
export const MIN_HEIGHT = 200;
export const DEFAULT_WIDTH = 720;
export const DEFAULT_HEIGHT = 480;

export const TOP_RESERVED = 28;
export const BOTTOM_RESERVED = 96;

export const SNAP_THRESHOLD = 12;
export const DOUBLE_CLICK_MS = 280;
export const CASCADE_STEP = 28;
export const CASCADE_WRAP = 8;

export const WINDOW_STATE = Object.freeze({
  NORMAL: "normal",
  MINIMIZED: "minimized",
  MAXIMIZED: "maximized",
  FULLSCREEN: "fullscreen",
});

export const RESIZE_DIRS = Object.freeze([
  "n",
  "s",
  "e",
  "w",
  "ne",
  "nw",
  "se",
  "sw",
]);

// ============================================================================
// UTILIDADES
// ============================================================================

export const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

export const isObject = (v) => v !== null && typeof v === "object";

export const noop = () => {};

export const now = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

// ============================================================================
// BUS DE EVENTOS
// ============================================================================

class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  on(event, handler) {
    if (typeof handler !== "function") return noop;
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  once(event, handler) {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off(event, handler) {
    const set = this.listeners.get(event);
    if (set) set.delete(handler);
  }

  emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const handler of Array.from(set)) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[kernel] listener error on "${event}"`, err);
      }
    }
  }

  clear(event) {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
  }

  count(event) {
    return this.listeners.get(event)?.size ?? 0;
  }
}

export const kernelBus = new EventBus();

export const KERNEL_EVENTS = Object.freeze({
  WINDOW_OPENED: "window:opened",
  WINDOW_CLOSED: "window:closed",
  WINDOW_FOCUSED: "window:focused",
  WINDOW_BLURRED: "window:blurred",
  WINDOW_MOVED: "window:moved",
  WINDOW_RESIZED: "window:resized",
  WINDOW_STATE_CHANGED: "window:state-changed",
  WINDOW_MINIMIZED: "window:minimized",
  WINDOW_RESTORED: "window:restored",
  WINDOW_MAXIMIZED: "window:maximized",
  WINDOW_UNMAXIMIZED: "window:unmaximized",
  WINDOW_FULLSCREEN_ENTER: "window:fullscreen-enter",
  WINDOW_FULLSCREEN_EXIT: "window:fullscreen-exit",
  WINDOW_UPDATED: "window:updated",
  VIEWPORT_CHANGED: "viewport:changed",
  MANAGER_RESET: "manager:reset",
  BLUR_ALL: "kernel:blur-all",
});

// ============================================================================
// GEOMETRÍA PURA
// ============================================================================

export function clampToViewport(x, y, width, height, viewport) {
  const minVisibleX = 80;
  const minVisibleY = TOP_RESERVED + 4;
  const maxX = viewport.width - minVisibleX;
  const minX = minVisibleX - width;
  const maxY = viewport.height - 40;
  const minY = minVisibleY;
  return {
    x: clamp(x, minX, maxX),
    y: clamp(y, minY, maxY),
  };
}

export function constrainResize(rect, dir, dx, dy) {
  let { x, y, width, height } = rect;

  if (dir.includes("e")) width += dx;
  if (dir.includes("s")) height += dy;

  if (dir.includes("w")) {
    const newWidth = width - dx;
    if (newWidth >= MIN_WIDTH) {
      width = newWidth;
      x += dx;
    } else {
      x += width - MIN_WIDTH;
      width = MIN_WIDTH;
    }
  }

  if (dir.includes("n")) {
    const newHeight = height - dy;
    const maxUp = y - TOP_RESERVED;
    if (newHeight >= MIN_HEIGHT && dy <= maxUp) {
      height = newHeight;
      y += dy;
    } else if (dy > maxUp) {
      height += maxUp;
      y = TOP_RESERVED;
    } else {
      y += height - MIN_HEIGHT;
      height = MIN_HEIGHT;
    }
  }

  if (width < MIN_WIDTH) width = MIN_WIDTH;
  if (height < MIN_HEIGHT) height = MIN_HEIGHT;

  if (y < TOP_RESERVED) {
    height -= TOP_RESERVED - y;
    y = TOP_RESERVED;
  }

  return { x, y, width, height };
}

export function applySnap(x, y, width, height, viewport) {
  let nx = x;
  let ny = y;

  if (Math.abs(x) <= SNAP_THRESHOLD) nx = 0;
  else if (Math.abs(x + width - viewport.width) <= SNAP_THRESHOLD)
    nx = viewport.width - width;

  if (Math.abs(y - TOP_RESERVED) <= SNAP_THRESHOLD) ny = TOP_RESERVED;

  return { x: nx, y: ny };
}

export function cascadePosition(index, viewport, width, height) {
  const baseX = Math.max(40, (viewport.width - width) / 2 - 120);
  const baseY = Math.max(
    TOP_RESERVED + 20,
    (viewport.height - height) / 2 - 120
  );
  const offset = index % CASCADE_WRAP;
  const x = clamp(baseX + offset * CASCADE_STEP, 0, viewport.width - width);
  const y = clamp(
    baseY + offset * CASCADE_STEP,
    TOP_RESERVED,
    viewport.height - 40
  );
  return { x, y };
}

export function rectsIntersect(a, b) {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

export function pointInRect(px, py, rect) {
  return (
    px >= rect.x &&
    px <= rect.x + rect.width &&
    py >= rect.y &&
    py <= rect.y + rect.height
  );
}

// ============================================================================
// ID GENERATOR
// ============================================================================

let _idCounter = 0;
const nextId = () => ++_idCounter;

// ============================================================================
// WINDOW MANAGER (clase pura)
// ============================================================================

export class WindowManager {
  constructor({ viewport = { width: 1440, height: 900 } } = {}) {
    this.viewport = { ...viewport };
    this.windows = [];
    this.focusStack = [];
    this.activeId = null;
    this.subscribers = new Set();
    this.snapshots = new Map();
    this.metadata = new Map();
    this._batchDepth = 0;
    this._dirty = false;
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _notify() {
    if (this._batchDepth > 0) {
      this._dirty = true;
      return;
    }
    const state = this.getState();
    for (const fn of this.subscribers) {
      try {
        fn(state);
      } catch (err) {
        console.error("[kernel] subscriber error", err);
      }
    }
  }

  batch(fn) {
    this._batchDepth++;
    try {
      fn();
    } finally {
      this._batchDepth--;
      if (this._batchDepth === 0 && this._dirty) {
        this._dirty = false;
        this._notify();
      }
    }
  }

  getState() {
    return {
      windows: this.windows.map((w) => ({ ...w })),
      activeId: this.activeId,
      viewport: { ...this.viewport },
    };
  }

  setViewport(viewport) {
    const changed =
      viewport.width !== this.viewport.width ||
      viewport.height !== this.viewport.height;
    if (!changed) return;

    this.viewport = { ...viewport };

    this.batch(() => {
      this.windows = this.windows.map((w) => {
        if (w.state === WINDOW_STATE.MAXIMIZED) {
          return {
            ...w,
            x: 0,
            y: TOP_RESERVED,
            width: this.viewport.width,
            height: this.viewport.height - TOP_RESERVED - BOTTOM_RESERVED,
          };
        }
        if (w.state === WINDOW_STATE.FULLSCREEN) {
          return {
            ...w,
            x: 0,
            y: 0,
            width: this.viewport.width,
            height: this.viewport.height,
          };
        }
        const { x, y } = clampToViewport(
          w.x,
          w.y,
          w.width,
          w.height,
          this.viewport
        );
        return { ...w, x, y };
      });
    });

    kernelBus.emit(KERNEL_EVENTS.VIEWPORT_CHANGED, { ...this.viewport });
    this._notify();
  }

  getViewport() {
    return { ...this.viewport };
  }

  open({
    appId,
    title,
    component,
    width,
    height,
    x,
    y,
    data,
    state = WINDOW_STATE.NORMAL,
    resizable = true,
    closable = true,
    minimizable = true,
    maximizable = true,
    fullscreenable = true,
    minWidth = MIN_WIDTH,
    minHeight = MIN_HEIGHT,
    metadata = null,
  } = {}) {
    const id = nextId();
    const w = width || DEFAULT_WIDTH;
    const h = height || DEFAULT_HEIGHT;

    const pos =
      x != null && y != null
        ? { x, y }
        : cascadePosition(this.windows.length, this.viewport, w, h);

    const win = {
      id,
      appId: appId || `app-${id}`,
      title: title || `Ventana ${id}`,
      component: component || null,
      data: data ?? null,
      x: pos.x,
      y: pos.y,
      width: w,
      height: h,
      state,
      zIndex: Z_BASE + this.focusStack.length * Z_STEP,
      createdAt: Date.now(),
      lastFocusedAt: Date.now(),
      flags: {
        resizable,
        closable,
        minimizable,
        maximizable,
        fullscreenable,
      },
      minWidth,
      minHeight,
    };

    this.windows = [...this.windows, win];
    if (metadata) this.metadata.set(id, metadata);

    this._focus(id, { emit: false });

    kernelBus.emit(KERNEL_EVENTS.WINDOW_OPENED, { id, window: { ...win } });
    this._notify();
    return id;
  }

  close(id) {
    const win = this._find(id);
    if (!win) return false;
    if (win.flags && win.flags.closable === false) return false;

    this.windows = this.windows.filter((w) => w.id !== id);
    this.focusStack = this.focusStack.filter((fid) => fid !== id);
    this.snapshots.delete(id);
    this.metadata.delete(id);

    if (this.activeId === id) {
      const newActive = this.focusStack[this.focusStack.length - 1] ?? null;
      const oldActive = this.activeId;
      this.activeId = newActive;
      this._reassignZ();
      if (oldActive != null && oldActive !== newActive) {
        kernelBus.emit(KERNEL_EVENTS.WINDOW_BLURRED, { id: oldActive });
      }
    }

    kernelBus.emit(KERNEL_EVENTS.WINDOW_CLOSED, { id });
    this._notify();
    return true;
  }

  closeAll() {
    const ids = this.windows.map((w) => w.id);
    this.windows = [];
    this.focusStack = [];
    this.activeId = null;
    this.snapshots.clear();
    this.metadata.clear();
    ids.forEach((id) => kernelBus.emit(KERNEL_EVENTS.WINDOW_CLOSED, { id }));
    this._notify();
  }

  reset() {
    this.windows = [];
    this.focusStack = [];
    this.activeId = null;
    this.snapshots.clear();
    this.metadata.clear();
    kernelBus.emit(KERNEL_EVENTS.MANAGER_RESET, {});
    this._notify();
  }

  _find(id) {
    return this.windows.find((w) => w.id === id);
  }

  _focus(id, { emit = true } = {}) {
    const win = this._find(id);
    if (!win) return;

    const previous = this.activeId;
    this.focusStack = this.focusStack.filter((fid) => fid !== id);
    this.focusStack.push(id);
    this.activeId = id;
    this._reassignZ();
    this.windows = this.windows.map((w) =>
      w.id === id ? { ...w, lastFocusedAt: Date.now() } : w
    );

    if (emit && previous !== id) {
      if (previous != null) {
        kernelBus.emit(KERNEL_EVENTS.WINDOW_BLURRED, { id: previous });
      }
      kernelBus.emit(KERNEL_EVENTS.WINDOW_FOCUSED, { id, previous });
    }
  }

  focus(id) {
    if (this.activeId === id) return;
    this._focus(id);
    this._notify();
  }

  blur() {
    if (this.activeId == null) return;
    const prev = this.activeId;
    this.activeId = null;
    this._reassignZ();
    kernelBus.emit(KERNEL_EVENTS.WINDOW_BLURRED, { id: prev });
    this._notify();
  }

  focusNext() {
    if (this.windows.length < 2) return;
    const idx = this.focusStack.indexOf(this.activeId);
    const next = this.focusStack[(idx + 1) % this.focusStack.length];
    this.focus(next);
  }

  focusPrev() {
    if (this.windows.length < 2) return;
    const idx = this.focusStack.indexOf(this.activeId);
    const prev =
      this.focusStack[
        (idx - 1 + this.focusStack.length) % this.focusStack.length
      ];
    this.focus(prev);
  }

  _reassignZ() {
    const zMap = new Map();
    this.focusStack.forEach((fid, idx) => {
      zMap.set(fid, Z_BASE + idx * Z_STEP);
    });
    this.windows = this.windows.map((w) => ({
      ...w,
      zIndex: zMap.get(w.id) ?? w.zIndex,
    }));
  }

  move(id, x, y, { snap = false } = {}) {
    const win = this._find(id);
    if (!win) return;
    if (
      win.state === WINDOW_STATE.MAXIMIZED ||
      win.state === WINDOW_STATE.FULLSCREEN
    )
      return;

    let nx = x;
    let ny = y;

    if (snap) {
      const snapped = applySnap(x, y, win.width, win.height, this.viewport);
      nx = snapped.x;
      ny = snapped.y;
    }

    const clamped = clampToViewport(
      nx,
      ny,
      win.width,
      win.height,
      this.viewport
    );

    if (clamped.x === win.x && clamped.y === win.y) return;

    this.windows = this.windows.map((w) =>
      w.id === id ? { ...w, x: clamped.x, y: clamped.y } : w
    );

    kernelBus.emit(KERNEL_EVENTS.WINDOW_MOVED, {
      id,
      x: clamped.x,
      y: clamped.y,
    });
    this._notify();
  }

  resize(id, dir, dx, dy) {
    const win = this._find(id);
    if (!win) return;
    if (win.flags && win.flags.resizable === false) return;
    if (
      win.state === WINDOW_STATE.MAXIMIZED ||
      win.state === WINDOW_STATE.FULLSCREEN
    )
      return;

    const rect = constrainResize(
      { x: win.x, y: win.y, width: win.width, height: win.height },
      dir,
      dx,
      dy
    );

    if (rect.width < win.minWidth) rect.width = win.minWidth;
    if (rect.height < win.minHeight) rect.height = win.minHeight;

    if (
      rect.x === win.x &&
      rect.y === win.y &&
      rect.width === win.width &&
      rect.height === win.height
    )
      return;

    this.windows = this.windows.map((w) =>
      w.id === id
        ? {
            ...w,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          }
        : w
    );

    kernelBus.emit(KERNEL_EVENTS.WINDOW_RESIZED, { id, ...rect });
    this._notify();
  }

  minimize(id) {
    const win = this._find(id);
    if (!win) return;
    if (win.flags && win.flags.minimizable === false) return;
    if (win.state === WINDOW_STATE.MINIMIZED) return;

    this.snapshots.set(id, {
      x: win.x,
      y: win.y,
      width: win.width,
      height: win.height,
    });

    this.windows = this.windows.map((w) =>
      w.id === id ? { ...w, state: WINDOW_STATE.MINIMIZED } : w
    );

    this.focusStack = this.focusStack.filter((fid) => fid !== id);
    if (this.activeId === id) {
      this.activeId = this.focusStack[this.focusStack.length - 1] ?? null;
      this._reassignZ();
    }

    kernelBus.emit(KERNEL_EVENTS.WINDOW_MINIMIZED, { id });
    kernelBus.emit(KERNEL_EVENTS.WINDOW_STATE_CHANGED, {
      id,
      state: WINDOW_STATE.MINIMIZED,
    });
    this._notify();
  }

  restore(id) {
    const win = this._find(id);
    if (!win) return;
    if (win.state !== WINDOW_STATE.MINIMIZED) return;

    const snap = this.snapshots.get(id);
    this.windows = this.windows.map((w) =>
      w.id === id ? { ...w, ...(snap || {}), state: WINDOW_STATE.NORMAL } : w
    );

    this._focus(id, { emit: false });

    kernelBus.emit(KERNEL_EVENTS.WINDOW_RESTORED, { id });
    kernelBus.emit(KERNEL_EVENTS.WINDOW_STATE_CHANGED, {
      id,
      state: WINDOW_STATE.NORMAL,
    });
    this._notify();
  }

  toggleMinimize(id) {
    const win = this._find(id);
    if (!win) return;
    if (win.state === WINDOW_STATE.MINIMIZED) this.restore(id);
    else this.minimize(id);
  }

  toggleMaximize(id) {
    const win = this._find(id);
    if (!win) return;
    if (win.flags && win.flags.maximizable === false) return;

    if (win.state === WINDOW_STATE.MAXIMIZED) {
      const prev = this.snapshots.get(id);
      this.windows = this.windows.map((w) =>
        w.id === id
          ? { ...w, ...(prev || {}), state: WINDOW_STATE.NORMAL }
          : w
      );
      kernelBus.emit(KERNEL_EVENTS.WINDOW_UNMAXIMIZED, { id });
      kernelBus.emit(KERNEL_EVENTS.WINDOW_STATE_CHANGED, {
        id,
        state: WINDOW_STATE.NORMAL,
      });
    } else {
      this.snapshots.set(id, {
        x: win.x,
        y: win.y,
        width: win.width,
        height: win.height,
      });
      this.windows = this.windows.map((w) =>
        w.id === id
          ? {
              ...w,
              x: 0,
              y: TOP_RESERVED,
              width: this.viewport.width,
              height: this.viewport.height - TOP_RESERVED - BOTTOM_RESERVED,
              state: WINDOW_STATE.MAXIMIZED,
            }
          : w
      );
      kernelBus.emit(KERNEL_EVENTS.WINDOW_MAXIMIZED, { id });
      kernelBus.emit(KERNEL_EVENTS.WINDOW_STATE_CHANGED, {
        id,
        state: WINDOW_STATE.MAXIMIZED,
      });
    }

    this._focus(id, { emit: false });
    this._notify();
  }

  toggleFullscreen(id) {
    const win = this._find(id);
    if (!win) return;
    if (win.flags && win.flags.fullscreenable === false) return;

    if (win.state === WINDOW_STATE.FULLSCREEN) {
      const prev = this.snapshots.get(id);
      this.windows = this.windows.map((w) =>
        w.id === id
          ? { ...w, ...(prev || {}), state: WINDOW_STATE.NORMAL }
          : w
      );
      kernelBus.emit(KERNEL_EVENTS.WINDOW_FULLSCREEN_EXIT, { id });
      kernelBus.emit(KERNEL_EVENTS.WINDOW_STATE_CHANGED, {
        id,
        state: WINDOW_STATE.NORMAL,
      });
    } else {
      this.snapshots.set(id, {
        x: win.x,
        y: win.y,
        width: win.width,
        height: win.height,
      });
      this.windows = this.windows.map((w) =>
        w.id === id
          ? {
              ...w,
              x: 0,
              y: 0,
              width: this.viewport.width,
              height: this.viewport.height,
              state: WINDOW_STATE.FULLSCREEN,
            }
          : w
      );
      kernelBus.emit(KERNEL_EVENTS.WINDOW_FULLSCREEN_ENTER, { id });
      kernelBus.emit(KERNEL_EVENTS.WINDOW_STATE_CHANGED, {
        id,
        state: WINDOW_STATE.FULLSCREEN,
      });
    }

    this._focus(id, { emit: false });
    this._notify();
  }

  update(id, patch) {
    const win = this._find(id);
    if (!win) return;
    this.windows = this.windows.map((w) =>
      w.id === id ? { ...w, ...patch } : w
    );
    kernelBus.emit(KERNEL_EVENTS.WINDOW_UPDATED, { id, patch });
    this._notify();
  }

  setTitle(id, title) {
    this.update(id, { title });
  }

  setData(id, data) {
    this.update(id, { data });
  }

  getWindow(id) {
    const w = this._find(id);
    return w ? { ...w } : null;
  }

  getWindows() {
    return this.windows.map((w) => ({ ...w }));
  }

  getVisibleWindows() {
    return this.windows
      .filter((w) => w.state !== WINDOW_STATE.MINIMIZED)
      .map((w) => ({ ...w }));
  }

  getMinimizedWindows() {
    return this.windows
      .filter((w) => w.state === WINDOW_STATE.MINIMIZED)
      .map((w) => ({ ...w }));
  }

  getActive() {
    return this.activeId != null ? this.getWindow(this.activeId) : null;
  }

  getByApp(appId) {
    return this.windows
      .filter((w) => w.appId === appId)
      .map((w) => ({ ...w }));
  }

  getWindowsSortedByZ() {
    return [...this.windows].sort((a, b) => a.zIndex - b.zIndex);
  }

  getWindowsSortedByZDesc() {
    return [...this.windows].sort((a, b) => b.zIndex - a.zIndex);
  }

  count() {
    return this.windows.length;
  }

  has(id) {
    return this.windows.some((w) => w.id === id);
  }

  hitTest(x, y) {
    const sorted = this.getWindowsSortedByZDesc();
    for (const w of sorted) {
      if (w.state === WINDOW_STATE.MINIMIZED) continue;
      if (pointInRect(x, y, w)) return w.id;
    }
    return null;
  }

  getIntersecting(rect) {
    return this.windows
      .filter((w) => rectsIntersect(w, rect))
      .map((w) => ({ ...w }));
  }

  setMetadata(id, metadata) {
    this.metadata.set(id, metadata);
  }

  getMetadata(id) {
    return this.metadata.get(id) ?? null;
  }

  serialize() {
    const windows = this.windows.map((w) => {
      const { component, ...rest } = w;
      return rest;
    });
    return JSON.stringify({
      version: 1,
      windows,
      activeId: this.activeId,
      focusStack: [...this.focusStack],
      snapshots: Array.from(this.snapshots.entries()),
    });
  }

  hydrate(json) {
    try {
      const parsed = typeof json === "string" ? JSON.parse(json) : json;
      if (!parsed || !Array.isArray(parsed.windows)) return false;

      const prevById = new Map(this.windows.map((w) => [w.id, w]));

      this.windows = parsed.windows.map((w) => {
        const prev = prevById.get(w.id);
        return {
          ...w,
          component: prev?.component ?? w.component ?? null,
        };
      });

      const maxId = this.windows.reduce((m, w) => Math.max(m, w.id), 0);
      _idCounter = Math.max(_idCounter, maxId);

      this.focusStack = parsed.focusStack
        ? [...parsed.focusStack]
        : this.windows.map((w) => w.id);
      this.activeId = parsed.activeId ?? null;

      this.snapshots = new Map(parsed.snapshots || []);
      this._reassignZ();
      this._notify();
      return true;
    } catch (err) {
      console.error("[kernel] hydrate error", err);
      return false;
    }
  }

  exportLayout() {
    return {
      windows: this.windows.map((w) => {
        const { component, ...rest } = w;
        return rest;
      }),
      activeId: this.activeId,
      focusStack: [...this.focusStack],
    };
  }
}

// ============================================================================
// CONTEXTO + PROVIDER
// ============================================================================

const WindowManagerContext = createContext(null);

export function WindowManagerProvider({ children, manager: external }) {
  const managerRef = useRef(null);
  if (!managerRef.current) {
    managerRef.current = external || new WindowManager();
  }

  const [state, setState] = useState(() => managerRef.current.getState());

  useEffect(() => {
    const m = managerRef.current;
    const unsub = m.subscribe(setState);

    const handleResize = () => {
      if (typeof window === "undefined") return;
      m.setViewport({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    if (typeof window !== "undefined") {
      window.addEventListener("resize", handleResize);
      handleResize();
    }

    return () => {
      unsub();
      if (typeof window !== "undefined") {
        window.removeEventListener("resize", handleResize);
      }
    };
  }, []);

  const api = useMemo(() => {
    const m = managerRef.current;
    return {
      manager: m,
      windows: state.windows,
      activeId: state.activeId,
      viewport: state.viewport,

      open: (opts) => m.open(opts),
      close: (id) => m.close(id),
      closeAll: () => m.closeAll(),
      reset: () => m.reset(),
      focus: (id) => m.focus(id),
      blur: () => m.blur(),
      focusNext: () => m.focusNext(),
      focusPrev: () => m.focusPrev(),
      move: (id, x, y, opts) => m.move(id, x, y, opts),
      resize: (id, dir, dx, dy) => m.resize(id, dir, dx, dy),
      minimize: (id) => m.minimize(id),
      restore: (id) => m.restore(id),
      toggleMinimize: (id) => m.toggleMinimize(id),
      toggleMaximize: (id) => m.toggleMaximize(id),
      toggleFullscreen: (id) => m.toggleFullscreen(id),
      update: (id, patch) => m.update(id, patch),
      setTitle: (id, t) => m.setTitle(id, t),
      setData: (id, d) => m.setData(id, d),

      getWindow: (id) => m.getWindow(id),
      getWindows: () => m.getWindows(),
      getVisibleWindows: () => m.getVisibleWindows(),
      getMinimizedWindows: () => m.getMinimizedWindows(),
      getActive: () => m.getActive(),
      getByApp: (appId) => m.getByApp(appId),
      getWindowsSortedByZ: () => m.getWindowsSortedByZ(),
      getWindowsSortedByZDesc: () => m.getWindowsSortedByZDesc(),
      count: () => m.count(),
      has: (id) => m.has(id),
      hitTest: (x, y) => m.hitTest(x, y),
      getIntersecting: (rect) => m.getIntersecting(rect),

      setMetadata: (id, md) => m.setMetadata(id, md),
      getMetadata: (id) => m.getMetadata(id),

      serialize: () => m.serialize(),
      hydrate: (json) => m.hydrate(json),
      exportLayout: () => m.exportLayout(),

      setViewport: (v) => m.setViewport(v),
      getViewport: () => m.getViewport(),

      batch: (fn) => m.batch(fn),
    };
  }, [state]);

  return (
    <WindowManagerContext.Provider value={api}>
      {children}
    </WindowManagerContext.Provider>
  );
}

export function useWindowManager() {
  const ctx = useContext(WindowManagerContext);
  if (!ctx)
    throw new Error(
      "useWindowManager must be used within a WindowManagerProvider"
    );
  return ctx;
}

// ============================================================================
// HOOK: useDraggable
// ============================================================================

export function useDraggable(id, options = {}) {
  const { snap = true, onStart, onMove, onEnd, getOrigin, threshold = 0 } =
    options;

  const { move, focus, getWindow } = useWindowManager();
  const dragRef = useRef(null);

  const handleMouseDown = useCallback(
    (e) => {
      if (e.button !== 0) return;
      if (e.defaultPrevented) return;

      const win = getWindow(id);
      if (!win) return;
      if (
        win.state === WINDOW_STATE.MAXIMIZED ||
        win.state === WINDOW_STATE.FULLSCREEN
      )
        return;

      focus(id);

      const origin = getOrigin ? getOrigin() : { x: win.x, y: win.y };

      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: origin.x,
        origY: origin.y,
        moved: false,
      };

      onStart?.({ id, x: origin.x, y: origin.y });

      const onMouseMove = (ev) => {
        const s = dragRef.current;
        if (!s) return;
        const dx = ev.clientX - s.startX;
        const dy = ev.clientY - s.startY;

        if (!s.moved && threshold > 0) {
          if (Math.hypot(dx, dy) < threshold) return;
          s.moved = true;
        }

        const nx = s.origX + dx;
        const ny = s.origY + dy;
        move(id, nx, ny, { snap });
        onMove?.({ id, x: nx, y: ny, dx, dy });
      };

      const onMouseUp = (ev) => {
        const s = dragRef.current;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        dragRef.current = null;
        onEnd?.({
          id,
          x: s ? s.origX + (ev.clientX - s.startX) : null,
          y: s ? s.origY + (ev.clientY - s.startY) : null,
          moved: s?.moved ?? false,
        });
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [id, move, focus, snap, onStart, onMove, onEnd, getOrigin, threshold, getWindow]
  );

  return { handleMouseDown };
}

// ============================================================================
// HOOK: useResizable
// ============================================================================

export function useResizable(id, dir, options = {}) {
  const { onStart, onMove, onEnd } = options;
  const { resize, focus, getWindow } = useWindowManager();
  const resizeRef = useRef(null);

  const handleMouseDown = useCallback(
    (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();

      const win = getWindow(id);
      if (!win) return;
      if (win.flags && win.flags.resizable === false) return;
      if (
        win.state === WINDOW_STATE.MAXIMIZED ||
        win.state === WINDOW_STATE.FULLSCREEN
      )
        return;

      focus(id);

      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
      };

      onStart?.({ id, dir });

      const onMouseMove = (ev) => {
        const s = resizeRef.current;
        if (!s) return;
        const dx = ev.clientX - s.startX;
        const dy = ev.clientY - s.startY;
        s.moved = true;
        resize(id, dir, dx, dy);
        onMove?.({ id, dir, dx, dy });
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        const s = resizeRef.current;
        resizeRef.current = null;
        onEnd?.({ id, dir, moved: s?.moved ?? false });
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [id, dir, resize, focus, onStart, onMove, onEnd, getWindow]
  );

  return { handleMouseDown };
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  WindowManager,
  WindowManagerProvider,
  useWindowManager,
  useDraggable,
  useResizable,
  kernelBus,
  KERNEL_EVENTS,
  WINDOW_STATE,
  RESIZE_DIRS,
  Z_BASE,
  Z_STEP,
  Z_MENUBAR,
  Z_DOCK,
  MIN_WIDTH,
  MIN_HEIGHT,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  TOP_RESERVED,
  BOTTOM_RESERVED,
  SNAP_THRESHOLD,
  DOUBLE_CLICK_MS,
  CASCADE_STEP,
  CASCADE_WRAP,
  clampToViewport,
  constrainResize,
  applySnap,
  cascadePosition,
  rectsIntersect,
  pointInRect,
  clamp,
  isObject,
  noop,
  now,
};
