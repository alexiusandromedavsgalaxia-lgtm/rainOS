
      kernelBus.on("thermal:critical-reached", (p) =>
        syslogsApi.error("com.rainos.thermal", "critical", `Nivel crítico alcanzado (${p.tempC?.toFixed?.(1) ?? p.level}°C)`, p)
      ),
      kernelBus.on("thermal:emergency-reached", (p) => {
        syslogsApi.error("com.rainos.thermal", "emergency", `Emergencia térmica (${p.level})`, p);
        // Política de emergencia: forzar ahorro y apagar radios no esenciales
        thermalApi.setPolicy("efficiency");
        bluetoothApi.powerOff?.();
        cameraApi.stopAll?.();
      }),
      kernelBus.on("thermal:shutdown", (p) => {
        syslogsApi.error("com.rainos.thermal", "shutdown", `Apagado por temperatura: ${p.tempC}°C`, p);
        driversApi.detachAll?.();
        displayApi.sleepAll?.();
        audioApi.suspend?.();
        usbApi.suspendAll?.();
      }),
      kernelBus.on("thermal:fan-update", (p) =>
        syslogsApi.debug("com.rainos.thermal", "fan", `Fan ${p.coolerId}: ${p.rpm} rpm`, p)
      ),
      kernelBus.on("thermal:policy-changed", (p) =>
        syslogsApi.info("com.rainos.thermal", "policy", `Política: ${p.from} → ${p.to}`, p)
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [syslogsApi, thermalApi, bluetoothApi, cameraApi, driversApi, displayApi, audioApi, usbApi]);

  // ---------------------------------------------------------------- USB ↔ Display (monitor externo)
  useEffect(() => {
    const off = kernelBus.on("usb:device-enumerated", (p) => {
      if (p.deviceClass === 0x0e || p.interfaceClass === 0x0e) {
        displayApi.manager?.addDisplay?.({
          id: `display-usb-${p.deviceId}`,
          name: p.productName || "USB Display",
          kind: "external",
          width: p.preferredWidth || 1920,
          height: p.preferredHeight || 1080,
          refresh: p.preferredRefresh || 60,
        });
        syslogsApi.info(
          "com.rainos.display",
          "hotplug",
          `Display externo por USB: ${p.productName}`,
          p
        );
      }
    });
    return off;
  }, [displayApi, syslogsApi]);

  // ---------------------------------------------------------------- USB ↔ Audio (DAC / auriculares)
  useEffect(() => {
    const off = kernelBus.on("usb:device-enumerated", (p) => {
      if (p.deviceClass === 0x01 || p.interfaceClass === 0x01) {
        audioApi.manager?.addDevice?.({
          id: `audio-usb-${p.deviceId}`,
          name: p.productName || "USB Audio",
          kind: "usb",
          isOutput: true,
          isInput: p.hasMicrophone ?? false,
          sampleRate: p.sampleRate || 48000,
          channels: p.channels || 2,
        });
        syslogsApi.info(
          "com.rainos.audio",
          "device",
          `Audio USB añadido: ${p.productName}`,
          p
        );
      }
    });
    return off;
  }, [audioApi, syslogsApi]);

  // ---------------------------------------------------------------- USB ↔ Camera (webcam UVC)
  useEffect(() => {
    const off = kernelBus.on("usb:device-enumerated", (p) => {
      if (p.deviceClass === 0x0e && p.subclass === 0x01) {
        cameraApi.manager?.registerDevice?.({
          id: `camera-usb-${p.deviceId}`,
          label: p.productName || "USB Camera",
          kind: "uvc",
          supportsVideo: true,
          supportsPhoto: true,
          maxWidth: p.maxWidth || 1920,
          maxHeight: p.maxHeight || 1080,
        });
        syslogsApi.info(
          "com.rainos.camera",
          "device",
          `Cámara USB registrada: ${p.productName}`,
          p
        );
      }
    });
    return off;
  }, [cameraApi, syslogsApi]);

  // ---------------------------------------------------------------- USB desacoplado: limpiar
  useEffect(() => {
    const off = kernelBus.on("usb:device-detached", (p) => {
      audioApi.manager?.removeDevice?.(`audio-usb-${p.deviceId}`);
      displayApi.manager?.removeDisplay?.(`display-usb-${p.deviceId}`);
      cameraApi.manager?.unregisterDevice?.(`camera-usb-${p.deviceId}`);
    });
    return off;
  }, [audioApi, displayApi, cameraApi]);

  // ---------------------------------------------------------------- Network ↔ Thermal (radio caliente)
  useEffect(() => {
    const off = kernelBus.on("network:request-completed", (p) => {
      thermalApi.setLoad?.("network", p.durationMs > 500 ? 3 : 1);
    });
    return off;
  }, [thermalApi]);

  // ---------------------------------------------------------------- Battery ↔ Thermal (carga calienta)
  useEffect(() => {
    const off = kernelBus.on("charge:state-changed", (p) => {
      if (p.to === "fast-charging" || p.to === "charging") {
        thermalApi.setLoad?.("charger", p.to === "fast-charging" ? 6 : 3);
      } else {
        thermalApi.setLoad?.("charger", 0);
      }
    });
    return off;
  }, [thermalApi]);

  // ---------------------------------------------------------------- Montaje global
  useEffect(() => {
    syslogsApi.info(
      "com.rainos.bridge",
      "boot",
      "SystemBridge inicializado — cableando subsistemas",
      {
        subsystems: [
          "battery",
          "charge",
          "drivers",
          "display",
          "audio",
          "network",
          "usb",
          "bluetooth",
          "camera",
          "thermal",
        ],
      }
    );

    return () => {
      syslogsApi.info(
        "com.rainos.bridge",
        "shutdown",
        "SystemBridge desmontado — liberando listeners",
        {}
      );
    };
  }, [syslogsApi]);

  return children;
}

// ============================================================================
// SHELL — interfaz principal una vez arrancado el sistema
// ============================================================================

function Shell() {
  const wm = useWindowManager();
  const runtime = useRuntime();

  const syscallsApi = useSyscalls();
  const syslogsApi = useSyslogs();
  const driversApi = useDrivers();
  const chargeApi = useChargeSystem();
  const diagnoseApi = useDiagnose();
  const batteryApi = useBattery();
  const displayApi = useDisplay();
  const audioApi = useAudio();
  const networkApi = useNetwork();
  const usbApi = useUsb();
  const bluetoothApi = useBluetooth();
  const cameraApi = useCamera();
  const thermalApi = useThermals();

  const [showLaunchpad, setShowLaunchpad] = React.useState(false);
  const [showSpotlight, setShowSpotlight] = React.useState(false);
  const [showNotifications, setShowNotifications] = React.useState(false);
  const [showMissionControl, setShowMissionControl] = React.useState(false);
  const [showControlCenter, setShowControlCenter] = React.useState(false);
  const [showAppSwitcher, setShowAppSwitcher] = React.useState(false);

  // ------------------------------------------------------------------ atajos globales
  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;

      if (e.key === "F4" && !meta) {
        e.preventDefault();
        setShowLaunchpad((s) => !s);
        return;
      }

      if (meta && e.key === " ") {
        e.preventDefault();
        setShowSpotlight((s) => !s);
        return;
      }

      if ((e.key === "F3" && !meta) || (e.ctrlKey && e.key === "ArrowUp")) {
        e.preventDefault();
        setShowMissionControl((s) => !s);
        return;
      }

      if (meta && e.key === "Tab") {
        e.preventDefault();
        setShowAppSwitcher(true);
        return;
      }

      if (meta && e.shiftKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        syslogsApi.info(
          "com.rainos.sysdiagnose",
          "trigger",
          "Sysdiagnose iniciado por atajo ⌘⇧D"
        );
        diagnoseApi.run({ mode: "quick" });
        return;
      }

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
        driversApi.suspendAll?.();
        displayApi.sleepAll?.();
        audioApi.suspend?.();
        usbApi.suspendAll?.();
      },
      onRestart: () => {
        syslogsApi.warn("com.rainos.power", "restart", "Reinicio solicitado");
        window.location.reload();
      },
      onShutdown: () => {
        syslogsApi.warn("com.rainos.power", "shutdown", "Apagado solicitado");
        driversApi.detachAll?.();
        displayApi.sleepAll?.();
        audioApi.suspend?.();
        usbApi.suspendAll?.();
        bluetoothApi.powerOff?.();
        chargeApi.detachCharger?.();
      },
      onLockScreen: () => {
        syslogsApi.info(
          "com.rainos.lockscreen",
          "lock",
          "Pantalla bloqueada manualmente"
        );
      },
      onLogOut: () => {
        syslogsApi.info("com.rainos.session", "logout", "Cierre de sesión");
      },
    }),
    [runtime, syslogsApi, driversApi, displayApi, audioApi, usbApi, bluetoothApi, chargeApi]
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

      {/* Launchpad */}
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

      {/* Spotlight */}
      {showSpotlight && (
        <Spotlight
          apps={SYSTEM_APPS}
          actions={[
            { id: "lock", label: "Bloquear pantalla", icon: "🔒" },
            { id: "sleep", label: "Suspender", icon: "💤" },
            { id: "empty-trash", label: "Vaciar papelera", icon: "🗑️" },
            { id: "sysdiagnose", label: "Ejecutar sysdiagnose", icon: "🩺" },
            { id: "speedtest", label: "Speed test de red", icon: "🌐" },
            { id: "battery-diag", label: "Diagnóstico de batería", icon: "🔋" },
          ]}
          open={showSpotlight}
          onClose={() => setShowSpotlight(false)}
          onOpenApp={(app) => {
            runtime.launch(app.id);
            setShowSpotlight(false);
          }}
          onRunAction={async (action) => {
            if (action.id === "sysdiagnose") diagnoseApi.run();
            if (action.id === "sleep") {
              driversApi.suspendAll?.();
              displayApi.sleepAll?.();
              audioApi.suspend?.();
            }
            if (action.id === "speedtest") {
              syslogsApi.info("com.rainos.network", "speedtest", "Speed test iniciado");
              const result = await networkApi.speedTest?.();
              syslogsApi.info(
                "com.rainos.network",
                "speedtest",
                `Resultado: ${result?.downloadMbps?.toFixed(2) ?? "?"} Mbps`,
                result
              );
            }
            syslogsApi.info(
              "com.rainos.spotlight",
              "action",
              `Acción ejecutada: ${action.id}`
            );
          }}
        />
      )}

      {/* Notifications */}
      {showNotifications && (
        <Notifications
          open={showNotifications}
          onClose={() => setShowNotifications(false)}
        />
      )}

      {/* Mission Control */}
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
          onActivateSpace={() => {}}
          onAddSpace={() => {}}
        />
      )}

      {/* Control Center */}
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

      {/* App Switcher */}
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

      {/* Lock screen por encima de todo */}
      <LockScreenView />
    </>
  );
}

// ============================================================================
// BOOT GATE — controla qué se muestra según la fase del sistema
// ============================================================================

function BootGate() {
  const [security, setSecurity] = React.useState(null);
  const [showInit, setShowInit] = React.useState(true);

  // Instalar seguridad al arrancar
  useEffect(() => {
    const sec = new SecurityManager({ keychainName: "login" });
    sec.fileVault.enable();
    sec.fileVault.setPassword("rainos-default-password");
    sec.fileVault.lock();
    installSecurityHooks({ security: sec });
    setSecurity(sec);
    // Desbloqueo automático (en un SO real pediría contraseña)
    setTimeout(() => sec.fileVault.unlock("rainos-default-password"), 500);
  }, []);

  // Ocultar pantalla de arranque tras 2.6s
  useEffect(() => {
    const t = setTimeout(() => setShowInit(false), 2600);
    return () => clearTimeout(t);
  }, []);

  if (!security) return null;

  return (
    <SecurityProvider security={security}>
      <SyslogsProvider persist>
        <SyscallsProvider>
          <SysfilteredProvider>
            <BatteryProvider autoStart options={{ initialLevel: 0.78 }}>
              <ChargeSystemBridge>
                <DriversProvider autoInit>
                  <DisplayProvider autoStart autoCreate>
                    <AudioProvider autoInit autoCreateDevices>
                      <NetworkProvider autoInit>
                        <UsbProvider autoStart autoLoadSamples>
                          <BluetoothProvider autoPowerOn adapterName="rainOS BT">
                            <CameraProvider autoEnumerate includeVirtual>
                              <ThermalProvider autoStart autoCreateZones>
                                <DiagnoseBridge>
                                  <BatteryDiagnosticBridge>
                                    <SystemBridge>
                                      <RuntimeProvider
                                        apps={SYSTEM_APPS}
                                        security={security}
                                      >
                                        {showInit ? (
                                          <ConnectedInitSystem
                                            onFinished={() => setShowInit(false)}
                                          />
                                        ) : (
                                          <Shell />
                                        )}
                                      </RuntimeProvider>
                                    </SystemBridge>
                                  </BatteryDiagnosticBridge>
                                </DiagnoseBridge>
                              </ThermalProvider>
                            </CameraProvider>
                          </BluetoothProvider>
                        </UsbProvider>
                      </NetworkProvider>
                    </AudioProvider>
                  </DisplayProvider>
                </DriversProvider>
              </ChargeSystemBridge>
            </BatteryProvider>
          </SysfilteredProvider>
        </SyscallsProvider>
      </SyslogsProvider>
    </SecurityProvider>
  );
}

// ============================================================================
// APP — árbol de providers de la cadena de arranque
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

// ============================================================================
// EXPORTS AUXILIARES (para tests y composición externa)
// ============================================================================

export { SystemBridge, Shell, BootGate };
