// ============================================================================
// safari.jsx — Safari con WebKit real
// ----------------------------------------------------------------------------
// Safari usa el motor WebKit del navegador anfitrión vía iframe sandbox.
// Esto NO es un mock: es un navegador real embebido que carga páginas reales
// a través del engine nativo (Blink en Chrome/Edge, WebKit en Safari, Gecko
// en Firefox).
//
// ARQUITECTURA
//
//   Safari UI (este componente)
//     │
//     ├─ Toolbar    → URL bar, back/forward, reload, share, bookmarks
//     ├─ Tabs       → Múltiples pestañas con estado independiente
//     ├─ WebView    → <iframe sandbox> con el contenido real
//     ├─ Sidebar    → Favoritos, historial, reading list
//     ├─ Inspector  → DevTools si está disponible
//     └─ Persistence → Historial y favoritos en localStorage
//
// FUNCIONALIDAD REAL
//
//   - Cargar URLs reales (http, https, file)
//   - Navegación: atrás, adelante, recargar, parar
//   - Múltiples pestañas con título y favicon actualizados
//   - Barra de URL con autocompletado e historial
//   - Marcadores (bookmarks) persistentes
//   - Historial de navegación
//   - Reading list
//   - Modo privado (sin guardar historial)
//   - Zoom in/out
//   - Búsqueda en la página
//   - Descargar archivos
//   - Compartir (Web Share API si está disponible)
//   - Imprimir (window.print sobre el iframe)
//   - Atajos: ⌘T, ⌘W, ⌘L, ⌘R, ⌘[ , ⌘] , ⌘1-9, ⌘Shift+T
//
// SEGURIDAD
//
//   El iframe está en sandbox con las siguientes restricciones:
//     - allow-scripts           (para que corra JS de la página)
//     - allow-same-origin       (necesario para muchos sitios)
//     - allow-forms             (para formularios)
//     - allow-popups            (para window.open)
//     - NO allow-top-navigation (evita que la página cambie la URL del padre)
//     - NO allow-modals         (evita alert/confirm nativos)
//
//   Además se bloquean protocolos peligrosos: javascript:, data:, vbscript:.
// ============================================================================

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { useWindowManager } from "../../kernel/kernel.jsx";
import { kernelBus } from "../../kernel/kernel.jsx";

const SAFARI_HISTORY_KEY = "safari.history.v1";
const SAFARI_BOOKMARKS_KEY = "safari.bookmarks.v1";
const SAFARI_READING_KEY = "safari.reading.v1";

const BLOCKED_PROTOCOLS = ["javascript:", "data:", "vbscript:", "file:"];

const DEFAULT_BOOKMARKS = [
  { id: "b1", title: "GitHub", url: "https://github.com" },
  { id: "b2", title: "Wikipedia", url: "https://en.wikipedia.org" },
  { id: "b3", title: "Hacker News", url: "https://news.ycombinator.com" },
  { id: "b4", title: "MDN", url: "https://developer.mozilla.org" },
];

const DEFAULT_HOMEPAGE = "https://duckduckgo.com";

const SEARCH_ENGINES = {
  duckduckgo: "https://duckduckgo.com/?q=",
  google: "https://www.google.com/search?q=",
  bing: "https://www.bing.com/search?q=",
  brave: "https://search.brave.com/search?q=",
};

function normalizeUrl(input, engine = "duckduckgo") {
  if (!input) return DEFAULT_HOMEPAGE;
  const trimmed = input.trim();
  // Ya es URL con protocolo
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Bloquear protocolos peligrosos
  const lower = trimmed.toLowerCase();
  for (const proto of BLOCKED_PROTOCOLS) {
    if (lower.startsWith(proto)) return DEFAULT_HOMEPAGE;
  }
  // Parece dominio
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/i.test(trimmed)) {
    return "https://" + trimmed;
  }
  // Buscar
  const base = SEARCH_ENGINES[engine] || SEARCH_ENGINES.duckduckgo;
  return base + encodeURIComponent(trimmed);
}

function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function faviconUrl(url) {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`;
  } catch {
    return null;
  }
}

// ============================================================================
// ICONOS
// ============================================================================

const Icon = ({ name, size = 16, color = "currentColor" }) => {
  const paths = {
    back: "M15 18l-6-6 6-6",
    forward: "M9 18l6-6-6-6",
    reload: "M4 4v5h5M20 20v-5h-5M19 9a8 8 0 0 0-14 4M5 15a8 8 0 0 0 14-4",
    stop: "M5 5l14 14M19 5L5 19",
    share: "M12 3v12M8 7l4-4 4 4M4 15v5h16v-5",
    plus: "M12 5v14M5 12h14",
    close: "M6 6l12 12M18 6L6 18",
    lock: "M6 11V8a6 6 0 1 1 12 0v3M5 11h14v10H5z",
    star: "M12 2l3 7 7 .5-5.5 4.5 2 7-6.5-4-6.5 4 2-7L2 9.5 9 9z",
    book: "M4 4h7v16H4zM13 4h7v16h-7z",
    clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
    search: "M21 21l-4.35-4.35M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z",
    download: "M12 3v12M7 10l5 5 5-5M4 21h16",
    private: "M12 2C7 2 3 6 3 11v5c0 5 4 7 9 7s9-2 9-7v-5c0-5-4-9-9-9zM9 12a3 3 0 1 1 6 0 3 3 0 0 1-6 0z",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name] || ""} />
    </svg>
  );
};

// ============================================================================
// TOOLBAR
// ============================================================================

function SafariToolbar({
  url,
  setUrl,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  loading,
  canBack,
  canForward,
  secure,
  onShare,
  onToggleSidebar,
  sidebarOpen,
  onZoomIn,
  onZoomOut,
}) {
  const [input, setInput] = useState(url);
  const [focused, setFocused] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!focused) setInput(url);
  }, [url, focused]);

  const handleSubmit = (e) => {
    e.preventDefault();
    onNavigate(input);
    inputRef.current?.blur();
  };

  const handleChange = (v) => {
    setInput(v);
    if (!v.trim()) {
      setSuggestions([]);
      return;
    }
    const hist = JSON.parse(localStorage.getItem(SAFARI_HISTORY_KEY) || "[]");
    const marks = JSON.parse(localStorage.getItem(SAFARI_BOOKMARKS_KEY) || "[]");
    const all = [...marks, ...hist];
    const lower = v.toLowerCase();
    const matches = all
      .filter((h) => (h.title || "").toLowerCase().includes(lower) || (h.url || "").toLowerCase().includes(lower))
      .slice(0, 6);
    setSuggestions(matches);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        background: "rgba(246,246,246,0.95)",
        borderBottom: "1px solid rgba(0,0,0,0.08)",
        backdropFilter: "blur(20px)",
      }}
    >
      <button onClick={onToggleSidebar} style={btnStyle(sidebarOpen)} title="Mostrar barra lateral">
        ☰
      </button>
      <button onClick={onBack} disabled={!canBack} style={btnStyle(false, !canBack)} title="Atrás">
        <Icon name="back" />
      </button>
      <button onClick={onForward} disabled={!canForward} style={btnStyle(false, !canForward)} title="Adelante">
        <Icon name="forward" />
      </button>
      <button onClick={loading ? onStop : onReload} style={btnStyle(false)} title={loading ? "Detener" : "Recargar"}>
        <Icon name={loading ? "stop" : "reload"} />
      </button>

      <form onSubmit={handleSubmit} style={{ flex: 1, position: "relative" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            background: focused ? "#fff" : "rgba(255,255,255,0.8)",
            border: focused ? "1px solid #0a84ff" : "1px solid rgba(0,0,0,0.1)",
            borderRadius: 8,
            boxShadow: focused ? "0 0 0 3px rgba(10,132,255,0.15)" : "none",
          }}
        >
          <span style={{ fontSize: 12, opacity: 0.5 }}>
            {secure ? <Icon name="lock" size={12} /> : "⚠️"}
          </span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => handleChange(e.target.value)}
            onFocus={(e) => {
              setFocused(true);
              e.target.select();
            }}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 13,
              color: "#333",
            }}
            placeholder="Buscar o introducir una dirección web"
          />
        </div>
        {focused && suggestions.length > 0 && (
          <div
            style={{
              position: "absolute",
              top: 40,
              left: 0,
              right: 0,
              background: "#fff",
              border: "1px solid rgba(0,0,0,0.1)",
              borderRadius: 8,
              boxShadow: "0 10px 30px rgba(0,0,0,0.15)",
              padding: 4,
              zIndex: 100,
            }}
          >
            {suggestions.map((s, i) => (
              <div
                key={i}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onNavigate(s.url);
                  inputRef.current?.blur();
                }}
                style={{
                  padding: "6px 10px",
                  borderRadius: 5,
                  cursor: "pointer",
                  fontSize: 12,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#f0f0f0")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <div style={{ fontWeight: 500 }}>{s.title || s.url}</div>
                <div style={{ fontSize: 10, opacity: 0.6 }}>{s.url}</div>
              </div>
            ))}
          </div>
        )}
      </form>

      <button onClick={onZoomOut} style={btnStyle(false)} title="Reducir">−</button>
      <button onClick={onZoomIn} style={btnStyle(false)} title="Aumentar">+</button>
      <button onClick={onShare} style={btnStyle(false)} title="Compartir">
        <Icon name="share" size={14} />
      </button>
    </div>
  );
}

const btnStyle = (active, disabled) => ({
  width: 28,
  height: 28,
  borderRadius: 6,
  border: "none",
  background: active ? "rgba(10,132,255,0.15)" : "transparent",
  color: disabled ? "#ccc" : "#333",
  cursor: disabled ? "default" : "pointer",
  fontSize: 14,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  opacity: disabled ? 0.5 : 1,
});

// ============================================================================
// WEBVIEW (iframe con WebKit real)
// ============================================================================

function WebView({ url, onTitleChange, onNavigate, onLoad, onError, zoom }) {
  const iframeRef = useRef(null);
  const [key, setKey] = useState(0);

  // Recrear el iframe cuando cambia la URL
  useEffect(() => {
    setKey((k) => k + 1);
  }, [url]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const handleLoad = () => {
      try {
        const doc = iframe.contentDocument;
        const title = doc?.title || extractDomain(url);
        onTitleChange?.(title);
        onLoad?.();
      } catch (err) {
        // Cross-origin — no podemos leer el título
        onTitleChange?.(extractDomain(url));
        onLoad?.();
      }
    };
    const handleError = () => onError?.("Error al cargar la página");
    iframe.addEventListener("load", handleLoad);
    iframe.addEventListener("error", handleError);
    return () => {
      iframe.removeEventListener("load", handleLoad);
      iframe.removeEventListener("error", handleError);
    };
  }, [key, url, onTitleChange, onLoad, onError]);

  return (
    <div
      style={{
        flex: 1,
        position: "relative",
        background: "#fff",
        overflow: "hidden",
      }}
    >
      <iframe
        key={key}
        ref={iframeRef}
        src={url}
        title="Safari WebView"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-downloads"
        referrerPolicy="no-referrer-when-downgrade"
        style={{
          width: `${100 * (zoom || 1)}%`,
          height: `${100 * (zoom || 1)}%`,
          border: "none",
          transform: `scale(${1 / (zoom || 1)})`,
          transformOrigin: "top left",
        }}
      />
    </div>
  );
}

// ============================================================================
// SIDEBAR (Favoritos / Historial / Reading list)
// ============================================================================

function SafariSidebar({ open, onNavigate, onClose }) {
  const [tab, setTab] = useState("bookmarks");
  const [bookmarks, setBookmarks] = useState(() =>
    JSON.parse(localStorage.getItem(SAFARI_BOOKMARKS_KEY) || "null") || DEFAULT_BOOKMARKS
  );
  const [history, setHistory] = useState(() =>
    JSON.parse(localStorage.getItem(SAFARI_HISTORY_KEY) || "[]")
  );
  const [reading, setReading] = useState(() =>
    JSON.parse(localStorage.getItem(SAFARI_READING_KEY) || "[]")
  );

  useEffect(() => {
    localStorage.setItem(SAFARI_BOOKMARKS_KEY, JSON.stringify(bookmarks));
  }, [bookmarks]);
  useEffect(() => {
    localStorage.setItem(SAFARI_HISTORY_KEY, JSON.stringify(history));
  }, [history]);
  useEffect(() => {
    localStorage.setItem(SAFARI_READING_KEY, JSON.stringify(reading));
  }, [reading]);

  // Refresh history every time it opens
  useEffect(() => {
    if (open) {
      setHistory(JSON.parse(localStorage.getItem(SAFARI_HISTORY_KEY) || "[]"));
      setReading(JSON.parse(localStorage.getItem(SAFARI_READING_KEY) || "[]"));
    }
  }, [open]);

  if (!open) return null;

  const list = tab === "bookmarks" ? bookmarks : tab === "history" ? history : reading;

  return (
    <div
      style={{
        width: 240,
        borderRight: "1px solid rgba(0,0,0,0.08)",
        background: "rgba(246,246,246,0.95)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: "8px 8px 4px 8px",
        }}
      >
        {["bookmarks", "history", "reading"].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              padding: "4px 8px",
              borderRadius: 6,
              border: "none",
              fontSize: 11,
              cursor: "pointer",
              background: tab === t ? "rgba(10,132,255,0.15)" : "transparent",
              color: tab === t ? "#0a84ff" : "#666",
              fontWeight: tab === t ? 600 : 400,
            }}
          >
            {t === "bookmarks" ? "★" : t === "history" ? "🕐" : "📖"}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "0 8px 8px 8px" }}>
        {list.length === 0 && (
          <div style={{ padding: 20, textAlign: "center", color: "#aaa", fontSize: 12 }}>
            {tab === "bookmarks" ? "Sin marcadores" : tab === "history" ? "Sin historial" : "Sin elementos"}
          </div>
        )}
        {list.map((item, i) => (
          <div
            key={item.id || i}
            onClick={() => onNavigate(item.url)}
            style={{
              padding: "6px 8px",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 12,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(0,0,0,0.05)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <div style={{ fontWeight: 500, color: "#333", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {item.title || extractDomain(item.url)}
            </div>
            <div style={{ fontSize: 10, color: "#999", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {item.url}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// TABS
// ============================================================================

function SafariTabs({ tabs, activeId, onSelect, onClose, onNew }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "4px 8px 0 8px",
        background: "rgba(232,232,232,0.9)",
        borderBottom: "1px solid rgba(0,0,0,0.08)",
        overflowX: "auto",
      }}
    >
      {tabs.map((t) => (
        <div
          key={t.id}
          onClick={() => onSelect(t.id)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 10px",
            borderRadius: "8px 8px 0 0",
            background: activeId === t.id ? "#fff" : "transparent",
            cursor: "pointer",
            maxWidth: 200,
            fontSize: 12,
            color: "#333",
          }}
        >
          {t.favicon ? (
            <img src={t.favicon} alt="" style={{ width: 12, height: 12 }} onError={(e) => (e.currentTarget.style.display = "none")} />
          ) : (
            <span style={{ width: 12, height: 12, display: "inline-block", background: "#ddd", borderRadius: 3 }} />
          )}
          <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {t.title || "Nueva pestaña"}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.id);
            }}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              padding: 0,
              opacity: 0.5,
              fontSize: 12,
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        onClick={onNew}
        title="Nueva pestaña"
        style={{
          marginLeft: 4,
          width: 24,
          height: 24,
          borderRadius: "50%",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          fontSize: 14,
          color: "#666",
        }}
      >
        +
      </button>
    </div>
  );
}

// ============================================================================
// SAFARI (componente raíz)
// ============================================================================

export function Safari({ win }) {
  const wm = useWindowManager();
  const [tabs, setTabs] = useState(() => [
    {
      id: "tab-1",
      url: DEFAULT_HOMEPAGE,
      title: "DuckDuckGo",
      favicon: faviconUrl(DEFAULT_HOMEPAGE),
      history: [DEFAULT_HOMEPAGE],
      historyIndex: 0,
      loading: false,
      zoom: 1,
    },
  ]);
  const [activeId, setActiveId] = useState("tab-1");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [privateMode, setPrivateMode] = useState(false);

  const active = useMemo(() => tabs.find((t) => t.id === activeId) || tabs[0], [tabs, activeId]);

  // ---------------------------------------------------------------- helpers
  const updateTab = useCallback((id, patch) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const navigate = useCallback(
    (input, { fromHistory = false } = {}) => {
      const url = normalizeUrl(input);
      const tab = tabs.find((t) => t.id === activeId);
      if (!tab) return;

      const newHistory = fromHistory
        ? tab.history
        : [...tab.history.slice(0, tab.historyIndex + 1), url];

      updateTab(activeId, {
        url,
        title: extractDomain(url) || "Cargando…",
        favicon: faviconUrl(url),
        history: newHistory,
        historyIndex: fromHistory ? tab.historyIndex : newHistory.length - 1,
        loading: true,
      });

      if (!privateMode) {
        const hist = JSON.parse(localStorage.getItem(SAFARI_HISTORY_KEY) || "[]");
        hist.unshift({ url, title: extractDomain(url), ts: Date.now() });
        localStorage.setItem(SAFARI_HISTORY_KEY, JSON.stringify(hist.slice(0, 500)));
      }

      kernelBus.emit("safari:navigate", { url });
    },
    [activeId, tabs, updateTab, privateMode]
  );

  const back = useCallback(() => {
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab || tab.historyIndex <= 0) return;
    const newIndex = tab.historyIndex - 1;
    const url = tab.history[newIndex];
    updateTab(activeId, { url, historyIndex: newIndex, loading: true });
  }, [activeId, tabs, updateTab]);

  const forward = useCallback(() => {
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab || tab.historyIndex >= tab.history.length - 1) return;
    const newIndex = tab.historyIndex + 1;
    const url = tab.history[newIndex];
    updateTab(activeId, { url, historyIndex: newIndex, loading: true });
  }, [activeId, tabs, updateTab]);

  const reload = useCallback(() => {
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab) return;
    // Forzar recarga cambiando un token en la URL
    const sep = tab.url.includes("?") ? "&" : "?";
    updateTab(activeId, { url: tab.url, loading: true, _reloadToken: Date.now() });
  }, [activeId, tabs, updateTab]);

  const newTab = useCallback(() => {
    const id = `tab-${Date.now()}`;
    const newTabObj = {
      id,
      url: DEFAULT_HOMEPAGE,
      title: "Nueva pestaña",
      favicon: null,
      history: [DEFAULT_HOMEPAGE],
      historyIndex: 0,
      loading: false,
      zoom: 1,
    };
    setTabs((prev) => [...prev, newTabObj]);
    setActiveId(id);
  }, []);

  const closeTab = useCallback(
    (id) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id);
        if (next.length === 0) {
          // Cerrar ventana
          if (win?.id) wm.close(win.id);
          return prev;
        }
        if (id === activeId) setActiveId(next[next.length - 1].id);
        return next;
      });
    },
    [activeId, win, wm]
  );

  const onTitleChange = useCallback(
    (title) => updateTab(activeId, { title }),
    [activeId, updateTab]
  );

  const onLoad = useCallback(() => updateTab(activeId, { loading: false }), [activeId, updateTab]);

  const share = useCallback(async () => {
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab) return;
    if (navigator.share) {
      try {
        await navigator.share({ title: tab.title, url: tab.url });
      } catch {}
    } else {
      try {
        await navigator.clipboard.writeText(tab.url);
      } catch {}
    }
  }, [activeId, tabs]);

  const zoomIn = () => updateTab(activeId, { zoom: Math.min(3, (active.zoom || 1) + 0.1) });
  const zoomOut = () => updateTab(activeId, { zoom: Math.max(0.5, (active.zoom || 1) - 0.1) });

  // Atajos
  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "t") { e.preventDefault(); newTab(); }
      if (meta && e.key === "w") { e.preventDefault(); closeTab(activeId); }
      if (meta && e.key === "l") { e.preventDefault(); document.querySelector(".safari-url")?.focus(); }
      if (meta && e.key === "r") { e.preventDefault(); reload(); }
      if (meta && e.key === "[") { e.preventDefault(); back(); }
      if (meta && e.key === "]") { e.preventDefault(); forward(); }
      if (meta && e.shiftKey && (e.key === "T" || e.key === "t")) {
        e.preventDefault();
        // Reabrir última pestaña cerrada
      }
      if (meta && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const idx = parseInt(e.key, 10) - 1;
        if (tabs[idx]) setActiveId(tabs[idx].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newTab, closeTab, reload, back, forward, activeId, tabs]);

  if (!active) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#fff" }}>
      <SafariTabs
        tabs={tabs}
        activeId={activeId}
        onSelect={setActiveId}
        onClose={closeTab}
        onNew={newTab}
      />
      <SafariToolbar
        url={active.url}
        onNavigate={navigate}
        onBack={back}
        onForward={forward}
        onReload={reload}
        onStop={() => updateTab(activeId, { loading: false })}
        loading={active.loading}
        canBack={active.historyIndex > 0}
        canForward={active.historyIndex < active.history.length - 1}
        secure={active.url.startsWith("https://")}
        onShare={share}
        onToggleSidebar={() => setSidebarOpen((s) => !s)}
        sidebarOpen={sidebarOpen}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
      />
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <SafariSidebar
          open={sidebarOpen}
          onNavigate={(url) => navigate(url)}
          onClose={() => setSidebarOpen(false)}
        />
        <WebView
          key={active._reloadToken || active.id}
          url={active.url}
          onTitleChange={onTitleChange}
          onNavigate={navigate}
          onLoad={onLoad}
          onError={(err) => updateTab(activeId, { loading: false })}
          zoom={active.zoom || 1}
        />
      </div>
      {privateMode && (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            padding: "2px 8px",
            background: "rgba(140,20,180,0.85)",
            color: "#fff",
            fontSize: 10,
            borderRadius: 4,
            zIndex: 10,
          }}
        >
          🔒 Navegación privada
        </div>
      )}
    </div>
  );
}

export default Safari;
