// ============================================================================
// main.jsx — Entry point de la aplicación demo
// ----------------------------------------------------------------------------
// Monta <App /> en el DOM. Este archivo NO se publica en el paquete npm;
// solo se usa durante el desarrollo (npm run dev) y para los ejemplos.
//
// Responsabilidades:
//   1. Esperar a que el DOM esté listo
//   2. Crear el root de React 18 (concurrent mode)
//   3. Aplicar estilos globales mínimos (reset + fullscreen)
//   4. Montar <App />
//   5. Configurar el manejo de errores de React
//   6. Cargar el Service Worker si está disponible
//   7. Instalar el handler de unhandled rejection
//
// Si algo falla antes de montar, se muestra un fallback en el DOM.
// ============================================================================

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

// ============================================================================
// ESTILOS GLOBALES MÍNIMOS
// ----------------------------------------------------------------------------
// Todo el sistema usa estilos inline, pero necesitamos:
//   - reset de márgenes y padding
//   - overflow hidden para que el desktop no scrollee
//   - fuente del sistema
//   - user-select por defecto
// ============================================================================

const GLOBAL_CSS = `
  *, *::before, *::after {
    box-sizing: border-box;
  }
  html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    width: 100%;
    overflow: hidden;
    background: #000;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text",
                 "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    color: #fff;
  }
  #root {
    width: 100%;
    height: 100%;
    overflow: hidden;
    position: relative;
  }
  button {
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
  }
  input, textarea, select {
    font-family: inherit;
    font-size: inherit;
  }
  ::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }
  ::-webkit-scrollbar-track {
    background: transparent;
  }
  ::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.2);
    border-radius: 5px;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: rgba(255,255,255,0.35);
  }
  ::selection {
    background: rgba(10,132,255,0.4);
  }
  /* Deshabilitar el arrastre por defecto de imágenes */
  img {
    -webkit-user-drag: none;
    user-select: none;
  }
`;

function injectGlobalStyles() {
  if (typeof document === "undefined") return;
  const style = document.createElement("style");
  style.id = "rainos-global-styles";
  style.textContent = GLOBAL_CSS;
  document.head.appendChild(style);
}

// ============================================================================
// FALLBACK DE ERROR
// ----------------------------------------------------------------------------
// Si React falla antes de montar (raro pero posible), mostramos un mensaje.
// ============================================================================

function showFatalError(message, detail = "") {
  if (typeof document === "undefined") return;
  const root = document.getElementById("root") || document.body;
  root.innerHTML = `
    <div style="
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      background: #000;
      color: #fff;
      font-family: -apple-system, sans-serif;
      padding: 40px;
      text-align: center;
    ">
      <div style="font-size: 64px; margin-bottom: 20px;">⛔</div>
      <div style="font-size: 20px; font-weight: 600; margin-bottom: 12px;">
        rainOS no pudo arrancar
      </div>
      <div style="font-size: 14px; color: #888; max-width: 480px; line-height: 1.5;">
        ${escapeHtml(message)}
      </div>
      ${
        detail
          ? `<pre style="
              margin-top: 24px;
              padding: 12px 16px;
              background: rgba(255,255,255,0.05);
              border-radius: 8px;
              font-size: 11px;
              color: #f87171;
              max-width: 640px;
              overflow: auto;
              text-align: left;
            ">${escapeHtml(detail)}</pre>`
          : ""
      }
      <div style="font-size: 11px; color: #555; margin-top: 32px;">
        Reinicia la página o contacta con el desarrollador.
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================================================================
// ERROR BOUNDARY DE NIVEL SUPERIOR
// ----------------------------------------------------------------------------
// Captura errores de React y evita que la pantalla quede en blanco.
// ============================================================================

class RootErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo });
    // Log en consola para debugging
    // eslint-disable-next-line no-console
    console.error("[rainOS] Error capturado:", error, errorInfo);

    // Emitir al bus del kernel si está disponible
    try {
      if (typeof window !== "undefined" && window.__RAINOS_BUS__) {
        window.__RAINOS_BUS__.emit("kernel:fatal-error", {
          error: String(error),
          stack: errorInfo?.componentStack || null,
        });
      }
    } catch {
      /* noop */
    }
  }

  handleReload = () => {
    if (typeof window !== "undefined") window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            background: "#000",
            color: "#fff",
            fontFamily: "-apple-system, sans-serif",
            padding: 40,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 64, marginBottom: 20 }}>💥</div>
          <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 12 }}>
            rainOS encontró un error fatal
          </div>
          <div
            style={{
              fontSize: 14,
              color: "#888",
              maxWidth: 480,
              lineHeight: 1.5,
              marginBottom: 24,
            }}
          >
            {String(this.state.error?.message || this.state.error)}
          </div>
          {this.state.errorInfo?.componentStack && (
            <pre
              style={{
                padding: 12,
                background: "rgba(255,255,255,0.05)",
                borderRadius: 8,
                fontSize: 11,
                color: "#f87171",
                maxWidth: 640,
                maxHeight: 300,
                overflow: "auto",
                textAlign: "left",
              }}
            >
              {this.state.errorInfo.componentStack}
            </pre>
          )}
          <button
            onClick={this.handleReload}
            style={{
              marginTop: 24,
              padding: "10px 24px",
              borderRadius: 10,
              border: "none",
              background: "#0a84ff",
              color: "#fff",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Recargar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ============================================================================
// SERVICE WORKER
// ----------------------------------------------------------------------------
// Registra el SW si el navegador lo soporta y hay un archivo sw.js.
// El SW permite instalar la app como PWA y cachear assets.
// ============================================================================

async function registerServiceWorker() {
  if (
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator) ||
    typeof window === "undefined"
  ) {
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
    });
    return reg;
  } catch {
    // Silencioso: no todos los entornos tienen /sw.js
    return null;
  }
}

// ============================================================================
// HANDLER GLOBAL DE UNHANDLED REJECTIONS
// ============================================================================

function installGlobalHandlers() {
  if (typeof window === "undefined") return;

  const onRejection = (event) => {
    // eslint-disable-next-line no-console
    console.error("[rainOS] Promise rechazada sin catch:", event.reason);
  };

  const onError = (event) => {
    // No mostramos errores de recursos externos (favicons, etc.)
    if (event.target && event.target.tagName) return;
    // eslint-disable-next-line no-console
    console.error("[rainOS] Error global:", event.error || event.message);
  };

  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("error", onError);

  return () => {
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("error", onError);
  };
}

// ============================================================================
// BOOT
// ============================================================================

async function boot() {
  try {
    // 1. Inyectar estilos globales
    injectGlobalStyles();

    // 2. Instalar handlers globales
    installGlobalHandlers();

    // 3. Esperar a que el DOM esté listo
    if (document.readyState === "loading") {
      await new Promise((resolve) => {
        document.addEventListener("DOMContentLoaded", resolve, { once: true });
      });
    }

    // 4. Localizar el contenedor
    const container = document.getElementById("root");
    if (!container) {
      throw new Error(
        'No se encontró el elemento con id="root" en el DOM. Verifica tu index.html.'
      );
    }

    // 5. Crear el root de React 18
    const root = createRoot(container);

    // 6. Montar la app dentro del error boundary
    root.render(
      <React.StrictMode>
        <RootErrorBoundary>
          <App />
        </RootErrorBoundary>
      </React.StrictMode>
    );

    // 7. Registrar Service Worker (no bloquea)
    registerServiceWorker().catch(() => {});

    // 8. Exponer referencias para debugging en dev
    if (typeof window !== "undefined") {
      window.__RAINOS__ = {
        version: "0.1.0",
        mountedAt: Date.now(),
        container,
        root,
      };
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[rainOS] Boot failed:", err);
    showFatalError(err.message, err.stack);
  }
}

// Arrancar
boot();
