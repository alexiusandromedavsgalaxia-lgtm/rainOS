// ============================================================================
// bluetooth.jsx — Subsistema Bluetooth completo
// ----------------------------------------------------------------------------
// Modela toda la pila Bluetooth desde el adaptador hasta los perfiles:
//
//   - BluetoothManager: orquesta adaptador, dispositivos, escaneo, perfiles
//   - BluetoothAdapter: el chip BT (¿encendido?, modo descubrible, nombre)
//   - BluetoothDevice: cada dispositivo emparejado o descubierto
//   - BluetoothService: servicios GATT/BLE de cada dispositivo
//   - BluetoothCharacteristic: características GATT con read/write/notify
//   - BluetoothProfile: A2DP, HFP, HID, ANCS, PAN, MAP, PBAP, OPP
//   - BluetoothPairing: emparejamiento con PIN/passkey/just-works
//   - BluetoothScanner: escaneo de dispositivos con filtros
//   - BluetoothNotifications: notificaciones ANCS (iOS)
//
// INTEGRACIÓN CON EL NAVEGADOR
//
//   - Web Bluetooth API (navigator.bluetooth) cuando está disponible
//   - requestDevice() con filtros (services, namePrefix, etc.)
//   - GATT server/characteristic discovery
//   - Read/write/notify sobre características
//   - Fallback a simulación si Web Bluetooth no está disponible
//
// PERFILES BLUETOOTH (Classic + BLE)
//
//   Classic:
//     - A2DP  → audio de alta calidad (auriculares, altavoces)
//     - HFP   → manos libres (coche, auriculares con mic)
//     - HID   → teclados y ratones
//     - PAN   → red personal (tethering)
//     - MAP   → acceso a mensajes
//     - PBAP  → acceso a agenda
//     - OPP   → transferencia de objetos (fotos, vCards)
//
//   BLE:
//     - GATT  → servicios y características genéricas
//     - ANCS  → notificaciones iOS
//     - HOGP  → HID sobre GATT
//     - BAS   → Battery Service
//     - DIS   → Device Information Service
//     - HRS   → Heart Rate Service
//
// EVENTOS
//
//   - adapter:on, adapter:off, adapter:state-changed
//   - adapter:name-changed, adapter:discoverable-changed
//   - device:added, device:removed, device:updated, device:selected
//   - device:paired, device:unpaired, device:connected, device:disconnected
//   - device:rssi-updated
//   - scan:started, scan:stopped, scan:result
//   - pair:started, pair:succeeded, pair:failed, pair:pin-required
//   - profile:connected, profile:disconnected
//   - gatt:service-found, gatt:characteristic-found
//   - gatt:value-changed
//   - notification:received
//   - transfer:started, transfer:progress, transfer:completed, transfer:failed
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

export const BT_STATE = Object.freeze({
  UNKNOWN: "unknown",
  OFF: "off",
  ON: "on",
  SUSPENDED: "suspended",
  UNAUTHORIZED: "unauthorized",
  UNSUPPORTED: "unsupported",
});

export const BT_DEVICE_KIND = Object.freeze({
  HEADPHONES: "headphones",
  SPEAKER: "speaker",
  KEYBOARD: "keyboard",
  MOUSE: "mouse",
  TRACKPAD: "trackpad",
  GAMEPAD: "gamepad",
  WATCH: "watch",
  PHONE: "phone",
  TABLET: "tablet",
  COMPUTER: "computer",
  HEART_RATE: "heart-rate",
  BEACON: "beacon",
  UNKNOWN: "unknown",
});

export const BT_PROFILE = Object.freeze({
  A2DP: "a2dp",
  AVRCP: "avrcp",
  HFP: "hfp",
  HSP: "hsp",
  HID: "hid",
  HOGP: "hogp",
  PAN: "pan",
  MAP: "map",
  PBAP: "pbap",
  OPP: "opp",
  GATT: "gatt",
  ANCS: "ancs",
  BAS: "bas",
  DIS: "dis",
  HRS: "hrs",
});

export const BT_CONNECTION = Object.freeze({
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  DISCONNECTING: "disconnecting",
  FAILED: "failed",
});

export const BT_PAIRING_STATE = Object.freeze({
  NONE: "none",
  PAIRING: "pairing",
  PAIRED: "paired",
  FAILED: "failed",
  PIN_REQUIRED: "pin-required",
  PASSKEY_REQUIRED: "passkey-required",
  CONFIRM_REQUIRED: "confirm-required",
});

export const BT_EVENTS = Object.freeze({
  MANAGER_STARTED: "bt:manager-started",
  MANAGER_STOPPED: "bt:manager-stopped",
  ADAPTER_STATE_CHANGED: "bt:adapter-state-changed",
  ADAPTER_NAME_CHANGED: "bt:adapter-name-changed",
  ADAPTER_DISCOVERABLE_CHANGED: "bt:adapter-discoverable-changed",
  DEVICE_ADDED: "bt:device-added",
  DEVICE_REMOVED: "bt:device-removed",
  DEVICE_UPDATED: "bt:device-updated",
  DEVICE_SELECTED: "bt:device-selected",
  DEVICE_RSSI_UPDATED: "bt:device-rssi-updated",
  SCAN_STARTED: "bt:scan-started",
  SCAN_STOPPED: "bt:scan-stopped",
  SCAN_RESULT: "bt:scan-result",
  PAIR_STARTED: "bt:pair-started",
  PAIR_SUCCEEDED: "bt:pair-succeeded",
  PAIR_FAILED: "bt:pair-failed",
  PAIR_PIN_REQUIRED: "bt:pair-pin-required",
  PAIR_PASSKEY_REQUIRED: "bt:pair-passkey-required",
  PAIR_CONFIRM_REQUIRED: "bt:pair-confirm-required",
  CONNECT_STARTED: "bt:connect-started",
  CONNECT_SUCCEEDED: "bt:connect-succeeded",
  CONNECT_FAILED: "bt:connect-failed",
  DISCONNECTED: "bt:disconnected",
  PROFILE_CONNECTED: "bt:profile-connected",
  PROFILE_DISCONNECTED: "bt:profile-disconnected",
  GATT_SERVICE_FOUND: "bt:gatt-service-found",
  GATT_CHARACTERISTIC_FOUND: "bt:gatt-characteristic-found",
  GATT_VALUE_CHANGED: "bt:gatt-value-changed",
  NOTIFICATION_RECEIVED: "bt:notification-received",
  TRANSFER_STARTED: "bt:transfer-started",
  TRANSFER_PROGRESS: "bt:transfer-progress",
  TRANSFER_COMPLETED: "bt:transfer-completed",
  TRANSFER_FAILED: "bt:transfer-failed",
  LOG: "bt:log",
});

// ============================================================================
// LOGGER
// ============================================================================

class BtLog {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(BT_EVENTS.LOG, e);
  }
  info(m, x) { this.push("info", m, x); }
  warn(m, x) { this.push("warn", m, x); }
  error(m, x) { this.push("error", m, x); }
  all() { return [...this.entries]; }
}

// ============================================================================
// BLUETOOTH ADAPTER
// ============================================================================

class BluetoothAdapter {
  constructor({ name = "rainOS BT", address = "00:00:00:00:00:00" } = {}) {
    this.name = name;
    this.address = address;
    this.state = BT_STATE.UNKNOWN;
    this.discoverable = false;
    this.discoverableTimeoutMs = 0;
    this.powered = false;
    this.listeners = new Set();

    this.stats = {
      powerOnCount: 0,
      totalPowerOnMs: 0,
      lastPowerOnAt: null,
    };
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

  setState(state) {
    if (this.state === state) return;
    const prev = this.state;
    this.state = state;
    this.powered = state === BT_STATE.ON;

    if (state === BT_STATE.ON) {
      this.stats.powerOnCount++;
      this.stats.lastPowerOnAt = Date.now();
    } else if (prev === BT_STATE.ON && this.stats.lastPowerOnAt) {
      this.stats.totalPowerOnMs += Date.now() - this.stats.lastPowerOnAt;
    }

    this._emit(BT_EVENTS.ADAPTER_STATE_CHANGED, { from: prev, to: state });
  }

  setName(name) {
    const prev = this.name;
    this.name = name;
    this._emit(BT_EVENTS.ADAPTER_NAME_CHANGED, { from: prev, to: name });
  }

  setDiscoverable(enabled, timeoutMs = 0) {
    const prev = this.discoverable;
    this.discoverable = !!enabled;
    this.discoverableTimeoutMs = timeoutMs;
    this._emit(BT_EVENTS.ADAPTER_DISCOVERABLE_CHANGED, {
      from: prev,
      to: this.discoverable,
      timeoutMs,
    });
  }

  snapshot() {
    return {
      name: this.name,
      address: this.address,
      state: this.state,
      powered: this.powered,
      discoverable: this.discoverable,
      discoverableTimeoutMs: this.discoverableTimeoutMs,
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// BLUETOOTH DEVICE
// ============================================================================

let _deviceCounter = 0;

class BluetoothDevice {
  constructor({
    id,
    name,
    address,
    kind = BT_DEVICE_KIND.UNKNOWN,
    paired = false,
    connected = false,
    rssi = -60,
    manufacturer = null,
    model = null,
    firmwareVersion = null,
    batteryLevel = null,
    profiles = [],
    webBluetoothDevice = null,
  }) {
    this.id = id || `bt-${++_deviceCounter}`;
    this.name = name || "Unknown Device";
    this.address = address || this._randomAddress();
    this.kind = kind;
    this.paired = paired;
    this.connected = connected;
    this.connectionState = connected ? BT_CONNECTION.CONNECTED : BT_CONNECTION.DISCONNECTED;
    this.pairingState = paired ? BT_PAIRING_STATE.PAIRED : BT_PAIRING_STATE.NONE;
    this.rssi = rssi;
    this.manufacturer = manufacturer;
    this.model = model;
    this.firmwareVersion = firmwareVersion;
    this.batteryLevel = batteryLevel;
    this.profiles = new Set(profiles);
    this.webBluetoothDevice = webBluetoothDevice;
    this.gattServer = null;
    this.services = new Map();
    this.characteristics = new Map();
    this.firstSeenAt = Date.now();
    this.lastSeenAt = Date.now();
    this.pairedAt = null;
    this.connectedAt = null;
    this.listeners = new Set();
    this.stats = {
      connectCount: 0,
      disconnectCount: 0,
      bytesSent: 0,
      bytesReceived: 0,
      notificationsReceived: 0,
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

  _randomAddress() {
    const hex = "0123456789ABCDEF";
    const parts = [];
    for (let i = 0; i < 6; i++) {
      parts.push(hex[Math.floor(Math.random() * 16)] + hex[Math.floor(Math.random() * 16)]);
    }
    return parts.join(":");
  }

  updateRssi(rssi) {
    this.rssi = rssi;
    this.lastSeenAt = Date.now();
    this._emit(BT_EVENTS.DEVICE_RSSI_UPDATED, {
      deviceId: this.id,
      rssi,
    });
  }

  setConnectionState(state) {
    if (this.connectionState === state) return;
    const prev = this.connectionState;
    this.connectionState = state;
    this.connected = state === BT_CONNECTION.CONNECTED;

    if (state === BT_CONNECTION.CONNECTED) {
      this.connectedAt = Date.now();
      this.stats.connectCount++;
    } else if (prev === BT_CONNECTION.CONNECTED) {
      this.stats.disconnectCount++;
    }
  }

  setPairingState(state) {
    if (this.pairingState === state) return;
    const prev = this.pairingState;
    this.pairingState = state;
    if (state === BT_PAIRING_STATE.PAIRED) {
      this.paired = true;
      this.pairedAt = Date.now();
    }
    this._emit(BT_EVENTS.DEVICE_UPDATED, {
      deviceId: this.id,
      pairingState: state,
      prev,
    });
  }

  addProfile(profile) {
    this.profiles.add(profile);
    this._emit(BT_EVENTS.PROFILE_CONNECTED, {
      deviceId: this.id,
      profile,
    });
  }

  removeProfile(profile) {
    this.profiles.delete(profile);
    this._emit(BT_EVENTS.PROFILE_DISCONNECTED, {
      deviceId: this.id,
      profile,
    });
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      address: this.address,
      kind: this.kind,
      paired: this.paired,
      connected: this.connected,
      connectionState: this.connectionState,
      pairingState: this.pairingState,
      rssi: this.rssi,
      manufacturer: this.manufacturer,
      model: this.model,
      firmwareVersion: this.firmwareVersion,
      batteryLevel: this.batteryLevel,
      profiles: Array.from(this.profiles),
      services: this.services.size,
      characteristics: this.characteristics.size,
      firstSeenAt: this.firstSeenAt,
      lastSeenAt: this.lastSeenAt,
      pairedAt: this.pairedAt,
      connectedAt: this.connectedAt,
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// GATT SERVICE
// ============================================================================

class GattService {
  constructor({ uuid, name, primary = true, deviceId }) {
    this.uuid = uuid;
    this.name = name || uuid;
    this.primary = primary;
    this.deviceId = deviceId;
    this.characteristics = new Map();
  }

  addCharacteristic(char) {
    this.characteristics.set(char.uuid, char);
  }

  getCharacteristic(uuid) {
    return this.characteristics.get(uuid);
  }

  listCharacteristics() {
    return Array.from(this.characteristics.values()).map((c) => c.snapshot());
  }

  snapshot() {
    return {
      uuid: this.uuid,
      name: this.name,
      primary: this.primary,
      deviceId: this.deviceId,
      characteristics: this.listCharacteristics(),
    };
  }
}

// ============================================================================
// GATT CHARACTERISTIC
// ============================================================================

class GattCharacteristic {
  constructor({
    uuid,
    name,
    properties = {},
    value = null,
    serviceUuid,
    deviceId,
  }) {
    this.uuid = uuid;
    this.name = name || uuid;
    this.properties = {
      read: !!properties.read,
      write: !!properties.write,
      writeWithoutResponse: !!properties.writeWithoutResponse,
      notify: !!properties.notify,
      indicate: !!properties.indicate,
      ...properties,
    };
    this.value = value;
    this.serviceUuid = serviceUuid;
    this.deviceId = deviceId;
    this.lastReadAt = null;
    this.lastWriteAt = null;
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

  async read() {
    if (!this.properties.read) {
      throw new Error("characteristic not readable");
    }
    this.lastReadAt = Date.now();
    return this.value;
  }

  async write(data) {
    if (!this.properties.write && !this.properties.writeWithoutResponse) {
      throw new Error("characteristic not writable");
    }
    this.value = data;
    this.lastWriteAt = Date.now();
  }

  async startNotifications() {
    if (!this.properties.notify && !this.properties.indicate) {
      throw new Error("characteristic does not support notifications");
    }
    this.notifyActive = true;
  }

  async stopNotifications() {
    this.notifyActive = false;
  }

  notify(newValue) {
    this.value = newValue;
    this._emit(BT_EVENTS.GATT_VALUE_CHANGED, {
      deviceId: this.deviceId,
      serviceUuid: this.serviceUuid,
      characteristicUuid: this.uuid,
      value: newValue,
    });
  }

  snapshot() {
    return {
      uuid: this.uuid,
      name: this.name,
      properties: { ...this.properties },
      serviceUuid: this.serviceUuid,
      deviceId: this.deviceId,
      lastReadAt: this.lastReadAt,
      lastWriteAt: this.lastWriteAt,
      notifyActive: !!this.notifyActive,
      valueLength: this.value?.byteLength ?? null,
    };
  }
}

// ============================================================================
// BLUETOOTH SCANNER
// ============================================================================

class BluetoothScanner {
  constructor({ manager }) {
    this.manager = manager;
    this.scanning = false;
    this.filters = { services: [], namePrefix: null, acceptAll: true };
    this.startedAt = null;
    this.results = new Map();
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

  setFilters(filters) {
    this.filters = { ...this.filters, ...filters };
  }

  /**
   * Inicia un escaneo.
   * @param {Object} opts
   *   - useWebBluetooth: boolean — intenta con Web Bluetooth real
   *   - durationMs: cuánto dura el escaneo simulado
   *   - simulate: boolean — añade dispositivos simulados
   */
  async start({ useWebBluetooth = false, durationMs = 0, simulate = true } = {}) {
    if (this.scanning) return false;
    if (this.manager.adapter.state !== BT_STATE.ON) {
      this._emit(BT_EVENTS.LOG, {
        level: "warn",
        message: "adapter is not powered on",
      });
      return false;
    }

    this.scanning = true;
    this.startedAt = Date.now();
    this.results.clear();

    this._emit(BT_EVENTS.SCAN_STARTED, {
      filters: { ...this.filters },
    });

    if (useWebBluetooth && navigator.bluetooth?.requestDevice) {
      try {
        const device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: this.filters.acceptAll,
          optionalServices: this.filters.services,
          filters: this.filters.namePrefix
            ? [{ namePrefix: this.filters.namePrefix }]
            : undefined,
        });
        this._handleWebBluetoothDevice(device);
      } catch (err) {
        this._emit(BT_EVENTS.LOG, {
          level: "warn",
          message: `Web Bluetooth request failed: ${err.message}`,
        });
      }
    }

    // Simulación de dispositivos cercanos
    if (simulate) {
      const simulated = this._generateSimulatedDevices();
      for (const sim of simulated) {
        this.results.set(sim.id, sim);
        this._emit(BT_EVENTS.SCAN_RESULT, { device: sim });
      }
    }

    if (durationMs > 0) {
      setTimeout(() => this.stop(), durationMs);
    }

    return true;
  }

  stop() {
    if (!this.scanning) return;
    this.scanning = false;
    this._emit(BT_EVENTS.SCAN_STOPPED, {
      durationMs: Date.now() - this.startedAt,
      results: this.results.size,
    });
  }

  _handleWebBluetoothDevice(webDevice) {
    // Registrar dispositivo como "descubierto"
    this._emit(BT_EVENTS.SCAN_RESULT, {
      device: {
        id: webDevice.id,
        name: webDevice.name,
        address: webDevice.id,
        kind: BT_DEVICE_KIND.UNKNOWN,
        paired: false,
        connected: false,
        rssi: null,
        webBluetoothDevice: webDevice,
      },
    });
  }

  _generateSimulatedDevices() {
    const pool = [
      { name: "AirPods Pro", kind: BT_DEVICE_KIND.HEADPHONES, rssi: -45, manufacturer: "Apple", battery: 82 },
      { name: "Magic Keyboard", kind: BT_DEVICE_KIND.KEYBOARD, rssi: -52, manufacturer: "Apple", battery: 90 },
      { name: "Magic Mouse", kind: BT_DEVICE_KIND.MOUSE, rssi: -55, manufacturer: "Apple", battery: 45 },
      { name: "Sony WH-1000XM5", kind: BT_DEVICE_KIND.HEADPHONES, rssi: -60, manufacturer: "Sony", battery: 76 },
      { name: "JBL Flip 6", kind: BT_DEVICE_KIND.SPEAKER, rssi: -68, manufacturer: "JBL", battery: 60 },
      { name: "Xbox Controller", kind: BT_DEVICE_KIND.GAMEPAD, rssi: -72, manufacturer: "Microsoft" },
      { name: "Apple Watch", kind: BT_DEVICE_KIND.WATCH, rssi: -48, manufacturer: "Apple", battery: 68 },
      { name: "iPhone de Alex", kind: BT_DEVICE_KIND.PHONE, rssi: -58, manufacturer: "Apple", battery: 91 },
      { name: "Logitech MX Master", kind: BT_DEVICE_KIND.MOUSE, rssi: -66, manufacturer: "Logitech", battery: 55 },
      { name: "Bose QuietComfort", kind: BT_DEVICE_KIND.HEADPHONES, rssi: -70, manufacturer: "Bose", battery: 88 },
    ];

    // Elegir entre 3 y 6 aleatoriamente
    const count = 3 + Math.floor(Math.random() * 4);
    const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, count);

    return shuffled.map((item, i) => ({
      id: `bt-sim-${Date.now()}-${i}`,
      name: item.name,
      address: this._randomAddress(),
      kind: item.kind,
      paired: false,
      connected: false,
      rssi: item.rssi + Math.floor((Math.random() - 0.5) * 6),
      manufacturer: item.manufacturer,
      batteryLevel: item.battery ?? null,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    }));
  }

  _randomAddress() {
    const hex = "0123456789ABCDEF";
    return Array.from({ length: 6 }, () =>
      hex[Math.floor(Math.random() * 16)] + hex[Math.floor(Math.random() * 16)]
    ).join(":");
  }

  snapshot() {
    return {
      scanning: this.scanning,
      startedAt: this.startedAt,
      filters: { ...this.filters },
      results: Array.from(this.results.values()).map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        rssi: d.rssi,
      })),
    };
  }
}

// ============================================================================
// BLUETOOTH MANAGER
// ============================================================================

export class BluetoothManager {
  constructor({ adapterName = "rainOS BT", simulate = true } = {}) {
    this.log = new BtLog();
    this.adapter = new BluetoothAdapter({ name: adapterName });
    this.devices = new Map(); // id → BluetoothDevice
    this.pairedDevices = new Set();
    this.selectedDeviceId = null;
    this.scanner = new BluetoothScanner({ manager: this });
    this.simulate = simulate;
    this.listeners = new Set();

    this.adapter.subscribe((event, payload) => {
      this._emit(event, payload);
    });

    this.scanner.subscribe((event, payload) => {
      this._emit(event, payload);
    });

    this.stats = {
      devicesSeen: 0,
      pairingsSucceeded: 0,
      pairingsFailed: 0,
      connectionsSucceeded: 0,
      connectionsFailed: 0,
      notificationsReceived: 0,
      transfersCompleted: 0,
    };

    // Estado inicial
    this.adapter.setState(BT_STATE.OFF);
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

  // -------------------------------------------------------------- power
  async powerOn() {
    this.adapter.setState(BT_STATE.ON);
    this._log("info", "adapter powered on");

    // Enumerar dispositivos Web Bluetooth ya autorizados
    if (navigator.bluetooth?.getDevices) {
      try {
        const devices = await navigator.bluetooth.getDevices();
        for (const webDevice of devices) {
          this._addWebBluetoothDevice(webDevice);
        }
      } catch (err) {
        this._log("warn", "getDevices failed", err);
      }
    }
  }

  powerOff() {
    this.adapter.setState(BT_STATE.OFF);
    this.scanner.stop();
    this._log("info", "adapter powered off");
  }

  async togglePower() {
    if (this.adapter.state === BT_STATE.ON) {
      this.powerOff();
      return false;
    } else {
      await this.powerOn();
      return true;
    }
  }

  // -------------------------------------------------------------- devices
  addDevice(opts) {
    const device = new BluetoothDevice(opts);
    device.subscribe((event, payload) => {
      this._emit(event, payload);
    });
    this.devices.set(device.id, device);
    this.stats.devicesSeen++;
    if (device.paired) this.pairedDevices.add(device.id);
    this._emit(BT_EVENTS.DEVICE_ADDED, device.snapshot());
    this._log("info", `device added: ${device.name}`);
    return device;
  }

  _addWebBluetoothDevice(webDevice) {
    if (this.devices.has(webDevice.id)) return this.devices.get(webDevice.id);
    return this.addDevice({
      id: webDevice.id,
      name: webDevice.name || "Unknown Device",
      address: webDevice.id,
      kind: BT_DEVICE_KIND.UNKNOWN,
      paired: true, // si está en getDevices es porque el usuario ya autorizó
      connected: false,
      webBluetoothDevice: webDevice,
    });
  }

  removeDevice(id) {
    const device = this.devices.get(id);
    if (!device) return false;
    this.devices.delete(id);
    this.pairedDevices.delete(id);
    if (this.selectedDeviceId === id) this.selectedDeviceId = null;
    this._emit(BT_EVENTS.DEVICE_REMOVED, { deviceId: id });
    return true;
  }

  getDevice(id) {
    return this.devices.get(id) ?? null;
  }

  listDevices() {
    return Array.from(this.devices.values()).map((d) => d.snapshot());
  }

  listPaired() {
    return Array.from(this.devices.values())
      .filter((d) => d.paired)
      .map((d) => d.snapshot());
  }

  listConnected() {
    return Array.from(this.devices.values())
      .filter((d) => d.connected)
      .map((d) => d.snapshot());
  }

  selectDevice(id) {
    if (!this.devices.has(id)) return false;
    this.selectedDeviceId = id;
    this._emit(BT_EVENTS.DEVICE_SELECTED, { deviceId: id });
    return true;
  }

  getSelectedDevice() {
    return this.selectedDeviceId ? this.devices.get(this.selectedDeviceId) : null;
  }

  // -------------------------------------------------------------- pairing
  /**
   * Empareja un dispositivo. Si es un Web Bluetooth device, hace el pairing real.
   * Si no, simula el proceso con diferentes mecanismos.
   */
  async pair(deviceId, { pin = null, passkey = null, confirm = null } = {}) {
    const device = this.devices.get(deviceId);
    if (!device) return { ok: false, error: "device-not-found" };
    if (device.paired) return { ok: true, alreadyPaired: true };

    this._emit(BT_EVENTS.PAIR_STARTED, { deviceId });

    // Web Bluetooth real
    if (device.webBluetoothDevice && navigator.bluetooth?.requestDevice) {
      try {
        await device.webBluetoothDevice.watchAdvertisements?.();
        device.setPairingState(BT_PAIRING_STATE.PAIRED);
        this.pairedDevices.add(deviceId);
        this.stats.pairingsSucceeded++;
        this._emit(BT_EVENTS.PAIR_SUCCEEDED, { deviceId, method: "web-bluetooth" });
        return { ok: true, method: "web-bluetooth" };
      } catch (err) {
        this.stats.pairingsFailed++;
        this._emit(BT_EVENTS.PAIR_FAILED, { deviceId, error: String(err) });
        return { ok: false, error: String(err) };
      }
    }

    // Simulación de pairing
    device.setPairingState(BT_PAIRING_STATE.PAIRING);

    // Elegir método de pairing según tipo de dispositivo
    const method = this._choosePairingMethod(device);

    await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));

    switch (method) {
      case "just-works":
        // Sin interacción
        break;
      case "pin": {
        if (pin == null) {
          this._emit(BT_EVENTS.PAIR_PIN_REQUIRED, { deviceId });
          return { ok: false, pending: true, method, pinRequired: true };
        }
        if (pin !== "0000" && pin !== "1234") {
          this.stats.pairingsFailed++;
          device.setPairingState(BT_PAIRING_STATE.FAILED);
          this._emit(BT_EVENTS.PAIR_FAILED, { deviceId, error: "wrong pin" });
          return { ok: false, error: "wrong pin" };
        }
        break;
      }
      case "passkey": {
        if (passkey == null) {
          const generated = String(Math.floor(100000 + Math.random() * 900000));
          this._emit(BT_EVENTS.PAIR_PASSKEY_REQUIRED, { deviceId, passkey: generated });
          return { ok: false, pending: true, method, passkey: generated };
        }
        break;
      }
      case "confirm": {
        if (confirm == null) {
          this._emit(BT_EVENTS.PAIR_CONFIRM_REQUIRED, { deviceId });
          return { ok: false, pending: true, method, confirmRequired: true };
        }
        if (!confirm) {
          this.stats.pairingsFailed++;
          device.setPairingState(BT_PAIRING_STATE.FAILED);
          return { ok: false, error: "pairing rejected by user" };
        }
        break;
      }
    }

    device.setPairingState(BT_PAIRING_STATE.PAIRED);
    this.pairedDevices.add(deviceId);
    this.stats.pairingsSucceeded++;
    this._emit(BT_EVENTS.PAIR_SUCCEEDED, { deviceId, method });
    this._log("info", `paired: ${device.name} via ${method}`);

    return { ok: true, method };
  }

  unpair(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    if (!device.paired) return false;

    // Desconectar si está conectado
    if (device.connected) this.disconnect(deviceId);

    device.paired = false;
    device.setPairingState(BT_PAIRING_STATE.NONE);
    device.pairedAt = null;
    this.pairedDevices.delete(deviceId);

    this._emit(BT_EVENTS.DEVICE_UPDATED, { deviceId, paired: false });
    this._log("info", `unpaired: ${device.name}`);
    return true;
  }

  _choosePairingMethod(device) {
    switch (device.kind) {
      case BT_DEVICE_KIND.KEYBOARD:
      case BT_DEVICE_KIND.MOUSE:
      case BT_DEVICE_KIND.TRACKPAD:
        return "pin";
      case BT_DEVICE_KIND.WATCH:
      case BT_DEVICE_KIND.PHONE:
        return "confirm";
      case BT_DEVICE_KIND.HEADPHONES:
      case BT_DEVICE_KIND.SPEAKER:
        return "just-works";
      default:
        return "confirm";
    }
  }

  // -------------------------------------------------------------- connection
  async connect(deviceId, { profiles = [] } = {}) {
    const device = this.devices.get(deviceId);
    if (!device) return { ok: false, error: "device-not-found" };
    if (!device.paired) return { ok: false, error: "not-paired" };
    if (device.connected) return { ok: true, alreadyConnected: true };

    this._emit(BT_EVENTS.CONNECT_STARTED, { deviceId });
    device.setConnectionState(BT_CONNECTION.CONNECTING);

    try {
      // Web Bluetooth: conectar al servidor GATT
      if (device.webBluetoothDevice?.gatt && navigator.bluetooth) {
        try {
          const server = await device.webBluetoothDevice.gatt.connect();
          device.gattServer = server;
          await this._discoverGattServices(device);
        } catch (err) {
          this._log("warn", `GATT connect failed: ${err.message}`);
        }
      }

      // Simular latencia si es un dispositivo simulado
      if (!device.webBluetoothDevice) {
        await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
      }

      device.setConnectionState(BT_CONNECTION.CONNECTED);

      // Añadir profiles
      const defaultProfiles = profiles.length > 0
        ? profiles
        : this._defaultProfilesFor(device.kind);
      for (const profile of defaultProfiles) {
        device.addProfile(profile);
      }

      this.stats.connectionsSucceeded++;
      this._emit(BT_EVENTS.CONNECT_SUCCEEDED, { deviceId });
      this._log("info", `connected: ${device.name}`);
      return { ok: true };
    } catch (err) {
      device.setConnectionState(BT_CONNECTION.FAILED);
      this.stats.connectionsFailed++;
      this._emit(BT_EVENTS.CONNECT_FAILED, { deviceId, error: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  disconnect(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    if (!device.connected) return false;

    device.setConnectionState(BT_CONNECTION.DISCONNECTING);

    try {
      device.gattServer?.disconnect?.();
    } catch {}

    device.setConnectionState(BT_CONNECTION.DISCONNECTED);
    device.profiles.clear();

    this._emit(BT_EVENTS.DISCONNECTED, { deviceId });
    this._log("info", `disconnected: ${device.name}`);
    return true;
  }

  _defaultProfilesFor(kind) {
    switch (kind) {
      case BT_DEVICE_KIND.HEADPHONES:
        return [BT_PROFILE.A2DP, BT_PROFILE.AVRCP, BT_PROFILE.HFP];
      case BT_DEVICE_KIND.SPEAKER:
        return [BT_PROFILE.A2DP, BT_PROFILE.AVRCP];
      case BT_DEVICE_KIND.KEYBOARD:
        return [BT_PROFILE.HID, BT_PROFILE.HOGP];
      case BT_DEVICE_KIND.MOUSE:
      case BT_DEVICE_KIND.TRACKPAD:
        return [BT_PROFILE.HID, BT_PROFILE.HOGP];
      case BT_DEVICE_KIND.GAMEPAD:
        return [BT_PROFILE.HID];
      case BT_DEVICE_KIND.WATCH:
        return [BT_PROFILE.GATT, BT_PROFILE.ANCS, BT_PROFILE.BAS];
      case BT_DEVICE_KIND.PHONE:
        return [BT_PROFILE.PAN, BT_PROFILE.MAP, BT_PROFILE.PBAP, BT_PROFILE.ANCS];
      case BT_DEVICE_KIND.HEART_RATE:
        return [BT_PROFILE.GATT, BT_PROFILE.HRS];
      default:
        return [BT_PROFILE.GATT];
    }
  }

  // -------------------------------------------------------------- GATT
  async _discoverGattServices(device) {
    if (!device.gattServer) return;
    try {
      const services = await device.gattServer.getPrimaryServices();
      for (const service of services) {
        const gattService = new GattService({
          uuid: service.uuid,
          name: this._gattName(service.uuid),
          primary: true,
          deviceId: device.id,
        });
        device.services.set(service.uuid, gattService);
        this._emit(BT_EVENTS.GATT_SERVICE_FOUND, {
          deviceId: device.id,
          serviceUuid: service.uuid,
          name: gattService.name,
        });

        try {
          const characteristics = await service.getCharacteristics();
          for (const char of characteristics) {
            const gattChar = new GattCharacteristic({
              uuid: char.uuid,
              name: this._gattName(char.uuid),
              properties: char.properties,
              serviceUuid: service.uuid,
              deviceId: device.id,
              _bluetoothChar: char,
            });
            gattService.addCharacteristic(gattChar);
            device.characteristics.set(char.uuid, gattChar);
            this._emit(BT_EVENTS.GATT_CHARACTERISTIC_FOUND, {
              deviceId: device.id,
              serviceUuid: service.uuid,
              characteristicUuid: char.uuid,
              properties: char.properties,
            });
          }
        } catch (err) {
          this._log("warn", `characteristic discovery failed: ${err.message}`);
        }
      }
    } catch (err) {
      this._log("warn", `service discovery failed: ${err.message}`);
    }
  }

  _gattName(uuid) {
    const known = {
      "1800": "Generic Access",
      "1801": "Generic Attribute",
      "1804": "Tx Power",
      "1805": "Current Time",
      "180a": "Device Information",
      "180d": "Heart Rate",
      "180f": "Battery Service",
      "1812": "HID",
      "181c": "User Data",
      "2a19": "Battery Level",
      "2a00": "Device Name",
      "2a01": "Appearance",
      "2a29": "Manufacturer Name",
      "2a24": "Model Number",
      "2a26": "Firmware Revision",
      "2a37": "Heart Rate Measurement",
      "2a38": "Body Sensor Location",
    };
    const key = uuid.replace(/-/g, "").slice(0, 4).toLowerCase();
    return known[key] || uuid;
  }

  // -------------------------------------------------------------- notifications
  /**
   * Simula la recepción de una notificación ANCS.
   */
  notifyIncoming({ deviceId, title, body, app = "Sistema" }) {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    device.stats.notificationsReceived++;
    this.stats.notificationsReceived++;
    this._emit(BT_EVENTS.NOTIFICATION_RECEIVED, {
      deviceId,
      title,
      body,
      app,
      ts: Date.now(),
    });
    return true;
  }

  // -------------------------------------------------------------- transfers
  async transferFile({ deviceId, name, size, direction = "out" }) {
    const device = this.devices.get(deviceId);
    if (!device) return { ok: false, error: "device-not-found" };
    if (!device.connected) return { ok: false, error: "not-connected" };

    this._emit(BT_EVENTS.TRANSFER_STARTED, { deviceId, name, size, direction });

    // Simular transferencia con progreso
    const chunks = 20;
    for (let i = 1; i <= chunks; i++) {
      await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));
      this._emit(BT_EVENTS.TRANSFER_PROGRESS, {
        deviceId,
        name,
        progress: i / chunks,
        bytesTransferred: Math.round((i / chunks) * size),
        size,
      });
    }

    if (direction === "out") device.stats.bytesSent += size;
    else device.stats.bytesReceived += size;

    this.stats.transfersCompleted++;
    this._emit(BT_EVENTS.TRANSFER_COMPLETED, { deviceId, name, size, direction });
    return { ok: true };
  }

  // -------------------------------------------------------------- snapshot
  snapshot() {
    return {
      adapter: this.adapter.snapshot(),
      devices: this.listDevices(),
      paired: this.listPaired(),
      connected: this.listConnected(),
      selectedDeviceId: this.selectedDeviceId,
      scanner: this.scanner.snapshot(),
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// PROVIDER + HOOK
// ============================================================================

const BluetoothContext = React.createContext(null);

export function BluetoothProvider({
  children,
  manager: external,
  autoPowerOn = true,
  adapterName = "rainOS BT",
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new BluetoothManager({ adapterName });
  }
  const manager = ref.current;
  const [snapshot, setSnapshot] = useState(() => manager.snapshot());

  useEffect(() => {
    const unsub = manager.subscribe(() => setSnapshot(manager.snapshot()));
    if (autoPowerOn) manager.powerOn();
    return () => unsub();
  }, [manager, autoPowerOn]);

  const api = useMemo(
    () => ({
      manager,
      snapshot,

      powerOn: () => manager.powerOn(),
      powerOff: () => manager.powerOff(),
      togglePower: () => manager.togglePower(),
      setName: (name) => manager.adapter.setName(name),
      setDiscoverable: (enabled, timeoutMs) =>
        manager.adapter.setDiscoverable(enabled, timeoutMs),

      startScan: (opts) => manager.scanner.start(opts),
      stopScan: () => manager.scanner.stop(),
      setScanFilters: (filters) => manager.scanner.setFilters(filters),

      addDevice: (opts) => manager.addDevice(opts),
      removeDevice: (id) => manager.removeDevice(id),
      getDevice: (id) => manager.getDevice(id),
      listDevices: () => manager.listDevices(),
      listPaired: () => manager.listPaired(),
      listConnected: () => manager.listConnected(),
      selectDevice: (id) => manager.selectDevice(id),
      getSelectedDevice: () => manager.getSelectedDevice(),

      pair: (deviceId, opts) => manager.pair(deviceId, opts),
      unpair: (deviceId) => manager.unpair(deviceId),

      connect: (deviceId, opts) => manager.connect(deviceId, opts),
      disconnect: (deviceId) => manager.disconnect(deviceId),

      notifyIncoming: (opts) => manager.notifyIncoming(opts),
      transferFile: (opts) => manager.transferFile(opts),
    }),
    [manager, snapshot]
  );

  return (
    <BluetoothContext.Provider value={api}>
      {children}
    </BluetoothContext.Provider>
  );
}

export function useBluetooth() {
  const ctx = React.useContext(BluetoothContext);
  if (!ctx) throw new Error("useBluetooth must be used within BluetoothProvider");
  return ctx;
}

export default {
  BluetoothManager,
  BluetoothAdapter,
  BluetoothDevice,
  BluetoothScanner,
  GattService,
  GattCharacteristic,
  BluetoothProvider,
  useBluetooth,
  BT_STATE,
  BT_DEVICE_KIND,
  BT_PROFILE,
  BT_CONNECTION,
  BT_PAIRING_STATE,
  BT_EVENTS,
};
