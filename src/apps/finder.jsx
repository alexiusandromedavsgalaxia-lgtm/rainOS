// ============================================================================
// finder.jsx — Finder de rainOS
// ----------------------------------------------------------------------------
// El explorador de archivos del sistema. Responsabilidades:
// - Sidebar con Favoritos, iCloud, Etiquetas, Ubicaciones
// - Vistas: iconos, lista, columnas, galería
// - Barra de herramientas con navegación (atrás/adelante/arriba)
// - Barra de ruta (breadcrumb)
// - Barra de búsqueda
// - Barra de estado (X elementos, Y GB disponibles)
// - Doble clic para abrir archivos/carpetas
// - Menú contextual (click derecho)
// - Integración con el kernel (abre ventanas nuevas)
// - Sistema de archivos virtual con estructura de ejemplo
// - Se integra con el descktop (iconos de Macintosh HD, Documentos...)
// - Todo con estilos inline
// ============================================================================

import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from "react";

import { useWindowManager } from "../../kernel/kernel.jsx";

// ============================================================================
// SISTEMA DE ARCHIVOS VIRTUAL
// ============================================================================

const FS_ROOT = {
  id: "root",
  name: "Macintosh HD",
  type: "drive",
  icon: "💽",
  children: [
    {
      id: "users",
      name: "Users",
      type: "folder",
      icon: "📁",
      children: [
        {
          id: "user",
          name: "usuario",
          type: "folder",
          icon: "📁",
          children: [
            {
              id: "desktop",
              name: "Escritorio",
              type: "folder",
              icon: "🖥️",
              children: [],
            },
            {
              id: "documents",
              name: "Documentos",
              type: "folder",
              icon: "📄",
              children: [
                { id: "doc-1", name: "Notas.txt", type: "file", icon: "📝", size: 1234, modified: "2026-09-01" },
                { id: "doc-2", name: "Presupuesto.xlsx", type: "file", icon: "📊", size: 45230, modified: "2026-08-15" },
                { id: "doc-3", name: "Presentación.pptx", type: "file", icon: "📽️", size: 108900, modified: "2026-08-10" },
                { id: "doc-4", name: "Tesis.pdf", type: "file", icon: "📕", size: 8900000, modified: "2026-07-20" },
              ],
            },
            {
              id: "downloads",
              name: "Descargas",
              type: "folder",
              icon: "📥",
              children: [
                { id: "dl-1", name: "rainOS-0.1.0.dmg", type: "file", icon: "💿", size: 25000000, modified: "2026-09-11" },
                { id: "dl-2", name: "wallpaper.png", type: "file", icon: "🖼️", size: 3400000, modified: "2026-09-10" },
                { id: "dl-3", name: "musica.mp3", type: "file", icon: "🎵", size: 8100000, modified: "2026-09-05" },
              ],
            },
            {
              id: "pictures",
              name: "Imágenes",
              type: "folder",
              icon: "🖼️",
              children: [],
            },
            {
              id: "music",
              name: "Música",
              type: "folder",
              icon: "🎵",
              children: [],
            },
            {
              id: "movies",
              name: "Películas",
              type: "folder",
              icon: "🎬",
              children: [],
            },
            {
              id: "projects",
              name: "Proyectos",
              type: "folder",
              icon: "📁",
              children: [
                {
                  id: "proj-rainos",
                  name: "rainOS",
                  type: "folder",
                  icon: "📦",
                  children: [
                    { id: "r-1", name: "package.json", type: "file", icon: "📋", size: 2100, modified: "2026-09-11" },
                    { id: "r-2", name: "README.md", type: "file", icon: "📘", size: 5600, modified: "2026-09-11" },
                    { id: "r-3", name: "kernel.jsx", type: "file", icon: "⚛️", size: 32000, modified: "2026-09-11" },
                    { id: "r-4", name: "bootstrap.jsx", type: "file", icon: "⚛️", size: 22000, modified: "2026-09-11" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "applications",
      name: "Aplicaciones",
      type: "folder",
      icon: "📦",
      children: [
        { id: "app-finder", name: "Finder.app", type: "app", icon: "🗂️", size: 5000000, modified: "2026-09-11" },
        { id: "app-terminal", name: "Terminal.app", type: "app", icon: "⌨️", size: 3000000, modified: "2026-09-11" },
        { id: "app-notes", name: "Notas.app", type: "app", icon: "📝", size: 2000000, modified: "2026-09-11" },
        { id: "app-settings", name: "Ajustes.app", type: "app", icon: "⚙️", size: 4000000, modified: "2026-09-11" },
      ],
    },
    {
      id: "library",
      name: "Library",
      type: "folder",
      icon: "📚",
      children: [],
    },
    {
      id: "system",
      name: "System",
      type: "folder",
      icon: "⚙️",
      children: [],
    },
  ],
};

const FAVORITES = [
  { id: "airdrop", name: "AirDrop", icon: "📡", target: null },
  { id: "recents", name: "Recientes", icon: "🕐", target: null },
  { id: "applications", name: "Aplicaciones", icon: "📦", target: "applications" },
  { id: "desktop", name: "Escritorio", icon: "🖥️", target: "desktop" },
  { id: "documents", name: "Documentos", icon: "📄", target: "documents" },
  { id: "downloads", name: "Descargas", icon: "📥", target: "downloads" },
  { id: "pictures", name: "Imágenes", icon: "🖼️", target: "pictures" },
  { id: "music", name: "Música", icon: "🎵", target: "music" },
  { id: "movies", name: "Películas", icon: "🎬", target: "movies" },
];

const LOCATIONS = [
  { id: "macintosh-hd", name: "Macintosh HD", icon: "💽", target: "root" },
  { id: "icloud", name: "iCloud Drive", icon: "☁️", target: null },
  { id: "network", name: "Red", icon: "🌐", target: null },
];

const TAGS = [
  { id: "red", name: "Rojo", color: "#ff453a" },
  { id: "orange", name: "Naranja", color: "#ff9f0a" },
  { id: "yellow", name: "Amarillo", color: "#ffd60a" },
  { id: "green", name: "Verde", color: "#32d74b" },
  { id: "blue", name: "Azul", color: "#0a84ff" },
  { id: "purple", name: "Púrpura", color: "#bf5af2" },
];

// ============================================================================
// HELPERS
// ============================================================================

const findNodeById = (node, id) => {
  if (!node) return null;
  if (node.id === id) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findNodeById(child, id);
      if (found) return found;
    }
  }
  return null;
};

const getPathToNode = (node, id, path = []) => {
  if (!node) return null;
  const newPath = [...path, node];
  if (node.id === id) return newPath;
  if (node.children) {
    for (const child of node.children) {
      const found = getPathToNode(child, id, newPath);
      if (found) return found;
    }
  }
  return null;
};

const formatSize = (bytes) => {
  if (!bytes) return "--";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

// ============================================================================
// VISTAS
// ============================================================================

function IconView({ items, onOpen, selected, onSelect }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))",
        gap: 12,
        padding: 20,
      }}
    >
      {items.map((item) => {
        const isSelected = selected.has(item.id);
        return (
          <div
            key={item.id}
            onClick={(e) => onSelect(item.id, e)}
            onDoubleClick={() => onOpen(item)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
              padding: 10,
              borderRadius: 8,
              cursor: "pointer",
              userSelect: "none",
              background: isSelected ? "rgba(10,132,255,0.2)" : "transparent",
            }}
          >
            <div style={{ fontSize: 48, lineHeight: 1 }}>
              {item.icon || (item.type === "folder" ? "📁" : "📄")}
            </div>
            <div
              style={{
                fontSize: 12,
                textAlign: "center",
                color: "#333",
                wordBreak: "break-word",
                maxWidth: "100%",
                background: isSelected ? "#0a84ff" : "transparent",
                color: isSelected ? "#fff" : "#333",
                padding: "2px 6px",
                borderRadius: 4,
              }}
            >
              {item.name}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ListView({ items, onOpen, selected, onSelect }) {
  return (
    <div style={{ padding: 8 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 120px 140px 100px",
          gap: 12,
          padding: "6px 12px",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "#888",
          borderBottom: "0.5px solid rgba(0,0,0,0.1)",
        }}
      >
        <div>Nombre</div>
        <div>Fecha de modificación</div>
        <div>Tamaño</div>
        <div>Tipo</div>
      </div>
      {items.map((item) => {
        const isSelected = selected.has(item.id);
        return (
          <div
            key={item.id}
            onClick={(e) => onSelect(item.id, e)}
            onDoubleClick={() => onOpen(item)}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 120px 140px 100px",
              gap: 12,
              padding: "6px 12px",
              fontSize: 13,
              cursor: "pointer",
              userSelect: "none",
              background: isSelected ? "#0a84ff" : "transparent",
              color: isSelected ? "#fff" : "#333",
              borderRadius: 4,
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 18 }}>
                {item.icon || (item.type === "folder" ? "📁" : "📄")}
              </span>
              <span>{item.name}</span>
            </div>
            <div style={{ opacity: 0.7 }}>{item.modified || "--"}</div>
            <div style={{ opacity: 0.7 }}>
              {item.type === "folder" ? "--" : formatSize(item.size)}
            </div>
            <div style={{ opacity: 0.7 }}>
              {item.type === "folder" ? "Carpeta" : "Documento"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ColumnView({ items, onOpen, selected, onSelect, columns }) {
  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {columns.map((col, ci) => (
        <div
          key={ci}
          style={{
            flex: 1,
            minWidth: 200,
            maxWidth: 320,
            borderRight: "0.5px solid rgba(0,0,0,0.1)",
            overflowY: "auto",
            background: "#fff",
          }}
        >
          {col.map((item) => {
            const isSelected = selected.has(item.id);
            const hasChildren = item.type === "folder" && item.children?.length > 0;
            return (
              <div
                key={item.id}
                onClick={(e) => onSelect(item.id, e)}
                onDoubleClick={() => onOpen(item)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  padding: "6px 12px",
                  fontSize: 13,
                  cursor: "pointer",
                  background: isSelected ? "#0a84ff" : "transparent",
                  color: isSelected ? "#fff" : "#333",
                  userSelect: "none",
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
                  <span style={{ fontSize: 16 }}>
                    {item.icon || (item.type === "folder" ? "📁" : "📄")}
                  </span>
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {item.name}
                  </span>
                </div>
                {hasChildren && (
                  <span style={{ opacity: 0.5, fontSize: 11 }}>›</span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// SIDEBAR
// ============================================================================

function Sidebar({ currentId, onNavigate }) {
  const Section = ({ title, children }) => (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "#888",
          padding: "4px 12px",
          fontWeight: 600,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );

  const Item = ({ icon, label, target, color }) => {
    const active = currentId === target;
    return (
      <div
        onClick={() => target && onNavigate(target)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px",
          fontSize: 13,
          borderRadius: 6,
          margin: "0 6px",
          cursor: "pointer",
          background: active ? "rgba(0,0,0,0.08)" : "transparent",
          color: "#333",
          userSelect: "none",
        }}
        onMouseEnter={(e) => {
          if (!active) e.currentTarget.style.background = "rgba(0,0,0,0.04)";
        }}
        onMouseLeave={(e) => {
          if (!active) e.currentTarget.style.background = "transparent";
        }}
      >
        <span style={{ fontSize: 14 }}>{icon}</span>
        <span
          style={{
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {label}
        </span>
        {color && (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              background: color,
              marginLeft: "auto",
            }}
          />
        )}
      </div>
    );
  };

  return (
    <div
      style={{
        width: 200,
        flexShrink: 0,
        background: "rgba(240,240,240,0.85)",
        borderRight: "0.5px solid rgba(0,0,0,0.1)",
        paddingTop: 12,
        overflowY: "auto",
      }}
    >
      <Section title="Favoritos">
        {FAVORITES.map((f) => (
          <Item
            key={f.id}
            icon={f.icon}
            label={f.name}
            target={f.target}
          />
        ))}
      </Section>

      <Section title="iCloud">
        <Item icon="☁️" label="iCloud Drive" target={null} />
        <Item icon="📄" label="Escritorio" target={null} />
        <Item icon="📄" label="Documentos" target={null} />
      </Section>

      <Section title="Etiquetas">
        {TAGS.map((t) => (
          <Item
            key={t.id}
            icon="●"
            color={t.color}
            label={t.name}
            target={null}
          />
        ))}
      </Section>

      <Section title="Ubicaciones">
        {LOCATIONS.map((l) => (
          <Item
            key={l.id}
            icon={l.icon}
            label={l.name}
            target={l.target}
          />
        ))}
      </Section>
    </div>
  );
}

// ============================================================================
// TOOLBAR
// ============================================================================

function Toolbar({
  view,
  setView,
  onBack,
  onForward,
  onUp,
  canBack,
  canForward,
  canUp,
  path,
  query,
  setQuery,
}) {
  const btnStyle = (disabled) => ({
    width: 28,
    height: 28,
    borderRadius: 6,
    border: "none",
    background: "transparent",
    color: disabled ? "#bbb" : "#555",
    cursor: disabled ? "default" : "pointer",
    fontSize: 14,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
  });

  const viewBtnStyle = (active) => ({
    ...btnStyle(false),
    background: active ? "rgba(0,0,0,0.08)" : "transparent",
    color: "#555",
  });

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        borderBottom: "0.5px solid rgba(0,0,0,0.1)",
        background: "rgba(245,245,245,0.9)",
      }}
    >
      <button
        onClick={onBack}
        disabled={!canBack}
        style={btnStyle(!canBack)}
        title="Atrás"
      >
        ‹
      </button>
      <button
        onClick={onForward}
        disabled={!canForward}
        style={btnStyle(!canForward)}
        title="Adelante"
      >
        ›
      </button>
      <button
        onClick={onUp}
        disabled={!canUp}
        style={btnStyle(!canUp)}
        title="Subir"
      >
        ⌃
      </button>

      <div
        style={{
          flex: 1,
          display: "flex",
          gap: 4,
          alignItems: "center",
          fontSize: 12,
          color: "#666",
          padding: "0 8px",
          overflow: "hidden",
        }}
      >
        {path.map((n, i) => (
          <React.Fragment key={n.id}>
            <span
              style={{
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 120,
              }}
            >
              {n.icon} {n.name}
            </span>
            {i < path.length - 1 && <span style={{ opacity: 0.5 }}>›</span>}
          </React.Fragment>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          gap: 2,
          border: "0.5px solid rgba(0,0,0,0.12)",
          borderRadius: 6,
          padding: 2,
        }}
      >
        <button
          onClick={() => setView("icon")}
          style={viewBtnStyle(view === "icon")}
          title="Como iconos"
        >
          ▦
        </button>
        <button
          onClick={() => setView("list")}
          style={viewBtnStyle(view === "list")}
          title="Como lista"
        >
          ☰
        </button>
        <button
          onClick={() => setView("column")}
          style={viewBtnStyle(view === "column")}
          title="Como columnas"
        >
          ▥
        </button>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          background: "rgba(0,0,0,0.05)",
          borderRadius: 6,
          fontSize: 12,
        }}
      >
        <span style={{ opacity: 0.6 }}>🔍</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar"
          style={{
            background: "transparent",
            border: "none",
            outline: "none",
            width: 100,
            fontSize: 12,
            color: "#333",
          }}
        />
      </div>
    </div>
  );
}

// ============================================================================
// FINDER (componente raíz)
// ============================================================================

export function Finder({ win }) {
  const wm = useWindowManager();

  const initialId = win?.data?.initialFolder || "documents";
  const [currentId, setCurrentId] = useState(initialId);
  const [history, setHistory] = useState([initialId]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [view, setView] = useState("icon");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [contextMenu, setContextMenu] = useState(null);

  // Navegar a un nodo
  const navigate = useCallback(
    (id, { pushHistory = true } = {}) => {
      setCurrentId(id);
      setSelected(new Set());
      if (pushHistory) {
        setHistory((h) => {
          const newHistory = h.slice(0, historyIndex + 1);
          newHistory.push(id);
          setHistoryIndex(newHistory.length - 1);
          return newHistory;
        });
      }
    },
    [historyIndex]
  );

  const goBack = useCallback(() => {
    if (historyIndex <= 0) return;
    const newIndex = historyIndex - 1;
    setHistoryIndex(newIndex);
    setCurrentId(history[newIndex]);
    setSelected(new Set());
  }, [historyIndex, history]);

  const goForward = useCallback(() => {
    if (historyIndex >= history.length - 1) return;
    const newIndex = historyIndex + 1;
    setHistoryIndex(newIndex);
    setCurrentId(history[newIndex]);
    setSelected(new Set());
  }, [historyIndex, history]);

  const goUp = useCallback(() => {
    const path = getPathToNode(FS_ROOT, currentId);
    if (path && path.length > 1) {
      navigate(path[path.length - 2].id);
    }
  }, [currentId, navigate]);

  // Datos del nodo actual
  const currentNode = useMemo(
    () => findNodeById(FS_ROOT, currentId),
    [currentId]
  );

  const path = useMemo(() => getPathToNode(FS_ROOT, currentId) || [], [currentId]);

  const items = useMemo(() => {
    if (!currentNode || !currentNode.children) return [];
    let list = currentNode.children;
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((i) => i.name.toLowerCase().includes(q));
    }
    return list;
  }, [currentNode, query]);

  // Columnas para la vista de columnas
  const columns = useMemo(() => {
    if (view !== "column") return [];
    const cols = [];
    for (let i = 0; i < path.length; i++) {
      cols.push(path[i].children || []);
    }
    return cols;
  }, [view, path]);

  // Manejo de selección
  const handleSelect = useCallback(
    (id, e) => {
      setSelected((prev) => {
        const next = new Set(e.metaKey || e.ctrlKey ? prev : []);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    []
  );

  // Abrir item
  const handleOpen = useCallback(
    (item) => {
      if (item.type === "folder" || item.type === "drive") {
        navigate(item.id);
      } else if (item.type === "app") {
        // Abrir app del sistema
        const appId = item.name.replace(".app", "").toLowerCase();
        // Aquí enlazaríamos con el sistema de apps
        console.log("[finder] would open app:", appId);
      } else {
        console.log("[finder] would open file:", item.name);
      }
    },
    [navigate]
  );

  // Context menu
  useEffect(() => {
    const close = () => setContextMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  // Doble click sobre el fondo de la ventana para subir un nivel
  const handleBackgroundDoubleClick = (e) => {
    if (e.target === e.currentTarget) {
      goUp();
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#fff",
        color: "#333",
        fontFamily:
          '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
        fontSize: 13,
        userSelect: "none",
      }}
    >
      {/* Toolbar */}
      <Toolbar
        view={view}
        setView={setView}
        onBack={goBack}
        onForward={goForward}
        onUp={goUp}
        canBack={historyIndex > 0}
        canForward={historyIndex < history.length - 1}
        canUp={path.length > 1}
        path={path}
        query={query}
        setQuery={setQuery}
      />

      {/* Body: sidebar + content */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <Sidebar currentId={currentId} onNavigate={navigate} />

        <div
          style={{
            flex: 1,
            overflow: "auto",
            background: "#fff",
            minWidth: 0,
          }}
          onDoubleClick={handleBackgroundDoubleClick}
        >
          {items.length === 0 ? (
            <div
              style={{
                padding: 40,
                textAlign: "center",
                color: "#aaa",
                fontSize: 13,
              }}
            >
              {query
                ? `Sin resultados para «${query}»`
                : "Esta carpeta está vacía"}
            </div>
          ) : view === "icon" ? (
            <IconView
              items={items}
              onOpen={handleOpen}
              selected={selected}
              onSelect={handleSelect}
            />
          ) : view === "list" ? (
            <ListView
              items={items}
              onOpen={handleOpen}
              selected={selected}
              onSelect={handleSelect}
            />
          ) : (
            <ColumnView
              items={items}
              onOpen={handleOpen}
              selected={selected}
              onSelect={handleSelect}
              columns={columns}
            />
          )}
        </div>
      </div>

      {/* Status bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 12px",
          borderTop: "0.5px solid rgba(0,0,0,0.1)",
          background: "rgba(245,245,245,0.9)",
          fontSize: 11,
          color: "#666",
        }}
      >
        <div>
          {items.length} elemento{items.length === 1 ? "" : "s"}
          {selected.size > 0 && ` · ${selected.size} seleccionados`}
        </div>
        <div>128,5 GB disponibles</div>
      </div>
    </div>
  );
}

export default Finder;
