// ============================================================================
// sysbatdiagnostic.jsx — Diagnóstico avanzado de batería
// ----------------------------------------------------------------------------
// Análogo a `batteryutil`, `powerlog` y `smcDiagnose` de iOS/macOS.
//
// FUNCIONES
//
//   - Recolecta un snapshot completo del subsistema de batería:
//       * Estado actual (nivel, voltaje, corriente, temperatura)
//       * Capacidad y salud (con degradación calculada)
//       * Ciclos (con proyección de degradación futura)
//       * Historial reciente (últimas 24h)
//       * Estado del cargador y negociación
//       * Alertas activas
//       * Predicciones: time-to-empty / time-to-full
//       * Análisis de tendencia de temperatura y voltaje
//   - Análisis de salud:
//       * Health = current / design
//       * Capacidad real vs diseño
//       * Temperatura media histórica
//       * Recomendaciones ("Batería al 92% - normal")
//   - Alertas críticas basadas en:
//       * Ciclos > 80% del máximo
//       * Salud < 80%
//       * Temperatura media > 35°C
//       * Voltaje cae < 3.2V con > 20% de carga (celda degradada)
//   - Exportación a JSON / texto / informe formateado
//   - Integración con sysdiagnose
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { kernelBus } from "../kernel/kernel.jsx";
import { degradeCapacity, levelToVoltage } from "../hardware/chargefunction.js";

// ============================================================================
// CONSTANTES
// ============================================================================

export const BAT_HEALTH = Object.freeze({
  EXCELLENT: "excellent",   // >= 95%
  GOOD: "good",             // >= 85%
  FAIR: "fair",             // >= 75%
  POOR: "poor",             // >= 60%
  SERVICE: "service",       // < 60%
});

export const BAT_DIAG_EVENTS = Object.freeze({
  STARTED: "sysbatdiag:started",
  COMPLETE: "sysbatdiag:complete",
  WARNING: "sysbatdiag:warning",
  CRITICAL: "sysbatdiag:critical",
  LOG: "sysbatdiag:log",
});

// ============================================================================
// DIAGNÓSTICO
// ============================================================================

export class BatteryDiagnostic {
  constructor({ battery, chargeSystem, syslogs = null } = {}) {
    this.battery = battery;
    this.chargeSystem = chargeSystem;
    this.syslogs = syslogs;
    this.lastReport = null;
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

  _log(level, message, meta) {
    kernelBus.emit(BAT_DIAG_EVENTS.LOG, { ts: Date.now(), level, message, meta });
    this.syslogs?.emit?.(level, "com.rainos.sysbatdiag", "default", message, meta);
  }

  // --------------------------------------------------------------- health class
  _healthClass(health) {
    if (health >= 0.95) return BAT_HEALTH.EXCELLENT;
    if (health >= 0.85) return BAT_HEALTH.GOOD;
    if (health >= 0.75) return BAT_HEALTH.FAIR;
    if (health >= 0.60) return BAT_HEALTH.POOR;
    return BAT_HEALTH.SERVICE;
  }

  // --------------------------------------------------------------- análisis de historial
  _analyzeHistory(history) {
    if (!history || history.length === 0) {
      return {
        samples: 0,
        avgTemperatureC: null,
        maxTemperatureC: null,
        minTemperatureC: null,
        avgVoltageMv: null,
        voltageSlopeMvPerSec: null,
        temperatureSlopeCPerSec: null,
      };
    }

    let sumT = 0, sumV = 0;
    let minT = Infinity, maxT = -Infinity;
    let firstV = null, lastV = null;
    let firstT = null, lastT = null;

    for (const h of history) {
      sumT += h.temperature ?? 0;
      sumV += h.voltage ?? 0;
      if (h.temperature < minT) minT = h.temperature;
      if (h.temperature > maxT) maxT = h.temperature;
      if (firstV == null) firstV = h.voltage;
      lastV = h.voltage;
      if (firstT == null) firstT = h.temperature;
      lastT = h.temperature;
    }

    const n = history.length;
    const durationSec =
      history.length >= 2
        ? (history[history.length - 1].ts - history[0].ts) / 1000
        : 0;

    return {
      samples: n,
      avgTemperatureC: sumT / n,
      minTemperatureC: minT === Infinity ? null : minT,
      maxTemperatureC: maxT === -Infinity ? null : maxT,
      avgVoltageMv: sumV / n,
      voltageSlopeMvPerSec: durationSec > 0 ? (lastV - firstV) / durationSec : 0,
      temperatureSlopeCPerSec: durationSec > 0 ? (lastT - firstT) / durationSec : 0,
    };
  }

  // --------------------------------------------------------------- recomendar
  _recommendations(snapshot, analysis) {
    const recs = [];

    const health = snapshot.health ?? 1;
    const cycles = snapshot.cycleCount ?? 0;
    const temp = snapshot.temperatureC ?? 25;

    if (health >= 0.95) {
      recs.push({ level: "info", message: "Batería en excelente estado." });
    } else if (health >= 0.85) {
      recs.push({ level: "info", message: "Batería en buen estado." });
    } else if (health >= 0.75) {
      recs.push({
        level: "warn",
        message: `Batería con desgaste moderado (${Math.round(health * 100)}%).`,
      });
    } else if (health >= 0.60) {
      recs.push({
        level: "warn",
        message: `Batería degradada (${Math.round(health * 100)}%). Considera reemplazo.`,
      });
    } else {
      recs.push({
        level: "error",
        message: `Batería en mal estado (${Math.round(health * 100)}%). Reemplazo recomendado.`,
      });
    }

    if (cycles > 800) {
      recs.push({
        level: "warn",
        message: `Ciclos altos (${cycles}). Se recomienda servicio pronto.`,
      });
    }

    if (temp > 40) {
      recs.push({
        level: "error",
        message: `Temperatura elevada (${temp.toFixed(1)}°C). Deja enfriar antes de cargar.`,
      });
    } else if (temp > 35) {
      recs.push({
        level: "warn",
        message: `Temperatura algo alta (${temp.toFixed(1)}°C).`,
      });
    }

    if (analysis.maxTemperatureC != null && analysis.maxTemperatureC > 42) {
      recs.push({
        level: "warn",
        message: `Pico histórico de ${analysis.maxTemperatureC.toFixed(1)}°C detectado.`,
      });
    }

    if (snapshot.voltageMv < 3300 && snapshot.level > 0.2) {
      recs.push({
        level: "error",
        message: `Voltaje bajo (${snapshot.voltageMv}mV) con carga ${Math.round(
          snapshot.level * 100
        )}%. Posible celda degradada.`,
      });
    }

    return recs;
  }

  // --------------------------------------------------------------- generar informe
  generateReport() {
    if (!this.battery) {
      const empty = {
        ts: Date.now(),
        ok: false,
        error: "no battery attached",
      };
      this.lastReport = empty;
      this._emit(BAT_DIAG_EVENTS.COMPLETE, empty);
      return empty;
    }

    const batterySnap = this.battery.snapshot();
    const history = this.battery.historySnapshot();
    const chargeSnap = this.chargeSystem?.snapshot?.() ?? null;

    const analysis = this._analyzeHistory(history);
    const healthClass = this._healthClass(batterySnap.health);
    const recommendations = this._recommendations(batterySnap, analysis);

    // Proyección: ¿cuántos ciclos le quedan hasta llegar al 80%?
    const remainingTo80 = Math.max(
      0,
      Math.round((batterySnap.health - 0.8) / 0.0002)
    );

    // Degradación futura estimada
    const projectedHealth100Cycles = degradeCapacity(
      batterySnap.designCapacityMah,
      batterySnap.cycleCount + 100,
      analysis.avgTemperatureC ?? 25
    ) / batterySnap.designCapacityMah;

    const report = {
      ts: Date.now(),
      ok: true,
      battery: batterySnap,
      charger: chargeSnap,
      analysis,
      healthClass,
      recommendations,
      projections: {
        remainingCyclesTo80Pct: remainingTo80,
        projectedHealthAtPlus100Cycles: projectedHealth100Cycles,
      },
      criticalAlerts: recommendations.filter((r) => r.level === "error"),
      warnings: recommendations.filter((r) => r.level === "warn"),
    };

    this.lastReport = report;
    this._emit(BAT_DIAG_EVENTS.COMPLETE, report);
    this._log("info", "battery diagnostic complete", {
      health: batterySnap.health,
      class: healthClass,
    });

    for (const alert of report.criticalAlerts) {
      this._emit(BAT_DIAG_EVENTS.CRITICAL, alert);
    }
    for (const warn of report.warnings) {
      this._emit(BAT_DIAG_EVENTS.WARNING, warn);
    }

    return report;
  }

  // --------------------------------------------------------------- export
  toJSON(report = this.lastReport) {
    if (!report) return "";
    return JSON.stringify(report, null, 2);
  }

  toText(report = this.lastReport) {
    if (!report) return "";
    const lines = [];
    const b = report.battery;

    lines.push("==========================================");
    lines.push("  rainOS Battery Diagnostic");
    lines.push("==========================================");
    lines.push(`Timestamp: ${new Date(report.ts).toISOString()}`);
    lines.push("");
    lines.push("--- Estado actual ---");
    lines.push(`  Nivel:            ${Math.round(b.level * 100)}%`);
    lines.push(`  Estado:           ${b.state}`);
    lines.push(`  Enchufado:        ${b.plugged ? "Sí" : "No"}`);
    lines.push(`  Cargando:         ${b.charging ? "Sí" : "No"}`);
    lines.push(`  Voltaje:          ${b.voltageMv} mV`);
    lines.push(`  Corriente:        ${Math.round(b.amperageMa)} mA`);
    lines.push(`  Potencia:         ${b.wattageW.toFixed(2)} W`);
    lines.push(`  Temperatura:      ${b.temperatureC.toFixed(1)} °C`);
    lines.push("");
    lines.push("--- Salud ---");
    lines.push(`  Design capacity:  ${b.designCapacityMah} mAh`);
    lines.push(`  Max capacity:     ${b.maxCapacityMah} mAh`);
    lines.push(`  Current capacity: ${b.capacityMah} mAh`);
    lines.push(`  Health:           ${(b.health * 100).toFixed(2)}% (${report.healthClass})`);
    lines.push(`  Ciclos:           ${b.cycleCount}`);
    lines.push(`  Restantes a 80%:  ~${report.projections.remainingCyclesTo80Pct} ciclos`);
    lines.push(`  Health @+100:     ${(report.projections.projectedHealthAtPlus100Cycles * 100).toFixed(2)}%`);
    lines.push("");
    lines.push("--- Análisis histórico ---");
    lines.push(`  Muestras:         ${report.analysis.samples}`);
    if (report.analysis.avgTemperatureC != null) {
      lines.push(`  Temp media:       ${report.analysis.avgTemperatureC.toFixed(2)} °C`);
      lines.push(`  Temp min/max:     ${report.analysis.minTemperatureC.toFixed(1)} / ${report.analysis.maxTemperatureC.toFixed(1)} °C`);
      lines.push(`  Tendencia temp:   ${report.analysis.temperatureSlopeCPerSec.toFixed(6)} °C/s`);
      lines.push(`  Voltaje medio:    ${report.analysis.avgVoltageMv.toFixed(0)} mV`);
      lines.push(`  Tendencia volt:   ${report.analysis.voltageSlopeMvPerSec.toFixed(4)} mV/s`);
    }
    lines.push("");

    if (report.charger) {
      lines.push("--- Cargador ---");
      lines.push(`  Estado:           ${report.charger.state}`);
      lines.push(`  Tipo:             ${report.charger.chargerKind}`);
      lines.push(`  Potencia:         ${report.charger.chargerWatts} W`);
      lines.push(`  Eficiencia:       ${(report.charger.chargerEfficiency * 100).toFixed(1)}%`);
      lines.push(`  Negociado:        ${report.charger.negotiated ? "Sí" : "No"}`);
      lines.push(`  Optimizada:       ${report.charger.optimizedCharging ? "Sí" : "No"} (${Math.round(
        report.charger.optimizedLimit * 100
      )}%)`);
      if (report.charger.timeToFullMin != null && isFinite(report.charger.timeToFullMin)) {
        const h = Math.floor(report.charger.timeToFullMin / 60);
        const m = Math.floor(report.charger.timeToFullMin % 60);
        lines.push(`  Tiempo a lleno:   ${h}h ${m}m`);
      }
      lines.push("");
    }

    if (report.recommendations.length > 0) {
      lines.push("--- Recomendaciones ---");
      for (const r of report.recommendations) {
        const tag = r.level === "error" ? "ERROR" : r.level === "warn" ? "WARN " : "INFO ";
        lines.push(`  [${tag}] ${r.message}`);
      }
      lines.push("");
    }

    lines.push("==========================================");
    return lines.join("\n");
  }

  // --------------------------------------------------------------- download
  download({ format = "txt" } = {}) {
    const content = format === "json" ? this.toJSON() : this.toText();
    if (!content) return false;
    const mime = format === "json" ? "application/json" : "text/plain";
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    a.download = `battery-diagnostic-${ts}.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
}

// ============================================================================
// PROVIDER + HOOK
// ============================================================================

const BatDiagContext = React.createContext(null);

export function BatteryDiagnosticProvider({
  children,
  battery,
  chargeSystem,
  syslogs,
  diagnostic: external,
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current =
      external ||
      new BatteryDiagnostic({ battery, chargeSystem, syslogs });
  }
  const diag = ref.current;
  const [report, setReport] = useState(() => diag.lastReport);

  useEffect(() => {
    const unsub = diag.subscribe((event, payload) => {
      if (event === BAT_DIAG_EVENTS.COMPLETE) setReport(payload);
    });
    return unsub;
  }, [diag]);

  const api = useMemo(
    () => ({
      diagnostic: diag,
      report,
      generate: () => diag.generateReport(),
      toJSON: () => diag.toJSON(),
      toText: () => diag.toText(),
      download: (opts) => diag.download(opts),
      subscribe: (fn) => diag.subscribe(fn),
    }),
    [diag, report]
  );

  return (
    <BatDiagContext.Provider value={api}>{children}</BatDiagContext.Provider>
  );
}

export function useBatteryDiagnostic() {
  const ctx = React.useContext(BatDiagContext);
  if (!ctx)
    throw new Error("useBatteryDiagnostic must be used within BatteryDiagnosticProvider");
  return ctx;
}

export default {
  BatteryDiagnostic,
  BatteryDiagnosticProvider,
  useBatteryDiagnostic,
  BAT_HEALTH,
  BAT_DIAG_EVENTS,
};
