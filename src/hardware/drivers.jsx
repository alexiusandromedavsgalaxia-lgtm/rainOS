// ============================================================================
// drivers.jsx — Subsistema de drivers de dispositivos
// ----------------------------------------------------------------------------
// Gestor completo de drivers al estilo IOKit (macOS/iOS):
//
//   - Registro de drivers con metadata (id, name, version, vendor, category)
//   - Matching de drivers contra dispositivos detectados
//   - Ciclo de vida: probe → attach → start → stop → detach
//   - Dependencias entre drivers (grafo)
//   - Categorías: display, audio, network, usb, hid, storage, input, power,
//     bluetooth, camera, sensors, misc
//   - IORegistry virtual: árbol de servicios con propiedades
//   - Hot-plug de dispositivos virtuales
//   - Interrupciones (IRQ) simuladas
//   - DMA (Direct Memory Access) simulado
//   - Power management por driver (dormir / despertar)
//   - Estadísticas de uso por driver
//   - Logging integrado con syslogs
//
// FILOSOFÍA
//
//   Cada driver:
//     - Declara qué dispositivos puede manejar (match criterias)
//     - Expone métodos: probe, attach, start, stop, detach, suspend, resume
//     - Puede fallar en cualquier fase y el sistema lo registra
//     - Vive en un IORegistryNode con propiedades observables
//
// USO
//
//   const drivers = new DriverManager({ syslogs, syscalls });
//   drivers.register(VirtualDisplayDriver);
//   drivers.scan(); // detecta devices y los matchea
//   drivers.attachAll();
//   drivers.suspendAll();
//   drivers.resumeAll();
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

export const DRIVER_CATEGORY = Object.freeze({
  DISPLAY: "display",
  AUDIO: "audio",
  NETWORK: "network",
  USB: "usb",
  HID: "hid",
  STORAGE: "storage",
  INPUT: "input",
  POWER: "power",
  BLUETOOTH: "bluetooth",
  CAMERA: "camera",
  SENSOR: "sensor",
  GPU: "gpu",
  CPU: "cpu",
  MISC: "misc",
});

export const DRIVER_STATE = Object.freeze({
  REGISTERED: "registered",
  MATCHED: "matched",
  PROBING: "probing",
  ATTACHED: "attached",
  STARTING: "starting",
  RUNNING: "running",
  STOPPING: "stopping",
  SUSPENDED: "suspended",
  FAILED: "failed",
  DETACHED: "detached",
});

export const DRIVER_EVENTS = Object.freeze({
  DRIVER_REGISTERED: "driver:registered",
  DRIVER_UNREGISTERED: "driver:unregistered",
  DEVICE_DETECTED: "driver:device-detected",
  DEVICE_REMOVED: "driver:device-removed",
  MATCH_FOUND: "driver:match-found",
  PROBE_STARTED: "driver:probe-started",
  PROBE_SUCCEEDED: "driver:probe-succeeded",
  PROBE_FAILED: "driver:probe-failed",
  ATTACHED: "driver:attached",
  STARTED: "driver:started",
  STOPPED: "driver:stopped",
  DETACHED: "driver:detached",
  SUSPENDED: "driver:suspended",
  RESUMED: "driver:resumed",
  IRQ_FIRED: "driver:irq-fired",
  DMA_STARTED: "driver:dma-started",
  DMA_COMPLETED: "driver:dma-completed",
  LOG: "driver:log",
});

// ============================================================================
// IOREGISTRY NODE
// ============================================================================

class IORegistryNode {
  constructor({ name, type = "IORegistryEntry", properties = {} } = {}) {
    this.id = `iorn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.name = name;
    this.type = type;
    this.properties = { ...properties };
    this.children = new Set();
    this.parent = null;
    this.createdAt = Date.now();
    this.refCount = 1;
  }

  addChild(node) {
    node.parent = this;
    this.children.add(node);
    return node;
  }

  removeChild(node) {
    this.children.delete(node);
    node.parent = null;
  }

  setProperty(key, value) {
    this.properties[key] = value;
  }

  getProperty(key) {
    return this.properties[key];
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      properties: { ...this.properties },
      childrenCount: this.children.size,
    };
  }
}

// ============================================================================
// DEVICE (dispositivo detectado)
// ============================================================================

class Device {
  constructor({
    id,
    name,
    category,
    vendor,
    product,
    matchCriterias = {},
    meta = {},
  }) {
    this.id = id || `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.name = name;
    this.category = category;
    this.vendor = vendor ?? "unknown";
    this.product = product ?? "unknown";
    this.matchCriterias = matchCriterias; // { vendorId, productId, category, ... }
    this.meta = meta;
    this.detectedAt = Date.now();
    this.attachedDriver = null;
    this.registryNode = null;
  }

  matches(criteria) {
    if (!criteria) return false;
    for (const [key, value] of Object.entries(criteria)) {
      const devValue = this.matchCriterias[key] ?? this[key];
      if (Array.isArray(value)) {
        if (!value.includes(devValue)) return false;
      } else if (value instanceof RegExp) {
        if (!value.test(String(devValue))) return false;
      } else if (devValue !== value) {
        return false;
      }
    }
    return true;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      category: this.category,
      vendor: this.vendor,
      product: this.product,
      detectedAt: this.detectedAt,
      attachedDriver: this.attachedDriver,
    };
  }
}

// ============================================================================
// DRIVER (clase base)
// ============================================================================

export class Driver {
  constructor({
    id,
    name,
    version = "1.0.0",
    vendor = "RainOS",
    category = DRIVER_CATEGORY.MISC,
    match = {},
    deps = [],
    priority = 100,
    critical = false,
  } = {}) {
    this.id = id;
    this.name = name || id;
    this.version = version;
    this.vendor = vendor;
    this.category = category;
    this.match = match;
    this.deps = deps;
    this.priority = priority;
    this.critical = critical;

    this.state = DRIVER_STATE.REGISTERED;
    this.device = null;
    this.registryNode = null;
    this.attachedAt = null;
    this.startedAt = null;
    this.error = null;

    this.stats = {
      probeCount: 0,
      attachCount: 0,
      startCount: 0,
      irqCount: 0,
      dmaTransfers: 0,
      bytesTransferred: 0,
      errors: 0,
    };

    this.listeners = new Set();
    this.irqHandler = null;
    this.dmaChannels = new Map();
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

  // -------------------------------------------------------------- métodos virtuales
  async probe(device) {
    return { ok: true };
  }

  async attach(device, registry) {
    return { ok: true };
  }

  async start() {
    return { ok: true };
  }

  async stop() {
    return { ok: true };
  }

  async detach() {
    return { ok: true };
  }

  async suspend() {
    return { ok: true };
  }

  async resume() {
    return { ok: true };
  }

  // -------------------------------------------------------------- IRQ / DMA
  setIrqHandler(fn) {
    this.irqHandler = fn;
  }

  fireIrq(number, data) {
    this.stats.irqCount++;
    kernelBus.emit(DRIVER_EVENTS.IRQ_FIRED, {
      driverId: this.id,
      irq: number,
      data,
    });
    this._emit("irq", { number, data });
    if (this.irqHandler) {
      try { this.irqHandler(number, data); } catch {}
    }
  }

  async dmaTransfer(src, dst, bytes, { channel = 0 } = {}) {
    this.stats.dmaTransfers++;
    this.stats.bytesTransferred += bytes;
    this.dmaChannels.set(channel, { busy: true, src, dst, bytes });
    kernelBus.emit(DRIVER_EVENTS.DMA_STARTED, {
      driverId: this.id,
      channel,
      src,
      dst,
      bytes,
    });
    // Simular latencia proporcional al tamaño
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(50, bytes / 1024))));
    this.dmaChannels.set(channel, { busy: false });
    kernelBus.emit(DRIVER_EVENTS.DMA_COMPLETED, {
      driverId: this.id,
      channel,
      bytes,
    });
    this._emit("dma", { channel, src, dst, bytes });
    return { ok: true };
  }

  // -------------------------------------------------------------- stats
  snapshot() {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      vendor: this.vendor,
      category: this.category,
      state: this.state,
      device: this.device?.id ?? null,
      attachedAt: this.attachedAt,
      startedAt: this.startedAt,
      error: this.error,
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// DRIVER MANAGER
// ============================================================================

export class DriverManager {
  constructor({ syslogs = null, syscalls = null } = {}) {
    this.syslogs = syslogs;
    this.syscalls = syscalls;

    this.drivers = new Map();       // id → Driver
    this.devices = new Map();       // id → Device
    this.matches = new Map();       // driverId → deviceId
    this.rootNode = new IORegistryNode({ name: "IODeviceTree", type: "root" });
    this.registry = new Map();      // deviceId → IORegistryNode

    this.listeners = new Set();
    this.suspended = false;

    this.stats = {
      driversRegistered: 0,
      devicesDetected: 0,
      matchesFound: 0,
      attached: 0,
      started: 0,
      failed: 0,
      suspended: 0,
      resumed: 0,
      detached: 0,
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

  _log(level, message, meta) {
    kernelBus.emit(DRIVER_EVENTS.LOG, { ts: Date.now(), level, message, meta });
    this.syslogs?.emit?.(level, "com.rainos.driver", "default", message, meta);
  }

  // -------------------------------------------------------------- registro
  register(driver) {
    if (!(driver instanceof Driver)) {
      throw new Error("register() expects a Driver instance");
    }
    if (this.drivers.has(driver.id)) {
      this._log("warn", `driver already registered: ${driver.id}`);
      return false;
    }
    this.drivers.set(driver.id, driver);
    this.stats.driversRegistered++;

    driver.subscribe((event, payload) => {
      this._emit(event, { driverId: driver.id, ...payload });
    });

    this._emit(DRIVER_EVENTS.DRIVER_REGISTERED, {
      id: driver.id,
      name: driver.name,
      category: driver.category,
    });
    this._log("info", `driver registered: ${driver.id}@${driver.version}`);
    return true;
  }

  unregister(driverId) {
    const driver = this.drivers.get(driverId);
    if (!driver) return false;

    // Detach primero
    if (driver.state === DRIVER_STATE.RUNNING || driver.state === DRIVER_STATE.ATTACHED) {
      driver.detach?.();
    }

    this.drivers.delete(driverId);
    this.matches.delete(driverId);

    this._emit(DRIVER_EVENTS.DRIVER_UNREGISTERED, { id: driverId });
    this._log("info", `driver unregistered: ${driverId}`);
    return true;
  }

  getDriver(id) {
    return this.drivers.get(id) ?? null;
  }

  listDrivers() {
    return Array.from(this.drivers.values()).map((d) => d.snapshot());
  }

  // -------------------------------------------------------------- detección
  detectDevice(device) {
    if (!(device instanceof Device)) {
      throw new Error("detectDevice() expects a Device instance");
    }
    this.devices.set(device.id, device);
    this.stats.devicesDetected++;

    // Crear nodo IORegistry
    const node = new IORegistryNode({
      name: device.name,
      type: `IO${device.category[0].toUpperCase()}${device.category.slice(1)}Device`,
      properties: {
        vendor: device.vendor,
        product: device.product,
        category: device.category,
        ...device.matchCriterias,
      },
    });
    this.rootNode.addChild(node);
    device.registryNode = node;
    this.registry.set(device.id, node);

    this._emit(DRIVER_EVENTS.DEVICE_DETECTED, device.toJSON());
    this._log("info", `device detected: ${device.name} (${device.category})`);
    return node;
  }

  removeDevice(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return false;

    if (device.attachedDriver) {
      const driver = this.drivers.get(device.attachedDriver);
      if (driver) driver.detach?.();
    }

    if (device.registryNode) {
      device.registryNode.parent?.removeChild(device.registryNode);
    }

    this.devices.delete(deviceId);
    this.registry.delete(deviceId);

    this._emit(DRIVER_EVENTS.DEVICE_REMOVED, { id: deviceId });
    this._log("info", `device removed: ${deviceId}`);
    return true;
  }

  listDevices() {
    return Array.from(this.devices.values()).map((d) => d.toJSON());
  }

  // -------------------------------------------------------------- matching
  findMatches(device) {
    const matches = [];
    for (const driver of this.drivers.values()) {
      if (device.matches(driver.match)) {
        matches.push(driver);
      }
    }
    // Ordenar por prioridad (menor número = mayor prioridad)
    matches.sort((a, b) => a.priority - b.priority);
    return matches;
  }

  matchAll() {
    let count = 0;
    for (const device of this.devices.values()) {
      if (device.attachedDriver) continue;
      const matches = this.findMatches(device);
      if (matches.length === 0) continue;
      const driver = matches[0]; // primera prioridad
      this.matches.set(driver.id, device.id);
      this.stats.matchesFound++;
      this._emit(DRIVER_EVENTS.MATCH_FOUND, {
        driverId: driver.id,
        deviceId: device.id,
        others: matches.slice(1).map((d) => d.id),
      });
      count++;
    }
    return count;
  }

  // -------------------------------------------------------------- ciclo de vida
  async attachDriver(driverId) {
    const driver = this.drivers.get(driverId);
    if (!driver) return { ok: false, error: "driver-not-found" };

    const deviceId = this.matches.get(driverId);
    if (!deviceId) return { ok: false, error: "no-match" };
    const device = this.devices.get(deviceId);
    if (!device) return { ok: false, error: "device-not-found" };

    // Dependencias: attach primero
    for (const depId of driver.deps) {
      const dep = this.drivers.get(depId);
      if (!dep) {
        return { ok: false, error: `missing-dep:${depId}` };
      }
      if (dep.state !== DRIVER_STATE.RUNNING && dep.state !== DRIVER_STATE.ATTACHED) {
        const r = await this.attachDriver(depId);
        if (!r.ok) return r;
      }
    }

    driver.state = DRIVER_STATE.PROBING;
    driver.stats.probeCount++;
    this._emit(DRIVER_EVENTS.PROBE_STARTED, { driverId, deviceId });

    let probeResult;
    try {
      probeResult = await driver.probe(device);
    } catch (err) {
      probeResult = { ok: false, error: String(err) };
    }

    if (!probeResult?.ok) {
      driver.state = DRIVER_STATE.FAILED;
      driver.error = probeResult?.error || "probe-failed";
      driver.stats.errors++;
      this.stats.failed++;
      this._emit(DRIVER_EVENTS.PROBE_FAILED, {
        driverId,
        deviceId,
        error: driver.error,
      });
      return { ok: false, error: driver.error };
    }

    this._emit(DRIVER_EVENTS.PROBE_SUCCEEDED, { driverId, deviceId });

    // Attach
    driver.state = DRIVER_STATE.ATTACHED;
    driver.device = device;
    driver.attachedAt = Date.now();
    driver.stats.attachCount++;
    device.attachedDriver = driverId;

    try {
      await driver.attach(device, this);
    } catch (err) {
      driver.state = DRIVER_STATE.FAILED;
      driver.error = String(err);
      driver.stats.errors++;
      this.stats.failed++;
      return { ok: false, error: driver.error };
    }

    this.stats.attached++;
    this._emit(DRIVER_EVENTS.ATTACHED, { driverId, deviceId });

    // Start
    driver.state = DRIVER_STATE.STARTING;
    try {
      await driver.start();
    } catch (err) {
      driver.state = DRIVER_STATE.FAILED;
      driver.error = String(err);
      driver.stats.errors++;
      this.stats.failed++;
      return { ok: false, error: driver.error };
    }

    driver.state = DRIVER_STATE.RUNNING;
    driver.startedAt = Date.now();
    driver.stats.startCount++;
    this.stats.started++;

    this._emit(DRIVER_EVENTS.STARTED, { driverId, deviceId });
    this._log("info", `driver started: ${driverId}`);
    return { ok: true };
  }

  async attachAll() {
    const results = [];
    for (const driverId of this.matches.keys()) {
      const driver = this.drivers.get(driverId);
      if (!driver) continue;
      if (driver.state === DRIVER_STATE.RUNNING) continue;
      results.push({ driverId, ...(await this.attachDriver(driverId)) });
    }
    return results;
  }

  async detachDriver(driverId) {
    const driver = this.drivers.get(driverId);
    if (!driver) return { ok: false, error: "driver-not-found" };

    if (driver.state === DRIVER_STATE.RUNNING || driver.state === DRIVER_STATE.SUSPENDED) {
      driver.state = DRIVER_STATE.STOPPING;
      try { await driver.stop(); } catch {}
      this._emit(DRIVER_EVENTS.STOPPED, { driverId });
    }

    try { await driver.detach(); } catch {}
    driver.state = DRIVER_STATE.DETACHED;
    if (driver.device) driver.device.attachedDriver = null;
    driver.device = null;
    this.stats.detached++;

    this._emit(DRIVER_EVENTS.DETACHED, { driverId });
    this._log("info", `driver detached: ${driverId}`);
    return { ok: true };
  }

  async detachAll() {
    const results = [];
    for (const driverId of this.matches.keys()) {
      results.push({ driverId, ...(await this.detachDriver(driverId)) });
    }
    return results;
  }

  // -------------------------------------------------------------- suspend/resume
  async suspendAll() {
    if (this.suspended) return 0;
    this.suspended = true;
    let count = 0;
    for (const driver of this.drivers.values()) {
      if (driver.state === DRIVER_STATE.RUNNING) {
        try { await driver.suspend(); } catch {}
        driver.state = DRIVER_STATE.SUSPENDED;
        count++;
        this.stats.suspended++;
        this._emit(DRIVER_EVENTS.SUSPENDED, { driverId: driver.id });
      }
    }
    this._log("info", `suspended ${count} drivers`);
    return count;
  }

  async resumeAll() {
    if (!this.suspended) return 0;
    this.suspended = false;
    let count = 0;
    for (const driver of this.drivers.values()) {
      if (driver.state === DRIVER_STATE.SUSPENDED) {
        try { await driver.resume(); } catch {}
        driver.state = DRIVER_STATE.RUNNING;
        count++;
        this.stats.resumed++;
        this._emit(DRIVER_EVENTS.RESUMED, { driverId: driver.id });
      }
    }
    this._log("info", `resumed ${count} drivers`);
    return count;
  }

  // -------------------------------------------------------------- queries
  listByCategory(category) {
    return Array.from(this.drivers.values())
      .filter((d) => d.category === category)
      .map((d) => d.snapshot());
  }

  runningDrivers() {
    return Array.from(this.drivers.values())
      .filter((d) => d.state === DRIVER_STATE.RUNNING)
      .map((d) => d.snapshot());
  }

  failedDrivers() {
    return Array.from(this.drivers.values())
      .filter((d) => d.state === DRIVER_STATE.FAILED)
      .map((d) => d.snapshot());
  }

  registryTree() {
    const walk = (node) => ({
      ...node.toJSON(),
      children: Array.from(node.children).map(walk),
    });
    return walk(this.rootNode);
  }

  snapshot() {
    return {
      drivers: this.drivers.size,
      devices: this.devices.size,
      matches: this.matches.size,
      suspended: this.suspended,
      stats: { ...this.stats },
      byState: {
        registered: Array.from(this.drivers.values()).filter(
          (d) => d.state === DRIVER_STATE.REGISTERED
        ).length,
        matched: Array.from(this.drivers.values()).filter(
          (d) => d.state === DRIVER_STATE.MATCHED
        ).length,
        running: Array.from(this.drivers.values()).filter(
          (d) => d.state === DRIVER_STATE.RUNNING
        ).length,
        suspended: Array.from(this.drivers.values()).filter(
          (d) => d.state === DRIVER_STATE.SUSPENDED
        ).length,
        failed: Array.from(this.drivers.values()).filter(
          (d) => d.state === DRIVER_STATE.FAILED
        ).length,
      },
    };
  }
}

// ============================================================================
// DRIVERS BASE (implementaciones funcionales)
// ============================================================================

// ---------------------------------------------------------------- Display
export class VirtualDisplayDriver extends Driver {
  constructor() {
    super({
      id: "com.rainos.driver.display.virtual",
      name: "Virtual Display",
      version: "1.0.0",
      category: DRIVER_CATEGORY.DISPLAY,
      match: { category: "display" },
      priority: 10,
    });
  }
  async probe(device) {
    return { ok: true, framebuffer: true };
  }
  async start() {
    this.registryNode = new IORegistryNode({
      name: "IODisplay",
      type: "IODisplay",
      properties: {
        width: window.screen.width,
        height: window.screen.height,
        refreshRate: 60,
        dpr: window.devicePixelRatio,
      },
    });
    return { ok: true };
  }
}

// ---------------------------------------------------------------- Audio
export class VirtualAudioDriver extends Driver {
  constructor() {
    super({
      id: "com.rainos.driver.audio.virtual",
      name: "Virtual Audio",
      version: "1.0.0",
      category: DRIVER_CATEGORY.AUDIO,
      match: { category: "audio" },
      priority: 10,
    });
  }
  async probe(device) {
    return { ok: true, hasWebAudio: typeof AudioContext !== "undefined" };
  }
  async start() {
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {}
    return { ok: true };
  }
  async stop() {
    try { this.ctx?.close?.(); } catch {}
    return { ok: true };
  }
}

// ---------------------------------------------------------------- Network
export class VirtualNetworkDriver extends Driver {
  constructor() {
    super({
      id: "com.rainos.driver.network.virtual",
      name: "Virtual Network",
      version: "1.0.0",
      category: DRIVER_CATEGORY.NETWORK,
      match: { category: "network" },
      priority: 10,
    });
  }
  async probe(device) {
    return { ok: true, online: navigator.onLine };
  }
  async start() {
    this.registryNode = new IORegistryNode({
      name: "IONetworkController",
      type: "IONetworkController",
      properties: {
        online: navigator.onLine,
        effectiveType: navigator.connection?.effectiveType,
        downlink: navigator.connection?.downlink,
        rtt: navigator.connection?.rtt,
      },
    });
    return { ok: true };
  }
}

// ---------------------------------------------------------------- HID (keyboard/mouse)
export class VirtualHidDriver extends Driver {
  constructor() {
    super({
      id: "com.rainos.driver.hid.virtual",
      name: "Virtual HID",
      version: "1.0.0",
      category: DRIVER_CATEGORY.HID,
      match: { category: "hid" },
      priority: 10,
    });
  }
  async probe(device) {
    return { ok: true };
  }
  async start() {
    // Registrar listeners de teclado y ratón
    this._onKey = (e) => this.fireIrq(1, { type: "key", code: e.code });
    this._onMouse = (e) => this.fireIrq(12, { type: "mouse", x: e.clientX, y: e.clientY });
    window.addEventListener("keydown", this._onKey);
    window.addEventListener("mousemove", this._onMouse);
    return { ok: true };
  }
  async stop() {
    window.removeEventListener("keydown", this._onKey);
    window.removeEventListener("mousemove", this._onMouse);
    return { ok: true };
  }
}

// ---------------------------------------------------------------- Storage
export class VirtualStorageDriver extends Driver {
  constructor() {
    super({
      id: "com.rainos.driver.storage.virtual",
      name: "Virtual Storage",
      version: "1.0.0",
      category: DRIVER_CATEGORY.STORAGE,
      match: { category: "storage" },
      priority: 10,
    });
  }
  async probe(device) {
    return { ok: true, hasStorageManager: !!navigator.storage };
  }
  async start() {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      this.capacity = est.quota;
      this.usage = est.usage;
    }
    return { ok: true };
  }
}

// ---------------------------------------------------------------- GPU
export class VirtualGpuDriver extends Driver {
  constructor() {
    super({
      id: "com.rainos.driver.gpu.virtual",
      name: "Virtual GPU",
      version: "1.0.0",
      category: DRIVER_CATEGORY.GPU,
      match: { category: "gpu" },
      priority: 5,
    });
  }
  async probe(device) {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("webgl2");
      return { ok: true, webgl: !!gl, webgl2: !!(canvas.getContext("webgl2")) };
    } catch {
      return { ok: false, error: "no-webgl" };
    }
  }
  async start() {
    this.registryNode = new IORegistryNode({
      name: "IOAccelerator",
      type: "IOAccelerator",
      properties: { vendor: "virtual", webgl: true },
    });
    return { ok: true };
  }
}

// ---------------------------------------------------------------- CPU
export class VirtualCpuDriver extends Driver {
  constructor() {
    super({
      id: "com.rainos.driver.cpu.virtual",
      name: "Virtual CPU",
      version: "1.0.0",
      category: DRIVER_CATEGORY.CPU,
      match: { category: "cpu" },
      priority: 0,
      critical: true,
    });
  }
  async probe(device) {
    return { ok: true, cores: navigator.hardwareConcurrency || 4 };
  }
  async start() {
    this.registryNode = new IORegistryNode({
      name: "IOCPU",
      type: "IOCPU",
      properties: {
        cores: navigator.hardwareConcurrency || 4,
        arch: "arm64",
        model: "virtual",
      },
    });
    return { ok: true };
  }
}

// ---------------------------------------------------------------- Power (battery)
export class VirtualPowerDriver extends Driver {
  constructor({ battery = null } = {}) {
    super({
      id: "com.rainos.driver.power.virtual",
      name: "Virtual Power",
      version: "1.0.0",
      category: DRIVER_CATEGORY.POWER,
      match: { category: "power" },
      priority: 5,
      critical: true,
    });
    this.battery = battery;
  }
  async probe(device) {
    return { ok: true, hasBattery: !!this.battery };
  }
  async start() {
    this.registryNode = new IORegistryNode({
      name: "IOPMPowerSource",
      type: "IOPMPowerSource",
      properties: this.battery?.snapshot() ?? {},
    });
    return { ok: true };
  }
}

// ============================================================================
// FÁBRICA DE DRIVERS POR DEFECTO
// ============================================================================

export function createDefaultDrivers({ battery } = {}) {
  return [
    new VirtualCpuDriver(),
    new VirtualGpuDriver(),
    new VirtualDisplayDriver(),
    new VirtualAudioDriver(),
    new VirtualNetworkDriver(),
    new VirtualHidDriver(),
    new VirtualStorageDriver(),
    new VirtualPowerDriver({ battery }),
  ];
}

// ============================================================================
// FÁBRICA DE DEVICES VIRTUALES
// ============================================================================

export function createDefaultDevices() {
  return [
    new Device({
      id: "dev-cpu",
      name: "Virtual CPU",
      category: "cpu",
      vendor: "RainOS",
      product: "Virtual CPU",
      matchCriterias: { category: "cpu" },
    }),
    new Device({
      id: "dev-gpu",
      name: "Virtual GPU",
      category: "gpu",
      vendor: "RainOS",
      product: "Virtual GPU",
      matchCriterias: { category: "gpu" },
    }),
    new Device({
      id: "dev-display-0",
      name: "Main Display",
      category: "display",
      vendor: "RainOS",
      product: "Virtual Display",
      matchCriterias: { category: "display" },
      meta: { primary: true },
    }),
    new Device({
      id: "dev-audio-0",
      name: "Default Output",
      category: "audio",
      vendor: "RainOS",
      product: "Virtual Audio",
      matchCriterias: { category: "audio" },
    }),
    new Device({
      id: "dev-net-0",
      name: "Primary Interface",
      category: "network",
      vendor: "RainOS",
      product: "Virtual Ethernet",
      matchCriterias: { category: "network" },
    }),
    new Device({
      id: "dev-kbd-0",
      name: "Keyboard",
      category: "hid",
      vendor: "RainOS",
      product: "Virtual Keyboard",
      matchCriterias: { category: "hid" },
    }),
    new Device({
      id: "dev-mouse-0",
      name: "Mouse",
      category: "hid",
      vendor: "RainOS",
      product: "Virtual Mouse",
      matchCriterias: { category: "hid" },
    }),
    new Device({
      id: "dev-storage-0",
      name: "System Disk",
      category: "storage",
      vendor: "RainOS",
      product: "Virtual Disk",
      matchCriterias: { category: "storage" },
    }),
    new Device({
      id: "dev-power-0",
      name: "Battery",
      category: "power",
      vendor: "RainOS",
      product: "Virtual Battery",
      matchCriterias: { category: "power" },
    }),
  ];
}

// ============================================================================
// PROVIDER + HOOK
// ============================================================================

const DriversContext = React.createContext(null);

export function DriversProvider({
  children,
  manager: external,
  battery = null,
  syslogs = null,
  autoInit = true,
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new DriverManager({ syslogs });
  }
  const manager = ref.current;

  const [snapshot, setSnapshot] = useState(() => manager.snapshot());

  useEffect(() => {
    const unsub = manager.subscribe(() => setSnapshot(manager.snapshot()));
    if (autoInit) {
      // Registrar drivers por defecto
      if (manager.drivers.size === 0) {
        for (const driver of createDefaultDrivers({ battery })) {
          manager.register(driver);
        }
      }
      // Detectar devices por defecto
      if (manager.devices.size === 0) {
        for (const device of createDefaultDevices()) {
          manager.detectDevice(device);
        }
      }
      // Match y attach
      manager.matchAll();
      manager.attachAll();
    }
    return () => {
      unsub();
      if (autoInit) manager.detachAll();
    };
  }, [manager, autoInit, battery]);

  const api = useMemo(
    () => ({
      manager,
      snapshot,
      register: (d) => manager.register(d),
      unregister: (id) => manager.unregister(id),
      getDriver: (id) => manager.getDriver(id),
      listDrivers: () => manager.listDrivers(),
      detectDevice: (d) => manager.detectDevice(d),
      removeDevice: (id) => manager.removeDevice(id),
      listDevices: () => manager.listDevices(),
      findMatches: (d) => manager.findMatches(d),
      matchAll: () => manager.matchAll(),
      attachDriver: (id) => manager.attachDriver(id),
      attachAll: () => manager.attachAll(),
      detachDriver: (id) => manager.detachDriver(id),
      detachAll: () => manager.detachAll(),
      suspendAll: () => manager.suspendAll(),
      resumeAll: () => manager.resumeAll(),
      listByCategory: (c) => manager.listByCategory(c),
      runningDrivers: () => manager.runningDrivers(),
      failedDrivers: () => manager.failedDrivers(),
      registryTree: () => manager.registryTree(),
    }),
    [manager, snapshot]
  );

  return <DriversContext.Provider value={api}>{children}</DriversContext.Provider>;
}

export function useDrivers() {
  const ctx = React.useContext(DriversContext);
  if (!ctx) throw new Error("useDrivers must be used within DriversProvider");
  return ctx;
}

export default {
  Driver,
  DriverManager,
  DriversProvider,
  useDrivers,
  Device,
  IORegistryNode,
  createDefaultDrivers,
  createDefaultDevices,
  DRIVER_CATEGORY,
  DRIVER_STATE,
  DRIVER_EVENTS,
  VirtualDisplayDriver,
  VirtualAudioDriver,
  VirtualNetworkDriver,
  VirtualHidDriver,
  VirtualStorageDriver,
  VirtualGpuDriver,
  VirtualCpuDriver,
  VirtualPowerDriver,
};
