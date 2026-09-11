// ============================================================================
// notifications.jsx — Centro de notificaciones de macOS
// ----------------------------------------------------------------------------
// Panel lateral que baja desde la esquina superior derecha. Responsabilidades:
// - Lista de notificaciones agrupadas por app
// - Widgets (reloj, clima, calendario, recordatorios)
// - Botón de "no molestar"
// - Limpiar todas las notificaciones
// - Click en notificación → abre app / acción
// - Swipe / botón para dismiss
// - Badge de contador en el icono del menubar
// - Backend de notificaciones (registrar, actualizar, dismiss)
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
} from "../kernel/kernel.jsx";

import { useLockScreen } from "../lockscreen/lockscreen.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

const NOTIF_EVENTS = Object.freeze({
  POSTED: "notif:posted",
  DISMISSED: "notif:dismissed",
  CLEARED_ALL: "notif:cleared-all",
  CLICKED: "notif:clicked",
  GROUP_CHANGED: "notif:group-changed",
  DND_TOGGLED: "notif:dnd-toggled",
});

const OVERLAY_Z = 99999;
const ANIMATION_MS = 220;

// ============================================================================
// CONTEXTO
// ============================================================================

const NotificationsContext = createContext(null);

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx)
    throw new Error("useNotifications must be used within a NotificationsProvider");
  return ctx;
}

// ============================================================================
// BACKEND DE NOTIFICACIONES (clase pura)
// ============================================================================

let _notifId = 0;
const nextId = () => `n-${++_notifId}`;

export class NotificationCenter {
  constructor() {
    this.notifications = [];
    this.dnd = false;
    this.subscribers = new Set();
    this.onClickHandlers = new Set();
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _notify() {
    const snap = this.getState();
    for (const fn of this.subscribers) {
      try {
        fn(snap);
      } catch (err) {
        console.error("[notifications] subscriber error", err);
      }
    }
  }

  getState() {
    return {
      notifications: [...this.notifications],
      dnd: this.dnd,
      unreadCount: this.notifications.filter((n) => !n.read).length,
    };
  }

  post({
    appId = "system",
    appName = "Sistema",
    appIcon = "🔔",
    title,
    body = "",
    icon = null,
    actions = [],
    onAction = null,
    onDismiss = null,
    silent = false,
    timeoutMs = null,
  }) {
    if (!title) throw new Error("[notifications] title required");

    const notif = {
      id: nextId(),
      appId,
      appName,
      appIcon,
      title,
      body,
      icon,
      actions,
      onAction,
      onDismiss,
      silent,
      timeoutMs,
      createdAt: Date.now(),
      read: false,
    };

    if (this.dnd) {
      // no mostramos pero guardamos silenciosa
      notif.silent = true;
    }

    this.notifications = [notif, ...this.notifications].slice(0, 200);

    kernelBus.emit(NOTIF_EVENTS.POSTED, { notification: notif });
    this._notify();

    if (timeoutMs && !this.dnd) {
      setTimeout(() => this.dismiss(notif.id), timeoutMs);
    }

    return notif.id;
  }

  dismiss(id) {
    const n = this.notifications.find((x) => x.id === id);
    if (!n) return false;
    try {
      n.onDismiss?.(n);
    } catch {
      /* noop */
    }
    this.notifications = this.notifications.filter((x) => x.id !== id);
    kernelBus.emit(NOTIF_EVENTS.DISMISSED, { id });
    this._notify();
    return true;
  }

  dismissAllForApp(appId) {
    const ids = this.notifications
      .filter((n) => n.appId === appId)
      .map((n) => n.id);
    ids.forEach((id) => this.dismiss(id));
    return ids.length;
  }

  clearAll() {
    this.notifications.forEach((n) => {
      try {
        n.onDismiss?.(n);
      } catch {
        /* noop */
      }
    });
    this.notifications = [];
    kernelBus.emit(NOTIF_EVENTS.CLEARED_ALL, {});
    this._notify();
  }

  markRead(id) {
    this.notifications = this.notifications.map((n) =>
      n.id === id ? { ...n, read: true } : n
    );
    this._notify();
  }

  markAllRead() {
    this.notifications = this.notifications.map((n) => ({ ...n, read: true }));
    this._notify();
  }

  click(id) {
    const n = this.notifications.find((x) => x.id === id);
    if (!n) return;
    this.markRead(id);
    kernelBus.emit(NOTIF_EVENTS.CLICKED, { id, notification: n });
    try {
      n.onAction?.(n);
    } catch {
      /* noop */
    }
    for (const fn of this.onClickHandlers) {
      try {
        fn(n);
      } catch {
        /* noop */
      }
    }
  }

  setDnd(enabled) {
    this.dnd = !!enabled;
    kernelBus.emit(NOTIF_EVENTS.DND_TOGGLED, { enabled: this.dnd });
    this._notify();
  }

  toggleDnd() {
    this.setDnd(!this.dnd);
  }

  list() {
    return [...this.notifications];
  }

  groupByApp() {
    const groups = new Map();
    for (const n of this.notifications) {
      if (!groups.has(n.appId)) {
        groups.set(n.appId, {
          appId: n.appId,
          appName: n.appName,
          appIcon: n.appIcon,
          notifications: [],
        });
      }
      groups.get(n.appId).notifications.push(n);
    }
    return Array.from(groups.values()).sort((a, b) => {
      const la = Math.max(...a.notifications.map((x) => x.createdAt));
      const lb = Math.max(...b.notifications.map((x) => x.createdAt));
      return lb - la;
    });
  }
}

// singleton global (el centro es único en el sistema)
export const notificationCenter = new NotificationCenter();

// ============================================================================
// HELPERS
// ============================================================================

function relativeTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "ahora";
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}

// ============================================================================
// WIDGETS
// ============================================================================

function ClockWidget({ now }) {
  const time = useMemo(() => {
    try {
      return new Date(now).toLocaleTimeString("es-ES", {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }, [now]);

  const date = useMemo(() => {
    try {
      return new Date(now).toLocaleDateString("es-ES", {
        weekday: "long",
        day: "numeric",
        month: "long",
      });
    } catch {
      return "";
    }
  }, [now]);

  return (
    <div
      style={{
        padding: "14px 16px",
        background: "rgba(255,255,255,0.12)",
        borderRadius: 14,
        border: "0.5px solid rgba(255,255,255,0.15)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        color: "#fff",
        textAlign: "left",
      }}
    >
      <div
        style={{
          fontSize: 34,
          fontWeight: 300,
          letterSpacing: "-0.02em",
          lineHeight: 1.05,
        }}
      >
        {time}
      </div>
      <div
        style={{
          fontSize: 12,
          opacity: 0.7,
          marginTop: 4,
          textTransform: "capitalize",
        }}
      >
        {date}
      </div>
    </div>
  );
}

function CalendarWidget({ now }) {
  const events = useMemo(
    () => [
      { time: "10:00", title: "Reunión de equipo" },
      { time: "14:30", title: "Llamada con cliente" },
      { time: "18:00", title: "Gym" },
    ],
    []
  );

  return (
    <div
      style={{
        padding: "12px 14px",
        background: "rgba(255,255,255,0.12)",
        borderRadius: 14,
        border: "0.5px solid rgba(255,255,255,0.15)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        color: "#fff",
      }}
    >
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          opacity: 0.65,
          marginBottom: 8,
        }}
      >
        Hoy
      </div>
      {events.map((e, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            padding: "5px 0",
            fontSize: 12,
          }}
        >
          <div
            style={{
              width: 3,
              minHeight: 22,
              background: "#0a84ff",
              borderRadius: 2,
              flexShrink: 0,
            }}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ opacity: 0.75 }}>{e.time}</div>
            <div style={{ fontWeight: 500 }}>{e.title}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// TARJETA DE NOTIFICACIÓN
// ============================================================================

function NotificationCard({ notif, onDismiss, onClick }) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onClick={() => onClick?.(notif)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        padding: "12px 14px",
        background: "rgba(255,255,255,0.14)",
        borderRadius: 14,
        border: "0.5px solid rgba(255,255,255,0.16)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        color: "#fff",
        cursor: "pointer",
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        transition: "background 0.1s ease-out",
      }}
    >
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 8,
          background: "rgba(255,255,255,0.16)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 20,
          flexShrink: 0,
        }}
      >
        {notif.icon || notif.appIcon}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {notif.title}
          </span>
          <span
            style={{
              fontSize: 11,
              opacity: 0.55,
              flexShrink: 0,
            }}
          >
            {relativeTime(notif.createdAt)}
          </span>
        </div>
        {notif.body && (
          <div
            style={{
              fontSize: 12,
              opacity: 0.75,
              marginTop: 3,
              lineHeight: 1.35,
              wordBreak: "break-word",
            }}
          >
            {notif.body}
          </div>
        )}
        {notif.actions?.length > 0 && (
          <div
            style={{
              display: "flex",
              gap: 6,
              marginTop: 8,
              flexWrap: "wrap",
            }}
          >
            {notif.actions.map((a, i) => (
              <button
                key={i}
                onClick={(e) => {
                  e.stopPropagation();
                  a.onClick?.(notif);
                }}
                style={{
                  padding: "3px 10px",
                  borderRadius: 6,
                  border: "0.5px solid rgba(255,255,255,0.2)",
                  background: "rgba(255,255,255,0.12)",
                  color: "#fff",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {hovered && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDismiss?.(notif.id);
          }}
          title="Cerrar"
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            width: 18,
            height: 18,
            borderRadius: 9,
            border: "none",
            background: "rgba(255,255,255,0.3)",
            color: "#fff",
            fontSize: 11,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ============================================================================
// NOTIFICATIONS PANEL
// ============================================================================

export function Notifications({
  open: openProp,
  onClose,
  widgets = null,
  showWidgets = true,
}) {
  const lock = useLockScreen?.() ?? { locked: false };

  const [internalOpen, setInternalOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [state, setState] = useState(() => notificationCenter.getState());
  const [now, setNow] = useState(Date.now());

  const open = openProp != null ? openProp : internalOpen;

  // suscripción al centro
  useEffect(() => {
    const unsub = notificationCenter.subscribe(setState);
    return () => unsub();
  }, []);

  // reloj de widgets
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // mount/unmount
  useEffect(() => {
    if (open) setMounted(true);
    else {
      const t = setTimeout(() => setMounted(false), ANIMATION_MS);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Esc para cerrar
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const handleOpen = useCallback(() => {
    if (openProp != null) return;
    setInternalOpen(true);
  }, [openProp]);

  const handleClose = useCallback(() => {
    if (openProp != null) onClose?.();
    else setInternalOpen(false);
  }, [openProp, onClose]);

  // ------------------------------------------------------ render
  if (lock?.locked) return null;
  if (!mounted) return null;

  const groups = notificationCenter.groupByApp();
  const unread = state.unreadCount;

  return (
    <NotificationsContext.Provider
      value={{
        open,
        openPanel: handleOpen,
        closePanel: handleClose,
        center: notificationCenter,
        state,
      }}
    >
      {/* Backdrop */}
      <div
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) handleClose();
        }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: OVERLAY_Z,
          background: open ? "transparent" : "transparent",
          pointerEvents: open ? "auto" : "none",
        }}
      />

      {/* Panel */}
      <div
        className="notifications-panel"
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: 380,
          zIndex: OVERLAY_Z + 1,
          background: "rgba(30,30,30,0.55)",
          backdropFilter: "blur(40px) saturate(160%)",
          WebkitBackdropFilter: "blur(40px) saturate(160%)",
          borderLeft: "0.5px solid rgba(255,255,255,0.1)",
          boxShadow: open ? "-20px 0 60px rgba(0,0,0,0.45)" : "none",
          transform: open ? "translateX(0)" : "translateX(105%)",
          transition: `transform ${ANIMATION_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
          display: "flex",
          flexDirection: "column",
          color: "#fff",
          fontFamily:
            '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
          userSelect: "none",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: "0.5px solid rgba(255,255,255,0.08)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>
              Notificaciones
            </span>
            {unread > 0 && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  background: "#ff453a",
                  color: "#fff",
                  borderRadius: 10,
                  padding: "1px 7px",
                  minWidth: 18,
                  textAlign: "center",
                }}
              >
                {unread}
              </span>
            )}
          </div>

          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button
              onClick={() => notificationCenter.toggleDnd()}
              title={state.dnd ? "Desactivar No molestar" : "Activar No molestar"}
              style={{
                background: state.dnd
                  ? "rgba(10,132,255,0.75)"
                  : "rgba(255,255,255,0.1)",
                border: "none",
                color: "#fff",
                borderRadius: 8,
                padding: "4px 10px",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              🌙
            </button>
            {state.notifications.length > 0 && (
              <button
                onClick={() => notificationCenter.clearAll()}
                title="Limpiar todas"
                style={{
                  background: "rgba(255,255,255,0.1)",
                  border: "none",
                  color: "#fff",
                  borderRadius: 8,
                  padding: "4px 10px",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                Limpiar
              </button>
            )}
            <button
              onClick={handleClose}
              title="Cerrar"
              style={{
                background: "rgba(255,255,255,0.1)",
                border: "none",
                color: "#fff",
                borderRadius: 8,
                width: 26,
                height: 26,
                fontSize: 12,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Body scrollable */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "14px 14px 24px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {/* Widgets */}
          {showWidgets && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
                marginBottom: 4,
              }}
            >
              <ClockWidget now={now} />
              <CalendarWidget now={now} />
              {widgets}
            </div>
          )}

          {/* Empty state */}
          {state.notifications.length === 0 && (
            <div
              style={{
                padding: "40px 20px",
                textAlign: "center",
                color: "rgba(255,255,255,0.4)",
                fontSize: 13,
              }}
            >
              No hay notificaciones
            </div>
          )}

          {/* Groups */}
          {groups.map((group) => (
            <div key={group.appId} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "4px 4px 0 4px",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  opacity: 0.6,
                  fontWeight: 600,
                }}
              >
                <span>
                  {group.appIcon} {group.appName}
                </span>
                <button
                  onClick={() =>
                    notificationCenter.dismissAllForApp(group.appId)
                  }
                  style={{
                    background: "none",
                    border: "none",
                    color: "inherit",
                    cursor: "pointer",
                    fontSize: 10,
                    padding: 0,
                    textTransform: "none",
                    letterSpacing: 0,
                  }}
                >
                  cerrar todo
                </button>
              </div>
              {group.notifications.map((n) => (
                <NotificationCard
                  key={n.id}
                  notif={n}
                  onClick={(notif) => {
                    notificationCenter.click(notif.id);
                  }}
                  onDismiss={(id) => notificationCenter.dismiss(id)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </NotificationsContext.Provider>
  );
}

// ============================================================================
// HOOKS AUXILIARES
// ============================================================================

/**
 * Devuelve el contador de notificaciones sin leer y se actualiza en vivo.
 */
export function useUnreadCount() {
  const [count, setCount] = useState(
    () => notificationCenter.getState().unreadCount
  );
  useEffect(() => {
    const unsub = notificationCenter.subscribe((s) => setCount(s.unreadCount));
    return () => unsub();
  }, []);
  return count;
}

/**
 * Hook para publicar notificaciones desde componentes.
 */
export function useNotificationPublisher() {
  return useCallback(
    (opts) => notificationCenter.post(opts),
    []
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export default Notifications;
export { NOTIF_EVENTS };
