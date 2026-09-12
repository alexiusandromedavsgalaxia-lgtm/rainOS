// ============================================================================
// App.jsx — Raíz de rainOS
// ----------------------------------------------------------------------------
// Monta TODO el sistema operativo. Este es el árbol de providers definitivo:
//
//   Bootstrap → WindowManager → SafeBoot → BootLoader → Scheduler
//   → Updater → Toast → AppInstaller → DMGInstaller
//   → StartupInstaller → InitialConfig → LockScreen
//   → BootGate
//       → SecurityProvider
//       → SyslogsProvider
//       → SyscallsProvider
//       → SysfilteredProvider
//       → BatteryProvider
//       → ChargeSystemProvider
//       → DriversProvider
//       → DisplayProvider
//       → AudioProvider
//       → NetworkProvider
//       → UsbProvider
//       → BluetoothProvider
//       → CameraProvider
//       → ThermalProvider
//       → DiagnoseProvider
//       → BatteryDiagnosticProvider
//       → SystemBridge
//       → RuntimeProvider
//       → Shell
//
// Convención de acceso a APIs:
//   - Todo hook `useXxx()` devuelve un objeto con sub-APIs (manager/system/bus/…).
//   - Los métodos se llaman SIEMPRE a través del sub-objeto (`api.manager.foo()`).
//   - Usamos `?.()` para que un método ausente no rompa el boot.
// ============================================================================

import React, { useEffect, useMemo, useContext, useState } from "react";

import { kernelBus } from "./kernel/kernel.jsx";

// ─────────────── Kernel / cadena de arranque ───────────────
import { WindowManagerProvider, useWindowManager } from "./kernel/kernel.jsx";
import { BootstrapProvider } from "./bootstrap/bootstrap.jsx";
import { BootLoaderProvider } from "./bootloader/bootloader.jsx";
import { SafeBootProvider } from "./safeboot/safeboot.jsx";
import { SchedulerProvider } from "./scheduler/scheduler.jsx";

// ─────────────── Instaladores y sistema ───────────────
import { StartupInstallerProvider } from "./startupinstaller/startupinstaller.jsx";
import { InitialConfigProvider } from "./initialconfig/initialconfig.jsx";
import { ConnectedInitSystem } from "./initsystem/initsystem.jsx";
import { UpdaterProvider } from "./updater/updater.jsx";
import { ToastProvider } from "./toast/toast.jsx";
import { AppInstallerProvider } from "./appinstaller/appinstaller.jsx";
import { DMGInstallerProvider } from "./dmginstaller/dmginstaller.jsx";

// ─────────────── Sistema ───────────────
import { SyslogsProvider, useSyslogs } from "./system/syslogs.jsx";
import { SyscallsProvider, useSyscalls } from "./system/syscalls.jsx";
import { SysfilteredProvider } from "./system/sysfiltered.jsx";
import { DiagnoseProvider, useDiagnose } from "./system/sysdiagnose.jsx";
import {
  BatteryDiagnosticProvider,
  useBatteryDiagnostic,
} from "./system/sysbatdiagnostic.jsx";

// ─────────────── Hardware ───────────────
import { BatteryProvider, useBattery } from "./hardware/battery.jsx";
import {
  ChargeSystemProvider,
  useChargeSystem,
} from "./hardware/chargesystem.jsx";
import { DriversProvider, useDrivers } from "./hardware/drivers.jsx";
import { DisplayProvider, useDisplay } from "./hardware/display.jsx";
import { AudioProvider, useAudio } from "./hardware/audio.jsx";
import { NetworkProvider, useNetwork } from "./hardware/network.jsx";
import { UsbProvider, useUsb } from "./hardware/usb.jsx";
import { BluetoothProvider, useBluetooth } from "./hardware/bluetooth.jsx";
import { CameraProvider, useCamera } from "./hardware/camera.jsx";
import { ThermalProvider, useThermals } from "./hardware/thermals.jsx";

// ─────────────── Seguridad ───────────────
import { SecurityManager, installSecurityHooks } from "./security/security.jsx";

// ─────────────── Runtime de apps ───────────────
import {
  RuntimeProvider,
  buildSystemApps,
  useRuntime,
} from "./runtime/runtime.jsx";

// ─────────────── Bloqueo ───────────────
import {
  LockScreenProvider,
  LockScreenView,
} from "./lockscreen/lockscreen.jsx";

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
// SECURITY CONTEXT
// ============================================================================

const SecurityContext = React.createContext(null);

export function useSecurity() {
  const ctx = useContext(SecurityContext);
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
// SUB-BRIDGE: ChargeSystem necesita la Battery
// ============================================================================

function ChargeSystemBridge({ children }) {
  const batteryApi = useBattery();
  return (
    <ChargeSystemProvider battery={batteryApi.battery} autoStart>
      {children}
    </ChargeSystemProvider>
  );
}

// ============================================================================
// SUB-BRIDGE: Diagnose necesita todos los subsistemas
// ============================================================================

function DiagnoseBridge({ children }) {
  const syslogsApi = useSyslogs();
  const syscallsApi = useSyscalls();
  const batteryApi = useBattery();
  const chargeApi = useChargeSystem();
  const driversApi = useDrivers();
  const displayApi = useDisplay();
  const audioApi = useAudio();
  const networkApi = useNetwork();
  const usbApi = useUsb();
  const bluetoothApi = useBluetooth();
  const cameraApi = useCamera();
  const thermalApi = useThermals();
  const security = useContext(SecurityContext);

  const ctxFactory = useMemo(
    () => () => ({
      battery: batteryApi.battery,
      chargeSystem: chargeApi.system,
      syslogs: syslogsApi.system,
      syscalls: syscallsApi.table,
      drivers: driversApi.manager,
      display: displayApi.manager,
      audio: audioApi.manager,
      network: networkApi.manager,
      usb: usbApi.bus,
      bluetooth: bluetoothApi.manager,
      camera: cameraApi.manager,
      thermal: thermalApi.manager,
      security,
      crashes: [],
      spindumps: [],
      bootTime:
        typeof performance !== "undefined"
          ? performance.timeOrigin ?? Date.now()
          : Date.now(),
    }),
    [
      batteryApi, chargeApi, syslogsApi, syscallsApi, driversApi, displayApi,
      audioApi, networkApi, usbApi, bluetoothApi, cameraApi, thermalApi, security,
    ]
  );

  return <DiagnoseProvider ctxFactory={ctxFactory}>{children}</DiagnoseProvider>;
}

// ============================================================================
// SUB-BRIDGE: BatteryDiagnostic
// ============================================================================

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
      {children}
    </BatteryDiagnosticProvider>
  );
}

// ============================================================================
// SYSTEM BRIDGE — cablea eventos entre todos los subsistemas
// ============================================================================
//
// Este componente es el pegamento del kernel: escucha eventos de kernelBus
// y los traduce en acciones sobre los distintos subsistemas (logs, throttle,
// hotplug de audio/display/cámara, etc.). Toda llamada a un método externo
// va con `?.()` para que un método ausente no rompa el boot.
// ============================================================================

function SystemBridge({ children }) {
  const syslogsApi = useSyslogs();
  const batteryApi = useBattery();
  const chargeApi = useChargeSystem();
  const driversApi = useDrivers();
  const displayApi = useDisplay();
  const audioApi = useAudio();
  const networkApi = useNetwork();
  const usbApi = useUsb();
  const bluetoothApi = useBluetooth();
  const cameraApi = useCamera();
  const thermalApi = useThermals();

  // ---------------------------------------------------------------- batería → logs + thermal
  useEffect(() => {
    const offs = [
      kernelBus.on("battery:low", (p) =>
        syslogsApi.info("com.rainos.battery", "power", "Batería baja", p)
      ),
      kernelBus.on("battery:critical", (p) => {
        syslogsApi.error("com.rainos.battery", "power", "Batería crítica", p);
        thermalApi.manager?.setPolicy?.("efficiency");
      }),
      kernelBus.on("battery:plugged", (p) => {
        syslogsApi.info("com.rainos.battery", "charger", "Cargador enchufado", p);
        thermalApi.manager?.setLoad?.("battery", 4);
      }),
      kernelBus.on("battery:unplugged", (p) => {
        syslogsApi.info("com.rainos.battery", "charger", "Cargador desenchufado", p);
        thermalApi.manager?.setLoad?.("battery", 0);
      }),
      kernelBus.on("battery:overheat", (p) => {
        syslogsApi.error("com.rainos.battery", "thermal", "Sobrecalentamiento", p);
        chargeApi.system?.cancelFullCharge?.();
      }),
      kernelBus.on("battery:full", (p) =>
        syslogsApi.info("com.rainos.battery", "charger", "Batería completa", p)
      ),
      kernelBus.on("battery:health-degraded", (p) =>
        syslogsApi.warn("com.rainos.battery", "health", "Salud degradada", p)
      ),
      kernelBus.on("battery:cycle", (p) =>
        syslogsApi.info("com.rainos.battery", "cycles", `Ciclos: ${p.cycleCount}`, p)
      ),
    ];
    return () => offs.forEach((off) => off && off());
  }, [syslogsApi, thermalApi, chargeApi]);

  // ---------------------------------------------------------------- charge → logs
  useEffect(() => {
    const offs = [
      kernelBus.on("charge:state-changed", (p) =>
        syslogsApi.info("com.rainos.charge", "state", `Carga: ${p.from} → ${p.to}`, p)
      ),
      kernelBus.on("charge:charger-attached", (p) =>
        syslogsApi.info("com.rainos.charge", "attach", `Cargador ${p.kind} (${p.watts}W)`, p)
      ),
      kernelBus.on("charge:charger-detached", (p) =>
        syslogsApi.info("com.rainos.charge", "detach", `Cargador desconectado (era ${p.prevKind})`, p)
      ),
      kernelBus.on("charge:optimized-pause", (p) =>
        syslogsApi.info("com.rainos.charge", "optimized", `Carga pausada al ${Math.round(p.limit * 100)}%`, p)
      ),
      kernelBus.on("charge:optimized-resume", (p) =>
        syslogsApi.info("com.rainos.charge", "optimized", "Carga reanudada", p)
      ),
      kernelBus.on("charge:overheat", (p) =>
        syslogsApi.error("com.rainos.charge", "thermal", `Pausa por temperatura ${p.temperatureC.toFixed(1)}°C`, p)
      ),
    ];
    return () => offs.forEach((off) => off && off());
  }, [syslogsApi]);

  // ---------------------------------------------------------------- drivers → logs
  useEffect(() => {
    const offs = [
      kernelBus.on("driver:registered", (p) =>
        syslogsApi.debug("com.rainos.driver", "register", `Driver ${p.id}@${p.version}`, p)
      ),
      kernelBus.on("driver:started", (p) =>
        syslogsApi.debug("com.rainos.driver", "lifecycle", `Driver started: ${p.driverId}`, p)
      ),
      kernelBus.on("driver:probe-failed", (p) =>
        syslogsApi.error("com.rainos.driver", "probe", `Probe failed: ${p.driverId}`, p)
      ),
      kernelBus.on("driver:irq-fired", (p) =>
        syslogsApi.debug("com.rainos.driver", "irq", `IRQ ${p.irq}`, p)
      ),
    ];
    return () => offs.forEach((off) => off && off());
  }, [syslogsApi]);

  // ---------------------------------------------------------------- syscalls con error → logs
  useEffect(() => {
    const off = kernelBus.on("syscall:called", (entry) => {
      if (entry.blocked || entry.errno !== 0) {
        syslogsApi.warn(
          "com.rainos.syscall",
          entry.category || "misc",
          `syscall ${entry.name} #${entry.number} → ${entry.errnoName}`,
          { pid: entry.pid, args: entry.args }
        );
      }
    });
    return () => off && off();
  }, [syslogsApi]);

  // ---------------------------------------------------------------- display → logs
  useEffect(() => {
    const offs = [
      kernelBus.on("display:connected", (p) =>
        syslogsApi.info("com.rainos.display", "hotplug", `Display conectado: ${p.name}`, p)
      ),
      kernelBus.on("display:mode-changed", (p) =>
        syslogsApi.info("com.rainos.display", "mode", `Modo: ${p.mode.width}x${p.mode.height}@${p.mode.refresh}Hz`, p)
      ),
      kernelBus.on("display:hdr-changed", (p) =>
        syslogsApi.info("com.rainos.display", "hdr", `HDR: ${p.hdrMode}`, p)
      ),
    ];
    return () => offs.forEach((off) => off && off());
  }, [syslogsApi]);

  // ---------------------------------------------------------------- audio → logs
  useEffect(() => {
    const offs = [
      kernelBus.on("audio:device-added", (p) =>
        syslogsApi.info("com.rainos.audio", "device", `Dispositivo añadido: ${p.name}`, p)
      ),
      kernelBus.on("audio:device-removed", (p) =>
        syslogsApi.info("com.rainos.audio", "device", `Dispositivo removido: ${p.deviceId}`, p)
      ),
      kernelBus.on("audio:default-output-changed", (p) =>
        syslogsApi.info("com.rainos.audio", "route", `Salida por defecto: ${p.id}`, p)
      ),
    ];
    return () => offs.forEach((off) => off && off());
  }, [syslogsApi]);

  // ---------------------------------------------------------------- network → logs
  useEffect(() => {
    const offs = [
      kernelBus.on("network:reachability-changed", (p) =>
        syslogsApi.info("com.rainos.network", "reachability", p.online ? "Online" : "Offline", p)
      ),
      kernelBus.on("network:request-completed", (p) =>
        syslogsApi.debug("com.rainos.network", "http", `${p.method} ${p.url} → ${p.status} (${p.durationMs}ms)`, p)
      ),
      kernelBus.on("network:request-failed", (p) =>
        syslogsApi.error("com.rainos.network", "http", `Fallo: ${p.url}`, p)
      ),
      kernelBus.on("network:dns-failed", (p) =>
        syslogsApi.warn("com.rainos.network", "dns", `DNS falló: ${p.host}`, p)
      ),
      kernelBus.on("network:firewall-blocked", (p) =>
        syslogsApi.warn("com.rainos.network", "firewall", `Bloqueado: ${p.host}`, p)
      ),
    ];
    return () => offs.forEach((off) => off && off());
  }, [syslogsApi]);

  // ---------------------------------------------------------------- USB → logs
  useEffect(() => {
    const offs = [
      kernelBus.on("usb:device-attached", (p) =>
        syslogsApi.info("com.rainos.usb", "attach", `USB conectado: ${p.productName}`, p)
      ),
      kernelBus.on("usb:device-detached", (p) =>
        syslogsApi.info("com.rainos.usb", "detach", `USB desconectado: ${p.deviceId}`, p)
      ),
      kernelBus.on("usb:device-enumerated", (p) =>
        syslogsApi.info("com.rainos.usb", "enumerate", `Enumerado en ${p.durationMs}ms`, p)
      ),
      kernelBus.on("usb:device-error", (p) =>
        syslogsApi.error("com.rainos.usb", "error", `Error en ${p.deviceId}`, p)
      ),
    ];
    return () => offs.forEach((off) => off && off());
  }, [syslogsApi]);

  // ---------------------------------------------------------------- Bluetooth → logs + Audio
  useEffect(() => {
    const offs = [
      kernelBus.on("bt:adapter-state-changed", (p) =>
        syslogsApi.info("com.rainos.bluetooth", "adapter", `Adapter: ${p.from} → ${p.to}`, p)
      ),
      kernelBus.on("bt:device-added", (p) =>
        syslogsApi.info("com.rainos.bluetooth", "device", `BT detectado: ${p.name}`, p)
      ),
      kernelBus.on("bt:pair-succeeded", (p) =>
        syslogsApi.info("com.rainos.bluetooth", "pair", `Emparejado: ${p.deviceId}`, p)
      ),
      kernelBus.on("bt:pair-failed", (p) =>
        syslogsApi.error("com.rainos.bluetooth", "pair", `Fallo pairing: ${p.deviceId}`, p)
      ),
      kernelBus.on("bt:connect-succeeded", (p) => {
        syslogsApi.info("com.rainos.bluetooth", "connect", `Conectado: ${p.deviceId}`, p);
        const device = bluetoothApi.manager?.getDevice?.(p.deviceId);
        if (device?.profiles?.has?.("a2dp")) {
          audioApi.manager?.addDevice?.({
            id: `audio-bt-${p.deviceId}`,
            name: device.name,
            kind: "bluetooth",
            isOutput: true,
          });
        }
      }),
      kernelBus.on("bt:disconnected", (p) => {
        syslogsApi.info("com.rainos.bluetooth", "disconnect", `Desconectado: ${p.deviceId}`, p);
        audioApi.manager?.removeDevice?.(`audio-bt-${p.deviceId}`);
      }),
      kernelBus.on("bt:notification-received", (p) =>
        syslogsApi.info("com.rainos.bluetooth", "ancs", `Notificación: ${p.title}`, p)
      ),
    ];
    return () => offs.forEach((off) => off && off());
  }, [syslogsApi, audioApi, bluetoothApi]);

  // ---------------------------------------------------------------- Camera → logs
  useEffect(() => {
    const offs = [
      kernelBus.on("camera:permission-granted", (p) =>
        syslogsApi.info("com.rainos.camera", "permission", "Permiso concedido", p)
      ),
      kernelBus.on("camera:permission-denied", (p) =>
        syslogsApi.warn("com.rainos.camera", "permission", "Permiso denegado", p)
      ),
      kernelBus.on("camera:stream-started", (p) =>
        syslogsApi.info("com.rainos.camera", "stream", `Stream iniciado: ${p.deviceId}`, p)
      ),
      kernelBus.on("camera:photo-captured", (p) =>
        syslogsApi.info(
          "com.rainos.camera",
          "photo",
          `Foto capturada (${p.width}x${p.height})`,
          p
        )
      ),
      kernelBus.on("camera:recording-started", (p) =>
        syslogsApi.info("com.rainos.camera", "record", "Grabación iniciada", p)
      ),
      kernelBus.on("camera:recording-stopped", (p) =>
        syslogsApi.info("com.rainos.camera", "record", "Grabación detenida", p)
      ),
    ];
    return () => offs.forEach((off) => off && off());
  }, [syslogsApi]);

  // ---------------------------------------------------------------- Security → logs
  useEffect(() => {
    const offs = [
      kernelBus.on("sec:codesign-verified", (p) =>
        syslogsApi.info("com.rainos.security", "codesign", "Firma verificada", p)
      ),
      kernelBus.on("sec:codesign-failed", (p) =>
        syslogsApi.error("com.rainos.security", "codesign", "Firma inválida", p)
      ),
      kernelBus.on("sec:gatekeeper-blocked", (p) =>
        syslogsApi.error("com.rainos.security", "gatekeeper", `Bloqueado: ${p.path}`, p)
      ),
      kernelBus.on("sec:sandbox-violation", (p) =>
        syslogsApi.warn("com.rainos.security", "sandbox", `Violación: ${p.bundleId}`, p)
      ),
      kernelBus.on("sec:tcc-requested", (p) =>
        syslogsApi.info("com.rainos.security", "tcc", `Permiso solicitado: ${p.service}`, p)
      ),
      kernelBus.on("sec:tcc-granted", (p) =>
        syslogsApi.info("com.rainos.security", "tcc", `Permiso concedido: ${p.service}`, p)
      ),
      kernelBus.on("sec:tcc-denied", (p) =>
        syslogsApi.warn("com.rainos.security", "tcc", `Permiso denegado: ${p.service}`, p)
      ),
      kernelBus.on("sec:sip-write-blocked", (p) =>
        syslogsApi.error("com.rainos.security", "sip", `Escritura bloqueada: ${p.path}`, p)
      ),
    ];
    return () => offs.forEach((off) => off && off());
  }, [syslogsApi]);

  // ---------------------------------------------------------------- Thermal → logs
  useEffect(() => {
    const offs = [
      kernelBus.on("thermal:trip-crossed", (p) =>
        syslogsApi.warn(
          "com.rainos.thermal",
          "trip",
          `Trip L${p.level} en ${p.zoneId} (${p.tempC?.toFixed?.(1) ?? p.tempC}°C)`,
          p
        )
      ),
      kernelBus.on("thermal:trip-recovered", (p) =>
        syslogsApi.info(
          "com.rainos.thermal",
          "trip",
          `Recuperado en ${p.zoneId} (${p.tempC?.toFixed?.(1) ?? p.tempC}°C)`,
          p
        )
      ),
      kernelBus.on("thermal:throttle-start", (p) =>
        syslogsApi.warn(
          "com.rainos.thermal",
          "throttle",
          `Throttling iniciado (${Math.round((p.throttle ?? 0) * 100)}%)`,
          p
        )
      ),
      kernelBus.on("thermal:throttle-stop", () =>
        syslogsApi.info("com.rainos.thermal", "throttle", "Throttling detenido", {})
      ),
      kernelBus.on("thermal:critical-reached", (p) =>
        syslogsApi.error(
          "com.rainos.thermal",
          "critical",
          `Nivel crítico alcanzado (${p.tempC?.toFixed?.(1) ?? p.level}°C)`,
          p
        )
      ),
      kernelBus.on("thermal:emergency-reached", (p) => {
        syslogsApi.error("com.rainos.thermal", "emergency", `Emergencia térmica (${p.level})`, p);
        thermalApi.manager?.setPolicy?.("efficiency");
        bluetoothApi.manager?.powerOff?.();
        cameraApi.manager?.stopAll?.();
      }),
      kernelBus.on("thermal:shutdown", (p) => {
        syslogsApi.error("com.rainos.thermal", "shutdown", `Apagado por temperatura: ${p.tempC}°C`, p);
        driversApi.manager?.detachAll?.();
        displayApi.manager?.sleepAll?.();
        audioApi.manager?.suspend?.();
        usbApi.bus?.suspendAll?.();
      }),
      kernelBus.on("thermal:fan-update", (p) =>
        syslogsApi.debug("com.rainos.thermal", "fan", `Fan ${p.coolerId}: ${p.rpm} rpm`, p)
      ),
      kernelBus.on("thermal:policy-changed", (p) =>
        syslogsApi.info("com.rainos.thermal", "policy", `Política: ${p.from} → ${p.to}`, p)
      ),
    ];
    return () => offs.forEach((off) => off && off());
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
    return () => off && off();
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
    return () => off && off();
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
    return () => off && off();
  }, [cameraApi, syslogsApi]);

  // ---------------------------------------------------------------- USB desacoplado: limpiar
  useEffect(() => {
    const off = kernelBus.on("usb:device-detached", (p) => {
      audioApi.manager?.removeDevice?.(`audio-usb-${p.deviceId}`);
      displayApi.manager?.removeDisplay?.(`display-usb-${p.deviceId}`);
      cameraApi.manager?.unregisterDevice?.(`camera-usb-${p.deviceId}`);
    });
    return () => off && off();
  }, [audioApi, displayApi, cameraApi]);

  // ---------------------------------------------------------------- Network ↔ Thermal (radio caliente)
  useEffect(() => {
    const off = kernelBus.on("network:request-completed", (p) => {
      thermalApi.manager?.setLoad?.("network", p.durationMs > 500 ? 3 : 1);
    });
    return () => off && off();
  }, [thermalApi]);

  // ---------------------------------------------------------------- Battery ↔ Thermal (carga calienta)
  useEffect(() => {
    const off = kernelBus.on("charge:state-changed", (p) => {
      if (p.to === "fast-charging" || p.to === "charging") {
        thermalApi.manager?.setLoad?.("charger", p.to === "fast-charging" ? 6 : 3);
      } else {
        thermalApi.manager?.setLoad?.("charger", 0);
      }
    });
    return () => off && off();
  }, [thermalApi]);

  // ---------------------------------------------------------------- Carga de batería simulada según CPU
  useEffect(() => {
    const interval = setInterval(() => {
      const load = 3 + Math.random() * 3; // 3-6 W
      batteryApi.battery?.setLoad?.(load);
    }, 5000);
    return () => clearInterval(interval);
  }, [batteryApi]);

  // ---------------------------------------------------------------- Carga térmica simulada
  useEffect(() => {
    const interval = setInterval(() => {
      // La CPU P genera entre 3 y 12W según carga simulada
      const cpuLoad = 3 + Math.random() * 9;
      thermalApi.manager?.setLoad?.("cpu-p", cpuLoad);

      // GPU genera entre 1 y 6W
      const gpuLoad = 1 + Math.random() * 5;
      thermalApi.manager?.setLoad?.("gpu", gpuLoad);

      // Display siempre 2-3W
      thermalApi.manager?.setLoad?.("display", 2 + Math.random());
    }, 3000);
    return () => clearInterval(interval);
  }, [thermalApi]);

  // ---------------------------------------------------------------- Red: medir latencia periódicamente
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        await networkApi.manager?.ping?.("https://cloudflare.com");
      } catch {
        // silencioso
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [networkApi]);

  // ---------------------------------------------------------------- USB: hot-plug aleatorio
  useEffect(() => {
    const interval = setInterval(() => {
      // Cada 45s, 20% de probabilidad de desconectar algo
      if (Math.random() > 0.8) {
        const devices = usbApi.bus?.listDevices?.() ?? [];
        if (devices.length > 0 && Math.random() > 0.5) {
          const random = devices[Math.floor(Math.random() * devices.length)];
          usbApi.bus?.detachDevice?.(random.id);
        }
      }
    }, 45000);
    return () => clearInterval(interval);
  }, [usbApi]);

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

  const syslogsApi = useSyslogs();
  const driversApi = useDrivers();
  const chargeApi = useChargeSystem();
  const diagnoseApi = useDiagnose();
  const displayApi = useDisplay();
  const audioApi = useAudio();
  const networkApi = useNetwork();
  const usbApi = useUsb();
  const bluetoothApi = useBluetooth();

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
          "Sysdiagnose iniciado por atajo ⌘⇧D"
        );
        diagnoseApi.run?.({ mode: "quick" });
        return;
      }

      // Esc cierra overlays
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
        driversApi.manager?.suspendAll?.();
        displayApi.manager?.sleepAll?.();
        audioApi.manager?.suspend?.();
        usbApi.bus?.suspendAll?.();
      },
      onRestart: () => {
        syslogsApi.warn("com.rainos.power", "restart", "Reinicio solicitado");
        window.location.reload();
      },
      onShutdown: () => {
        syslogsApi.warn("com.rainos.power", "shutdown", "Apagado solicitado");
        driversApi.manager?.detachAll?.();
        displayApi.manager?.sleepAll?.();
        audioApi.manager?.suspend?.();
        usbApi.bus?.suspendAll?.();
        bluetoothApi.manager?.powerOff?.();
        chargeApi.system?.detachCharger?.();
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
    [
      runtime,
      syslogsApi,
      driversApi,
      displayApi,
      audioApi,
      usbApi,
      bluetoothApi,
      chargeApi,
    ]
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
            if (action.id === "sysdiagnose") diagnoseApi.run?.();
            if (action.id === "sleep") {
              driversApi.manager?.suspendAll?.();
              displayApi.manager?.sleepAll?.();
              audioApi.manager?.suspend?.();
            }
            if (action.id === "speedtest") {
              syslogsApi.info("com.rainos.network", "speedtest", "Speed test iniciado");
              const result = await networkApi.manager?.speedTest?.();
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
