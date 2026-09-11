// ============================================================================
// dock.jsx — Dock inferior
// ----------------------------------------------------------------------------
// El dock del sistema. Responsabilidades:
// - Mostrar apps fijadas y apps abiertas
// - Efecto de magnificación al hover (estilo macOS)
// - Indicador de apps abiertas (punto debajo)
// - Separador antes de la Papelera
// - Papelera al final
// - Tooltips con el nombre de cada app
// - Click para abrir/foco de la app
// - Click derecho para opciones (cerrar, mostrar en Finder, etc.)
// - Reordenar por drag (opcional)
// - Animación de bounce al abrir una app
// - Posición configurable (bottom/left/right) desde initialconfig
// - Autohide configurable
// - Tamaño configurable (small/medium/large)
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
  Z_DOCK,
  BOTTOM_RESERVED,
} from "../kernel/kernel.jsx";

import { useLockScreen } from "../lockscreen/lockscreen.jsx";
import { useInitialConfig } from "../initialconfig/initialconfig.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

const DOCK_SIZE_MAP = {
  small: 44,
  medium: 52,
  large: 62,
};

const MAGNIFICATION_SCALE = 1.55;
const MAGNIFICATION_RADIUS = 2; // cuántos vecinos se magnifican además del hover
const BOUNCE_HEIGHT = 18;
const BOUNCE_DURATION = 500;

// ============================================================================
// CONTEXTO
// ============================================================================

const DockContext = createContext(null);

export function useDock() {
  const ctx = useContext(DockContext);
  if (!ctx) throw new Error("useDock must be used within a Dock");
  return ctx;
}

// ============================================================================
// ICONO DEL DOCK
// ============================================================================

function DockIcon({
  app,
  index,
  hoveredIndex,
  iconSize,
  magnification,
  isRunning,
  onClick,
  onContextMenu,
  bouncing,
}) {
  const distance = hoveredIndex == null ? null : Math.abs(hoveredIndex - index);
  const inRange =
    distance != null && distance <= MAGNIFICATION_RADIUS && magnification;
  const scale = inRange
    ? Math.max(
        1,
        MAGNIFICATION_SCALE - (distance - 0) * (MAGNIFICATION_SCALE - 1) / (MAGNIFICATION_RADIUS + 1)
      )
    : 1;
  const lift = inRange ? (scale - 1) * iconSize * 0.5 : 0;

  const size = iconSize;

  return (
    <div
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e);
      }}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-end",
        cursor: "pointer",
        userSelect: "none",
        transition: "transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1)",
        transform: `translateY(-${lift}px) scale(${scale})`,
        transformOrigin: "bottom center",
        zIndex: inRange ? 10 : 1,
        width: size,
        height: size,
        animation: bouncing
          ? `dock-bounce ${BOUNCE_DURATION}ms ease-in-out`
          : undefined,
      }}
    >
      <div
        style={{
          width: size,
          height: size,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: size * 0.62,
          borderRadius: size * 0.22,
          overflow: "hidden",
          background: "transparent",
          boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
          textShadow: "0 1px 3px rgba(0,0,0,0.4)",
        }}
      >
        {app.renderIcon ? app.renderIcon({ size }) : app.emoji || "📦"}
      </div>

      {/* Indicador de app abierta */}
      {isRunning && (
        <div
          style={{
            position: "absolute",
            bottom: -6,
            left: "50%",
            transform: "translateX(-50%)",
            width: 4,
            height: 4,
            borderRadius: 2,
            background: "rgba(255,255,255,0.9)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// TOOLTIP
// ============================================================================

function DockTooltip({ app, position }) {
  if (!app) return null;
  return (
    <div
      style={{
        position: "absolute",
        bottom: position.bottom,
        left: position.left,
        transform: "translate(-50%, -100%)",
        background: "rgba(30,30,30,0.95)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        color: "#fff",
        padding: "4px 10px",
        borderRadius: 6,
        fontSize: 12,
        whiteSpace: "nowrap",
        pointerEvents: "none",
        zIndex: Z_DOCK + 10,
        boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
        border: "0.5px solid rgba(255,255,255,0.1)",
      }}
    >
      {app.name}
    </div>
  );
}

// ============================================================================
// DOCK
// ============================================================================

export function Dock({
  apps: appsProp = [],
  pinned = [],
  trash,
  onAppClick,
  onTrashClick,
  onContextMenu,
  position: positionProp,
  size: sizeProp,
  magnification: magProp,
  autohide: autohideProp,
}) {
  const wm = useWindowManager();
  const lock = useLockScreen?.() ?? { locked: false };
  const config = useInitialConfig?.() ?? { values: null };

  // ------------------------------------------------------ config from initialconfig
  const configDock = config?.values?.dock || {};
  const position = positionProp ?? configDock.position ?? "bottom";
  const sizeKey = sizeProp ?? configDock.size ?? "medium";
  const magnification = magProp ?? configDock.magnification ?? true;
  const autohide = autohideProp ?? configDock.autohide ?? false;

  const iconSize = DOCK_SIZE_MAP[sizeKey] || DOCK_SIZE_MAP.medium;

  // ------------------------------------------------------ state
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const [tooltipApp, setTooltipApp] = useState(null);
  const [bouncingId, setBouncingId] = useState(null);
  const [isHoveringDock, setIsHoveringDock] = useState(false);

  const dockRef = useRef(null);

  // ------------------------------------------------------ build app list
  const allApps = useMemo(() => {
    const pinnedIds = new Set(pinned);
    const list = [];

    // Pinned first (in order)
    if (pinned.length > 0) {
      for (const id of pinned) {
        const app = appsProp.find((a) => a.id === id);
        if (app) list.push(app);
      }
    }

    // Rest of apps
    for (const app of appsProp) {
      if (!pinnedIds.has(app.id)) list.push(app);
    }

    return list;
  }, [appsProp, pinned]);

  const runningAppIds = useMemo(() => {
    const ids = new Set();
    for (const w of wm.windows) ids.add(w.appId);
    return ids;
  }, [wm.windows]);

  // ------------------------------------------------------ handlers
  const handleIconClick = useCallback(
    (app) => {
      const existingWindows = wm.windows.filter((w) => w.appId === app.id);

      if (existingWindows.length === 0) {
        // Not running: open
        setBouncingId(app.id);
        setTimeout(() => setBouncingId(null), BOUNCE_DURATION);
        onAppClick?.(app);
      } else {
        // Running: focus or cycle
        const active = wm.getActive();
        if (active && active.appId === app.id) {
          // Already active: focus next window of this app or minimize
          const visible = existingWindows.filter(
            (w) => w.state !== "minimized"
          );
          if (visible.length > 0) {
            wm.minimize(visible[0].id);
          } else {
            wm.restore(existingWindows[0].id);
          }
        } else {
          // Focus first visible window of this app
          const visible = existingWindows.find(
            (w) => w.state !== "minimized"
          );
          if (visible) wm.focus(visible.id);
          else wm.restore(existingWindows[0].id);
        }
      }
    },
    [wm, onAppClick]
  );

  const handleIconContextMenu = useCallback(
    (app, e) => {
      const existingWindows = wm.windows.filter((w) => w.appId === app.id);
      onContextMenu?.({
        app,
        event: e,
        windows: existingWindows,
        actions: {
          open: () => onAppClick?.(app),
          closeAll: () => existingWindows.forEach((w) => wm.close(w.id)),
          minimizeAll: () => existingWindows.forEach((w) => wm.minimize(w.id)),
          focusFirst: () => {
            if (existingWindows[0]) wm.focus(existingWindows[0].id);
          },
        },
      });
    },
    [wm, onAppClick, onContextMenu]
  );

  // ------------------------------------------------------ autohide
  const hideTimeoutRef = useRef(null);
  const [autohideVisible, setAutohideVisible] = useState(false);

  useEffect(() => {
    if (!autohide) {
      setAutohideVisible(false);
      return;
    }

    const handleMouseMove = (e) => {
      if (typeof window === "undefined") return;
      const dockThickness = iconSize + 24;
      let trigger = false;

      if (position === "bottom") {
        trigger = e.clientY > window.innerHeight - 4;
      } else if (position === "left") {
        trigger = e.clientX < 4;
      } else if (position === "right") {
        trigger = e.clientX > window.innerWidth - 4;
      }

      if (trigger) {
        setAutohideVisible(true);
        if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
      } else if (!isHoveringDock) {
        if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = setTimeout(() => {
          setAutohideVisible(false);
        }, 400);
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, [autohide, position, iconSize, isHoveringDock]);

  const shouldShow = !autohide || autohideVisible;

  // ------------------------------------------------------ positioning
  const dockStyle = useMemo(() => {
    const base = {
      position: "fixed",
      zIndex: Z_DOCK,
      transition: "transform 0.25s ease-out, opacity 0.2s ease-out",
      opacity: shouldShow ? 1 : 0,
    };

    if (position === "bottom") {
      return {
        ...base,
        bottom: 8,
        left: "50%",
        transform: shouldShow
          ? "translateX(-50%) translateY(0)"
          : "translateX(-50%) translateY(120%)",
      };
    }
    if (position === "left") {
      return {
        ...base,
        left: 8,
        top: "50%",
        transform: shouldShow
          ? "translateY(-50%) translateX(0)"
          : "translateY(-50%) translateX(-120%)",
      };
    }
    return {
      ...base,
      right: 8,
      top: "50%",
      transform: shouldShow
        ? "translateY(-50%) translateX(0)"
        : "translateY(-50%) translateX(120%)",
    };
  }, [position, shouldShow]);

  const isVertical = position === "left" || position === "right";

  // ------------------------------------------------------ hide when locked
  if (lock?.locked) return null;

  return (
    <DockContext.Provider
      value={{
        allApps,
        runningAppIds,
        handleIconClick,
        iconSize,
        position,
      }}
    >
      <div
        ref={dockRef}
        style={dockStyle}
        onMouseEnter={() => {
          setIsHoveringDock(true);
          setAutohideVisible(true);
        }}
        onMouseLeave={() => {
          setIsHoveringDock(false);
          setHoveredIndex(null);
          setTooltipApp(null);
        }}
      >
        <style>{`
          @keyframes dock-bounce {
            0% { transform: translateY(0) scale(1); }
            30% { transform: translateY(-${BOUNCE_HEIGHT}px) scale(1); }
            60% { transform: translateY(0) scale(1); }
            80% { transform: translateY(-4px) scale(1); }
            100% { transform: translateY(0) scale(1); }
          }
        `}</style>

        <div
          style={{
            display: "flex",
            flexDirection: isVertical ? "column" : "row",
            alignItems: "center",
            gap: 6,
            padding: "8px 12px",
            background: "rgba(255,255,255,0.22)",
            backdropFilter: "blur(30px) saturate(180%)",
            WebkitBackdropFilter: "blur(30px) saturate(180%)",
            borderRadius: 20,
            border: "0.5px solid rgba(255,255,255,0.35)",
            boxShadow:
              "0 10px 30px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.15)",
          }}
        >
          {/* Apps */}
          {allApps.map((app, index) => (
            <div
              key={app.id}
              onMouseEnter={(e) => {
                setHoveredIndex(index);
                const rect = e.currentTarget.getBoundingClientRect();
                setTooltipApp({
                  app,
                  position: isVertical
                    ? {
                        left:
                          position === "left"
                            ? rect.right + 12
                            : rect.left - 12,
                        bottom: rect.top + rect.height / 2,
                      }
                    : {
                        left: rect.left + rect.width / 2,
                        bottom:
                          typeof window !== "undefined"
                            ? window.innerHeight - rect.top + 8
                            : 0,
                      },
                });
              }}
              onMouseLeave={() => {
                setHoveredIndex(null);
                setTooltipApp(null);
              }}
            >
              <DockIcon
                app={app}
                index={index}
                hoveredIndex={hoveredIndex}
                iconSize={iconSize}
                magnification={magnification}
                isRunning={runningAppIds.has(app.id)}
                bouncing={bouncingId === app.id}
                onClick={() => handleIconClick(app)}
                onContextMenu={(e) => handleIconContextMenu(app, e)}
              />
            </div>
          ))}

          {/* Separator */}
          {(allApps.length > 0 || trash) && (
            <div
              style={{
                width: isVertical ? iconSize * 0.8 : 1,
                height: isVertical ? 1 : iconSize * 0.8,
                background: "rgba(255,255,255,0.35)",
                margin: isVertical ? "4px 0" : "0 6px",
                alignSelf: "center",
              }}
            />
          )}

          {/* Papelera */}
          {trash && (
            <div
              onMouseEnter={(e) => {
                setHoveredIndex(allApps.length + 1);
                const rect = e.currentTarget.getBoundingClientRect();
                setTooltipApp({
                  app: trash,
                  position: isVertical
                    ? {
                        left:
                          position === "left"
                            ? rect.right + 12
                            : rect.left - 12,
                        bottom: rect.top + rect.height / 2,
                      }
                    : {
                        left: rect.left + rect.width / 2,
                        bottom:
                          typeof window !== "undefined"
                            ? window.innerHeight - rect.top + 8
                            : 0,
                      },
                });
              }}
              onMouseLeave={() => {
                setHoveredIndex(null);
                setTooltipApp(null);
              }}
            >
              <DockIcon
                app={trash}
                index={allApps.length + 1}
                hoveredIndex={hoveredIndex}
                iconSize={iconSize}
                magnification={magnification}
                isRunning={false}
                bouncing={false}
                onClick={() => onTrashClick?.()}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onContextMenu?.({
                    app: trash,
                    event: e,
                    actions: {
                      open: () => onTrashClick?.(),
                      empty: () => console.log("[dock] empty trash"),
                    },
                  });
                }}
              />
            </div>
          )}
        </div>

        {/* Tooltip */}
        {tooltipApp && (
          <DockTooltip
            app={tooltipApp.app}
            position={tooltipApp.position}
          />
        )}
      </div>
    </DockContext.Provider>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export default Dock;
