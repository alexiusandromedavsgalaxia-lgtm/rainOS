// ============================================================================
// chargefunction.js — Funciones puras de carga y descarga
// ----------------------------------------------------------------------------
// Modelos matemáticos para el subsistema de batería. Cero React, cero estado:
// solo funciones puras que dado un estado y un dt, devuelven el nuevo estado.
//
// MODELOS IMPLEMENTADOS
//
//   1. Curva de descarga Li-ion (no-lineal)
//   2. Curva de carga CC/CV (constant current / constant voltage)
//   3. Eficiencia del cargador según potencia
//   4. Temperatura: generación de calor por corriente + disipación
//   5. Degradación de capacidad según ciclos y temperatura
//   6. Estimación de tiempo restante con consumo variable
//   7. Modelo de optimización de carga (80% limit)
//   8. Detección de "trickle charge" cuando está al 100%
//
// REFERENCIAS
//
//   - Battery University BU-409: Charging Lithium-Ion
//   - BU-501: Basics about Discharging
//   - BU-802b: What does Elevated Self-discharge do?
//   - Hoja de datos de celdas Li-ion tipo NMC 3.7V
// ============================================================================

// ============================================================================
// 1. CURVA DE DESCARGA
// ----------------------------------------------------------------------------
// Relación nivel ↔ voltaje. Li-ion real:
//
//   100% → 4.20V
//    90% → 4.06V
//    80% → 3.98V
//    70% → 3.87V
//    60% → 3.79V
//    50% → 3.72V
//    40% → 3.65V
//    30% → 3.58V
//    20% → 3.49V
//    10% → 3.38V
//     5% → 3.28V
//     0% → 3.00V
//
// Ajustamos una curva de tipo polinómica con corrección de extremos.
// ============================================================================

/**
 * Convierte nivel (0..1) a voltaje (mV) según curva Li-ion.
 * @param {number} level - 0..1
 * @param {{minVoltageMv: number, maxVoltageMv: number}} opts
 * @returns {number} voltaje en mV
 */
export function levelToVoltage(level, { minVoltageMv = 3000, maxVoltageMv = 4200 } = {}) {
  const t = clamp(level, 0, 1);
  // Ajuste para que los extremos caigan rápido
  // Usamos una combinación de lineal + spline cúbico simple
  const anchored = t * 0.7 + smoothstep(0.15, 0.85, t) * 0.3;
  return Math.round(lerp(minVoltageMv, maxVoltageMv, anchored));
}

/**
 * Convierte voltaje a nivel aproximado.
 */
export function voltageToLevel(voltageMv, opts) {
  const min = opts.minVoltageMv ?? 3000;
  const max = opts.maxVoltageMv ?? 4200;
  const t = clamp((voltageMv - min) / (max - min), 0, 1);
  // Invertir smoothstep
  return clamp((t - 0.15) / 0.7, 0, 1);
}

// ============================================================================
// 2. CARGA CC/CV
// ----------------------------------------------------------------------------
// Fase 1 (CC — Constant Current): carga a corriente fija hasta ~80% del SOC.
// Fase 2 (CV — Constant Voltage): voltaje fijo (4.2V), corriente decae
//   exponencialmente hasta el corte (~C/20).
// ============================================================================

/**
 * Devuelve la corriente de carga (mA) dado el estado actual.
 * @param {number} level - nivel actual 0..1
 * @param {object} battery - { capacityMah, voltageMv, temperatureC, design }
 * @param {object} opts - { chargerWatts, efficiency }
 * @returns {number} mA positivos (carga)
 */
export function chargeCurrentCCCV(level, battery, opts = {}) {
  const chargerWatts = opts.chargerWatts ?? 18;
  const efficiency = opts.efficiency ?? battery.design?.chargerEfficiency ?? 0.85;
  const capacityMah = battery.capacityMah;
  const voltageMv = battery.voltageMv;
  const ccThreshold = 0.8; // CC hasta 80%

  // Corriente máxima teórica según potencia
  const maxCurrentMa = (chargerWatts * efficiency * 1000) / voltageMv * 1000;

  // Fase CC: corriente máx pero limitada a C-rate
  const maxCrate = 1.0; // 1C
  const ccCurrentMa = Math.min(maxCurrentMa, capacityMah * maxCrate);

  if (level < ccThreshold) {
    // CC pura
    return ccCurrentMa;
  }

  // Fase CV: decae exponencialmente de 1C a C/20 entre 80% y 100%
  const t = (level - ccThreshold) / (1 - ccThreshold); // 0..1
  const decay = Math.exp(-4 * t);
  const cvCurrentMa = ccCurrentMa * Math.max(0.05, decay);
  return cvCurrentMa;
}

/**
 * Aplica un tick de carga. Devuelve el nuevo estado.
 * @param {object} state - { level, temperatureC, capacityMah, voltageMv }
 * @param {number} dtSec - segundos transcurridos
 * @param {object} opts - { chargerWatts, efficiency, loadWatts, optimizedLimit }
 */
export function applyChargeTick(state, dtSec, opts = {}) {
  const {
    chargerWatts = 18,
    efficiency = 0.85,
    loadWatts = 4.5,
    optimizedLimit = 1.0,
  } = opts;

  // ¿Estamos en el límite de optimización?
  if (state.level >= optimizedLimit - 0.001) {
    // Trickle charge — mantener nivel
    return {
      ...state,
      amperageMa: 0,
      wattageW: 0,
      temperatureC: clamp(state.temperatureC - 0.01 * dtSec, 20, 50),
    };
  }

  const currentMa = chargeCurrentCCCV(state.level, state, {
    chargerWatts,
    efficiency,
  });

  // Restar consumo
  const loadCurrentMa = (loadWatts * 1000) / state.voltageMv * 1000;
  const netCurrentMa = currentMa - loadCurrentMa;

  // Δ nivel = corriente * dt / capacidad
  const deltaLevel = (netCurrentMa * dtSec) / state.capacityMah / 1000;

  const newLevel = clamp(state.level + deltaLevel, 0, 1);

  // Nuevo voltaje
  const voltageMv = levelToVoltage(newLevel, state.design || {});

  // Calor: pérdidas I²R aproximadas
  const internalResistanceOhm = 0.05; // 50 mΩ típico
  const currentA = netCurrentMa / 1000;
  const heatW = currentA * currentA * internalResistanceOhm;
  const heatRateCPerSec = heatW * 0.3; // inercia térmica
  const coolingRateCPerSec = 0.005;

  const newTemp = clamp(
    state.temperatureC + (heatRateCPerSec - coolingRateCPerSec) * dtSec,
    15,
    60
  );

  return {
    ...state,
    level: newLevel,
    voltageMv,
    amperageMa: netCurrentMa,
    wattageW: (netCurrentMa * voltageMv) / 1000000,
    temperatureC: newTemp,
  };
}

// ============================================================================
// 3. DESCARGA
// ============================================================================

/**
 * Aplica un tick de descarga.
 */
export function applyDischargeTick(state, dtSec, opts = {}) {
  const { loadWatts = 4.5, lowPowerFactor = 1.0 } = opts;

  const effectiveLoad = loadWatts * lowPowerFactor;
  const currentMa = (effectiveLoad * 1000) / state.voltageMv * 1000;

  const deltaLevel = (currentMa * dtSec) / state.capacityMah / 1000;
  const newLevel = clamp(state.level - deltaLevel, 0, 1);
  const voltageMv = levelToVoltage(newLevel, state.design || {});

  // Batería se enfría lentamente al descargar (menos pérdidas)
  const newTemp = clamp(state.temperatureC - 0.008 * dtSec, 15, 60);

  return {
    ...state,
    level: newLevel,
    voltageMv,
    amperageMa: -currentMa,
    wattageW: (-currentMa * voltageMv) / 1000000,
    temperatureC: newTemp,
  };
}

// ============================================================================
// 4. TIEMPO RESTANTE
// ============================================================================

/**
 * Estima minutos restantes de carga/descarga según estado y consumo.
 */
export function estimateTimeTo(state, { charging, loadWatts = 4.5, chargerWatts = 18 } = {}) {
  const capacityMah = state.capacityMah;
  const level = state.level;

  if (charging) {
    const currentMa = chargeCurrentCCCV(level, state, { chargerWatts });
    const loadCurrentMa = (loadWatts * 1000) / state.voltageMv * 1000;
    const netMa = currentMa - loadCurrentMa;
    if (netMa <= 0) return Infinity;
    const missingMah = (1 - level) * capacityMah;
    // El tiempo con corriente decreciente se aproxima con integral
    // Simplificamos con un factor corrector de 1.15 (fase CV más lenta)
    return ((missingMah / netMa) * 60) * 1.15;
  }

  const currentMa = (loadWatts * 1000) / state.voltageMv * 1000;
  if (currentMa <= 0) return Infinity;
  const remainingMah = level * capacityMah;
  return (remainingMah / currentMa) * 60;
}

// ============================================================================
// 5. DEGRADACIÓN
// ============================================================================

/**
 * Degradación de capacidad según ciclos y temperatura.
 * Modelo típico: 20% de pérdida a 1000 ciclos (0.02% por ciclo).
 * Penalización extra si se carga a alta temperatura.
 */
export function degradeCapacity(designCapacityMah, cycleCount, avgTemperatureC = 25) {
  const cycleLoss = cycleCount * 0.0002; // 0.02%/ciclo
  const tempPenalty = Math.max(0, avgTemperatureC - 25) * 0.0001 * cycleCount / 100;
  const health = clamp(1 - cycleLoss - tempPenalty, 0.5, 1);
  return Math.round(designCapacityMah * health);
}

// ============================================================================
// 6. OPTIMIZACIÓN DE CARGA
// ============================================================================

/**
 * Decide si se debe parar la carga según el modo optimizado.
 * @returns {boolean} true si hay que parar
 */
export function shouldStopCharging(level, optimized, optimizedLimit = 0.8) {
  if (!optimized) return level >= 0.999;
  return level >= optimizedLimit - 0.001;
}

/**
 * Decide si hay que reanudar tras parar por optimización.
 * Regla: reanudar si baja del 75% y sigue enchufado.
 */
export function shouldResumeCharging(level, optimized, optimizedLimit = 0.8) {
  if (!optimized) return false;
  return level < optimizedLimit - 0.05;
}

// ============================================================================
// 7. EFICIENCIA DEL CARGADOR
// ============================================================================

/**
 * Eficiencia del cargador según potencia de salida.
 * Los cargadores USB-C PD tienen eficiencia 85-92% en su rango óptimo.
 */
export function chargerEfficiency(watts) {
  if (watts < 5) return 0.75;
  if (watts < 10) return 0.82;
  if (watts < 18) return 0.87;
  if (watts < 30) return 0.9;
  if (watts < 65) return 0.92;
  return 0.9;
}

// ============================================================================
// 8. HELPERS INTERNOS
// ============================================================================

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// ============================================================================
// EXPORTS AGRUPADOS
// ============================================================================

export default {
  levelToVoltage,
  voltageToLevel,
  chargeCurrentCCCV,
  applyChargeTick,
  applyDischargeTick,
  estimateTimeTo,
  degradeCapacity,
  shouldStopCharging,
  shouldResumeCharging,
  chargerEfficiency,
};
