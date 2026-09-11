// ============================================================================
// settings.jsx — Ajustes del Sistema de rainOS
// ----------------------------------------------------------------------------
// Panel completo de preferencias del sistema. Secciones:
//
// 1. GENERAL
//    - Información del sistema
//    - Nombre del equipo
//    - Idioma y región
//
// 2. APARIENCIA
//    - Modo claro / oscuro / auto
//    - Color de acento
//    - Fondo de pantalla
//    - Transparencia, reducir movimiento, aumentar contraste
//
// 3. ESCRITORIO Y DOCK
//    - Posición del dock
//    - Tamaño del dock
//    - Magnificación
//    - Ocultar automáticamente
//    - Efecto de minimización
//
// 4. ACCESIBILIDAD
//    - Zoom, VoiceOver, subtítulos, contraste
//
// 5. ACTUALIZACIÓN DE SOFTWARE  ← integración con updater.jsx
//    - Actualizaciones automáticas
//    - Canal (stable / beta / dev)
//    - Buscar ahora
//    - Estado actual, versión disponible, changelog
//    - Descargar / Instalar / Reiniciar
//    - Historial de actualizaciones
//
// 6. PRIVACIDAD Y SEGURIDAD
//    - Analíticas, ubicación, Siri, publicidad
//
// 7. RED
//    - Wi-Fi, Ethernet, DNS, hostname
//
// 8. BLUETOOTH
//    - Dispositivos conectados
//
// 9. USUARIOS Y GRUPOS
//    - Cuenta actual, cambiar foto, contraseña
//
// 10. BATERÍA
//     - Estado, ciclos, salud
//
// 11. ALMACENAMIENTO
//     - Uso de disco por categoría
//
// Layout: sidebar con secciones + panel de contenido.
// Todo con estilos inline.
// ============================================================================

import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
} from "react";

import { useWindowManager } from "../../kernel/kernel.jsx";
import { useUpdater, UPDATE_STATE, UPDATE_CHANNEL, SYSTEM_VERSION } from "../../updater/updater.jsx";
import { useInitialConfig } from "../../initialconfig/initialconfig.jsx";
import { useAppInstaller } from "../../appinstaller/appinstaller.jsx";
import { toast } from "../../toast/toast.jsx";

// ============================================================================
// SECCIONES
// ============================================================================

const SECTIONS = [
  { id: "general", name: "General", icon: "⚙️" },
  { id: "appearance", name: "Apariencia", icon: "🎨" },
  { id: "desktop", name: "Escritorio y Dock", icon: "🖥️" },
  { id: "accessibility", name: "Accesibilidad", icon: "♿" },
  { id: "updates", name: "Actualización de software", icon: "⬇️" },
  { id: "privacy", name: "Privacidad y seguridad", icon: "🔒" },
  { id: "network", name: "Red", icon: "📶" },
  { id: "bluetooth", name: "Bluetooth", icon: "🎧" },
  { id: "users", name: "Usuarios y grupos", icon: "👤" },
  { id: "battery", name: "Batería", icon: "🔋" },
  { id: "storage", name: "Almacenamiento", icon: "💽" },
];

// ============================================================================
// HELPERS UI
// ============================================================================

function SectionTitle({ children }) {
  return (
    <h2
      style={{
        fontSize: 15,
        fontWeight: 600,
        color: "#333",
        margin: "0 0 4px 0",
      }}
    >
      {children}
    </h2>
  );
}

function SectionDescription({ children }) {
  return (
    <p
      style={{
        fontSize: 12,
        color: "#777",
        margin: "0 0 16px 0",
        lineHeight: 1.5,
      }}
    >
      {children}
    </p>
  );
}

function Row({ label, description, children, align = "center" }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: align,
        justifyContent: "space-between",
        gap: 20,
        padding: "12px 0",
        borderBottom: "0.5px solid rgba(0,0,0,0.06)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "#333" }}>
          {label}
        </div>
        {description && (
          <div
            style={{
              fontSize: 11,
              color: "#888",
              marginTop: 2,
              lineHeight: 1.4,
            }}
          >
            {description}
          </div>
        )}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

function Toggle({ value, onChange, disabled }) {
  return (
    <button
      onClick={() => !disabled && onChange(!value)}
      disabled={disabled}
      style={{
        width: 44,
        height: 26,
        borderRadius: 13,
        border: "none",
        background: value ? "#0a84ff" : "rgba(0,0,0,0.18)",
        cursor: disabled ? "default" : "pointer",
        position: "relative",
        transition: "background 0.15s ease-out",
        opacity: disabled ? 0.5 : 1,
        padding: 0,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 2,
          left: value ? 20 : 2,
          width: 22,
          height: 22,
          borderRadius: 11,
          background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
          transition: "left 0.15s ease-out",
        }}
      />
    </button>
  );
}

function Select({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: "6px 10px",
        borderRadius: 6,
        border: "1px solid rgba(0,0,0,0.15)",
        background: "#fff",
        fontSize: 12,
        color: "#333",
        outline: "none",
        cursor: "pointer",
        fontFamily: "inherit",
        minWidth: 160,
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Slider({ value, onChange, min = 0, max = 1, step = 0.01 }) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      style={{
        width: 160,
        accentColor: "#0a84ff",
      }}
    />
  );
}

function Button({ children, onClick, primary, danger, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "6px 14px",
        borderRadius: 8,
        border: primary
          ? "none"
          : danger
          ? "1px solid rgba(211,47,47,0.3)"
          : "1px solid rgba(0,0,0,0.15)",
        background: primary
          ? "#0a84ff"
          : danger
          ? "rgba(211,47,47,0.08)"
          : "transparent",
        color: primary ? "#fff" : danger ? "#d32f2f" : "#333",
        fontSize: 13,
        fontWeight: primary ? 500 : 400,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}

function Card({ children }) {
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 12,
        padding: 18,
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        marginBottom: 16,
      }}
    >
      {children}
    </div>
  );
}

// ============================================================================
// SECCIONES DE CONTENIDO
// ============================================================================

function GeneralSection({ config, setValue }) {
  return (
    <>
      <SectionTitle>General</SectionTitle>
      <SectionDescription>
        Información del sistema, nombre del equipo e idioma.
      </SectionDescription>

      <Card>
        <Row label="Nombre del equipo" description="El nombre visible en la red local.">
          <input
            type="text"
            defaultValue="rainOS"
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid rgba(0,0,0,0.15)",
              fontSize: 12,
              outline: "none",
              width: 200,
              fontFamily: "inherit",
            }}
          />
        </Row>
        <Row label="Versión del sistema" description="rainOS kernel build">
          <span style={{ fontSize: 13, color: "#333", fontWeight: 500 }}>
            {SYSTEM_VERSION}
          </span>
        </Row>
        <Row label="Idioma">
          <Select
            value={config.language}
            onChange={(v) => setValue("language", v)}
            options={[
              { value: "es-ES", label: "Español (España)" },
              { value: "es-MX", label: "Español (México)" },
              { value: "en-US", label: "English (US)" },
              { value: "en-GB", label: "English (UK)" },
              { value: "fr-FR", label: "Français" },
              { value: "de-DE", label: "Deutsch" },
            ]}
          />
        </Row>
        <Row label="Región">
          <Select
            value={config.region}
            onChange={(v) => setValue("region", v)}
            options={[
              { value: "ES", label: "España" },
              { value: "MX", label: "México" },
              { value: "AR", label: "Argentina" },
              { value: "US", label: "Estados Unidos" },
              { value: "GB", label: "Reino Unido" },
            ]}
          />
        </Row>
        <Row label="Formato de fecha" last>
          <Select
            value={config.dateFormat}
            onChange={(v) => setValue("dateFormat", v)}
            options={[
              { value: "DD/MM/YYYY", label: "31/12/2026" },
              { value: "MM/DD/YYYY", label: "12/31/2026" },
              { value: "YYYY-MM-DD", label: "2026-12-31" },
            ]}
          />
        </Row>
      </Card>
    </>
  );
}

function AppearanceSection({ config, setValue }) {
  const appearance = config.appearance;
  return (
    <>
      <SectionTitle>Apariencia</SectionTitle>
      <SectionDescription>
        Personaliza el aspecto visual del sistema.
      </SectionDescription>

      <Card>
        <Row label="Modo de apariencia">
          <div style={{ display: "flex", gap: 6 }}>
            {["light", "dark", "auto"].map((mode) => (
              <button
                key={mode}
                onClick={() => setValue("appearance.theme", mode)}
                style={{
                  padding: "6px 14px",
                  borderRadius: 8,
                  border:
                    appearance.theme === mode
                      ? "2px solid #0a84ff"
                      : "1px solid rgba(0,0,0,0.15)",
                  background:
                    appearance.theme === mode ? "rgba(10,132,255,0.08)" : "#fff",
                  fontSize: 12,
                  cursor: "pointer",
                  color: "#333",
                  fontFamily: "inherit",
                }}
              >
                {mode === "light" ? "Claro" : mode === "dark" ? "Oscuro" : "Auto"}
              </button>
            ))}
          </div>
        </Row>

        <Row label="Color de acento">
          <div style={{ display: "flex", gap: 8 }}>
            {[
              { id: "blue", hex: "#0a84ff" },
              { id: "purple", hex: "#bf5af2" },
              { id: "pink", hex: "#ff375f" },
              { id: "red", hex: "#ff453a" },
              { id: "orange", hex: "#ff9f0a" },
              { id: "yellow", hex: "#ffd60a" },
              { id: "green", hex: "#32d74b" },
              { id: "graphite", hex: "#8e8e93" },
            ].map((c) => (
              <button
                key={c.id}
                onClick={() => setValue("appearance.accent", c.id)}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  border:
                    appearance.accent === c.id
                      ? "2px solid #333"
                      : "2px solid transparent",
                  background: c.hex,
                  cursor: "pointer",
                  padding: 0,
                }}
              />
            ))}
          </div>
        </Row>

        <Row label="Fondo de pantalla">
          <Select
            value={appearance.wallpaper}
            onChange={(v) => setValue("appearance.wallpaper", v)}
            options={[
              { value: "sonoma", label: "Sonoma" },
              { value: "ventura", label: "Ventura" },
              { value: "monterey", label: "Monterey" },
              { value: "bigsur", label: "Big Sur" },
              { value: "graphite", label: "Grafito" },
              { value: "midnight", label: "Medianoche" },
              { value: "snow", label: "Nieve" },
            ]}
          />
        </Row>

        <Row label="Transparencia">
          <Toggle
            value={appearance.transparency}
            onChange={(v) => setValue("appearance.transparency", v)}
          />
        </Row>

        <Row label="Reducir movimiento">
          <Toggle
            value={appearance.reduceMotion}
            onChange={(v) => setValue("appearance.reduceMotion", v)}
          />
        </Row>

        <Row label="Aumentar contraste" last>
          <Toggle
            value={appearance.increaseContrast}
            onChange={(v) => setValue("appearance.increaseContrast", v)}
          />
        </Row>
      </Card>
    </>
  );
}

function DesktopDockSection({ config, setValue }) {
  const dock = config.dock;
  return (
    <>
      <SectionTitle>Escritorio y Dock</SectionTitle>
      <SectionDescription>
        Configura el dock, la barra de menús y el escritorio.
      </SectionDescription>

      <Card>
        <Row label="Posición del Dock">
          <Select
            value={dock.position}
            onChange={(v) => setValue("dock.position", v)}
            options={[
              { value: "bottom", label: "Abajo" },
              { value: "left", label: "Izquierda" },
              { value: "right", label: "Derecha" },
            ]}
          />
        </Row>
        <Row label="Tamaño del Dock">
          <Select
            value={dock.size}
            onChange={(v) => setValue("dock.size", v)}
            options={[
              { value: "small", label: "Pequeño" },
              { value: "medium", label: "Mediano" },
              { value: "large", label: "Grande" },
            ]}
          />
        </Row>
        <Row label="Magnificación" description="Ampliar iconos al pasar el ratón">
          <Toggle
            value={dock.magnification}
            onChange={(v) => setValue("dock.magnification", v)}
          />
        </Row>
        <Row label="Cantidad de magnificación">
          <Slider
            value={dock.magnificationAmount}
            onChange={(v) => setValue("dock.magnificationAmount", v)}
            min={1}
            max={2}
            step={0.05}
          />
        </Row>
        <Row label="Ocultar y mostrar automáticamente">
          <Toggle
            value={dock.autohide}
            onChange={(v) => setValue("dock.autohide", v)}
          />
        </Row>
        <Row label="Efecto de minimización" last>
          <Select
            value={dock.minimizeEffect}
            onChange={(v) => setValue("dock.minimizeEffect", v)}
            options={[
              { value: "genie", label: "Genio" },
              { value: "scale", label: "Escala" },
              { value: "suck", label: "Aspirar" },
            ]}
          />
        </Row>
      </Card>
    </>
  );
}

function AccessibilitySection({ config, setValue }) {
  return (
    <>
      <SectionTitle>Accesibilidad</SectionTitle>
      <SectionDescription>
        Ajustes de visión, audición y motricidad.
      </SectionDescription>

      <Card>
        <Row label="VoiceOver" description="Lector de pantalla">
          <Toggle value={false} onChange={() => {}} />
        </Row>
        <Row label="Zoom" description="Ampliar la pantalla al hacer zoom">
          <Toggle value={false} onChange={() => {}} />
        </Row>
        <Row label="Subtítulos">
          <Toggle value={false} onChange={() => {}} />
        </Row>
        <Row label="Reducir transparencias">
          <Toggle
            value={!config.appearance.transparency}
            onChange={(v) => setValue("appearance.transparency", !v)}
          />
        </Row>
        <Row label="Aumentar contraste" last>
          <Toggle
            value={config.appearance.increaseContrast}
            onChange={(v) => setValue("appearance.increaseContrast", v)}
          />
        </Row>
      </Card>
    </>
  );
}

// ============================================================================
// SECCIÓN DE ACTUALIZACIONES — la más importante
// ============================================================================

function UpdatesSection() {
  const updater = useUpdater();

  const {
    state,
    currentVersion,
    availableVersion,
    availableManifest,
    pendingUpdate,
    progress,
    phase,
    error,
    settings,
    lastCheck,
    history,
    check,
    download,
    cancelDownload,
    apply,
    setSettings,
    clearHistory,
    isChecking,
    isAvailable,
    isDownloading,
    isReady,
    isApplying,
    hasUpdate,
    canApply,
  } = updater;

  const formatDate = (ts) => {
    if (!ts) return "nunca";
    const d = new Date(ts);
    return d.toLocaleString("es-ES", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const statusText = useMemo(() => {
    if (isChecking) return "Buscando actualizaciones…";
    if (isAvailable) return `Actualización disponible: ${availableVersion}`;
    if (isDownloading) return `Descargando… ${progress}%`;
    if (isReady) return "Lista para instalar";
    if (isApplying) return `Instalando… ${progress}%`;
    if (state === UPDATE_STATE.NOT_AVAILABLE)
      return "Tu sistema está actualizado";
    if (state === UPDATE_STATE.APPLIED) return "Actualización aplicada";
    if (state === UPDATE_STATE.FAILED) return `Error: ${error}`;
    return "Listo para comprobar";
  }, [state, isChecking, isAvailable, isDownloading, isReady, isApplying, progress, availableVersion, error]);

  const statusColor = useMemo(() => {
    if (state === UPDATE_STATE.FAILED) return "#ff453a";
    if (isAvailable) return "#0a84ff";
    if (isReady) return "#32d74b";
    if (isApplying || isDownloading) return "#ff9f0a";
    return "#666";
  }, [state, isAvailable, isReady, isApplying, isDownloading]);

  return (
    <>
      <SectionTitle>Actualización de software</SectionTitle>
      <SectionDescription>
        Mantén rainOS al día. Las actualizaciones se descargan en segundo plano
        y se aplican sin interrumpir tu trabajo.
      </SectionDescription>

      {/* Estado actual */}
      <Card>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              background:
                state === UPDATE_STATE.FAILED
                  ? "rgba(255,69,58,0.15)"
                  : isAvailable
                  ? "rgba(10,132,255,0.15)"
                  : isReady
                  ? "rgba(50,215,75,0.15)"
                  : "rgba(0,0,0,0.06)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 24,
            }}
          >
            {state === UPDATE_STATE.FAILED ? "⚠️" : isAvailable ? "⬇️" : isReady ? "✅" : "🔄"}
          </div>
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: statusColor,
              }}
            >
              {statusText}
            </div>
            <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
              Versión actual: <strong>{currentVersion}</strong>
              {" · "}
              Última comprobación: {formatDate(lastCheck)}
            </div>
          </div>
        </div>

        {/* Barra de progreso cuando descarga o aplica */}
        {(isDownloading || isApplying) && (
          <div
            style={{
              marginTop: 14,
              height: 6,
              background: "rgba(0,0,0,0.08)",
              borderRadius: 3,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${progress}%`,
                background: "#0a84ff",
                transition: "width 0.25s ease-out",
              }}
            />
          </div>
        )}

        {/* Changelog si hay actualización */}
        {isAvailable && availableManifest && (
          <div
            style={{
              marginTop: 16,
              padding: 12,
              background: "rgba(10,132,255,0.06)",
              borderRadius: 8,
              border: "1px solid rgba(10,132,255,0.15)",
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "#0a84ff",
                marginBottom: 6,
              }}
            >
              Novedades en {availableVersion}
            </div>
            <div
              style={{
                fontSize: 12,
                color: "#555",
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
              }}
            >
              {availableManifest.notes || "Sin notas de esta versión."}
            </div>
          </div>
        )}

        {/* Botones de acción */}
        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 16,
            justifyContent: "flex-end",
          }}
        >
          {isDownloading && (
            <Button onClick={cancelDownload}>Cancelar descarga</Button>
          )}
          {!isDownloading && !isApplying && (
            <Button onClick={() => check({ force: true })} disabled={isChecking}>
              {isChecking ? "Buscando…" : "Buscar actualizaciones"}
            </Button>
          )}
          {isAvailable && !isDownloading && !isReady && (
            <Button primary onClick={() => download(availableManifest)}>
              Descargar
            </Button>
          )}
          {canApply && !isApplying && (
            <Button
              primary
              onClick={() => apply(pendingUpdate || availableManifest)}
            >
              Instalar ahora
            </Button>
          )}
        </div>
      </Card>

      {/* Configuración */}
      <Card>
        <Row
          label="Buscar actualizaciones automáticamente"
          description="Comprueba si hay nuevas versiones al iniciar sesión."
        >
          <Toggle
            value={settings.autoCheck}
            onChange={(v) => setSettings({ autoCheck: v })}
          />
        </Row>
        <Row
          label="Descargar automáticamente"
          description="Descarga las actualizaciones en segundo plano."
        >
          <Toggle
            value={settings.autoDownload}
            onChange={(v) => setSettings({ autoDownload: v })}
          />
        </Row>
        <Row
          label="Instalar automáticamente"
          description="Aplica las actualizaciones sin pedir confirmación."
        >
          <Toggle
            value={settings.autoInstall}
            onChange={(v) => setSettings({ autoInstall: v })}
          />
        </Row>
        <Row
          label="Canal de actualización"
          description="Los canales beta y dev reciben versiones de prueba con posibles errores."
        >
          <Select
            value={settings.channel}
            onChange={(v) => setSettings({ channel: v })}
            options={[
              { value: UPDATE_CHANNEL.STABLE, label: "Estable" },
              { value: UPDATE_CHANNEL.BETA, label: "Beta" },
              { value: UPDATE_CHANNEL.DEV, label: "Desarrollo" },
            ]}
          />
        </Row>
        <Row
          label="Permitir rollback"
          description="Vuelve a la versión anterior si la actualización falla."
          last
        >
          <Toggle
            value={settings.allowRollback}
            onChange={(v) => setSettings({ allowRollback: v })}
          />
        </Row>
      </Card>

      {/* Historial */}
      <Card>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "#333" }}>
            Historial de actualizaciones
          </div>
          {history.length > 0 && (
            <Button danger onClick={clearHistory}>
              Borrar historial
            </Button>
          )}
        </div>

        {history.length === 0 ? (
          <div
            style={{
              fontSize: 12,
              color: "#aaa",
              textAlign: "center",
              padding: "16px 0",
            }}
          >
            No hay actualizaciones registradas
          </div>
        ) : (
          history.map((h, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "10px 0",
                borderBottom:
                  i < history.length - 1
                    ? "0.5px solid rgba(0,0,0,0.06)"
                    : "none",
                fontSize: 13,
              }}
            >
              <div>
                <div style={{ fontWeight: 500, color: "#333" }}>
                  {h.from} → {h.to}
                </div>
                <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
                  {formatDate(h.ts)}
                  {h.channel && ` · ${h.channel}`}
                </div>
              </div>
              <span
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 10,
                  background: "rgba(50,215,75,0.15)",
                  color: "#1d8a3a",
                  fontWeight: 500,
                }}
              >
                instalada
              </span>
            </div>
          ))
        )}
      </Card>
    </>
  );
}

function PrivacySection({ config, setValue }) {
  const privacy = config.privacy;
  return (
    <>
      <SectionTitle>Privacidad y seguridad</SectionTitle>
      <SectionDescription>
        Controla qué datos comparte el sistema con terceros.
      </SectionDescription>

      <Card>
        <Row
          label="Analíticas"
          description="Ayúdanos a mejorar rainOS enviando datos anónimos de uso."
        >
          <Toggle
            value={privacy.analytics}
            onChange={(v) => setValue("privacy.analytics", v)}
          />
        </Row>
        <Row
          label="Servicios de ubicación"
          description="Permite que las apps accedan a tu ubicación."
        >
          <Toggle
            value={privacy.location}
            onChange={(v) => setValue("privacy.location", v)}
          />
        </Row>
        <Row label="Siri y dictado">
          <Toggle
            value={privacy.siri}
            onChange={(v) => setValue("privacy.siri", v)}
          />
        </Row>
        <Row label="Publicidad personalizada">
          <Toggle
            value={privacy.personalizedAds}
            onChange={(v) => setValue("privacy.personalizedAds", v)}
          />
        </Row>
        <Row label="Enviar informes de fallos" last>
          <Toggle
            value={privacy.crashReports}
            onChange={(v) => setValue("privacy.crashReports", v)}
          />
        </Row>
      </Card>
    </>
  );
}

function NetworkSection() {
  return (
    <>
      <SectionTitle>Red</SectionTitle>
      <SectionDescription>
        Configuración de conexiones Wi-Fi, Ethernet y VPN.
      </SectionDescription>

      <Card>
        <Row label="Wi-Fi" description="rainOS-Network · Conectado">
          <Toggle value={true} onChange={() => {}} />
        </Row>
        <Row label="Ethernet" description="No conectado">
          <Toggle value={false} onChange={() => {}} />
        </Row>
        <Row label="Firewall">
          <Toggle value={true} onChange={() => {}} />
        </Row>
        <Row label="VPN" last>
          <Button>Configurar…</Button>
        </Row>
      </Card>
    </>
  );
}

function BluetoothSection() {
  const devices = [
    { name: "AirPods Pro", icon: "🎧", connected: true, battery: 82 },
    { name: "Magic Mouse", icon: "🖱️", connected: true, battery: 45 },
    { name: "Magic Keyboard", icon: "⌨️", connected: false, battery: 90 },
  ];
  return (
    <>
      <SectionTitle>Bluetooth</SectionTitle>
      <SectionDescription>
        Dispositivos inalámbricos conectados a rainOS.
      </SectionDescription>

      <Card>
        <Row label="Bluetooth">
          <Toggle value={true} onChange={() => {}} />
        </Row>
      </Card>

      <Card>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "#666",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            marginBottom: 10,
          }}
        >
          Dispositivos
        </div>
        {devices.map((d, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 0",
              borderBottom:
                i < devices.length - 1
                  ? "0.5px solid rgba(0,0,0,0.06)"
                  : "none",
            }}
          >
            <div style={{ fontSize: 26 }}>{d.icon}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "#333" }}>
                {d.name}
              </div>
              <div style={{ fontSize: 11, color: "#888" }}>
                {d.connected ? "Conectado" : "No conectado"} · 🔋 {d.battery}%
              </div>
            </div>
            <Button>{d.connected ? "Desconectar" : "Conectar"}</Button>
          </div>
        ))}
      </Card>
    </>
  );
}

function UsersSection({ config }) {
  const account = config.account;
  return (
    <>
      <SectionTitle>Usuarios y grupos</SectionTitle>
      <SectionDescription>
        Gestiona las cuentas de usuario del sistema.
      </SectionDescription>

      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 32,
              background: "rgba(0,0,0,0.08)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 28,
            }}
          >
            👤
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#333" }}>
              {account.fullName || "Usuario"}
            </div>
            <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
              {account.shortName || "usuario"} · Administrador
            </div>
          </div>
          <Button>Cambiar foto</Button>
        </div>

        <div style={{ marginTop: 16 }}>
          <Row label="Cambiar contraseña">
            <Button>Cambiar…</Button>
          </Row>
          <Row label="Touch ID">
            <Toggle
              value={account.touchId}
              onChange={() => {}}
            />
          </Row>
          <Row label="Inicio de sesión automático">
            <Toggle value={false} onChange={() => {}} />
          </Row>
          <Row label="Bloqueo al salir de la pantalla de inicio de sesión" last>
            <Toggle value={true} onChange={() => {}} />
          </Row>
        </div>
      </Card>
    </>
  );
}

function BatterySection() {
  return (
    <>
      <SectionTitle>Batería</SectionTitle>
      <SectionDescription>
        Estado de la batería y consumo de energía.
      </SectionDescription>

      <Card>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
            marginBottom: 16,
          }}
        >
          <div
            style={{
              width: 80,
              height: 120,
              border: "2px solid #333",
              borderRadius: 12,
              position: "relative",
              padding: 4,
            }}
          >
            <div
              style={{
                position: "absolute",
                top: -4,
                left: "50%",
                transform: "translateX(-50%)",
                width: 20,
                height: 4,
                background: "#333",
                borderRadius: "2px 2px 0 0",
              }}
            />
            <div
              style={{
                width: "100%",
                height: "82%",
                background: "linear-gradient(180deg, #32d74b, #1d8a3a)",
                borderRadius: 8,
                position: "absolute",
                bottom: 4,
                left: 4,
                right: 4,
              }}
            />
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 22,
                fontWeight: 600,
                color: "#fff",
                textShadow: "0 1px 3px rgba(0,0,0,0.4)",
              }}
            >
              82%
            </div>
          </div>
          <div style={{ fontSize: 13, color: "#555", lineHeight: 1.7 }}>
            <div>
              <strong>Estado:</strong> En uso
            </div>
            <div>
              <strong>Ciclos:</strong> 128
            </div>
            <div>
              <strong>Salud:</strong> 94 %
            </div>
            <div>
              <strong>Tiempo restante:</strong> 4 h 12 min
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <Row label="Modo de bajo consumo">
          <Toggle value={false} onChange={() => {}} />
        </Row>
        <Row label="Optimización de carga">
          <Toggle value={true} onChange={() => {}} />
        </Row>
        <Row label="Mostrar porcentaje en la barra de menús" last>
          <Toggle value={true} onChange={() => {}} />
        </Row>
      </Card>
    </>
  );
}

function StorageSection() {
  const usage = [
    { name: "Aplicaciones", size: "12,4 GB", color: "#0a84ff" },
    { name: "Documentos", size: "8,7 GB", color: "#32d74b" },
    { name: "Fotos", size: "15,2 GB", color: "#ff9f0a" },
    { name: "Música", size: "6,1 GB", color: "#bf5af2" },
    { name: "Películas", size: "22,3 GB", color: "#ff375f" },
    { name: "Sistema", size: "18,0 GB", color: "#8e8e93" },
    { name: "Otro", size: "5,4 GB", color: "#a0aec0" },
  ];

  const total = 88.1;
  const capacity = 128;

  return (
    <>
      <SectionTitle>Almacenamiento</SectionTitle>
      <SectionDescription>
        Uso del disco Macintosh HD. {capacity - total} GB disponibles de {capacity} GB.
      </SectionDescription>

      <Card>
        <div
          style={{
            height: 24,
            borderRadius: 6,
            overflow: "hidden",
            display: "flex",
            marginBottom: 16,
          }}
        >
          {usage.map((u, i) => {
            const pct = (parseFloat(u.size) / capacity) * 100;
            return (
              <div
                key={i}
                title={`${u.name}: ${u.size}`}
                style={{
                  width: `${pct}%`,
                  background: u.color,
                }}
              />
            );
          })}
          <div
            style={{
              flex: 1,
              background: "rgba(0,0,0,0.05)",
            }}
          />
        </div>

        {usage.map((u, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 0",
              fontSize: 13,
              borderBottom:
                i < usage.length - 1
                  ? "0.5px solid rgba(0,0,0,0.06)"
                  : "none",
            }}
          >
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                background: u.color,
              }}
            />
            <div style={{ flex: 1, color: "#333" }}>{u.name}</div>
            <div style={{ color: "#888", fontFamily: "monospace" }}>
              {u.size}
            </div>
          </div>
        ))}
      </Card>
    </>
  );
}

// ============================================================================
// SETTINGS — componente raíz
// ============================================================================

export function Settings({ win }) {
  const wm = useWindowManager();
  const initialConfig = useInitialConfig?.() ?? null;

  const [section, setSection] = useState("general");
  const [search, setSearch] = useState("");

  // Fallback local si no hay InitialConfigProvider
  const configFallback = useMemo(
    () => ({
      language: "es-ES",
      region: "ES",
      dateFormat: "DD/MM/YYYY",
      appearance: {
        theme: "auto",
        accent: "blue",
        wallpaper: "sonoma",
        transparency: true,
        reduceMotion: false,
        increaseContrast: false,
      },
      dock: {
        position: "bottom",
        size: "medium",
        magnification: true,
        magnificationAmount: 1.35,
        autohide: false,
        minimizeEffect: "genie",
      },
      privacy: {
        analytics: false,
        location: false,
        siri: false,
        personalizedAds: false,
        crashReports: true,
      },
      account: {
        fullName: "Usuario",
        shortName: "usuario",
        touchId: false,
      },
    }),
    []
  );

  const config = initialConfig?.values || configFallback;

  const setValue = useCallback(
    (path, value) => {
      if (initialConfig?.setValue) {
        initialConfig.setValue(path, value);
      } else {
        console.log("[settings] setValue (fallback):", path, "=", value);
      }
    },
    [initialConfig]
  );

  // Filtrado de secciones por búsqueda
  const visibleSections = useMemo(() => {
    if (!search.trim()) return SECTIONS;
    const q = search.toLowerCase();
    return SECTIONS.filter((s) => s.name.toLowerCase().includes(q));
  }, [search]);

  // Render de la sección activa
  const renderSection = () => {
    switch (section) {
      case "general":
        return <GeneralSection config={config} setValue={setValue} />;
      case "appearance":
        return <AppearanceSection config={config} setValue={setValue} />;
      case "desktop":
        return <DesktopDockSection config={config} setValue={setValue} />;
      case "accessibility":
        return <AccessibilitySection config={config} setValue={setValue} />;
      case "updates":
        return <UpdatesSection />;
      case "privacy":
        return <PrivacySection config={config} setValue={setValue} />;
      case "network":
        return <NetworkSection />;
      case "bluetooth":
        return <BluetoothSection />;
      case "users":
        return <UsersSection config={config} />;
      case "battery":
        return <BatterySection />;
      case "storage":
        return <StorageSection />;
      default:
        return null;
    }
  };

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        background: "#f5f5f7",
        color: "#333",
        fontFamily:
          '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
        fontSize: 13,
        userSelect: "none",
      }}
    >
      {/* Sidebar */}
      <div
        style={{
          width: 260,
          flexShrink: 0,
          background: "rgba(240,240,240,0.9)",
          borderRight: "0.5px solid rgba(0,0,0,0.1)",
          padding: "12px 10px",
          overflowY: "auto",
        }}
      >
        {/* Buscador */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 10px",
            background: "rgba(0,0,0,0.06)",
            borderRadius: 8,
            fontSize: 12,
            color: "#666",
            marginBottom: 14,
          }}
        >
          <span>🔍</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar ajustes"
            style={{
              background: "transparent",
              border: "none",
              outline: "none",
              width: "100%",
              fontSize: 12,
              color: "#333",
              fontFamily: "inherit",
            }}
          />
        </div>

        {/* Secciones */}
        {visibleSections.map((s) => {
          const active = s.id === section;
          return (
            <div
              key={s.id}
              onClick={() => setSection(s.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                marginBottom: 2,
                borderRadius: 8,
                cursor: "pointer",
                background: active ? "#0a84ff" : "transparent",
                color: active ? "#fff" : "#333",
                fontSize: 13,
              }}
              onMouseEnter={(e) => {
                if (!active)
                  e.currentTarget.style.background = "rgba(0,0,0,0.05)";
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.background = "transparent";
              }}
            >
              <span style={{ fontSize: 15 }}>{s.icon}</span>
              <span style={{ flex: 1 }}>{s.name}</span>
            </div>
          );
        })}
      </div>

      {/* Contenido */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "24px 32px",
          minWidth: 0,
        }}
      >
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          {renderSection()}
        </div>
      </div>
    </div>
  );
}

export default Settings;
