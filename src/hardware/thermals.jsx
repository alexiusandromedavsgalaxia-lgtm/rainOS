// ============================================================================
// thermals.jsx — Subsistema térmico completo
// ----------------------------------------------------------------------------
// Modela toda la gestión térmica del dispositivo virtual, desde los sensores
// hasta el throttling:
//
//   - ThermalZone: cada zona térmica (CPU, GPU, battery, display, SoC)
//   - ThermalSensor: cada sensor individual (°C) con tipo y límites
//   - ThermalCurve: curvas de temperatura → frecuencia
//   - ThermalGovernor: política de throttling automático
//   - FanController: control de ventiladores (PWM)
//   - CoolingPolicy: política de mitigación (passive / active / critical)
//   - ThermalMitigation: acciones concretas (bajar freq, limitar cores, etc.)
//   - ThermalPredictor: predicción de picos futuros
//
// ZONAS POR DEFECTO
//
//   - soc       → temperatura global del SoC
//   - cpu-p     → cluster P (performance)
//   - cpu-e     → cluster E (efficiency)
//   - gpu       → GPU
//   - battery   → batería
//   - display   → panel de pantalla
//   - nand      → almacenamiento NAND
//   - ambient   → temperatura ambiente
//
// FÍSICA
//
//   - Cada zona tiene: heat generation W, thermal resistance °C/W,
//     thermal capacitance J/°C, y una temperatura ambiente.
//   - Ley de Newton del enfriamiento: dT/dt = (Q_in - (T - T_amb)/R) / C
//   - Los coolers (ventiladores, heatsink) incrementan la conductancia
//   - Throttling reduce Q_in
//   - El governor actúa cuando T supera trip points
//
// TRIP POINTS (macOS/iOS style)
//
//   0 → normal (< 65°C)
//   1 → warning (65°C)      — empezar a bajar frecuencia
//   2 → serious (75°C)      — throttle agresivo
//   3 → critical (85°C)     — limite duro
//   4 → emergency (95°C)    — apagar cores
//   5 → shutdown (105°C)    — apagado de emergencia
//
// EVENTOS
//
//   - zone:created, zone:removed, zone:updated
//   - sensor:update
//   - governor:trip, governor:recovery, governor:policy-changed
//   - cooler:update, cooler:enabled, cooler:disabled
//   - throttling:start, throttling:stop, throttling:change
//   - critical:reached, emergency:reached
//   - fan:update, fan:curve-applied
//   - prediction:update
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

export const THERMAL_ZONE = Object.freeze({
  SOC: "soc",
  CPU_P: "cpu-p",
  CPU_E: "cpu-e",
  GPU: "gpu",
  BATTERY: "battery",
  DISPLAY: "display",
  NAND: "nand",
  AMBIENT: "ambient",
  CHARGER: "charger",
});

export const THERMAL_SENSOR_TYPE = Object.freeze({
  TEMPERATURE: "temperature",
  VOLTAGE: "voltage",
  CURRENT: "current",
  POWER: "power",
  FAN_RPM: "fan-rpm",
});

export const TRIP_TYPE = Object.freeze({
  ACTIVE: "active",
  PASSIVE: "passive",
  CRITICAL: "critical",
  HOT: "hot",
  EMERGENCY: "emergency",
  SHUTDOWN: "shutdown",
});

export const MITIGATION_ACTION = Object.freeze({
  NONE: "none",
  THROTTLE_CPU: "throttle-cpu",
  THROTTLE_GPU: "throttle-gpu",
  LIMIT_CORES: "limit-cores",
  LOWER_DISPLAY_BRIGHTNESS: "lower-display-brightness",
  LIMIT_CHARGE_RATE: "limit-charge-rate",
  STOP_CHARGING: "stop-charging",
  KILL_BACKGROUND: "kill-background",
  EMERGENCY_SHUTDOWN: "emergency-shutdown",
});

export const THERMAL_POLICY = Object.freeze({
  PERFORMANCE: "performance",
  BALANCED: "balanced",
  EFFICIENCY: "efficiency",
  QUIET: "quiet",
  CUSTOM: "custom",
});

export const THERMAL_EVENTS = Object.freeze({
  MANAGER_STARTED: "thermal:manager-started",
  MANAGER_STOPPED: "thermal:manager-stopped",
  ZONE_CREATED: "thermal:zone-created",
  ZONE_REMOVED: "thermal:zone-removed",
  ZONE_UPDATED: "thermal:zone-updated",
  SENSOR_UPDATE: "thermal:sensor-update",
  TRIP_CROSSED: "thermal:trip-crossed",
  TRIP_RECOVERED: "thermal:trip-recovered",
  POLICY_CHANGED: "thermal:policy-changed",
  THROTTLE_START: "thermal:throttle-start",
  THROTTLE_STOP: "thermal:throttle-stop",
  THROTTLE_CHANGE: "thermal:throttle-change",
  CRITICAL_REACHED: "thermal:critical-reached",
  EMERGENCY_REACHED: "thermal:emergency-reached",
  SHUTDOWN: "thermal:shutdown",
  COOLER_UPDATE: "thermal:cooler-update",
  COOLER_ENABLED: "thermal:cooler-enabled",
  COOLER_DISABLED: "thermal:cooler-disabled",
  FAN_UPDATE: "thermal:fan-update",
  FAN_CURVE_APPLIED: "thermal:fan-curve-applied",
  PREDICTION_UPDATE: "thermal:prediction-update",
  LOG: "thermal:log",
});

// ============================================================================
// LOGGER
// ============================================================================

class ThermalLog {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(THERMAL_EVENTS.LOG, e);
  }
  info(m, x) { this.push("info", m, x); }
  warn(m, x) { this.push("warn", m, x); }
  error(m, x) { this.push("error", m, x); }
  all() { return [...this.entries]; }
}

// ============================================================================
// THERMAL SENSOR
// ============================================================================

let _sensorCounter = 0;

class ThermalSensor {
  constructor({
    id,
    name,
    type = THERMAL_SENSOR_TYPE.TEMPERATURE,
    unit = "°C",
    value = 25,
    min = 0,
    max = 120,
    warningThreshold = 65,
    criticalThreshold = 85,
    tripType = TRIP_TYPE.PASSIVE,
  }) {
    this.id = id || `sensor-${++_sensorCounter}`;
    this.name = name;
    this.type = type;
    this.unit = unit;
    this.value = value;
    this.min = min;
    this.max = max;
    this.warningThreshold = warningThreshold;
    this.criticalThreshold = criticalThreshold;
    this.tripType = tripType;
    this.history = [];
    this.maxHistory = 300;
    this.updatedAt = Date.now();
  }

  setValue(v) {
    const prev = this.value;
    this.value = Math.max(this.min, Math.min(this.max, v));
    this.updatedAt = Date.now();
    this.history.push({ ts: Date.now(), value: this.value });
    if (this.history.length > this.maxHistory) this.history.shift();

    return { prev, curr: this.value, changed: prev !== this.value };
  }

  get isWarning() {
    return this.value >= this.warningThreshold;
  }

  get isCritical() {
    return this.value >= this.criticalThreshold;
  }

  average(windowMs = 60000) {
    const cutoff = Date.now() - windowMs;
    const recent = this.history.filter((h) => h.ts >= cutoff);
    if (recent.length === 0) return this.value;
    return recent.reduce((a, h) => a + h.value, 0) / recent.length;
  }

  rateOfChange(windowMs = 60000) {
    const cutoff = Date.now() - windowMs;
    const recent = this.history.filter((h) => h.ts >= cutoff);
    if (recent.length < 2) return 0;
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dt = (last.ts - first.ts) / 1000;
    if (dt === 0) return 0;
    return (last.value - first.value) / dt;
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      unit: this.unit,
      value: this.value,
      min: this.min,
      max: this.max,
      warningThreshold: this.warningThreshold,
      criticalThreshold: this.criticalThreshold,
      isWarning: this.isWarning,
      isCritical: this.isCritical,
      updatedAt: this.updatedAt,
      avg60s: this.average(),
      rateCPerSec: this.rateOfChange(),
    };
  }
}

// ============================================================================
// THERMAL ZONE
// ============================================================================

let _zoneCounter = 0;

class ThermalZone {
  constructor({
    id,
    name,
    kind,
    initialTemp = 25,
    ambientTemp = 25,
    thermalResistance = 1.5,   // °C/W (resistencia a disipar)
    thermalCapacitance = 5,    // J/°C (inercia térmica)
    maxPowerW = 20,            // potencia máxima de generación
    tripPoints = null,
  }) {
    this.id = id || `zone-${++_zoneCounter}`;
    this.name = name;
    this.kind = kind;
    this.currentTemp = initialTemp;
    this.ambientTemp = ambientTemp;
    this.thermalResistance = thermalResistance;
    this.thermalCapacitance = thermalCapacitance;
    this.maxPowerW = maxPowerW;
    this.currentPowerW = 0;
    this.throttleFactor = 1.0; // 1.0 = sin throttling, 0.0 = totalmente bloqueado

    this.sensors = new Map();
    this.tripPoints = tripPoints || this._defaultTripPoints();

    this.createdAt = Date.now();
    this.lastUpdate = Date.now();
    this.activeTripLevel = 0;
    this.coolingState = "passive";

    this.listeners = new Set();
  }

  _defaultTripPoints() {
    return [
      { level: 0, tempC: 65, type: TRIP_TYPE.PASSIVE, name: "warm" },
      { level: 1, tempC: 75, type: TRIP_TYPE.PASSIVE, name: "hot" },
      { level: 2, tempC: 85, type: TRIP_TYPE.CRITICAL, name: "critical" },
      { level: 3, tempC: 95, type: TRIP_TYPE.EMERGENCY, name: "emergency" },
      { level: 4, tempC: 105, type: TRIP_TYPE.SHUTDOWN, name: "shutdown" },
    ];
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

  addSensor(sensor) {
    this.sensors.set(sensor.id, sensor);
  }

  removeSensor(sensorId) {
    this.sensors.delete(sensorId);
  }

  /**
   * Tick físico. Avanza la simulación térmica en dt segundos.
   */
  tick(dtSec) {
    const now = Date.now();
    const dt = Math.min(dtSec, 1.0); // no simular saltos enormes

    // Potencia efectiva tras throttling
    const effectivePower = this.currentPowerW * this.throttleFactor;

    // Ley de Newton: dT/dt = (Q - (T - T_amb) / R) / C
    const qLoss = (this.currentTemp - this.ambientTemp) / this.thermalResistance;
    const dT = ((effectivePower - qLoss) / this.thermalCapacitance) * dt;
    this.currentTemp = Math.max(this.ambientTemp, this.currentTemp + dT);

    this.lastUpdate = now;

    // Actualizar sensores de temperatura
    for (const sensor of this.sensors.values()) {
      if (sensor.type === THERMAL_SENSOR_TYPE.TEMPERATURE) {
        // Añadir un pequeño ruido para realismo
        const noise = (Math.random() - 0.5) * 0.3;
        sensor.setValue(this.currentTemp + noise);
      }
    }

    // Detectar cruces de trip points
    const prevLevel = this.activeTripLevel;
    let newLevel = 0;
    for (const tp of this.tripPoints) {
      if (this.currentTemp >= tp.tempC) {
        newLevel = tp.level + 1;
      }
    }
    if (newLevel !== prevLevel) {
      this.activeTripLevel = newLevel;
      if (newLevel > prevLevel) {
        kernelBus.emit(THERMAL_EVENTS.TRIP_CROSSED, {
          zoneId: this.id,
          level: newLevel,
          tempC: this.currentTemp,
          tripPoint: this.tripPoints[newLevel - 1],
        });
      } else {
        kernelBus.emit(THERMAL_EVENTS.TRIP_RECOVERED, {
          zoneId: this.id,
          level: newLevel,
          tempC: this.currentTemp,
        });
      }
    }

    return this.currentTemp;
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      currentTemp: this.currentTemp,
      ambientTemp: this.ambientTemp,
      thermalResistance: this.thermalResistance,
      thermalCapacitance: this.thermalCapacitance,
      currentPowerW: this.currentPowerW,
      effectivePowerW: this.currentPowerW * this.throttleFactor,
      throttleFactor: this.throttleFactor,
      activeTripLevel: this.activeTripLevel,
      tripPoints: this.tripPoints.map((tp) => ({ ...tp })),
      coolingState: this.coolingState,
      sensors: Array.from(this.sensors.values()).map((s) => s.snapshot()),
      createdAt: this.createdAt,
      lastUpdate: this.lastUpdate,
    };
  }
}

// ============================================================================
// COOLER (ventilador / heatsink activo)
// ============================================================================

class Cooler {
  constructor({
    id,
    name,
    kind = "fan", // "fan" | "heatsink" | "liquid"
    maxRpm = 6000,
    minRpm = 0,
    maxPwm = 255,
    curve = null,
  }) {
    this.id = id;
    this.name = name;
    this.kind = kind;
    this.maxRpm = maxRpm;
    this.minRpm = minRpm;
    this.maxPwm = maxPwm;
    this.currentRpm = 0;
    this.currentPwm = 0;
    this.enabled = true;
    this.curve = curve || this._defaultCurve();
    this.updatedAt = Date.now();
    this.stats = {
      totalSeconds: 0,
      maxRpmReached: 0,
      activations: 0,
    };
  }

  _defaultCurve() {
    // Curva por defecto: 0 rpm hasta 50°C, subir progresivo hasta 100% a 90°C
    return [
      { tempC: 40, pwm: 0 },
      { tempC: 50, pwm: 0.2 },
      { tempC: 60, pwm: 0.4 },
      { tempC: 70, pwm: 0.7 },
      { tempC: 80, pwm: 0.9 },
      { tempC: 90, pwm: 1.0 },
    ];
  }

  setCurve(curve) {
    this.curve = curve;
    kernelBus.emit(THERMAL_EVENTS.FAN_CURVE_APPLIED, {
      coolerId: this.id,
      curve,
    });
  }

  /**
   * Aplica la curva de temperatura → PWM.
   */
  updateForTemp(tempC, dtSec = 1) {
    if (!this.enabled) {
      this.currentRpm = 0;
      this.currentPwm = 0;
      return;
    }

    const pwm = this._interpolateCurve(tempC);
    this.currentPwm = pwm;
    this.currentRpm = Math.round(this.minRpm + pwm * (this.maxRpm - this.minRpm));
    this.updatedAt = Date.now();
    this.stats.totalSeconds += dtSec;
    if (this.currentRpm > this.stats.maxRpmReached) {
      this.stats.maxRpmReached = this.currentRpm;
    }
    if (this.currentRpm > 0 && this.stats.activations === 0) {
      this.stats.activations = 1;
      kernelBus.emit(THERMAL_EVENTS.COOLER_ENABLED, { coolerId: this.id });
    }
    kernelBus.emit(THERMAL_EVENTS.FAN_UPDATE, {
      coolerId: this.id,
      rpm: this.currentRpm,
      pwm: this.currentPwm,
    });
  }

  _interpolateCurve(tempC) {
    const c = this.curve;
    if (tempC <= c[0].tempC) return c[0].pwm;
    if (tempC >= c[c.length - 1].tempC) return c[c.length - 1].pwm;
    for (let i = 0; i < c.length - 1; i++) {
      const a = c[i];
      const b = c[i + 1];
      if (tempC >= a.tempC && tempC <= b.tempC) {
        const t = (tempC - a.tempC) / (b.tempC - a.tempC);
        return a.pwm + t * (b.pwm - a.pwm);
      }
    }
    return 0;
  }

  enable() {
    this.enabled = true;
    kernelBus.emit(THERMAL_EVENTS.COOLER_ENABLED, { coolerId: this.id });
  }

  disable() {
    this.enabled = false;
    this.currentRpm = 0;
    this.currentPwm = 0;
    kernelBus.emit(THERMAL_EVENTS.COOLER_DISABLED, { coolerId: this.id });
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      enabled: this.enabled,
      currentRpm: this.currentRpm,
      currentPwm: this.currentPwm,
      maxRpm: this.maxRpm,
      curve: this.curve.map((c) => ({ ...c })),
      stats: { ...this.stats },
      updatedAt: this.updatedAt,
    };
  }
}

// ============================================================================
// THERMAL GOVERNOR
// ----------------------------------------------------------------------------
// Toma decisiones de throttling basándose en los trip points activos.
// ============================================================================

class ThermalGovernor {
  constructor({ manager }) {
    this.manager = manager;
    this.policy = THERMAL_POLICY.BALANCED;
    this.currentThrottle = 1.0;
    this.targetThrottle = 1.0;
    this.throttling = false;
    this.activeMitigations = new Set();
    this.stats = {
      throttleEvents: 0,
      emergencyEvents: 0,
      avgThrottle: 1.0,
      samples: 0,
    };
  }

  setPolicy(policy) {
    this.policy = policy;
    kernelBus.emit(THERMAL_EVENTS.POLICY_CHANGED, { policy });
    this._evaluate();
  }

  /**
   * Evalúa el estado actual de las zonas y ajusta el throttling.
   */
  _evaluate() {
    const zones = this.manager.listZones();
    let maxTripLevel = 0;
    let maxZone = null;

    for (const zone of zones) {
      if (zone.activeTripLevel > maxTripLevel) {
        maxTripLevel = zone.activeTripLevel;
        maxZone = zone;
      }
    }

    // Calcular factor de throttle según el nivel más alto
    let target = 1.0;

    switch (maxTripLevel) {
      case 0:
        target = 1.0;
        break;
      case 1:
        target = this._policyFactor(0.85, 0.8, 0.9, 0.95);
        break;
      case 2:
        target = this._policyFactor(0.6, 0.55, 0.7, 0.8);
        break;
      case 3:
        target = this._policyFactor(0.3, 0.25, 0.4, 0.5);
        break;
      case 4:
        target = 0.0; // shutdown
        break;
      default:
        target = 0.0;
    }

    this.targetThrottle = target;

    // Aplicar a todas las zonas (con margen de histéresis)
    const newThrottle = this.currentThrottle + (target - this.currentThrottle) * 0.15;
    const changed = Math.abs(newThrottle - this.currentThrottle) > 0.01;

    this.currentThrottle = newThrottle;

    if (changed) {
      for (const zone of this.manager.zones.values()) {
        zone.throttleFactor = newThrottle;
      }

      kernelBus.emit(THERMAL_EVENTS.THROTTLE_CHANGE, {
        from: this.currentThrottle,
        to: newThrottle,
        target,
        tripLevel: maxTripLevel,
      });

      if (newThrottle < 0.95 && !this.throttling) {
        this.throttling = true;
        this.stats.throttleEvents++;
        kernelBus.emit(THERMAL_EVENTS.THROTTLE_START, {
          throttle: newThrottle,
          tripLevel: maxTripLevel,
          zoneId: maxZone?.id,
        });
      } else if (newThrottle >= 0.99 && this.throttling) {
        this.throttling = false;
        kernelBus.emit(THERMAL_EVENTS.THROTTLE_STOP, {});
      }

      if (maxTripLevel >= 2) {
        kernelBus.emit(THERMAL_EVENTS.CRITICAL_REACHED, {
          level: maxTripLevel,
          zoneId: maxZone?.id,
        });
      }
      if (maxTripLevel >= 3) {
        this.stats.emergencyEvents++;
        kernelBus.emit(THERMAL_EVENTS.EMERGENCY_REACHED, {
          level: maxTripLevel,
          zoneId: maxZone?.id,
        });
      }
      if (maxTripLevel >= 4) {
        kernelBus.emit(THERMAL_EVENTS.SHUTDOWN, {
          reason: "thermal-emergency",
          zoneId: maxZone?.id,
          tempC: maxZone?.currentTemp,
        });
      }
    }

    // Media móvil del throttle
    this.stats.samples++;
    this.stats.avgThrottle =
      (this.stats.avgThrottle * (this.stats.samples - 1) + newThrottle) /
      this.stats.samples;

    return newThrottle;
  }

  _policyFactor(performance, balanced, efficiency, quiet) {
    switch (this.policy) {
      case THERMAL_POLICY.PERFORMANCE: return performance;
      case THERMAL_POLICY.BALANCED: return balanced;
      case THERMAL_POLICY.EFFICIENCY: return efficiency;
      case THERMAL_POLICY.QUIET: return quiet;
      default: return balanced;
    }
  }

  snapshot() {
    return {
      policy: this.policy,
      currentThrottle: this.currentThrottle,
      targetThrottle: this.targetThrottle,
      throttling: this.throttling,
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// THERMAL PREDICTOR
// ----------------------------------------------------------------------------
// Predice la temperatura futura basándose en la tendencia actual.
// ============================================================================

class ThermalPredictor {
  constructor({ manager }) {
    this.manager = manager;
    this.horizonSec = 30;
    this.predictions = new Map(); // zoneId → { predictedTemp, trend, confidence }
  }

  update() {
    for (const zone of this.manager.zones.values()) {
      const trend = this._estimateTrend(zone);
      const predicted = zone.currentTemp + trend * this.horizonSec;
      const confidence = this._estimateConfidence(zone);
      this.predictions.set(zone.id, {
        predictedTemp: Math.max(20, predicted),
        trend,
        confidence,
        horizonSec: this.horizonSec,
      });
    }
    kernelBus.emit(THERMAL_EVENTS.PREDICTION_UPDATE, {
      predictions: Object.fromEntries(this.predictions),
    });
  }

  _estimateTrend(zone) {
    const tempSensors = Array.from(zone.sensors.values()).filter(
      (s) => s.type === THERMAL_SENSOR_TYPE.TEMPERATURE
    );
    if (tempSensors.length === 0) return 0;
    const sensor = tempSensors[0];
    return sensor.rateOfChange(10000); // °C/s en los últimos 10s
  }

  _estimateConfidence(zone) {
    // Menos confianza si el trend es muy alto (condiciones cambiantes)
    const trend = this._estimateTrend(zone);
    const absTrend = Math.abs(trend);
    if (absTrend < 0.1) return 0.95;
    if (absTrend < 0.5) return 0.8;
    if (absTrend < 2) return 0.6;
    return 0.3;
  }

  snapshot() {
    const out = {};
    for (const [id, p] of this.predictions) {
      out[id] = { ...p };
    }
    return out;
  }
}

// ============================================================================
// THERMAL MANAGER
// ============================================================================

export class ThermalManager {
  constructor({ ambientTempC = 25, tickIntervalMs = 500, policy = THERMAL_POLICY.BALANCED } = {}) {
    this.ambientTempC = ambientTempC;
    this.tickIntervalMs = tickIntervalMs;
    this.log = new ThermalLog();

    this.zones = new Map();
    this.coolers = new Map();
    this.policy = policy;
    this.governor = new ThermalGovernor({ manager: this });
    this.predictor = new ThermalPredictor({ manager: this });

    this.listeners = new Set();
    this._tickHandle = null;
    this._lastTick = Date.now();

    this.stats = {
      tickCount: 0,
      uptimeMs: 0,
      peakTempC: ambientTempC,
      peakZoneId: null,
      throttleSeconds: 0,
      emergencyCount: 0,
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

  // -------------------------------------------------------------- zonas
  createZone(opts) {
    const zone = new ThermalZone({
      ...opts,
      ambientTemp: opts.ambientTemp ?? this.ambientTempC,
    });
    zone.subscribe((event, payload) => {
      this._emit(event, { zoneId: zone.id, ...payload });
    });
    this.zones.set(zone.id, zone);
    this._emit(THERMAL_EVENTS.ZONE_CREATED, zone.snapshot());
    this._log("info", `zone created: ${zone.name} (${zone.kind})`);
    return zone;
  }

  removeZone(id) {
    const zone = this.zones.get(id);
    if (!zone) return false;
    this.zones.delete(id);
    this._emit(THERMAL_EVENTS.ZONE_REMOVED, { zoneId: id });
    return true;
  }

  getZone(id) {
    return this.zones.get(id) ?? null;
  }

  listZones() {
    return Array.from(this.zones.values());
  }

  listZonesSnapshot() {
    return this.listZones().map((z) => z.snapshot());
  }

  // -------------------------------------------------------------- coolers
  createCooler(opts) {
    const cooler = new Cooler(opts);
    this.coolers.set(cooler.id, cooler);
    this._emit(THERMAL_EVENTS.COOLER_UPDATE, cooler.snapshot());
    this._log("info", `cooler created: ${cooler.name}`);
    return cooler;
  }

  removeCooler(id) {
    const cooler = this.coolers.get(id);
    if (!cooler) return false;
    this.coolers.delete(id);
    return true;
  }

  listCoolers() {
    return Array.from(this.coolers.values()).map((c) => c.snapshot());
  }

  // -------------------------------------------------------------- load sources
  /**
   * Registra carga de un subsistema (CPU, GPU, etc.) sobre una zona.
   */
  setLoad(zoneId, watts) {
    const zone = this.zones.get(zoneId);
    if (!zone) return false;
    zone.currentPowerW = Math.max(0, watts);
    this._emit(THERMAL_EVENTS.ZONE_UPDATED, {
      zoneId,
      currentPowerW: zone.currentPowerW,
    });
    return true;
  }

  // -------------------------------------------------------------- policy
  setPolicy(policy) {
    this.policy = policy;
    this.governor.setPolicy(policy);
  }

  // -------------------------------------------------------------- lifecycle
  start() {
    if (this._tickHandle) return;
    this._lastTick = Date.now();
    this._tickHandle = setInterval(() => this._tick(), this.tickIntervalMs);
    this._emit(THERMAL_EVENTS.MANAGER_STARTED, {});
    this._log("info", "thermal manager started");
  }

  stop() {
    if (this._tickHandle) {
      clearInterval(this._tickHandle);
      this._tickHandle = null;
    }
    this._emit(THERMAL_EVENTS.MANAGER_STOPPED, {});
    this._log("info", "thermal manager stopped");
  }

  // -------------------------------------------------------------- tick loop
  _tick() {
    const now = Date.now();
    const dtSec = (now - this._lastTick) / 1000;
    this._lastTick = now;

    this.stats.tickCount++;
    this.stats.uptimeMs += dtSec * 1000;

    // Avanzar cada zona
    for (const zone of this.zones.values()) {
      zone.tick(dtSec);

      // Actualizar stats globales
      if (zone.currentTemp > this.stats.peakTempC) {
        this.stats.peakTempC = zone.currentTemp;
        this.stats.peakZoneId = zone.id;
      }
    }

    // Actualizar coolers según la temperatura media del SoC
    const socZone = this.zones.get(THERMAL_ZONE.SOC) ||
                    this.zones.values().next().value;
    if (socZone) {
      for (const cooler of this.coolers.values()) {
        cooler.updateForTemp(socZone.currentTemp, dtSec);
      }
    }

    // Governor evalúa y ajusta throttling
    this.governor._evaluate();

    if (this.governor.throttling) {
      this.stats.throttleSeconds += dtSec;
    }

    // Predictor
    this.predictor.update();
  }

  // -------------------------------------------------------------- snapshot
  snapshot() {
    return {
      ambientTempC: this.ambientTempC,
      policy: this.policy,
      zones: this.listZonesSnapshot(),
      coolers: this.listCoolers(),
      governor: this.governor.snapshot(),
      predictions: this.predictor.snapshot(),
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// SIMULACIÓN POR DEFECTO
// ----------------------------------------------------------------------------
// Crea un SoC con clusters CPU P/E, GPU, batería, NAND, display y dos
// ventiladores (uno para CPU y otro para GPU).
// ============================================================================

export function createDefaultThermalZones(manager, ambientTempC = 25) {
  const soc = manager.createZone({
    id: THERMAL_ZONE.SOC,
    name: "SoC",
    kind: THERMAL_ZONE.SOC,
    initialTemp: ambientTempC + 5,
    thermalResistance: 0.8,
    thermalCapacitance: 20,
    maxPowerW: 35,
  });

  const cpuP = manager.createZone({
    id: THERMAL_ZONE.CPU_P,
    name: "CPU Performance Cores",
    kind: THERMAL_ZONE.CPU_P,
    initialTemp: ambientTempC + 4,
    thermalResistance: 1.2,
    thermalCapacitance: 8,
    maxPowerW: 20,
  });

  const cpuE = manager.createZone({
    id: THERMAL_ZONE.CPU_E,
    name: "CPU Efficiency Cores",
    kind: THERMAL_ZONE.CPU_E,
    initialTemp: ambientTempC + 3,
    thermalResistance: 1.8,
    thermalCapacitance: 4,
    maxPowerW: 8,
  });

  const gpu = manager.createZone({
    id: THERMAL_ZONE.GPU,
    name: "GPU",
    kind: THERMAL_ZONE.GPU,
    initialTemp: ambientTempC + 3,
    thermalResistance: 1.0,
    thermalCapacitance: 12,
    maxPowerW: 25,
  });

  const battery = manager.createZone({
    id: THERMAL_ZONE.BATTERY,
    name: "Battery",
    kind: THERMAL_ZONE.BATTERY,
    initialTemp: ambientTempC + 2,
    thermalResistance: 3.0,
    thermalCapacitance: 30,
    maxPowerW: 5,
  });

  const display = manager.createZone({
    id: THERMAL_ZONE.DISPLAY,
    name: "Display Panel",
    kind: THERMAL_ZONE.DISPLAY,
    initialTemp: ambientTempC + 3,
    thermalResistance: 4.0,
    thermalCapacitance: 6,
    maxPowerW: 4,
  });

  const nand = manager.createZone({
    id: THERMAL_ZONE.NAND,
    name: "NAND Storage",
    kind: THERMAL_ZONE.NAND,
    initialTemp: ambientTempC + 2,
    thermalResistance: 5.0,
    thermalCapacitance: 10,
    maxPowerW: 3,
  });

  // Añadir sensores de temperatura a cada zona
  for (const zone of [soc, cpuP, cpuE, gpu, battery, display, nand]) {
    zone.addSensor(
      new ThermalSensor({
        id: `${zone.id}-temp`,
        name: `${zone.name} Temp`,
        value: zone.currentTemp,
        warningThreshold: 65,
        criticalThreshold: 85,
      })
    );
  }

  // Coolers por defecto
  manager.createCooler({
    id: "fan-cpu",
    name: "CPU Fan",
    kind: "fan",
    maxRpm: 6000,
  });

  manager.createCooler({
    id: "fan-gpu",
    name: "GPU Fan",
    kind: "fan",
    maxRpm: 5000,
  });

  return { soc, cpuP, cpuE, gpu, battery, display, nand };
}

// ============================================================================
// PROVIDER + HOOK
// ============================================================================

const ThermalContext = React.createContext(null);

export function ThermalProvider({
  children,
  manager: external,
  autoStart = true,
  autoCreateZones = true,
  ambientTempC = 25,
  policy = THERMAL_POLICY.BALANCED,
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new ThermalManager({ ambientTempC, policy });
    if (autoCreateZones && ref.current.zones.size === 0) {
      createDefaultThermalZones(ref.current, ambientTempC);
    }
  }
  const manager = ref.current;
  const [snapshot, setSnapshot] = useState(() => manager.snapshot());

  useEffect(() => {
    const unsub = manager.subscribe(() => setSnapshot(manager.snapshot()));
    if (autoStart) manager.start();
    return () => {
      unsub();
      if (autoStart) manager.stop();
    };
  }, [manager, autoStart]);

  const api = useMemo(
    () => ({
      manager,
      snapshot,

      createZone: (opts) => manager.createZone(opts),
      removeZone: (id) => manager.removeZone(id),
      getZone: (id) => manager.getZone(id),
      listZones: () => manager.listZonesSnapshot(),

      createCooler: (opts) => manager.createCooler(opts),
      removeCooler: (id) => manager.removeCooler(id),
      listCoolers: () => manager.listCoolers(),

      setLoad: (zoneId, watts) => manager.setLoad(zoneId, watts),
      setPolicy: (policy) => manager.setPolicy(policy),

      start: () => manager.start(),
      stop: () => manager.stop(),

      governor: manager.governor,
      predictor: manager.predictor,
    }),
    [manager, snapshot]
  );

  return (
    <ThermalContext.Provider value={api}>{children}</ThermalContext.Provider>
  );
}

export function useThermals() {
  const ctx = React.useContext(ThermalContext);
  if (!ctx) throw new Error("useThermals must be used within ThermalProvider");
  return ctx;
}

export default {
  ThermalManager,
  ThermalZone,
  ThermalSensor,
  Cooler,
  ThermalGovernor,
  ThermalPredictor,
  ThermalProvider,
  useThermals,
  createDefaultThermalZones,
  THERMAL_ZONE,
  THERMAL_SENSOR_TYPE,
  TRIP_TYPE,
  MITIGATION_ACTION,
  THERMAL_POLICY,
  THERMAL_EVENTS,
};
