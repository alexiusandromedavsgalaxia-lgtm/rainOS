// ============================================================================
// appswitcher.jsx — App Switcher de macOS (⌘Tab)
// ----------------------------------------------------------------------------
// Fila horizontal de iconos de apps abiertas que aparece al pulsar ⌘Tab.
// Comportamiento idéntico al App Switcher real de macOS:
// - Se abre con ⌘Tab (o Alt+Tab en Windows/Linux)
// - Fila centrada con iconos de apps abiertas
// - La app seleccionada está resaltada
// - Se mantiene abierto mientras ⌘ está pulsado
// - Tab avanza, Shift+Tab retrocede
// - Al soltar ⌘ se activa la app seleccionada
// - Esc cancela (vuelve a la app original)
// - Click con el ratón sobre un icono → activa esa app
// - Muestra el nombre de la app seleccionada encima
// - Orden: apps en el focus stack del kernel, más reciente primero
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

import { useWindowManager } from "../kernel/kernel.jsx";
import { useLockScreen } from "../lockscreen/lockscreen.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

const OVERLAY_Z = 100004;
const ANIMATION_MS = 140;
const ICON_SIZE = 72;

// ============================================================================
// CONTEXTO
// ============================================================================

const AppSwitcherContext = createContext(null);

export function useAppSwitcher() {
  const ctx = useContext(AppSwitcherContext);
  if (!ctx)
    throw new Error(
      "useAppSwitcher must be used within an AppSwitcherProvider"
    );
  return ctx;
}

// ============================================================================
// ICONO EN LA FILA
// ============================================================================

function SwitcherIcon({ app, selected, onClick, onHover }) {
  return (
    <div
      onClick={onClick}
      onMouseEnter={onHover}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        cursor: "pointer",
        userSelect: "none",
        transition: "transform 0.1s ease-out",
        transform: selected ? "scale(1.08)" : "scale(1)",
      }}
    >
      <div
        style={{
          width: ICON_SIZE,
          height: ICON_SIZE,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: ICON_SIZE * 0.6,
          borderRadius: ICON_SIZE * 0.22,
          overflow: "hidden",
          background: selected
            ? "rgba(255,255,255,0.22)"
            : "rgba(255,255,255,0.08)",
          boxShadow: selected
            ? "0 12px 30px rgba(0,0,0,0.5), 0 0 0 2px rgba(255,255,255,0.9)"
            : "0 4px 12px rgba(0,0,0,0.35)",
          transition: "background 0.1s ease-out, box-shadow 0.1s ease-out",
        }}
      >
        {app.renderIcon ? app.renderIcon({ size: ICON_SIZE }) : app.emoji || "📦"}
      </div>

      {/* Indicador de múltiples ventanas */}
      {app.windowCount > 1 && (
        <div
          style={{
            position: "absolute",
            right: -2,
            top: -2,
            minWidth: 18,
            height: 18,
            padding: "0 5px",
            borderRadius: 9,
            background: "rgba(0,0,0,0.7)",
            color: "#fff",
            fontSize: 10,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid rgba(255,255,255,0.35)",
          }}
        >
          {app.windowCount}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// APP SWITCHER
// ============================================================================

export function AppSwitcher({
  apps: appsProp = [],
  open: openProp,
  onClose,
  onSwitch,
}) {
  const wm = useWindowManager();
  const lock = useLockScreen?.() ?? { locked: false };

  const [internalOpen, setInternalOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [originalAppId, setOriginalAppId] = useState(null);

  const metaKeyRef = useRef(false);

  const open = openProp != null ? openProp : internalOpen;

  // ------------------------------------------------------ list of running apps
  // Agrupamos las ventanas del kernel por appId.
  // El orden viene del focus stack: ventanas más recientes primero.
  const runningApps = useMemo(() => {
    const byApp = new Map();

    // Recorremos las ventanas en orden inverso al array (que es el orden en que se abrieron)
    const sorted = [...wm.windows].sort(
      (a, b) => (b.lastFocusedAt || 0) - (a.lastFocusedAt || 0)
    );

    for (const w of sorted) {
      if (!byApp.has(w.appId)) {
        byApp.set(w.appId, {
          id: w.appId,
          name: w.appId,
          emoji: "📦",
          renderIcon: null,
          windows: [],
          windowCount: 0,
        });
      }
      const entry = byApp.get(w.appId);
      entry.windows.push(w);
      entry.windowCount = entry.windows.length;
    }

    // Enriquecer con la metadata de apps si está disponible
    for (const [appId, entry] of byApp.entries()) {
      const def = appsProp.find((a) => a.id === appId);
      if (def) {
        entry.name = def.name;
        entry.emoji = def.emoji;
        entry.renderIcon = def.renderIcon;
      }
    }

    return Array.from(byApp.values());
  }, [wm.windows, appsProp]);

  // ------------------------------------------------------ lifecycle
  useEffect(() => {
    if (open) {
      setMounted(true);
      setSelectedIndex(0);
      const active = wm.getActive();
      setOriginalAppId(active?.appId || null);
    } else {
      const t = setTimeout(() => setMounted(false), ANIMATION_MS);
      return () => clearTimeout(t);
    }
  }, [open]);

  // ------------------------------------------------------ global ⌘Tab
  useEffect(() => {
    const onKeyDown = (e) => {
      const isSwitch =
        (e.metaKey || e.altKey) &&
        (e.key === "Tab" || e.key === "Dead");

      if (isSwitch) {
        e.preventDefault();
        if (!openProp && !internalOpen) {
          setInternalOpen(true);
          setSelectedIndex(0);
        } else {
          setSelectedIndex((i) => {
            if (runningApps.length === 0) return 0;
            if (e.shiftKey) {
              return (i - 1 + runningApps.length) % runningApps.length;
            }
            return (i + 1) % runningApps.length;
          });
        }
        return;
      }

      if (e.key === "Escape" && open) {
        e.preventDefault();
        cancel();
        return;
      }

      // Meta soltada: sobreescribimos con el keyup handler
      if (e.key === "Meta" || e.key === "Alt") {
        metaKeyRef.current = true;
      }
    };

    const onKeyUp = (e) => {
      if (
        (e.key === "Meta" || e.key === "Alt") &&
        (openProp != null ? openProp : internalOpen)
      ) {
        // Se ha soltado el modificador: confirmamos selección
        confirmSelection();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [open, openProp, internalOpen, runningApps.length, wm]);

  // ------------------------------------------------------ close when locked
  useEffect(() => {
    if (lock?.locked && internalOpen) {
      setInternalOpen(false);
    }
  }, [lock?.locked, internalOpen]);

  // ------------------------------------------------------ helpers
  const handleOpen = useCallback(() => {
    if (openProp != null) return;
    setInternalOpen(true);
  }, [openProp]);

  const handleClose = useCallback(() => {
    if (openProp != null) onClose?.();
    else setInternalOpen(false);
  }, [openProp, onClose]);

  const confirmSelection = useCallback(() => {
    const app = runningApps[selectedIndex];
    if (app) {
      // Enfocamos la ventana más reciente de esa app
      const target = app.windows[0];
      if (target) {
        if (target.state === "minimized") wm.restore(target.id);
        else wm.focus(target.id);
      }
      onSwitch?.(app);
    }
    handleClose();
  }, [runningApps, selectedIndex, wm, onSwitch, handleClose]);

  const cancel = useCallback(() => {
    // Volvemos a la app original
    if (originalAppId) {
      const original = runningApps.find((a) => a.id === originalAppId);
      if (original && original.windows[0]) {
        wm.focus(original.windows[0].id);
      }
    }
    handleClose();
  }, [originalAppId, runningApps, wm, handleClose]);

  // ------------------------------------------------------ hide conditions
  if (lock?.locked) return null;
  if (!mounted) return null;
  if (runningApps.length === 0) return null;

  const selectedApp = runningApps[selectedIndex];

  return (
    <AppSwitcherContext.Provider
      value={{
        open,
        openSwitcher: handleOpen,
        closeSwitcher: handleClose,
      }}
    >
      <div
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) cancel();
        }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: OVERLAY_Z,
          background: "rgba(0,0,0,0.25)",
          backdropFilter: "blur(20px) saturate(140%)",
          WebkitBackdropFilter: "blur(20px) saturate(140%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: open ? 1 : 0,
          transition: `opacity ${ANIMATION_MS}ms ease-out`,
          userSelect: "none",
          fontFamily:
            '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
        }}
      >
        <style>{`
          @keyframes appswitcher-pop {
            from { opacity: 0; transform: scale(0.94); }
            to   { opacity: 1; transform: scale(1); }
          }
        `}</style>

        {/* Contenedor vertical */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 18,
            animation: `appswitcher-pop ${ANIMATION_MS}ms ease-out`,
          }}
        >
          {/* Nombre de la app seleccionada */}
          {selectedApp && (
            <div
              style={{
                padding: "6px 16px",
                borderRadius: 10,
                background: "rgba(30,30,30,0.75)",
                backdropFilter: "blur(20px)",
                WebkitBackdropFilter: "blur(20px)",
                color: "#fff",
                fontSize: 16,
                fontWeight: 500,
                border: "0.5px solid rgba(255,255,255,0.15)",
                boxShadow: "0 8px 30px rgba(0,0,0,0.45)",
                letterSpacing: "0.01em",
              }}
            >
              {selectedApp.name}
            </div>
          )}

          {/* Fila de iconos */}
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 16,
              padding: "14px 20px",
              background: "rgba(30,30,30,0.55)",
              backdropFilter: "blur(40px) saturate(180%)",
              WebkitBackdropFilter: "blur(40px) saturate(180%)",
              borderRadius: 22,
              border: "0.5px solid rgba(255,255,255,0.12)",
              boxShadow:
                "0 30px 80px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06)",
              maxWidth: "min(92vw, 1200px)",
              overflowX: "auto",
            }}
          >
            {runningApps.map((app, i) => (
              <SwitcherIcon
                key={app.id}
                app={app}
                selected={i === selectedIndex}
                onHover={() => setSelectedIndex(i)}
                onClick={() => {
                  setSelectedIndex(i);
                  // Click directo: confirma inmediatamente
                  setTimeout(() => {
                    const target = app.windows[0];
                    if (target) {
                      if (target.state === "minimized") wm.restore(target.id);
                      else wm.focus(target.id);
                    }
                    onSwitch?.(app);
                    handleClose();
                  }, 0);
                }}
              />
            ))}
          </div>

          {/* Ayuda contextual */}
          <div
            style={{
              fontSize: 11,
              color: "rgba(255,255,255,0.55)",
              display: "flex",
              gap: 16,
            }}
          >
            <span>
              <kbd style={kbdStyle}>Tab</kbd> siguiente
            </span>
            <span>
              <kbd style={kbdStyle}>⇧ Tab</kbd> anterior
            </span>
            <span>
              <kbd style={kbdStyle}>Esc</kbd> cancelar
            </span>
          </div>
        </div>
      </div>
    </AppSwitcherContext.Provider>
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

export default AppSwitcher;
