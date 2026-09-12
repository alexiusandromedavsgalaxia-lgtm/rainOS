// ============================================================================
// battery.jsx — Subsistema de batería
// ----------------------------------------------------------------------------
// Modela la batería del dispositivo virtual con física realista:
//
//   - Capacidad nominal (mAh) y capacidad actual (design capacity vs actual)
//   - Nivel actual (0..1) y porcentaje
//   - Estado: charging, discharging, full, not-charging, unknown
//   - Ciclos de carga
//   - Salud (health) = actual capacity / design capacity
//   - Temperatura (°C)
//   - Voltaje (mV)
//   - Corriente (mA) — positiva carga, negativa descarga
//   - Potencia (W)
//   - Tiempo restante (min) para carga/descarga
//   - Modo de bajo consumo
//   - Optimización de carga (80% stop)
//   - Alertas: nivel bajo (20%), crítico (5%), salud degradada (<80%)
//
// SIMULACIÓN
//
//   - Consumo estimado según procesos corriendo (QoS del scheduler)
//   - Carga según eficiencia del cargador (por defecto 85%)
//   - Degradación de capacidad según ciclos (0.02% por ciclo)
//   - Curva de voltaje realista (Li-ion)
//   - Temperatura sube con carga rápida y con CPU alta
//   - Reporta eventos al kernelBus
//
// API
//
//   - getSnapshot() → estado completo
//   - setCharging(bool) → enchufar/desenchufar
//   - setLevel(pct) → forzar nivel (debug)
//   - setLowPowerMode(bool)
//   - setOptimizedCharging(bool, {limit: 0.8})
//   - subscribe(fn) → stream de actualizaciones
//   - reset()
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

export const BATTERY_STATE = Object.freeze({
  UNKNOWN: "unknown",
  CHARGING: "charging",
  DISCHARGING: "discharging",
  FULL: "full",
  NOT_CHARGING: "not-charging",
});

export const BATTERY_EVENTS = Object.freeze({
  STATE_CHANGED: "battery:state-changed",
  LEVEL_CHANGED: "battery:level-changed",
  LOW_BATTERY: "battery:low",
  CRITICAL_BATTERY: "battery:critical",
  FULLY_CHARGED: "battery:full",
  PLUGGED: "battery:plugged",
  UNPLUGGED: "battery:unplugged",
  HEALTH_DEGRADED: "battery:health-degraded",
  TEMPERATURE_WARNING: "battery:temperature-warning",
  OVERHEAT: "battery:overheat",
  LOW_POWER_MODE_CHANGED: "battery:lpm-changed",
  OPTIMIZED_CHARGING_CHANGED: "battery:opt-charging-changed",
  CYCLE_INCREASED: "battery:cycle",
  LOG: "battery:log",
});

export const BATTERY_DEFAULTS = Object.freeze({
  designCapacityMah: 8756,      // iPad 9ª gen tiene ~8756 mAh
  currentCapacityMah: 8130,     // ~93% salud
  maxVoltageMv: 4350,
  minVoltageMv: 3000,
  nominalVoltageMv: 3860,
  cycleCount: 187,
  maxCycles: 1000,
  lowThreshold: 0.2,
  criticalThreshold: 0.05,
  temperatureWarningC: 40,
  temperatureCriticalC: 45,
  chargerEfficiency: 0.85,
  tickIntervalMs: 1000,
});

// ============================================================================
// HELPERS
// ============================================================================

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

function levelToVoltage(level, design) {
  // Curva no-lineal Li-ion: casi plana entre 20-80%, cae rápido en extremos
  const min = design.minVoltageMv;
  const max = design.maxVoltageMv;
  let t = clamp(level, 0, 1);
  // Comprimir extremos
  if (t < 0.1) t = t * 0.5;
  else if (t > 0.9) t = 0.95 + (t - 0.9) * 0.5;
  return Math.round(lerp(min, max, t));
}

function formatDuration(minutes) {
  if (!isFinite(minutes) || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  return { hours: h, minutes: m, text: `${h}h ${String(m).padStart(2, "0")}m` };
}

// ============================================================================
// BATERÍA (clase pura)
// ============================================================================

let _batteryIdCounter = 0;

export class Battery {
  constructor(options = {}) {
    this.id = ++_batteryIdCounter;
    this.design = { ...BATTERY_DEFAULTS, ...options };

    // Estado físico
    this.capacityMah = this.design.currentCapacityMah;
    this.level = options.initialLevel ?? 0.78;
    this.state = BATTERY_STATE.DISCHARGING;
    this.plugged = false;
    this.charging = false;
    this.fullAt = null; // timestamp cuando llegó al 100%

    // Batería
    this.cycleCount = this.design.cycleCount;
    this.temperatureC = options.initialTemperature ?? 26;
    this.voltageMv = levelToVoltage(this.level, this.design);
    this.amperageMa = -450; // descarga por defecto
    this.wattageW = 0;

    // Modos
    this.lowPowerMode = false;
    this.optimizedCharging = true;
    this.optimizedChargingLimit = 0.8;

    // Estimaciones
    this.estimatedDischargeMinutes = 0;
    this.estimatedChargeMinutes = 0;

    // Alertas
    this.alerts = {
      low: false,
      critical: false,
      healthDegraded: false,
      temperatureWarning: false,
      overheat: false,
    };

    // Historial
    this.history = [];
    this.maxHistory = 200;

    // Subscribers
    this.listeners = new Set();

    // Loop
    this._handle = null;
    this._lastTick = Date.now();

    // Consumo base según procesos (se ajusta con setLoad)
    this.loadWatts = 4.5; // vatios por defecto

    this._log("info", "battery initialized", this.snapshot());
  }

  // ------------------------------------------------------------- suscripción
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
    kernelBus.emit(BATTERY_EVENTS.LOG, {
      ts: Date.now(),
      level,
      message,
      meta,
    });
  }

  // ------------------------------------------------------------- start/stop
  start() {
    if (this._handle) return;
    this._lastTick = Date.now();
    this._handle = setInterval(() => this._tick(), this.design.tickIntervalMs);
    this._log("info", "battery tick started");
  }

  stop() {
    if (this._handle) {
      clearInterval(this._handle);
      this._handle = null;
    }
    this._log("info", "battery tick stopped");
  }

  // ------------------------------------------------------------- API pública
  setCharging(plugged) {
    if (this.plugged === plugged) return;
    this.plugged = plugged;
    if (plugged) {
      this.state = this.level >= 1 ? BATTERY_STATE.FULL : BATTERY_STATE.CHARGING;
      this.charging = this.state === BATTERY_STATE.CHARGING;
      this._emit(BATTERY_EVENTS.PLUGGED, { level: this.level });
      this._log("info", "charger plugged", { level: this.level });
    } else {
      this.state = BATTERY_STATE.DISCHARGING;
      this.charging = false;
      this._emit(BATTERY_EVENTS.UNPLUGGED, { level: this.level });
      this._log("info", "charger unplugged", { level: this.level });
    }
    this._emit(BATTERY_EVENTS.STATE_CHANGED, { state: this.state });
  }

  setLevel(pct) {
    this.level = clamp(Number(pct), 0, 1);
    this.voltageMv = levelToVoltage(this.level, this.design);
    this._recomputeEstimates();
    this._emit(BATTERY_EVENTS.LEVEL_CHANGED, { level: this.level });
    this._checkAlerts();
    this._recordHistory();
  }

  setLoad(watts) {
    this.loadWatts = Math.max(0.1, watts);
    this._recomputeEstimates();
  }

  setLowPowerMode(enabled) {
    if (this.lowPowerMode === enabled) return;
    this.lowPowerMode = enabled;
    this._emit(BATTERY_EVENTS.LOW_POWER_MODE_CHANGED, { enabled });
    this._log("info", `low power mode ${enabled ? "on" : "off"}`);
  }

  setOptimizedCharging(enabled, limit = 0.8) {
    this.optimizedCharging = enabled;
    this.optimizedChargingLimit = clamp(limit, 0.5, 1);
    this._emit(BATTERY_EVENTS.OPTIMIZED_CHARGING_CHANGED, {
      enabled,
      limit: this.optimizedChargingLimit,
    });
    this._log("info", `optimized charging ${enabled ? "on" : "off"} limit ${limit}`);
  }

  reset() {
    this.level = 0.78;
    this.cycleCount = this.design.cycleCount;
    this.temperatureC = 26;
    this.state = BATTERY_STATE.DISCHARGING;
    this.plugged = false;
    this.charging = false;
    this.alerts = {
      low: false,
      critical: false,
      healthDegraded: false,
      temperatureWarning: false,
      overheat: false,
    };
    this.history = [];
    this._recomputeEstimates();
    this._emit(BATTERY_EVENTS.STATE_CHANGED, { state: this.state });
  }

  // ------------------------------------------------------------- física
  _tick() {
    const now = Date.now();
    const dtSec = (now - this._lastTick) / 1000;
    this._lastTick = now;

    // Simular dinámica
    if (this.charging && this.plugged) {
      // ¿Llegamos al límite de optimización?
      const limit = this.optimizedCharging ? this.optimizedChargingLimit : 1.0;
      if (this.level >= limit - 0.001) {
        this.state = BATTERY_STATE.NOT_CHARGING;
        this.charging = false;
        if (!this.alerts.fullNotified) {
          this._emit(BATTERY_EVENTS.FULLY_CHARGED, {
            level: this.level,
            optimized: this.optimizedCharging,
          });
          this.alerts.fullNotified = true;
        }
      } else {
        // Corriente de carga
        const wattsIn = 18 * this.design.chargerEfficiency; // 18W charger
        const wattsNet = wattsIn - this.loadWatts;
        const mAhPerSec = (wattsNet * 1000) / this.design.nominalVoltageMv / 3600;
        const delta = mAhPerSec * dtSec;
        const deltaLevel = delta / this.capacityMah;

        const prevLevel = this.level;
        this.level = clamp(this.level + deltaLevel, 0, 1);

        // Corriente y potencia
        this.amperageMa = (deltaLevel * this.capacityMah * 1000) / dtSec;
        this.wattageW = (this.amperageMa * this.voltageMv) / 1000000;

        // Temperatura sube un poco con carga
        const heat = Math.abs(this.wattageW) * 0.05;
        this.temperatureC = clamp(
          this.temperatureC + (heat - 0.05) * dtSec * 0.1,
          20,
          50
        );

        // Ciclos: cada 100% completo suma 1 ciclo
        if (prevLevel < 1 && this.level >= 1) {
          this.cycleCount++;
          this._emit(BATTERY_EVENTS.CYCLE_INCREASED, { cycleCount: this.cycleCount });
        }
      }
    } else {
      // Descarga
      const wattsOut = this.lowPowerMode ? this.loadWatts * 0.6 : this.loadWatts;
      const mAhPerSec = (wattsOut * 1000) / this.design.nominalVoltageMv / 3600;
      const delta = mAhPerSec * dtSec;
      const deltaLevel = delta / this.capacityMah;

      this.level = clamp(this.level - deltaLevel, 0, 1);

      this.amperageMa = -(deltaLevel * this.capacityMah * 1000) / dtSec;
      this.wattageW = (this.amperageMa * this.voltageMv) / 1000000;

      // Temperatura baja un poco al descargar
      this.temperatureC = clamp(this.temperatureC - 0.02 * dtSec, 20, 50);
    }

    // Voltaje según nivel
    this.voltageMv = levelToVoltage(this.level, this.design);

    this._recomputeEstimates();
    this._checkAlerts();
    this._recordHistory();

    // Notificar
    this._emit(BATTERY_EVENTS.LEVEL_CHANGED, { level: this.level });
  }

  _recomputeEstimates() {
    const watts = this.lowPowerMode ? this.loadWatts * 0.6 : this.loadWatts;
    if (this.charging && this.plugged) {
      const wattsIn = 18 * this.design.chargerEfficiency;
      const netW = wattsIn - watts;
      const missingMah = (1 - this.level) * this.capacityMah;
      const minutes = netW > 0
        ? (missingMah * this.design.nominalVoltageMv) / (netW * 1000) * 60
        : Infinity;
      this.estimatedChargeMinutes = minutes;
      this.estimatedDischargeMinutes = 0;
    } else {
      const remainingMah = this.level * this.capacityMah;
      const minutes = watts > 0
        ? (remainingMah * this.design.nominalVoltageMv) / (watts * 1000) * 60
        : Infinity;
      this.estimatedDischargeMinutes = minutes;
      this.estimatedChargeMinutes = 0;
    }
  }

  _checkAlerts() {
    // Nivel bajo
    if (this.level <= this.design.lowThreshold && !this.alerts.low) {
      this.alerts.low = true;
      this._emit(BATTERY_EVENTS.LOW_BATTERY, { level: this.level });
      this._log("warn", "battery low", { level: this.level });
    } else if (this.level > this.design.lowThreshold + 0.02) {
      this.alerts.low = false;
    }

    // Crítico
    if (this.level <= this.design.criticalThreshold && !this.alerts.critical) {
      this.alerts.critical = true;
      this._emit(BATTERY_EVENTS.CRITICAL_BATTERY, { level: this.level });
      this._log("error", "battery critical", { level: this.level });
    } else if (this.level > this.design.criticalThreshold + 0.02) {
      this.alerts.critical = false;
    }

    // Salud
    const health = this.health;
    if (health < 0.8 && !this.alerts.healthDegraded) {
      this.alerts.healthDegraded = true;
      this._emit(BATTERY_EVENTS.HEALTH_DEGRADED, { health });
      this._log("warn", "battery health degraded", { health });
    }

    // Temperatura
    if (this.temperatureC >= this.design.temperatureCriticalC && !this.alerts.overheat) {
      this.alerts.overheat = true;
      this._emit(BATTERY_EVENTS.OVERHEAT, { temperature: this.temperatureC });
      this._log("error", "battery overheat", { temperature: this.temperatureC });
    } else if (this.temperatureC < this.design.temperatureCriticalC - 2) {
      this.alerts.overheat = false;
    }

    if (
      this.temperatureC >= this.design.temperatureWarningC &&
      !this.alerts.temperatureWarning
    ) {
      this.alerts.temperatureWarning = true;
      this._emit(BATTERY_EVENTS.TEMPERATURE_WARNING, {
        temperature: this.temperatureC,
      });
    } else if (this.temperatureC < this.design.temperatureWarningC - 2) {
      this.alerts.temperatureWarning = false;
    }
  }

  _recordHistory() {
    const now = Date.now();
    // Guardamos una muestra cada 60s o cuando el nivel cambia > 1%
    const last = this.history[this.history.length - 1];
    if (
      !last ||
      now - last.ts > 60000 ||
      Math.abs(last.level - this.level) > 0.01
    ) {
      this.history.push({
        ts: now,
        level: this.level,
        state: this.state,
        voltage: this.voltageMv,
        temperature: this.temperatureC,
        amperage: this.amperageMa,
      });
      if (this.history.length > this.maxHistory) this.history.shift();
    }
  }

  // ------------------------------------------------------------- getters
  get percentage() {
    return Math.round(this.level * 100);
  }

  get health() {
    return clamp(this.capacityMah / this.design.designCapacityMah, 0, 1);
  }

  get isCharging() {
    return this.state === BATTERY_STATE.CHARGING || this.state === BATTERY_STATE.FULL;
  }

  get timeToEmpty() {
    return formatDuration(this.estimatedDischargeMinutes);
  }

  get timeToFull() {
    return formatDuration(this.estimatedChargeMinutes);
  }

  snapshot() {
    return {
      id: this.id,
      level: this.level,
      percentage: this.percentage,
      state: this.state,
      plugged: this.plugged,
      charging: this.charging,
      health: this.health,
      cycleCount: this.cycleCount,
      capacityMah: this.capacityMah,
      designCapacityMah: this.design.designCapacityMah,
      maxCapacityMah: this.design.currentCapacityMah,
      voltageMv: this.voltageMv,
      amperageMa: this.amperageMa,
      wattageW: this.wattageW,
      temperatureC: this.temperatureC,
      lowPowerMode: this.lowPowerMode,
      optimizedCharging: this.optimizedCharging,
      optimizedChargingLimit: this.optimizedChargingLimit,
      estimatedDischargeMinutes: this.estimatedDischargeMinutes,
      estimatedChargeMinutes: this.estimatedChargeMinutes,
      timeToEmpty: this.timeToEmpty,
      timeToFull: this.timeToFull,
      alerts: { ...this.alerts },
      historyLength: this.history.length,
    };
  }

  historySnapshot() {
    return [...this.history];
  }
}

// ============================================================================
// PROVIDER + HOOKS
// ============================================================================

const BatteryContext = React.createContext(null);

export function BatteryProvider({ children, battery: external, autoStart = true, options = {} }) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new Battery(options);
  }
  const battery = ref.current;
  const [snapshot, setSnapshot] = useState(() => battery.snapshot());

  useEffect(() => {
    const unsub = battery.subscribe(() => setSnapshot(battery.snapshot()));
    if (autoStart) battery.start();
    return () => {
      unsub();
      if (autoStart) battery.stop();
    };
  }, [battery, autoStart]);

  const api = useMemo(
    () => ({
      battery,
      snapshot,
      setCharging: (p) => battery.setCharging(p),
      setLevel: (l) => battery.setLevel(l),
      setLoad: (w) => battery.setLoad(w),
      setLowPowerMode: (e) => battery.setLowPowerMode(e),
      setOptimizedCharging: (e, l) => battery.setOptimizedCharging(e, l),
      reset: () => battery.reset(),
      history: () => battery.historySnapshot(),
      start: () => battery.start(),
      stop: () => battery.stop(),
    }),
    [battery, snapshot]
  );

  return (
    <BatteryContext.Provider value={api}>{children}</BatteryContext.Provider>
  );
}

export function useBattery() {
  const ctx = React.useContext(BatteryContext);
  if (!ctx) throw new Error("useBattery must be used within BatteryProvider");
  return ctx;
}

export default {
  Battery,
  BatteryProvider,
  useBattery,
  BATTERY_STATE,
  BATTERY_EVENTS,
  BATTERY_DEFAULTS,
};
