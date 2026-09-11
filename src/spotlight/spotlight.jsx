// ============================================================================
// spotlight.jsx — Spotlight de macOS
// ----------------------------------------------------------------------------
// Buscador global. Comportamiento idéntico al Spotlight real:
// - Se abre con ⌘Espacio (Cmd+Space)
// - Overlay centrado en pantalla con blur
// - Campo de búsqueda con foco automático
// - Resultados agrupados por categoría (Apps, Ventanas, Acciones, Archivos...)
// - Navegación con ↑/↓ y Enter para abrir
// - Esc para cerrar
// - Búsqueda con fuzzy matching simple
// - Categorías dinámicas según el contexto (apps abiertas, ventanas activas)
// - Vista previa a la derecha (opcional)
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
} from "../kernel/kernel.jsx";

import { useLockScreen } from "../lockscreen/lockscreen.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

const OVERLAY_Z = 100001;
const ANIMATION_MS = 180;
const MAX_RESULTS_PER_CATEGORY = 6;
const MAX_TOTAL_RESULTS = 40;

// ============================================================================
// CONTEXTO
// ============================================================================

const SpotlightContext = createContext(null);

export function useSpotlight() {
  const ctx = useContext(SpotlightContext);
  if (!ctx) throw new Error("useSpotlight must be used within a Spotlight");
  return ctx;
}

// ============================================================================
// FUZZY MATCH
// ----------------------------------------------------------------------------
// Matching simple: puntúa según coincidencia de caracteres en orden.
// Devuelve { match: boolean, score: number, ranges: [[start, end], ...] }.
// ============================================================================

function fuzzyMatch(query, target) {
  if (!query) return { match: true, score: 0, ranges: [] };
  const q = query.toLowerCase();
  const t = (target || "").toLowerCase();
  if (!t) return { match: false, score: 0, ranges: [] };

  // Exact substring → máxima puntuación
  const idx = t.indexOf(q);
  if (idx >= 0) {
    return {
      match: true,
      score: 1000 - idx * 5 + (q.length / t.length) * 100,
      ranges: [[idx, idx + q.length]],
    };
  }

  // Subsequence match
  let qi = 0;
  let score = 0;
  const ranges = [];
  let start = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (start === -1) start = ti;
      qi++;
      score += 10;
      // Bonus por caracteres consecutivos
      if (ti > 0 && t[ti - 1] === q[qi - 2]) score += 5;
    } else if (start !== -1) {
      ranges.push([start, ti]);
      start = -1;
    }
  }

  if (qi < q.length) return { match: false, score: 0, ranges: [] };
  if (start !== -1) ranges.push([start, t.length]);

  // Bonus por empezar con la query
  if (t.startsWith(q[0])) score += 30;

  return { match: true, score, ranges };
}

// ============================================================================
// RENDERIZADO DEL TEXTO MATCHED
// ============================================================================

function HighlightedText({ text, ranges }) {
  if (!ranges || ranges.length === 0) return <>{text}</>;

  const parts = [];
  let cursor = 0;

  const sortedRanges = [...ranges].sort((a, b) => a[0] - b[0]);

  for (const [start, end] of sortedRanges) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <strong key={`${start}-${end}`} style={{ fontWeight: 700 }}>
        {text.slice(start, end)}
      </strong>
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));

  return <>{parts}</>;
}

// ============================================================================
// FILA DE RESULTADO
// ============================================================================

function ResultRow({
  item,
  selected,
  onSelect,
  onClick,
}) {
  return (
    <div
      onClick={onClick}
      onMouseEnter={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "7px 12px",
        borderRadius: 6,
        cursor: "pointer",
        background: selected ? "rgba(10,132,255,0.85)" : "transparent",
        color: "#fff",
        transition: "background 0.05s ease-out",
      }}
    >
      <div
        style={{
          width: 24,
          height: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 18,
          flexShrink: 0,
        }}
      >
        {item.icon || "•"}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          <HighlightedText text={item.label} ranges={item.ranges} />
        </div>
        {item.subtitle && (
          <div
            style={{
              fontSize: 11,
              opacity: 0.65,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              marginTop: 1,
            }}
          >
            {item.subtitle}
          </div>
        )}
      </div>
      {item.hint && (
        <div
          style={{
            fontSize: 11,
            opacity: 0.55,
            fontFamily:
              '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
          }}
        >
          {item.hint}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// SPOTLIGHT
// ============================================================================

export function Spotlight({
  apps = [],
  actions = [],
  extraSources = [],
  open: openProp,
  onClose,
  onOpenApp,
  onRunAction,
  placeholder = "Búsqueda en Spotlight",
}) {
  const wm = useWindowManager();
  const lock = useLockScreen?.() ?? { locked: false };

  const [internalOpen, setInternalOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef(null);
  const listRef = useRef(null);

  const open = openProp != null ? openProp : internalOpen;

  // ------------------------------------------------------ sources de resultados
  const searchableItems = useMemo(() => {
    const items = [];

    // Apps del sistema
    for (const app of apps) {
      items.push({
        id: `app:${app.id}`,
        category: "Aplicaciones",
        label: app.name,
        subtitle: "Aplicación",
        icon: app.emoji || "📦",
        keywords: [app.id, app.name],
        kind: "app",
        app,
      });
    }

    // Ventanas abiertas
    for (const w of wm.windows) {
      if (w.state === "minimized") continue;
      items.push({
        id: `window:${w.id}`,
        category: "Ventanas",
        label: w.title,
        subtitle: `Ventana #${w.id} · ${w.appId}`,
        icon: "🪟",
        keywords: [w.title, w.appId],
        kind: "window",
        window: w,
      });
    }

    // Acciones del sistema
    for (const action of actions) {
      items.push({
        id: `action:${action.id}`,
        category: "Acciones",
        label: action.label,
        subtitle: action.subtitle || "Acción del sistema",
        icon: action.icon || "⚡",
        keywords: [action.id, action.label],
        kind: "action",
        action,
      });
    }

    // Fuentes extra (archivos, contactos, etc.)
    for (const source of extraSources) {
      try {
        const extra = source.items || [];
        for (const item of extra) {
          items.push({
            id: `${source.id}:${item.id}`,
            category: source.name || "Otros",
            label: item.label,
            subtitle: item.subtitle,
            icon: item.icon || "•",
            keywords: [item.label, ...(item.keywords || [])],
            kind: "extra",
            raw: item,
            sourceId: source.id,
          });
        }
      } catch {
        /* noop */
      }
    }

    return items;
  }, [apps, wm.windows, actions, extraSources]);

  // ------------------------------------------------------ filtered + grouped
  const grouped = useMemo(() => {
    const q = query.trim();
    const scored = [];

    for (const item of searchableItems) {
      const targets = [item.label, ...(item.keywords || [])];
      let best = { match: false, score: 0, ranges: [] };
      for (const target of targets) {
        const m = fuzzyMatch(q, target);
        if (m.match && m.score > best.score) {
          best = { ...m, ranges: target === item.label ? m.ranges : [] };
        }
      }
      if (best.match) {
        scored.push({ ...item, score: best.score, ranges: best.ranges });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    const byCategory = new Map();
    for (const item of scored) {
      if (!byCategory.has(item.category)) byCategory.set(item.category, []);
      const list = byCategory.get(item.category);
      if (list.length < MAX_RESULTS_PER_CATEGORY) list.push(item);
    }

    const out = [];
    let total = 0;
    for (const [category, items] of byCategory.entries()) {
      out.push({ category, items });
      total += items.length;
      if (total >= MAX_TOTAL_RESULTS) break;
    }
    return out;
  }, [searchableItems, query]);

  // Flat list for keyboard navigation
  const flatResults = useMemo(
    () => grouped.flatMap((g) => g.items),
    [grouped]
  );

  // ------------------------------------------------------ lifecycle
  useEffect(() => {
    if (open) {
      setMounted(true);
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus?.(), 30);
    } else {
      const t = setTimeout(() => setMounted(false), ANIMATION_MS);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // ------------------------------------------------------ global ⌘Space
  useEffect(() => {
    const onKey = (e) => {
      const isCmd = e.metaKey || e.ctrlKey;
      if (isCmd && e.key === " ") {
        e.preventDefault();
        if (openProp != null) {
          // Controlado externamente
          if (!open) onClose?.();
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
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) =>
          Math.min(flatResults.length - 1, i + 1)
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = flatResults[selectedIndex];
        if (item) handleSelect(item);
        return;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, flatResults, selectedIndex]);

  // ------------------------------------------------------ scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(
      `[data-spotlight-index="${selectedIndex}"]`
    );
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // ------------------------------------------------------ helpers
  const handleOpen = useCallback(() => {
    if (openProp != null) return;
    setInternalOpen(true);
  }, [openProp]);

  const handleClose = useCallback(() => {
    if (openProp != null) onClose?.();
    else setInternalOpen(false);
  }, [openProp, onClose]);

  const handleSelect = useCallback(
    (item) => {
      if (item.kind === "app") {
        onOpenApp?.(item.app);
      } else if (item.kind === "window") {
        wm.focus(item.window.id);
      } else if (item.kind === "action") {
        item.action?.action?.();
        onRunAction?.(item.action);
      } else if (item.kind === "extra") {
        // delegate to source handler if provided
        const src = extraSources.find((s) => s.id === item.sourceId);
        src?.onSelect?.(item.raw);
      }
      handleClose();
    },
    [wm, onOpenApp, onRunAction, extraSources, handleClose]
  );

  // ------------------------------------------------------ hide when locked
  if (lock?.locked) return null;
  if (!mounted) return null;

  const hasQuery = query.trim().length > 0;
  const isEmpty = flatResults.length === 0;

  return (
    <SpotlightContext.Provider value={{ open, handleOpen, handleClose }}>
      <div
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) handleClose();
        }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: OVERLAY_Z,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          paddingTop: "14vh",
          background: "rgba(0,0,0,0.18)",
          opacity: open ? 1 : 0,
          transition: `opacity ${ANIMATION_MS}ms ease-out`,
        }}
      >
        <style>{`
          @keyframes spotlight-in {
            from { opacity: 0; transform: translateY(-8px) scale(0.98); }
            to   { opacity: 1; transform: translateY(0) scale(1); }
          }
        `}</style>

        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            width: "min(720px, 92vw)",
            maxHeight: "70vh",
            display: "flex",
            flexDirection: "column",
            background: "rgba(30,30,30,0.85)",
            backdropFilter: "blur(40px) saturate(180%)",
            WebkitBackdropFilter: "blur(40px) saturate(180%)",
            borderRadius: 14,
            border: "0.5px solid rgba(255,255,255,0.15)",
            boxShadow:
              "0 30px 80px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06)",
            overflow: "hidden",
            animation: `spotlight-in ${ANIMATION_MS}ms ease-out`,
            color: "#fff",
          }}
        >
          {/* Search input */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "14px 18px",
              borderBottom:
                hasQuery && flatResults.length > 0
                  ? "0.5px solid rgba(255,255,255,0.1)"
                  : "none",
            }}
          >
            <span style={{ fontSize: 20, opacity: 0.7 }}>🔍</span>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              spellCheck={false}
              autoComplete="off"
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                color: "#fff",
                fontSize: 22,
                fontWeight: 300,
                padding: "2px 0",
                letterSpacing: "0.01em",
              }}
            />
            {hasQuery && (
              <button
                onClick={() => setQuery("")}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "rgba(255,255,255,0.55)",
                  fontSize: 18,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                ✕
              </button>
            )}
          </div>

          {/* Results */}
          {hasQuery && (
            <div
              ref={listRef}
              style={{
                flex: 1,
                overflowY: "auto",
                padding: flatResults.length > 0 ? "6px 6px 10px 6px" : 0,
              }}
            >
              {isEmpty ? (
                <div
                  style={{
                    padding: "28px 20px",
                    textAlign: "center",
                    color: "rgba(255,255,255,0.5)",
                    fontSize: 13,
                  }}
                >
                  Sin resultados para «{query}»
                </div>
              ) : (
                grouped.map((group) => (
                  <div key={group.category} style={{ marginBottom: 6 }}>
                    <div
                      style={{
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                        opacity: 0.5,
                        padding: "8px 12px 4px 12px",
                        fontWeight: 600,
                      }}
                    >
                      {group.category}
                    </div>
                    {group.items.map((item) => {
                      const idx = flatResults.indexOf(item);
                      return (
                        <div
                          key={item.id}
                          data-spotlight-index={idx}
                        >
                          <ResultRow
                            item={item}
                            selected={idx === selectedIndex}
                            onSelect={() => setSelectedIndex(idx)}
                            onClick={() => handleSelect(item)}
                          />
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          )}

          {/* Hint bar */}
          {!hasQuery && (
            <div
              style={{
                padding: "12px 18px 14px 18px",
                fontSize: 11,
                color: "rgba(255,255,255,0.4)",
                display: "flex",
                gap: 14,
                flexWrap: "wrap",
              }}
            >
              <span>
                <kbd style={kbdStyle}>↑</kbd>{" "}
                <kbd style={kbdStyle}>↓</kbd> navegar
              </span>
              <span>
                <kbd style={kbdStyle}>↵</kbd> abrir
              </span>
              <span>
                <kbd style={kbdStyle}>Esc</kbd> cerrar
              </span>
            </div>
          )}

          {hasQuery && flatResults.length > 0 && (
            <div
              style={{
                padding: "8px 18px",
                borderTop: "0.5px solid rgba(255,255,255,0.08)",
                fontSize: 11,
                color: "rgba(255,255,255,0.4)",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>
                {flatResults.length} resultado
                {flatResults.length === 1 ? "" : "s"}
              </span>
              <span>
                <kbd style={kbdStyle}>↵</kbd> abrir ·{" "}
                <kbd style={kbdStyle}>Esc</kbd> cerrar
              </span>
            </div>
          )}
        </div>
      </div>
    </SpotlightContext.Provider>
  );
}

const kbdStyle = {
  display: "inline-block",
  padding: "1px 5px",
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

export default Spotlight;
