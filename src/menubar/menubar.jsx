// ============================================================================
// menubar.jsx — Barra de menú superior
// ----------------------------------------------------------------------------
// La barra de arriba del escritorio. Responsabilidades:
// - Logo de la manzana con menú Apple (Acerca de, Ajustes, Dormir, Reiniciar...)
// - Menús del app activo (Archivo, Editar, Ver, Ventana, Ayuda...)
// - Menús desplegables con hover + click
// - Indicadores del sistema: batería, wifi, bluetooth, sonido, brillo
// - Reloj con fecha y hora (formato 12h/24h desde initialconfig)
// - Centro de control (botón que abre overlay)
// - Spotlight (botón que abre overlay)
// - Notificaciones (botón que abre overlay)
// - Icono del usuario
// - Se oculta/atenúa cuando el escritorio está bloqueado
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
  TOP_RESERVED,
  Z_MENUBAR,
} from "../kernel/kernel.jsx";

import { useLockScreen } from "../lockscreen/lockscreen.jsx";
import { useInitialConfig } from "../initialconfig/initialconfig.jsx";

// ============================================================================
// CONTEXTO
// ============================================================================

const MenuBarContext = createContext(null);

export function useMenuBar() {
  const ctx = useContext(MenuBarContext);
  if (!ctx)
    throw new Error("useMenuBar must be used within a MenuBar");
  return ctx;
}

// ============================================================================
// MENÚ APPLE (con menús desplegables genéricos)
// ============================================================================

function Menu({
  label,
  items,
  open,
  onOpen,
  onClose,
  onHover,
  bold,
}) {
  const ref = useRef(null);

  return (
    <div
      ref={ref}
      onMouseEnter={onHover}
      onClick={(e) => {
        e.stopPropagation();
        open ? onClose?.() : onOpen?.();
      }}
      style={{
        position: "relative",
        padding: "2px 10px",
        borderRadius: 4,
        fontSize: 13,
        cursor: "default",
        fontWeight: bold ? 600 : 400,
        background: open ? "rgba(255,255,255,0.25)" : "transparent",
        color: "#fff",
        userSelect: "none",
        height: 20,
        display: "flex",
        alignItems: "center",
      }}
    >
      {label}
      {open && items && items.length > 0 && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: 24,
            left: 0,
            minWidth: 220,
            background: "rgba(40,40,40,0.95)",
            backdropFilter: "blur(30px)",
            WebkitBackdropFilter: "blur(30px)",
            borderRadius: 8,
            padding: 6,
            boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
            border: "0.5px solid rgba(255,255,255,0.1)",
            color: "#fff",
            fontSize: 13,
            zIndex: Z_MENUBAR + 1,
          }}
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
                  gap: 24,
                  opacity: item.disabled ? 0.4 : 1,
                  pointerEvents: item.disabled ? "none" : "auto",
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
      )}
    </div>
  );
}

// ============================================================================
// INDICADOR DEL SISTEMA
// ============================================================================

function StatusIcon({ children, onClick, title }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: "transparent",
        border: "none",
        color: "#fff",
        cursor: "pointer",
        padding: "2px 6px",
        borderRadius: 4,
        fontSize: 13,
        display: "flex",
        alignItems: "center",
        gap: 4,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(255,255,255,0.15)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}

// ============================================================================
// RELOJ
// ============================================================================

function Clock({ use24Hour }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000 * 5);
    return () => clearInterval(t);
  }, []);

  const text = useMemo(() => {
    try {
      const weekday = now.toLocaleDateString("es-ES", { weekday: "long" });
      const day = now.getDate();
      const month = now.toLocaleDateString("es-ES", { month: "long" });

      const opts = use24Hour
        ? { hour: "2-digit", minute: "2-digit", hour12: false }
        : { hour: "numeric", minute: "2-digit", hour12: true };
      const time = now.toLocaleTimeString("es-ES", opts);

      return `${time} ${weekday.charAt(0).toUpperCase() + weekday.slice(1)} ${day} de ${month}`;
    } catch {
      return now.toLocaleString();
    }
  }, [now, use24Hour]);

  return <span style={{ fontSize: 13 }}>{text}</span>;
}

// ============================================================================
// MENÚ BAR
// ============================================================================

export function MenuBar({
  onOpenControlCenter,
  onOpenSpotlight,
  onOpenNotifications,
  onOpenSettings,
  onOpenAbout,
  onSleep,
  onRestart,
  onShutdown,
  onLockScreen,
  onLogOut,
  extraMenus = [],
  appName: appNameProp,
  apps = [],
}) {
  const wm = useWindowManager();
  const lock = useLockScreen?.() ?? { locked: false };
  const config = useInitialConfig?.() ?? { values: null };

  const [openMenu, setOpenMenu] = useState(null);
  const barRef = useRef(null);

  const use24Hour = config?.values?.use24Hour !== false;

  // Cierra menús al click fuera
  useEffect(() => {
    const onDown = (e) => {
      if (barRef.current && !barRef.current.contains(e.target)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // Cierra al cambiar de app activa
  useEffect(() => {
    const off = kernelBus.on(KERNEL_EVENTS.WINDOW_FOCUSED, () => {
      setOpenMenu(null);
    });
    return off;
  }, []);

  const active = wm.getActive();
  const appName = appNameProp || active?.appId || "Finder";

  // ------------------------------------------------------------------ menús Apple
  const appleMenuItems = useMemo(
    () => [
      {
        label: "Acerca de este Mac",
        action: () => onOpenAbout?.(),
      },
      { separator: true },
      {
        label: "Ajustes del Sistema…",
        action: () => onOpenSettings?.(),
      },
      { separator: true },
      {
        label: "Bloquear pantalla",
        shortcut: "⌃⌘Q",
        action: () => onLockScreen?.(),
      },
      {
        label: "Cerrar sesión…",
        shortcut: "⇧⌘Q",
        action: () => onLogOut?.(),
      },
      { separator: true },
      {
        label: "Dormir",
        action: () => onSleep?.(),
      },
      {
        label: "Reiniciar…",
        action: () => onRestart?.(),
      },
      {
        label: "Apagar…",
        action: () => onShutdown?.(),
      },
    ],
    [onOpenAbout, onOpenSettings, onLockScreen, onLogOut, onSleep, onRestart, onShutdown]
  );

  // ------------------------------------------------------------------ menús del app activo
  const fileMenuItems = useMemo(
    () => [
      { label: "Nueva ventana", shortcut: "⌘N" },
      { label: "Nueva pestaña", shortcut: "⌘T" },
      { separator: true },
      { label: "Abrir…", shortcut: "⌘O" },
      { label: "Abrir reciente" },
      { separator: true },
      { label: "Cerrar ventana", shortcut: "⌘W" },
      { label: "Cerrar todas las ventanas", shortcut: "⌥⌘W" },
      { separator: true },
      { label: "Guardar", shortcut: "⌘S" },
      { label: "Guardar como…", shortcut: "⇧⌘S" },
      { separator: true },
      { label: "Imprimir…", shortcut: "⌘P" },
    ],
    []
  );

  const editMenuItems = useMemo(
    () => [
      { label: "Deshacer", shortcut: "⌘Z" },
      { label: "Rehacer", shortcut: "⇧⌘Z" },
      { separator: true },
      { label: "Cortar", shortcut: "⌘X" },
      { label: "Copiar", shortcut: "⌘C" },
      { label: "Pegar", shortcut: "⌘V" },
      { label: "Pegar y buscar", shortcut: "⇧⌘V" },
      { separator: true },
      { label: "Seleccionar todo", shortcut: "⌘A" },
      { separator: true },
      { label: "Buscar…", shortcut: "⌘F" },
      { label: "Buscar siguiente", shortcut: "⌘G" },
    ],
    []
  );

  const viewMenuItems = useMemo(
    () => [
      { label: "Como iconos", shortcut: "⌘1" },
      { label: "Como lista", shortcut: "⌘2" },
      { label: "Como columnas", shortcut: "⌘3" },
      { label: "Como galería", shortcut: "⌘4" },
      { separator: true },
      { label: "Mostrar barra lateral", shortcut: "⌃⌘S" },
      { label: "Mostrar barra de estado" },
      { label: "Mostrar barra de ruta" },
      { separator: true },
      { label: "Entrar en pantalla completa", shortcut: "⌃⌘F" },
    ],
    []
  );

  const goMenuItems = useMemo(
    () => [
      { label: "Atrás", shortcut: "⌘[" },
      { label: "Adelante", shortcut: "⌘]" },
      { label: "Subir", shortcut: "⌘↑" },
      { separator: true },
      { label: "Escritorio", shortcut: "⇧⌘D" },
      { label: "Documentos", shortcut: "⇧⌘O" },
      { label: "Descargas", shortcut: "⌥⌘L" },
      { label: "Inicio", shortcut: "⇧⌘H" },
      { separator: true },
      { label: "Utilidades", shortcut: "⇧⌘U" },
      { separator: true },
      { label: "Ir a la carpeta…", shortcut: "⇧⌘G" },
    ],
    []
  );

  const windowMenuItems = useMemo(
    () => [
      { label: "Minimizar", shortcut: "⌘M" },
      { label: "Zoom" },
      { separator: true },
      { label: "Mover la ventana a la izquierda" },
      { label: "Mover la ventana a la derecha" },
      { separator: true },
      { label: "Traer todo al frente" },
      { separator: true },
      ...wm.windows
        .filter((w) => w.state !== "minimized")
        .slice(0, 8)
        .map((w) => ({
          label: w.title,
          action: () => wm.focus(w.id),
        })),
    ],
    [wm.windows, wm]
  );

  const helpMenuItems = useMemo(
    () => [
      { label: "Ayuda de macOS" },
      { separator: true },
      { label: "Buscar en la Ayuda" },
    ],
    []
  );

  // ------------------------------------------------------------------ click handlers
  const open = (name) => setOpenMenu(name);
  const close = () => setOpenMenu(null);
  const hover = (name) => {
    if (openMenu !== null) setOpenMenu(name);
  };

  // ------------------------------------------------------------------ hidden when locked
  if (lock?.locked) {
    return (
      <div
        ref={barRef}
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: TOP_RESERVED,
          zIndex: Z_MENUBAR,
          pointerEvents: "none",
        }}
      />
    );
  }

  return (
    <div
      ref={barRef}
      className="menubar-root"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: TOP_RESERVED,
        background: "rgba(0,0,0,0.35)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: 2,
        color: "#fff",
        fontSize: 13,
        zIndex: Z_MENUBAR,
        userSelect: "none",
        borderBottom: "0.5px solid rgba(255,255,255,0.06)",
      }}
    >
      {/* Menú Apple */}
      <Menu
        label={"\uF8FF"}
        bold
        open={openMenu === "apple"}
        onOpen={() => open("apple")}
        onClose={close}
        onHover={() => hover("apple")}
        items={appleMenuItems}
      />

      {/* Nombre del app activo */}
      <Menu
        label={appName}
        bold
        open={openMenu === "app"}
        onOpen={() => open("app")}
        onClose={close}
        onHover={() => hover("app")}
        items={[
          { label: `Acerca de ${appName}`, action: () => onOpenAbout?.() },
          { separator: true },
          { label: "Preferencias…", shortcut: "⌘," },
          { separator: true },
          { label: `Ocultar ${appName}`, shortcut: "⌘H" },
          { label: `Ocultar los demás`, shortcut: "⌥⌘H" },
          { label: `Mostrar todo` },
          { separator: true },
          { label: `Salir de ${appName}`, shortcut: "⌘Q", action: () => { const a = wm.getActive(); if (a) wm.close(a.id); } },
        ]}
      />

      {/* Menús estándar */}
      <Menu
        label="Archivo"
        open={openMenu === "file"}
        onOpen={() => open("file")}
        onClose={close}
        onHover={() => hover("file")}
        items={fileMenuItems}
      />
      <Menu
        label="Editar"
        open={openMenu === "edit"}
        onOpen={() => open("edit")}
        onClose={close}
        onHover={() => hover("edit")}
        items={editMenuItems}
      />
      <Menu
        label="Ver"
        open={openMenu === "view"}
        onOpen={() => open("view")}
        onClose={close}
        onHover={() => hover("view")}
        items={viewMenuItems}
      />
      <Menu
        label="Ir"
        open={openMenu === "go"}
        onOpen={() => open("go")}
        onClose={close}
        onHover={() => hover("go")}
        items={goMenuItems}
      />
      <Menu
        label="Ventana"
        open={openMenu === "window"}
        onOpen={() => open("window")}
        onClose={close}
        onHover={() => hover("window")}
        items={windowMenuItems}
      />
      <Menu
        label="Ayuda"
        open={openMenu === "help"}
        onOpen={() => open("help")}
        onClose={close}
        onHover={() => hover("help")}
        items={helpMenuItems}
      />

      {/* Extra menus */}
      {extraMenus.map((m) => (
        <Menu
          key={m.id}
          label={m.label}
          items={m.items}
          open={openMenu === m.id}
          onOpen={() => open(m.id)}
          onClose={close}
          onHover={() => hover(m.id)}
        />
      ))}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Indicadores del sistema */}
      <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
        <StatusIcon
          title="Batería: 80%"
          onClick={() => onOpenControlCenter?.()}
        >
          <span>🔋</span>
          <span style={{ fontSize: 12 }}>80%</span>
        </StatusIcon>

        <StatusIcon title="Wi-Fi" onClick={() => onOpenControlCenter?.()}>
          <span>📶</span>
        </StatusIcon>

        <StatusIcon title="Bluetooth" onClick={() => onOpenControlCenter?.()}>
          <span>🎧</span>
        </StatusIcon>

        <StatusIcon title="Sonido" onClick={() => onOpenControlCenter?.()}>
          <span>🔊</span>
        </StatusIcon>

        <StatusIcon
          title="Centro de control"
          onClick={() => onOpenControlCenter?.()}
        >
          <span>⚙️</span>
        </StatusIcon>

        <StatusIcon
          title="Notificaciones"
          onClick={() => onOpenNotifications?.()}
        >
          <span>🔔</span>
        </StatusIcon>

        <StatusIcon
          title="Spotlight"
          onClick={() => onOpenSpotlight?.()}
        >
          <span>🔍</span>
        </StatusIcon>

        {/* Reloj */}
        <StatusIcon title="Fecha y hora" onClick={() => onOpenNotifications?.()}>
          <Clock use24Hour={use24Hour} />
        </StatusIcon>
      </div>
    </div>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export default MenuBar;
