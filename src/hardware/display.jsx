// ============================================================================
// display.jsx — Subsistema de display completo
// ----------------------------------------------------------------------------
// Modela TODA la cadena de video, desde el framebuffer hasta el compositor:
//
//   - Detección de displays (físicos y virtuales)
//   - Modos de video: resolución, refresh, color depth, HDR
//   - Espacios de color: sRGB, Display P3, Adobe RGB, Rec.2020
//   - Escalado: HiDPI, DPI lógico/físico, factor de escala
//   - Brillo y gamma por display
//   - HDR: PQ, HLG, Dolby Vision, metadata estática/dinámica
//   - Color management: ICC profiles, conversión entre espacios
//   - Night Shift: temperatura de color adaptativa
//   - True Tone: balance de blancos adaptativo
//   - Composición: ventanas → framebuffers → displays
//   - VSync / adaptive sync / FreeSync / ProMotion
//   - Wake / sleep / hot-plug
//   - Integración con VGPU (presenta framebuffers reales)
//
// ARQUITECTURA
//
//   DisplayManager
//     ├─ Display × N          (cada monitor)
//     │   ├─ DisplayMode[]    (modos soportados)
//     │   ├─ ColorProfile     (ICC / espacio de color)
//     │   └─ FrameBuffer      (buffer actual presentado)
//     ├─ Compositor           (mezcla ventanas → displays)
//     └─ VSyncController      (sincronización adaptativa)
//
// FÍSICA
//
//   - Cada Display tiene dimensiones físicas (mm) y píxeles (px)
//   - De ahí sale el DPI (píxeles por pulgada)
//   - El factor de escala (Retina) es scale = round(DPI / 72)
//   - El tamaño lógico = píxeles físicos / scale
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

export const DISPLAY_STATE = Object.freeze({
  OFF: "off",
  SLEEPING: "sleeping",
  WAKING: "waking",
  ON: "on",
  FAILED: "failed",
  DISCONNECTED: "disconnected",
});

export const COLOR_SPACE = Object.freeze({
  SRGB: "srgb",
  DISPLAY_P3: "display-p3",
  ADOBE_RGB: "adobe-rgb",
  REC_2020: "rec2020",
  REC_709: "rec709",
  DCI_P3: "dci-p3",
  BT_2020: "bt2020",
});

export const HDR_MODE = Object.freeze({
  NONE: "none",
  HDR10: "hdr10",
  HDR10_PLUS: "hdr10-plus",
  DOLBY_VISION: "dolby-vision",
  HLG: "hlg",
});

export const SCALING_MODE = Object.freeze({
  STRETCH: "stretch",
  FIT: "fit",
  FILL: "fill",
  CENTER: "center",
  NATIVE: "native",
});

export const VSYNC_MODE = Object.freeze({
  OFF: "off",
  VSYNC: "vsync",
  ADAPTIVE: "adaptive", // FreeSync / G-Sync
  PRO_MOTION: "pro-motion", // Apple ProMotion
});

export const DISPLAY_EVENTS = Object.freeze({
  DISPLAY_CONNECTED: "display:connected",
  DISPLAY_DISCONNECTED: "display:disconnected",
  DISPLAY_STATE_CHANGED: "display:state-changed",
  MODE_CHANGED: "display:mode-changed",
  BRIGHTNESS_CHANGED: "display:brightness-changed",
  GAMMA_CHANGED: "display:gamma-changed",
  COLOR_SPACE_CHANGED: "display:color-space-changed",
  HDR_CHANGED: "display:hdr-changed",
  NIGHT_SHIFT_CHANGED: "display:night-shift-changed",
  TRUE_TONE_CHANGED: "display:true-tone-changed",
  SCALING_CHANGED: "display:scaling-changed",
  VSYNC_CHANGED: "display:vsync-changed",
  FRAME_PRESENTED: "display:frame-presented",
  VSYNC_TICK: "display:vsync-tick",
  OVERSCAN_CHANGED: "display:overscan-changed",
  LOG: "display:log",
});

// ============================================================================
// COLOR PROFILES
// ----------------------------------------------------------------------------
// Valores aproximados de primaries y white point por espacio de color.
// Son matrices de conversión 3x3 (de XYZ a RGB).
// ============================================================================

const COLOR_PROFILES = {
  [COLOR_SPACE.SRGB]: {
    name: "sRGB IEC61966-2.1",
    primaries: {
      red: [0.6400, 0.3300],
      green: [0.3000, 0.6000],
      blue: [0.1500, 0.0600],
    },
    whitePoint: [0.3127, 0.3290], // D65
    gamma: 2.2,
    maxLuminance: 100, // cd/m²
  },
  [COLOR_SPACE.DISPLAY_P3]: {
    name: "Display P3",
    primaries: {
      red: [0.6800, 0.3200],
      green: [0.2650, 0.6900],
      blue: [0.1500, 0.0600],
    },
    whitePoint: [0.3127, 0.3290], // D65
    gamma: 2.2,
    maxLuminance: 500,
  },
  [COLOR_SPACE.ADOBE_RGB]: {
    name: "Adobe RGB (1998)",
    primaries: {
      red: [0.6400, 0.3300],
      green: [0.2100, 0.7100],
      blue: [0.1500, 0.0600],
    },
    whitePoint: [0.3127, 0.3290],
    gamma: 2.2,
    maxLuminance: 300,
  },
  [COLOR_SPACE.REC_2020]: {
    name: "Rec. 2020",
    primaries: {
      red: [0.7080, 0.2920],
      green: [0.1700, 0.7970],
      blue: [0.1310, 0.0460],
    },
    whitePoint: [0.3127, 0.3290],
    gamma: 2.4,
    maxLuminance: 1000,
  },
  [COLOR_SPACE.DCI_P3]: {
    name: "DCI-P3",
    primaries: {
      red: [0.6800, 0.3200],
      green: [0.2650, 0.6900],
      blue: [0.1500, 0.0600],
    },
    whitePoint: [0.3140, 0.3510], // DCI white point
    gamma: 2.6,
    maxLuminance: 48,
  },
  [COLOR_SPACE.BT_2020]: {
    name: "BT.2020",
    primaries: {
      red: [0.7080, 0.2920],
      green: [0.1700, 0.7970],
      blue: [0.1310, 0.0460],
    },
    whitePoint: [0.3127, 0.3290],
    gamma: 2.4,
    maxLuminance: 10000,
  },
};

// ============================================================================
// MODOS DE VIDEO PREDEFINIDOS
// ============================================================================

const MODES_1080P = [
  { width: 1920, height: 1080, refresh: 60, colorDepth: 24, hdr: HDR_MODE.NONE },
  { width: 1920, height: 1080, refresh: 30, colorDepth: 24, hdr: HDR_MODE.NONE },
];

const MODES_4K = [
  { width: 3840, height: 2160, refresh: 60, colorDepth: 30, hdr: HDR_MODE.HDR10 },
  { width: 3840, height: 2160, refresh: 30, colorDepth: 30, hdr: HDR_MODE.HDR10 },
  { width: 1920, height: 1080, refresh: 60, colorDepth: 24, hdr: HDR_MODE.NONE },
];

const MODES_RETINA_LAPTOP = [
  { width: 2880, height: 1800, refresh: 60, colorDepth: 30, hdr: HDR_MODE.NONE },
  { width: 2560, height: 1600, refresh: 60, colorDepth: 30, hdr: HDR_MODE.NONE },
  { width: 1680, height: 1050, refresh: 60, colorDepth: 24, hdr: HDR_MODE.NONE },
];

const MODES_PRO_DISPLAY = [
  { width: 6016, height: 3384, refresh: 60, colorDepth: 30, hdr: HDR_MODE.HDR10 },
  { width: 5120, height: 2880, refresh: 60, colorDepth: 30, hdr: HDR_MODE.HDR10 },
  { width: 3840, height: 2160, refresh: 60, colorDepth: 30, hdr: HDR_MODE.HDR10 },
];

// ============================================================================
// DISPLAY
// ============================================================================

let _displayCounter = 0;

class Display {
  constructor({
    id,
    name,
    widthMm = 527,       // 23.5" ≈ 527mm de ancho
    heightMm = 296,
    modes = MODES_4K,
    defaultModeIndex = 0,
    colorSpace = COLOR_SPACE.DISPLAY_P3,
    isPrimary = false,
    isBuiltin = false,
    maxRefreshHz = 60,
    supportsHDR = true,
    supportsAdaptiveSync = false,
    manufacturer = "RainDisplays",
    model = "Virtual 4K",
    serialNumber = `SN-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
  } = {}) {
    this.id = id || `display-${++_displayCounter}`;
    this.name = name || `Display ${_displayCounter}`;
    this.widthMm = widthMm;
    this.heightMm = heightMm;
    this.modes = modes.map((m) => ({ ...m }));
    this.modeIndex = defaultModeIndex;
    this.colorSpace = colorSpace;
    this.isPrimary = isPrimary;
    this.isBuiltin = isBuiltin;
    this.maxRefreshHz = maxRefreshHz;
    this.supportsHDR = supportsHDR;
    this.supportsAdaptiveSync = supportsAdaptiveSync;
    this.manufacturer = manufacturer;
    this.model = model;
    this.serialNumber = serialNumber;

    this.state = DISPLAY_STATE.ON;
    this.brightness = 0.8;
    this.gamma = 2.2;
    this.nightShiftEnabled = false;
    this.nightShiftTemperature = 3400; // K
    this.trueToneEnabled = true;
    this.hdrMode = HDR_MODE.NONE;
    this.scalingMode = SCALING_MODE.NATIVE;
    this.vsyncMode = supportsAdaptiveSync ? VSYNC_MODE.ADAPTIVE : VSYNC_MODE.VSYNC;
    this.overscan = { top: 0, right: 0, bottom: 0, left: 0 };
    this.rotation = 0; // 0, 90, 180, 270

    this.stats = {
      framesPresented: 0,
      framesDropped: 0,
      vsyncMissed: 0,
      lastPresentAt: null,
      totalPresentTime: 0,
    };

    this.listeners = new Set();
  }

  // -------------------------------------------------------------- suscripción
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(event, payload) {
    for (const fn of this.listeners) {
      try { fn(event, payload); } catch {}
    }
  }

  // -------------------------------------------------------------- mode
  get currentMode() {
    return this.modes[this.modeIndex];
  }

  setMode(index) {
    if (index < 0 || index >= this.modes.length) return false;
    const prev = this.modeIndex;
    this.modeIndex = index;
    const mode = this.currentMode;
    this._emit(DISPLAY_EVENTS.MODE_CHANGED, { from: prev, to: index, mode });
    return true;
  }

  setModeBySignature(width, height, refresh) {
    const idx = this.modes.findIndex(
      (m) => m.width === width && m.height === height && m.refresh === refresh
    );
    if (idx < 0) return false;
    return this.setMode(idx);
  }

  // -------------------------------------------------------------- brightness
  setBrightness(pct) {
    const clamped = Math.max(0, Math.min(1, pct));
    this.brightness = clamped;
    this._emit(DISPLAY_EVENTS.BRIGHTNESS_CHANGED, { brightness: clamped });
  }

  setGamma(g) {
    this.gamma = Math.max(0.5, Math.min(3.0, g));
    this._emit(DISPLAY_EVENTS.GAMMA_CHANGED, { gamma: this.gamma });
  }

  // -------------------------------------------------------------- color
  setColorSpace(cs) {
    if (!COLOR_PROFILES[cs]) return false;
    this.colorSpace = cs;
    this._emit(DISPLAY_EVENTS.COLOR_SPACE_CHANGED, { colorSpace: cs });
    return true;
  }

  get colorProfile() {
    return COLOR_PROFILES[this.colorSpace];
  }

  // -------------------------------------------------------------- HDR
  setHDRMode(mode) {
    if (!this.supportsHDR && mode !== HDR_MODE.NONE) return false;
    this.hdrMode = mode;
    this._emit(DISPLAY_EVENTS.HDR_CHANGED, { hdrMode: mode });
    return true;
  }

  get isHDRActive() {
    return this.hdrMode !== HDR_MODE.NONE;
  }

  // -------------------------------------------------------------- night shift
  setNightShift(enabled, temperature = 3400) {
    this.nightShiftEnabled = enabled;
    if (temperature) this.nightShiftTemperature = temperature;
    this._emit(DISPLAY_EVENTS.NIGHT_SHIFT_CHANGED, {
      enabled,
      temperature: this.nightShiftTemperature,
    });
  }

  setTrueTone(enabled) {
    this.trueToneEnabled = enabled;
    this._emit(DISPLAY_EVENTS.TRUE_TONE_CHANGED, { enabled });
  }

  // -------------------------------------------------------------- scaling
  setScalingMode(mode) {
    this.scalingMode = mode;
    this._emit(DISPLAY_EVENTS.SCALING_CHANGED, { mode });
  }

  setVSyncMode(mode) {
    if (mode === VSYNC_MODE.ADAPTIVE && !this.supportsAdaptiveSync) return false;
    if (mode === VSYNC_MODE.PRO_MOTION && this.maxRefreshHz < 120) return false;
    this.vsyncMode = mode;
    this._emit(DISPLAY_EVENTS.VSYNC_CHANGED, { mode });
    return true;
  }

  setOverscan(patch) {
    this.overscan = { ...this.overscan, ...patch };
    this._emit(DISPLAY_EVENTS.OVERSCAN_CHANGED, { overscan: this.overscan });
  }

  // -------------------------------------------------------------- state
  sleep() {
    if (this.state === DISPLAY_STATE.SLEEPING || this.state === DISPLAY_STATE.OFF) return;
    this.state = DISPLAY_STATE.SLEEPING;
    this._emit(DISPLAY_EVENTS.DISPLAY_STATE_CHANGED, { state: this.state });
  }

  wake() {
    if (this.state !== DISPLAY_STATE.SLEEPING) return;
    this.state = DISPLAY_STATE.WAKING;
    this._emit(DISPLAY_EVENTS.DISPLAY_STATE_CHANGED, { state: this.state });
    setTimeout(() => {
      this.state = DISPLAY_STATE.ON;
      this._emit(DISPLAY_EVENTS.DISPLAY_STATE_CHANGED, { state: this.state });
    }, 300);
  }

  turnOff() {
    this.state = DISPLAY_STATE.OFF;
    this._emit(DISPLAY_EVENTS.DISPLAY_STATE_CHANGED, { state: this.state });
  }

  turnOn() {
    this.state = DISPLAY_STATE.ON;
    this._emit(DISPLAY_EVENTS.DISPLAY_STATE_CHANGED, { state: this.state });
  }

  // -------------------------------------------------------------- metrics
  get physicalWidth() {
    return this.currentMode.width;
  }

  get physicalHeight() {
    return this.currentMode.height;
  }

  get dpi() {
    // DPI = sqrt(ancho² + alto²) / diagonal (pulgadas)
    const px = Math.sqrt(this.physicalWidth ** 2 + this.physicalHeight ** 2);
    const diagMm = Math.sqrt(this.widthMm ** 2 + this.heightMm ** 2);
    const diagInches = diagMm / 25.4;
    return px / diagInches;
  }

  get scaleFactor() {
    // Apple Retina: si el DPI > 200, scale = 2. Si > 300, scale = 2 o 3.
    if (this.dpi >= 260) return 3;
    if (this.dpi >= 150) return 2;
    return 1;
  }

  get logicalWidth() {
    return Math.round(this.physicalWidth / this.scaleFactor);
  }

  get logicalHeight() {
    return Math.round(this.physicalHeight / this.scaleFactor);
  }

  // Espacio de color a vector RGB (aproximación de conversión a sRGB)
  computeTemperatureScale() {
    // Night Shift: bajar temperatura = más rojo, menos azul
    if (!this.nightShiftEnabled) return [1, 1, 1];
    const t = this.nightShiftTemperature;
    // 6500K → [1,1,1]; 3400K → [1, 0.85, 0.65]; 2700K → [1, 0.75, 0.5]
    const k = Math.max(2700, Math.min(6500, t));
    const r = 1.0;
    const g = 0.75 + (k - 2700) / (6500 - 2700) * 0.25;
    const b = 0.5 + (k - 2700) / (6500 - 2700) * 0.5;
    return [r, g, b];
  }

  // -------------------------------------------------------------- present
  presentFrame(frameId, { durationMs = 0 } = {}) {
    if (this.state !== DISPLAY_STATE.ON) return false;

    const refresh = this.currentMode.refresh;
    const now = performance.now();
    const last = this.stats.lastPresentAt;

    // VSync: si estamos en modo VSYNC y presentamos antes del intervalo, drop
    if (this.vsyncMode === VSYNC_MODE.VSYNC && last != null) {
      const expected = 1000 / refresh;
      if (now - last < expected * 0.9) {
        this.stats.framesDropped++;
        this.stats.vsyncMissed++;
        return false;
      }
    }

    this.stats.framesPresented++;
    this.stats.lastPresentAt = now;
    this.stats.totalPresentTime += durationMs;

    this._emit(DISPLAY_EVENTS.FRAME_PRESENTED, {
      frameId,
      durationMs,
      brightness: this.brightness,
      nightShift: this.nightShiftEnabled,
      nightShiftScale: this.computeTemperatureScale(),
      hdrMode: this.hdrMode,
      colorSpace: this.colorSpace,
    });

    kernelBus.emit(DISPLAY_EVENTS.FRAME_PRESENTED, {
      displayId: this.id,
      frameId,
      durationMs,
    });

    return true;
  }

  // -------------------------------------------------------------- snapshot
  snapshot() {
    const mode = this.currentMode;
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      primary: this.isPrimary,
      builtin: this.isBuiltin,
      manufacturer: this.manufacturer,
      model: this.model,
      serialNumber: this.serialNumber,
      physical: {
        widthMm: this.widthMm,
        heightMm: this.heightMm,
        dpi: this.dpi,
      },
      logical: {
        width: this.logicalWidth,
        height: this.logicalHeight,
        scaleFactor: this.scaleFactor,
      },
      mode: {
        width: mode.width,
        height: mode.height,
        refresh: mode.refresh,
        colorDepth: mode.colorDepth,
        hdr: mode.hdr,
      },
      availableModes: this.modes.length,
      colorSpace: this.colorSpace,
      colorProfileName: this.colorProfile?.name,
      hdrMode: this.hdrMode,
      isHDRActive: this.isHDRActive,
      brightness: this.brightness,
      gamma: this.gamma,
      nightShift: {
        enabled: this.nightShiftEnabled,
        temperature: this.nightShiftTemperature,
        rgbScale: this.computeTemperatureScale(),
      },
      trueTone: this.trueToneEnabled,
      scalingMode: this.scalingMode,
      vsyncMode: this.vsyncMode,
      rotation: this.rotation,
      overscan: { ...this.overscan },
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// COMPOSITOR
// ----------------------------------------------------------------------------
// Recibe "capas" (ventanas, overlays) y las compone en un framebuffer por
// display. Es puramente lógico: no dibuja, emite eventos para que el VGPU
// u otro renderer haga el trabajo real.
// ============================================================================

class Compositor {
  constructor({ displayManager }) {
    this.displayManager = displayManager;
    this.layers = new Map();     // layerId → { layerId, displayId, z, opacity, bounds, visible, content }
    this.dirty = new Set();      // displayIds que necesitan recomposición
    this.frameCounter = 0;
    this.stats = {
      composited: 0,
      layersCount: 0,
      avgLayersPerFrame: 0,
    };
  }

  addLayer({ layerId, displayId = null, z = 0, opacity = 1, bounds = {}, visible = true, content = null }) {
    this.layers.set(layerId, {
      layerId,
      displayId,
      z,
      opacity,
      bounds: {
        x: bounds.x ?? 0,
        y: bounds.y ?? 0,
        width: bounds.width ?? 0,
        height: bounds.height ?? 0,
      },
      visible,
      content,
      updatedAt: Date.now(),
    });
    this.stats.layersCount = this.layers.size;
    this._markDirty(displayId);
  }

  removeLayer(layerId) {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    this.layers.delete(layerId);
    this.stats.layersCount = this.layers.size;
    this._markDirty(layer.displayId);
  }

  updateLayer(layerId, patch) {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    Object.assign(layer, patch);
    layer.updatedAt = Date.now();
    this._markDirty(layer.displayId);
  }

  _markDirty(displayId) {
    if (displayId) this.dirty.add(displayId);
    else {
      // Afecta a todos los displays
      for (const d of this.displayManager.listDisplays()) this.dirty.add(d.id);
    }
  }

  // Devuelve las capas ordenadas por z para un display concreto
  layersFor(displayId) {
    const out = [];
    for (const layer of this.layers.values()) {
      if (!layer.visible) continue;
      if (layer.displayId != null && layer.displayId !== displayId) continue;
      out.push(layer);
    }
    return out.sort((a, b) => a.z - b.z);
  }

  // Composite completo
  composite() {
    this.frameCounter++;
    const displays = this.displayManager.listDisplays();
    let totalLayers = 0;

    for (const display of displays) {
      if (display.state !== DISPLAY_STATE.ON) continue;
      const layers = this.layersFor(display.id);
      totalLayers += layers.length;

      // Emitir capas ordenadas para que el renderer real lo pinte
      kernelBus.emit("compositor:frame", {
        displayId: display.id,
        frameId: this.frameCounter,
        layers: layers.map((l) => ({
          layerId: l.layerId,
          z: l.z,
          opacity: l.opacity,
          bounds: { ...l.bounds },
          content: l.content,
        })),
        brightness: display.brightness,
        nightShift: display.nightShiftEnabled,
        colorSpace: display.colorSpace,
        hdrMode: display.hdrMode,
      });

      display.presentFrame(this.frameCounter);
    }

    this.stats.composited++;
    this.stats.avgLayersPerFrame =
      (this.stats.avgLayersPerFrame * (this.stats.composited - 1) + totalLayers) /
      this.stats.composited;
    this.dirty.clear();
  }

  snapshot() {
    return {
      layers: this.layers.size,
      dirty: this.dirty.size,
      frame: this.frameCounter,
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// VSYNC CONTROLLER
// ----------------------------------------------------------------------------
// Genera los ticks de VSync para cada display. Los displays con refresh
// distinto tienen su propio loop.
// ============================================================================

class VsyncController {
  constructor({ displayManager, compositor }) {
    this.displayManager = displayManager;
    this.compositor = compositor;
    this.handles = new Map(); // displayId → interval
    this.stats = { ticks: 0, missedTicks: 0 };
  }

  start(displayId) {
    if (this.handles.has(displayId)) return;
    const display = this.displayManager.getDisplay(displayId);
    if (!display) return;

    const interval = 1000 / display.currentMode.refresh;
    let lastTick = performance.now();

    const handle = setInterval(() => {
      const now = performance.now();
      const delta = now - lastTick;
      lastTick = now;

      // Si ha pasado más del doble del intervalo, hay missed tick
      if (delta > interval * 2) {
        this.stats.missedTicks += Math.floor(delta / interval) - 1;
        display.stats.vsyncMissed++;
      }

      this.stats.ticks++;
      kernelBus.emit(DISPLAY_EVENTS.VSYNC_TICK, {
        displayId,
        ts: now,
        delta,
      });

      // Composición automática si hay capas
      if (this.compositor.dirty.size > 0) {
        this.compositor.composite();
      }
    }, interval);

    this.handles.set(displayId, handle);
  }

  stop(displayId) {
    const h = this.handles.get(displayId);
    if (h) {
      clearInterval(h);
      this.handles.delete(displayId);
    }
  }

  stopAll() {
    for (const h of this.handles.values()) clearInterval(h);
    this.handles.clear();
  }

  snapshot() {
    return {
      active: this.handles.size,
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// DISPLAY MANAGER
// ============================================================================

export class DisplayManager {
  constructor() {
    this.displays = new Map(); // id → Display
    this.primaryId = null;
    this.compositor = new Compositor({ displayManager: this });
    this.vsync = new VsyncController({
      displayManager: this,
      compositor: this.compositor,
    });
    this.listeners = new Set();
    this.stats = {
      hotplug: 0,
      connectCount: 0,
      disconnectCount: 0,
    };
  }

  // -------------------------------------------------------------- suscripción
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(event, payload) {
    kernelBus.emit(event, payload);
    for (const fn of this.listeners) {
      try { fn(event, payload); } catch {}
    }
  }

  // -------------------------------------------------------------- registro
  connect(options = {}) {
    const display = new Display(options);
    display.subscribe((event, payload) => {
      this._emit(event, { displayId: display.id, ...payload });
    });
    this.displays.set(display.id, display);
    if (display.isPrimary || this.primaryId == null) {
      this.primaryId = display.id;
    }
    this.stats.hotplug++;
    this.stats.connectCount++;
    this._emit(DISPLAY_EVENTS.DISPLAY_CONNECTED, display.snapshot());
    return display;
  }

  disconnect(displayId) {
    const display = this.displays.get(displayId);
    if (!display) return false;
    this.vsync.stop(displayId);
    display.state = DISPLAY_STATE.DISCONNECTED;
    this.displays.delete(displayId);
    if (this.primaryId === displayId) {
      this.primaryId = this.displays.keys().next().value ?? null;
    }
    this.stats.disconnectCount++;
    this._emit(DISPLAY_EVENTS.DISPLAY_DISCONNECTED, { displayId });
    return true;
  }

  getDisplay(id) {
    return this.displays.get(id) ?? null;
  }

  getPrimary() {
    return this.primaryId ? this.getDisplay(this.primaryId) : null;
  }

  listDisplays() {
    return Array.from(this.displays.values());
  }

  setPrimary(id) {
    if (!this.displays.has(id)) return false;
    for (const d of this.displays.values()) d.isPrimary = false;
    this.displays.get(id).isPrimary = true;
    this.primaryId = id;
    return true;
  }

  // -------------------------------------------------------------- lifecycle
  startAllVsync() {
    for (const d of this.displays.values()) {
      this.vsync.start(d.id);
    }
  }

  stopAllVsync() {
    this.vsync.stopAll();
  }

  sleepAll() {
    for (const d of this.displays.values()) d.sleep();
    this.stopAllVsync();
  }

  wakeAll() {
    for (const d of this.displays.values()) d.wake();
    setTimeout(() => this.startAllVsync(), 350);
  }

  // -------------------------------------------------------------- snapshot global
  snapshot() {
    return {
      displays: this.listDisplays().map((d) => d.snapshot()),
      primaryId: this.primaryId,
      compositor: this.compositor.snapshot(),
      vsync: this.vsync.snapshot(),
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// FÁBRICA DE DISPLAYS POR DEFECTO
// ----------------------------------------------------------------------------
// Detecta el display del navegador y crea un Display que lo refleja.
// ============================================================================

export function createDefaultDisplays() {
  const list = [];

  // Display del navegador (primario)
  const screenW = window.screen?.width ?? 1920;
  const screenH = window.screen?.height ?? 1080;
  const dpr = window.devicePixelRatio ?? 1;

  // Estimar tamaño físico a partir de un típico 27" 16:9
  const physicalDiagonalInches = 27;
  const physicalDiagonalMm = physicalDiagonalInches * 25.4;
  const ratio = screenW / screenH;
  const heightMm = physicalDiagonalMm / Math.sqrt(1 + ratio * ratio);
  const widthMm = heightMm * ratio;

  const isRetina = dpr > 1.5;

  list.push({
    id: "display-primary",
    name: "Built-in Display",
    widthMm: Math.round(widthMm),
    heightMm: Math.round(heightMm),
    modes: [
      {
        width: screenW,
        height: screenH,
        refresh: 60,
        colorDepth: 30,
        hdr: HDR_MODE.NONE,
      },
      {
        width: Math.round(screenW / 2),
        height: Math.round(screenH / 2),
        refresh: 60,
        colorDepth: 24,
        hdr: HDR_MODE.NONE,
      },
    ],
    defaultModeIndex: 0,
    colorSpace: COLOR_SPACE.DISPLAY_P3,
    isPrimary: true,
    isBuiltin: true,
    maxRefreshHz: 60,
    supportsHDR: false,
    supportsAdaptiveSync: false,
    manufacturer: "RainOS",
    model: "Virtual Display",
  });

  return list;
}

// ============================================================================
// PROVIDER + HOOKS
// ============================================================================

const DisplayContext = React.createContext(null);

export function DisplayProvider({
  children,
  manager: external,
  autoStart = true,
  autoCreate = true,
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new DisplayManager();
    if (autoCreate && ref.current.displays.size === 0) {
      for (const opts of createDefaultDisplays()) {
        ref.current.connect(opts);
      }
    }
  }
  const manager = ref.current;
  const [snapshot, setSnapshot] = useState(() => manager.snapshot());

  useEffect(() => {
    const unsub = manager.subscribe(() => setSnapshot(manager.snapshot()));
    if (autoStart) manager.startAllVsync();
    return () => {
      unsub();
      if (autoStart) manager.stopAllVsync();
    };
  }, [manager, autoStart]);

  const api = useMemo(
    () => ({
      manager,
      snapshot,
      connect: (opts) => manager.connect(opts),
      disconnect: (id) => manager.disconnect(id),
      getDisplay: (id) => manager.getDisplay(id),
      getPrimary: () => manager.getPrimary(),
      listDisplays: () => manager.listDisplays().map((d) => d.snapshot()),
      setPrimary: (id) => manager.setPrimary(id),

      // Compositor
      addLayer: (opts) => manager.compositor.addLayer(opts),
      removeLayer: (id) => manager.compositor.removeLayer(id),
      updateLayer: (id, patch) => manager.compositor.updateLayer(id, patch),
      composite: () => manager.compositor.composite(),
      layersFor: (displayId) => manager.compositor.layersFor(displayId),
      compositorSnapshot: () => manager.compositor.snapshot(),

      // Lifecycle
      sleepAll: () => manager.sleepAll(),
      wakeAll: () => manager.wakeAll(),
      startAllVsync: () => manager.startAllVsync(),
      stopAllVsync: () => manager.stopAllVsync(),
    }),
    [manager, snapshot]
  );

  return <DisplayContext.Provider value={api}>{children}</DisplayContext.Provider>;
}

export function useDisplay() {
  const ctx = React.useContext(DisplayContext);
  if (!ctx) throw new Error("useDisplay must be used within DisplayProvider");
  return ctx;
}

// Hook para un display concreto
export function useDisplayById(id) {
  const { getDisplay, snapshot } = useDisplay();
  const display = getDisplay(id);
  // Usar snapshot para forzar re-render cuando cambia
  const _ = snapshot;
  return display;
}

export default {
  Display,
  DisplayManager,
  Compositor,
  VsyncController,
  DisplayProvider,
  useDisplay,
  useDisplayById,
  createDefaultDisplays,
  DISPLAY_STATE,
  DISPLAY_EVENTS,
  COLOR_SPACE,
  HDR_MODE,
  SCALING_MODE,
  VSYNC_MODE,
  COLOR_PROFILES,
  MODES_1080P,
  MODES_4K,
  MODES_RETINA_LAPTOP,
  MODES_PRO_DISPLAY,
};
