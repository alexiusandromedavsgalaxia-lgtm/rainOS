// ============================================================================
// App.jsx — Raíz de rainOS (versión completa)
// ----------------------------------------------------------------------------
// Monta TODO el sistema operativo:
//
//   1. Cadena de arranque:
//      BootstrapProvider → WindowManagerProvider → SafeBootProvider
//      → BootLoaderProvider → SchedulerProvider → UpdaterProvider
//      → ToastProvider → AppInstallerProvider → DMGInstallerProvider
//      → StartupInstallerProvider → InitialConfigProvider
//
//   2. Subsistemas nuevos:
//      → SyslogsProvider → SyscallsProvider → SysfilteredProvider
//      → BatteryProvider → ChargeSystemProvider → DriversProvider
//      → DiagnoseProvider → BatteryDiagnosticProvider
//
//   3. Seguridad:
//      → SecurityProvider (con SecurityManager)
//
//   4. Runtime de apps + 8 apps del sistema
//
//   5. LockScreen
//
//   6. Shell (Desktop + overlays + dock + menubar)
//
// OJO: la cadena de providers importa. El orden es:
//   - Primero los que no dependen de nada (bootstrap, kernel)
//   - Luego los del sistema (syslogs, syscalls, sysfiltered)
//   - Luego hardware (battery → charge → drivers → diagnose)
//   - Luego seguridad (que puede depender de syscalls)
//   - Luego runtime de apps (que depende de seguridad + kernel)
//   - Y por último el Shell
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from "react";

// ─────────────── Kernel / cadena de arranque ───────────────
import {
  WindowManagerProvider,
  useWindowManager,
  WINDOW_STATE,
} from "./kernel/kernel.jsx";
import { BootstrapProvider } from "./bootstrap/bootstrap.jsx";
import { BootLoaderProvider } from "./bootloader/bootloader.jsx";
import { SafeBootProvider } from "./safeboot/safeboot.jsx";
import { SchedulerProvider } from "./scheduler/scheduler.jsx";
import { kernelBus } from "./kernel/kernel.jsx";

// ─────────────── Instaladores y sistema ───────────────
import { StartupInstallerProvider } from "./startupinstaller/startupinstaller.jsx";
import { InitialConfigProvider } from "./initialconfig/initialconfig.jsx";
import { ConnectedInitSystem } from "./initsystem/initsystem.jsx";
import { UpdaterProvider } from "./updater/updater.jsx";
import { ToastProvider } from "./toast/toast.jsx";
import { AppInstallerProvider } from "./appinstaller/appinstaller.jsx";
import { DMGInstallerProvider } from "./dmginstaller/dmginstaller.jsx";

// ─────────────── Sistema (módulos nuevos) ───────────────
import { SyslogsProvider, useSyslogs } from "./system/syslogs.jsx";
import { SyscallsProvider, useSyscalls } from "./system/syscalls.jsx";
import { SysfilteredProvider } from "./system/sysfiltered.jsx";
import {
  DiagnoseProvider,
  useDiagnose,
} from "./system/sysdiagnose.jsx";
import {
  BatteryDiagnosticProvider,
  useBatteryDiagnostic,
} from "./system/sysbatdiagnostic.jsx";

// ─────────────── Hardware (módulos nuevos) ───────────────
import { BatteryProvider, useBattery, Battery } from "./hardware/battery.jsx";
import {
  ChargeSystemProvider,
  useChargeSystem,
} from "./hardware/chargesystem.jsx";
import {
  DriversProvider,
  useDrivers,
} from "./hardware/drivers.jsx";

// ─────────────── Seguridad ───────────────
import { SecurityManager, installSecurityHooks } from "./security/security.jsx";

// ─────────────── Runtime de apps ───────────────
import {
  RuntimeProvider,
  buildSystemApps,
  useRuntime,
} from "./runtime/runtime.jsx";

// ─────────────── Bloqueo ───────────────
import { LockScreenProvider, LockScreenView } from "./lockscreen/lockscreen.jsx";

// ─────────────── Chrome del escritorio ───────────────
import { Desktop } from "./desktop/desktop.jsx";
import { MenuBar } from "./menubar/menubar.jsx";
import { Dock } from "./dock/dock.jsx";
import { Launchpad } from "./launchpad/launchpad.jsx";
import { Spotlight } from "./spotlight/spotlight.jsx";
import { Notifications } from "./notifications/notifications.jsx";
import { MissionControl } from "./missioncontrol/missioncontrol.jsx";
import { ControlCenter } from "./controlcenter/controlcenter.jsx";
import { AppSwitcher } from "./appswitcher/appswitcher.jsx";

// ─────────────── Apps del sistema ───────────────
import { Finder } from "./apps/finder/finder.jsx";
import { Safari } from "./apps/safari/safari.jsx";
import { Music } from "./apps/music/music.jsx";
import { Photos } from "./apps/photos/photos.jsx";
import { Terminal } from "./apps/terminal/terminal.jsx";
import { Notes } from "./apps/notes/notes.jsx";
import { Settings } from "./apps/settings/settings.jsx";
import { About } from "./apps/about/about.jsx";

// ============================================================================
// APPS DEL SISTEMA
// ============================================================================

const SYSTEM_APPS = buildSystemApps({
  Finder,
  Safari,
  Music,
  Photos,
  Terminal,
  Notes,
  Settings,
  About,
});

// ============================================================================
// SECURITY CONTEXT
// ============================================================================

const SecurityContext = React.createContext(null);

export function useSecurity() {
  const ctx = React.useContext(SecurityContext);
  if (!ctx) throw new Error("useSecurity must be used within SecurityContext");
  return ctx;
}

function SecurityProvider({ security, children }) {
  return (
    <SecurityContext.Provider value={security}>
      {children}
    </SecurityContext.Provider>
  );
}

// ============================================================================
// SYSTEM BRIDGE
// ----------------------------------------------------------------------------
// Conecta los módulos nuevos entre sí:
//   - Carga de drivers basada en la battery
//   - ctxFactory para el DiagnoseProvider con todos los subsistemas
//   - Wiring de eventos entre batería ↔ carga ↔ syslogs
// ============================================================================

function SystemBridge({ children, security }) {
  const batteryApi = useBattery();
  const chargeApi = useChargeSystem();
  const syscallsApi = useSyscalls();
  const syslogsApi = useSyslogs();
  const driversApi = useDrivers();
  const diagnoseApi = useDiagnose();

  // ---------------------------------------------------------------- logs
  // Redirigir eventos importantes al sistema de logs
  useEffect(() => {
    const offBattery = kernelBus.on("battery:low", (payload) => {
      syslogsApi.info("com.rainos.battery", "power", "Batería baja", payload);
    });
    const offCritical = kernelBus.on("battery:critical", (payload) => {
      syslogsApi.error("com.rainos.battery", "power", "Batería crítica", payload);
    });
    const offPlugged = kernelBus.on("battery:plugged", (payload) => {
      syslogsApi.info("com.rainos.battery", "charger", "Cargador enchufado", payload);
    });
    const offUnplugged = kernelBus.on("battery:unplugged", (payload) => {
      syslogsApi.info("com.rainos.battery", "charger", "Cargador desenchufado", payload);
    });
    const offOverheat = kernelBus.on("battery:overheat", (payload) => {
      syslogsApi.error("com.rainos.battery", "thermal", "Sobrecalentamiento", payload);
    });
    const offFullCharge = kernelBus.on("battery:full", (payload) => {
      syslogsApi.info("com.rainos.battery", "charger", "Batería completa", payload);
    });

    const offChargeState = kernelBus.on("charge:state-changed", (payload) => {
      syslogsApi.info(
        "com.rainos.charge",
        "state",
        `Carga: ${payload.from} → ${payload.to}`,
        payload
      );
    });
    const offChargeAttached = kernelBus.on("charge:charger-attached", (payload) => {
      syslogsApi.info(
        "com.rainos.charge",
        "attach",
        `Cargador ${payload.kind} (${payload.watts}W)`,
        payload
      );
    });

    const offDriverStarted = kernelBus.on("driver:started", (payload) => {
      syslogsApi.debug(
        "com.rainos.driver",
        "lifecycle",
        `Driver started: ${payload.driverId}`,
        payload
      );
    });
    const offDriverFailed = kernelBus.on("driver:probe-failed", (payload) => {
      syslogsApi.error(
        "com.rainos.driver",
        "probe",
        `Driver probe failed: ${payload.driverId}`,
        payload
      );
    });

    const offIrq = kernelBus.on("driver:irq-fired", (payload) => {
      syslogsApi.debug(
        "com.rainos.driver",
        "irq",
        `IRQ ${payload.irq} del driver ${payload.driverId}`,
        payload
      );
    });

    return () => {
      offBattery();
      offCritical();
      offPlugged();
      offUnplugged();
      offOverheat();
      offFullCharge();
      offChargeState();
      offChargeAttached();
      offDriverStarted();
      offDriverFailed();
      offIrq();
    };
  }, [syslogsApi]);

  // ---------------------------------------------------------------- syscalls logging
  useEffect(() => {
    const off = kernelBus.on("syscall:called", (entry) => {
      // Solo loguear syscalls bloqueadas o con error
      if (entry.blocked || entry.errno !== 0) {
        syslogsApi.warn(
          "com.rainos.syscall",
          entry.category || "misc",
          `syscall ${entry.name} #${entry.number} → ${entry.errnoName}`,
          { pid: entry.pid, args: entry.args }
        );
      }
    });
    return off;
  }, [syslogsApi]);

  // ---------------------------------------------------------------- diagnose
  useEffect(() => {
    // Configurar el ctxFactory del diagnose con acceso a todos los subsistemas
    if (diagnoseApi?.engine) {
      diagnoseApi.engine.ctxFactory = () => ({
        battery: batteryApi.battery,
        chargeSystem: chargeApi.system,
        syslogs: syslogsApi.system,
        syscalls: syscallsApi.table,
        drivers: driversApi.manager,
        runtime: null, // se rellena en el Shell donde hay window manager
        security,
        crashes: [],
        spindumps: [],
        bootTime: performance.timeOrigin ?? Date.now(),
      });
    }
  }, [diagnoseApi, batteryApi, chargeApi, syslogsApi, syscallsApi, driversApi, security]);

  // ---------------------------------------------------------------- battery load → scheduler
  useEffect(() => {
    // Simular consumo de CPU como load de la batería
    const interval = setInterval(() => {
      const load = 3 + Math.random() * 3; // 3-6 W
      batteryApi.setLoad(load);
    }, 5000);
    return () => clearInterval(interval);
  }, [batteryApi]);

  return children;
}

// ============================================================================
// SHELL (todo lo que se renderiza dentro del sistema ya arrancado)
// ============================================================================

function Shell() {
  const wm = useWindowManager();
  const runtime = useRuntime();
  const batteryApi = useBattery();
  const chargeApi = useChargeSystem();
  const syscallsApi = useSyscalls();
  const syslogsApi = useSyslogs();
  const driversApi = useDrivers();
  const diagnoseApi = useDiagnose();
  const batDiagApi = useBatteryDiagnostic();

  const [showLaunchpad, setShowLaunchpad] = useState(false);
  const [showSpotlight, setShowSpotlight] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showMissionControl, setShowMissionControl] = useState(false);
  const [showControlCenter, setShowControlCenter] = useState(false);
  const [showAppSwitcher, setShowAppSwitcher] = useState(false);

  // ------------------------------------------------------------------ atajos globales
  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;

      // F4 → Launchpad
      if (e.key === "F4" && !meta) {
        e.preventDefault();
        setShowLaunchpad((s) => !s);
        return;
      }

      // ⌘Space → Spotlight
      if (meta && e.key === " ") {
        e.preventDefault();
        setShowSpotlight((s) => !s);
        return;
      }

      // F3 o Ctrl+↑ → Mission Control
      if ((e.key === "F3" && !meta) || (e.ctrlKey && e.key === "ArrowUp")) {
        e.preventDefault();
        setShowMissionControl((s) => !s);
        return;
      }

      // ⌘Tab → App Switcher
      if (meta && e.key === "Tab") {
        e.preventDefault();
        setShowAppSwitcher(true);
        return;
      }

      // ⌘⇧D → Sysdiagnose
      if (meta && e.shiftKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        syslogsApi.info(
          "com.rainos.sysdiagnose",
          "trigger",
          "Sysdiagnose iniciado por atajo"
        );
        diagnoseApi.run({ mode: "quick" });
        return;
      }

      // Esc cierra todos los overlays
      if (e.key === "Escape") {
        setShowLaunchpad(false);
        setShowSpotlight(false);
        setShowMissionControl(false);
        setShowControlCenter(false);
        setShowAppSwitcher(false);
      }
    };

    const onKeyUp = (e) => {
      if (e.key === "Meta" || e.key === "Alt") {
        setShowAppSwitcher(false);
      }
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [syslogsApi, diagnoseApi]);

  // ------------------------------------------------------------------ menubar handlers
  const menuBarHandlers = useMemo(
    () => ({
      onOpenControlCenter: () => setShowControlCenter((s) => !s),
      onOpenSpotlight: () => setShowSpotlight((s) => !s),
      onOpenNotifications: () => setShowNotifications((s) => !s),
      onOpenSettings: () => runtime.focusOrLaunch("settings"),
      onOpenAbout: () => runtime.focusOrLaunch("about"),
      onSleep: () => {
        syslogsApi.info("com.rainos.power", "sleep", "Sistema suspendido");
        driversApi.suspendAll();
      },
      onRestart: () => {
        syslogsApi.warn("com.rainos.power", "restart", "Reinicio solicitado");
        window.location.reload();
      },
      onShutdown: () => {
        syslogsApi.warn("com.rainos.power", "shutdown", "Apagado solicitado");
        driversApi.detachAll();
        chargeApi.detachCharger();
      },
      onLockScreen: () => {
        syslogsApi.info("com.rainos.lockscreen", "lock", "Pantalla bloqueada manualmente");
      },
      onLogOut: () => {
        syslogsApi.info("com.rainos.session", "logout", "Cierre de sesión");
      },
    }),
    [runtime, syslogsApi, driversApi, chargeApi]
  );

  // ------------------------------------------------------------------ dock apps
  const dockApps = useMemo(
    () =>
      [
        "finder",
        "safari",
        "music",
        "photos",
        "terminal",
        "notes",
        "settings",
      ]
        .map((id) => SYSTEM_APPS.find((a) => a.id === id))
        .filter(Boolean),
    []
  );

  return (
    <>
      {/* Escritorio con ventanas */}
      <Desktop />

      {/* Chrome superior */}
      <MenuBar {...menuBarHandlers} />

      {/* Chrome inferior */}
      <Dock
        apps={dockApps.map((a) => ({
          id: a.id,
          name: a.name,
          emoji: a.icon,
        }))}
        pinned={[
          "finder",
          "safari",
          "music",
          "photos",
          "terminal",
          "notes",
          "settings",
        ]}
        trash={{ id: "trash", name: "Papelera", emoji: "🗑️" }}
        onAppClick={(app) => runtime.focusOrLaunch(app.id)}
        onTrashClick={() => {
          syslogsApi.info("com.rainos.finder", "trash", "Papelera abierta");
        }}
      />

      {/* Overlays */}
      {showLaunchpad && (
        <Launchpad
          apps={SYSTEM_APPS}
          open={showLaunchpad}
          onClose={() => setShowLaunchpad(false)}
          onOpenApp={(app) => {
            runtime.launch(app.id);
            setShowLaunchpad(false);
          }}
        />
      )}

      {showSpotlight && (
        <Spotlight
          apps={SYSTEM_APPS}
          actions={[
            { id: "lock", label: "Bloquear pantalla", icon: "🔒" },
            { id: "sleep", label: "Suspender", icon: "💤" },
            { id: "empty-trash", label: "Vaciar papelera", icon: "🗑️" },
            { id: "sysdiagnose", label: "Ejecutar sysdiagnose", icon: "🩺" },
          ]}
          open={showSpotlight}
          onClose={() => setShowSpotlight(false)}
          onOpenApp={(app) => {
            runtime.launch(app.id);
            setShowSpotlight(false);
          }}
          onRunAction={(action) => {
            if (action.id === "sysdiagnose") diagnoseApi.run();
            syslogsApi.info(
              "com.rainos.spotlight",
              "action",
              `Acción ejecutada: ${action.id}`
            );
          }}
        />
      )}

      {showNotifications && (
        <Notifications
          open={showNotifications}
          onClose={() => setShowNotifications(false)}
        />
      )}

      {showMissionControl && (
        <MissionControl
          spaces={[
            { id: "space-1", name: "Escritorio 1" },
            { id: "space-2", name: "Escritorio 2" },
          ]}
          activeSpaceId="space-1"
          open={showMissionControl}
          onClose={() => setShowMissionControl(false)}
          onActivateWindow={() => setShowMissionControl(false)}
          onActivateSpace={(s) => {}}
          onAddSpace={() => {}}
        />
      )}

      {showControlCenter && (
        <ControlCenter
          open={showControlCenter}
          onClose={() => setShowControlCenter(false)}
          onOpenSettings={() => runtime.focusOrLaunch("settings")}
          onOpenSound={() => {}}
          onOpenDisplay={() => {}}
          onOpenNetwork={() => {}}
          onLockScreen={() => {}}
        />
      )}

      {showAppSwitcher && (
        <AppSwitcher
          apps={SYSTEM_APPS}
          open={showAppSwitcher}
          onClose={() => setShowAppSwitcher(false)}
          onSwitch={(app) => {
            runtime.focusOrLaunch(app.id);
            setShowAppSwitcher(false);
          }}
        />
      )}

      {/* Lock screen (por encima de todo) */}
      <LockScreenView />
    </>
  );
}

// ============================================================================
// BOOT GATE — controla qué se muestra según la fase del sistema
// ============================================================================

function BootGate() {
  const [security, setSecurity] = useState(null);
  const [showInit, setShowInit] = useState(true);

  // Instalar seguridad al arrancar
  useEffect(() => {
    const sec = new SecurityManager({ keychainName: "login" });
    sec.fileVault.enable();
    sec.fileVault.setPassword("rainos-default-password");
    sec.fileVault.lock();
    installSecurityHooks({ security: sec });
    setSecurity(sec);
    // Simular desbloqueo (en un SO real pediría contraseña)
    setTimeout(() => sec.fileVault.unlock("rainos-default-password"), 500);
  }, []);

  // Ocultar pantalla de arranque
  useEffect(() => {
    const t = setTimeout(() => setShowInit(false), 2600);
    return () => clearTimeout(t);
  }, []);

  if (!security) return null;

  return (
    <SecurityProvider security={security}>
      {/* Subsistemas del sistema */}
      <SyslogsProvider persist>
        <SyscallsProvider>
          <SysfilteredProvider>
            {/* Hardware */}
            <BatteryProvider autoStart options={{ initialLevel: 0.78 }}>
              <ChargeSystemBridgeBattery>
                <DriversProvider autoInit>
                  <DiagnoseBridge>
                    <BatteryDiagnosticBridge>
                      <SecurityProvider security={security}>
                        <RuntimeProvider apps={SYSTEM_APPS} security={security}>
                          {showInit ? (
                            <ConnectedInitSystem onFinished={() => setShowInit(false)} />
                          ) : (
                            <Shell />
                          )}
                        </RuntimeProvider>
                      </SecurityProvider>
                    </BatteryDiagnosticBridge>
                  </DiagnoseBridge>
                </DriversProvider>
              </ChargeSystemBridgeBattery>
            </BatteryProvider>
          </SysfilteredProvider>
        </SyscallsProvider>
      </SyslogsProvider>
    </SecurityProvider>
  );
}

// ============================================================================
// SUB-BRIDGES (providers que necesitan acceso a otros providers)
// ============================================================================

// ChargeSystem necesita acceso a la batería
function ChargeSystemBridgeBattery({ children }) {
  const batteryApi = useBattery();
  return (
    <ChargeSystemProvider battery={batteryApi.battery} autoStart>
      {children}
    </ChargeSystemProvider>
  );
}

// Diagnose necesita acceso a syslogs/syscalls/battery/charge/drivers
function DiagnoseBridge({ children }) {
  const syslogsApi = useSyslogs();
  const syscallsApi = useSyscalls();
  const batteryApi = useBattery();
  const chargeApi = useChargeSystem();
  const driversApi = useDrivers();

  const ctxFactory = useMemo(
    () => () => ({
      battery: batteryApi.battery,
      chargeSystem: chargeApi.system,
      syslogs: syslogsApi.system,
      syscalls: syscallsApi.table,
      drivers: driversApi.manager,
      crashes: [],
      spindumps: [],
      bootTime: performance.timeOrigin ?? Date.now(),
    }),
    [batteryApi, chargeApi, syslogsApi, syscallsApi, driversApi]
  );

  return <DiagnoseProvider ctxFactory={ctxFactory}>{children}</DiagnoseProvider>;
}

// BatteryDiagnostic necesita acceso a battery + charge
function BatteryDiagnosticBridge({ children }) {
  const batteryApi = useBattery();
  const chargeApi = useChargeSystem();
  const syslogsApi = useSyslogs();

  return (
    <BatteryDiagnosticProvider
      battery={batteryApi.battery}
      chargeSystem={chargeApi.system}
      syslogs={syslogsApi.system}
    >
      <SystemBridgeWrapper>{children}</SystemBridgeWrapper>
    </BatteryDiagnosticProvider>
  );
}

// SystemBridge necesita estar dentro de todos los providers nuevos
function SystemBridgeWrapper({ children }) {
  const security = React.useContext(SecurityContext);
  return <SystemBridge security={security}>{children}</SystemBridge>;
}

// ============================================================================
// APP (árbol de providers completo)
// ============================================================================

export default function App() {
  return (
    <BootstrapProvider autoRun>
      <WindowManagerProvider>
        <SafeBootProvider autoStart>
          <BootLoaderProvider autoRun countdownMs={1200}>
            <SchedulerProvider autoStart options={{ cores: 4, tickHz: 250 }}>
              <UpdaterProvider autoCheckOnMount>
                <ToastProvider>
                  <AppInstallerProvider
                    initialCatalog={[
                      {
                        id: "extra-app",
                        name: "Extra App",
                        version: "1.0.0",
                        developerId: "RainSoft",
                        checksum: null,
                      },
                    ]}
                  >
                    <DMGInstallerProvider>
                      <StartupInstallerProvider autoRun>
                        <InitialConfigProvider autoStart>
                          <LockScreenProvider autoLock>
                            <BootGate />
                          </LockScreenProvider>
                        </InitialConfigProvider>
                      </StartupInstallerProvider>
                    </DMGInstallerProvider>
                  </AppInstallerProvider>
                </ToastProvider>
              </UpdaterProvider>
            </SchedulerProvider>
          </BootLoaderProvider>
        </SafeBootProvider>
      </WindowManagerProvider>
    </BootstrapProvider>
  );
}
