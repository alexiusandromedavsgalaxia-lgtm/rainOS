// ============================================================================
// playerbackground.js — Fondo animado del reproductor
// ----------------------------------------------------------------------------
// Genera un fondo visual dinámico que reacciona al audio que está sonando:
//
//   - Gradientes animados con la paleta de la portada
//   - Visualizador de barras en el fondo
//   - Blobs / partículas que pulsan con el beat
//   - Ondas circulares expansivas
//   - Modo "album colors" → extrae la paleta dominante del artwork
//   - Modo "spectrum bars" → barras de FFT de fondo
//   - Modo "wave" → onda sinusoidal que sigue la música
//   - Modo "particles" → partículas que vuelan
//   - Modo "blur" → la portada borrosa de fondo
//   - Modo "auto" → elige según el género / tempo detectado
//
// No usa librerías externas. Todo con Canvas 2D y requestAnimationFrame.
// ============================================================================

import { formatDuration } from "./audiocomponent-helpers.js";

// (si no tienes el archivo auxiliar, la función formatDuration también está en
//  audiocomponent.js; puedes importarla de ahí)

// ============================================================================
// CONSTANTES
// ============================================================================

export const PLAYER_BG_MODE = Object.freeze({
  AUTO: "auto",
  ALBUM_COLORS: "album-colors",
  SPECTRUM_BARS: "spectrum-bars",
  WAVE: "wave",
  PARTICLES: "particles",
  BLUR: "blur",
  ORB: "orb",
  GRADIENT: "gradient",
  NONE: "none",
});

export const PLAYER_BG_DEFAULTS = Object.freeze({
  mode: PLAYER_BG_MODE.AUTO,
  brightness: 0.8,
  saturation: 1.2,
  animationSpeed: 1.0,
  blurAmount: 0,
  particleCount: 80,
  waveLayers: 4,
  colorMode: "spectrum", // "spectrum" | "artwork" | "custom"
  customColors: ["#ff3366", "#7c3aed", "#0a84ff", "#ffd60a"],
  showVignette: true,
  reactToBeat: true,
});

// ============================================================================
// EXTRACCIÓN DE COLORES
// ----------------------------------------------------------------------------
// Saca la paleta dominante de una imagen (artwork) usando muestreo + k-means
// simplificado. Es lo que hace macOS/iOS con la portada del álbum.
// ============================================================================

export function extractAlbumColors(image, { count = 5 } = {}) {
  if (!image) return PLAYER_BG_DEFAULTS.customColors;

  const canvas = document.createElement("canvas");
  const size = 64;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, size, size);

  const data = ctx.getImageData(0, 0, size, size).data;
  const samples = [];
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 128) continue;
    // Ignorar casi-blancos y casi-negros
    const brightness = (r + g + b) / 3;
    if (brightness < 20 || brightness > 235) continue;
    samples.push([r, g, b]);
  }

  if (samples.length === 0) return PLAYER_BG_DEFAULTS.customColors;

  // K-means simplificado
  const centroids = [];
  for (let i = 0; i < count; i++) {
    centroids.push(samples[Math.floor((i / count) * samples.length)]);
  }

  const assignments = new Array(samples.length).fill(0);
  for (let iter = 0; iter < 8; iter++) {
    // Asignar
    for (let i = 0; i < samples.length; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const dr = samples[i][0] - centroids[c][0];
        const dg = samples[i][1] - centroids[c][1];
        const db = samples[i][2] - centroids[c][2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      assignments[i] = best;
    }
    // Recalcular centroides
    const sums = centroids.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < samples.length; i++) {
      const c = assignments[i];
      sums[c][0] += samples[i][0];
      sums[c][1] += samples[i][1];
      sums[c][2] += samples[i][2];
      sums[c][3]++;
    }
    for (let c = 0; c < centroids.length; c++) {
      if (sums[c][3] > 0) {
        centroids[c] = [
          Math.round(sums[c][0] / sums[c][3]),
          Math.round(sums[c][1] / sums[c][3]),
          Math.round(sums[c][2] / sums[c][3]),
        ];
      }
    }
  }

  return centroids.map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`);
}

// ============================================================================
// PLAYER BACKGROUND (clase pura)
// ----------------------------------------------------------------------------
// No es un componente React: es una clase que controla un canvas.
// PlayerMediaBackground (React) la usa internamente.
// ============================================================================

export class PlayerBackground {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.options = { ...PLAYER_BG_DEFAULTS, ...options };

    this.width = 0;
    this.height = 0;
    this.dpr = window.devicePixelRatio || 1;

    this.playing = false;
    this.bpm = 0;
    this.beatEnergy = 0;
    this.spectrum = null;
    this.waveform = null;
    this.albumColors = options.albumColors || this.options.customColors;

    this.particles = [];
    this.waves = [];
    this.blobs = [];
    this.time = 0;
    this.lastFrame = 0;

    this.rafRef = null;
    this._destroyed = false;

    this._initParticles();
    this._initWaves();
    this._initBlobs();
    this._resize();
  }

  // -------------------------------------------------------------- init
  _initParticles() {
    this.particles = [];
    for (let i = 0; i < this.options.particleCount; i++) {
      this.particles.push(this._newParticle());
    }
  }

  _newParticle() {
    const angle = Math.random() * Math.PI * 2;
    const speed = 20 + Math.random() * 80;
    const color =
      this.albumColors[Math.floor(Math.random() * this.albumColors.length)];
    return {
      x: this.width / 2,
      y: this.height / 2,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 1 + Math.random() * 3,
      life: 0,
      maxLife: 3 + Math.random() * 5,
      color,
      alpha: 0.3 + Math.random() * 0.5,
    };
  }

  _initWaves() {
    this.waves = [];
    for (let i = 0; i < this.options.waveLayers; i++) {
      this.waves.push({
        amplitude: 40 + i * 20,
        frequency: 0.005 + i * 0.002,
        speed: 0.5 + i * 0.2,
        phase: Math.random() * Math.PI * 2,
        color: this.albumColors[i % this.albumColors.length],
        alpha: 0.15 - i * 0.02,
      });
    }
  }

  _initBlobs() {
    this.blobs = [];
    const count = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      this.blobs.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        vx: (Math.random() - 0.5) * 30,
        vy: (Math.random() - 0.5) * 30,
        radius: 100 + Math.random() * 200,
        color: this.albumColors[i % this.albumColors.length],
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  // -------------------------------------------------------------- config
  setMode(mode) {
    this.options.mode = mode;
  }

  setAlbumColors(colors) {
    this.albumColors = colors;
    this._initParticles();
    this._initWaves();
    this._initBlobs();
  }

  setOptions(patch) {
    this.options = { ...this.options, ...patch };
    if (patch.particleCount != null) this._initParticles();
    if (patch.waveLayers != null) this._initWaves();
  }

  setPlaying(playing) {
    this.playing = playing;
  }

  updateAudioData({ spectrum, waveform, beatEnergy, bpm }) {
    if (spectrum) this.spectrum = spectrum;
    if (waveform) this.waveform = waveform;
    if (beatEnergy != null) this.beatEnergy = beatEnergy;
    if (bpm != null) this.bpm = bpm;
  }

  // -------------------------------------------------------------- resize
  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width * this.dpr;
    this.height = rect.height * this.dpr;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
  }

  handleResize() {
    this._resize();
    this._initBlobs();
  }

  // -------------------------------------------------------------- render
  start() {
    if (this.rafRef) return;
    this.lastFrame = performance.now();
    const loop = (now) => {
      if (this._destroyed) return;
      const dt = (now - this.lastFrame) / 1000;
      this.lastFrame = now;
      this._tick(dt);
      this._render();
      this.rafRef = requestAnimationFrame(loop);
    };
    this.rafRef = requestAnimationFrame(loop);
  }

  stop() {
    if (this.rafRef) {
      cancelAnimationFrame(this.rafRef);
      this.rafRef = null;
    }
  }

  destroy() {
    this._destroyed = true;
    this.stop();
  }

  // -------------------------------------------------------------- tick
  _tick(dt) {
    this.time += dt * this.options.animationSpeed;

    // Actualizar partículas
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life += dt;

      // Rebotar en bordes
      if (p.x < 0 || p.x > this.width) p.vx *= -1;
      if (p.y < 0 || p.y > this.height) p.vy *= -1;

      if (p.life > p.maxLife) {
        Object.assign(p, this._newParticle());
        p.x = this.width / 2;
        p.y = this.height / 2;
      }
    }

    // Actualizar blobs
    for (const blob of this.blobs) {
      blob.x += blob.vx * dt;
      blob.y += blob.vy * dt;
      blob.phase += dt * 0.5;

      // Rebotar
      if (blob.x < -blob.radius || blob.x > this.width + blob.radius) {
        blob.vx *= -1;
      }
      if (blob.y < -blob.radius || blob.y > this.height + blob.radius) {
        blob.vy *= -1;
      }
    }

    // Actualizar waves
    for (const wave of this.waves) {
      wave.phase += dt * wave.speed;
    }
  }

  // -------------------------------------------------------------- render
  _render() {
    const { ctx } = this;
    const { width, height } = this;

    ctx.clearRect(0, 0, width, height);

    // Base: gradiente de dos colores dominantes
    const c1 = this.albumColors[0] || "#000";
    const c2 = this.albumColors[1] || "#111";
    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // Capas por modo
    const mode = this._resolveMode();

    switch (mode) {
      case PLAYER_BG_MODE.ALBUM_COLORS:
        this._renderBlobs();
        break;
      case PLAYER_BG_MODE.SPECTRUM_BARS:
        this._renderSpectrumBars();
        break;
      case PLAYER_BG_MODE.WAVE:
        this._renderWaves();
        break;
      case PLAYER_BG_MODE.PARTICLES:
        this._renderParticles();
        break;
      case PLAYER_BG_MODE.BLUR:
        this._renderBlur();
        break;
      case PLAYER_BG_MODE.ORB:
        this._renderOrb();
        break;
      case PLAYER_BG_MODE.GRADIENT:
        this._renderAnimatedGradient();
        break;
      case PLAYER_BG_MODE.NONE:
      default:
        break;
    }

    // Vignette
    if (this.options.showVignette) {
      const v = ctx.createRadialGradient(
        width / 2,
        height / 2,
        Math.min(width, height) * 0.2,
        width / 2,
        height / 2,
        Math.max(width, height) * 0.7
      );
      v.addColorStop(0, "rgba(0,0,0,0)");
      v.addColorStop(1, "rgba(0,0,0,0.7)");
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, width, height);
    }

    // Pulsación con el beat
    if (this.options.reactToBeat && this.beatEnergy > 0.1) {
      ctx.fillStyle = `rgba(255, 255, 255, ${this.beatEnergy * 0.05})`;
      ctx.fillRect(0, 0, width, height);
    }
  }

  _resolveMode() {
    if (this.options.mode !== PLAYER_BG_MODE.AUTO) return this.options.mode;
    // Auto: elegir según si tenemos spectrum o artwork
    if (this.spectrum && this.playing) return PLAYER_BG_MODE.SPECTRUM_BARS;
    if (this.albumColors.length > 2) return PLAYER_BG_MODE.ALBUM_COLORS;
    return PLAYER_BG_MODE.WAVE;
  }

  // -------------------------------------------------------------- modos
  _renderBlobs() {
    const { ctx } = this;
    ctx.globalCompositeOperation = "screen";
    for (const blob of this.blobs) {
      const radius = blob.radius * (1 + Math.sin(blob.phase) * 0.15);
      const g = ctx.createRadialGradient(
        blob.x,
        blob.y,
        0,
        blob.x,
        blob.y,
        radius
      );
      g.addColorStop(0, blob.color);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(blob.x, blob.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  _renderSpectrumBars() {
    const { ctx } = this;
    if (!this.spectrum) return;
    const bars = 96;
    const barW = this.width / bars;
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < bars; i++) {
      const v = this.spectrum[Math.floor((i / bars) * this.spectrum.length)] / 255;
      const h = v * this.height;
      const color = this.albumColors[i % this.albumColors.length];
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.4 + v * 0.4;
      ctx.fillRect(i * barW, this.height - h, barW - 1, h);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  _renderWaves() {
    const { ctx } = this;
    ctx.globalCompositeOperation = "lighter";
    for (const wave of this.waves) {
      ctx.beginPath();
      ctx.strokeStyle = wave.color;
      ctx.globalAlpha = wave.alpha;
      ctx.lineWidth = 2;
      for (let x = 0; x <= this.width; x += 4) {
        const y =
          this.height / 2 +
          Math.sin(x * wave.frequency + wave.phase) * wave.amplitude +
          Math.sin(x * wave.frequency * 2.5 + wave.phase * 1.7) * (wave.amplitude * 0.3);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  _renderParticles() {
    const { ctx } = this;
    ctx.globalCompositeOperation = "lighter";
    for (const p of this.particles) {
      const lifeRatio = p.life / p.maxLife;
      const alpha = p.alpha * (1 - lifeRatio);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  _renderBlur() {
    // El blur se aplica con CSS backdrop-filter si está disponible.
    // Aquí solo añadimos un tinte de color encima.
    const { ctx } = this;
    ctx.fillStyle = this.albumColors[0] || "#000";
    ctx.globalAlpha = 0.6;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.globalAlpha = 1;
    this._renderBlobs();
  }

  _renderOrb() {
    const { ctx } = this;
    const cx = this.width / 2;
    const cy = this.height / 2;
    const baseR = Math.min(this.width, this.height) * 0.25;

    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 4; i++) {
      const color = this.albumColors[i % this.albumColors.length];
      const phase = this.time * (0.5 + i * 0.3);
      const r = baseR * (1 + Math.sin(phase) * 0.15 + i * 0.4);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, color);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.globalAlpha = 0.4 - i * 0.08;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  _renderAnimatedGradient() {
    const { ctx } = this;
    const angle = this.time * 0.2;
    const x1 = this.width / 2 + Math.cos(angle) * this.width / 2;
    const y1 = this.height / 2 + Math.sin(angle) * this.height / 2;
    const x2 = this.width / 2 - Math.cos(angle) * this.width / 2;
    const y2 = this.height / 2 - Math.sin(angle) * this.height / 2;

    const grad = ctx.createLinearGradient(x1, y1, x2, y2);
    grad.addColorStop(0, this.albumColors[0]);
    grad.addColorStop(0.5, this.albumColors[1] || this.albumColors[0]);
    grad.addColorStop(1, this.albumColors[2] || this.albumColors[0]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.width, this.height);
  }
}

// ============================================================================
// PROVIDER + HOOK (opcional)
// ============================================================================

export function createPlayerBackground(canvas, options) {
  const bg = new PlayerBackground(canvas, options);
  bg.start();
  return bg;
}

export default {
  PlayerBackground,
  createPlayerBackground,
  extractAlbumColors,
  PLAYER_BG_MODE,
  PLAYER_BG_DEFAULTS,
};
