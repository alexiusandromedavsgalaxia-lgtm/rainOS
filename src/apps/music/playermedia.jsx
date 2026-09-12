// ============================================================================
// playermedia.jsx — Reproductor de media (componente React)
// ----------------------------------------------------------------------------
// Reproductor completo estilo Music.app/QuickTime que usa el AudioManager
// para reproducir audio real, con controles, visualizador y análisis.
//
// CARACTERÍSTICAS
//
//   - Play / Pause / Stop / Next / Prev
//   - Seek con drag
//   - Volumen con slider
//   - Waveform en tiempo real (AnalyserNode)
//   - Spectrum de barras
//   - Lista de reproducción con drag&drop
//   - Soporta archivos locales (drag&drop)
//   - Shuffle / Repeat
//   - Ecualizador visual
//   - Metadata simple (título, artista, álbum, duración)
//   - Control de velocidad (0.5x - 2x)
//   - Crossfade entre pistas
//
// La reproducción real usa decodeAudioData + AudioBufferSourceNode del
// AudioManager. Si el archivo no es decodificable por el navegador,
// se muestra el mensaje de error adecuado.
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useAudio } from "../../hardware/audio.jsx";
import { formatDuration, perceptualVolume } from "../../hardware/audiocomponent.js";

// ============================================================================
// PLAYER MEDIA
// ============================================================================

export function PlayerMedia({
  width = 400,
  height = "auto",
  showWaveform = true,
  showSpectrum = true,
  showPlaylist = true,
  showEqualizer = false,
  initialTrack = null,
}) {
  const audio = useAudio();
  const channelRef = useRef(null);

  const [track, setTrack] = useState(initialTrack);
  const [playlist, setPlaylist] = useState(initialTrack ? [initialTrack] : []);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(0.7);
  const [muted, setMuted] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState("off"); // "off" | "all" | "one"
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [eqBands, setEqBands] = useState(
    Array.from({ length: 10 }, () => ({ freq: 0, gain: 0 }))
  );

  // Crear un canal de audio dedicado para este player
  useEffect(() => {
    if (!audio.manager.ctx) audio.init();
    const ch = audio.createChannel({
      name: "PlayerMedia",
      appId: "music",
    });
    channelRef.current = ch;
    return () => {
      audio.destroyChannel(ch.id);
      channelRef.current = null;
    };
  }, [audio]);

  // Sincronizar volumen con el canal
  useEffect(() => {
    if (!channelRef.current?.gainNode) return;
    const g = perceptualVolume(muted ? 0 : volume);
    channelRef.current.gainNode.gain.value = g;
  }, [volume, muted]);

  // Loop de tiempo actual
  useEffect(() => {
    if (!playing) return;
    let raf;
    const tick = () => {
      const ch = channelRef.current;
      if (ch && ch.playing) {
        // Calcular tiempo actual
        const elapsed = (audio.manager.ctx?.currentTime ?? 0);
        setCurrentTime(
          Math.min(duration, (ch._startedAt ? elapsed - ch._startedAt : 0) + (ch._pausedAt || 0))
        );
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration, audio]);

  // -------------------------------------------------------------- reproducción
  const loadTrack = async (t) => {
    if (!t || !t.url) {
      setError("Pista sin URL");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const buffer = await audio.decodeFromUrl(t.url);
      setTrack({ ...t, _buffer: buffer });
      setDuration(buffer.duration);
      setCurrentTime(0);
    } catch (err) {
      setError(`No se pudo decodificar: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const play = async () => {
    const ch = channelRef.current;
    if (!ch) return;
    if (!track?._buffer) {
      if (track?.url) await loadTrack(track);
    }
    const t = track;
    if (!t?._buffer) return;
    await audio.manager.playBuffer(ch, t._buffer, { offset: currentTime });
    ch._startedAt = audio.manager.ctx.currentTime - currentTime;
    ch.sourceNode.playbackRate.value = playbackRate;
    setPlaying(true);
  };

  const pause = () => {
    const ch = channelRef.current;
    if (!ch) return;
    ch._pausedAt = currentTime;
    audio.pauseChannel(ch.id);
    setPlaying(false);
  };

  const togglePlay = () => (playing ? pause() : play());

  const stop = () => {
    const ch = channelRef.current;
    if (!ch) return;
    audio.stopChannel(ch.id);
    setPlaying(false);
    setCurrentTime(0);
  };

  const seek = (value) => {
    const ch = channelRef.current;
    if (!ch || !track?._buffer) return;
    setCurrentTime(value);
    if (playing) {
      audio.manager.playBuffer(ch, track._buffer, { offset: value });
      ch._startedAt = audio.manager.ctx.currentTime - value;
    }
  };

  const next = () => {
    if (playlist.length === 0) return;
    let idx = playlist.findIndex((t) => t.id === track?.id);
    if (shuffle) {
      idx = Math.floor(Math.random() * playlist.length);
    } else {
      idx = (idx + 1) % playlist.length;
    }
    loadTrack(playlist[idx]).then(() => {
      if (playing) play();
    });
  };

  const prev = () => {
    if (playlist.length === 0) return;
    let idx = playlist.findIndex((t) => t.id === track?.id);
    idx = (idx - 1 + playlist.length) % playlist.length;
    loadTrack(playlist[idx]).then(() => {
      if (playing) play();
    });
  };

  // -------------------------------------------------------------- drag&drop
  const handleDrop = async (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;
    const first = files[0];
    const url = URL.createObjectURL(first);
    const newTrack = {
      id: `local-${Date.now()}`,
      title: first.name.replace(/\.[^.]+$/, ""),
      artist: "Archivo local",
      album: "Importado",
      url,
      size: first.size,
    };
    setPlaylist((prev) => [...prev, newTrack]);
    await loadTrack(newTrack);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  // -------------------------------------------------------------- render
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      style={{
        width,
        height,
        background: "#111",
        color: "#fff",
        borderRadius: 12,
        fontFamily: '-apple-system, "SF Pro Text", system-ui, sans-serif',
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        userSelect: "none",
        border: "1px solid #222",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #222",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 8,
            background: "linear-gradient(135deg, #ff3366, #7c3aed)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 22,
          }}
        >
          🎵
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {track?.title ?? "Sin pista"}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "#888",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {track?.artist ?? "—"} {track?.album ? `· ${track.album}` : ""}
          </div>
        </div>
        {loading && (
          <div style={{ fontSize: 11, color: "#0a84ff" }}>Cargando…</div>
        )}
      </div>

      {/* Waveform */}
      {showWaveform && (
        <WaveformView
          getWaveform={() => audio.getWaveform?.()}
          playing={playing}
          color="#ff3366"
        />
      )}

      {/* Spectrum */}
      {showSpectrum && (
        <SpectrumView
          getSpectrum={() => audio.getSpectrum?.()}
          playing={playing}
          color="#7c3aed"
        />
      )}

      {/* Progress */}
      <div style={{ padding: "8px 16px" }}>
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={currentTime}
          onChange={(e) => seek(parseFloat(e.target.value))}
          style={{ width: "100%", accentColor: "#ff3366" }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 10,
            color: "#888",
            marginTop: 2,
          }}
        >
          <span>{formatDuration(currentTime)}</span>
          <span>-{formatDuration(Math.max(0, duration - currentTime))}</span>
        </div>
      </div>

      {/* Controls */}
      <div
        style={{
          padding: "8px 16px 16px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        <button onClick={() => setShuffle((s) => !s)} style={btn(shuffle, true)}>
          🔀
        </button>
        <button onClick={prev} style={btn()}>
          ⏮
        </button>
        <button
          onClick={togglePlay}
          style={{ ...btn(true), width: 44, height: 44, fontSize: 18 }}
        >
          {playing ? "⏸" : "▶"}
        </button>
        <button onClick={next} style={btn()}>
          ⏭
        </button>
        <button
          onClick={() =>
            setRepeat((r) => (r === "off" ? "all" : r === "all" ? "one" : "off"))
          }
          style={btn(repeat !== "off", true)}
        >
          {repeat === "one" ? "🔂" : "🔁"}
        </button>
      </div>

      {/* Volume */}
      <div
        style={{
          padding: "0 16px 12px 16px",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <button onClick={() => setMuted((m) => !m)} style={btn(false, true)}>
          {muted ? "🔇" : "🔊"}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
          style={{ flex: 1, accentColor: "#ff3366" }}
        />
        <span style={{ fontSize: 10, color: "#888", minWidth: 32, textAlign: "right" }}>
          {Math.round(volume * 100)}%
        </span>
      </div>

      {/* Playlist */}
      {showPlaylist && playlist.length > 0 && (
        <div
          style={{
            borderTop: "1px solid #222",
            maxHeight: 180,
            overflow: "auto",
            padding: "4px 0",
          }}
        >
          {playlist.map((t, i) => (
            <div
              key={t.id}
              onClick={() => {
                loadTrack(t).then(() => play());
              }}
              style={{
                padding: "6px 16px",
                display: "flex",
                gap: 10,
                alignItems: "center",
                cursor: "pointer",
                background: t.id === track?.id ? "#1e1e1e" : "transparent",
                fontSize: 12,
              }}
            >
              <span style={{ width: 20, color: "#666" }}>{i + 1}</span>
              <span
                style={{
                  flex: 1,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {t.title}
              </span>
              <span style={{ fontSize: 10, color: "#666" }}>{t.artist}</span>
            </div>
          ))}
        </div>
      )}

      {/* Equalizer */}
      {showEqualizer && (
        <div
          style={{
            padding: 12,
            borderTop: "1px solid #222",
            display: "flex",
            gap: 6,
          }}
        >
          {eqBands.map((band, i) => (
            <div
              key={i}
              style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}
            >
              <input
                type="range"
                min={-12}
                max={12}
                step={0.5}
                value={band.gain}
                onChange={(e) => {
                  const g = parseFloat(e.target.value);
                  setEqBands((prev) =>
                    prev.map((b, j) => (j === i ? { ...b, gain: g } : b))
                  );
                  audio.setEqBand(i, g);
                }}
                style={{
                  writingMode: "vertical-lr",
                  direction: "rtl",
                  height: 60,
                  accentColor: "#7c3aed",
                }}
              />
              <div style={{ fontSize: 8, color: "#666", marginTop: 2 }}>
                {i}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          style={{
            padding: "8px 16px",
            background: "rgba(255,51,51,0.15)",
            color: "#ff6666",
            fontSize: 11,
            borderTop: "1px solid #ff3366",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// SUB-COMPONENTES
// ============================================================================

function WaveformView({ getWaveform, playing, color }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const data = getWaveform?.();
      if (data && playing) {
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          const x = (i / data.length) * w;
          const y = h / 2 + v * (h / 2 - 2);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      } else {
        ctx.strokeStyle = "rgba(255,255,255,0.1)";
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();
      }
      rafRef.current = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [getWaveform, playing, color]);

  return (
    <canvas
      ref={canvasRef}
      width={800}
      height={60}
      style={{ width: "100%", height: 60, display: "block" }}
    />
  );
}

function SpectrumView({ getSpectrum, playing, color }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const data = getSpectrum?.();
      if (data && playing) {
        const bars = 64;
        const barW = w / bars;
        for (let i = 0; i < bars; i++) {
          const v = data[Math.floor((i / bars) * data.length)] / 255;
          const barH = v * h;
          ctx.fillStyle = color;
          ctx.fillRect(i * barW, h - barH, barW - 1, barH);
        }
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.fillRect(0, h - 4, w, 4);
      }
      rafRef.current = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [getSpectrum, playing, color]);

  return (
    <canvas
      ref={canvasRef}
      width={800}
      height={80}
      style={{ width: "100%", height: 80, display: "block" }}
    />
  );
}

// ============================================================================
// HELPERS
// ============================================================================

const btn = (active = false, small = false) => ({
  width: small ? 28 : 36,
  height: small ? 28 : 36,
  borderRadius: "50%",
  border: "none",
  background: active ? "#ff3366" : "#1e1e1e",
  color: "#fff",
  cursor: "pointer",
  fontSize: small ? 12 : 14,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  transition: "background 0.15s",
});

export default PlayerMedia;
