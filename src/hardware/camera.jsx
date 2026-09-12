// ============================================================================
// camera.jsx — Subsistema de cámara completo
// ----------------------------------------------------------------------------
// Modela toda la pila de captura de vídeo, desde el sensor hasta el frame
// procesado, usando getUserMedia cuando está disponible:
//
//   - CameraManager: orquesta todas las cámaras y sesiones
//   - CameraDevice: cada dispositivo (frontal, trasera, USB, virtual)
//   - CaptureSession: una sesión de captura activa
//   - VideoStream: stream de vídeo con tracks y formato
//   - PhotoCapture: captura de foto estática desde el stream
//   - VideoRecording: grabación de vídeo con MediaRecorder
//   - CameraControls: exposición, foco, zoom, balance de blancos, HDR
//   - CameraFormats: lista de resoluciones y framerates soportados
//   - CameraEffects: filtros aplicados en tiempo real (Canvas)
//
// ARQUITECTURA
//
//   CameraManager
//     ├─ CameraDevice[]         (frontales, traseras, USB, virtuales)
//     │   ├─ MediaDeviceInfo    (info del navegador)
//     │   ├─ capabilities       (focos, exposiciones, resoluciones)
//     │   └─ settings           (aplicados actualmente)
//     ├─ CaptureSession[]       (una por uso activo)
//     │   ├─ MediaStream        (stream real)
//     │   ├─ VideoElement       (para preview)
//     │   └─ Canvas             (para procesado/efectos)
//     └─ Recorder[]             (MediaRecorder activos)
//
// FÍSICA Y CONTROLES
//
//   - getUserMedia({ video: { facingMode, width, height, frameRate } })
//   - applyConstraints() para cambiar resolución/fps/foco/etc.
//   - track.getCapabilities() para saber qué controles soporta
//   - track.getSettings() para saber qué está aplicado
//   - exposureMode: 'continuous' | 'manual'
//   - focusMode: 'continuous' | 'single-shot' | 'manual'
//   - whiteBalanceMode: 'continuous' | 'manual'
//   - zoom: 1..N (si soportado)
//   - torch: on/off (si soportado)
//
// EVENTOS
//
//   - manager:started, manager:stopped
//   - device:added, device:removed, device:changed
//   - device:selected
//   - session:started, session:stopped, session:failed
//   - stream:started, stream:stopped, stream:error
//   - settings:changed
//   - photo:captured
//   - recording:started, recording:stopped, recording:data
//   - control:changed
//   - effect:applied, effect:removed
//   - permission:denied, permission:granted
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

export const CAMERA_FACING = Object.freeze({
  FRONT: "user",
  BACK: "environment",
  EXTERNAL: "external",
  UNKNOWN: "unknown",
});

export const CAMERA_KIND = Object.freeze({
  BUILTIN: "builtin",
  USB: "usb",
  VIRTUAL: "virtual",
  CONTINUITY: "continuity",
  DESK_VIEW: "desk-view",
});

export const CAPTURE_STATE = Object.freeze({
  IDLE: "idle",
  REQUESTING_PERMISSION: "requesting-permission",
  STARTING: "starting",
  RUNNING: "running",
  PAUSED: "paused",
  STOPPING: "stopping",
  STOPPED: "stopped",
  FAILED: "failed",
});

export const RECORDING_STATE = Object.freeze({
  IDLE: "idle",
  RECORDING: "recording",
  PAUSED: "paused",
  STOPPED: "stopped",
});

export const EXPOSURE_MODE = Object.freeze({
  CONTINUOUS: "continuous",
  MANUAL: "manual",
});

export const FOCUS_MODE = Object.freeze({
  CONTINUOUS: "continuous",
  SINGLE_SHOT: "single-shot",
  MANUAL: "manual",
});

export const WHITE_BALANCE_MODE = Object.freeze({
  CONTINUOUS: "continuous",
  MANUAL: "manual",
});

export const CAMERA_EFFECT = Object.freeze({
  NONE: "none",
  GRAYSCALE: "grayscale",
  SEPIA: "sepia",
  INVERT: "invert",
  BLUR: "blur",
  BRIGHTNESS_UP: "brightness-up",
  BRIGHTNESS_DOWN: "brightness-down",
  CONTRAST: "contrast",
  SATURATE: "saturate",
  HUE_ROTATE: "hue-rotate",
  MIRROR: "mirror",
  VINTAGE: "vintage",
  COOL: "cool",
  WARM: "warm",
  NOISE: "noise",
  PIXELATE: "pixelate",
});

export const CAMERA_EVENTS = Object.freeze({
  MANAGER_STARTED: "camera:manager-started",
  MANAGER_STOPPED: "camera:manager-stopped",
  DEVICE_ADDED: "camera:device-added",
  DEVICE_REMOVED: "camera:device-removed",
  DEVICE_CHANGED: "camera:device-changed",
  DEVICE_SELECTED: "camera:device-selected",
  PERMISSION_REQUESTED: "camera:permission-requested",
  PERMISSION_GRANTED: "camera:permission-granted",
  PERMISSION_DENIED: "camera:permission-denied",
  SESSION_STARTED: "camera:session-started",
  SESSION_STOPPED: "camera:session-stopped",
  SESSION_FAILED: "camera:session-failed",
  STREAM_STARTED: "camera:stream-started",
  STREAM_STOPPED: "camera:stream-stopped",
  STREAM_ERROR: "camera:stream-error",
  SETTINGS_CHANGED: "camera:settings-changed",
  CONTROL_CHANGED: "camera:control-changed",
  PHOTO_CAPTURED: "camera:photo-captured",
  RECORDING_STARTED: "camera:recording-started",
  RECORDING_PAUSED: "camera:recording-paused",
  RECORDING_RESUMED: "camera:recording-resumed",
  RECORDING_STOPPED: "camera:recording-stopped",
  RECORDING_DATA: "camera:recording-data",
  EFFECT_APPLIED: "camera:effect-applied",
  EFFECT_REMOVED: "camera:effect-removed",
  LOG: "camera:log",
});

// ============================================================================
// LOGGER
// ============================================================================

class CameraLog {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(CAMERA_EVENTS.LOG, e);
  }
  info(m, x) { this.push("info", m, x); }
  warn(m, x) { this.push("warn", m, x); }
  error(m, x) { this.push("error", m, x); }
  all() { return [...this.entries]; }
}

// ============================================================================
// CÁMARA VIRTUAL (fallback cuando no hay getUserMedia)
// ----------------------------------------------------------------------------
// Genera un stream sintético con un canvas animado para poder probar el
// subsistema sin hardware real.
// ============================================================================

function createVirtualStream({ width = 640, height = 480, fps = 30, label = "Virtual Camera" } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  let frame = 0;
  let raf = null;

  const draw = () => {
    frame++;

    // Fondo con gradiente
    const grad = ctx.createLinearGradient(0, 0, width, height);
    const t = (frame * 0.005) % 1;
    grad.addColorStop(0, `hsl(${(t * 360) | 0}, 70%, 30%)`);
    grad.addColorStop(1, `hsl(${((t + 0.5) * 360) | 0}, 70%, 20%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // "Ruido"
    for (let i = 0; i < 200; i++) {
      ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.1})`;
      ctx.fillRect(Math.random() * width, Math.random() * height, 2, 2);
    }

    // Círculo animado (simula un sujeto)
    const cx = width / 2 + Math.sin(frame * 0.02) * 80;
    const cy = height / 2 + Math.cos(frame * 0.015) * 60;
    ctx.beginPath();
    ctx.arc(cx, cy, 60, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fill();

    // Info
    ctx.fillStyle = "#fff";
    ctx.font = "14px monospace";
    ctx.fillText(`Virtual Camera · ${width}x${height} @ ${fps}fps`, 12, 24);
    ctx.fillText(`Frame: ${frame}`, 12, height - 12);

    raf = requestAnimationFrame(draw);
  };
  draw();

  // Convertir canvas a MediaStream
  const stream = canvas.captureStream(fps);

  // Sobrescribir stop para limpiar el RAF
  const originalStop = stream.getTracks()[0].stop.bind(stream.getTracks()[0]);
  stream.getTracks().forEach((track) => {
    track.stop = () => {
      if (raf) cancelAnimationFrame(raf);
      originalStop();
    };
  });

  // Metadata
  stream.__virtual = true;
  stream.__label = label;

  return stream;
}

// ============================================================================
// CAMERA DEVICE
// ============================================================================

let _deviceCounter = 0;

class CameraDevice {
  constructor({
    id,
    label,
    kind,
    facing = CAMERA_FACING.UNKNOWN,
    mediaDeviceInfo = null,
    capabilities = {},
    virtual = false,
  }) {
    this.id = id || `cam-${++_deviceCounter}`;
    this.label = label;
    this.kind = kind;
    this.facing = facing;
    this.mediaDeviceInfo = mediaDeviceInfo;
    this.capabilities = {
      // Por defecto, todos los navegadores soportan esto
      width: { min: 320, max: 1920, step: 1 },
      height: { min: 240, max: 1080, step: 1 },
      frameRate: { min: 1, max: 60, step: 1 },
      // Estos dependen del navegador/plataforma
      exposureMode: null,
      exposureCompensation: null,
      exposureTime: null,
      focusMode: null,
      focusDistance: null,
      whiteBalanceMode: null,
      colorTemperature: null,
      iso: null,
      zoom: null,
      torch: null,
      ...capabilities,
    };
    this.virtual = virtual;
    this.createdAt = Date.now();
    this.stats = {
      sessionCount: 0,
      photoCount: 0,
      recordingCount: 0,
      secondsRecorded: 0,
    };
    this.settings = {
      width: 1280,
      height: 720,
      frameRate: 30,
      exposureMode: EXPOSURE_MODE.CONTINUOUS,
      exposureCompensation: 0,
      focusMode: FOCUS_MODE.CONTINUOUS,
      whiteBalanceMode: WHITE_BALANCE_MODE.CONTINUOUS,
      zoom: 1,
      torch: false,
    };
    this.listeners = new Set();
  }

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

  updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this._emit(CAMERA_EVENTS.SETTINGS_CHANGED, {
      deviceId: this.id,
      settings: { ...this.settings },
    });
  }

  snapshot() {
    return {
      id: this.id,
      label: this.label,
      kind: this.kind,
      facing: this.facing,
      virtual: this.virtual,
      capabilities: { ...this.capabilities },
      settings: { ...this.settings },
      createdAt: this.createdAt,
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// CAPTURE SESSION
// ============================================================================

let _sessionCounter = 0;

class CaptureSession {
  constructor({ manager, device }) {
    this.id = `session-${++_sessionCounter}`;
    this.manager = manager;
    this.device = device;
    this.state = CAPTURE_STATE.IDLE;
    this.stream = null;
    this.videoTrack = null;
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.effects = new Set();
    this.recorder = null;
    this.recordedChunks = [];
    this.recordingState = RECORDING_STATE.IDLE;
    this.startedAt = null;
    this.stoppedAt = null;
    this.listeners = new Set();
    this.frameStats = {
      framesRendered: 0,
      framesDropped: 0,
      lastFrameTs: null,
      fpsAvg: 0,
    };
  }

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

  _setState(state) {
    if (this.state === state) return;
    const prev = this.state;
    this.state = state;
    this._emit(CAMERA_EVENTS.SESSION_STARTED, {
      sessionId: this.id,
      from: prev,
      to: state,
    });
  }

  // -------------------------------------------------------------- start
  async start({ width, height, frameRate, facing, deviceId } = {}) {
    this._setState(CAPTURE_STATE.REQUESTING_PERMISSION);

    // Determinar constraints
    const constraints = {
      video: {
        width: width ? { ideal: width } : undefined,
        height: height ? { ideal: height } : undefined,
        frameRate: frameRate ? { ideal: frameRate } : undefined,
      },
      audio: false,
    };

    // facingMode si aplica
    if (facing) constraints.video.facingMode = { ideal: facing };

    // deviceId específico
    if (deviceId) constraints.video.deviceId = { exact: deviceId };

    // Si el device es virtual, usar el stream sintético
    if (this.device?.virtual) {
      try {
        this.stream = createVirtualStream({
          width: width || 640,
          height: height || 480,
          fps: frameRate || 30,
          label: this.device.label,
        });
      } catch (err) {
        this._setState(CAPTURE_STATE.FAILED);
        this._emit(CAMERA_EVENTS.SESSION_FAILED, {
          sessionId: this.id,
          error: String(err),
        });
        return false;
      }
    } else {
      // Stream real
      if (!navigator.mediaDevices?.getUserMedia) {
        // Fallback a virtual
        this._emit(CAMERA_EVENTS.PERMISSION_DENIED, {
          sessionId: this.id,
          reason: "getUserMedia no disponible",
        });
        try {
          this.stream = createVirtualStream({
            width: width || 640,
            height: height || 480,
            fps: frameRate || 30,
            label: "Fallback Virtual",
          });
        } catch (err) {
          this._setState(CAPTURE_STATE.FAILED);
          return false;
        }
      } else {
        try {
          this._emit(CAMERA_EVENTS.PERMISSION_REQUESTED, {
            sessionId: this.id,
            constraints,
          });
          this.stream = await navigator.mediaDevices.getUserMedia(constraints);
          this._emit(CAMERA_EVENTS.PERMISSION_GRANTED, {
            sessionId: this.id,
          });
        } catch (err) {
          this._setState(CAPTURE_STATE.FAILED);
          this._emit(CAMERA_EVENTS.STREAM_ERROR, {
            sessionId: this.id,
            error: String(err),
          });
          this._emit(CAMERA_EVENTS.SESSION_FAILED, {
            sessionId: this.id,
            error: String(err),
          });
          return false;
        }
      }
    }

    this._setState(CAPTURE_STATE.STARTING);

    // Track de vídeo
    this.videoTrack = this.stream.getVideoTracks()[0];
    if (!this.videoTrack) {
      this._setState(CAPTURE_STATE.FAILED);
      this._emit(CAMERA_EVENTS.STREAM_ERROR, {
        sessionId: this.id,
        error: "no video track",
      });
      return false;
    }

    // Leer capabilities reales del track
    if (this.videoTrack.getCapabilities && this.device) {
      try {
        const caps = this.videoTrack.getCapabilities();
        this.device.capabilities = {
          ...this.device.capabilities,
          ...caps,
        };
      } catch {}
    }

    // Leer settings reales
    if (this.videoTrack.getSettings && this.device) {
      try {
        const settings = this.videoTrack.getSettings();
        this.device.settings = {
          ...this.device.settings,
          ...settings,
        };
      } catch {}
    }

    this._setState(CAPTURE_STATE.RUNNING);
    this.startedAt = Date.now();
    if (this.device) this.device.stats.sessionCount++;

    this._emit(CAMERA_EVENTS.STREAM_STARTED, {
      sessionId: this.id,
      deviceId: this.device?.id,
      settings: this.device?.settings,
    });

    return true;
  }

  // -------------------------------------------------------------- stop
  stop() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try { track.stop(); } catch {}
      }
    }
    this.stream = null;
    this.videoTrack = null;
    this._setState(CAPTURE_STATE.STOPPED);
    this.stoppedAt = Date.now();

    this._emit(CAMERA_EVENTS.STREAM_STOPPED, {
      sessionId: this.id,
    });
    this._emit(CAMERA_EVENTS.SESSION_STOPPED, { sessionId: this.id });
  }

  // -------------------------------------------------------------- apply constraints
  async applyConstraints(constraints) {
    if (!this.videoTrack) return false;
    try {
      await this.videoTrack.applyConstraints(constraints);
      if (this.device && this.videoTrack.getSettings) {
        const settings = this.videoTrack.getSettings();
        this.device.updateSettings(settings);
        this._emit(CAMERA_EVENTS.CONTROL_CHANGED, {
          sessionId: this.id,
          settings,
        });
      }
      return true;
    } catch (err) {
      this._emit(CAMERA_EVENTS.STREAM_ERROR, {
        sessionId: this.id,
        error: String(err),
      });
      return false;
    }
  }

  // -------------------------------------------------------------- photo capture
  async capturePhoto({ type = "image/png", quality = 0.92, applyEffects = true } = {}) {
    if (this.state !== CAPTURE_STATE.RUNNING) {
      return { ok: false, error: "session not running" };
    }

    const width = this.device?.settings?.width ?? this.canvas.width ?? 1280;
    const height = this.device?.settings?.height ?? this.canvas.height ?? 720;

    this.canvas.width = width;
    this.canvas.height = height;

    // Dibujar el frame actual
    const videoElement = this._createVideoElement();
    await videoElement.play();
    this.ctx.drawImage(videoElement, 0, 0, width, height);

    // Aplicar efectos
    if (applyEffects && this.effects.size > 0) {
      this._applyEffectsToCanvas();
    }

    // Convertir a blob/dataURL
    const dataURL = this.canvas.toDataURL(type, quality);

    // Registrar stats
    if (this.device) this.device.stats.photoCount++;

    this._emit(CAMERA_EVENTS.PHOTO_CAPTURED, {
      sessionId: this.id,
      deviceId: this.device?.id,
      width,
      height,
      type,
      size: dataURL.length,
    });

    return {
      ok: true,
      dataURL,
      width,
      height,
      type,
      size: dataURL.length,
    };
  }

  _createVideoElement() {
    if (!this._videoEl) {
      const v = document.createElement("video");
      v.srcObject = this.stream;
      v.muted = true;
      v.playsInline = true;
      v.autoplay = true;
      v.width = this.device?.settings?.width ?? 1280;
      v.height = this.device?.settings?.height ?? 720;
      this._videoEl = v;
    }
    return this._videoEl;
  }

  // -------------------------------------------------------------- recording
  startRecording({ mimeType = "video/webm", videoBitsPerSecond = 2500000 } = {}) {
    if (this.state !== CAPTURE_STATE.RUNNING) return false;
    if (this.recordingState === RECORDING_STATE.RECORDING) return false;
    if (typeof MediaRecorder === "undefined") {
      this._emit(CAMERA_EVENTS.STREAM_ERROR, {
        sessionId: this.id,
        error: "MediaRecorder no disponible",
      });
      return false;
    }
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      this._emit(CAMERA_EVENTS.STREAM_ERROR, {
        sessionId: this.id,
        error: `mime no soportado: ${mimeType}`,
      });
      return false;
    }

    this.recordedChunks = [];

    try {
      this.recorder = new MediaRecorder(this.stream, {
        mimeType,
        videoBitsPerSecond,
      });
    } catch (err) {
      this._emit(CAMERA_EVENTS.STREAM_ERROR, {
        sessionId: this.id,
        error: String(err),
      });
      return false;
    }

    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.recordedChunks.push(e.data);
        this._emit(CAMERA_EVENTS.RECORDING_DATA, {
          sessionId: this.id,
          size: e.data.size,
        });
      }
    };

    this.recorder.onstart = () => {
      this.recordingState = RECORDING_STATE.RECORDING;
      if (this.device) this.device.stats.recordingCount++;
      this._emit(CAMERA_EVENTS.RECORDING_STARTED, {
        sessionId: this.id,
        mimeType,
      });
    };

    this.recorder.onstop = () => {
      this.recordingState = RECORDING_STATE.STOPPED;
      this._emit(CAMERA_EVENTS.RECORDING_STOPPED, {
        sessionId: this.id,
        chunks: this.recordedChunks.length,
      });
    };

    this.recorder.onerror = (err) => {
      this._emit(CAMERA_EVENTS.STREAM_ERROR, {
        sessionId: this.id,
        error: String(err),
      });
    };

    this.recorder.start(1000); // chunk cada 1s
    return true;
  }

  pauseRecording() {
    if (!this.recorder) return false;
    try {
      this.recorder.pause();
      this.recordingState = RECORDING_STATE.PAUSED;
      this._emit(CAMERA_EVENTS.RECORDING_PAUSED, { sessionId: this.id });
      return true;
    } catch {
      return false;
    }
  }

  resumeRecording() {
    if (!this.recorder) return false;
    try {
      this.recorder.resume();
      this.recordingState = RECORDING_STATE.RECORDING;
      this._emit(CAMERA_EVENTS.RECORDING_RESUMED, { sessionId: this.id });
      return true;
    } catch {
      return false;
    }
  }

  stopRecording() {
    if (!this.recorder) return false;
    try {
      this.recorder.stop();
      this.recorder = null;
      return true;
    } catch {
      return false;
    }
  }

  getRecordingBlob() {
    if (this.recordedChunks.length === 0) return null;
    return new Blob(this.recordedChunks, { type: this.recorder?.mimeType || "video/webm" });
  }

  // -------------------------------------------------------------- effects
  addEffect(effect) {
    this.effects.add(effect);
    this._emit(CAMERA_EVENTS.EFFECT_APPLIED, {
      sessionId: this.id,
      effect,
    });
  }

  removeEffect(effect) {
    this.effects.delete(effect);
    this._emit(CAMERA_EVENTS.EFFECT_REMOVED, {
      sessionId: this.id,
      effect,
    });
  }

  clearEffects() {
    const removed = Array.from(this.effects);
    this.effects.clear();
    for (const effect of removed) {
      this._emit(CAMERA_EVENTS.EFFECT_REMOVED, {
        sessionId: this.id,
        effect,
      });
    }
  }

  _applyEffectsToCanvas() {
    if (this.effects.size === 0) return;

    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    for (const effect of this.effects) {
      switch (effect) {
        case CAMERA_EFFECT.GRAYSCALE:
          for (let i = 0; i < data.length; i += 4) {
            const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            data[i] = data[i + 1] = data[i + 2] = g;
          }
          break;
        case CAMERA_EFFECT.SEPIA:
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            data[i] = Math.min(255, r * 0.393 + g * 0.769 + b * 0.189);
            data[i + 1] = Math.min(255, r * 0.349 + g * 0.686 + b * 0.168);
            data[i + 2] = Math.min(255, r * 0.272 + g * 0.534 + b * 0.131);
          }
          break;
        case CAMERA_EFFECT.INVERT:
          for (let i = 0; i < data.length; i += 4) {
            data[i] = 255 - data[i];
            data[i + 1] = 255 - data[i + 1];
            data[i + 2] = 255 - data[i + 2];
          }
          break;
        case CAMERA_EFFECT.BRIGHTNESS_UP:
          for (let i = 0; i < data.length; i += 4) {
            data[i] = Math.min(255, data[i] + 40);
            data[i + 1] = Math.min(255, data[i + 1] + 40);
            data[i + 2] = Math.min(255, data[i + 2] + 40);
          }
          break;
        case CAMERA_EFFECT.BRIGHTNESS_DOWN:
          for (let i = 0; i < data.length; i += 4) {
            data[i] = Math.max(0, data[i] - 40);
            data[i + 1] = Math.max(0, data[i + 1] - 40);
            data[i + 2] = Math.max(0, data[i + 2] - 40);
          }
          break;
        case CAMERA_EFFECT.CONTRAST:
          for (let i = 0; i < data.length; i += 4) {
            data[i] = clampByte((data[i] - 128) * 1.4 + 128);
            data[i + 1] = clampByte((data[i + 1] - 128) * 1.4 + 128);
            data[i + 2] = clampByte((data[i + 2] - 128) * 1.4 + 128);
          }
          break;
        case CAMERA_EFFECT.SATURATE:
          for (let i = 0; i < data.length; i += 4) {
            const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            data[i] = clampByte(g + (data[i] - g) * 1.5);
            data[i + 1] = clampByte(g + (data[i + 1] - g) * 1.5);
            data[i + 2] = clampByte(g + (data[i + 2] - g) * 1.5);
          }
          break;
        case CAMERA_EFFECT.COOL:
          for (let i = 0; i < data.length; i += 4) {
            data[i] = Math.max(0, data[i] - 20);
            data[i + 2] = Math.min(255, data[i + 2] + 30);
          }
          break;
        case CAMERA_EFFECT.WARM:
          for (let i = 0; i < data.length; i += 4) {
            data[i] = Math.min(255, data[i] + 30);
            data[i + 2] = Math.max(0, data[i + 2] - 20);
          }
          break;
        case CAMERA_EFFECT.VINTAGE:
          for (let i = 0; i < data.length; i += 4) {
            data[i] = clampByte(data[i] * 0.9 + 20);
            data[i + 1] = clampByte(data[i + 1] * 0.85 + 10);
            data[i + 2] = clampByte(data[i + 2] * 0.7);
          }
          break;
        default:
          break;
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  snapshot() {
    return {
      id: this.id,
      state: this.state,
      deviceId: this.device?.id,
      effects: Array.from(this.effects),
      recordingState: this.recordingState,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      frameStats: { ...this.frameStats },
    };
  }

  destroy() {
    this.stop();
    this.effects.clear();
    this._videoEl = null;
    this.recordedChunks = [];
  }
}

function clampByte(v) {
  return Math.max(0, Math.min(255, v | 0));
}

// ============================================================================
// CAMERA MANAGER
// ============================================================================

export class CameraManager {
  constructor({ autoEnumerate = true, includeVirtual = true } = {}) {
    this.log = new CameraLog();
    this.devices = new Map();
    this.selectedDeviceId = null;
    this.sessions = new Map();
    this.includeVirtual = includeVirtual;
    this.listeners = new Set();

    this.stats = {
      devicesDetected: 0,
      sessionsCreated: 0,
      photosCaptured: 0,
      recordingsCompleted: 0,
      bytesRecorded: 0,
    };

    if (autoEnumerate) {
      this.enumerate();
    }

    this._setupDeviceChangeListener();
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

  _log(level, message, meta) {
    this.log.push(level, message, meta);
  }

  // -------------------------------------------------------------- enumerate
  async enumerate() {
    // Enumerar dispositivos reales
    if (navigator.mediaDevices?.enumerateDevices) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videos = devices.filter((d) => d.kind === "videoinput");

        for (const info of videos) {
          if (this.devices.has(info.deviceId)) continue;
          const label =
            info.label ||
            `Camera ${this.devices.size + 1}`;
          const kind = label.toLowerCase().includes("usb")
            ? CAMERA_KIND.USB
            : label.toLowerCase().includes("virtual")
            ? CAMERA_KIND.VIRTUAL
            : CAMERA_KIND.BUILTIN;

          let facing = CAMERA_FACING.UNKNOWN;
          if (label.toLowerCase().includes("front") || label.toLowerCase().includes("user")) {
            facing = CAMERA_FACING.FRONT;
          } else if (
            label.toLowerCase().includes("back") ||
            label.toLowerCase().includes("rear") ||
            label.toLowerCase().includes("environment")
          ) {
            facing = CAMERA_FACING.BACK;
          }

          const device = new CameraDevice({
            id: info.deviceId,
            label,
            kind,
            facing,
            mediaDeviceInfo: info,
          });
          device.subscribe((event, payload) => {
            this._emit(event, payload);
          });
          this.devices.set(device.id, device);
          this.stats.devicesDetected++;
          this._emit(CAMERA_EVENTS.DEVICE_ADDED, device.snapshot());
        }
      } catch (err) {
        this._log("warn", "enumerateDevices failed", err);
      }
    }

    // Dispositivo virtual (siempre disponible como fallback)
    if (this.includeVirtual && this.devices.size === 0) {
      const device = new CameraDevice({
        id: "virtual-camera",
        label: "Virtual Camera",
        kind: CAMERA_KIND.VIRTUAL,
        facing: CAMERA_FACING.FRONT,
        virtual: true,
        capabilities: {
          width: { min: 320, max: 1920, step: 1 },
          height: { min: 240, max: 1080, step: 1 },
          frameRate: { min: 1, max: 60, step: 1 },
        },
      });
      device.subscribe((event, payload) => {
        this._emit(event, payload);
      });
      this.devices.set(device.id, device);
      this._emit(CAMERA_EVENTS.DEVICE_ADDED, device.snapshot());
    }

    if (!this.selectedDeviceId && this.devices.size > 0) {
      this.selectDevice([...this.devices.keys()][0]);
    }

    return this.listDevices();
  }

  _setupDeviceChangeListener() {
    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", () => {
        this.enumerate();
      });
    }
  }

  // -------------------------------------------------------------- select
  selectDevice(id) {
    const device = this.devices.get(id);
    if (!device) return false;
    this.selectedDeviceId = id;
    this._emit(CAMERA_EVENTS.DEVICE_SELECTED, { deviceId: id });
    return true;
  }

  getSelectedDevice() {
    return this.selectedDeviceId ? this.devices.get(this.selectedDeviceId) : null;
  }

  getDevice(id) {
    return this.devices.get(id) ?? null;
  }

  listDevices() {
    return Array.from(this.devices.values()).map((d) => d.snapshot());
  }

  // -------------------------------------------------------------- sessions
  async createSession({ deviceId = null, width, height, frameRate, facing } = {}) {
    const deviceIdToUse = deviceId || this.selectedDeviceId;
    const device = deviceIdToUse ? this.devices.get(deviceIdToUse) : null;

    const session = new CaptureSession({
      manager: this,
      device,
    });

    session.subscribe((event, payload) => {
      this._emit(event, payload);
      // Contabilizar stats
      if (event === CAMERA_EVENTS.PHOTO_CAPTURED) {
        this.stats.photosCaptured++;
      } else if (event === CAMERA_EVENTS.RECORDING_STOPPED) {
        this.stats.recordingsCompleted++;
      }
    });

    const ok = await session.start({ width, height, frameRate, facing });

    if (ok) {
      this.sessions.set(session.id, session);
      this.stats.sessionsCreated++;
      this._emit(CAMERA_EVENTS.STREAM_STARTED, {
        sessionId: session.id,
        deviceId: device?.id,
      });
      return session;
    } else {
      session.destroy();
      return null;
    }
  }

  getSession(id) {
    return this.sessions.get(id) ?? null;
  }

  listSessions() {
    return Array.from(this.sessions.values()).map((s) => s.snapshot());
  }

  destroySession(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.destroy();
    this.sessions.delete(id);
    this._emit(CAMERA_EVENTS.SESSION_STOPPED, { sessionId: id });
    return true;
  }

  destroyAllSessions() {
    for (const session of this.sessions.values()) {
      session.destroy();
    }
    this.sessions.clear();
  }

  // -------------------------------------------------------------- snapshot
  snapshot() {
    return {
      selectedDeviceId: this.selectedDeviceId,
      devices: this.listDevices(),
      sessions: this.listSessions(),
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// PROVIDER + HOOK
// ============================================================================

const CameraContext = React.createContext(null);

export function CameraProvider({
  children,
  manager: external,
  autoEnumerate = true,
  includeVirtual = true,
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new CameraManager({ autoEnumerate, includeVirtual });
  }
  const manager = ref.current;
  const [snapshot, setSnapshot] = useState(() => manager.snapshot());

  useEffect(() => {
    const unsub = manager.subscribe(() => setSnapshot(manager.snapshot()));
    if (autoEnumerate) manager.enumerate();
    return () => unsub();
  }, [manager, autoEnumerate]);

  const api = useMemo(
    () => ({
      manager,
      snapshot,

      enumerate: () => manager.enumerate(),
      selectDevice: (id) => manager.selectDevice(id),
      getSelectedDevice: () => manager.getSelectedDevice(),
      getDevice: (id) => manager.getDevice(id),
      listDevices: () => manager.listDevices(),

      createSession: (opts) => manager.createSession(opts),
      getSession: (id) => manager.getSession(id),
      listSessions: () => manager.listSessions(),
      destroySession: (id) => manager.destroySession(id),
      destroyAllSessions: () => manager.destroyAllSessions(),
    }),
    [manager, snapshot]
  );

  return (
    <CameraContext.Provider value={api}>{children}</CameraContext.Provider>
  );
}

export function useCamera() {
  const ctx = React.useContext(CameraContext);
  if (!ctx) throw new Error("useCamera must be used within CameraProvider");
  return ctx;
}

export default {
  CameraManager,
  CameraDevice,
  CaptureSession,
  CameraProvider,
  useCamera,
  createVirtualStream,
  CAMERA_FACING,
  CAMERA_KIND,
  CAPTURE_STATE,
  RECORDING_STATE,
  EXPOSURE_MODE,
  FOCUS_MODE,
  WHITE_BALANCE_MODE,
  CAMERA_EFFECT,
  CAMERA_EVENTS,
};
