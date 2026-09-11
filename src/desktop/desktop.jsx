// ============================================================================
// desktop.jsx — Escritorio principal
// ----------------------------------------------------------------------------
// El escritorio del sistema. Responsabilidades:
// - Renderizar el fondo (wallpaper del initialconfig)
// - Renderizar los iconos del escritorio
// - Renderizar todas las ventanas gestionadas por el kernel
// - Renderizar la capa de selección (rubber band) para multi-selección
// - Renderizar el menú contextual (click derecho)
// - Renderizar la barra de menú superior
// - Renderizar el dock inferior
// - Gestionar doble-click en iconos
// - Gestionar drop de archivos sobre iconos
// - Gestionar atajos globales (⌘W, ⌘Q, ⌘Tab, ...)
// - Ocultar todo cuando el lockscreen está activo
// - Todo lo visual con estilos inline, sin CSS externo
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
  useDraggable,
  useResizable,
  WINDOW_STATE,
  TOP_RESERVED,
  BOTTOM_RESERVED,
  RESIZE_DIRS,
} from "../kernel/kernel.jsx";

import { useLockScreen, LOCK_STATE } from "../lockscreen/lockscreen.jsx";
import { useInitialConfig } from "../initialconfig/initialconfig.jsx";
import { useScheduler } from "../scheduler/scheduler.jsx";
import { useStartupInstaller } from "../startupinstaller/startupinstaller.jsx";

// ============================================================================
// CONTEXTO DEL ESCRITORIO
// ============================================================================

const DesktopContext = createContext(null);

export function useDesktop() {
  const ctx = useContext(DesktopContext);
  if (!ctx)
    throw new Error("useDesktop must be used within a DesktopProvider");
  return ctx;
}

// ============================================================================
// WALLPAPER
// ============================================================================

function Wallpaper({ css, image, blur = 0 }) {
  const style = image
    ? {
        backgroundImage: `url(${image})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        filter: blur ? `blur(${blur}px)` : undefined,
      }
    : { background: css || "linear-gradient(135deg,#1e3a8a 0%,#6d28d9 50%,#db2777 100%)" };

  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        ...style,
        zIndex: 0,
      }}
    />
  );
}

// ============================================================================
// ICONO DEL ESCRITORIO
// ============================================================================

function DesktopIcon({ icon, onOpen, onContextMenu, selected, onSelect }) {
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);
  const startPosRef = useRef({ x: 0, y: 0 });

  const handleMouseDown = (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect?.(icon.id, e);

    startPosRef.current = { x: e.clientX, y: e.clientY };

    const onMove = (ev) => {
      const dx = ev.clientX - startPosRef.current.x;
      const dy = ev.clientY - startPosRef.current.y;
      setDragOffset({ x: dx, y: dy });
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setDragOffset({ x: 0, y: 0 });
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const handleDoubleClick = (e) => {
    e.stopPropagation();
    onOpen?.(icon);
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu?.(icon, e);
  };

  return (
    <div
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      style={{
        position: "absolute",
        left: icon.x,
        top: icon.y,
        transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        width: 84,
        cursor: "default",
        userSelect: "none",
        color: "#fff",
        fontSize: 12,
        textShadow: "0 1px 3px rgba(0,0,0,0.6)",
        padding: 4,
        borderRadius: 6,
        background: selected ? "rgba(255,255,255,0.2)" : "transparent",
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 40,
        }}
      >
        {icon.renderIcon ? icon.renderIcon() : icon.emoji || "📄"}
      </div>
      <div
        style={{
          textAlign: "center",
          lineHeight: 1.2,
          wordBreak: "break-word",
          maxWidth: "100%",
        }}
      >
        {icon.name}
      </div>
    </div>
  );
}

// ============================================================================
// VENTANA (con chrome completo)
// ============================================================================

function WindowChrome({ win, renderContent }) {
  const wm = useWindowManager();
  const installer = useStartupInstaller();
  const scheduler = useScheduler();

  const drag = useDraggable(win.id, { snap: true });

  const se = useResizable(win.id, "se");
  const sw = useResizable(win.id, "sw");
  const ne = useResizable(win.id, "ne");
  const nw = useResizable(win.id, "nw");
  const n = useResizable(win.id, "n");
  const s = useResizable(win.id, "s");
  const e = useResizable(win.id, "e");
  const w = useResizable(win.id, "w");

  const style = installer?.getStyle?.("default") || {
    radius: 12,
    shadow: "0 20px 50px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(0,0,0,0.2)",
    titlebarHeight: 32,
  };

  const isMax = win.state === WINDOW_STATE.MAXIMIZED;
  const isFull = win.state === WINDOW_STATE.FULLSCREEN;
  const canDrag = !isMax && !isFull;

  const close = () => wm.close(win.id);
  const minimize = () => wm.minimize(win.id);
  const maximize = () => wm.toggleMaximize(win.id);
  const focus = () => wm.focus(win.id);

  const handleTitleDoubleClick = () => {
    if (win.flags?.maximizable === false) return;
    maximize();
  };

  const handleTitleMouseDown = (e) => {
    focus();
    if (!canDrag) return;
    drag.handleMouseDown(e);
  };

  // Handles de resize
  const handles = [
    { dir: "se", ...se, style: { right: 0, bottom: 0, width: 16, height: 16, cursor: "nwse-resize" } },
    { dir: "sw", ...sw, style: { left: 0, bottom: 0, width: 16, height: 16, cursor: "nesw-resize" } },
    { dir: "ne", ...ne, style: { right: 0, top: style.titlebarHeight, width: 16, height: 16, cursor: "nesw-resize" } },
    { dir: "nw", ...nw, style: { left: 0, top: style.titlebarHeight, width: 16, height: 16, cursor: "nwse-resize" } },
    { dir: "n", ...n, style: { left: 0, right: 0, top: 0, height: 6, cursor: "ns-resize" } },
    { dir: "s", ...s, style: { left: 0, right: 0, bottom: 0, height: 6, cursor: "ns-resize" } },
    { dir: "e", ...e, style: { right: 0, top: style.titlebarHeight, bottom: 0, width: 6, cursor: "ew-resize" } },
    { dir: "w", ...w, style: { left: 0, top: style.titlebarHeight, bottom: 0, width: 6, cursor: "ew-resize" } },
  ];

  const content = useMemo(() => {
    if (!win.component) return null;
    const Comp = win.component;
    return <Comp win={win} />;
  }, [win.component, win]);

  return (
    <div
      className="desktop-window"
      onMouseDown={focus}
      style={{
        position: "absolute",
        left: win.x,
        top: win.y,
        width: win.width,
        height: win.height,
        zIndex: win.zIndex,
        background: "rgba(240,240,240,0.92)",
        backdropFilter: "blur(30px)",
        WebkitBackdropFilter: "blur(30px)",
        borderRadius: style.radius,
        boxShadow: style.shadow,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        transition: "box-shadow 0.15s ease",
      }}
    >
      {/* Titlebar */}
      <div
        onMouseDown={handleTitleMouseDown}
        onDoubleClick={handleTitleDoubleClick}
        style={{
          height: style.titlebarHeight,
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          background: "rgba(230,230,230,0.8)",
          borderBottom: "0.5px solid rgba(0,0,0,0.15)",
          cursor: canDrag ? "grab" : "default",
          userSelect: "none",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", gap: 8, width: 60, alignItems: "center" }}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              close();
            }}
            title="Cerrar"
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              border: "none",
              padding: 0,
              background: "#ff5f57",
              cursor: "pointer",
            }}
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              minimize();
            }}
            title="Minimizar"
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              border: "none",
              padding: 0,
              background: "#febc2e",
              cursor: "pointer",
            }}
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              maximize();
            }}
            title="Maximizar"
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              border: "none",
              padding: 0,
              background: "#28c840",
              cursor: "pointer",
            }}
          />
        </div>
        <div
          style={{
            flex: 1,
            textAlign: "center",
            fontSize: 13,
            fontWeight: 600,
            color: "#333",
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
            padding: "0 12px",
          }}
        >
          {win.title}
        </div>
        <div style={{ width: 60 }} />
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          background: "rgba(255,255,255,0.7)",
        }}
      >
        {content}
      </div>

      {/* Resize handles */}
      {!isMax && !isFull && win.flags?.resizable !== false && (
        <>
          {handles.map(({ dir, handleMouseDown, style: hs }) => (
            <div
              key={dir}
              onMouseDown={handleMouseDown}
              style={{
                position: "absolute",
                ...hs,
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}

// ============================================================================
// SELECCIÓN (RUBBER BAND)
// ============================================================================

function RubberBand({ start, end, active }) {
  if (!active) return null;
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width,
        height,
        background: "rgba(10,132,255,0.25)",
        border: "1px solid rgba(10,132,255,0.6)",
        pointerEvents: "none",
        zIndex: 999998,
      }}
    />
  );
}

// ============================================================================
// MENÚ CONTEXTUAL
// ============================================================================

function ContextMenu({ items, position, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose?.();
    };
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!items || items.length === 0) return null;

  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        left: position.x,
        top: position.y,
        minWidth: 200,
        background: "rgba(40,40,40,0.95)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderRadius: 8,
        padding: 6,
        boxShadow: "0 10px 30px rgba(0,0,0,0.4)",
        border: "0.5px solid rgba(255,255,255,0.1)",
        zIndex: 999999,
        color: "#fff",
        fontSize: 13,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div
            key={i}
            style={{
              height: 1,
              background: "rgba(255,255,255,0.15)",
              margin: "5px 4px",
            }}
          />
        ) : (
          <div
            key={i}
            onClick={() => {
              item.action?.();
              onClose?.();
            }}
            style={{
              padding: "5px 10px",
              borderRadius: 4,
              cursor: "pointer",
              display: "flex",
              justifyContent: "space-between",
              gap: 20,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "#0a84ff";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && (
              <span style={{ opacity: 0.6 }}>{item.shortcut}</span>
            )}
          </div>
        )
      )}
    </div>
  );
}

// ============================================================================
// ATAJOS GLOBALES
// ============================================================================

function useGlobalShortcuts({ onShowDesktop, onCycleWindows, onCloseActive }) {
  useEffect(() => {
    const handler = (e) => {
      const meta = e.metaKey || e.ctrlKey;

      if (meta && e.key === "w") {
        e.preventDefault();
        onCloseActive?.();
        return;
      }

      if (meta && e.key === "Tab") {
        e.preventDefault();
        onCycleWindows?.(e.shiftKey ? -1 : 1);
        return;
      }

      if (meta && e.key === "F3") {
        e.preventDefault();
        onShowDesktop?.();
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCloseActive, onCycleWindows, onShowDesktop]);
}

// ============================================================================
// DESKTOP
// ============================================================================

export function Desktop({
  icons: iconsProp = [],
  onIconOpen,
  menuBar,
  dock,
  overlay,
  hideWhenLocked = true,
  children,
}) {
  const wm = useWindowManager();
  const lock = useLockScreen?.() ?? { locked: false };
  const config = useInitialConfig?.() ?? { values: null };
  const installer = useStartupInstaller?.() ?? null;

  const [selectedIcons, setSelectedIcons] = useState(new Set());
  const [contextMenu, setContextMenu] = useState(null);
  const [rubber, setRubber] = useState({
    active: false,
    start: { x: 0, y: 0 },
    end: { x: 0, y: 0 },
  });

  const desktopRef = useRef(null);

  const wallpaper = useMemo(() => {
    if (config?.values?.appearance?.wallpaper) {
      const wp = config.values.appearance.wallpaper;
      return wp;
    }
    return "sonoma";
  }, [config?.values?.appearance?.wallpaper]);

  const wallpaperStyle = useMemo(() => {
    const walls = {
      sonoma: "linear-gradient(135deg,#1e3a8a 0%,#6d28d9 50%,#db2777 100%)",
      ventura: "linear-gradient(135deg,#0f172a 0%,#1e40af 50%,#0891b2 100%)",
      monterey: "linear-gradient(135deg,#7c3aed 0%,#ec4899 50%,#f59e0b 100%)",
      bigsur: "linear-gradient(135deg,#fb7185 0%,#a78bfa 50%,#38bdf8 100%)",
      graphite: "#1c1c1e",
      midnight: "#0a0a0a",
      snow: "#f5f5f7",
    };
    return walls[wallpaper] || walls.sonoma;
  }, [wallpaper]);

  // ------------------------------------------------------ iconos por defecto
  const icons = useMemo(() => {
    const base = [
      {
        id: "macintosh-hd",
        name: "Macintosh HD",
        emoji: "💽",
        x: 20,
        y: 20,
        onOpen: () => {
          if (onIconOpen) onIconOpen("macintosh-hd");
        },
      },
      {
        id: "documents",
        name: "Documentos",
        emoji: "📁",
        x: 20,
        y: 120,
        onOpen: () => onIconOpen?.("documents"),
      },
      {
        id: "downloads",
        name: "Descargas",
        emoji: "📥",
        x: 20,
        y: 220,
        onOpen: () => onIconOpen?.("downloads"),
      },
      {
        id: "trash",
        name: "Papelera",
        emoji: "🗑️",
        x: 20,
        y: 900,
        onOpen: () => onIconOpen?.("trash"),
      },
    ];
    return [...base, ...iconsProp];
  }, [iconsProp, onIconOpen]);

  // ------------------------------------------------------ selection
  const handleIconSelect = useCallback((id, e) => {
    setSelectedIcons((prev) => {
      const next = new Set(e.metaKey || e.ctrlKey ? prev : []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIcons(new Set());
  }, []);

  // ------------------------------------------------------ rubber band
  const handleDesktopMouseDown = useCallback(
    (e) => {
      if (e.target !== desktopRef.current) return;
      if (e.button !== 0) return;

      clearSelection();
      setContextMenu(null);

      const start = { x: e.clientX, y: e.clientY };
      setRubber({ active: true, start, end: start });

      const onMove = (ev) => {
        setRubber((r) => ({ ...r, end: { x: ev.clientX, y: ev.clientY } }));
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        setRubber({ active: false, start: { x: 0, y: 0 }, end: { x: 0, y: 0 } });
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [clearSelection]
  );

  // ------------------------------------------------------ context menu
  const handleDesktopContextMenu = useCallback(
    (e) => {
      if (e.target !== desktopRef.current) return;
      e.preventDefault();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: "Nueva carpeta",
            action: () => console.log("[desktop] new folder"),
          },
          {
            label: "Nuevo documento",
            action: () => console.log("[desktop] new document"),
          },
          { separator: true },
          {
            label: "Cambiar fondo de pantalla…",
            action: () => console.log("[desktop] change wallpaper"),
          },
          {
            label: "Ordenar por nombre",
            action: () => console.log("[desktop] sort by name"),
          },
          {
            label: "Mostrar opciones de vista",
            action: () => console.log("[desktop] view options"),
          },
        ],
      });
    },
    []
  );

  const handleIconContextMenu = useCallback((icon, e) => {
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "Abrir",
          action: () => icon.onOpen?.(),
        },
        {
          label: "Mostrar en Finder",
          action: () => console.log("[desktop] show in finder"),
        },
        { separator: true },
        {
          label: "Obtener información",
          action: () => console.log("[desktop] get info"),
        },
        {
          label: "Renombrar",
          action: () => console.log("[desktop] rename"),
        },
        { separator: true },
        {
          label: "Mover a la papelera",
          action: () => console.log("[desktop] move to trash"),
        },
      ],
    });
  }, []);

  // ------------------------------------------------------ global shortcuts
  useGlobalShortcuts({
    onCloseActive: () => {
      const active = wm.getActive();
      if (active) wm.close(active.id);
    },
    onCycleWindows: () => wm.focusNext(),
    onShowDesktop: () => {
      wm.getVisibleWindows().forEach((w) => wm.minimize(w.id));
    },
  });

  // ------------------------------------------------------ escuchar eventos del kernel
  useEffect(() => {
    const offOpen = kernelBus.on(KERNEL_EVENTS.WINDOW_OPENED, () => {
      setContextMenu(null);
    });
    return () => {
      offOpen();
    };
  }, []);

  // ------------------------------------------------------ ocultar cuando locked
  const shouldHide = hideWhenLocked && lock?.locked;

  return (
    <DesktopContext.Provider value={{ selectedIcons, clearSelection }}>
      <div
        ref={desktopRef}
        className="desktop-root"
        style={{
          position: "fixed",
          inset: 0,
          overflow: "hidden",
          visibility: shouldHide ? "hidden" : "visible",
        }}
        onMouseDown={handleDesktopMouseDown}
        onContextMenu={handleDesktopContextMenu}
      >
        <Wallpaper css={wallpaperStyle} blur={lock?.showScreenSaver ? 20 : 0} />

        {/* Iconos del escritorio */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
          }}
        >
          <div style={{ position: "absolute", inset: 0, pointerEvents: "auto" }}>
            {icons.map((icon) => (
              <DesktopIcon
                key={icon.id}
                icon={icon}
                selected={selectedIcons.has(icon.id)}
                onSelect={handleIconSelect}
                onOpen={icon.onOpen}
                onContextMenu={handleIconContextMenu}
              />
            ))}
          </div>
        </div>

        {/* Capa de ventanas */}
        <div
          style={{
            position: "absolute",
            top: TOP_RESERVED,
            left: 0,
            right: 0,
            bottom: 0,
          }}
        >
          {wm.windows
            .filter((w) => w.state !== WINDOW_STATE.MINIMIZED)
            .map((win) => (
              <WindowChrome key={win.id} win={win} />
            ))}
        </div>

        {/* Barra de menú */}
        {menuBar && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              zIndex: 10000,
            }}
          >
            {menuBar}
          </div>
        )}

        {/* Dock */}
        {dock && (
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              zIndex: 9000,
            }}
          >
            {dock}
          </div>
        )}

        {/* Rubber band */}
        <RubberBand
          active={rubber.active}
          start={rubber.start}
          end={rubber.end}
        />

        {/* Menú contextual */}
        {contextMenu && (
          <ContextMenu
            items={contextMenu.items}
            position={{ x: contextMenu.x, y: contextMenu.y }}
            onClose={() => setContextMenu(null)}
          />
        )}

        {/* Overlay opcional (mission control, launchpad, spotlight) */}
        {overlay}

        {/* Hijos personalizados */}
        {children}
      </div>
    </DesktopContext.Provider>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export default Desktop;
