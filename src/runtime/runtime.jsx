import React from "react";
import {
  // Cadena de arranque
  BootstrapProvider,
  BootLoaderProvider,
  SafeBootProvider,
  WindowManagerProvider,
  LockScreenProvider,
  LockScreenView,
  UpdaterProvider,
  ToastProvider,
  AppInstallerProvider,
  DMGInstallerProvider,

  // Runtime
  RuntimeProvider,
  buildSystemApps,

  // Chrome
  Desktop,
  MenuBar,
  Dock,
  Launchpad,
  Spotlight,
  Notifications,
  MissionControl,
  ControlCenter,
  AppSwitcher,

  // Apps
  Finder,
  Terminal,
  Notes,
  Settings,
  About,
} from "rainOS";

// Definiciones de las apps del sistema
const SYSTEM_APPS = buildSystemApps({
  Finder,
  Terminal,
  Notes,
  Settings,
  About,
});

// Iconos SVG (opcional, si quieres pasar componentes en vez de emojis)
const finderIcon = "🗂️";
const terminalIcon = "⌨️";
const notesIcon = "📝";
const settingsIcon = "⚙️";
const aboutIcon = "ℹ️";

function Shell() {
  return (
    <>
      <Desktop />
      <MenuBar />
      <Dock
        apps={SYSTEM_APPS.map((a) => ({
          id: a.id,
          name: a.name,
          emoji: a.icon,
        }))}
        pinned={["finder", "terminal", "notes", "settings"]}
        trash={{ id: "trash", name: "Papelera", emoji: "🗑️" }}
      />
      <Launchpad apps={SYSTEM_APPS} />
      <Spotlight apps={SYSTEM_APPS} />
      <Notifications />
      <MissionControl />
      <ControlCenter />
      <AppSwitcher apps={SYSTEM_APPS} />
      <LockScreenView />
    </>
  );
}

export default function App() {
  return (
    <BootstrapProvider autoRun>
      <WindowManagerProvider>
        <SafeBootProvider autoStart>
          <BootLoaderProvider autoRun countdownMs={1200}>
            <UpdaterProvider autoCheckOnMount>
              <ToastProvider>
                <AppInstallerProvider>
                  <DMGInstallerProvider>
                    <RuntimeProvider apps={SYSTEM_APPS}>
                      <LockScreenProvider autoLock>
                        <Shell />
                      </LockScreenProvider>
                    </RuntimeProvider>
                  </DMGInstallerProvider>
                </AppInstallerProvider>
              </ToastProvider>
            </UpdaterProvider>
          </BootLoaderProvider>
        </SafeBootProvider>
      </WindowManagerProvider>
    </BootstrapProvider>

    ¿sessions.has("terminal")?
  SÍ → focus/restore/minimize según el caso
  NO → this.launch("terminal")
  
  );windowManager.open({
  appId: "terminal",
  title: "Terminal",
  component: Terminal,           // el componente real
  width: 720,
  height: 460,
  ...

    
});
}


sessions.set("terminal", new Set([winId]));
windowToApp.set(winId, "terminal");
