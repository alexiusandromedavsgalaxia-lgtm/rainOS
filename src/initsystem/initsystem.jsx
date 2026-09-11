// ============================================================================
// initsystem.jsx — Pantalla de arranque (logo + progreso)
// ----------------------------------------------------------------------------
// Primera UI del sistema. Muestra:
// - Logo de la manzana en SVG (inline, sin dependencias)
// - Barra de progreso que refleja el arranque real
// - Estado textual (Booting, Loading services, Safe Mode, etc.)
// - Modo verbose con log scrolleable
// - Spinner mientras se resuelven fases indeterminadas
// - Transición fade-out al terminar
// - Compatible con Bootstrap / BootLoader / SafeBoot
// ============================================================================

import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";

// ============================================================================
// LOGO APPLE (SVG inline)
// ============================================================================

export function AppleLogo({ size = 120, color = "#fff", opacity = 1, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 814 1000"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ opacity, display: "block" }}
      aria-hidden="true"
    >
      <path
        fill={color}
        d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"
      />
    </svg>
  );
}

// ============================================================================
// SPINNER
// ============================================================================

export function Spinner({ size = 24, color = "#fff", thickness = 3 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 50 50"
      style={{ animation: "initsystem-spin 1s linear infinite" }}
      aria-hidden="true"
    >
      <circle
        cx="25"
        cy="25"
        r="20"
        fill="none"
        stroke={color}
        strokeOpacity="0.2"
        strokeWidth={thickness}
      />
      <circle
        cx="25"
        cy="25"
        r="20"
        fill="none"
        stroke={color}
        strokeWidth={thickness}
        strokeLinecap="round"
        strokeDasharray="90 150"
      />
    </svg>
  );
}

// ============================================================================
// BARRA DE PROGRESO
// ============================================================================

export function ProgressBar({
  value = 0,
  width = 260,
  height = 4,
  color = "#fff",
  trackColor = "rgba(255,255,255,0.2)",
  indeterminate = false,
}) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: height / 2,
        background: trackColor,
        overflow: "hidden",
        position: "relative",
      }}
    >
      {indeterminate ? (
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            width: "40%",
            borderRadius: height / 2,
            background: color,
            animation: "initsystem-indeterminate 1.4s ease-in-out infinite",
          }}
        />
      ) : (
        <div
          style={{
            width: `${Math.max(0, Math.min(100, value))}%`,
            height: "100%",
            borderRadius: height / 2,
            background: color,
            transition: "width 0.25s ease-out",
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// MAPEO DE FASES → TEXTOS
// ============================================================================

const PHASE_LABELS = {
  pending: "Iniciando…",
  validating: "Verificando entorno…",
  polyfilling: "Preparando sistema…",
  freezing: "Bloqueando recursos críticos…",
  modules: "Cargando módulos…",
  "skipped-ssr": "Modo servidor",

  idle: "Iniciando…",
  detecting: "Detectando hardware…",
  scanning: "Buscando volúmenes de arranque…",
  countdown: "Presiona una tecla para opciones de arranque…",
  "waiting-input": "Esperando selección…",
  loading: "Cargando…",
  chainloading: "Arrancando volumen seleccionado…",
  handoff: "Entregando control al sistema…",
  recovery: "Modo recuperación",
  aborted: "Arranque cancelado",

  off: "Apagado",
  "power-on": "Encendiendo…",
  post: "Comprobación automática…",
  loader: "Cargando gestor de arranque…",
  "kernel-init": "Inicializando kernel…",
  "load-extensions": "Cargando extensiones…",
  "load-services": "Iniciando servicios…",
  "restore-session": "Restaurando sesión…",
  "start-window-manager": "Iniciando gestor de ventanas…",
  ready: "Listo",
  "safe-mode": "Modo seguro",
  failed: "Error de arranque",
};

// ============================================================================
// INIT SYSTEM
// ============================================================================

export function InitSystem({
  progress: progressProp,
  phase: phaseProp,
  safeMode: safeModeProp,
  failed: failedProp,
  error: errorProp,
  verbose: verboseProp = false,
  logs: logsProp = [],
  onFinished,
  minDuration = 1200,
  holdOnError = true,
  bg = "#000",
  fg = "#fff",
}) {
  const startedAtRef = useRef(Date.now());
  const [visible, setVisible] = useState(true);
  const [fading, setFading] = useState(false);
  const [localProgress, setLocalProgress] = useState(0);
  const [localPhase, setLocalPhase] = useState(phaseProp ?? "pending");
  const [localSafeMode, setLocalSafeMode] = useState(!!safeModeProp);
  const [localFailed, setLocalFailed] = useState(!!failedProp);
  const [localError, setLocalError] = useState(errorProp ?? null);
  const [localVerbose, setLocalVerbose] = useState(!!verboseProp);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (progressProp != null) setLocalProgress(progressProp);
  }, [progressProp]);

  useEffect(() => {
    if (phaseProp != null) setLocalPhase(phaseProp);
  }, [phaseProp]);

  useEffect(() => {
    if (safeModeProp != null) setLocalSafeMode(!!safeModeProp);
  }, [safeModeProp]);

  useEffect(() => {
    if (failedProp != null) setLocalFailed(!!failedProp);
  }, [failedProp]);

  useEffect(() => {
    if (errorProp !== undefined) setLocalError(errorProp);
  }, [errorProp]);

  useEffect(() => {
    setLocalVerbose(!!verboseProp);
  }, [verboseProp]);

  useEffect(() => {
    const t = setInterval(() => {
      setElapsed(Date.now() - startedAtRef.current);
    }, 100);
    return () => clearInterval(t);
  }, []);

  const ready = useMemo(() => {
    return (
      localPhase === "ready" ||
      localPhase === "safe-mode" ||
      (localProgress != null && localProgress >= 100)
    );
  }, [localPhase, localProgress]);

  const failed = localFailed || localPhase === "failed";

  useEffect(() => {
    if (!ready && !failed) return;
    if (failed && holdOnError) return;

    const elapsedMs = Date.now() - startedAtRef.current;
    const remaining = Math.max(0, minDuration - elapsedMs);

    const t = setTimeout(() => {
      setFading(true);
      const t2 = setTimeout(() => {
        setVisible(false);
        onFinished?.();
      }, 500);
      return () => clearTimeout(t2);
    }, remaining);

    return () => clearTimeout(t);
  }, [ready, failed, holdOnError, minDuration, onFinished]);

  const logs = useMemo(() => {
    if (!logsProp || logsProp.length === 0) return [];
    return logsProp.slice(-200);
  }, [logsProp]);

  const scrollRef = useRef(null);
  useEffect(() => {
    if (localVerbose && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, localVerbose]);

  const label = useMemo(() => {
    if (localFailed) return "Error de arranque";
    if (localSafeMode) return PHASE_LABELS[localPhase] || "Modo seguro";
    return PHASE_LABELS[localPhase] || "Iniciando…";
  }, [localPhase, localSafeMode, localFailed]);

  const handleKeyDown = useCallback((e) => {
    if (e.metaKey && (e.key === "v" || e.key === "V")) {
      e.preventDefault();
      setLocalVerbose((v) => !v);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (!visible) return null;

  return (
    <div
      className="initsystem-root"
      style={{
        position: "fixed",
        inset: 0,
        background: bg,
        color: fg,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily:
          '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
        zIndex: 2147483647,
        opacity: fading ? 0 : 1,
        transition: "opacity 0.5s ease-out",
        userSelect: "none",
        overflow: "hidden",
      }}
    >
      <style>{`
        @keyframes initsystem-spin {
          to { transform: rotate(360deg); }
        }
        @keyframes initsystem-indeterminate {
          0%   { left: -40%; }
          50%  { left: 60%; }
          100% { left: 100%; }
        }
        @keyframes initsystem-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.55; }
        }
        @keyframes initsystem-fadein {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .initsystem-root * { box-sizing: border-box; }
        .initsystem-logo {
          animation: initsystem-fadein 0.5s ease-out both;
        }
        .initsystem-label {
          animation: initsystem-fadein 0.4s ease-out both;
          letter-spacing: 0.02em;
        }
      `}</style>

      {localVerbose ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            padding: "24px 32px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace',
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <div style={{ color: "#9ae6b4", opacity: 0.9 }}>
            kernel boot: verbose mode (-v) — {logs.length} entradas
          </div>
          <div
            ref={scrollRef}
            style={{
              flex: 1,
              overflow: "auto",
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 6,
              padding: 12,
            }}
          >
            {logs.length === 0 && (
              <div style={{ color: "#888" }}>(sin entradas)</div>
            )}
            {logs.map((entry, i) => (
              <div
                key={i}
                style={{
                  color:
                    entry.level === "error"
                      ? "#fc8181"
                      : entry.level === "warn"
                      ? "#f6ad55"
                      : entry.level === "debug"
                      ? "#a0aec0"
                      : "#cbd5e0",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {entry.ts
                  ? `[${new Date(entry.ts).toLocaleTimeString()}] `
                  : ""}
                {entry.level ? `${entry.level.toUpperCase()} ` : ""}
                {entry.message ?? JSON.stringify(entry)}
              </div>
            ))}
          </div>
          <div style={{ color: "#a0aec0", fontSize: 11 }}>
            ⌘V para salir de verbose · {label}
            {elapsed > 0 ? ` · ${(elapsed / 1000).toFixed(1)}s` : ""}
          </div>
        </div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 40,
            }}
          >
            <div className="initsystem-logo">
              <AppleLogo
                size={110}
                color={fg}
                opacity={localFailed ? 0.5 : 1}
              />
            </div>

            {!localFailed && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 18,
                }}
              >
                <ProgressBar
                  value={localProgress}
                  width={260}
                  height={4}
                  color={localSafeMode ? "#f6ad55" : fg}
                  trackColor="rgba(255,255,255,0.18)"
                  indeterminate={
                    localProgress === 0 || localPhase === "countdown"
                  }
                />
                <div
                  className="initsystem-label"
                  style={{
                    fontSize: 13,
                    color: localSafeMode
                      ? "#f6ad55"
                      : "rgba(255,255,255,0.85)",
                    minHeight: 18,
                    textAlign: "center",
                    animation:
                      localPhase === "countdown"
                        ? "initsystem-pulse 1.6s ease-in-out infinite"
                        : undefined,
                  }}
                >
                  {label}
                </div>
              </div>
            )}

            {localFailed && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 16,
                  maxWidth: 480,
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    fontSize: 15,
                    color: "#fc8181",
                    fontWeight: 500,
                    letterSpacing: "0.01em",
                  }}
                >
                  No se pudo completar el arranque
                </div>
                {localError && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "rgba(255,255,255,0.6)",
                      fontFamily:
                        '"SF Mono", Menlo, Monaco, "Courier New", monospace',
                      maxHeight: 160,
                      overflow: "auto",
                      padding: "8px 12px",
                      border: "1px solid rgba(255,255,255,0.12)",
                      borderRadius: 6,
                      background: "rgba(255,255,255,0.03)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {typeof localError === "string"
                      ? localError
                      : String(localError)}
                  </div>
                )}
                <div
                  style={{
                    fontSize: 11,
                    color: "rgba(255,255,255,0.35)",
                    marginTop: 4,
                  }}
                >
                  Presiona ⌘V para ver el log completo
                </div>
              </div>
            )}
          </div>

          <div
            style={{
              position: "absolute",
              bottom: 24,
              fontSize: 11,
              color: "rgba(255,255,255,0.3)",
              letterSpacing: "0.05em",
            }}
          >
            {localSafeMode && !localFailed
              ? "Safe Mode"
              : !localFailed
              ? `Starting up… ${(elapsed / 1000).toFixed(1)}s`
              : ""}
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================================
// CONECTOR AUTOMÁTICO
// ============================================================================

export function ConnectedInitSystem({
  bootstrap: bootstrapApi,
  bootloader: bootloaderApi,
  safeboot: safebootApi,
  onFinished,
  minDuration = 1200,
  holdOnError = true,
}) {
  const phase = useMemo(() => {
    if (safebootApi?.phase) return safebootApi.phase;
    if (bootloaderApi?.state) return bootloaderApi.state;
    if (bootstrapApi?.phase) return bootstrapApi.phase;
    return "pending";
  }, [safebootApi?.phase, bootloaderApi?.state, bootstrapApi?.phase]);

  const progress = useMemo(() => {
    if (safebootApi && typeof safebootApi.progress === "number") {
      return safebootApi.progress;
    }
    if (bootloaderApi?.state) {
      const map = {
        idle: 5,
        detecting: 10,
        scanning: 20,
        countdown: 30,
        "waiting-input": 32,
        loading: 45,
        chainloading: 60,
        handoff: 75,
        recovery: 60,
        aborted: 100,
        failed: 100,
      };
      return map[bootloaderApi.state] ?? 0;
    }
    if (bootstrapApi?.phase) {
      const map = {
        pending: 0,
        validating: 5,
        polyfilling: 10,
        freezing: 12,
        modules: 20,
        ready: 25,
        "skipped-ssr": 25,
        failed: 100,
      };
      return map[bootstrapApi.phase] ?? 0;
    }
    return 0;
  }, [safebootApi?.progress, bootloaderApi?.state, bootstrapApi?.phase]);

  const safeMode = useMemo(() => {
    return (
      safebootApi?.safeMode ||
      bootloaderApi?.flags?.includes?.("safe") ||
      false
    );
  }, [safebootApi?.safeMode, bootloaderApi?.flags]);

  const failed = useMemo(() => {
    return (
      safebootApi?.isFailed ||
      bootloaderApi?.state === "failed" ||
      bootstrapApi?.isFailed ||
      false
    );
  }, [safebootApi, bootloaderApi, bootstrapApi]);

  const error = useMemo(() => {
    if (safebootApi?.errors?.length) {
      return safebootApi.errors[safebootApi.errors.length - 1];
    }
    if (bootstrapApi?.error) return bootstrapApi.error;
    if (bootloaderApi?.errors?.length) {
      return bootloaderApi.errors[bootloaderApi.errors.length - 1];
    }
    return null;
  }, [safebootApi, bootstrapApi, bootloaderApi]);

  const logs = useMemo(() => {
    const merged = [];
    if (bootstrapApi?.trace) {
      for (const e of bootstrapApi.trace.all?.() ?? []) {
        merged.push({ ts: e.ts, level: e.level, message: e.message });
      }
    }
    if (bootloaderApi?.logs) merged.push(...bootloaderApi.logs);
    if (safebootApi?.logs) merged.push(...safebootApi.logs);
    merged.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return merged;
  }, [bootstrapApi, bootloaderApi, safebootApi]);

  return (
    <InitSystem
      progress={progress}
      phase={phase}
      safeMode={safeMode}
      failed={failed}
      error={error}
      logs={logs}
      onFinished={onFinished}
      minDuration={minDuration}
      holdOnError={holdOnError}
    />
  );
}

// ============================================================================
// HOOK
// ============================================================================

export function useInitGate() {
  const [booted, setBooted] = useState(false);
  const onFinished = useCallback(() => setBooted(true), []);
  return { booted, onFinished };
}

// ============================================================================
// EXPORTS DEFAULT
// ============================================================================

export default {
  InitSystem,
  ConnectedInitSystem,
  AppleLogo,
  Spinner,
  ProgressBar,
  useInitGate,
};
