// ============================================================================
// usb.jsx — Subsistema USB completo
// ----------------------------------------------------------------------------
// Modela toda la pila USB, desde el bus hasta las transferencias:
//
//   - UsbBus: el bus USB (host controller)
//   - UsbHub: hubs (raíz y externos)
//   - UsbDevice: dispositivos (teclados, ratones, discos, cámaras...)
//   - UsbConfiguration: configuraciones alternativas
//   - UsbInterface: interfaces dentro de un dispositivo
//   - UsbEndpoint: endpoints (IN/OUT, Control/Bulk/Interrupt/Isochronous)
//   - Transferencias: control, bulk, interrupt, isochronous
//   - Descriptores: device, config, interface, endpoint, string, HID, MSC
//   - Hot-plug: attach/detach en caliente
//   - Power management: suspend/resume, remote wakeup
//   - Enumeración: GET_DESCRIPTOR, SET_ADDRESS, SET_CONFIGURATION
//   - Clases USB: HID, Mass Storage, Audio, Video, Printer, CDC, Hub
//   - Integración con navigator.usb (WebUSB) cuando está disponible
//
// EVENTOS
//
//   - bus:started, bus:stopped
//   - device:attached, device:detached, device:enumerated, device:error
//   - transfer:submitted, transfer:completed, transfer:failed
//   - interface:claimed, interface:released
//   - power:suspend, power:resume
//   - hotplug:change
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

export const USB_SPEED = Object.freeze({
  LOW: "low",           // 1.5 Mbps (USB 1.0)
  FULL: "full",         // 12 Mbps (USB 1.1)
  HIGH: "high",         // 480 Mbps (USB 2.0)
  SUPER: "super",       // 5 Gbps (USB 3.0)
  SUPER_PLUS: "super+", // 10 Gbps (USB 3.1)
  SUPER_PLUS_20: "super++", // 20 Gbps (USB 3.2)
});

export const USB_SPEED_MBPS = Object.freeze({
  low: 1.5,
  full: 12,
  high: 480,
  super: 5000,
  "super+": 10000,
  "super++": 20000,
});

export const USB_CLASS = Object.freeze({
  PER_INTERFACE: 0x00,
  AUDIO: 0x01,
  CDC_COMM: 0x02,
  HID: 0x03,
  PHYSICAL: 0x05,
  IMAGE: 0x06,
  PRINTER: 0x07,
  MASS_STORAGE: 0x08,
  HUB: 0x09,
  CDC_DATA: 0x0a,
  SMART_CARD: 0x0b,
  CONTENT_SECURITY: 0x0d,
  VIDEO: 0x0e,
  PERSONAL_HEALTHCARE: 0x0f,
  AUDIO_VIDEO: 0x10,
  BILLBOARD: 0x11,
  USB_C_BRIDGE: 0x12,
  DIAGNOSTIC: 0xdc,
  WIRELESS: 0xe0,
  MISCELLANEOUS: 0xef,
  APPLICATION_SPECIFIC: 0xfe,
  VENDOR_SPECIFIC: 0xff,
});

export const USB_TRANSFER_TYPE = Object.freeze({
  CONTROL: "control",
  ISOCHRONOUS: "isochronous",
  BULK: "bulk",
  INTERRUPT: "interrupt",
});

export const USB_DIRECTION = Object.freeze({
  IN: "in",   // device → host
  OUT: "out", // host → device
});

export const USB_STATE = Object.freeze({
  DETACHED: "detached",
  ATTACHED: "attached",
  POWERED: "powered",
  DEFAULT: "default",
  ADDRESSED: "addressed",
  CONFIGURED: "configured",
  SUSPENDED: "suspended",
  ERROR: "error",
});

export const USB_EVENTS = Object.freeze({
  BUS_STARTED: "usb:bus-started",
  BUS_STOPPED: "usb:bus-stopped",
  HUB_ADDED: "usb:hub-added",
  HUB_REMOVED: "usb:hub-removed",
  DEVICE_ATTACHED: "usb:device-attached",
  DEVICE_DETACHED: "usb:device-detached",
  DEVICE_ENUMERATED: "usb:device-enumerated",
  DEVICE_STATE_CHANGED: "usb:device-state-changed",
  DEVICE_ERROR: "usb:device-error",
  CONFIGURATION_SET: "usb:configuration-set",
  INTERFACE_CLAIMED: "usb:interface-claimed",
  INTERFACE_RELEASED: "usb:interface-released",
  ENDPOINT_OPENED: "usb:endpoint-opened",
  ENDPOINT_CLOSED: "usb:endpoint-closed",
  TRANSFER_SUBMITTED: "usb:transfer-submitted",
  TRANSFER_PROGRESS: "usb:transfer-progress",
  TRANSFER_COMPLETED: "usb:transfer-completed",
  TRANSFER_FAILED: "usb:transfer-failed",
  POWER_SUSPEND: "usb:power-suspend",
  POWER_RESUME: "usb:power-resume",
  HOTPLUG_CHANGE: "usb:hotplug-change",
  ENUMERATION_STEP: "usb:enumeration-step",
  LOG: "usb:log",
});

// ============================================================================
// LOGGER
// ============================================================================

class UsbLog {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(USB_EVENTS.LOG, e);
  }
  info(m, x) { this.push("info", m, x); }
  warn(m, x) { this.push("warn", m, x); }
  error(m, x) { this.push("error", m, x); }
  all() { return [...this.entries]; }
}

// ============================================================================
// DESCRIPTORES
// ----------------------------------------------------------------------------
// Formato estándar USB 2.0 / 3.x
// ============================================================================

export class UsbDeviceDescriptor {
  constructor({
    bLength = 18,
    bDescriptorType = 0x01,
    bcdUSB = 0x0200,
    bDeviceClass = 0,
    bDeviceSubClass = 0,
    bDeviceProtocol = 0,
    bMaxPacketSize0 = 64,
    idVendor = 0,
    idProduct = 0,
    bcdDevice = 0x0100,
    iManufacturer = 1,
    iProduct = 2,
    iSerialNumber = 3,
    bNumConfigurations = 1,
  } = {}) {
    this.bLength = bLength;
    this.bDescriptorType = bDescriptorType;
    this.bcdUSB = bcdUSB;
    this.bDeviceClass = bDeviceClass;
    this.bDeviceSubClass = bDeviceSubClass;
    this.bDeviceProtocol = bDeviceProtocol;
    this.bMaxPacketSize0 = bMaxPacketSize0;
    this.idVendor = idVendor;
    this.idProduct = idProduct;
    this.bcdDevice = bcdDevice;
    this.iManufacturer = iManufacturer;
    this.iProduct = iProduct;
    this.iSerialNumber = iSerialNumber;
    this.bNumConfigurations = bNumConfigurations;
  }

  get vendorHex() {
    return "0x" + this.idVendor.toString(16).padStart(4, "0");
  }

  get productHex() {
    return "0x" + this.idProduct.toString(16).padStart(4, "0");
  }

  toJSON() {
    return {
      bLength: this.bLength,
      bDescriptorType: this.bDescriptorType,
      bcdUSB: `0x${this.bcdUSB.toString(16).padStart(4, "0")}`,
      bDeviceClass: this.bDeviceClass,
      bMaxPacketSize0: this.bMaxPacketSize0,
      idVendor: this.vendorHex,
      idProduct: this.productHex,
      bcdDevice: `0x${this.bcdDevice.toString(16).padStart(4, "0")}`,
      bNumConfigurations: this.bNumConfigurations,
    };
  }
}

export class UsbEndpointDescriptor {
  constructor({
    bLength = 7,
    bDescriptorType = 0x05,
    bEndpointAddress = 0x00,
    bmAttributes = 0x00,
    wMaxPacketSize = 64,
    bInterval = 0,
  } = {}) {
    this.bLength = bLength;
    this.bDescriptorType = bDescriptorType;
    this.bEndpointAddress = bEndpointAddress;
    this.bmAttributes = bmAttributes;
    this.wMaxPacketSize = wMaxPacketSize;
    this.bInterval = bInterval;
  }

  get number() {
    return this.bEndpointAddress & 0x0f;
  }

  get direction() {
    return (this.bEndpointAddress & 0x80) === 0x80
      ? USB_DIRECTION.IN
      : USB_DIRECTION.OUT;
  }

  get transferType() {
    const type = this.bmAttributes & 0x03;
    switch (type) {
      case 0: return USB_TRANSFER_TYPE.CONTROL;
      case 1: return USB_TRANSFER_TYPE.ISOCHRONOUS;
      case 2: return USB_TRANSFER_TYPE.BULK;
      case 3: return USB_TRANSFER_TYPE.INTERRUPT;
      default: return USB_TRANSFER_TYPE.CONTROL;
    }
  }

  toJSON() {
    return {
      bEndpointAddress: `0x${this.bEndpointAddress.toString(16).padStart(2, "0")}`,
      number: this.number,
      direction: this.direction,
      transferType: this.transferType,
      wMaxPacketSize: this.wMaxPacketSize,
      bInterval: this.bInterval,
    };
  }
}

export class UsbInterfaceDescriptor {
  constructor({
    bLength = 9,
    bDescriptorType = 0x04,
    bInterfaceNumber = 0,
    bAlternateSetting = 0,
    bNumEndpoints = 0,
    bInterfaceClass = 0,
    bInterfaceSubClass = 0,
    bInterfaceProtocol = 0,
    iInterface = 0,
    endpoints = [],
  } = {}) {
    this.bLength = bLength;
    this.bDescriptorType = bDescriptorType;
    this.bInterfaceNumber = bInterfaceNumber;
    this.bAlternateSetting = bAlternateSetting;
    this.bNumEndpoints = bNumEndpoints;
    this.bInterfaceClass = bInterfaceClass;
    this.bInterfaceSubClass = bInterfaceSubClass;
    this.bInterfaceProtocol = bInterfaceProtocol;
    this.iInterface = iInterface;
    this.endpoints = endpoints;
  }

  className() {
    const names = {
      0x01: "Audio",
      0x02: "CDC Comm",
      0x03: "HID",
      0x06: "Image",
      0x07: "Printer",
      0x08: "Mass Storage",
      0x09: "Hub",
      0x0a: "CDC Data",
      0x0e: "Video",
      0xdc: "Diagnostic",
      0xe0: "Wireless",
      0xef: "Misc",
      0xfe: "App Specific",
      0xff: "Vendor",
    };
    return names[this.bInterfaceClass] || `Class 0x${this.bInterfaceClass.toString(16)}`;
  }

  toJSON() {
    return {
      bInterfaceNumber: this.bInterfaceNumber,
      bAlternateSetting: this.bAlternateSetting,
      bInterfaceClass: `0x${this.bInterfaceClass.toString(16).padStart(2, "0")}`,
      className: this.className(),
      bNumEndpoints: this.bNumEndpoints,
      endpoints: this.endpoints.map((e) => e.toJSON()),
    };
  }
}

export class UsbConfigurationDescriptor {
  constructor({
    bLength = 9,
    bDescriptorType = 0x02,
    wTotalLength = 0,
    bNumInterfaces = 0,
    bConfigurationValue = 1,
    iConfiguration = 0,
    bmAttributes = 0x80, // bus powered
    bMaxPower = 50,     // 100 mA
    interfaces = [],
  } = {}) {
    this.bLength = bLength;
    this.bDescriptorType = bDescriptorType;
    this.wTotalLength = wTotalLength;
    this.bNumInterfaces = bNumInterfaces;
    this.bConfigurationValue = bConfigurationValue;
    this.iConfiguration = iConfiguration;
    this.bmAttributes = bmAttributes;
    this.bMaxPower = bMaxPower;
    this.interfaces = interfaces;
  }

  get maxPowerMa() {
    return this.bMaxPower * 2;
  }

  get selfPowered() {
    return (this.bmAttributes & 0x40) !== 0;
  }

  get remoteWakeup() {
    return (this.bmAttributes & 0x20) !== 0;
  }

  toJSON() {
    return {
      bConfigurationValue: this.bConfigurationValue,
      bNumInterfaces: this.bNumInterfaces,
      maxPowerMa: this.maxPowerMa,
      selfPowered: this.selfPowered,
      remoteWakeup: this.remoteWakeup,
      interfaces: this.interfaces.map((i) => i.toJSON()),
    };
  }
}

// ============================================================================
// USB ENDPOINT (runtime)
// ============================================================================

class UsbEndpoint {
  constructor(descriptor, device) {
    this.descriptor = descriptor;
    this.device = device;
    this.number = descriptor.number;
    this.direction = descriptor.direction;
    this.transferType = descriptor.transferType;
    this.opened = false;
    this.stats = {
      transfers: 0,
      bytesTransferred: 0,
      errors: 0,
      avgLatencyMs: 0,
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

  open() {
    this.opened = true;
    this._emit(USB_EVENTS.ENDPOINT_OPENED, {
      deviceId: this.device.id,
      endpoint: this.number,
      direction: this.direction,
    });
  }

  close() {
    this.opened = false;
    this._emit(USB_EVENTS.ENDPOINT_CLOSED, {
      deviceId: this.device.id,
      endpoint: this.number,
    });
  }

  snapshot() {
    return {
      number: this.number,
      direction: this.direction,
      transferType: this.transferType,
      opened: this.opened,
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// USB TRANSFER
// ============================================================================

let _transferCounter = 0;

class UsbTransfer {
  constructor({ device, endpoint, data = null, length = 0, direction }) {
    this.id = `xfer-${++_transferCounter}`;
    this.device = device;
    this.endpoint = endpoint;
    this.data = data;
    this.length = length || data?.byteLength || 0;
    this.direction = direction || endpoint?.direction || USB_DIRECTION.IN;
    this.transferType = endpoint?.transferType || USB_TRANSFER_TYPE.CONTROL;
    this.state = "pending";
    this.submittedAt = Date.now();
    this.completedAt = null;
    this.error = null;
  }

  async execute() {
    this.state = "in-progress";
    kernelBus.emit(USB_EVENTS.TRANSFER_SUBMITTED, {
      transferId: this.id,
      deviceId: this.device?.id,
      endpoint: this.endpoint?.number,
      length: this.length,
      direction: this.direction,
      type: this.transferType,
    });

    // Simular latencia según tipo de transferencia y velocidad
    const speed = USB_SPEED_MBPS[this.device?.speed || "high"] || 480;
    const baseLatency = {
      [USB_TRANSFER_TYPE.CONTROL]: 2,
      [USB_TRANSFER_TYPE.BULK]: 1,
      [USB_TRANSFER_TYPE.INTERRUPT]: 1,
      [USB_TRANSFER_TYPE.ISOCHRONOUS]: 0.125,
    }[this.transferType] || 1;

    const transferMs = baseLatency + (this.length / (speed * 1e6 / 1000)) * 1000;

    await new Promise((r) => setTimeout(r, Math.max(0.5, Math.min(50, transferMs))));

    this.state = "completed";
    this.completedAt = Date.now();
    const durationMs = this.completedAt - this.submittedAt;

    if (this.endpoint) {
      this.endpoint.stats.transfers++;
      this.endpoint.stats.bytesTransferred += this.length;
      const prev = this.endpoint.stats.avgLatencyMs;
      this.endpoint.stats.avgLatencyMs = prev === 0 ? durationMs : (prev * 0.9 + durationMs * 0.1);
    }

    kernelBus.emit(USB_EVENTS.TRANSFER_COMPLETED, {
      transferId: this.id,
      deviceId: this.device?.id,
      length: this.length,
      durationMs,
    });

    return {
      ok: true,
      bytesTransferred: this.length,
      durationMs,
    };
  }
}

// ============================================================================
// USB DEVICE
// ============================================================================

let _deviceCounter = 0;

class UsbDevice {
  constructor({
    bus,
    parentHub = null,
    portNumber = 1,
    speed = USB_SPEED.HIGH,
    deviceDescriptor = null,
    configurations = [],
    strings = {},
    productName = "USB Device",
    manufacturerName = "Unknown",
    serialNumber = null,
    webUsbDevice = null,
  }) {
    this.id = `usb-dev-${++_deviceCounter}`;
    this.bus = bus;
    this.parentHub = parentHub;
    this.portNumber = portNumber;
    this.speed = speed;
    this.deviceDescriptor =
      deviceDescriptor || new UsbDeviceDescriptor();
    this.configurations = configurations;
    this.activeConfiguration = configurations[0]?.bConfigurationValue ?? null;
    this.strings = { ...strings };
    this.productName = productName;
    this.manufacturerName = manufacturerName;
    this.serialNumber = serialNumber;
    this.webUsbDevice = webUsbDevice;

    this.state = USB_STATE.ATTACHED;
    this.attachedAt = Date.now();
    this.enumeratedAt = null;
    this.suspended = false;

    // Endpoints activos
    this.endpoints = new Map(); // "ep-addr" → UsbEndpoint
    this.claimedInterfaces = new Set();

    // Power
    this.power = {
      maxPowerMa: 100,
      currentMa: 0,
      selfPowered: false,
      remoteWakeup: false,
    };

    // Stats
    this.stats = {
      transfers: 0,
      bytesIn: 0,
      bytesOut: 0,
      errors: 0,
      resets: 0,
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

  _setState(next) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this._emit(USB_EVENTS.DEVICE_STATE_CHANGED, {
      deviceId: this.id,
      from: prev,
      to: next,
    });
  }

  // ---------------------------------------------------------------- enumeración
  async enumerate() {
    this._setState(USB_STATE.POWERED);
    this._emit(USB_EVENTS.ENUMERATION_STEP, {
      deviceId: this.id,
      step: "powered",
    });

    // GET_DESCRIPTOR (device)
    await this._controlTransfer("GET_DESCRIPTOR", 0x01, 0, 18);
    this._emit(USB_EVENTS.ENUMERATION_STEP, {
      deviceId: this.id,
      step: "get-device-descriptor",
    });

    // SET_ADDRESS
    this._setState(USB_STATE.DEFAULT);
    await this._controlTransfer("SET_ADDRESS", 0x05, this.portNumber, 0);
    this._setState(USB_STATE.ADDRESSED);
    this._emit(USB_EVENTS.ENUMERATION_STEP, {
      deviceId: this.id,
      step: "set-address",
      address: this.portNumber,
    });

    // GET_DESCRIPTOR (config)
    if (this.configurations.length > 0) {
      await this._controlTransfer("GET_DESCRIPTOR", 0x02, 0, 9);
      this._emit(USB_EVENTS.ENUMERATION_STEP, {
        deviceId: this.id,
        step: "get-config-descriptor",
      });
    }

    // SET_CONFIGURATION
    if (this.activeConfiguration != null) {
      await this._controlTransfer(
        "SET_CONFIGURATION",
        0x09,
        this.activeConfiguration,
        0
      );
      this._setState(USB_STATE.CONFIGURED);
      this._openEndpoints();
      this._emit(USB_EVENTS.CONFIGURATION_SET, {
        deviceId: this.id,
        configuration: this.activeConfiguration,
      });
    }

    this.enumeratedAt = Date.now();
    this._emit(USB_EVENTS.DEVICE_ENUMERATED, {
      deviceId: this.id,
      durationMs: this.enumeratedAt - this.attachedAt,
    });
    return true;
  }

  _openEndpoints() {
    const config = this.configurations.find(
      (c) => c.bConfigurationValue === this.activeConfiguration
    );
    if (!config) return;

    for (const iface of config.interfaces) {
      for (const epDesc of iface.endpoints) {
        const key = `ep-${epDesc.bEndpointAddress}`;
        if (!this.endpoints.has(key)) {
          const ep = new UsbEndpoint(epDesc, this);
          ep.open();
          this.endpoints.set(key, ep);
        }
      }
    }
  }

  // ---------------------------------------------------------------- control transfers
  async _controlTransfer(name, request, value, length) {
    const transfer = new UsbTransfer({
      device: this,
      endpoint: null,
      length,
      direction: USB_DIRECTION.IN,
    });
    this.stats.transfers++;
    return transfer.execute();
  }

  // ---------------------------------------------------------------- bulk transfers
  async bulkTransfer(endpointNumber, direction, data) {
    const key = `ep-${(direction === USB_DIRECTION.IN ? 0x80 : 0x00) | endpointNumber}`;
    const ep = this.endpoints.get(key);
    if (!ep) {
      this.stats.errors++;
      this._emit(USB_EVENTS.TRANSFER_FAILED, {
        deviceId: this.id,
        error: "endpoint not found",
      });
      return { ok: false, error: "endpoint not found" };
    }

    const transfer = new UsbTransfer({
      device: this,
      endpoint: ep,
      data,
      length: data?.byteLength ?? 0,
      direction,
    });
    this.stats.transfers++;

    const result = await transfer.execute();

    if (direction === USB_DIRECTION.IN) {
      this.stats.bytesIn += result.bytesTransferred;
    } else {
      this.stats.bytesOut += result.bytesTransferred;
    }

    return result;
  }

  async interruptTransfer(endpointNumber, direction, data) {
    // Misma lógica que bulk pero con endpoint interrupt
    return this.bulkTransfer(endpointNumber, direction, data);
  }

  async isochronousTransfer(endpointNumber, direction, data) {
    return this.bulkTransfer(endpointNumber, direction, data);
  }

  // ---------------------------------------------------------------- interfaces
  claimInterface(interfaceNumber) {
    if (this.claimedInterfaces.has(interfaceNumber)) return false;
    this.claimedInterfaces.add(interfaceNumber);
    this._emit(USB_EVENTS.INTERFACE_CLAIMED, {
      deviceId: this.id,
      interfaceNumber,
    });
    return true;
  }

  releaseInterface(interfaceNumber) {
    if (!this.claimedInterfaces.has(interfaceNumber)) return false;
    this.claimedInterfaces.delete(interfaceNumber);
    this._emit(USB_EVENTS.INTERFACE_RELEASED, {
      deviceId: this.id,
      interfaceNumber,
    });
    return true;
  }

  // ---------------------------------------------------------------- power
  suspend() {
    if (this.suspended) return;
    this.suspended = true;
    this._setState(USB_STATE.SUSPENDED);
    this._emit(USB_EVENTS.POWER_SUSPEND, { deviceId: this.id });
  }

  resume() {
    if (!this.suspended) return;
    this.suspended = false;
    this._setState(USB_STATE.CONFIGURED);
    this._emit(USB_EVENTS.POWER_RESUME, { deviceId: this.id });
  }

  // ---------------------------------------------------------------- reset
  async reset() {
    this.stats.resets++;
    this._setState(USB_STATE.DEFAULT);
    await new Promise((r) => setTimeout(r, 50));
    await this.enumerate();
  }

  // ---------------------------------------------------------------- snapshot
  get classSummary() {
    const classes = new Set();
    for (const config of this.configurations) {
      for (const iface of config.interfaces) {
        classes.add(iface.className());
      }
    }
    return Array.from(classes);
  }

  snapshot() {
    return {
      id: this.id,
      productName: this.productName,
      manufacturerName: this.manufacturerName,
      serialNumber: this.serialNumber,
      speed: this.speed,
      speedMbps: USB_SPEED_MBPS[this.speed],
      state: this.state,
      portNumber: this.portNumber,
      parentHub: this.parentHub,
      deviceDescriptor: this.deviceDescriptor.toJSON(),
      configurations: this.configurations.map((c) => c.toJSON()),
      activeConfiguration: this.activeConfiguration,
      classes: this.classSummary,
      endpoints: Array.from(this.endpoints.values()).map((e) => e.snapshot()),
      claimedInterfaces: Array.from(this.claimedInterfaces),
      power: { ...this.power },
      suspended: this.suspended,
      attachedAt: this.attachedAt,
      enumeratedAt: this.enumeratedAt,
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// USB HUB
// ============================================================================

class UsbHub {
  constructor({ id, bus, parentHub = null, ports = 4, tier = 1, speed = USB_SPEED.HIGH }) {
    this.id = id || `hub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.bus = bus;
    this.parentHub = parentHub;
    this.ports = ports;
    this.tier = tier;
    this.speed = speed;
    this.portDevices = new Array(ports).fill(null);
    this.createdAt = Date.now();
  }

  attachDevice(device, portNumber) {
    if (portNumber < 0 || portNumber >= this.ports) return false;
    if (this.portDevices[portNumber]) return false;
    this.portDevices[portNumber] = device.id;
    device.parentHub = this.id;
    device.portNumber = portNumber;
    return true;
  }

  detachDevice(deviceId) {
    for (let i = 0; i < this.portDevices.length; i++) {
      if (this.portDevices[i] === deviceId) {
        this.portDevices[i] = null;
        return true;
      }
    }
    return false;
  }

  snapshot() {
    return {
      id: this.id,
      parentHub: this.parentHub,
      ports: this.ports,
      tier: this.tier,
      speed: this.speed,
      portDevices: [...this.portDevices],
      usedPorts: this.portDevices.filter(Boolean).length,
    };
  }
}

// ============================================================================
// USB BUS
// ============================================================================

export class UsbBus {
  constructor({ maxTier = 7, rootPorts = 4 } = {}) {
    this.maxTier = maxTier;
    this.rootPorts = rootPorts;
    this.hubs = new Map();
    this.devices = new Map();
    this.rootHub = new UsbHub({
      id: "root-hub",
      bus: this,
      parentHub: null,
      ports: rootPorts,
      tier: 0,
    });
    this.hubs.set(this.rootHub.id, this.rootHub);
    this.state = "stopped";
    this.listeners = new Set();
    this.log = new UsbLog();
    this.stats = {
      devicesAttached: 0,
      devicesDetached: 0,
      totalTransfers: 0,
      bytesIn: 0,
      bytesOut: 0,
      errors: 0,
      startedAt: null,
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
    this.log.push(level, message, meta);
  }

  // -------------------------------------------------------------- lifecycle
  start() {
    if (this.state === "running") return;
    this.state = "running";
    this.stats.startedAt = Date.now();
    this._emit(USB_EVENTS.BUS_STARTED, {});
    this._log("info", "usb bus started");
  }

  stop() {
    if (this.state === "stopped") return;
    this.state = "stopped";
    for (const d of this.devices.values()) {
      d.suspend();
    }
    this._emit(USB_EVENTS.BUS_STOPPED, {});
    this._log("info", "usb bus stopped");
  }

  // -------------------------------------------------------------- hubs
  addHub({ parentHub = null, ports = 4, speed = USB_SPEED.HIGH }) {
    const parent = parentHub ? this.hubs.get(parentHub) : this.rootHub;
    const tier = (parent?.tier ?? 0) + 1;
    if (tier > this.maxTier) {
      this._log("warn", `hub tier ${tier} exceeds max ${this.maxTier}`);
      return null;
    }
    const hub = new UsbHub({
      bus: this,
      parentHub: parent?.id ?? null,
      ports,
      tier,
      speed,
    });
    this.hubs.set(hub.id, hub);
    this._emit(USB_EVENTS.HUB_ADDED, hub.snapshot());
    this._log("info", `hub added: ${hub.id} (tier ${tier})`);
    return hub;
  }

  removeHub(id) {
    if (id === this.rootHub.id) return false;
    const hub = this.hubs.get(id);
    if (!hub) return false;
    // Detach todos los devices hijos
    for (let i = 0; i < hub.portDevices.length; i++) {
      const devId = hub.portDevices[i];
      if (devId) this.detachDevice(devId);
    }
    this.hubs.delete(id);
    this._emit(USB_EVENTS.HUB_REMOVED, { hubId: id });
    return true;
  }

  getHub(id) {
    return this.hubs.get(id) ?? null;
  }

  listHubs() {
    return Array.from(this.hubs.values()).map((h) => h.snapshot());
  }

  // -------------------------------------------------------------- attach/detach
  async attachDevice({
    productName = "USB Device",
    manufacturerName = "Unknown",
    speed = USB_SPEED.HIGH,
    idVendor = 0,
    idProduct = 0,
    configurations = [],
    strings = {},
    portNumber = null,
    hubId = null,
    webUsbDevice = null,
    autoEnumerate = true,
  } = {}) {
    if (this.state !== "running") this.start();

    const deviceDescriptor = new UsbDeviceDescriptor({
      idVendor,
      idProduct,
      bcdUSB:
        speed === USB_SPEED.SUPER
          ? 0x0300
          : speed === USB_SPEED.HIGH
          ? 0x0200
          : 0x0110,
    });

    const device = new UsbDevice({
      bus: this,
      speed,
      deviceDescriptor,
      configurations,
      strings,
      productName,
      manufacturerName,
      webUsbDevice,
    });

    // Elegir puerto
    const parentHub = hubId ? this.hubs.get(hubId) : this.rootHub;
    let port = portNumber;
    if (port == null) {
      const idx = parentHub.portDevices.findIndex((d) => d === null);
      port = idx >= 0 ? idx : 0;
    }
    parentHub.attachDevice(device, port);

    this.devices.set(device.id, device);
    this.stats.devicesAttached++;

    this._emit(USB_EVENTS.DEVICE_ATTACHED, device.snapshot());
    this._emit(USB_EVENTS.HOTPLUG_CHANGE, { type: "attach", deviceId: device.id });
    this._log("info", `device attached: ${device.productName} @ ${speed}`);

    if (autoEnumerate) {
      try {
        await device.enumerate();
      } catch (err) {
        device._setState(USB_STATE.ERROR);
        device.stats.errors++;
        this.stats.errors++;
        this._emit(USB_EVENTS.DEVICE_ERROR, {
          deviceId: device.id,
          error: String(err),
        });
      }
    }

    return device;
  }

  detachDevice(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return false;

    // Cerrar endpoints
    for (const ep of device.endpoints.values()) ep.close();
    device.endpoints.clear();

    // Detach del hub
    if (device.parentHub) {
      const hub = this.hubs.get(device.parentHub);
      hub?.detachDevice(deviceId);
    }

    this.devices.delete(deviceId);
    this.stats.devicesDetached++;

    this._emit(USB_EVENTS.DEVICE_DETACHED, { deviceId });
    this._emit(USB_EVENTS.HOTPLUG_CHANGE, { type: "detach", deviceId });
    this._log("info", `device detached: ${device.productName}`);
    return true;
  }

  getDevice(id) {
    return this.devices.get(id) ?? null;
  }

  listDevices() {
    return Array.from(this.devices.values()).map((d) => d.snapshot());
  }

  listDevicesByClass(className) {
    return this.listDevices().filter((d) =>
      d.classes.some((c) => c.toLowerCase().includes(className.toLowerCase()))
    );
  }

  // -------------------------------------------------------------- WebUSB
  async initWebUsb() {
    if (typeof navigator === "undefined" || !navigator.usb) {
      this._log("warn", "WebUSB no disponible");
      return false;
    }
    try {
      const devices = await navigator.usb.getDevices();
      for (const webDev of devices) {
        await this.attachDevice({
          productName: webDev.productName || "WebUSB Device",
          manufacturerName: webDev.manufacturerName || "Unknown",
          speed: "high",
          idVendor: webDev.vendorId,
          idProduct: webDev.productId,
          webUsbDevice: webDev,
        });
      }
      this._log("info", `WebUSB: ${devices.length} devices detected`);
      return true;
    } catch (err) {
      this._log("error", "WebUSB init failed", err);
      return false;
    }
  }

  async requestWebUsbDevice() {
    if (typeof navigator === "undefined" || !navigator.usb) return null;
    try {
      const webDev = await navigator.usb.requestDevice({ filters: [] });
      return this.attachDevice({
        productName: webDev.productName || "WebUSB Device",
        manufacturerName: webDev.manufacturerName || "Unknown",
        idVendor: webDev.vendorId,
        idProduct: webDev.productId,
        webUsbDevice: webDev,
      });
    } catch (err) {
      return null;
    }
  }

  // -------------------------------------------------------------- power
  suspendAll() {
    for (const d of this.devices.values()) d.suspend();
  }

  resumeAll() {
    for (const d of this.devices.values()) d.resume();
  }

  // -------------------------------------------------------------- snapshot
  snapshot() {
    return {
      state: this.state,
      rootPorts: this.rootPorts,
      maxTier: this.maxTier,
      hubs: this.listHubs(),
      devices: this.listDevices(),
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// FÁBRICA DE DISPOSITIVOS DE EJEMPLO
// ----------------------------------------------------------------------------
// Crea un conjunto realista de dispositivos USB para pruebas:
// teclado HID, ratón HID, disco externo MSC, cámara UVC, altavoces Audio
// ============================================================================

export function createSampleDevices() {
  return [
    // Teclado HID
    {
      productName: "Virtual Keyboard",
      manufacturerName: "RainOS",
      speed: USB_SPEED.LOW,
      idVendor: 0x05ac,
      idProduct: 0x024f,
      configurations: [
        new UsbConfigurationDescriptor({
          bNumInterfaces: 1,
          bConfigurationValue: 1,
          bMaxPower: 50,
          interfaces: [
            new UsbInterfaceDescriptor({
              bInterfaceNumber: 0,
              bNumEndpoints: 1,
              bInterfaceClass: USB_CLASS.HID,
              bInterfaceSubClass: 1, // boot interface
              bInterfaceProtocol: 1, // keyboard
              endpoints: [
                new UsbEndpointDescriptor({
                  bEndpointAddress: 0x81,
                  bmAttributes: 0x03, // interrupt
                  wMaxPacketSize: 8,
                  bInterval: 10,
                }),
              ],
            }),
          ],
        }),
      ],
    },
    // Ratón HID
    {
      productName: "Virtual Mouse",
      manufacturerName: "RainOS",
      speed: USB_SPEED.LOW,
      idVendor: 0x05ac,
      idProduct: 0x030d,
      configurations: [
        new UsbConfigurationDescriptor({
          bNumInterfaces: 1,
          bConfigurationValue: 1,
          bMaxPower: 50,
          interfaces: [
            new UsbInterfaceDescriptor({
              bInterfaceNumber: 0,
              bNumEndpoints: 1,
              bInterfaceClass: USB_CLASS.HID,
              bInterfaceSubClass: 1,
              bInterfaceProtocol: 2, // mouse
              endpoints: [
                new UsbEndpointDescriptor({
                  bEndpointAddress: 0x81,
                  bmAttributes: 0x03,
                  wMaxPacketSize: 4,
                  bInterval: 10,
                }),
              ],
            }),
          ],
        }),
      ],
    },
    // Disco externo Mass Storage
    {
      productName: "External SSD",
      manufacturerName: "RainOS",
      speed: USB_SPEED.SUPER,
      idVendor: 0x0bc2,
      idProduct: 0x231a,
      configurations: [
        new UsbConfigurationDescriptor({
          bNumInterfaces: 1,
          bConfigurationValue: 1,
          bMaxPower: 250,
          interfaces: [
            new UsbInterfaceDescriptor({
              bInterfaceNumber: 0,
              bNumEndpoints: 2,
              bInterfaceClass: USB_CLASS.MASS_STORAGE,
              bInterfaceSubClass: 6, // SCSI
              bInterfaceProtocol: 0x50, // Bulk-Only
              endpoints: [
                new UsbEndpointDescriptor({
                  bEndpointAddress: 0x81, // IN
                  bmAttributes: 0x02,     // bulk
                  wMaxPacketSize: 1024,
                }),
                new UsbEndpointDescriptor({
                  bEndpointAddress: 0x02, // OUT
                  bmAttributes: 0x02,
                  wMaxPacketSize: 1024,
                }),
              ],
            }),
          ],
        }),
      ],
    },
    // Cámara UVC
    {
      productName: "HD Webcam",
      manufacturerName: "RainOS",
      speed: USB_SPEED.HIGH,
      idVendor: 0x046d,
      idProduct: 0x0825,
      configurations: [
        new UsbConfigurationDescriptor({
          bNumInterfaces: 2,
          bConfigurationValue: 1,
          bMaxPower: 500,
          interfaces: [
            new UsbInterfaceDescriptor({
              bInterfaceNumber: 0,
              bNumEndpoints: 1,
              bInterfaceClass: USB_CLASS.VIDEO,
              bInterfaceSubClass: 1, // video control
              endpoints: [
                new UsbEndpointDescriptor({
                  bEndpointAddress: 0x83,
                  bmAttributes: 0x03, // interrupt
                  wMaxPacketSize: 16,
                  bInterval: 6,
                }),
              ],
            }),
            new UsbInterfaceDescriptor({
              bInterfaceNumber: 1,
              bNumEndpoints: 1,
              bInterfaceClass: USB_CLASS.VIDEO,
              bInterfaceSubClass: 2, // video streaming
              endpoints: [
                new UsbEndpointDescriptor({
                  bEndpointAddress: 0x81,
                  bmAttributes: 0x01, // isochronous
                  wMaxPacketSize: 3072,
                  bInterval: 1,
                }),
              ],
            }),
          ],
        }),
      ],
    },
    // Altavoces Audio
    {
      productName: "USB Speakers",
      manufacturerName: "RainOS",
      speed: USB_SPEED.FULL,
      idVendor: 0x1235,
      idProduct: 0x8001,
      configurations: [
        new UsbConfigurationDescriptor({
          bNumInterfaces: 1,
          bConfigurationValue: 1,
          bMaxPower: 100,
          interfaces: [
            new UsbInterfaceDescriptor({
              bInterfaceNumber: 0,
              bNumEndpoints: 1,
              bInterfaceClass: USB_CLASS.AUDIO,
              bInterfaceSubClass: 2, // audio streaming
              endpoints: [
                new UsbEndpointDescriptor({
                  bEndpointAddress: 0x01,
                  bmAttributes: 0x01, // isochronous
                  wMaxPacketSize: 192,
                  bInterval: 1,
                }),
              ],
            }),
          ],
        }),
      ],
    },
  ];
}

// ============================================================================
// PROVIDER + HOOK
// ============================================================================

const UsbContext = React.createContext(null);

export function UsbProvider({
  children,
  bus: external,
  autoStart = true,
  autoLoadSamples = false,
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new UsbBus();
  }
  const bus = ref.current;
  const [snapshot, setSnapshot] = useState(() => bus.snapshot());

  useEffect(() => {
    const unsub = bus.subscribe(() => setSnapshot(bus.snapshot()));
    if (autoStart) bus.start();

    if (autoLoadSamples) {
      (async () => {
        const samples = createSampleDevices();
        for (const sample of samples) {
          await bus.attachDevice(sample);
        }
      })();
    }

    return () => {
      unsub();
      if (autoStart) bus.stop();
    };
  }, [bus, autoStart, autoLoadSamples]);

  const api = useMemo(
    () => ({
      bus,
      snapshot,

      start: () => bus.start(),
      stop: () => bus.stop(),

      addHub: (opts) => bus.addHub(opts),
      removeHub: (id) => bus.removeHub(id),
      getHub: (id) => bus.getHub(id),
      listHubs: () => bus.listHubs(),

      attachDevice: (opts) => bus.attachDevice(opts),
      detachDevice: (id) => bus.detachDevice(id),
      getDevice: (id) => bus.getDevice(id),
      listDevices: () => bus.listDevices(),
      listDevicesByClass: (cls) => bus.listDevicesByClass(cls),

      bulkTransfer: (deviceId, endpointNumber, direction, data) => {
        const device = bus.getDevice(deviceId);
        if (!device) return Promise.resolve({ ok: false, error: "device-not-found" });
        return device.bulkTransfer(endpointNumber, direction, data);
      },

      initWebUsb: () => bus.initWebUsb(),
      requestWebUsbDevice: () => bus.requestWebUsbDevice(),

      suspendAll: () => bus.suspendAll(),
      resumeAll: () => bus.resumeAll(),

      createSampleDevices,
    }),
    [bus, snapshot]
  );

  return <UsbContext.Provider value={api}>{children}</UsbContext.Provider>;
}

export function useUsb() {
  const ctx = React.useContext(UsbContext);
  if (!ctx) throw new Error("useUsb must be used within UsbProvider");
  return ctx;
}

export default {
  UsbBus,
  UsbHub,
  UsbDevice,
  UsbEndpoint,
  UsbTransfer,
  UsbDeviceDescriptor,
  UsbConfigurationDescriptor,
  UsbInterfaceDescriptor,
  UsbEndpointDescriptor,
  UsbProvider,
  useUsb,
  createSampleDevices,
  USB_SPEED,
  USB_SPEED_MBPS,
  USB_CLASS,
  USB_TRANSFER_TYPE,
  USB_DIRECTION,
  USB_STATE,
  USB_EVENTS,
};
