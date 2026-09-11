// ============================================================================
// toast.jsx — Notificaciones flotantes (toasts)
// ----------------------------------------------------------------------------
// Banners que aparecen arriba a la derecha, se apilan verticalmente y
// desaparecen solos. Comportamiento idéntico al banner de notificación
// de macOS (una notificación que llega cuando la app está en primer plano
// o el sistema quiere avisar de algo):
// - Se apilan en la esquina superior derecha
// - Se auto-cierran tras N ms (configurable)
// - Se pueden cerrar manualmente con ✕
// - Se pueden pausar al hacer hover
// - Animación de entrada (slide desde la derecha) y salida (fade)
// - Tipos: info, success, warning, error
// - Pueden tener icono, título, cuerpo y acciones
// - API imperativa (toast.info, toast.success, ...) + provider
// - Se ocultan cuando el lockscreen está activo
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

import { useLockScreen } from "../lockscreen/lockscreen.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

const TOAST_Z = 100005;
const ANIMATION_MS = 260;
const DEFAULT_DURATION = 4000;
const MAX_VISIBLE = 4;

// ============================================================================
// BACKEND DE TOASTS
// ============================================================================

let _toastId = 0;
const nextId = () => `t-${++_toastId}`;

export class ToastCenter {
  constructor() {
    this.toasts = [];
    this.subscribers = new Set();
    this.handlers = new Map(); // para cancelar timeouts
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _notify() {
    const snap = this.list();
    for (const fn of this.subscribers) {
      try {
        fn(snap);
      } catch (err) {
        console.error("[toast] subscriber error", err);
      }
    }
  }

  push(opts) {
    const toast = {
      id: nextId(),
      type: "info",
      title: "",
      body: "",
      icon: null,
      actions: [],
      duration: DEFAULT_DURATION,
      createdAt: Date.now(),
      paused: false,
      remaining: null,
      onAction: null,
      onDismiss: null,
      dismissible: true,
      ...opts,
    };

    if (toast.duration == null) toast.duration = 0;
    toast.remaining = toast.duration;

    this.toasts = [...this.toasts, toast];

    // Si excede el máximo visible, quitamos el más antiguo
    if (this.toasts.length > MAX_VISIBLE) {
      const overflow = this.toasts.slice(0, this.toasts.length - MAX_VISIBLE);
      overflow.forEach((t) => this.dismiss(t.id, { silent: true }));
    }

    if (toast.duration > 0) {
      this._scheduleAutoDismiss(toast.id, toast.duration);
    }

    this._notify();
    return toast.id;
  }

  _scheduleAutoDismiss(id, ms) {
    const existing = this.handlers.get(id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.dismiss(id);
    }, ms);
    this.handlers.set(id, t);
  }

  dismiss(id, { silent = false } = {}) {
    const toast = this.toasts.find((t) => t.id === id);
    if (!toast) return false;

    if (!silent) {
      try {
        toast.onDismiss?.(toast);
      } catch {
        /* noop */
      }
    }

    const handle = this.handlers.get(id);
    if (handle) {
      clearTimeout(handle);
      this.handlers.delete(id);
    }

    this.toasts = this.toasts.filter((t) => t.id !== id);
    this._notify();
    return true;
  }

  dismissAll() {
    const ids = this.toasts.map((t) => t.id);
    ids.forEach((id) => this.dismiss(id, { silent: true }));
    return ids.length;
  }

  click(id) {
    const toast = this.toasts.find((t) => t.id === id);
    if (!toast) return;
    try {
      toast.onAction?.(toast);
    } catch {
      /* noop */
    }
    this.dismiss(id, { silent: true });
  }

  pause(id) {
    const toast = this.toasts.find((t) => t.id === id);
    if (!toast || toast.paused) return;
    const handle = this.handlers.get(id);
    if (handle) {
      clearTimeout(handle);
      this.handlers.delete(id);
    }
    // Aproximamos lo que queda
    const elapsed = Date.now() - toast.createdAt;
    toast.remaining = Math.max(200, toast.remaining - elapsed);
    toast.paused = true;
    this._notify();
  }

  resume(id) {
    const toast = this.toasts.find((t) => t.id === id);
    if (!toast || !toast.paused) return;
    toast.paused = false;
    toast.createdAt = Date.now();
    if (toast.remaining > 0) {
      this._scheduleAutoDismiss(id, toast.remaining);
    }
    this._notify();
  }

  list() {
    return [...this.toasts];
  }

  // ------------------------------------------------------------- shortcuts
  info(title, body, opts = {}) {
    return this.push({ type: "info", title, body, ...opts });
  }
  success(title, body, opts = {}) {
    return this.push({ type: "success", title, body, ...opts });
  }
  warning(title, body, opts = {}) {
    return this.push({ type: "warning", title, body, ...opts });
  }
  error(title, body, opts = {}) {
    return this.push({ type: "error", title, body, ...opts });
  }
}

// singleton
export const toastCenter = new ToastCenter();

// API imperativa
export const toast = {
  info: (t, b, o) => toastCenter.info(t, b, o),
  success: (t, b, o) => toastCenter.success(t, b, o),
  warning: (t, b, o) => toastCenter.warning(t, b, o),
  error: (t, b, o) => toastCenter.error(t, b, o),
  push: (o) => toastCenter.push(o),
  dismiss: (id) => toastCenter.dismiss(id),
  dismissAll: () => toastCenter.dismissAll(),
  list: () => toastCenter.list(),
  center: toastCenter,
};

// ============================================================================
// COLORES POR TIPO
// ============================================================================

const TYPE_STYLES = {
  info: {
    accent: "#0a84ff",
    icon: "ℹ️",
    bg: "rgba(30,30,30,0.82)",
  },
  success: {
    accent: "#32d74b",
    icon: "✅",
    bg: "rgba(20,40,25,0.85)",
  },
  warning: {
    accent: "#ff9f0a",
    icon: "⚠️",
    bg: "rgba(45,35,15,0.85)",
  },
  error: {
    accent: "#ff453a",
    icon: "⛔",
    bg: "rgba(45,20,20,0.85)",
  },
};

// ============================================================================
// TOAST INDIVIDUAL
// ============================================================================

function ToastItem({ toast: t, onDismiss, onClick, onPause, onResume }) {
  const style = TYPE_STYLES[t.type] || TYPE_STYLES.info;
  const [exiting, setExiting] = useState(false);
  const [entered, setEntered] = useState(false);

  // Animación de entrada
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const handleDismiss = () => {
    setExiting(true);
    setTimeout(() => onDismiss?.(t.id), ANIMATION_MS * 0.6);
  };

  const visible = entered && !exiting;

  return (
    <div
      onMouseEnter={() => onPause?.(t.id)}
      onMouseLeave={() => onResume?.(t.id)}
      onClick={() => onClick?.(t.id)}
      style={{
        width: 340,
        padding: "12px 14px",
        background: style.bg,
        backdropFilter: "blur(40px) saturate(180%)",
        WebkitBackdropFilter: "blur(40px) saturate(180%)",
        border: "0.5px solid rgba(255,255,255,0.14)",
        borderRadius: 14,
        boxShadow: "0 20px 50px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)",
        color: "#fff",
        fontFamily:
          '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
        cursor: "pointer",
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        position: "relative",
        overflow: "hidden",
        opacity: visible ? 1 : 0,
        transform: visible
          ? "translateX(0) scale(1)"
          : "translateX(24px) scale(0.98)",
        transition: `opacity ${ANIMATION_MS}ms ease-out, transform ${ANIMATION_MS}ms ease-out`,
      }}
    >
      {/* Barra de acento lateral */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background: style.accent,
        }}
      />

      {/* Icono */}
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: "rgba(255,255,255,0.1)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 18,
          flexShrink: 0,
          marginLeft: 4,
        }}
      >
        {t.icon || style.icon}
      </div>

      {/* Contenido */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {t.title && (
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 2,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {t.title}
          </div>
        )}
        {t.body && (
          <div
            style={{
              fontSize: 12,
              opacity: 0.78,
              lineHeight: 1.4,
              wordBreak: "break-word",
            }}
          >
            {t.body}
          </div>
        )}
        {t.actions?.length > 0 && (
          <div
            style={{
              display: "flex",
              gap: 6,
              marginTop: 8,
              flexWrap: "wrap",
            }}
          >
            {t.actions.map((a, i) => (
              <button
                key={i}
                onClick={(e) => {
                  e.stopPropagation();
                  a.onClick?.(t);
                  onDismiss?.(t.id);
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

      {/* Cerrar */}
      {t.dismissible !== false && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleDismiss();
          }}
          title="Cerrar"
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            border: "none",
            background: "rgba(255,255,255,0.15)",
            color: "#fff",
            fontSize: 11,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            flexShrink: 0,
          }}
        >
          ✕
        </button>
      )}

      {/* Barra de progreso (si tiene duración) */}
      {t.duration > 0 && !t.paused && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: 2,
            background: "rgba(255,255,255,0.08)",
          }}
        >
          <div
            style={{
              height: "100%",
              background: style.accent,
              opacity: 0.7,
              animation: `toast-progress ${t.duration}ms linear`,
              transformOrigin: "left",
            }}
          />
        </div>
      )}
    </div>
  );
}

// ============================================================================
// CONTENEDOR DE TOASTS
// ============================================================================

export function ToastContainer({
  position = "top-right",
  offsetTop = 40,
  offsetRight = 12,
}) {
  const lock = useLockScreen?.() ?? { locked: false };
  const [toasts, setToasts] = useState(() => toastCenter.list());

  useEffect(() => {
    const unsub = toastCenter.subscribe(setToasts);
    return () => unsub();
  }, []);

  if (lock?.locked) return null;
  if (toasts.length === 0) return null;

  const posStyles = {
    "top-right": {
      top: offsetTop,
      right: offsetRight,
      alignItems: "flex-end",
    },
    "top-left": {
      top: offsetTop,
      left: offsetRight,
      alignItems: "flex-start",
    },
    "top-center": {
      top: offsetTop,
      left: "50%",
      transform: "translateX(-50%)",
      alignItems: "center",
    },
    "bottom-right": {
      bottom: offsetTop,
      right: offsetRight,
      alignItems: "flex-end",
    },
    "bottom-left": {
      bottom: offsetTop,
      left: offsetRight,
      alignItems: "flex-start",
    },
    "bottom-center": {
      bottom: offsetTop,
      left: "50%",
      transform: "translateX(-50%)",
      alignItems: "center",
    },
  }[position];

  return (
    <div
      className="toast-container"
      style={{
        position: "fixed",
        zIndex: TOAST_Z,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        pointerEvents: "none",
        ...posStyles,
      }}
    >
      <style>{`
        @keyframes toast-progress {
          from { transform: scaleX(1); }
          to   { transform: scaleX(0); }
        }
      `}</style>

      {toasts.map((t) => (
        <div key={t.id} style={{ pointerEvents: "auto" }}>
          <ToastItem
            toast={t}
            onDismiss={(id) => toastCenter.dismiss(id)}
            onClick={(id) => toastCenter.click(id)}
            onPause={(id) => toastCenter.pause(id)}
            onResume={(id) => toastCenter.resume(id)}
          />
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// CONTEXTO / HOOKS
// ============================================================================

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const api = useMemo(
    () => ({
      toast,
      center: toastCenter,
      info: (t, b, o) => toastCenter.info(t, b, o),
      success: (t, b, o) => toastCenter.success(t, b, o),
      warning: (t, b, o) => toastCenter.warning(t, b, o),
      error: (t, b, o) => toastCenter.error(t, b, o),
      push: (o) => toastCenter.push(o),
      dismiss: (id) => toastCenter.dismiss(id),
      dismissAll: () => toastCenter.dismissAll(),
      list: () => toastCenter.list(),
    }),
    []
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastContainer />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx)
    throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  ToastCenter,
  toastCenter,
  toast,
  ToastContainer,
  ToastProvider,
  useToast,
};
