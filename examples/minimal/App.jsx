// ============================================================================
// examples/minimal/App.jsx — Minimal kernel demo
// ----------------------------------------------------------------------------
// Shows only the kernel: a few buttons that open windows and a simple
// window renderer built with useDraggable and useResizable.
// ============================================================================

import React from "react";
import {
  WindowManagerProvider,
  useWindowManager,
  useDraggable,
  useResizable,
  WINDOW_STATE,
  RESIZE_DIRS,
  TOP_RESERVED,
} from "../../src/kernel/kernel.jsx";

// ----------------------------------------------------------------------------
// A simple window chrome using the interaction hooks.
// ----------------------------------------------------------------------------

function Chrome({ win }) {
  const { close, toggleMinimize, toggleMaximize } = useWindowManager();
  const drag = useDraggable(win.id, { snap: true });

  const se = useResizable(win.id, "se");
  const e = useResizable(win.id, "e");
  const s = useResizable(win.id, "s");

  const isMax = win.state === WINDOW_STATE.MAXIMIZED;
  const isFull = win.state === WINDOW_STATE.FULLSCREEN;

  return (
    <div
      style={{
        position: "absolute",
        left: win.x,
        top: win.y,
        width: win.width,
        height: win.height,
        zIndex: win.zIndex,
        background: "rgba(240,240,240,0.92)",
        borderRadius: 12,
        boxShadow: "0 20px 50px rgba(0,0,0,0.35)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        backdropFilter: "blur(30px)",
        WebkitBackdropFilter: "blur(30px)",
      }}
    >
      {/* Titlebar */}
      <div
        onMouseDown={isMax || isFull ? undefined : drag.handleMouseDown}
        style={{
          height: 32,
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          background: "rgba(230,230,230,0.8)",
          borderBottom: "0.5px solid rgba(0,0,0,0.15)",
          cursor: isMax || isFull ? "default" : "grab",
          userSelect: "none",
        }}
      >
        <div style={{ display: "flex", gap: 8, width: 60 }}>
          <button
            onClick={() => close(win.id)}
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              border: "none",
              background: "#ff5f57",
              padding: 0,
              cursor: "pointer",
            }}
          />
          <button
            onClick={() => toggleMinimize(win.id)}
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              border: "none",
              background: "#febc2e",
              padding: 0,
              cursor: "pointer",
            }}
          />
          <button
            onClick={() => toggleMaximize(win.id)}
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              border: "none",
              background: "#28c840",
              padding: 0,
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
          }}
        >
          {win.title}
        </div>
        <div style={{ width: 60 }} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
        {win.component ? <win.component win={win} /> : null}
      </div>

      {/* Resize handles */}
      {!isMax && !isFull && (
        <>
          <div
            onMouseDown={se.handleMouseDown}
            style={{
              position: "absolute",
              right: 0,
              bottom: 0,
              width: 16,
              height: 16,
              cursor: "nwse-resize",
            }}
          />
          <div
            onMouseDown={e.handleMouseDown}
            style={{
              position: "absolute",
              right: 0,
              top: 32,
              bottom: 16,
              width: 6,
              cursor: "ew-resize",
            }}
          />
          <div
            onMouseDown={s.handleMouseDown}
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 16,
              height: 6,
              cursor: "ns-resize",
            }}
          />
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Window content examples
// ----------------------------------------------------------------------------

function SimpleContent({ win }) {
  return (
    <div>
      <p style={{ margin: 0, fontSize: 14 }}>
        Esta es la ventana <strong>#{win.id}</strong>.
      </p>
      <p style={{ fontSize: 13, opacity: 0.7 }}>
        Arrástrala por la barra de título y redimensiónala desde la esquina
        inferior derecha.
      </p>
      <ul style={{ fontSize: 13, opacity: 0.8 }}>
        <li>Posición: {Math.round(win.x)}, {Math.round(win.y)}</li>
        <li>Tamaño: {Math.round(win.width)}×{Math.round(win.height)}</li>
        <li>Estado: {win.state}</li>
        <li>z-index: {win.zIndex}</li>
      </ul>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Desktop
// ----------------------------------------------------------------------------

function Desktop() {
  const wm = useWindowManager();

  const openSimple = () => {
    wm.open({ title: "Ventana", component: SimpleContent });
  };

  const openFixed = () => {
    wm.open({
      title: "No redimensionable",
      component: SimpleContent,
      width: 480,
      height: 320,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
    });
  };

  const openCascade = () => {
    for (let i = 0; i < 5; i++) {
      wm.open({ title: `Cascada ${i + 1}`, component: SimpleContent });
    }
  };

  const closeAll = () => wm.closeAll();
  const minimizeAll = () => {
    wm.getVisibleWindows().forEach((w) => wm.minimize(w.id));
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background:
          "linear-gradient(135deg, #1e3a8a 0%, #6d28d9 50%, #db2777 100%)",
      }}
    >
      {/* Menu bar */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: TOP_RESERVED,
          background: "rgba(0,0,0,0.35)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          fontSize: 13,
          gap: 18,
          zIndex: 10000,
        }}
      >
        <span style={{ fontSize: 16 }}>&#63743;</span>
        <span>rainOS</span>
        <span style={{ opacity: 0.7 }}>Archivo</span>
        <span style={{ opacity: 0.7 }}>Editar</span>
        <span style={{ opacity: 0.7 }}>Ver</span>
        <div style={{ flex: 1 }} />
        <span style={{ opacity: 0.7 }}>
          {wm.count()} ventana{wm.count() === 1 ? "" : "s"}
        </span>
      </div>

      {/* Toolbar */}
      <div
        style={{
          position: "absolute",
          top: TOP_RESERVED + 16,
          left: 16,
          display: "flex",
          gap: 8,
          zIndex: 9999,
        }}
      >
        <Button onClick={openSimple}>Abrir ventana</Button>
        <Button onClick={openFixed}>No redimensionable</Button>
        <Button onClick={openCascade}>Cascada ×5</Button>
        <Button onClick={minimizeAll}>Minimizar todas</Button>
        <Button onClick={closeAll}>Cerrar todas</Button>
      </div>

      {/* Windows */}
      {wm.windows
        .filter((w) => w.state !== WINDOW_STATE.MINIMIZED)
        .map((win) => (
          <Chrome key={win.id} win={win} />
        ))}
    </div>
  );
}

function Button({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 14px",
        borderRadius: 8,
        border: "0.5px solid rgba(255,255,255,0.3)",
        background: "rgba(255,255,255,0.2)",
        color: "#fff",
        fontSize: 13,
        fontWeight: 500,
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

// ----------------------------------------------------------------------------
// App
// ----------------------------------------------------------------------------

export default function App() {
  return (
    <WindowManagerProvider>
      <Desktop />
    </WindowManagerProvider>
  );
}
