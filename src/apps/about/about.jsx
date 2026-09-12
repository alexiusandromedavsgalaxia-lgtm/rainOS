// ============================================================================
// about.jsx — Acerca de este rainOS
// ----------------------------------------------------------------------------
// Ventana "Acerca de" con la información del sistema. Estilo Apple.
// Contenido:
// - Logo de la manzana en grande
// - Nombre del sistema: rainOS
// - Versión del sistema (de updater.jsx)
// - Nombre del equipo (configurable)
// - Información del hardware simulado
// - Botón "Más información…" que abre Ajustes
// - Créditos y licencia
// - Todo con estilos inline
// ============================================================================

import React from "react";
import { useUpdater, SYSTEM_VERSION } from "../../updater/updater.jsx";
import { useInitialConfig } from "../../initialconfig/initialconfig.jsx";
import { useWindowManager } from "../../kernel/kernel.jsx";

// ============================================================================
// LOGO APPLE
// ============================================================================

function AppleLogo({ size = 120, color = "#333" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 814 1000"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <path
        fill={color}
        d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"
      />
    </svg>
  );
}

// ============================================================================
// COMPONENTES AUXILIARES
// ============================================================================

function InfoRow({ label, value }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 16,
        padding: "6px 0",
        fontSize: 12,
      }}
    >
      <span style={{ color: "#888", flexShrink: 0 }}>{label}</span>
      <span
        style={{
          color: "#333",
          textAlign: "right",
          wordBreak: "break-word",
          fontWeight: 500,
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ============================================================================
// ABOUT
// ============================================================================

export function About() {
  const updater = useUpdater?.() ?? null;
  const config = useInitialConfig?.() ?? null;
  const wm = useWindowManager();

  const currentVersion = updater?.currentVersion || SYSTEM_VERSION;
  const channel = updater?.settings?.channel || "stable";

  const deviceName = config?.values?.hostname || "rainOS";

  // Botón "Más información" → abre Ajustes en la pestaña General
  const openSettings = () => {
    // Buscar una ventana de Ajustes ya abierta
    const existing = wm.windows.find((w) => w.appId === "settings");
    if (existing) {
      wm.focus(existing.id);
      return;
    }
    // Si no hay, intentamos abrir vía evento (el sistema lo captura)
    try {
      window.dispatchEvent(
        new CustomEvent("rainos:open-app", { detail: { appId: "settings" } })
      );
    } catch {
      /* noop */
    }
  };

  return (
    <div
      style={{
        height: "100%",
        background:
          "linear-gradient(180deg, #fbfbfd 0%, #f5f5f7 100%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
        color: "#333",
        fontFamily:
          '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
        userSelect: "none",
      }}
    >
      {/* Logo */}
      <div style={{ marginBottom: 20 }}>
        <AppleLogo size={96} color="#333" />
      </div>

      {/* Nombre + versión */}
      <div
        style={{
          textAlign: "center",
          marginBottom: 24,
        }}
      >
        <div
          style={{
            fontSize: 32,
            fontWeight: 300,
            letterSpacing: "-0.02em",
            color: "#1d1d1f",
            marginBottom: 4,
          }}
        >
          rainOS
        </div>
        <div
          style={{
            fontSize: 14,
            color: "#6e6e73",
            letterSpacing: "0.01em",
          }}
        >
          Versión {currentVersion}
          {channel !== "stable" ? ` (${channel})` : ""}
        </div>
      </div>

      {/* Info técnica */}
      <div
        style={{
          background: "rgba(0,0,0,0.03)",
          borderRadius: 12,
          padding: "16px 20px",
          width: "100%",
          maxWidth: 420,
          marginBottom: 20,
        }}
      >
        <InfoRow label="Equipo" value={deviceName} />
        <InfoRow label="Modelo" value="rainOS Virtual Machine" />
        <InfoRow label="Chip" value="React Virtual x86_64" />
        <InfoRow label="Memoria" value="4 GB" />
        <InfoRow label="Núcleos" value="8 vCPU" />
        <InfoRow label="Gráficos" value="Virtual Renderer 1024 MB" />
        <InfoRow label="Serial" value="RN0S-2026-09-11" />
      </div>

      {/* Texto legal */}
      <div
        style={{
          fontSize: 11,
          color: "#86868b",
          textAlign: "center",
          maxWidth: 420,
          lineHeight: 1.5,
          marginBottom: 20,
        }}
      >
        rainOS es un kernel de sistema operativo escrito en React.
        Este es un proyecto educativo y no está afiliado con Apple Inc.
        Todas las marcas registradas pertenecen a sus respectivos dueños.
      </div>

      {/* Botón */}
      <button
        onClick={openSettings}
        style={{
          padding: "8px 20px",
          borderRadius: 10,
          border: "none",
          background: "#0a84ff",
          color: "#fff",
          fontSize: 13,
          fontWeight: 500,
          cursor: "pointer",
          fontFamily: "inherit",
          marginBottom: 24,
        }}
      >
        Más información…
      </button>

      {/* Footer con copyright */}
      <div
        style={{
          position: "absolute",
          bottom: 16,
          fontSize: 10,
          color: "#aeaeb2",
          textAlign: "center",
          width: "100%",
        }}
      >
        © 2026 rainOS Project · MIT License
      </div>
    </div>
  );
}

export default About;
