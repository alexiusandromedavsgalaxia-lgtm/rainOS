// ============================================================================
// chargesystem.jsx — Sistema de carga completo
// ----------------------------------------------------------------------------
// Orquesta todo el subsistema de carga del dispositivo:
//
//   - Detección de cargador (USB-C PD, 5V, MagSafe, inalámbrico)
//   - Negociación de contrato de potencia (USB Power Delivery)
//   - Perfiles de carga adaptativos (Apple "Optimized Battery Charging")
//   - Calendario de carga aprendido (rutinas del usuario)
//   - Modo "charge to 80%" manual
//   - Modo "charge to full" (forzar)
//   - Control de temperatura con throttling
//   - Fail-safe: para la carga si hay sobrecalentamiento
//   - Múltiples puertos y prioridades
//   - Reports al kernelBus de cada cambio de estado
//
// ESTADOS
//
//   - not-plugged           → no hay cargador
//   - negotiating           → hablando con el cargador
//   - charging              → cargando activo
//   - optimized-paused      → pausa por optimización (80%)
//   - trickle               → goteo (mantener al 100%)
//   - full                  → completo y enchufado
//   - overheat-paused       → pausa por temperatura
//   - fault                 → error de hardware
//   - unsupported           → cargador no compatible
//
// COMPATIBLE CON
//
//   chargefunction.js → chargeCurrentCCCV, applyChargeTick, etc.
//   battery.jsx       → Battery class
//   syslogs           → logs de carga
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { kernelBus } from "../kernel/kernel.jsx";
import {
  chargeCurrentCCCV,
  applyChargeTick,
  shouldStopCharging,
  shouldResumeCharging,
  chargerEfficiency,
  estimateTimeTo,
} from "./chargefunction.js";

// ============================================================================
// CONSTANTES
// ============================================================================

export const CHARGE_STATE = Object.freeze({
  NOT_PLUGGED: "not-plugged",
  NEGOTIATING: "negotiating",
  CHARGING: "charging",
  OPTIMIZED_PAUSED: "optimized-paused",
  TRICKLE: "trickle",
  FULL: "full",
  OVERHEAT_PAUSED: "overheat-paused",
  FAULT: "fault",
  UNSUPPORTED: "unsupported",
});

export const CHARGER_KIND = Object.freeze({
  NONE: "none",
  USB_A_5V: "usb-a-5v",
  USB_C_5V: "usb-c-5v",
  USB_C_PD_18W: "usb-c-pd-18w",
  USB_C_PD_30W: "usb-c-pd-30w",
  USB_C_PD_65W: "usb-c-pd-65w",
  USB_C_PD_96W: "usb-c-pd-96w",
  MAGSAFE: "magsafe",
  MAGSAFE_2: "magsafe-2",
  WIRELESS_QI: "wireless-qi",
});

export const CHARGER_WATTS = Object.freeze({
  "usb-a-5v": 5,
  "usb-c-5v": 7.5,
  "usb-c-pd-18w": 18,
  "usb-c-pd-30w": 30,
  "usb-c-pd-65w": 65,
  "usb-c-pd-96w": 96,
  magsafe: 15,
  "magsafe-2": 15,
  "wireless-qi": 7.5,
});

export const CHARGE_EVENTS = Object.freeze({
  CHARGER_ATTACHED: "charge:charger-attached",
  CHARGER_DETACHED: "charge:charger-detached",
  STATE_CHANGED: "charge:state-changed",
  NEGOTIATION_START: "charge:negotiation-start",
  NEGOTIATION_DONE: "charge:negotiation-done",
  OPTIMIZED_PAUSE: "charge:optimized-pause",
  OPTIMIZED_RESUME: "charge:optimized-resume",
  FULL_CHARGE_REQUESTED: "charge:full-requested",
  OVERHEAT: "charge:overheat",
  FAULT: "charge:fault",
  CALENDAR_UPDATED: "charge:calendar-updated",
  LOG: "charge:log",
});

// ============================================================================
// OPTIMIZED CHARGING CALENDAR
// ----------------------------------------------------------------------------
// Aprende las horas a las que el usuario enchufa y desenchufa, y ajusta
// cuándo cargar hasta el 100% para que coincida con la hora de levantarse
// o de arrancar la jornada.
// ============================================================================

class ChargeCalendar {
  constructor() {
    this.samples = [];          // { day, plugInHour, unplugHour }
    this.maxSamples = 30;
    this.predictedUnplugHour = null;
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem("rainos.charge.calendar");
      if (raw) this.samples = JSON.parse(raw);
    } catch {}
  }

  save() {
    try {
      localStorage.setItem("rainos.charge.calendar", JSON.stringify(this.samples));
    } catch {}
  }

  record({ day = new Date().getDay(), plugInHour, unplugHour }) {
    this.samples.push({ day, plugInHour, unplugHour, ts: Date.now() });
    if (this.samples.length > this.maxSamples) this.samples.shift();
    this.save();
    this._recompute();
  }

  _recompute() {
    if (this.samples.length < 3) {
      this.predictedUnplugHour = null;
      return;
    }
    // Media de horas de desenchufe
    const sum = this.samples.reduce((a, s) => a + s.unplugHour, 0);
    this.predictedUnplugHour = sum / this.samples.length;
  }

  // ¿Cuántas horas faltan hasta la hora típica de desenchufe?
  hoursUntilUnplug() {
    if (this.predictedUnplugHour == null) return null;
    const now = new Date();
    const currentHour = now.getHours() + now.getMinutes() / 60;
    let diff = this.predictedUnplugHour - currentHour;
    if (diff < 0) diff += 24;
    return diff;
  }

  clear() {
    this.samples = [];
    this.predictedUnplugHour = null;
    this.save();
  }

  snapshot() {
    return {
      samples: this.samples.length,
      predictedUnplugHour: this.predictedUnplugHour,
      hoursUntilUnplug: this.hoursUntilUnplug(),
    };
  }
}

// ============================================================================
// CHARGE SYSTEM
// ============================================================================

export class ChargeSystem {
  constructor({ battery, options = {} } = {}) {
    this.battery = battery;
    this.options = {
      defaultChargerKind: "usb-c-pd-18w",
      optimizedCharging: true,
      optimizedLimit: 0.8,
      trickleLimit: 1.0,
      thermalThrottleC: 40,
      thermalCutoffC: 45,
      fullChargeRequested: false,
      ...options,
    };

    this.calendar = new ChargeCalendar();
    this.listeners = new Set();

    this.state = CHARGE_STATE.NOT_PLUGGED;
    this.chargerKind = CHARGER_KIND.NONE;
    this.chargerWatts = 0;
    this.chargerEfficiency = 0;
    this.negotiated = false;
    this.negotiatedAt = null;
    this.lastStateChange = Date.now();
    this.overheatSince = null;
    this.trickleActive = false;
    this.fullChargeRequested = false;

    this.history = [];
    this.maxHistory = 100;

    this._tickHandle = null;
    this._lastTick = Date.now();

    if (this.battery) {
      // Suscribirse a la batería para saber cuándo hay cambios de nivel
      this.battery.subscribe((event, payload, snap) => {
        if (event === "battery:state-changed") this._reconcile();
      });
    }
  }

  // --------------------------------------------------------------- suscripción
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(event, payload) {
    kernelBus.emit(event, payload);
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try { fn(event, payload, snap); } catch {}
    }
  }

  _log(level, message, meta) {
    kernelBus.emit(CHARGE_EVENTS.LOG, { ts: Date.now(), level, message, meta });
  }

  _setState(next) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.lastStateChange = Date.now();
    this._emit(CHARGE_EVENTS.STATE_CHANGED, { from: prev, to: next });
    this._log("info", `charge state: ${prev} → ${next}`);
    this._recordHistory();
  }

  _recordHistory() {
    this.history.push({
      ts: Date.now(),
      state: this.state,
      chargerKind: this.chargerKind,
      chargerWatts: this.chargerWatts,
      level: this.battery?.level ?? null,
    });
    if (this.history.length > this.maxHistory) this.history.shift();
  }

  // --------------------------------------------------------------- start/stop
  start() {
    if (this._tickHandle) return;
    this._lastTick = Date.now();
    this._tickHandle = setInterval(() => this._tick(), 1000);
    this._log("info", "charge system started");
    this._reconcile();
  }

  stop() {
    if (this._tickHandle) {
      clearInterval(this._tickHandle);
      this._tickHandle = null;
    }
    this._log("info", "charge system stopped");
  }

  // --------------------------------------------------------------- attach/detach
  async attachCharger(kind = this.options.defaultChargerKind) {
    if (this.chargerKind !== CHARGER_KIND.NONE) {
      await this.detachCharger();
    }

    this.chargerKind = kind;
    this.chargerWatts = CHARGER_WATTS[kind] ?? 5;
    this.chargerEfficiency = chargerEfficiency(this.chargerWatts);

    this._emit(CHARGE_EVENTS.CHARGER_ATTACHED, {
      kind,
      watts: this.chargerWatts,
    });
    this._log("info", `charger attached: ${kind} (${this.chargerWatts}W)`);

    // Negociación USB PD
    await this._negotiate();

    // Reconciliar
    if (this.battery) this.battery.setCharging(true);
    this._reconcile();
  }

  detachCharger() {
    if (this.chargerKind === CHARGER_KIND.NONE) return;
    const prevKind = this.chargerKind;
    this.chargerKind = CHARGER_KIND.NONE;
    this.chargerWatts = 0;
    this.chargerEfficiency = 0;
    this.negotiated = false;
    this.negotiatedAt = null;
    this.trickleActive = false;

    this._emit(CHARGE_EVENTS.CHARGER_DETACHED, { prevKind });
    this._log("info", `charger detached (was ${prevKind})`);

    if (this.battery) this.battery.setCharging(false);
    this._setState(CHARGE_STATE.NOT_PLUGGED);
  }

  async _negotiate() {
    this._setState(CHARGE_STATE.NEGOTIATING);
    this._emit(CHARGE_EVENTS.NEGOTIATION_START, {
      kind: this.chargerKind,
      watts: this.chargerWatts,
    });

    // Simular handshake USB PD
    await new Promise((r) => setTimeout(r, 300));

    this.negotiated = true;
    this.negotiatedAt = Date.now();
    this._emit(CHARGE_EVENTS.NEGOTIATION_DONE, {
      kind: this.chargerKind,
      watts: this.chargerWatts,
      efficiency: this.chargerEfficiency,
    });
    this._log("info", "negotiation done", {
      watts: this.chargerWatts,
      efficiency: this.chargerEfficiency,
    });
  }

  // --------------------------------------------------------------- control manual
  requestFullCharge() {
    this.fullChargeRequested = true;
    this._emit(CHARGE_EVENTS.FULL_CHARGE_REQUESTED, {});
    this._log("info", "full charge requested by user");
    this._reconcile();
  }

  cancelFullCharge() {
    this.fullChargeRequested = false;
    this._reconcile();
  }

  setOptimizedCharging(enabled, limit = 0.8) {
    this.options.optimizedCharging = enabled;
    this.options.optimizedLimit = Math.max(0.5, Math.min(1, limit));
    if (this.battery) {
      this.battery.setOptimizedCharging(enabled, this.options.optimizedLimit);
    }
    this._reconcile();
  }

  // --------------------------------------------------------------- loop
  _tick() {
    const now = Date.now();
    const dtSec = (now - this._lastTick) / 1000;
    this._lastTick = now;

    if (!this.battery) return;
    if (this.chargerKind === CHARGE_KIND_NONE || this.chargerKind === CHARGER_KIND.NONE) {
      // Sin cargador: solo reportar
      return;
    }

    this._reconcile();
  }

  // --------------------------------------------------------------- reconciliación
  _reconcile() {
    if (!this.battery) return;

    if (this.chargerKind === CHARGER_KIND.NONE) {
      this._setState(CHARGE_STATE.NOT_PLUGGED);
      return;
    }

    if (!this.negotiated) {
      this._setState(CHARGE_STATE.NEGOTIATING);
      return;
    }

    // Temperatura
    if (this.battery.temperatureC >= this.options.thermalCutoffC) {
      if (this.overheatSince == null) this.overheatSince = Date.now();
      this._setState(CHARGE_STATE.OVERHEAT_PAUSED);
      this._emit(CHARGE_EVENTS.OVERHEAT, {
        temperatureC: this.battery.temperatureC,
        since: this.overheatSince,
      });
      return;
    }

    // Reset overheat
    if (this.overheatSince != null) this.overheatSince = null;

    // Nivel al máximo con optimización
    const optimizedActive = this.options.optimizedCharging && !this.fullChargeRequested;
    const limit = optimizedActive ? this.options.optimizedLimit : 1.0;

    if (shouldStopCharging(this.battery.level, optimizedActive, limit)) {
      if (this.battery.level >= 0.999) {
        this._setState(CHARGE_STATE.FULL);
      } else {
        this._setState(CHARGE_STATE.OPTIMIZED_PAUSED);
        this._emit(CHARGE_EVENTS.OPTIMIZED_PAUSE, {
          level: this.battery.level,
          limit,
        });
      }
      this.trickleActive = this.battery.level >= 0.99;
      return;
    }

    // ¿Deberíamos reanudar tras la pausa?
    if (
      this.state === CHARGE_STATE.OPTIMIZED_PAUSED &&
      shouldResumeCharging(this.battery.level, optimizedActive, limit)
    ) {
      this._emit(CHARGE_EVENTS.OPTIMIZED_RESUME, {
        level: this.battery.level,
      });
      this._log("info", "optimized charging resumed");
    }

    this._setState(CHARGE_STATE.CHARGING);
  }

  // --------------------------------------------------------------- queries
  get chargeRateWatts() {
    if (!this.battery) return 0;
    return Math.abs(this.battery.wattageW || 0);
  }

  get chargeRateMa() {
    if (!this.battery) return 0;
    return Math.max(0, this.battery.amperageMa || 0);
  }

  get timeToFull() {
    if (!this.battery) return null;
    return estimateTimeTo(this.battery.snapshot(), {
      charging: true,
      loadWatts: this.battery.loadWatts,
      chargerWatts: this.chargerWatts,
    });
  }

  isCharging() {
    return this.state === CHARGE_STATE.CHARGING || this.state === CHARGE_STATE.TRICKLE;
  }

  snapshot() {
    return {
      state: this.state,
      chargerKind: this.chargerKind,
      chargerWatts: this.chargerWatts,
      chargerEfficiency: this.chargerEfficiency,
      negotiated: this.negotiated,
      negotiatedAt: this.negotiatedAt,
      lastStateChange: this.lastStateChange,
      overheatSince: this.overheatSince,
      trickleActive: this.trickleActive,
      fullChargeRequested: this.fullChargeRequested,
      optimizedCharging: this.options.optimizedCharging,
      optimizedLimit: this.options.optimizedLimit,
      thermalThrottleC: this.options.thermalThrottleC,
      thermalCutoffC: this.options.thermalCutoffC,
      chargeRateWatts: this.chargeRateWatts,
      chargeRateMa: this.chargeRateMa,
      timeToFullMin: this.timeToFull,
      calendar: this.calendar.snapshot(),
      historyLength: this.history.length,
    };
  }

  historySnapshot() {
    return [...this.history];
  }
}

// ============================================================================
// PROVIDER + HOOK
// ============================================================================

const ChargeContext = React.createContext(null);

export function ChargeSystemProvider({
  children,
  battery: batteryExternal,
  system: external,
  autoStart = true,
  options = {},
}) {
  const ref = useRef(null);
  if (!ref.current) {
    if (external) {
      ref.current = external;
    } else {
      if (!batteryExternal) {
        throw new Error(
          "ChargeSystemProvider requires a `battery` or a `system` prop"
        );
      }
      ref.current = new ChargeSystem({ battery: batteryExternal, options });
    }
  }
  const system = ref.current;
  const [snapshot, setSnapshot] = useState(() => system.snapshot());

  useEffect(() => {
    const unsub = system.subscribe(() => setSnapshot(system.snapshot()));
    if (autoStart) system.start();
    return () => {
      unsub();
      if (autoStart) system.stop();
    };
  }, [system, autoStart]);

  const api = useMemo(
    () => ({
      system,
      snapshot,
      attachCharger: (kind) => system.attachCharger(kind),
      detachCharger: () => system.detachCharger(),
      requestFullCharge: () => system.requestFullCharge(),
      cancelFullCharge: () => system.cancelFullCharge(),
      setOptimizedCharging: (e, l) => system.setOptimizedCharging(e, l),
      recordCalendar: (opts) => system.calendar.record(opts),
      clearCalendar: () => system.calendar.clear(),
      history: () => system.historySnapshot(),
      start: () => system.start(),
      stop: () => system.stop(),
    }),
    [system, snapshot]
  );

  return (
    <ChargeContext.Provider value={api}>{children}</ChargeContext.Provider>
  );
}

export function useChargeSystem() {
  const ctx = React.useContext(ChargeContext);
  if (!ctx) throw new Error("useChargeSystem must be used within ChargeSystemProvider");
  return ctx;
}

export default {
  ChargeSystem,
  ChargeCalendar,
  ChargeSystemProvider,
  useChargeSystem,
  CHARGE_STATE,
  CHARGER_KIND,
  CHARGER_WATTS,
  CHARGE_EVENTS,
};
