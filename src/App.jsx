// ============================================================================
// App.jsx — Raíz de rainOS
// ----------------------------------------------------------------------------
// Monta todo el sistema operativo con la cadena de arranque completa.
//
//   1. Cadena de arranque:
//      BootstrapProvider → WindowManagerProvider → SafeBootProvider
//      → BootLoaderProvider → SchedulerProvider → UpdaterProvider
//      → ToastProvider → AppInstallerProvider → DMGInstallerProvider
//      → StartupInstallerProvider → InitialConfigProvider
//      → LockScreenProvider → RuntimeProvider
//
//   2. Security manager global
//
//   3. Runtime de apps con las 8 apps del sistema
//      (todas viven en src/apps/<app>/<app>.jsx)
//
//   4. Todos los overlays de UI (menubar, dock, launchpad, ...)
//
//   5. Shell principal: Desktop + windows + overlays
//
// ============================================================================

import React, { useEffect, useMemo, useState } from "react";

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

// ─────────────── Instaladores y sistema ───────────────
import { StartupInstallerProvider } from "./startupinstaller/startupinstaller.jsx";
import { InitialConfigProvider } from "./initialconfig/initialconfig.jsx";
import { InitSystem, ConnectedInitSystem } from "./initsystem/initsystem.jsx";
import { UpdaterProvider } from "./updater/updater.jsx";
import { ToastProvider } from "./toast/toast.jsx";
import { AppInstallerProvider } from "./appinstaller/appinstaller.jsx";
import { DMGInstallerProvider } from "./dmginstaller/dmginstaller.jsx";

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
// Cada app vive en src/apps/<app>/<app>.jsx
import { Finder }   from "./apps/finder/finder.jsx";
import { Safari }   from "./apps/safari/safari.jsx";
import { Music }    from "./apps/music/music.jsx";
import { Photos }   from "./apps/photos/photos.jsx";
import { Terminal } from "./apps/terminal/terminal.jsx";
import { Notes }    from "./apps/notes/notes.jsx";
import { Settings } from "./apps/settings/settings.jsx";
import { About }    from "./apps/about/about.jsx";

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
// SECURITY CONTEXT (provider local, no está en un archivo aparte)
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
// SHELL — todo lo que se renderiza dentro del sistema ya arrancado
// ============================================================================

function Shell() {
  const wm = useWindowManager();
  const runtime = useRuntime();

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
  }, []);

  // ------------------------------------------------------------------ menubar
  const menuBarHandlers = useMemo(
    () => ({
      onOpenControlCenter: () => setShowControlCenter((s) => !s),
      onOpenSpotlight: () => setShowSpotlight((s) => !s),
      onOpenNotifications: () => setShowNotifications((s) => !s),
      onOpenSettings: () => runtime.focusOrLaunch("settings"),
      onOpenAbout: () => runtime.focusOrLaunch("about"),
      onSleep: () => console.log("[shell] sleep"),
      onRestart: () => console.log("[shell] restart"),
      onShutdown: () => console.log("[shell] shutdown"),
      onLockScreen: () => console.log("[shell] lock"),
      onLogOut: () => console.log("[shell] logout"),
    }),
    [runtime]
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
        onTrashClick={() => console.log("[dock] trash")}
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
          ]}
          open={showSpotlight}
          onClose={() => setShowSpotlight(false)}
          onOpenApp={(app) => {
            runtime.launch(app.id);
            setShowSpotlight(false);
          }}
          onRunAction={(action) => console.log("[spotlight] action:", action)}
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
          onActivateSpace={(s) => console.log("[missioncontrol] space:", s)}
          onAddSpace={() => console.log("[missioncontrol] add space")}
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
          onLockScreen={() => console.log("[controlcenter] lock")}
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

  // Ocultar pantalla de arranque tras un tiempo
  useEffect(() => {
    const t = setTimeout(() => {
      setShowInit(false);
    }, 2600);
    return () => clearTimeout(t);
  }, []);

  if (!security) return null;

  return (
    <SecurityProvider security={security}>
      <RuntimeProvider apps={SYSTEM_APPS} security={security}>
        {showInit ? (
          <ConnectedInitSystem onFinished={() => setShowInit(false)} />
        ) : (
          <Shell />
        )}
      </RuntimeProvider>
    </SecurityProvider>
  );
}

// ============================================================================
// APP — árbol completo de providers
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
