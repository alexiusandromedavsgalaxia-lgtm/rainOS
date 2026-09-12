// ============================================================================
// audiocomponent.js — Componentes puros de audio (sin React)
// ----------------------------------------------------------------------------
// Utilidades matemáticas, formatos, conversiones y helpers que se usan en el
// resto del subsistema de audio. Cero estado, cero React, cero efectos
// secundarios. Todo son funciones puras y clases sin estado externo.
//
// CONTENIDO
//
//   - Conversiones: dB ↔ gain, Hz ↔ mel, semitonos ↔ ratio
//   - Formatos de audio: WAV, MP3, OGG, FLAC, AAC, M4A
//   - Cálculo de duración y tamaño
//   - Curva de volumen perceptual (potencia 2/3)
//   - Interpolación de buffers (cubic hermite)
//   - Crossfade entre dos buffers
//   - Resampling lineal
//   - Downmix 5.1 → estéreo
//   - Normalización de picos
//   - Análisis de espectro: bandas de octava
//   - Cálculo de LUFS (Loudness Units Full Scale)
//   - Detección de silencio
//   - Fade in/out
//   - Generador de tonos (sine, square, saw, noise)
//   - Beat detection (BPM)
// ============================================================================

// ============================================================================
// CONVERSIONES
// ============================================================================

/**
 * Convierte decibelios a ganancia lineal (amplitud).
 */
export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/**
 * Convierte ganancia lineal a decibelios.
 */
export function gainToDb(gain) {
  if (gain <= 0) return -Infinity;
  return 20 * Math.log10(gain);
}

/**
 * Convierte hercios a mel (escala perceptual).
 */
export function hzToMel(hz) {
  return 2595 * Math.log10(1 + hz / 700);
}

/**
 * Convierte mel a hercios.
 */
export function melToHz(mel) {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

/**
 * Convierte semitonos a ratio de frecuencia.
 */
export function semitonesToRatio(semitones) {
  return Math.pow(2, semitones / 12);
}

/**
 * Convierte ratio de frecuencia a semitonos.
 */
export function ratioToSemitones(ratio) {
  return 12 * Math.log2(ratio);
}

/**
 * Convierte ratio a cents.
 */
export function ratioToCents(ratio) {
  return 1200 * Math.log2(ratio);
}

/**
 * Curva de volumen perceptual.
 * macOS/iOS usan aproximadamente una potencia de 2/3.
 */
export function perceptualVolume(linear) {
  return Math.pow(Math.max(0, Math.min(1, linear)), 2 / 3);
}

/**
 * Inversa de perceptualVolume.
 */
export function linearVolume(perceptual) {
  return Math.pow(Math.max(0, Math.min(1, perceptual)), 1.5);
}

/**
 * Convierte un valor de 0..1 a un valor perceptualmente suave (smoothstep).
 */
export function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ============================================================================
// FORMATOS DE AUDIO
// ============================================================================

export const AUDIO_FORMATS = Object.freeze({
  wav: {
    mime: "audio/wav",
    extension: ".wav",
    lossless: true,
    lossless_compression: false,
    channels: "any",
    sampleRates: [8000, 16000, 22050, 44100, 48000, 96000, 192000],
    bitDepths: [8, 16, 24, 32],
  },
  mp3: {
    mime: "audio/mpeg",
    extension: ".mp3",
    lossless: false,
    lossless_compression: false,
    channels: [1, 2],
    sampleRates: [22050, 32000, 44100, 48000],
    bitrates: [32, 64, 96, 128, 160, 192, 256, 320],
  },
  ogg: {
    mime: "audio/ogg",
    extension: ".ogg",
    lossless: false,
    lossless_compression: false,
    channels: [1, 2],
    sampleRates: [44100, 48000],
  },
  flac: {
    mime: "audio/flac",
    extension: ".flac",
    lossless: true,
    lossless_compression: true,
    channels: "any",
    sampleRates: [44100, 48000, 96000, 192000],
    bitDepths: [16, 24],
  },
  aac: {
    mime: "audio/aac",
    extension: ".aac",
    lossless: false,
    lossless_compression: false,
    channels: [1, 2, 6],
    sampleRates: [44100, 48000],
    bitrates: [128, 192, 256],
  },
  m4a: {
    mime: "audio/mp4",
    extension: ".m4a",
    lossless: false,
    lossless_compression: false,
    channels: [1, 2, 6],
    sampleRates: [44100, 48000, 96000],
  },
  opus: {
    mime: "audio/opus",
    extension: ".opus",
    lossless: false,
    lossless_compression: false,
    channels: [1, 2, 6],
    sampleRates: [48000],
    bitrates: [6, 12, 24, 48, 96, 128, 192, 510],
  },
});

/**
 * Estima el tamaño de un archivo PCM sin compresión.
 */
export function estimatePcmSize(durationSec, sampleRate, channels, bitDepth) {
  return durationSec * sampleRate * channels * (bitDepth / 8);
}

/**
 * Estima el tamaño de un archivo con bitrate (MP3, AAC, etc.).
 */
export function estimateCompressedSize(durationSec, bitrateKbps) {
  return (durationSec * bitrateKbps * 1000) / 8;
}

/**
 * Estima la duración de un archivo comprimido dado su tamaño y bitrate.
 */
export function estimateDurationCompressed(bytes, bitrateKbps) {
  return (bytes * 8) / (bitrateKbps * 1000);
}

/**
 * Convierte una duración de segundos a texto (mm:ss o h:mm:ss).
 */
export function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ============================================================================
// INTERPOLACIÓN Y RESAMPLING
// ============================================================================

/**
 * Interpolación cúbica hermite entre 4 puntos.
 */
export function hermite(y0, y1, y2, y3, t) {
  const c0 = y1;
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * t + c2) * t + c1) * t + c0;
}

/**
 * Resampling lineal de un buffer Float32Array.
 */
export function resampleLinear(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;
  const ratio = outputRate / inputRate;
  const outLen = Math.round(input.length * ratio);
  const output = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i / ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = srcIdx - i0;
    output[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return output;
}

/**
 * Resampling con interpolación cúbica (mejor calidad).
 */
export function resampleCubic(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;
  const ratio = outputRate / inputRate;
  const outLen = Math.round(input.length * ratio);
  const output = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i / ratio;
    const i0 = Math.floor(srcIdx);
    const y0 = input[Math.max(0, i0 - 1)] ?? 0;
    const y1 = input[i0] ?? 0;
    const y2 = input[i0 + 1] ?? 0;
    const y3 = input[i0 + 2] ?? 0;
    const t = srcIdx - i0;
    output[i] = hermite(y0, y1, y2, y3, t);
  }
  return output;
}

// ============================================================================
// CROSSFADE Y FADES
// ============================================================================

/**
 * Crossfade entre dos buffers del mismo tamaño.
 * @returns {Float32Array} buffer combinado
 */
export function crossfade(bufferA, bufferB, t) {
  const len = Math.min(bufferA.length, bufferB.length);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = bufferA[i] * (1 - t) + bufferB[i] * t;
  }
  return out;
}

/**
 * Aplica un fade in lineal al buffer.
 */
export function applyFadeIn(buffer, durationSec, sampleRate) {
  const fadeSamples = Math.min(buffer.length, Math.floor(durationSec * sampleRate));
  for (let i = 0; i < fadeSamples; i++) {
    buffer[i] *= i / fadeSamples;
  }
  return buffer;
}

/**
 * Aplica un fade out lineal al buffer.
 */
export function applyFadeOut(buffer, durationSec, sampleRate) {
  const fadeSamples = Math.min(buffer.length, Math.floor(durationSec * sampleRate));
  const start = buffer.length - fadeSamples;
  for (let i = 0; i < fadeSamples; i++) {
    buffer[start + i] *= 1 - i / fadeSamples;
  }
  return buffer;
}

// ============================================================================
// DOWNMIX / UPMMIX
// ============================================================================

/**
 * Downmix de 5.1 a estéreo (ITU-R BS.775).
 */
export function downmix51ToStereo(left, right, center, lfe, surroundLeft, surroundRight) {
  const len = left.length;
  const outL = new Float32Array(len);
  const outR = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    outL[i] = left[i] + center[i] * 0.707 + surroundLeft[i] * 0.707 + lfe[i] * 0.5;
    outR[i] = right[i] + center[i] * 0.707 + surroundRight[i] * 0.707 + lfe[i] * 0.5;
  }
  return { left: outL, right: outR };
}

/**
 * Downmix mono a estéreo (duplicando).
 */
export function downmixMonoToStereo(mono) {
  return { left: mono, right: mono };
}

// ============================================================================
// NORMALIZACIÓN Y ANÁLISIS
// ============================================================================

/**
 * Encuentra el pico máximo en un buffer.
 */
export function findPeak(buffer) {
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) {
    const a = Math.abs(buffer[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * Calcula el RMS de un buffer.
 */
export function calculateRms(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i] * buffer[i];
  }
  return Math.sqrt(sum / buffer.length);
}

/**
 * Normaliza un buffer al pico dado (0..1).
 */
export function normalizePeak(buffer, targetPeak = 0.95) {
  const peak = findPeak(buffer);
  if (peak === 0) return buffer;
  const gain = targetPeak / peak;
  for (let i = 0; i < buffer.length; i++) buffer[i] *= gain;
  return buffer;
}

/**
 * Detecta si un buffer es silencio (por debajo de un umbral).
 */
export function isSilent(buffer, threshold = 0.001) {
  for (let i = 0; i < buffer.length; i++) {
    if (Math.abs(buffer[i]) > threshold) return false;
  }
  return true;
}

/**
 * Encuentra el inicio real del audio (skip silence).
 */
export function findAudioStart(buffer, threshold = 0.01) {
  for (let i = 0; i < buffer.length; i++) {
    if (Math.abs(buffer[i]) > threshold) return i;
  }
  return buffer.length;
}

/**
 * Encuentra el fin real del audio.
 */
export function findAudioEnd(buffer, threshold = 0.01) {
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (Math.abs(buffer[i]) > threshold) return i + 1;
  }
  return 0;
}

/**
 * Calcula LUFS (Loudness Units Full Scale) aproximado.
 * Es una versión simplificada sin K-weighting.
 */
export function approximateLufs(buffer) {
  const rms = calculateRms(buffer);
  return -0.691 + 20 * Math.log10(rms || 1e-10);
}

// ============================================================================
// GENERADORES DE TONO
// ============================================================================

/**
 * Genera un buffer de onda senoidal.
 */
export function generateSine(freq, durationSec, sampleRate, amplitude = 0.5) {
  const len = Math.floor(durationSec * sampleRate);
  const buffer = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    buffer[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return buffer;
}

/**
 * Genera un buffer de onda cuadrada.
 */
export function generateSquare(freq, durationSec, sampleRate, amplitude = 0.3) {
  const len = Math.floor(durationSec * sampleRate);
  const buffer = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const phase = (freq * i) / sampleRate;
    buffer[i] = amplitude * (phase % 1 < 0.5 ? 1 : -1);
  }
  return buffer;
}

/**
 * Genera un buffer de onda diente de sierra.
 */
export function generateSawtooth(freq, durationSec, sampleRate, amplitude = 0.3) {
  const len = Math.floor(durationSec * sampleRate);
  const buffer = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const phase = (freq * i) / sampleRate;
    buffer[i] = amplitude * (2 * (phase % 1) - 1);
  }
  return buffer;
}

/**
 * Genera ruido blanco.
 */
export function generateWhiteNoise(durationSec, sampleRate, amplitude = 0.1) {
  const len = Math.floor(durationSec * sampleRate);
  const buffer = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    buffer[i] = amplitude * (Math.random() * 2 - 1);
  }
  return buffer;
}

// ============================================================================
// BANDAS DE OCTAVA
// ============================================================================

/**
 * Frecuencias centrales de las bandas de octava estándar.
 */
export const OCTAVE_BANDS = [
  31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
];

/**
 * Dado un spectrum bin (0..N-1) y sampleRate, agrupa en bandas de octava.
 */
export function spectrumToOctaveBands(spectrum, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  const bands = new Array(OCTAVE_BANDS.length).fill(0);
  const counts = new Array(OCTAVE_BANDS.length).fill(0);

  for (let i = 0; i < spectrum.length; i++) {
    const freq = i * binHz;
    for (let b = 0; b < OCTAVE_BANDS.length; b++) {
      const center = OCTAVE_BANDS[b];
      const low = center / Math.sqrt(2);
      const high = center * Math.sqrt(2);
      if (freq >= low && freq < high) {
        bands[b] += spectrum[i];
        counts[b]++;
        break;
      }
    }
  }

  return bands.map((sum, i) => (counts[i] > 0 ? sum / counts[i] : 0));
}

// ============================================================================
// BEAT DETECTION
// ============================================================================

/**
 * Detección simple de BPM basada en picos de energía.
 * @param {Uint8Array} spectrum — spectrum del AnalyserNode
 * @returns {number} BPM aproximado
 */
export function detectBpm(spectrumHistory, sampleRate = 60) {
  if (!spectrumHistory || spectrumHistory.length < 2) return 0;

  // Calculamos energía baja (kicks) por frame
  const energy = spectrumHistory.map((spectrum) => {
    let sum = 0;
    for (let i = 0; i < 20; i++) sum += spectrum[i] || 0;
    return sum;
  });

  // Detectar picos
  const peaks = [];
  for (let i = 1; i < energy.length - 1; i++) {
    if (energy[i] > energy[i - 1] * 1.3 && energy[i] > energy[i + 1] * 1.3) {
      peaks.push(i);
    }
  }

  if (peaks.length < 2) return 0;

  // Intervalos entre picos
  const intervals = [];
  for (let i = 1; i < peaks.length; i++) {
    intervals.push(peaks[i] - peaks[i - 1]);
  }

  // Mediana de intervalos
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];

  // BPM = 60 / (intervalo_en_segundos)
  const seconds = median / sampleRate;
  const bpm = 60 / seconds;

  // Normalizar a 60-180
  let normalized = bpm;
  while (normalized < 60) normalized *= 2;
  while (normalized > 180) normalized /= 2;

  return Math.round(normalized);
}

// ============================================================================
// HELPERS ADICIONALES
// ============================================================================

/**
 * Convierte un array de bytes a Float32Array normalizado -1..1.
 */
export function pcm16ToFloat32(int16Array) {
  const out = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    out[i] = int16Array[i] / 32768;
  }
  return out;
}

/**
 * Convierte un Float32Array a PCM16.
 */
export function float32ToPcm16(float32Array) {
  const out = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Codifica un Float32Array en WAV (header + datos PCM16).
 */
export function encodeWav(float32Array, sampleRate, channels = 1) {
  const pcm = float32ToPcm16(float32Array);
  const dataSize = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(44 + i * 2, pcm[i], true);
  }

  return buffer;
}

export default {
  dbToGain,
  gainToDb,
  hzToMel,
  melToHz,
  semitonesToRatio,
  ratioToSemitones,
  ratioToCents,
  perceptualVolume,
  linearVolume,
  smoothstep,
  AUDIO_FORMATS,
  estimatePcmSize,
  estimateCompressedSize,
  estimateDurationCompressed,
  formatDuration,
  hermite,
  resampleLinear,
  resampleCubic,
  crossfade,
  applyFadeIn,
  applyFadeOut,
  downmix51ToStereo,
  downmixMonoToStereo,
  findPeak,
  calculateRms,
  normalizePeak,
  isSilent,
  findAudioStart,
  findAudioEnd,
  approximateLufs,
  generateSine,
  generateSquare,
  generateSawtooth,
  generateWhiteNoise,
  OCTAVE_BANDS,
  spectrumToOctaveBands,
  detectBpm,
  pcm16ToFloat32,
  float32ToPcm16,
  encodeWav,
};
