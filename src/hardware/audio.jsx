// ============================================================================
// audio.jsx — Subsistema de audio (CoreAudio-style)
// ----------------------------------------------------------------------------
// Modela toda la cadena de audio desde el decoder hasta el dispositivo físico:
//
//   - AudioManager: enruta audio entre apps y dispositivos
//   - AudioDevice: cada dispositivo (altavoces, auriculares, AirPlay, BT)
//   - AudioChannel: cada canal (una app, un stream)
//   - AudioStream: stream de audio activo con buffer y stats
//   - Mixer: mezcla varios canales en un solo stream maestro
//   - DSP: filtros, EQ, reverb, compressor, limiter
//   - Metering: niveles RMS y pico en tiempo real
//   - Routing: cambio de dispositivo por app
//   - Spatial audio: pan estéreo, 3D con Web Audio PannerNode
//
// INTEGRACIÓN
//
//   - Web Audio API: AudioContext real
//   - decodeAudioData: decodificación MP3/WAV/OGG/M4A
//   - AnalyserNode: FFT real para visualizador
//   - GainNode: control de volumen
//   - BiquadFilterNode: EQ de 10 bandas
//   - ConvolverNode: reverb
//   - DynamicsCompressorNode: compressor/limiter
//   - PannerNode: spatial audio
//
// EVENTOS
//
//   - device:added, device:removed, device:changed
//   - channel:created, channel:destroyed
//   - stream:started, stream:ended, stream:error
//   - volume:changed, mute:changed
//   - metering:update
//   - route:changed
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

export const AUDIO_DEVICE_KIND = Object.freeze({
  BUILTIN_SPEAKER: "builtin-speaker",
  BUILTIN_MIC: "builtin-mic",
  HEADPHONES: "headphones",
  BLUETOOTH: "bluetooth",
  AIRPLAY: "airplay",
  USB_AUDIO: "usb-audio",
  HDMI: "hdmi",
  VIRTUAL: "virtual",
});

export const AUDIO_STATE = Object.freeze({
  OFFLINE: "offline",
  READY: "ready",
  RUNNING: "running",
  SUSPENDED: "suspended",
  FAILED: "failed",
});

export const AUDIO_EVENTS = Object.freeze({
  MANAGER_STARTED: "audio:manager-started",
  MANAGER_STOPPED: "audio:manager-stopped",
  DEVICE_ADDED: "audio:device-added",
  DEVICE_REMOVED: "audio:device-removed",
  DEVICE_CHANGED: "audio:device-changed",
  DEFAULT_OUTPUT_CHANGED: "audio:default-output-changed",
  DEFAULT_INPUT_CHANGED: "audio:default-input-changed",
  CHANNEL_CREATED: "audio:channel-created",
  CHANNEL_DESTROYED: "audio:channel-destroyed",
  STREAM_STARTED: "audio:stream-started",
  STREAM_ENDED: "audio:stream-ended",
  STREAM_PAUSED: "audio:stream-paused",
  STREAM_RESUMED: "audio:stream-resumed",
  STREAM_ERROR: "audio:stream-error",
  VOLUME_CHANGED: "audio:volume-changed",
  MUTE_CHANGED: "audio:mute-changed",
  ROUTE_CHANGED: "audio:route-changed",
  METERING_UPDATE: "audio:metering-update",
  CONTEXT_STATE_CHANGED: "audio:context-state",
  LOG: "audio:log",
});

export const AUDIO_DEFAULTS = Object.freeze({
  sampleRate: 48000,
  channels: 2,
  latencyHint: "interactive", // "interactive" | "balanced" | "playback"
  fftSize: 2048,
  smoothingTimeConstant: 0.8,
});

// ============================================================================
// LOGGER
// ============================================================================

class AudioLog {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(AUDIO_EVENTS.LOG, e);
  }
  info(m, x) { this.push("info", m, x); }
  warn(m, x) { this.push("warn", m, x); }
  error(m, x) { this.push("error", m, x); }
  all() { return [...this.entries]; }
}

// ============================================================================
// AUDIO DEVICE
// ============================================================================

class AudioDevice {
  constructor({
    id,
    name,
    kind,
    isInput = false,
    isOutput = true,
    isDefault = false,
    manufacturer = "RainOS",
    model = "Virtual Audio",
    sampleRate = 48000,
    channels = 2,
    latencyMs = 20,
    volume = 1,
    muted = false,
    spatialAudio = false,
  }) {
    this.id = id;
    this.name = name;
    this.kind = kind;
    this.isInput = isInput;
    this.isOutput = isOutput;
    this.isDefault = isDefault;
    this.manufacturer = manufacturer;
    this.model = model;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.latencyMs = latencyMs;
    this.volume = volume;
    this.muted = muted;
    this.spatialAudio = spatialAudio;
    this.connectedAt = Date.now();
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(event, payload) {
    for (const fn of this.listeners) {
      try { fn(event, payload); } catch {}
    }
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this._emit(AUDIO_EVENTS.VOLUME_CHANGED, { volume: this.volume });
  }

  setMuted(m) {
    this.muted = !!m;
    this._emit(AUDIO_EVENTS.MUTE_CHANGED, { muted: this.muted });
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      isInput: this.isInput,
      isOutput: this.isOutput,
      isDefault: this.isDefault,
      manufacturer: this.manufacturer,
      model: this.model,
      sampleRate: this.sampleRate,
      channels: this.channels,
      latencyMs: this.latencyMs,
      volume: this.volume,
      muted: this.muted,
      spatialAudio: this.spatialAudio,
      connectedAt: this.connectedAt,
    };
  }
}

// ============================================================================
// AUDIO CHANNEL (una app reproduciendo)
// ============================================================================

let _channelCounter = 0;

class AudioChannel {
  constructor({ name, appId = null, routeTo = null, gain = 1, muted = false }) {
    this.id = `ch-${++_channelCounter}`;
    this.name = name;
    this.appId = appId;
    this.routeTo = routeTo; // device id o null = default
    this.gain = gain;
    this.muted = muted;
    this.pan = 0;
    this.createdAt = Date.now();

    // Nodos Web Audio
    this.gainNode = null;
    this.pannerNode = null;
    this.analyserNode = null;
    this.sourceNode = null;

    // Estado
    this.playing = false;
    this.paused = false;
    this.duration = 0;
    this.currentTime = 0;
    this.buffer = null;

    // Metering
    this.metering = {
      rms: 0,
      peak: 0,
      left: 0,
      right: 0,
    };

    this.stats = {
      bytesDecoded: 0,
      secondsPlayed: 0,
      startCount: 0,
      errorCount: 0,
    };

    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(event, payload) {
    for (const fn of this.listeners) {
      try { fn(event, payload); } catch {}
    }
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      appId: this.appId,
      routeTo: this.routeTo,
      gain: this.gain,
      muted: this.muted,
      pan: this.pan,
      playing: this.playing,
      paused: this.paused,
      duration: this.duration,
      currentTime: this.currentTime,
      metering: { ...this.metering },
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// DSP CHAIN (EQ, compresor, reverb, limiter)
// ============================================================================

export class DspChain {
  constructor(ctx) {
    this.ctx = ctx;
    this.eq = [];
    this.compressor = null;
    this.limiter = null;
    this.reverb = null;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this._build();
  }

  _build() {
    const ctx = this.ctx;

    // EQ de 10 bandas
    const freqs = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    for (const f of freqs) {
      const filter = ctx.createBiquadFilter();
      filter.type = "peaking";
      filter.frequency.value = f;
      filter.Q.value = 1.0;
      filter.gain.value = 0;
      this.eq.push(filter);
    }

    // Compresor
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -24;
    this.compressor.knee.value = 30;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;

    // Limiter (otro compresor muy agresivo)
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.05;

    // Cadena: input → eq[0..n] → compressor → limiter → output
    let prev = this.input;
    for (const filter of this.eq) {
      prev.connect(filter);
      prev = filter;
    }
    prev.connect(this.compressor);
    this.compressor.connect(this.limiter);
    this.limiter.connect(this.output);
  }

  setEqBand(index, gainDb) {
    if (this.eq[index]) {
      this.eq[index].gain.value = Math.max(-12, Math.min(12, gainDb));
    }
  }

  setCompressor({ threshold, ratio, attack, release, knee }) {
    if (threshold != null) this.compressor.threshold.value = threshold;
    if (ratio != null) this.compressor.ratio.value = ratio;
    if (attack != null) this.compressor.attack.value = attack;
    if (release != null) this.compressor.release.value = release;
    if (knee != null) this.compressor.knee.value = knee;
  }

  get eqBands() {
    return this.eq.map((f) => ({
      freq: f.frequency.value,
      gain: f.gain.value,
      q: f.Q.value,
    }));
  }
}

// ============================================================================
// AUDIO MANAGER
// ============================================================================

export class AudioManager {
  constructor(options = {}) {
    this.options = { ...AUDIO_DEFAULTS, ...options };
    this.state = AUDIO_STATE.OFFLINE;
    this.log = new AudioLog();

    this.ctx = null;
    this.masterGain = null;
    this.masterAnalyser = null;
    this.dsp = null;

    this.devices = new Map();
    this.defaultOutputId = null;
    this.defaultInputId = null;
    this.channels = new Map();

    this.volume = 0.7;
    this.muted = false;

    this.listeners = new Set();
    this._meteringHandle = null;
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
    kernelBus.emit(AUDIO_EVENTS.LOG, { ts: Date.now(), level, message, meta });
  }

  // -------------------------------------------------------------- init
  init() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      this.state = AUDIO_STATE.FAILED;
      this._log("error", "Web Audio API no disponible");
      return null;
    }
    this.ctx = new AC({
      sampleRate: this.options.sampleRate,
      latencyHint: this.options.latencyHint,
    });

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.volume;

    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = this.options.fftSize;
    this.masterAnalyser.smoothingTimeConstant = this.options.smoothingTimeConstant;

    this.dsp = new DspChain(this.ctx);
    this.dsp.output.connect(this.masterGain);
    this.masterGain.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.ctx.destination);

    this.state = AUDIO_STATE.READY;
    this._emit(AUDIO_EVENTS.MANAGER_STARTED, {});
    this._emit(AUDIO_EVENTS.CONTEXT_STATE_CHANGED, { state: this.ctx.state });
    this._log("info", "audio manager initialized", {
      sampleRate: this.ctx.sampleRate,
      state: this.ctx.state,
    });

    // Monitor de metering
    this._startMeteringLoop();

    return this.ctx;
  }

  async resume() {
    if (!this.ctx) this.init();
    if (this.ctx?.state === "suspended") {
      try {
        await this.ctx.resume();
        this.state = AUDIO_STATE.RUNNING;
        this._emit(AUDIO_EVENTS.CONTEXT_STATE_CHANGED, { state: this.ctx.state });
      } catch (err) {
        this._log("error", "resume failed", err);
      }
    }
  }

  async suspend() {
    if (this.ctx?.state === "running") {
      try {
        await this.ctx.suspend();
        this.state = AUDIO_STATE.SUSPENDED;
        this._emit(AUDIO_EVENTS.CONTEXT_STATE_CHANGED, { state: this.ctx.state });
      } catch (err) {
        this._log("error", "suspend failed", err);
      }
    }
  }

  // -------------------------------------------------------------- dispositivos
  addDevice(opts) {
    const device = new AudioDevice(opts);
    device.subscribe((event, payload) => {
      this._emit(event, { deviceId: device.id, ...payload });
    });
    this.devices.set(device.id, device);
    if (device.isDefault && device.isOutput) this.defaultOutputId = device.id;
    if (device.isDefault && device.isInput) this.defaultInputId = device.id;
    if (!this.defaultOutputId && device.isOutput) this.defaultOutputId = device.id;
    if (!this.defaultInputId && device.isInput) this.defaultInputId = device.id;
    this._emit(AUDIO_EVENTS.DEVICE_ADDED, device.snapshot());
    this._log("info", `device added: ${device.name} (${device.kind})`);
    return device;
  }

  removeDevice(id) {
    const device = this.devices.get(id);
    if (!device) return false;
    this.devices.delete(id);
    if (this.defaultOutputId === id) {
      this.defaultOutputId = this.listOutputs()[0]?.id ?? null;
      this._emit(AUDIO_EVENTS.DEFAULT_OUTPUT_CHANGED, { id: this.defaultOutputId });
    }
    if (this.defaultInputId === id) {
      this.defaultInputId = this.listInputs()[0]?.id ?? null;
      this._emit(AUDIO_EVENTS.DEFAULT_INPUT_CHANGED, { id: this.defaultInputId });
    }
    this._emit(AUDIO_EVENTS.DEVICE_REMOVED, { deviceId: id });
    this._log("info", `device removed: ${id}`);
    return true;
  }

  getDevice(id) {
    return this.devices.get(id) ?? null;
  }

  listDevices() {
    return Array.from(this.devices.values()).map((d) => d.snapshot());
  }

  listOutputs() {
    return Array.from(this.devices.values()).filter((d) => d.isOutput);
  }

  listInputs() {
    return Array.from(this.devices.values()).filter((d) => d.isInput);
  }

  getDefaultOutput() {
    return this.defaultOutputId ? this.getDevice(this.defaultOutputId) : null;
  }

  getDefaultInput() {
    return this.defaultInputId ? this.getDevice(this.defaultInputId) : null;
  }

  setDefaultOutput(id) {
    const d = this.getDevice(id);
    if (!d || !d.isOutput) return false;
    this.defaultOutputId = id;
    this._emit(AUDIO_EVENTS.DEFAULT_OUTPUT_CHANGED, { id });
    return true;
  }

  setDefaultInput(id) {
    const d = this.getDevice(id);
    if (!d || !d.isInput) return false;
    this.defaultInputId = id;
    this._emit(AUDIO_EVENTS.DEFAULT_INPUT_CHANGED, { id });
    return true;
  }

  // -------------------------------------------------------------- volumen maestro
  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.masterGain) this.masterGain.gain.value = this.volume;
    this._emit(AUDIO_EVENTS.VOLUME_CHANGED, { volume: this.volume });
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.masterGain) this.masterGain.gain.value = this.muted ? 0 : this.volume;
    this._emit(AUDIO_EVENTS.MUTE_CHANGED, { muted: this.muted });
  }

  // -------------------------------------------------------------- canales
  createChannel({ name, appId = null, routeTo = null, gain = 1, muted = false }) {
    if (!this.ctx) this.init();
    const ch = new AudioChannel({ name, appId, routeTo, gain, muted });
    if (this.ctx) {
      ch.gainNode = this.ctx.createGain();
      ch.gainNode.gain.value = ch.muted ? 0 : ch.gain;
      ch.pannerNode = this.ctx.createStereoPanner();
      ch.pannerNode.pan.value = ch.pan;
      ch.analyserNode = this.ctx.createAnalyser();
      ch.analyserNode.fftSize = this.options.fftSize;

      ch.gainNode.connect(ch.pannerNode);
      ch.pannerNode.connect(ch.analyserNode);
      ch.analyserNode.connect(this.dsp.input);
    }
    this.channels.set(ch.id, ch);
    this._emit(AUDIO_EVENTS.CHANNEL_CREATED, ch.snapshot());
    this._log("info", `channel created: ${ch.name}`);
    return ch;
  }

  destroyChannel(id) {
    const ch = this.channels.get(id);
    if (!ch) return false;
    try { ch.sourceNode?.stop?.(); } catch {}
    try { ch.gainNode?.disconnect?.(); } catch {}
    try { ch.pannerNode?.disconnect?.(); } catch {}
    try { ch.analyserNode?.disconnect?.(); } catch {}
    this.channels.delete(id);
    this._emit(AUDIO_EVENTS.CHANNEL_DESTROYED, { channelId: id });
    this._log("info", `channel destroyed: ${id}`);
    return true;
  }

  getChannel(id) {
    return this.channels.get(id) ?? null;
  }

  listChannels() {
    return Array.from(this.channels.values()).map((c) => c.snapshot());
  }

  // -------------------------------------------------------------- decode & play
  async decode(buffer) {
    if (!this.ctx) this.init();
    try {
      const audioBuffer = await this.ctx.decodeAudioData(
        buffer instanceof ArrayBuffer ? buffer : await buffer.arrayBuffer()
      );
      return audioBuffer;
    } catch (err) {
      this._log("error", "decode failed", err);
      throw err;
    }
  }

  async decodeFromUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arrayBuf = await res.arrayBuffer();
    return this.decode(arrayBuf);
  }

  async playBuffer(channel, audioBuffer, { offset = 0 } = {}) {
    if (!this.ctx) this.init();
    if (!channel) throw new Error("channel required");
    try { channel.sourceNode?.stop?.(); } catch {}

    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(channel.gainNode);
    source.onended = () => {
      channel.playing = false;
      channel._emit(AUDIO_EVENTS.STREAM_ENDED, { channelId: channel.id });
      this._emit(AUDIO_EVENTS.STREAM_ENDED, { channelId: channel.id });
    };
    source.start(0, offset);
    channel.sourceNode = source;
    channel.buffer = audioBuffer;
    channel.duration = audioBuffer.duration;
    channel.currentTime = offset;
    channel.playing = true;
    channel.paused = false;
    channel.stats.startCount++;
    this._emit(AUDIO_EVENTS.STREAM_STARTED, { channelId: channel.id });
    return source;
  }

  stopChannel(channelId) {
    const ch = this.channels.get(channelId);
    if (!ch) return false;
    try { ch.sourceNode?.stop?.(); } catch {}
    ch.playing = false;
    ch.paused = false;
    ch.currentTime = 0;
    this._emit(AUDIO_EVENTS.STREAM_ENDED, { channelId });
    return true;
  }

  pauseChannel(channelId) {
    const ch = this.channels.get(channelId);
    if (!ch || !ch.playing) return false;
    // Web Audio API no soporta pause real; guardamos offset y paramos
    ch._pausedAt = ch.currentTime;
    try { ch.sourceNode?.stop?.(); } catch {}
    ch.playing = false;
    ch.paused = true;
    this._emit(AUDIO_EVENTS.STREAM_PAUSED, { channelId });
    return true;
  }

  async resumeChannel(channelId) {
    const ch = this.channels.get(channelId);
    if (!ch || !ch.paused || !ch.buffer) return false;
    await this.playBuffer(ch, ch.buffer, { offset: ch._pausedAt || 0 });
    this._emit(AUDIO_EVENTS.STREAM_RESUMED, { channelId });
    return true;
  }

  // -------------------------------------------------------------- DSP helpers
  setEqBand(index, gainDb) {
    if (this.dsp) this.dsp.setEqBand(index, gainDb);
  }

  setCompressor(opts) {
    if (this.dsp) this.dsp.setCompressor(opts);
  }

  // -------------------------------------------------------------- metering
  getMasterAnalyser() {
    return this.masterAnalyser;
  }

  getSpectrum() {
    if (!this.masterAnalyser) return null;
    const data = new Uint8Array(this.masterAnalyser.frequencyBinCount);
    this.masterAnalyser.getByteFrequencyData(data);
    return data;
  }

  getWaveform() {
    if (!this.masterAnalyser) return null;
    const data = new Uint8Array(this.masterAnalyser.fftSize);
    this.masterAnalyser.getByteTimeDomainData(data);
    return data;
  }

  _startMeteringLoop() {
    if (this._meteringHandle) return;
    const tick = () => {
      if (!this.masterAnalyser) return;
      const data = new Uint8Array(this.masterAnalyser.frequencyBinCount);
      this.masterAnalyser.getByteFrequencyData(data);
      let sum = 0, peak = 0;
      for (let i = 0; i < data.length; i++) {
        sum += data[i] * data[i];
        if (data[i] > peak) peak = data[i];
      }
      const rms = Math.sqrt(sum / data.length) / 255;
      this._emit(AUDIO_EVENTS.METERING_UPDATE, {
        rms,
        peak: peak / 255,
      });
      this._meteringHandle = requestAnimationFrame(tick);
    };
    this._meteringHandle = requestAnimationFrame(tick);
  }

  // -------------------------------------------------------------- snapshot
  snapshot() {
    return {
      state: this.state,
      contextState: this.ctx?.state ?? "closed",
      sampleRate: this.ctx?.sampleRate ?? null,
      volume: this.volume,
      muted: this.muted,
      devices: this.listDevices(),
      defaultOutputId: this.defaultOutputId,
      defaultInputId: this.defaultInputId,
      channels: this.listChannels(),
      eq: this.dsp?.eqBands ?? [],
    };
  }
}

// ============================================================================
// FÁBRICA DE DISPOSITIVOS POR DEFECTO
// ============================================================================

export function createDefaultAudioDevices() {
  return [
    {
      id: "audio-builtin-speaker",
      name: "Altavoces internos",
      kind: AUDIO_DEVICE_KIND.BUILTIN_SPEAKER,
      isOutput: true,
      isDefault: true,
      manufacturer: "RainOS",
      model: "Virtual Speaker",
    },
    {
      id: "audio-builtin-mic",
      name: "Micrófono interno",
      kind: AUDIO_DEVICE_KIND.BUILTIN_MIC,
      isInput: true,
      isOutput: false,
      isDefault: true,
      manufacturer: "RainOS",
      model: "Virtual Microphone",
    },
    {
      id: "audio-headphones",
      name: "Auriculares",
      kind: AUDIO_DEVICE_KIND.HEADPHONES,
      isOutput: true,
      isDefault: false,
      manufacturer: "RainOS",
      model: "Virtual Headphones",
    },
    {
      id: "audio-airplay",
      name: "AirPlay",
      kind: AUDIO_DEVICE_KIND.AIRPLAY,
      isOutput: true,
      isDefault: false,
      manufacturer: "Apple",
      model: "AirPlay",
    },
    {
      id: "audio-bluetooth",
      name: "Bluetooth Audio",
      kind: AUDIO_DEVICE_KIND.BLUETOOTH,
      isOutput: true,
      isDefault: false,
      manufacturer: "RainOS",
      model: "Virtual BT",
    },
  ];
}

// ============================================================================
// PROVIDER + HOOK
// ============================================================================

const AudioContext2 = React.createContext(null);

export function AudioProvider({
  children,
  manager: external,
  autoInit = true,
  autoCreateDevices = true,
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new AudioManager();
    if (autoCreateDevices && ref.current.devices.size === 0) {
      for (const opts of createDefaultAudioDevices()) {
        ref.current.addDevice(opts);
      }
    }
  }
  const manager = ref.current;
  const [snapshot, setSnapshot] = useState(() => manager.snapshot());

  useEffect(() => {
    const unsub = manager.subscribe(() => setSnapshot(manager.snapshot()));
    if (autoInit) manager.init();
    return () => unsub();
  }, [manager, autoInit]);

  const api = useMemo(
    () => ({
      manager,
      snapshot,
      init: () => manager.init(),
      resume: () => manager.resume(),
      suspend: () => manager.suspend(),

      addDevice: (opts) => manager.addDevice(opts),
      removeDevice: (id) => manager.removeDevice(id),
      getDevice: (id) => manager.getDevice(id),
      listDevices: () => manager.listDevices(),
      listOutputs: () => manager.listOutputs(),
      listInputs: () => manager.listInputs(),
      getDefaultOutput: () => manager.getDefaultOutput(),
      getDefaultInput: () => manager.getDefaultInput(),
      setDefaultOutput: (id) => manager.setDefaultOutput(id),
      setDefaultInput: (id) => manager.setDefaultInput(id),

      setVolume: (v) => manager.setVolume(v),
      setMuted: (m) => manager.setMuted(m),

      createChannel: (opts) => manager.createChannel(opts),
      destroyChannel: (id) => manager.destroyChannel(id),
      getChannel: (id) => manager.getChannel(id),
      listChannels: () => manager.listChannels(),

      decode: (buffer) => manager.decode(buffer),
      decodeFromUrl: (url) => manager.decodeFromUrl(url),
      playBuffer: (ch, buf, opts) => manager.playBuffer(ch, buf, opts),
      stopChannel: (id) => manager.stopChannel(id),
      pauseChannel: (id) => manager.pauseChannel(id),
      resumeChannel: (id) => manager.resumeChannel(id),

      setEqBand: (i, g) => manager.setEqBand(i, g),
      setCompressor: (o) => manager.setCompressor(o),

      getSpectrum: () => manager.getSpectrum(),
      getWaveform: () => manager.getWaveform(),
      getMasterAnalyser: () => manager.getMasterAnalyser(),
    }),
    [manager, snapshot]
  );

  return (
    <AudioContext2.Provider value={api}>{children}</AudioContext2.Provider>
  );
}

export function useAudio() {
  const ctx = React.useContext(AudioContext2);
  if (!ctx) throw new Error("useAudio must be used within AudioProvider");
  return ctx;
}

export default {
  AudioManager,
  AudioDevice,
  AudioChannel,
  DspChain,
  AudioProvider,
  useAudio,
  createDefaultAudioDevices,
  AUDIO_DEVICE_KIND,
  AUDIO_STATE,
  AUDIO_EVENTS,
  AUDIO_DEFAULTS,
};
