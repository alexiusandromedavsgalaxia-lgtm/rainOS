// ============================================================================
// controlcenter.jsx — Centro de control de macOS
// ----------------------------------------------------------------------------
// Panel desplegable que baja desde la esquina superior derecha al pulsar el
// icono del menubar. Comportamiento idéntico al Control Center real de macOS:
// - Se abre desde el menubar (icono ⚙️)
// - Widgets: WiFi, Bluetooth, AirDrop, Modo avión
// - Widget de No molestar / Concentración
// - Sliders: brillo, volumen
// - Widget de música con controles de reproducción
// - Widget de teclado / brillo (según config)
// - Acceso a Ajustes del Sistema, Bloquear pantalla, etc.
// - Cierre con Esc, clic fuera, o segundo clic en el icono
// - Animación de apertura/cierre
// - Se oculta cuando el lockscreen está activo
// - Todo con estilos inline
// ============================================================================

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";

import { kernelBus } from "../kernel/kernel.jsx";
import { useLockScreen } from "../lockscreen/lockscreen.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

const OVERLAY_Z = 100003;
const ANIMATION_MS = 220;

// ============================================================================
// CONTEXTO
// ============================================================================

const ControlCenterContext = createContext(null);

export function useControlCenter() {
  const ctx = useContext(ControlCenterContext);
  if (!ctx)
    throw new Error(
      "useControlCenter must be used within a ControlCenterProvider"
    );
  return ctx;
}

// ============================================================================
// TOGGLE CIRCULAR (WiFi, BT, AirDrop, Modo avión)
// ============================================================================

function CircleToggle({ icon, label, active, onToggle, sublabel }) {
  return (
    <button
      onClick={onToggle}
      title={label}
      style={{
        width: 48,
        height: 48,
        borderRadius: 24,
        border: "none",
        background: active ? "rgba(10,132,255,0.95)" : "rgba(255,255,255,0.14)",
        color: "#fff",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 20,
        transition: "background 0.15s ease-out",
        padding: 0,
        position: "relative",
      }}
    >
      {icon}
      {sublabel && (
        <span
          style={{
            position: "absolute",
            bottom: -16,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 10,
            opacity: 0.75,
            whiteSpace: "nowrap",
          }}
        >
          {sublabel}
        </span>
      )}
    </button>
  );
}

// ============================================================================
// SLIDER CIRCULAR (brillo, volumen)
// ============================================================================

function RoundSlider({
  value = 0.5,
  onChange,
  icon,
  label,
  size = 88,
}) {
  const ref = useRef(null);
  const draggingRef = useRef(false);

  const computeValue = useCallback((clientX, clientY) => {
    const el = ref.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    // Ajustamos para que "arriba" sea el máximo
    let angle = Math.atan2(-dx, -dy); // -pi..pi, 0 = arriba
    if (angle < 0) angle += Math.PI * 2;
    const v = 1 - angle / (Math.PI * 2);
    return Math.max(0, Math.min(1, v));
  }, [value]);

  const onMouseDown = (e) => {
    draggingRef.current = true;
    const v = computeValue(e.clientX, e.clientY);
    onChange?.(v);

    const onMove = (ev) => {
      if (!draggingRef.current) return;
      onChange?.(computeValue(ev.clientX, ev.clientY));
    };
    const onUp = () => {
      draggingRef.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const r = size / 2 - 6;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const dash = circumference * value;

  // Convertimos el ángulo en rotación para el trazo
  // Empieza arriba y va en sentido horario
  const rotation = 0;

  return (
    <div
      ref={ref}
      onMouseDown={onMouseDown}
      title={label}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        background: "rgba(255,255,255,0.14)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "ns-resize",
        position: "relative",
        userSelect: "none",
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ position: "absolute", inset: 0 }}
      >
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.12)"
          strokeWidth={4}
        />
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="#fff"
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          transform={`rotate(${rotation} ${cx} ${cy})`}
        />
      </svg>
      <span style={{ fontSize: 24, position: "relative", zIndex: 1 }}>
        {icon}
      </span>
    </div>
  );
}

// ============================================================================
// TILE (bloque con contenido)
// ============================================================================

function Tile({ children, style, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: "rgba(255,255,255,0.1)",
        borderRadius: 14,
        border: "0.5px solid rgba(255,255,255,0.08)",
        padding: 12,
        display: "flex",
        gap: 12,
        alignItems: "center",
        color: "#fff",
        fontFamily:
          '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
        fontSize: 13,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ============================================================================
// TOGGLE PILL (etiqueta clicable con estado on/off)
// ============================================================================

function TogglePill({ icon, label, active, onToggle, subtitle }) {
  return (
    <div
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        borderRadius: 10,
        background: "rgba(255,255,255,0.06)",
        cursor: "pointer",
        flex: 1,
        minWidth: 0,
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 14,
          background: active
            ? "rgba(10,132,255,0.9)"
            : "rgba(255,255,255,0.18)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {label}
        </div>
        {subtitle && (
          <div
            style={{
              fontSize: 10,
              opacity: 0.6,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// WIDGET DE MÚSICA
// ============================================================================

function MusicWidget({
  title = "Sin reproducción",
  artist = "",
  artwork = "🎵",
  playing = false,
  onPlay,
  onPause,
  onNext,
  onPrev,
}) {
  return (
    <Tile style={{ padding: 12 }}>
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 8,
          background: "rgba(255,255,255,0.16)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 22,
          flexShrink: 0,
        }}
      >
        {artwork}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </div>
        {artist && (
          <div
            style={{
              fontSize: 10,
              opacity: 0.6,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {artist}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <button onClick={onPrev} style={iconBtnStyle}>
          ⏮
        </button>
        <button
          onClick={playing ? onPause : onPlay}
          style={{ ...iconBtnStyle, fontSize: 16 }}
        >
          {playing ? "⏸" : "▶"}
        </button>
        <button onClick={onNext} style={iconBtnStyle}>
          ⏭
        </button>
      </div>
    </Tile>
  );
}

const iconBtnStyle = {
  width: 26,
  height: 26,
  borderRadius: 13,
  border: "none",
  background: "rgba(255,255,255,0.14)",
  color: "#fff",
  fontSize: 12,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};

// ============================================================================
// CONTROL CENTER
// ============================================================================

export function ControlCenter({
  open: openProp,
  onClose,
  onOpenSettings,
  onOpenSound,
  onOpenDisplay,
  onOpenNetwork,
  onLockScreen,
}) {
  const lock = useLockScreen?.() ?? { locked: false };

  const [internalOpen, setInternalOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Estado de los toggles y sliders
  const [wifi, setWifi] = useState(true);
  const [bluetooth, setBluetooth] = useState(true);
  const [airdrop, setAirdrop] = useState(false);
  const [airplane, setAirplane] = useState(false);
  const [dnd, setDnd] = useState(false);
  const [brightness, setBrightness] = useState(0.75);
  const [volume, setVolume] = useState(0.45);

  // Música (mock)
  const [music, setMusic] = useState({
    title: "Ich Komme",
    artist: "Erika Vikman",
    artwork: "🎵",
    playing: false,
  });

  const open = openProp != null ? openProp : internalOpen;
  const panelRef = useRef(null);

  // ------------------------------------------------------ lifecycle
  useEffect(() => {
    if (open) {
      setMounted(true);
    } else {
      const t = setTimeout(() => setMounted(false), ANIMATION_MS);
      return () => clearTimeout(t);
    }
  }, [open]);

  // ------------------------------------------------------ helpers
  const handleOpen = useCallback(() => {
    if (openProp != null) return;
    setInternalOpen(true);
  }, [openProp]);

  const handleClose = useCallback(() => {
    if (openProp != null) onClose?.();
    else setInternalOpen(false);
  }, [openProp, onClose]);

  // ------------------------------------------------------ close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        handleClose();
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, handleClose]);

  // ------------------------------------------------------ handlers de toggles
  const toggleWifi = () => setWifi((v) => !v);
  const toggleBluetooth = () => setBluetooth((v) => !v);
  const toggleAirDrop = () => setAirdrop((v) => !v);
  const toggleAirplane = () => {
    setAirplane((v) => {
      const next = !v;
      if (next) {
        setWifi(false);
        setBluetooth(false);
      } else {
        setWifi(true);
        setBluetooth(true);
      }
      return next;
    });
  };
  const toggleDnd = () => setDnd((v) => !v);

  // ------------------------------------------------------ hide when locked
  if (lock?.locked) return null;
  if (!mounted) return null;

  return (
    <ControlCenterContext.Provider
      value={{
        open,
        openCC: handleOpen,
        closeCC: handleClose,
      }}
    >
      <div
        style={{
          position: "fixed",
          top: 30,
          right: 8,
          zIndex: OVERLAY_Z,
          opacity: open ? 1 : 0,
          transform: open ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.98)",
          transformOrigin: "top right",
          transition: `opacity ${ANIMATION_MS}ms ease-out, transform ${ANIMATION_MS}ms ease-out`,
          pointerEvents: open ? "auto" : "none",
        }}
      >
        <div
          ref={panelRef}
          style={{
            width: 340,
            padding: 14,
            background: "rgba(30,30,30,0.72)",
            backdropFilter: "blur(40px) saturate(180%)",
            WebkitBackdropFilter: "blur(40px) saturate(180%)",
            borderRadius: 20,
            border: "0.5px solid rgba(255,255,255,0.14)",
            boxShadow:
              "0 30px 80px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06)",
            color: "#fff",
            fontFamily:
              '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
            display: "flex",
            flexDirection: "column",
            gap: 10,
            userSelect: "none",
          }}
        >
          {/* Fila superior: conectividad */}
          <Tile style={{ padding: 14, flexDirection: "column", alignItems: "stretch", gap: 14 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                Conexiones
              </span>
              <button
                onClick={onOpenNetwork}
                style={{
                  background: "none",
                  border: "none",
                  color: "rgba(255,255,255,0.7)",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                Detalles…
              </button>
            </div>
            <div
              style={{
                display: "flex",
                gap: 14,
                justifyContent: "space-between",
                padding: "0 4px",
              }}
            >
              <CircleToggle
                icon="📶"
                label="Wi-Fi"
                active={wifi}
                onToggle={toggleWifi}
                sublabel={wifi ? "Wi-Fi" : "Off"}
              />
              <CircleToggle
                icon="🎧"
                label="Bluetooth"
                active={bluetooth}
                onToggle={toggleBluetooth}
                sublabel={bluetooth ? "Bluetooth" : "Off"}
              />
              <CircleToggle
                icon="📡"
                label="AirDrop"
                active={airdrop}
                onToggle={toggleAirDrop}
                sublabel={airdrop ? "AirDrop" : "Off"}
              />
              <CircleToggle
                icon="✈️"
                label="Modo avión"
                active={airplane}
                onToggle={toggleAirplane}
                sublabel={airplane ? "Avión" : "Off"}
              />
            </div>
          </Tile>

          {/* No molestar + Concentración */}
          <Tile style={{ padding: 12, gap: 8 }}>
            <TogglePill
              icon="🌙"
              label="No molestar"
              subtitle={dnd ? "Activado" : "Desactivado"}
              active={dnd}
              onToggle={toggleDnd}
            />
            <TogglePill
              icon="🎯"
              label="Concentración"
              subtitle="Trabajo"
              active={false}
              onToggle={() => console.log("[cc] focus mode")}
            />
          </Tile>

          {/* Brillo + Volumen */}
          <Tile
            style={{
              padding: 14,
              justifyContent: "space-around",
              alignItems: "center",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
              }}
            >
              <RoundSlider
                value={brightness}
                onChange={setBrightness}
                icon="☀️"
                label="Brillo"
              />
              <div style={{ fontSize: 10, opacity: 0.6 }}>
                Brillo {Math.round(brightness * 100)}%
              </div>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
              }}
            >
              <RoundSlider
                value={volume}
                onChange={setVolume}
                icon="🔊"
                label="Volumen"
              />
              <div style={{ fontSize: 10, opacity: 0.6 }}>
                Volumen {Math.round(volume * 100)}%
              </div>
            </div>
          </Tile>

          {/* Música */}
          <MusicWidget
            title={music.title}
            artist={music.artist}
            artwork={music.artwork}
            playing={music.playing}
            onPlay={() => setMusic((m) => ({ ...m, playing: true }))}
            onPause={() => setMusic((m) => ({ ...m, playing: false }))}
            onNext={() => console.log("[cc] next track")}
            onPrev={() => console.log("[cc] prev track")}
          />

          {/* Acciones rápidas */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
            }}
          >
            <div
              onClick={() => onOpenSettings?.()}
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                background: "rgba(255,255,255,0.1)",
                display: "flex",
                alignItems: "center",
                gap: 10,
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              <span style={{ fontSize: 16 }}>⚙️</span>
              Ajustes
            </div>
            <div
              onClick={() => onLockScreen?.()}
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                background: "rgba(255,255,255,0.1)",
                display: "flex",
                alignItems: "center",
                gap: 10,
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              <span style={{ fontSize: 16 }}>🔒</span>
              Bloquear
            </div>
            <div
              onClick={() => onOpenDisplay?.()}
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                background: "rgba(255,255,255,0.1)",
                display: "flex",
                alignItems: "center",
                gap: 10,
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              <span style={{ fontSize: 16 }}>🖥</span>
              Pantalla
            </div>
            <div
              onClick={() => onOpenSound?.()}
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                background: "rgba(255,255,255,0.1)",
                display: "flex",
                alignItems: "center",
                gap: 10,
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              <span style={{ fontSize: 16 }}>🔊</span>
              Sonido
            </div>
          </div>
        </div>
      </div>
    </ControlCenterContext.Provider>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export default ControlCenter;
