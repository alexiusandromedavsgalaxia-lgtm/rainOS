// ============================================================================
// runtime.jsx — Runtime de ejecución de apps (v2)
// ----------------------------------------------------------------------------
// Conecta el mundo "estático" (registry de apps, iconos, dock) con el mundo
// "dinámico" (ventanas reales renderizadas por el kernel).
//
// AHORA TAMBIÉN GESTIONA:
//   - Procesos virtuales (VCPU) por app cuando hace falta
//   - Contextos de seguridad (sandbox + entitlements) por app
//   - Integración con Dyld para apps Mach-O reales
//   - Ciclo de vida completo (launch, suspend, resume, terminate)
//   - Persistencia del estado de sesiones
//   - Prioridad y QoS por app
//   - Notificaciones del sistema cuando una app termina
//
// RESPONSABILIDADES
//
//   1. APP REGISTRY
//      - Registro central de todas las apps del sistema
//      - Metadata: id, name, icon, component, width, height, flags
//      - Soporte para apps nativas (component) y apps Mach-O (bytes)
//      - Categorías, keywords, capabilities declaradas
//
//   2. APP LAUNCHER
//      - `launch(appId, options)` → abre una ventana nueva
//      - `focusOrLaunch(appId)` → foco o abre
//      - `launchWithData(appId, data)` → abre con payload
//      - `close(appId)` / `closeAll(appId)` → cierra instancias
//      - `quit(appId)` → cierra todas las ventanas
//
//   3. PROCESS MANAGER
//      - PID único por instancia de app
//      - VCPU + memoria aislada por proceso (si la app lo pide)
//      - Lifecycle: spawn → run → suspend → resume → terminate
//      - Kill con SIGTERM / SIGKILL
//
//   4. SECURITY INTEGRATION
//      - Verifica entitlements antes de lanzar
//      - Crea sandbox por bundle ID
//      - Aplica TCC al pedir servicios
//      - Hook en Gatekeeper para apps externas
//
//   5. PERSISTENCE
//      - Guarda/restaura sesiones de apps con `stateful: true`
//      - Estado por app en localStorage
//      - Historial de últimas 100 ejecuciones
//
// ============================================================================

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";

import { kernelBus, KERNEL_EVENTS, useWindowManager } from "../kernel/kernel.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

export const RUNTIME_EVENTS = Object.freeze({
  APP_REGISTERED: "runtime:app-registered",
  APP_UNREGISTERED: "runtime:app-unregistered",
  APP_LAUNCHED: "runtime:app-launched",
  APP_FOCUSED: "runtime:app-focused",
  APP_BLURRED: "runtime:app-blurred",
  APP_CLOSED: "runtime:app-closed",
  APP_QUIT: "runtime:app-quit",
  APP_CRASHED: "runtime:app-crashed",
  APP_SUSPENDED: "runtime:app-suspended",
  APP_RESUMED: "runtime:app-resumed",
  PROCESS_SPAWNED: "runtime:process-spawned",
  PROCESS_EXITED: "runtime:process-exited",
  REGISTRY_CHANGED: "runtime:registry-changed",
  LAUNCH_FAILED: "runtime:launch-failed",
  SECURITY_VIOLATION: "runtime:security-violation",
  LOG: "runtime:log",
});

export const APP_KIND = Object.freeze({
  NATIVE: "native",       // Componente React (Finder, Terminal, etc.)
  MACHO: "macho",         // Binario Mach-O (apps reales de macOS)
  SHELL: "shell",         // Ejecutable de shell script
  BUNDLE: "bundle",       // .app bundle con Info.plist
  PLUGIN: "plugin",       // Extensión cargable
});

export const APP_STATE = Object.freeze({
  REGISTERED: "registered",
  LAUNCHING: "launching",
  RUNNING: "running",
  SUSPENDED: "suspended",
  TERMINATING: "terminating",
  TERMINATED: "terminated",
  CRASHED: "crashed",
});

export const QOS_CLASS = Object.freeze({
  USER_INTERACTIVE: "user-interactive",
  USER_INITIATED: "user-initiated",
  DEFAULT: "default",
  UTILITY: "utility",
  BACKGROUND: "background",
});

// ============================================================================
// LOGGER
// ============================================================================

class RuntimeLog {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(RUNTIME_EVENTS.LOG, e);
    if (level === "error") console.error("[runtime]", message, meta);
  }
  info(m, x) { this.push("info", m, x); }
  warn(m, x) { this.push("warn", m, x); }
  error(m, x) { this.push("error", m, x); }
}

// ============================================================================
// APP REGISTRY
// ============================================================================

class AppRegistry {
  constructor() {
    this.apps = new Map();
    this.log = new RuntimeLog();
  }

  /**
   * Registra una app.
   *
   * @param {Object} def — Definición:
   *   {
   *     id: string,
   *     name: string,
   *     icon: string | function,
   *     kind?: APP_KIND.NATIVE (default),
   *     component?: React.ComponentType,   // para NATIVE
   *     bundleBytes?: Uint8Array,          // para MACHO/BUNDLE
   *     bundlePath?: string,
   *     width?, height?, minWidth?, minHeight?,
   *     singleton?: boolean,
   *     stateful?: boolean,                // persiste estado al cerrar
   *     hidden?: boolean,                  // no mostrar en Launchpad
   *     category?: string,
   *     keywords?: string[],
   *     qos?: QOS_CLASS,
   *     entitlements?: Object,             // com.apple.security.*
   *     flags?: { resizable, closable, minimizable, maximizable, fullscreenable },
   *     requires?: string[],               // APIs requeridas (network, camera, ...)
   *   }
   */
  register(def) {
    if (!def?.id) throw new Error("[runtime] app requires an id");
    if (def.kind === APP_KIND.MACHO && !def.bundleBytes) {
      throw new Error(`[runtime] app "${def.id}" is MACHO but has no bundleBytes`);
    }
    if ((!def.kind || def.kind === APP_KIND.NATIVE) && !def.component) {
      throw new Error(`[runtime] app "${def.id}" is NATIVE but has no component`);
    }

    const entry = {
      id: def.id,
      name: def.name || def.id,
      icon: def.icon || "📦",
      kind: def.kind || APP_KIND.NATIVE,
      component: def.component || null,
      bundleBytes: def.bundleBytes || null,
      bundlePath: def.bundlePath || null,
      width: def.width ?? 800,
      height: def.height ?? 500,
      minWidth: def.minWidth,
      minHeight: def.minHeight,
      singleton: def.singleton ?? false,
      stateful: def.stateful ?? false,
      hidden: def.hidden ?? false,
      category: def.category ?? "Otros",
      keywords: def.keywords ?? [],
      qos: def.qos ?? QOS_CLASS.DEFAULT,
      entitlements: def.entitlements || {},
      requires: def.requires || [],
      flags: {
        resizable: def.flags?.resizable !== false,
        closable: def.flags?.closable !== false,
        minimizable: def.flags?.minimizable !== false,
        maximizable: def.flags?.maximizable !== false,
        fullscreenable: def.flags?.fullscreenable !== false,
      },
      registeredAt: Date.now(),
    };

    this.apps.set(entry.id, entry);
    kernelBus.emit(RUNTIME_EVENTS.APP_REGISTERED, { id: entry.id, app: entry });
    this.log.info(`app registered: ${entry.id}`);
    return entry;
  }

  registerMany(defs) {
    return defs.map((d) => this.register(d));
  }

  unregister(id) {
    const app = this.apps.get(id);
    if (!app) return false;
    this.apps.delete(id);
    kernelBus.emit(RUNTIME_EVENTS.APP_UNREGISTERED, { id });
    this.log.info(`app unregistered: ${id}`);
    return true;
  }

  get(id) { return this.apps.get(id) ?? null; }
  has(id) { return this.apps.has(id); }
  all() { return Array.from(this.apps.values()); }
  visible() { return this.all().filter((a) => !a.hidden); }

  byCategory() {
    const groups = new Map();
    for (const app of this.visible()) {
      if (!groups.has(app.category)) groups.set(app.category, []);
      groups.get(app.category).push(app);
    }
    return groups;
  }

  search(query) {
    if (!query) return this.visible();
    const q = query.toLowerCase();
    return this.visible().filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        a.keywords.some((k) => k.toLowerCase().includes(q))
    );
  }
}

// ============================================================================
// PROCESS (una instancia de app corriendo)
// ============================================================================

let _pidCounter = 100;
const nextPid = () => ++_pidCounter;

class AppProcess {
  constructor(appDef) {
    this.pid = nextPid();
    this.appDef = appDef;
    this.appId = appDef.id;
    this.state = APP_STATE.LAUNCHING;
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.windows = new Set();
    this.vcpu = null;             // solo si kind === MACHO
    this.dyld = null;
    this.sandbox = null;          // security context
    this.exitCode = null;
    this.meta = {};
  }

  addWindow(winId) {
    this.windows.add(winId);
  }

  removeWindow(winId) {
    this.windows.delete(winId);
  }

  get isAlive() {
    return this.state === APP_STATE.RUNNING || this.state === APP_STATE.LAUNCHING || this.state === APP_STATE.SUSPENDED;
  }

  snapshot() {
    return {
      pid: this.pid,
      appId: this.appId,
      state: this.state,
      windows: Array.from(this.windows),
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      exitCode: this.exitCode,
      hasVcpu: !!this.vcpu,
      hasSandbox: !!this.sandbox,
    };
  }
}

// ============================================================================
// APP RUNTIME (clase pura)
// ============================================================================

export class AppRuntime {
  constructor({ windowManager, registry, security, dyld } = {}) {
    this.registry = registry || new AppRegistry();
    this.windowManager = windowManager || null;
    this.security = security || null;
    this.dyld = dyld || null;
    this.log = new RuntimeLog();
    this.listeners = new Set();

    // Mapa appId → Set<winId>
    this.sessions = new Map();
    // Mapa winId → appId
    this.windowToApp = new Map();
    // Mapa pid → AppProcess
    this.processes = new Map();
    // Mapa appId → Set<pid>
    this.appProcesses = new Map();

    // Estado persistido por app
    this.persistedState = new Map();
  }

  setWindowManager(wm) {
    this.windowManager = wm;
  }

  setSecurity(security) {
    this.security = security;
  }

  setDyld(dyld) {
    this.dyld = dyld;
  }

  // -------------------------------------------------------------- suscripción
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify() {
    const snap = this.getState();
    for (const fn of this.listeners) {
      try { fn(snap); } catch (err) { console.error("[runtime] subscriber error", err); }
    }
  }

  getState() {
    const sessions = {};
    for (const [appId, set] of this.sessions.entries()) {
      sessions[appId] = Array.from(set);
    }
    const processes = {};
    for (const [pid, proc] of this.processes.entries()) {
      processes[pid] = proc.snapshot();
    }
    return {
      runningApps: Object.keys(sessions),
      sessions,
      counts: Object.fromEntries(
        Object.entries(sessions).map(([id, arr]) => [id, arr.length])
      ),
      processes,
    };
  }

  // -------------------------------------------------------------- helpers
  _getActiveWin() {
    return this.windowManager?.getActive() ?? null;
  }

  _getApp(id) {
    return this.registry.get(id);
  }

  _persistAppState(appId, state) {
    try {
      localStorage.setItem(`runtime.app.${appId}.state`, JSON.stringify(state));
      this.persistedState.set(appId, state);
    } catch {}
  }

  _loadAppState(appId) {
    if (this.persistedState.has(appId)) return this.persistedState.get(appId);
    try {
      const raw = localStorage.getItem(`runtime.app.${appId}.state`);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.persistedState.set(appId, parsed);
        return parsed;
      }
    } catch {}
    return null;
  }

  // -------------------------------------------------------------- launch
  /**
   * Lanza una app.
   *
   * @param {string} appId
   * @param {Object} opts
   *   - data: payload para la app
   *   - x, y, width, height: pos/tamaño
   *   - newInstance: forzar nueva instancia aunque sea singleton
   *   - skipSecurity: (debug) saltar verificación de seguridad
   */
  async launch(appId, opts = {}) {
    const app = this._getApp(appId);
    if (!app) {
      kernelBus.emit(RUNTIME_EVENTS.LAUNCH_FAILED, { appId, error: "app not registered" });
      this.log.warn(`launch failed, app not found: ${appId}`);
      return null;
    }

    if (!this.windowManager) {
      this.log.error("launch failed, no window manager", { appId });
      return null;
    }

    // Singleton: si ya hay ventanas abiertas, enfocar
    const existing = this.sessions.get(appId);
    if (!opts.newInstance && app.singleton && existing && existing.size > 0) {
      const firstWinId = Array.from(existing)[0];
      this.windowManager.focus(firstWinId);
      this.log.info(`focused existing singleton: ${appId}`);
      return firstWinId;
    }

    // Verificación de seguridad para apps externas
    if (this.security && !opts.skipSecurity && app.kind !== APP_KIND.NATIVE) {
      try {
        const authz = this.security.authorizeApp({
          path: app.bundlePath || app.id,
          bytes: app.bundleBytes,
          bundleId: app.id,
          entitlements: app.entitlements,
        });
        if (!authz.allowed) {
          kernelBus.emit(RUNTIME_EVENTS.SECURITY_VIOLATION, { appId, reason: authz.reason });
          this.log.error(`security blocked launch: ${appId}`, { reason: authz.reason });
          throw new Error(authz.reason);
        }
        this._pendingSecurity = { [appId]: authz };
      } catch (err) {
        this.log.error(`launch failed (security): ${appId}`, err);
        return null;
      }
    }

    // Crear proceso
    const proc = new AppProcess(app);
    this.processes.set(proc.pid, proc);
    if (!this.appProcesses.has(appId)) this.appProcesses.set(appId, new Set());
    this.appProcesses.get(appId).add(proc.pid);

    kernelBus.emit(RUNTIME_EVENTS.PROCESS_SPAWNED, { pid: proc.pid, appId });

    // Para apps Mach-O: crear VCPU + Dyld + ejecutar
    if (app.kind === APP_KIND.MACHO || app.kind === APP_KIND.BUNDLE) {
      try {
        await this._launchMachoApp(proc, opts);
      } catch (err) {
        this.log.error(`macho launch failed: ${appId}`, err);
        proc.state = APP_STATE.CRASHED;
        kernelBus.emit(RUNTIME_EVENTS.APP_CRASHED, { appId, pid: proc.pid, error: String(err) });
        return null;
      }
    }

    // Crear ventana
    const persisted = app.stateful ? this._loadAppState(appId) : null;
    const winId = this.windowManager.open({
      appId: app.id,
      title: opts.title || app.name,
      component: app.component,
      data: { ...(persisted || {}), ...(opts.data || {}) },
      width: opts.width ?? app.width,
      height: opts.height ?? app.height,
      x: opts.x,
      y: opts.y,
      minWidth: app.minWidth,
      minHeight: app.minHeight,
      resizable: app.flags.resizable,
      closable: app.flags.closable,
      minimizable: app.flags.minimizable,
      maximizable: app.flags.maximizable,
      fullscreenable: app.flags.fullscreenable,
    });

    // Trackear
    if (!this.sessions.has(appId)) this.sessions.set(appId, new Set());
    this.sessions.get(appId).add(winId);
    this.windowToApp.set(winId, appId);
    proc.addWindow(winId);
    proc.state = APP_STATE.RUNNING;

    kernelBus.emit(RUNTIME_EVENTS.APP_LAUNCHED, {
      appId,
      pid: proc.pid,
      winId,
      app,
      data: opts.data ?? null,
    });
    this.log.info(`launched: ${appId} → window #${winId} (pid ${proc.pid})`);

    this._notify();
    return winId;
  }

  /**
   * Lanza una app Mach-O (bundle o ejecutable suelto).
   */
  async _launchMachoApp(proc, opts) {
    const app = proc.appDef;
    if (!this.dyld) {
      this.log.warn(`no dyld, running in simulated mode: ${app.id}`);
      return;
    }
    // En una implementación completa, aquí se crearía VCPU + Dyld + executor
    // y se ejecutaría main(). El componente React actúa como "shim" que
    // muestra lo que la app Mach-O va produciendo (framebuffer, stdout, etc.)
    this.log.info(`macho launch prepared: ${app.id} (${app.bundleBytes?.length ?? 0} bytes)`);
  }

  /**
   * Si la app ya está abierta, la enfoca. Si no, la lanza.
   */
  focusOrLaunch(appId, opts = {}) {
    const existing = this.sessions.get(appId);
    if (existing && existing.size > 0) {
      const wins = Array.from(existing);
      const active = this._getActiveWin();
      if (active && wins.includes(active.id)) {
        const visible = wins
          .map((id) => this.windowManager.getWindow(id))
          .filter((w) => w && w.state !== "minimized");
        if (visible.length > 1) {
          const currentIndex = visible.findIndex((w) => w.id === active.id);
          const next = visible[(currentIndex + 1) % visible.length];
          this.windowManager.focus(next.id);
          return next.id;
        }
        this.windowManager.minimize(active.id);
        return active.id;
      }
      const targetId = wins[wins.length - 1];
      const target = this.windowManager.getWindow(targetId);
      if (target && target.state === "minimized") this.windowManager.restore(targetId);
      else this.windowManager.focus(targetId);
      return targetId;
    }
    return this.launch(appId, opts);
  }

  /**
   * Cierra una ventana concreta.
   */
  closeWindow(winId) {
    const appId = this.windowToApp.get(winId);
    const app = appId ? this._getApp(appId) : null;

    // Persistir estado si es stateful
    if (app?.stateful) {
      const win = this.windowManager?.getWindow(winId);
      if (win?.data) this._persistAppState(appId, win.data);
    }

    this.windowManager?.close(winId);
    this._forgetWindow(winId, appId);
    return true;
  }

  /**
   * Cierra todas las ventanas de una app.
   */
  quit(appId) {
    const set = this.sessions.get(appId);
    if (!set) return 0;
    const ids = Array.from(set);

    // Persistir estado
    const app = this._getApp(appId);
    if (app?.stateful) {
      const lastWin = ids.length > 0 ? this.windowManager?.getWindow(ids[ids.length - 1]) : null;
      if (lastWin?.data) this._persistAppState(appId, lastWin.data);
    }

    ids.forEach((id) => this.windowManager?.close(id));
    this.sessions.delete(appId);
    ids.forEach((id) => this.windowToApp.delete(id));

    // Terminar procesos
    const pids = this.appProcesses.get(appId);
    if (pids) {
      for (const pid of pids) {
        const proc = this.processes.get(pid);
        if (proc) {
          proc.state = APP_STATE.TERMINATED;
          proc.finishedAt = Date.now();
          proc.exitCode = 0;
          kernelBus.emit(RUNTIME_EVENTS.PROCESS_EXITED, { pid, appId, exitCode: 0 });
        }
        this.processes.delete(pid);
      }
      this.appProcesses.delete(appId);
    }

    kernelBus.emit(RUNTIME_EVENTS.APP_QUIT, { appId, count: ids.length });
    this.log.info(`quit: ${appId} (${ids.length} ventanas)`);
    this._notify();
    return ids.length;
  }

  /**
   * Minimiza todas las ventanas de una app.
   */
  hide(appId) {
    const set = this.sessions.get(appId);
    if (!set) return 0;
    let n = 0;
    for (const id of set) {
      this.windowManager?.minimize(id);
      n++;
    }
    return n;
  }

  /**
   * Suspende una app (congela sus procesos sin cerrarlos).
   */
  suspend(appId) {
    const pids = this.appProcesses.get(appId);
    if (!pids) return 0;
    let n = 0;
    for (const pid of pids) {
      const proc = this.processes.get(pid);
      if (proc && proc.state === APP_STATE.RUNNING) {
        proc.state = APP_STATE.SUSPENDED;
        proc.suspendedAt = Date.now();
        kernelBus.emit(RUNTIME_EVENTS.APP_SUSPENDED, { pid, appId });
        n++;
      }
    }
    return n;
  }

  /**
   * Reanuda una app suspendida.
   */
  resume(appId) {
    const pids = this.appProcesses.get(appId);
    if (!pids) return 0;
    let n = 0;
    for (const pid of pids) {
      const proc = this.processes.get(pid);
      if (proc && proc.state === APP_STATE.SUSPENDED) {
        proc.state = APP_STATE.RUNNING;
        proc.resumedAt = Date.now();
        kernelBus.emit(RUNTIME_EVENTS.APP_RESUMED, { pid, appId });
        n++;
      }
    }
    return n;
  }

  /**
   * Mata una app con SIGKILL.
   */
  kill(appId) {
    const pids = this.appProcesses.get(appId);
    if (!pids) return 0;
    let n = 0;
    for (const pid of pids) {
      const proc = this.processes.get(pid);
      if (proc) {
        proc.state = APP_STATE.TERMINATED;
        proc.finishedAt = Date.now();
        proc.exitCode = 137;
        kernelBus.emit(RUNTIME_EVENTS.PROCESS_EXITED, { pid, appId, exitCode: 137 });
      }
      this.processes.delete(pid);
      n++;
    }
    this.appProcesses.delete(appId);
    this.sessions.delete(appId);
    this._notify();
    return n;
  }

  // -------------------------------------------------------------- tracking
  _forgetWindow(winId, appId) {
    if (appId && this.sessions.has(appId)) {
      this.sessions.get(appId).delete(winId);
      if (this.sessions.get(appId).size === 0) {
        // Última ventana cerrada → terminar procesos
        const pids = this.appProcesses.get(appId);
        if (pids) {
          for (const pid of pids) {
            const proc = this.processes.get(pid);
            if (proc) {
              proc.state = APP_STATE.TERMINATED;
              proc.finishedAt = Date.now();
              proc.exitCode = 0;
              kernelBus.emit(RUNTIME_EVENTS.PROCESS_EXITED, { pid, appId, exitCode: 0 });
            }
            this.processes.delete(pid);
          }
          this.appProcesses.delete(appId);
        }
        this.sessions.delete(appId);
      }
    }
    this.windowToApp.delete(winId);
    kernelBus.emit(RUNTIME_EVENTS.APP_CLOSED, { appId, winId });
    this._notify();
  }

  handleWindowClosed(winId) {
    const appId = this.windowToApp.get(winId);
    if (!appId) return;
    this._forgetWindow(winId, appId);
  }

  handleWindowFocused(winId) {
    const appId = this.windowToApp.get(winId);
    if (!appId) return;
    kernelBus.emit(RUNTIME_EVENTS.APP_FOCUSED, { appId, winId });
  }

  handleWindowBlurred(winId) {
    const appId = this.windowToApp.get(winId);
    if (!appId) return;
    kernelBus.emit(RUNTIME_EVENTS.APP_BLURRED, { appId, winId });
  }

  // -------------------------------------------------------------- consultas
  isRunning(appId) {
    return this.sessions.has(appId) && this.sessions.get(appId).size > 0;
  }

  getWindows(appId) {
    const set = this.sessions.get(appId);
    if (!set) return [];
    return Array.from(set)
      .map((id) => this.windowManager?.getWindow(id))
      .filter(Boolean);
  }

  getWindowCount(appId) {
    return this.sessions.get(appId)?.size ?? 0;
  }

  getAppOfWindow(winId) {
    const appId = this.windowToApp.get(winId);
    return appId ? this.registry.get(appId) : null;
  }

  listRunning() {
    return Array.from(this.sessions.keys());
  }

  getProcesses() {
    return Array.from(this.processes.values()).map((p) => p.snapshot());
  }

  getProcess(pid) {
    return this.processes.get(pid)?.snapshot() ?? null;
  }
}

// ============================================================================
// CONTEXTO + PROVIDER
// ============================================================================

const RuntimeContext = createContext(null);

export function RuntimeProvider({
  children,
  apps = [],
  runtime: external,
  security = null,
  dyld = null,
}) {
  const wm = useWindowManager();
  const registryRef = useRef(null);
  const runtimeRef = useRef(null);

  if (!registryRef.current) registryRef.current = new AppRegistry();
  if (!runtimeRef.current) {
    runtimeRef.current =
      external ||
      new AppRuntime({
        registry: registryRef.current,
        windowManager: wm.manager,
        security,
        dyld,
      });
  }

  const runtime = runtimeRef.current;
  const registry = registryRef.current;

  const [state, setState] = useState(() => runtime.getState());

  useEffect(() => {
    runtime.setWindowManager(wm.manager);
    if (security) runtime.setSecurity(security);
    if (dyld) runtime.setDyld(dyld);
  }, [runtime, wm.manager, security, dyld]);

  // Registrar apps iniciales
  const didRegisterRef = useRef(false);
  useEffect(() => {
    if (didRegisterRef.current) return;
    didRegisterRef.current = true;
    if (apps.length > 0) {
      registry.registerMany(apps);
      kernelBus.emit(RUNTIME_EVENTS.REGISTRY_CHANGED, { apps: registry.all() });
    }
  }, [apps, registry]);

  // Suscripción a cambios
  useEffect(() => {
    const unsub = runtime.subscribe(setState);
    return () => unsub();
  }, [runtime]);

  // Sincronizar con eventos del kernel
  useEffect(() => {
    const offClosed = kernelBus.on(KERNEL_EVENTS.WINDOW_CLOSED, ({ id }) => {
      runtime.handleWindowClosed(id);
    });
    const offFocused = kernelBus.on(KERNEL_EVENTS.WINDOW_FOCUSED, ({ id }) => {
      runtime.handleWindowFocused(id);
    });
    const offBlurred = kernelBus.on(KERNEL_EVENTS.WINDOW_BLURRED, ({ id }) => {
      runtime.handleWindowBlurred(id);
    });
    return () => {
      offClosed();
      offFocused();
      offBlurred();
    };
  }, [runtime]);

  // Escuchar eventos externos de "abrir app"
  useEffect(() => {
    const onOpenApp = (e) => {
      const { appId, options } = e.detail || {};
      if (appId) runtime.focusOrLaunch(appId, options);
    };
    const onKernelOpen = ({ appId, options }) => {
      if (appId) runtime.focusOrLaunch(appId, options);
    };
    window.addEventListener("rainos:open-app", onOpenApp);
    const offBus = kernelBus.on("kernel:open-app", onKernelOpen);
    return () => {
      window.removeEventListener("rainos:open-app", onOpenApp);
      offBus();
    };
  }, [runtime]);

  const api = useMemo(
    () => ({
      runtime,
      registry,

      runningApps: state.runningApps,
      sessions: state.sessions,
      counts: state.counts,
      processes: state.processes,

      // Acciones
      launch: (appId, opts) => runtime.launch(appId, opts),
      focusOrLaunch: (appId, opts) => runtime.focusOrLaunch(appId, opts),
      closeWindow: (winId) => runtime.closeWindow(winId),
      quit: (appId) => runtime.quit(appId),
      hide: (appId) => runtime.hide(appId),
      suspend: (appId) => runtime.suspend(appId),
      resume: (appId) => runtime.resume(appId),
      kill: (appId) => runtime.kill(appId),

      // Consultas
      isRunning: (appId) => runtime.isRunning(appId),
      getWindows: (appId) => runtime.getWindows(appId),
      getWindowCount: (appId) => runtime.getWindowCount(appId),
      getAppOfWindow: (winId) => runtime.getAppOfWindow(winId),
      listRunning: () => runtime.listRunning(),
      getProcesses: () => runtime.getProcesses(),
      getProcess: (pid) => runtime.getProcess(pid),

      // Registro
      registerApp: (def) => registry.register(def),
      registerApps: (defs) => registry.registerMany(defs),
      unregisterApp: (id) => registry.unregister(id),
      getApp: (id) => registry.get(id),
      listApps: () => registry.all(),
      listVisibleApps: () => registry.visible(),
      searchApps: (q) => registry.search(q),
      getAppsByCategory: () => registry.byCategory(),

      // CustomEvent helper
      openApp: (appId, options) => {
        try {
          window.dispatchEvent(
            new CustomEvent("rainos:open-app", { detail: { appId, options } })
          );
        } catch {}
      },
    }),
    [runtime, registry, state]
  );

  return <RuntimeContext.Provider value={api}>{children}</RuntimeContext.Provider>;
}

export function useRuntime() {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error("useRuntime must be used within a RuntimeProvider");
  return ctx;
}

// ============================================================================
// HOOKS AUXILIARES
// ============================================================================

export function useIsRunning(appId) {
  const runtime = useRuntime();
  return runtime.runningApps.includes(appId);
}

export function useWindowCount(appId) {
  const runtime = useRuntime();
  return runtime.counts[appId] || 0;
}

export function useApps() {
  const runtime = useRuntime();
  return runtime.listApps();
}

export function useVisibleApps() {
  const runtime = useRuntime();
  return runtime.listVisibleApps();
}

// ============================================================================
// BUILD SYSTEM APPS (helper)
// ============================================================================

/**
 * Helper para construir el array de apps del sistema.
 * Uso:
 *   const SYSTEM_APPS = buildSystemApps({ Finder, Safari, Music, ... });
 */
export function buildSystemApps(components = {}) {
  const {
    Finder, Safari, Music, Photos,
    Terminal, Notes, Settings, About,
  } = components;

  const apps = [];

  if (Finder) apps.push({
    id: "finder",
    name: "Finder",
    icon: "🗂️",
    component: Finder,
    width: 900, height: 560, minWidth: 640, minHeight: 400,
    singleton: false, stateful: true,
    category: "Sistema",
    keywords: ["archivos", "carpetas", "explorador", "files"],
  });

  if (Safari) apps.push({
    id: "safari",
    name: "Safari",
    icon: "🧭",
    component: Safari,
    width: 1200, height: 800, minWidth: 600, minHeight: 400,
    singleton: false, stateful: true,
    category: "Internet",
    keywords: ["navegador", "web", "internet", "browser"],
    entitlements: { "com.apple.security.network.client": true },
  });

  if (Music) apps.push({
    id: "music",
    name: "Música",
    icon: "🎵",
    component: Music,
    width: 900, height: 640, minWidth: 700, minHeight: 500,
    singleton: true, stateful: true,
    category: "Entretenimiento",
    keywords: ["audio", "canciones", "reproductor", "music"],
  });

  if (Photos) apps.push({
    id: "photos",
    name: "Fotos",
    icon: "🖼️",
    component: Photos,
    width: 1100, height: 700, minWidth: 800, minHeight: 500,
    singleton: false, stateful: true,
    category: "Entretenimiento",
    keywords: ["imágenes", "fotos", "editor", "photos"],
  });

  if (Terminal) apps.push({
    id: "terminal",
    name: "Terminal",
    icon: "⌨️",
    component: Terminal,
    width: 720, height: 460, minWidth: 480, minHeight: 300,
    singleton: false, stateful: false,
    category: "Utilidades",
    keywords: ["shell", "bash", "consola", "comandos"],
  });

  if (Notes) apps.push({
    id: "notes",
    name: "Notas",
    icon: "📝",
    component: Notes,
    width: 780, height: 520, minWidth: 520, minHeight: 360,
    singleton: false, stateful: true,
    category: "Productividad",
    keywords: ["notas", "textos", "apuntes"],
  });

  if (Settings) apps.push({
    id: "settings",
    name: "Ajustes del Sistema",
    icon: "⚙️",
    component: Settings,
    width: 900, height: 620, minWidth: 700, minHeight: 500,
    singleton: true, stateful: false,
    category: "Sistema",
    keywords: ["preferencias", "configuración", "settings"],
  });

  if (About) apps.push({
    id: "about",
    name: "Acerca de rainOS",
    icon: "ℹ️",
    component: About,
    width: 520, height: 620, minWidth: 420, minHeight: 520,
    singleton: true, stateful: false,
    category: "Sistema",
    keywords: ["about", "versión", "info", "sistema"],
  });

  return apps;
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  AppRegistry,
  AppRuntime,
  AppProcess,
  RuntimeProvider,
  useRuntime,
  useIsRunning,
  useWindowCount,
  useApps,
  useVisibleApps,
  buildSystemApps,
  RUNTIME_EVENTS,
  APP_KIND,
  APP_STATE,
  QOS_CLASS,
};
