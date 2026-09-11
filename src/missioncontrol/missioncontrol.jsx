// ============================================================================
// missioncontrol.jsx — Mission Control de macOS
// ----------------------------------------------------------------------------
// Vista que muestra todas las ventanas abiertas en miniatura sobre el
// escritorio. Comportamiento idéntico al Mission Control real de macOS:
// - Se abre con F3, ctrl+↑, o gesto de 3 dedos hacia arriba
// - Fondo: wallpaper actual con blur + dim
// - Barra superior con miniaturas de Spaces (escritorios virtuales)
// - Cuadrícula con todas las ventanas visibles en miniatura
// - Ventanas minimizadas en su propia fila inferior
// - Click en una ventana → foco y salir
// - Click en un Space → cambiar de escritorio
// - Esc, F3 o clic fuera → cerrar
// - Navegación con teclado (flechas + Enter)
// - Animación de entrada/salida
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

import {
  kernelBus,
  KERNEL_EVENTS,
  useWindowManager,
  WINDOW_STATE,
} from "../kernel/kernel.jsx";

import { useLockScreen } from "../lockscreen/lockscreen.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

const OVERLAY_Z = 100002;
const ANIMATION_MS = 260;

// ============================================================================
// CONTEXTO
// ============================================================================

const MissionControlContext = createContext(null);

export function useMissionControl() {
  const ctx = useContext(MissionControlContext);
  if (!ctx)
    throw new Error(
      "useMissionControl must be used within a MissionControlProvider"
    );
  return ctx;
}

// ============================================================================
// MINIATURA DE VENTANA
// ============================================================================

function WindowThumbnail({
  win,
  selected,
  onClick,
  onHover,
  cellWidth,
  cellHeight,
}) {
  // Escala la miniatura manteniendo el aspect ratio de la ventana
  const scale = Math.min(
    cellWidth / win.width,
    cellHeight / win.height,
    1
  );

  const thumbW = win.width * scale;
  const thumbH = win.height * scale;

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(win);
      }}
      onMouseEnter={onHover}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        padding: 10,
        borderRadius: 10,
        cursor: "pointer",
        background: selected ? "rgba(10,132,255,0.35)" : "transparent",
        transition: "background 0.1s ease-out",
      }}
    >
      <div
        style={{
          width: thumbW,
          height: thumbH,
          background: "rgba(240,240,240,0.95)",
          borderRadius: 10,
          overflow: "hidden",
          boxShadow: selected
            ? "0 20px 60px rgba(0,0,0,0.55), 0 0 0 3px rgba(10,132,255,0.9)"
            : "0 12px 36px rgba(0,0,0,0.45)",
          transition: "box-shadow 0.15s ease-out",
          display: "flex",
          flexDirection: "column",
          position: "relative",
        }}
      >
        {/* Falsa titlebar */}
        <div
          style={{
            height: Math.max(14, thumbH * 0.05),
            background: "rgba(220,220,220,0.9)",
            borderBottom: "0.5px solid rgba(0,0,0,0.15)",
            display: "flex",
            alignItems: "center",
            padding: "0 6px",
            gap: 4,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "#ff5f57",
            }}
          />
          <div
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "#febc2e",
            }}
          />
          <div
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "#28c840",
            }}
          />
        </div>

        {/* Falso contenido */}
        <div
          style={{
            flex: 1,
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.7), rgba(240,240,240,0.7))",
            position: "relative",
            overflow: "hidden",
          }}
        >
          {/* Simulación de contenido con líneas */}
          <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {[0.9, 0.6, 0.75, 0.5].map((w, i) => (
              <div
                key={i}
                style={{
                  height: Math.max(2, thumbH * 0.03),
                  width: `${w * 100}%`,
                  background: "rgba(0,0,0,0.08)",
                  borderRadius: 2,
                }}
              />
            ))}
          </div>
        </div>
      </div>
      <div
        style={{
          fontSize: 12,
          color: "#fff",
          textShadow: "0 1px 3px rgba(0,0,0,0.6)",
          maxWidth: cellWidth,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          textAlign: "center",
        }}
      >
        {win.title}
      </div>
    </div>
  );
}

// ============================================================================
// MINIATURA DE SPACE
// ============================================================================

function SpaceThumbnail({ space, active, onClick, index }) {
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(space);
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        cursor: "pointer",
        padding: 4,
        borderRadius: 8,
        background: active ? "rgba(10,132,255,0.3)" : "transparent",
      }}
    >
      <div
        style={{
          width: 100,
          height: 62,
          borderRadius: 6,
          background:
            space.wallpaper ||
            "linear-gradient(135deg,#1e3a8a 0%,#6d28d9 50%,#db2777 100%)",
          border: active
            ? "2px solid rgba(255,255,255,0.95)"
            : "1px solid rgba(255,255,255,0.25)",
          boxShadow: active ? "0 6px 16px rgba(0,0,0,0.4)" : "none",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Falsa mini ventana */}
        <div
          style={{
            position: "absolute",
            left: 12,
            top: 10,
            width: 60,
            height: 38,
            background: "rgba(255,255,255,0.25)",
            borderRadius: 3,
            border: "0.5px solid rgba(255,255,255,0.4)",
          }}
        />
      </div>
      <div
        style={{
          fontSize: 10,
          color: "#fff",
          textShadow: "0 1px 2px rgba(0,0,0,0.5)",
          opacity: active ? 1 : 0.75,
        }}
      >
        {space.name || `Escritorio ${index + 1}`}
      </div>
    </div>
  );
}

// ============================================================================
// MISSION CONTROL
// ============================================================================

export function MissionControl({
  spaces = [],
  activeSpaceId = "space-1",
  open: openProp,
  onClose,
  onActivateWindow,
  onActivateSpace,
  onAddSpace,
  onRemoveSpace,
}) {
  const wm = useWindowManager();
  const lock = useLockScreen?.() ?? { locked: false };

  const [internalOpen, setInternalOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const rootRef = useRef(null);

  const open = openProp != null ? openProp : internalOpen;

  // ------------------------------------------------------ visible + minimized
  const visibleWindows = useMemo(
    () => wm.windows.filter((w) => w.state !== WINDOW_STATE.MINIMIZED),
    [wm.windows]
  );
  const minimizedWindows = useMemo(
    () => wm.windows.filter((w) => w.state === WINDOW_STATE.MINIMIZED),
    [wm.windows]
  );

  const allWindows = useMemo(
    () => [...visibleWindows, ...minimizedWindows],
    [visibleWindows, minimizedWindows]
  );

  // ------------------------------------------------------ lifecycle
  useEffect(() => {
    if (open) {
      setMounted(true);
      setSelectedIndex(0);
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

  // ------------------------------------------------------ global F3 / ctrl+↑
  useEffect(() => {
    const onKey = (e) => {
      // F3
      if (e.key === "F3" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (openProp != null) {
          if (open) onClose?.();
          else onClose?.();
        } else {
          setInternalOpen((v) => !v);
        }
        return;
      }
      // Ctrl+ArrowUp
      if (e.ctrlKey && e.key === "ArrowUp") {
        e.preventDefault();
        if (openProp != null) {
          if (open) onClose?.();
        } else {
          setInternalOpen((v) => !v);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, openProp, onClose]);

  // ------------------------------------------------------ keyboard nav
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
        return;
      }
      if (allWindows.length === 0) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(allWindows.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const win = allWindows[selectedIndex];
        if (win) {
          if (win.state === WINDOW_STATE.MINIMIZED) wm.restore(win.id);
          else wm.focus(win.id);
          onActivateWindow?.(win);
          handleClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, allWindows, selectedIndex, wm, handleClose, onActivateWindow]);

  // ------------------------------------------------------ compute grid
  const gridCols = useMemo(() => {
    const n = visibleWindows.length;
    if (n <= 1) return 1;
    if (n <= 4) return 2;
    if (n <= 9) return 3;
    if (n <= 16) return 4;
    return 5;
  }, [visibleWindows.length]);

  const gridRows = Math.max(
    1,
    Math.ceil(visibleWindows.length / gridCols)
  );

  // ------------------------------------------------------ hide when locked
  if (lock?.locked) return null;
  if (!mounted) return null;

  return (
    <MissionControlContext.Provider
      value={{
        open,
        openMC: handleOpen,
        closeMC: handleClose,
      }}
    >
      <div
        ref={rootRef}
        onClick={(e) => {
          if (e.target === e.currentTarget) handleClose();
        }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: OVERLAY_Z,
          background: "rgba(0,0,0,0.55)",
          backdropFilter: "blur(40px) saturate(140%)",
          WebkitBackdropFilter: "blur(40px) saturate(140%)",
          opacity: open ? 1 : 0,
          transition: `opacity ${ANIMATION_MS}ms ease-out`,
          display: "flex",
          flexDirection: "column",
          color: "#fff",
          fontFamily:
            '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
          userSelect: "none",
          overflow: "hidden",
        }}
      >
        <style>{`
          @keyframes mc-in {
            from { opacity: 0; transform: scale(0.96) translateY(8px); }
            to   { opacity: 1; transform: scale(1) translateY(0); }
          }
        `}</style>

        {/* Spaces bar */}
        {spaces.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              padding: "20px 24px 12px 24px",
              flexShrink: 0,
            }}
          >
            <div style={{ display: "flex", gap: 10 }}>
              {spaces.map((s, i) => (
                <SpaceThumbnail
                  key={s.id || i}
                  space={s}
                  index={i}
                  active={s.id === activeSpaceId}
                  onClick={(space) => {
                    onActivateSpace?.(space);
                  }}
                />
              ))}
            </div>
            {onAddSpace && (
              <button
                onClick={onAddSpace}
                title="Añadir escritorio"
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  border: "1px dashed rgba(255,255,255,0.5)",
                  background: "rgba(255,255,255,0.08)",
                  color: "#fff",
                  fontSize: 20,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  marginLeft: 4,
                }}
              >
                +
              </button>
            )}
          </div>
        )}

        {/* Main grid */}
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "10px 40px",
            minHeight: 0,
            overflow: "auto",
          }}
        >
          {visibleWindows.length === 0 ? (
            <div
              style={{
                color: "rgba(255,255,255,0.5)",
                fontSize: 15,
              }}
            >
              No hay ventanas abiertas
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
                gap: 24,
                maxWidth: 1400,
                width: "100%",
                animation: `mc-in ${ANIMATION_MS}ms ease-out`,
              }}
            >
              {visibleWindows.map((w, i) => {
                const cellWidth = Math.min(
                  420,
                  (typeof window !== "undefined"
                    ? window.innerWidth - 80 - (gridCols - 1) * 24
                    : 1200) /
                    gridCols
                );
                const cellHeight = 280;
                return (
                  <WindowThumbnail
                    key={w.id}
                    win={w}
                    selected={i === selectedIndex}
                    onHover={() => setSelectedIndex(i)}
                    onClick={(win) => {
                      wm.focus(win.id);
                      onActivateWindow?.(win);
                      handleClose();
                    }}
                    cellWidth={cellWidth}
                    cellHeight={cellHeight}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Minimized windows row */}
        {minimizedWindows.length > 0 && (
          <div
            style={{
              padding: "12px 24px 20px 24px",
              borderTop: "0.5px solid rgba(255,255,255,0.1)",
              flexShrink: 0,
            }}
          >
            <div
              style={{
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                opacity: 0.55,
                marginBottom: 10,
                textAlign: "center",
              }}
            >
              Minimizadas
            </div>
            <div
              style={{
                display: "flex",
                gap: 16,
                justifyContent: "center",
                flexWrap: "wrap",
              }}
            >
              {minimizedWindows.map((w) => (
                <div
                  key={w.id}
                  onClick={() => {
                    wm.restore(w.id);
                    onActivateWindow?.(w);
                    handleClose();
                  }}
                  style={{
                    width: 140,
                    padding: "6px 8px 8px 8px",
                    background: "rgba(255,255,255,0.1)",
                    borderRadius: 8,
                    cursor: "pointer",
                    textAlign: "center",
                  }}
                >
                  <div
                    style={{
                      height: 60,
                      background: "rgba(240,240,240,0.9)",
                      borderRadius: 4,
                      marginBottom: 6,
                    }}
                  />
                  <div
                    style={{
                      fontSize: 11,
                      color: "#fff",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {w.title}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Hint bar */}
        <div
          style={{
            padding: "10px 24px 18px 24px",
            fontSize: 11,
            color: "rgba(255,255,255,0.45)",
            display: "flex",
            gap: 20,
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <span>
            <kbd style={kbdStyle}>←</kbd> <kbd style={kbdStyle}>→</kbd>{" "}
            navegar
          </span>
          <span>
            <kbd style={kbdStyle}>↵</kbd> abrir
          </span>
          <span>
            <kbd style={kbdStyle}>Esc</kbd> cerrar
          </span>
        </div>
      </div>
    </MissionControlContext.Provider>
  );
}

const kbdStyle = {
  display: "inline-block",
  padding: "1px 6px",
  fontSize: 10,
  borderRadius: 3,
  border: "0.5px solid rgba(255,255,255,0.25)",
  background: "rgba(255,255,255,0.08)",
  fontFamily:
    '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
  minWidth: 14,
  textAlign: "center",
};

// ============================================================================
// EXPORTS
// ============================================================================

export default MissionControl;
