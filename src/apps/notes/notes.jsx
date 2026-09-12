// ============================================================================
// notes.jsx — Notas de rainOS
// ----------------------------------------------------------------------------
// App de notas del sistema. Responsabilidades:
//
// 1. SIDEBAR
//    - Secciones: Todas, Notas, Fijadas + carpetas de usuario
//    - Crear carpeta nueva
//    - Contador de notas por carpeta
//    - Búsqueda global en título + cuerpo
//
// 2. LISTA DE NOTAS
//    - Preview (título + fecha + primera línea)
//    - Notas fijadas arriba
//    - Indicadores: 📌 fijada, 🔒 bloqueada
//    - Click derecho → menú contextual completo
//
// 3. EDITOR
//    - Título + cuerpo
//    - Autosave al escribir
//    - Fecha de última edición
//    - Vista bloqueada si tiene contraseña
//
// 4. ACCIONES (menú contextual)
//    - Compartir
//    - Trasladar a carpeta
//    - Eliminar
//    - Abrir en ventana nueva
//    - Mostrar en carpeta contenedora
//    - Fijar / Desfijar
//    - Bloquear / Desbloquear con contraseña
//    - Duplicar
//
// 5. ATAJOS
//    - ⌘N nueva nota
//    - ⌘F buscar
//    - Esc cerrar modales
//
// 6. PERSISTENCIA
//    - localStorage bajo "notes.v1"
//
// Todo con estilos inline.
// ============================================================================

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";

import { useWindowManager } from "../../kernel/kernel.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

const STORAGE_KEY = "notes.v1";

const INITIAL_FOLDERS = [
  { id: "all", name: "Todas las notas", icon: "📝", system: true },
  { id: "notes", name: "Notas", icon: "📝", system: true },
  { id: "pinned", name: "Fijadas", icon: "📌", system: true },
  { id: "work", name: "Trabajo", icon: "💼", system: false },
  { id: "personal", name: "Personal", icon: "🏠", system: false },
  { id: "ideas", name: "Ideas", icon: "💡", system: false },
];

const INITIAL_NOTES = [
  {
    id: "n-1",
    folder: "work",
    title: "Bienvenido a Notas",
    body:
      "Esta es la app de Notas de rainOS.\n\n" +
      "Puedes:\n" +
      "• Crear notas nuevas con ⌘N\n" +
      "• Fijar notas importantes (clic derecho → Fijar nota)\n" +
      "• Bloquear notas con contraseña\n" +
      "• Organizar por carpetas\n" +
      "• Buscar en todas las notas\n\n" +
      "El menú contextual (clic derecho) tiene todas las acciones.",
    pinned: true,
    locked: false,
    createdAt: Date.now() - 86400000 * 3,
    updatedAt: Date.now() - 86400000 * 3,
  },
  {
    id: "n-2",
    folder: "notes",
    title: "Lista de la compra",
    body: "☐ Leche\n☑ Pan\n☐ Huevos\n☐ Fruta\n☐ Café",
    pinned: false,
    locked: false,
    createdAt: Date.now() - 86400000 * 2,
    updatedAt: Date.now() - 86400000 * 2,
  },
  {
    id: "n-3",
    folder: "ideas",
    title: "Ideas para rainOS",
    body:
      "1. Añadir app Emulator con v86 (WASM)\n" +
      "2. Integrar actualizaciones automáticas\n" +
      "3. Modo oscuro global\n" +
      "4. Gestos con el trackpad",
    pinned: true,
    locked: false,
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now() - 86400000,
  },
  {
    id: "n-4",
    folder: "personal",
    title: "Nota privada",
    body: "Esto está bloqueado con contraseña 🔒\n\nContraseña: 1234",
    pinned: false,
    locked: true,
    lockedPassword: "1234",
    createdAt: Date.now() - 3600000 * 5,
    updatedAt: Date.now() - 3600000 * 5,
  },
];

// ============================================================================
// HELPERS
// ============================================================================

const formatDate = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString("es-ES", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  if (sameYear) {
    return d.toLocaleDateString("es-ES", {
      day: "2-digit",
      month: "short",
    });
  }
  return d.toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
};

const previewText = (body, max = 40) => {
  const first = (body || "").split("\n").find((l) => l.trim()) || "";
  return first.length > max ? first.slice(0, max) + "…" : first;
};

const loadFromStorage = () => {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const saveToStorage = (data) => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* noop */
  }
};

// ============================================================================
// ICONOS SVG
// ============================================================================

const Icon = ({ name, size = 16, color = "currentColor" }) => {
  const paths = {
    share: "M8 3v10M4 7l4-4 4 4M3 11v5h10v-5",
    trash: "M3 4h10M5 4V3h6v1M4 4l1 10h6l1-10",
    newWindow: "M2 3h8v6H2zM6 6h8v6H6zM9 8h1M9 11h1",
    folder: "M2 4h5l1 1h6v7H2z",
    pin: "M8 2l2 4 3 .5-2.5 3v3.5L8 12l-2.5-1.5V7L3 6.5 6 6z",
    lock: "M4 7V5a3 3 0 1 1 6 0v2M3 7h10v7H3z",
    unlock: "M4 7V5a3 3 0 0 1 6 0M3 7h10v7H3z",
    duplicate: "M4 4h7v7H4zM6 2h8v8",
    search: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM11 11l3 3",
    plus: "M8 3v10M3 8h10",
    x: "M4 4l8 8M12 4l-8 8",
    back: "M10 4L6 8l4 4",
    forward: "M6 4l4 4-4 4",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={color}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, display: "block" }}
    >
      <path d={paths[name] || ""} />
    </svg>
  );
};

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

  // Ajustar si se sale por la derecha/abajo
  const menuWidth = 260;
  const menuHeight = items.length * 30 + 20;
  const x = Math.min(position.x, window.innerWidth - menuWidth - 10);
  const y = Math.min(position.y, window.innerHeight - menuHeight - 10);

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: x,
        top: y,
        minWidth: menuWidth,
        background: "rgba(40,40,40,0.96)",
        backdropFilter: "blur(30px)",
        WebkitBackdropFilter: "blur(30px)",
        borderRadius: 10,
        padding: 6,
        boxShadow: "0 20px 50px rgba(0,0,0,0.5)",
        border: "0.5px solid rgba(255,255,255,0.1)",
        color: "#fff",
        fontSize: 13,
        zIndex: 999999,
        userSelect: "none",
        fontFamily:
          '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
      }}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div
            key={i}
            style={{
              height: 1,
              background: "rgba(255,255,255,0.15)",
              margin: "5px 8px",
            }}
          />
        ) : (
          <div
            key={i}
            onClick={() => {
              if (item.disabled) return;
              item.action?.();
              onClose?.();
            }}
            style={{
              padding: "6px 10px",
              borderRadius: 5,
              cursor: item.disabled ? "default" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: 10,
              opacity: item.disabled ? 0.4 : 1,
              color: item.danger ? "#ff6b6b" : "#fff",
            }}
            onMouseEnter={(e) => {
              if (!item.disabled)
                e.currentTarget.style.background = item.danger
                  ? "#d32f2f"
                  : "#0a84ff";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            {item.icon && (
              <span
                style={{
                  width: 18,
                  display: "flex",
                  justifyContent: "center",
                }}
              >
                <Icon name={item.icon} size={15} />
              </span>
            )}
            <span style={{ flex: 1 }}>{item.label}</span>
            {item.shortcut && (
              <span style={{ opacity: 0.5, fontSize: 11 }}>
                {item.shortcut}
              </span>
            )}
          </div>
        )
      )}
    </div>
  );
}

// ============================================================================
// MODAL DE CONTRASEÑA
// ============================================================================

function PasswordModal({ mode, note, error, onConfirm, onCancel }) {
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState("");

  const submit = () => {
    if (!password) {
      setLocalError("Introduce una contraseña");
      return;
    }
    setLocalError("");
    onConfirm?.(password);
  };

  const title = mode === "lock" ? "Bloquear nota" : "Desbloquear nota";
  const buttonLabel = mode === "lock" ? "Bloquear" : "Desbloquear";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel?.();
      }}
    >
      <div
        style={{
          width: 360,
          padding: 22,
          background: "rgba(240,240,240,0.98)",
          borderRadius: 14,
          boxShadow: "0 30px 80px rgba(0,0,0,0.5)",
          color: "#333",
          fontFamily:
            '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
        }}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            marginBottom: 6,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Icon name="lock" size={18} color="#333" />
          {title}
        </div>
        <div style={{ fontSize: 12, color: "#666", marginBottom: 14 }}>
          {mode === "lock"
            ? `Introduce una contraseña para bloquear «${note.title}».`
            : `Introduce la contraseña para desbloquear «${note.title}».`}
        </div>
        <input
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setLocalError("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onCancel?.();
          }}
          autoFocus
          placeholder="Contraseña"
          style={{
            width: "100%",
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid rgba(0,0,0,0.15)",
            fontSize: 14,
            outline: "none",
            marginBottom: 8,
            boxSizing: "border-box",
          }}
        />
        {(localError || error) && (
          <div style={{ color: "#d32f2f", fontSize: 12, marginBottom: 8 }}>
            {localError || "Contraseña incorrecta"}
          </div>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 8,
          }}
        >
          <button
            onClick={onCancel}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              border: "1px solid rgba(0,0,0,0.15)",
              background: "transparent",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Cancelar
          </button>
          <button
            onClick={submit}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              border: "none",
              background: "#0a84ff",
              color: "#fff",
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {buttonLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// SELECTOR DE CARPETA (para "Trasladar")
// ============================================================================

function FolderPicker({ folders, onPick, position }) {
  const list = folders.filter((f) => f.id !== "all" && f.id !== "pinned");

  return (
    <div
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
        minWidth: 200,
        background: "rgba(40,40,40,0.96)",
        backdropFilter: "blur(30px)",
        WebkitBackdropFilter: "blur(30px)",
        borderRadius: 10,
        padding: 6,
        boxShadow: "0 20px 50px rgba(0,0,0,0.5)",
        border: "0.5px solid rgba(255,255,255,0.1)",
        color: "#fff",
        fontSize: 13,
        zIndex: 1000000,
        fontFamily:
          '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
      }}
    >
      <div
        style={{
          padding: "4px 10px",
          fontSize: 11,
          opacity: 0.6,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        Trasladar a…
      </div>
      {list.map((f) => (
        <div
          key={f.id}
          onClick={() => onPick?.(f.id)}
          style={{
            padding: "6px 10px",
            borderRadius: 5,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "#0a84ff";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          <span>{f.icon}</span>
          <span>{f.name}</span>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// NOTES (componente raíz)
// ============================================================================

export function Notes({ win }) {
  const wm = useWindowManager();

  // ------------------------------------------------------ state
  const [folders, setFolders] = useState(() => {
    const stored = loadFromStorage();
    return stored?.folders || INITIAL_FOLDERS;
  });
  const [notes, setNotes] = useState(() => {
    const stored = loadFromStorage();
    return stored?.notes || INITIAL_NOTES;
  });
  const [currentFolder, setCurrentFolder] = useState("all");
  const [selectedNoteId, setSelectedNoteId] = useState(() => {
    const stored = loadFromStorage();
    const list = stored?.notes || INITIAL_NOTES;
    return list.find((n) => n.pinned)?.id || list[0]?.id || null;
  });
  const [query, setQuery] = useState("");
  const [contextMenu, setContextMenu] = useState(null);
  const [folderPicker, setFolderPicker] = useState(null);
  const [passwordModal, setPasswordModal] = useState(null);
  const [passwordError, setPasswordError] = useState(false);
  const [unlockedNotes, setUnlockedNotes] = useState(new Set());

  const editorRef = useRef(null);

  // ------------------------------------------------------ persistencia
  useEffect(() => {
    saveToStorage({ folders, notes });
  }, [folders, notes]);

  // ------------------------------------------------------ notas filtradas
  const filteredNotes = useMemo(() => {
    let list = [...notes];

    if (currentFolder === "pinned") {
      list = list.filter((n) => n.pinned);
    } else if (currentFolder === "all") {
      // todas
    } else {
      list = list.filter((n) => n.folder === currentFolder);
    }

    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          n.body.toLowerCase().includes(q)
      );
    }

    list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });

    return list;
  }, [notes, currentFolder, query]);

  const selectedNote = useMemo(
    () => notes.find((n) => n.id === selectedNoteId) || null,
    [notes, selectedNoteId]
  );

  const isSelectedLocked =
    selectedNote?.locked && !unlockedNotes.has(selectedNote.id);

  // ------------------------------------------------------ acciones
  const createNote = useCallback(() => {
    const id = `n-${Date.now()}`;
    const folder =
      currentFolder === "all" || currentFolder === "pinned"
        ? "notes"
        : currentFolder;
    const newNote = {
      id,
      folder,
      title: "Nueva nota",
      body: "",
      pinned: false,
      locked: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setNotes((prev) => [newNote, ...prev]);
    setSelectedNoteId(id);
    setTimeout(() => editorRef.current?.focus?.(), 50);
  }, [currentFolder]);

  const updateNote = useCallback((id, patch) => {
    setNotes((prev) =>
      prev.map((n) => (n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n))
    );
  }, []);

  const deleteNote = useCallback(
    (id) => {
      setNotes((prev) => prev.filter((n) => n.id !== id));
      if (selectedNoteId === id) {
        const remaining = notes.filter((n) => n.id !== id);
        setSelectedNoteId(remaining[0]?.id || null);
      }
    },
    [notes, selectedNoteId]
  );

  const duplicateNote = useCallback(
    (id) => {
      const original = notes.find((n) => n.id === id);
      if (!original) return;
      const newId = `n-${Date.now()}`;
      const copy = {
        ...original,
        id: newId,
        title: `${original.title} copia`,
        pinned: false,
        locked: false,
        lockedPassword: undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setNotes((prev) => [copy, ...prev]);
      setSelectedNoteId(newId);
    },
    [notes]
  );

  const togglePin = useCallback(
    (id) => {
      const note = notes.find((n) => n.id === id);
      if (!note) return;
      updateNote(id, { pinned: !note.pinned });
    },
    [notes, updateNote]
  );

  const requestLock = useCallback((note) => {
    setPasswordError(false);
    setPasswordModal({
      mode: note.locked ? "unlock" : "lock",
      note,
    });
  }, []);

  const confirmPassword = useCallback(
    (password) => {
      if (!passwordModal) return;
      const { mode, note } = passwordModal;

      if (mode === "lock") {
        updateNote(note.id, {
          locked: true,
          lockedPassword: password,
        });
        setPasswordModal(null);
        setPasswordError(false);
        return;
      }

      if (mode === "unlock") {
        if (note.lockedPassword === password) {
          setUnlockedNotes((prev) => new Set([...prev, note.id]));
          setPasswordModal(null);
          setPasswordError(false);
        } else {
          setPasswordError(true);
        }
      }
    },
    [passwordModal, updateNote]
  );

  const moveNote = useCallback(
    (id, folderId) => {
      updateNote(id, { folder: folderId });
    },
    [updateNote]
  );

  const shareNote = useCallback((note) => {
    console.log("[notes] share:", note.title);
  }, []);

  const showInFolder = useCallback((note) => {
    console.log("[notes] show in folder:", note.folder);
  }, []);

  const openInNewWindow = useCallback(
    (note) => {
      wm.open({
        title: note.title || "Nota",
        component: Notes,
        width: 720,
        height: 480,
        data: { noteId: note.id },
      });
    },
    [wm]
  );

  // ------------------------------------------------------ nueva carpeta
  const createFolder = useCallback(() => {
    const name = typeof window !== "undefined"
      ? window.prompt("Nombre de la carpeta:")
      : null;
    if (!name) return;
    const id = `f-${Date.now()}`;
    setFolders((prev) => [...prev, { id, name, icon: "📁", system: false }]);
  }, []);

  // ------------------------------------------------------ context menu
  const openContextMenu = useCallback(
    (e, note) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        note,
        items: [
          {
            label: "Compartir",
            icon: "share",
            action: () => shareNote(note),
          },
          {
            label: "Trasladar",
            icon: "folder",
            action: () => {
              setFolderPicker({
                x: e.clientX,
                y: e.clientY,
                note,
              });
            },
          },
          {
            label: "Eliminar",
            icon: "trash",
            danger: true,
            action: () => {
              const ok =
                typeof window !== "undefined"
                  ? window.confirm(`¿Eliminar la nota «${note.title}»?`)
                  : true;
              if (ok) deleteNote(note.id);
            },
          },
          { separator: true },
          {
            label: "Abrir en una ventana nueva",
            icon: "newWindow",
            action: () => openInNewWindow(note),
          },
          { separator: true },
          {
            label: "Mostrar en la carpeta contenedora",
            icon: "folder",
            action: () => showInFolder(note),
          },
          {
            label: note.pinned ? "Quitar de fijadas" : "Fijar nota",
            icon: "pin",
            action: () => togglePin(note.id),
          },
          {
            label: note.locked ? "Desbloquear nota" : "Bloquear nota",
            icon: "lock",
            action: () => requestLock(note),
          },
          {
            label: "Duplicar nota",
            icon: "duplicate",
            action: () => duplicateNote(note.id),
          },
        ],
      });
    },
    [
      shareNote,
      deleteNote,
      openInNewWindow,
      showInFolder,
      togglePin,
      requestLock,
      duplicateNote,
    ]
  );

  // ------------------------------------------------------ keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "n" || e.key === "N")) {
        // solo si esta ventana es la activa
        if (win?.id && wm.activeId && win.id !== wm.activeId) return;
        e.preventDefault();
        createNote();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createNote, win, wm.activeId]);

  // ------------------------------------------------------ render item
  const NoteListItem = ({ note }) => {
    const isSelected = note.id === selectedNoteId;
    const locked = note.locked && !unlockedNotes.has(note.id);
    return (
      <div
        onClick={() => setSelectedNoteId(note.id)}
        onContextMenu={(e) => openContextMenu(e, note)}
        style={{
          padding: "10px 14px",
          borderBottom: "0.5px solid rgba(0,0,0,0.08)",
          cursor: "pointer",
          background: isSelected ? "rgba(255,214,10,0.28)" : "transparent",
          userSelect: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            fontWeight: 600,
            color: "#333",
            marginBottom: 2,
          }}
        >
          {note.pinned && <span style={{ fontSize: 11 }}>📌</span>}
          {locked && <span style={{ fontSize: 11 }}>🔒</span>}
          <span
            style={{
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              flex: 1,
            }}
          >
            {note.title || "Sin título"}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11,
            color: "#888",
            gap: 8,
          }}
        >
          <span
            style={{
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              flex: 1,
            }}
          >
            {locked ? "🔒 Bloqueada" : formatDate(note.updatedAt)}
          </span>
          {!locked && (
            <span
              style={{
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 120,
              }}
            >
              {previewText(note.body)}
            </span>
          )}
        </div>
      </div>
    );
  };

  // ------------------------------------------------------ render
  const headerHeight = 44;

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        background: "#fff",
        color: "#333",
        fontFamily:
          '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
        fontSize: 13,
        userSelect: "none",
      }}
    >
      {/* Sidebar + lista */}
      <div
        style={{
          width: 300,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          borderRight: "0.5px solid rgba(0,0,0,0.1)",
          background: "rgba(245,245,245,0.9)",
        }}
      >
        {/* Header */}
        <div
          style={{
            height: headerHeight,
            display: "flex",
            alignItems: "center",
            padding: "0 10px",
            borderBottom: "0.5px solid rgba(0,0,0,0.1)",
            gap: 8,
          }}
        >
          <button
            onClick={createNote}
            title="Nueva nota (⌘N)"
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#333",
              padding: 0,
            }}
          >
            <Icon name="plus" size={16} />
          </button>
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 8px",
              background: "rgba(0,0,0,0.05)",
              borderRadius: 6,
              fontSize: 12,
              color: "#888",
            }}
          >
            <Icon name="search" size={13} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar"
              style={{
                background: "transparent",
                border: "none",
                outline: "none",
                width: "100%",
                fontSize: 12,
                color: "#333",
              }}
            />
          </div>
        </div>

        {/* Carpetas */}
        <div
          style={{
            padding: "8px 0",
            borderBottom: "0.5px solid rgba(0,0,0,0.1)",
          }}
        >
          {folders.map((f) => (
            <div
              key={f.id}
              onClick={() => setCurrentFolder(f.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 12px",
                margin: "0 6px",
                borderRadius: 6,
                cursor: "pointer",
                background:
                  currentFolder === f.id ? "rgba(0,0,0,0.08)" : "transparent",
                fontSize: 13,
                color: "#333",
              }}
            >
              <span style={{ fontSize: 14 }}>{f.icon}</span>
              <span
                style={{
                  flex: 1,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {f.name}
              </span>
              <span style={{ fontSize: 11, color: "#888" }}>
                {
                  notes.filter((n) =>
                    f.id === "all"
                      ? true
                      : f.id === "pinned"
                      ? n.pinned
                      : n.folder === f.id
                  ).length
                }
              </span>
            </div>
          ))}
          <div
            onClick={createFolder}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 12px",
              margin: "0 6px",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
              color: "#0a84ff",
            }}
          >
            <span style={{ fontSize: 14 }}>＋</span>
            <span>Nueva carpeta</span>
          </div>
        </div>

        {/* Lista de notas */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {filteredNotes.length === 0 ? (
            <div
              style={{
                padding: 30,
                textAlign: "center",
                color: "#aaa",
                fontSize: 12,
              }}
            >
              No hay notas
            </div>
          ) : (
            filteredNotes.map((n) => <NoteListItem key={n.id} note={n} />)
          )}
        </div>
      </div>

      {/* Editor */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {selectedNote ? (
          isSelectedLocked ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 14,
                color: "#666",
              }}
            >
              <div style={{ fontSize: 48 }}>🔒</div>
              <div style={{ fontSize: 15, fontWeight: 500 }}>
                Nota bloqueada
              </div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>
                Introduce la contraseña para ver su contenido
              </div>
              <button
                onClick={() => requestLock(selectedNote)}
                style={{
                  padding: "6px 16px",
                  borderRadius: 8,
                  border: "none",
                  background: "#0a84ff",
                  color: "#fff",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Desbloquear
              </button>
            </div>
          ) : (
            <>
              <div
                style={{
                  padding: "12px 20px 6px 20px",
                  borderBottom: "0.5px solid rgba(0,0,0,0.08)",
                }}
              >
                <input
                  value={selectedNote.title}
                  onChange={(e) =>
                    updateNote(selectedNote.id, { title: e.target.value })
                  }
                  placeholder="Título"
                  style={{
                    width: "100%",
                    border: "none",
                    outline: "none",
                    fontSize: 20,
                    fontWeight: 600,
                    color: "#333",
                    background: "transparent",
                    fontFamily: "inherit",
                    boxSizing: "border-box",
                  }}
                />
                <div
                  style={{
                    fontSize: 11,
                    color: "#888",
                    marginTop: 4,
                    display: "flex",
                    gap: 10,
                  }}
                >
                  <span>Editado {formatDate(selectedNote.updatedAt)}</span>
                  {selectedNote.pinned && <span>📌 Fijada</span>}
                  {selectedNote.locked && <span>🔒 Bloqueada</span>}
                </div>
              </div>
              <textarea
                ref={editorRef}
                value={selectedNote.body}
                onChange={(e) =>
                  updateNote(selectedNote.id, { body: e.target.value })
                }
                placeholder="Escribe aquí…"
                style={{
                  flex: 1,
                  width: "100%",
                  border: "none",
                  outline: "none",
                  resize: "none",
                  padding: "14px 20px",
                  fontSize: 14,
                  fontFamily: "inherit",
                  lineHeight: 1.55,
                  color: "#333",
                  background: "#fff",
                  boxSizing: "border-box",
                }}
              />
            </>
          )
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#aaa",
              fontSize: 13,
            }}
          >
            Selecciona una nota o crea una nueva con ⌘N
          </div>
        )}
      </div>

      {/* Menú contextual */}
      {contextMenu && (
        <ContextMenu
          items={contextMenu.items}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Selector de carpeta */}
      {folderPicker && (
        <FolderPicker
          folders={folders}
          position={{ x: folderPicker.x, y: folderPicker.y }}
          onPick={(folderId) => {
            moveNote(folderPicker.note.id, folderId);
            setFolderPicker(null);
          }}
        />
      )}

      {/* Modal de contraseña */}
      {passwordModal && (
        <PasswordModal
          mode={passwordModal.mode}
          note={passwordModal.note}
          error={passwordError}
          onConfirm={confirmPassword}
          onCancel={() => {
            setPasswordModal(null);
            setPasswordError(false);
          }}
        />
      )}
    </div>
  );
}

export default Notes;
