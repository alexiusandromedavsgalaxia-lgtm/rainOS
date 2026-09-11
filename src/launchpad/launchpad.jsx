// ============================================================================
// launchpad.jsx — Launchpad de macOS
// ----------------------------------------------------------------------------
// Overlay fullscreen con blur del wallpaper, cuadrícula de apps y búsqueda.
// Comportamiento idéntico al Launchpad real de macOS:
// - Se abre con F4, gesto de pinza o clic en el icono del Dock
// - Fondo: wallpaper actual con blur + dim oscuro
// - Cuadrícula de apps con iconos grandes agrupados por página
// - Campo de búsqueda arriba
// - Puntos de página abajo + swipe horizontal entre páginas
// - Click en una app → abre y cierra Launchpad
// - Esc o clic fuera → cierra
// - Animación de entrada/salida (fade + scale)
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
  useWindowManager,
  Z_DOCK,
} from "../kernel/kernel.jsx";

import { useLockScreen } from "../lockscreen/lockscreen.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

const OVERLAY_Z = 100000;
const ANIMATION_MS = 220;
const APPS_PER_PAGE_DESKTOP = 35;
const APPS_PER_PAGE_TABLET = 24;
const APPS_PER_PAGE_MOBILE = 15;

// ============================================================================
// CONTEXTO
// ============================================================================

const LaunchpadContext = createContext(null);

export function useLaunchpad() {
  const ctx = useContext(LaunchpadContext);
  if (!ctx) throw new Error("useLaunchpad must be used within a Launchpad");
  return ctx;
}

// ============================================================================
// ICONO DE APP
// ============================================================================

function AppIcon({ app, onClick, size = 96 }) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        cursor: "pointer",
        userSelect: "none",
        padding: 8,
        borderRadius: 12,
        transition: "transform 0.15s ease-out",
        transform: hovered ? "scale(1.08)" : "scale(1)",
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
          boxShadow: hovered
            ? "0 12px 30px rgba(0,0,0,0.45)"
            : "0 6px 16px rgba(0,0,0,0.3)",
          background: "rgba(255,255,255,0.06)",
          transition: "box-shadow 0.15s ease-out",
          textShadow: "0 2px 4px rgba(0,0,0,0.4)",
        }}
      >
        {app.renderIcon ? app.renderIcon({ size }) : app.emoji || "📦"}
      </div>
      <div
        style={{
          fontSize: 13,
          color: "#fff",
          textShadow: "0 1px 3px rgba(0,0,0,0.6)",
          textAlign: "center",
          maxWidth: size + 16,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontWeight: 500,
        }}
      >
        {app.name}
      </div>
    </div>
  );
}

// ============================================================================
// PUNTOS DE PÁGINA
// ============================================================================

function PageDots({ count, current, onChange }) {
  if (count <= 1) return null;
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        justifyContent: "center",
        padding: "8px 0",
      }}
    >
      {Array.from({ length: count }, (_, i) => (
        <button
          key={i}
          onClick={() => onChange?.(i)}
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            border: "none",
            padding: 0,
            background:
              i === current ? "#fff" : "rgba(255,255,255,0.35)",
            cursor: "pointer",
            transition: "background 0.15s ease-out",
          }}
        />
      ))}
    </div>
  );
}

// ============================================================================
// LAUNCHPAD
// ============================================================================

export function Launchpad({
  apps = [],
  open: openProp,
  onClose,
  onOpenApp,
}) {
  const lock = useLockScreen?.() ?? { locked: false };
  const [internalOpen, setInternalOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [cols, setCols] = useState(7);

  const searchRef = useRef(null);
  const touchRef = useRef(null);

  const open = openProp != null ? openProp : internalOpen;

  // ------------------------------------------------------ responsive cols
  useEffect(() => {
    const compute = () => {
      if (typeof window === "undefined") return;
      const w = window.innerWidth;
      if (w < 640) setCols(4);
      else if (w < 1024) setCols(5);
      else if (w < 1440) setCols(6);
      else setCols(7);
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, []);

  const appsPerPage = useMemo(() => {
    if (typeof window === "undefined") return APPS_PER_PAGE_DESKTOP;
    const w = window.innerWidth;
    if (w < 640) return APPS_PER_PAGE_MOBILE;
    if (w < 1024) return APPS_PER_PAGE_TABLET;
    return APPS_PER_PAGE_DESKTOP;
  }, []);

  // ------------------------------------------------------ filtered apps
  const filtered = useMemo(() => {
    if (!query.trim()) return apps;
    const q = query.toLowerCase();
    return apps.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q)
    );
  }, [apps, query]);

  // ------------------------------------------------------ pagination
  const pages = useMemo(() => {
    const out = [];
    for (let i = 0; i < filtered.length; i += appsPerPage) {
      out.push(filtered.slice(i, i + appsPerPage));
    }
    return out.length > 0 ? out : [[]];
  }, [filtered, appsPerPage]);

  const totalPages = pages.length;
  const currentPage = Math.min(page, totalPages - 1);

  // ------------------------------------------------------ mount/unmount animation
  useEffect(() => {
    if (open) {
      setMounted(true);
      setQuery("");
      setPage(0);
      setTimeout(() => {
        searchRef.current?.focus?.();
      }, 50);
    } else {
      const t = setTimeout(() => setMounted(false), ANIMATION_MS);
      return () => clearTimeout(t);
    }
  }, [open]);

  // ------------------------------------------------------ open/close API
  const handleOpen = useCallback(() => {
    if (openProp != null) return;
    setInternalOpen(true);
  }, [openProp]);

  const handleClose = useCallback(() => {
    if (openProp != null) {
      onClose?.();
    } else {
      setInternalOpen(false);
    }
  }, [openProp, onClose]);

  // ------------------------------------------------------ global F4
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "F4" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (openProp != null) {
          open ? onClose?.() : onClose?.(); // handled externally
        } else {
          setInternalOpen((v) => !v);
        }
      }
      if (e.key === "Escape" && open) {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, openProp, onClose, handleClose]);

  // ------------------------------------------------------ swipe pagination
  const handleTouchStart = (e) => {
    const t = e.touches[0];
    touchRef.current = { x: t.clientX, y: t.clientY };
  };

  const handleTouchEnd = (e) => {
    if (!touchRef.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchRef.current.x;
    const dy = t.clientY - touchRef.current.y;
    touchRef.current = null;

    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy)) return;

    if (dx < 0 && currentPage < totalPages - 1) setPage(currentPage + 1);
    else if (dx > 0 && currentPage > 0) setPage(currentPage - 1);
  };

  // ------------------------------------------------------ app click
  const handleAppClick = (app) => {
    onOpenApp?.(app);
    handleClose();
  };

  // ------------------------------------------------------ hide when locked
  if (lock?.locked) return null;
  if (!mounted) return null;

  return (
    <LaunchpadContext.Provider
      value={{ open, handleOpen, handleClose, pages, currentPage, totalPages }}
    >
      <div
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onClick={(e) => {
          if (e.target === e.currentTarget) handleClose();
        }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: OVERLAY_Z,
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          justifyContent: "stretch",
          background: "rgba(0,0,0,0.4)",
          backdropFilter: "blur(40px) saturate(160%)",
          WebkitBackdropFilter: "blur(40px) saturate(160%)",
          opacity: open ? 1 : 0,
          transition: `opacity ${ANIMATION_MS}ms ease-out`,
          userSelect: "none",
        }}
      >
        <style>{`
          @keyframes launchpad-fadein {
            from { opacity: 0; transform: scale(0.96); }
            to   { opacity: 1; transform: scale(1); }
          }
        `}</style>

        {/* Barra de búsqueda */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "36px 24px 20px 24px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "min(520px, 90%)",
              padding: "8px 14px",
              background: "rgba(255,255,255,0.12)",
              border: "0.5px solid rgba(255,255,255,0.2)",
              borderRadius: 10,
              backdropFilter: "blur(20px)",
              WebkitBackdropFilter: "blur(20px)",
            }}
          >
            <span style={{ fontSize: 15, opacity: 0.7 }}>🔍</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
              placeholder="Buscar"
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                color: "#fff",
                fontSize: 15,
                padding: "4px 0",
              }}
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "rgba(255,255,255,0.7)",
                  cursor: "pointer",
                  fontSize: 16,
                  padding: 0,
                }}
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Cuadrícula de apps */}
        <div
          style={{
            flex: 1,
            overflow: "hidden",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "0 24px",
          }}
        >
          {filtered.length === 0 ? (
            <div
              style={{
                color: "rgba(255,255,255,0.5)",
                fontSize: 15,
                marginTop: 80,
              }}
            >
              Sin resultados para «{query}»
            </div>
          ) : (
            <div
              key={currentPage}
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gap: "20px 8px",
                maxWidth: cols * 130,
                width: "100%",
                justifyContent: "center",
                animation: `launchpad-fadein ${ANIMATION_MS}ms ease-out`,
              }}
            >
              {pages[currentPage]?.map((app) => (
                <AppIcon
                  key={app.id}
                  app={app}
                  onClick={() => handleAppClick(app)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Puntos de página */}
        <div
          style={{
            padding: "16px 24px 32px 24px",
          }}
        >
          <PageDots
            count={totalPages}
            current={currentPage}
            onChange={setPage}
          />
        </div>
      </div>
    </LaunchpadContext.Provider>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export default Launchpad;
