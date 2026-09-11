// ============================================================================
// scheduler.jsx — Scheduler del kernel de macOS
// ----------------------------------------------------------------------------
// Planificador de tareas y procesos del sistema. Responsabilidades:
// - Cola de tareas con prioridades (critical, high, normal, low, idle)
// - Ejecución diferida (setTimeout) y periódica (setInterval)
// - Microtasks (ejecutar tras el frame actual)
// - requestAnimationFrame loop
// - requestIdleCallback (con fallback a setTimeout)
// - Cancelación de tareas por ID o por tag
// - Pausa / reanudación global
// - Estadísticas de ejecución (lastRun, runCount, totalTime, avgTime)
// - Cuotas por prioridad (evitar que low bloquee critical)
// - Registro de procesos (apps abiertas con prioridad)
// - Eventos de ciclo de vida
// - Todo sin UI. Solo lógica.
// ============================================================================

import React, {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";

import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// CONSTANTES
// ============================================================================

export const PRIORITY = Object.freeze({
  CRITICAL: 0,
  HIGH: 10,
  NORMAL: 20,
  LOW: 30,
  IDLE: 40,
});

export const TASK_KIND = Object.freeze({
  ONCE: "once",
  INTERVAL: "interval",
  MICROTASK: "microtask",
  RAF: "raf",
  IDLE: "idle",
});

export const SCHEDULER_STATE = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  PAUSED: "paused",
  STOPPED: "stopped",
});

export const SCHEDULER_EVENTS = Object.freeze({
  STARTED: "scheduler:started",
  STOPPED: "scheduler:stopped",
  PAUSED: "scheduler:paused",
  RESUMED: "scheduler:resumed",
  TASK_SCHEDULED: "scheduler:task-scheduled",
  TASK_STARTED: "scheduler:task-started",
  TASK_COMPLETED: "scheduler:task-completed",
  TASK_FAILED: "scheduler:task-failed",
  TASK_CANCELLED: "scheduler:task-cancelled",
  TASK_SKIPPED: "scheduler:task-skipped",
  FRAME: "scheduler:frame",
  TICK: "scheduler:tick",
  QUEUE_OVERFLOW: "scheduler:queue-overflow",
  PROCESS_REGISTERED: "scheduler:process-registered",
  PROCESS_UNREGISTERED: "scheduler:process-unregistered",
  STATS: "scheduler:stats",
  LOG: "scheduler:log",
  WARNING: "scheduler:warning",
  ERROR: "scheduler:error",
});

// ============================================================================
// LOGGER
// ============================================================================

class SchedulerLog {
  constructor(max = 300) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(SCHEDULER_EVENTS.LOG, e);
    return e;
  }
  info(m, x) {
    return this.push("info", m, x);
  }
  warn(m, x) {
    return this.push("warn", m, x);
  }
  error(m, x) {
    return this.push("error", m, x);
  }
  all() {
    return [...this.entries];
  }
  clear() {
    this.entries = [];
  }
}

// ============================================================================
// HELPERS
// ============================================================================

let _taskIdCounter = 0;
const nextTaskId = () => ++_taskIdCounter;

const safeCall = (fn, args = []) => {
  try {
    return fn(...args);
  } catch (err) {
    console.error("[scheduler] task threw", err);
    return undefined;
  }
};

// ============================================================================
// SCHEDULER (clase pura)
// ============================================================================

export class Scheduler {
  constructor(options = {}) {
    this.options = {
      maxQueue: 5000,
      defaultPriority: PRIORITY.NORMAL,
      trackStats: true,
      useIdleCallback: true,
      ...options,
    };

    this.logger = new SchedulerLog(options.maxLogs || 300);
    this.state = SCHEDULER_STATE.IDLE;
    this.tasks = new Map();
    this.queue = [];
    this.microtasks = [];
    this.rafTasks = new Map();
    this.intervals = new Map();
    this.timeouts = new Map();
    this.processes = new Map();
    this.stats = {
      scheduled: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      totalTime: 0,
    };
    this.frameHandle = null;
    this.intervalHandle = null;
    this.tickIntervalMs = options.tickIntervalMs || 100;
    this.subscribers = new Set();
    this.aborted = false;
  }

  // ------------------------------------------------------------------ state
  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _notify() {
    const snapshot = this.getState();
    for (const fn of this.subscribers) {
      try {
        fn(snapshot);
      } catch (err) {
        console.error("[scheduler] subscriber error", err);
      }
    }
  }

  getState() {
    return {
      state: this.state,
      tasks: this.tasks.size,
      queued: this.queue.length,
      microtasks: this.microtasks.length,
      rafTasks: this.rafTasks.size,
      intervals: this.intervals.size,
      timeouts: this.timeouts.size,
      processes: this.processes.size,
      stats: { ...this.stats },
    };
  }

  _setState(state) {
    this.state = state;
  }

  // ------------------------------------------------------------------ start/stop
  start() {
    if (this.state === SCHEDULER_STATE.RUNNING) return;
    this._setState(SCHEDULER_STATE.RUNNING);

    if (typeof requestAnimationFrame === "function") {
      const loop = () => {
        if (this.state !== SCHEDULER_STATE.RUNNING) return;
        this._runFrame();
        this.frameHandle = requestAnimationFrame(loop);
      };
      this.frameHandle = requestAnimationFrame(loop);
    }

    this.intervalHandle = setInterval(() => {
      if (this.state !== SCHEDULER_STATE.RUNNING) return;
      this._runQueue();
      kernelBus.emit(SCHEDULER_EVENTS.TICK, {
        queued: this.queue.length,
      });
      this._notify();
    }, this.tickIntervalMs);

    kernelBus.emit(SCHEDULER_EVENTS.STARTED, {});
    this.logger.info("scheduler started");
  }

  stop() {
    if (this.state === SCHEDULER_STATE.STOPPED) return;
    this._setState(SCHEDULER_STATE.STOPPED);

    if (this.frameHandle != null) {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(this.frameHandle);
      }
      this.frameHandle = null;
    }
    if (this.intervalHandle != null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    for (const id of this.timeouts.keys()) clearTimeout(id);
    for (const id of this.intervals.keys()) clearInterval(id);
    this.timeouts.clear();
    this.intervals.clear();

    kernelBus.emit(SCHEDULER_EVENTS.STOPPED, {});
    this.logger.info("scheduler stopped");
    this._notify();
  }

  pause() {
    if (this.state !== SCHEDULER_STATE.RUNNING) return;
    this._setState(SCHEDULER_STATE.PAUSED);
    kernelBus.emit(SCHEDULER_EVENTS.PAUSED, {});
    this._notify();
  }

  resume() {
    if (this.state !== SCHEDULER_STATE.PAUSED) return;
    this._setState(SCHEDULER_STATE.RUNNING);
    kernelBus.emit(SCHEDULER_EVENTS.RESUMED, {});
    this._notify();
  }

  // ------------------------------------------------------------------ scheduling
  _checkQueue() {
    if (this.queue.length >= this.options.maxQueue) {
      kernelBus.emit(SCHEDULER_EVENTS.QUEUE_OVERFLOW, {
        size: this.queue.length,
      });
      this.logger.warn("queue overflow");
      return false;
    }
    return true;
  }

  schedule(fn, opts = {}) {
    const {
      priority = this.options.defaultPriority,
      delay = 0,
      tag = null,
      name = null,
      once = true,
    } = opts;

    if (!this._checkQueue()) return null;

    const id = nextTaskId();
    const task = {
      id,
      fn,
      priority,
      delay,
      tag,
      name,
      kind: TASK_KIND.ONCE,
      once,
      scheduledAt: Date.now(),
      runCount: 0,
      lastRunAt: null,
      totalTime: 0,
    };

    this.tasks.set(id, task);
    this.stats.scheduled++;
    kernelBus.emit(SCHEDULER_EVENTS.TASK_SCHEDULED, {
      id,
      name,
      priority,
      delay,
      tag,
    });

    if (delay > 0) {
      const handle = setTimeout(() => {
        this.timeouts.delete(handle);
        this._runTask(task);
      }, delay);
      this.timeouts.set(handle, id);
    } else {
      this.queue.push(task);
      this.queue.sort((a, b) => a.priority - b.priority);
    }

    this._notify();
    return id;
  }

  // Alias semántico
  defer(fn, opts = {}) {
    return this.schedule(fn, { ...opts, once: true });
  }

  interval(fn, ms, opts = {}) {
    const { priority = this.options.defaultPriority, tag = null, name = null } =
      opts;

    if (!this._checkQueue()) return null;

    const id = nextTaskId();
    const task = {
      id,
      fn,
      priority,
      ms,
      tag,
      name,
      kind: TASK_KIND.INTERVAL,
      once: false,
      scheduledAt: Date.now(),
      runCount: 0,
      lastRunAt: null,
      totalTime: 0,
    };

    this.tasks.set(id, task);
    this.stats.scheduled++;

    const handle = setInterval(() => {
      this._runTask(task);
    }, ms);
    this.intervals.set(handle, id);

    kernelBus.emit(SCHEDULER_EVENTS.TASK_SCHEDULED, {
      id,
      name,
      priority,
      ms,
      tag,
      kind: TASK_KIND.INTERVAL,
    });
    this._notify();
    return id;
  }

  microtask(fn, opts = {}) {
    const { name = null, tag = null } = opts;

    if (!this._checkQueue()) return null;

    const id = nextTaskId();
    const task = {
      id,
      fn,
      priority: PRIORITY.CRITICAL,
      name,
      tag,
      kind: TASK_KIND.MICROTASK,
      once: true,
      scheduledAt: Date.now(),
      runCount: 0,
      lastRunAt: null,
      totalTime: 0,
    };

    this.tasks.set(id, task);
    this.microtasks.push(task);
    this.stats.scheduled++;

    if (typeof queueMicrotask === "function") {
      queueMicrotask(() => this._drainMicrotasks());
    } else {
      Promise.resolve().then(() => this._drainMicrotasks());
    }

    kernelBus.emit(SCHEDULER_EVENTS.TASK_SCHEDULED, {
      id,
      name,
      tag,
      kind: TASK_KIND.MICROTASK,
    });
    return id;
  }

  raf(fn, opts = {}) {
    const { name = null, tag = null } = opts;
    const id = nextTaskId();

    const task = {
      id,
      fn,
      priority: PRIORITY.HIGH,
      name,
      tag,
      kind: TASK_KIND.RAF,
      once: false,
      scheduledAt: Date.now(),
      runCount: 0,
      lastRunAt: null,
      totalTime: 0,
    };

    this.tasks.set(id, task);
    this.rafTasks.set(id, task);
    this.stats.scheduled++;

    kernelBus.emit(SCHEDULER_EVENTS.TASK_SCHEDULED, {
      id,
      name,
      tag,
      kind: TASK_KIND.RAF,
    });
    return id;
  }

  idle(fn, opts = {}) {
    const { name = null, tag = null, timeout = 1000 } = opts;

    if (!this._checkQueue()) return null;

    const id = nextTaskId();
    const task = {
      id,
      fn,
      priority: PRIORITY.IDLE,
      name,
      tag,
      kind: TASK_KIND.IDLE,
      once: true,
      scheduledAt: Date.now(),
      runCount: 0,
      lastRunAt: null,
      totalTime: 0,
    };

    this.tasks.set(id, task);
    this.stats.scheduled++;

    const run = () => this._runTask(task);

    if (
      this.options.useIdleCallback &&
      typeof requestIdleCallback === "function"
    ) {
      requestIdleCallback(run, { timeout });
    } else {
      setTimeout(run, 1);
    }

    kernelBus.emit(SCHEDULER_EVENTS.TASK_SCHEDULED, {
      id,
      name,
      tag,
      kind: TASK_KIND.IDLE,
    });
    return id;
  }

  // ------------------------------------------------------------------ cancel
  cancel(id) {
    const task = this.tasks.get(id);
    if (!task) return false;

    this.queue = this.queue.filter((t) => t.id !== id);
    this.microtasks = this.microtasks.filter((t) => t.id !== id);
    this.rafTasks.delete(id);

    for (const [handle, tid] of this.intervals.entries()) {
      if (tid === id) {
        clearInterval(handle);
        this.intervals.delete(handle);
      }
    }
    for (const [handle, tid] of this.timeouts.entries()) {
      if (tid === id) {
        clearTimeout(handle);
        this.timeouts.delete(handle);
      }
    }

    this.tasks.delete(id);
    this.stats.cancelled++;

    kernelBus.emit(SCHEDULER_EVENTS.TASK_CANCELLED, { id, name: task.name });
    this._notify();
    return true;
  }

  cancelByTag(tag) {
    const ids = [];
    for (const [id, task] of this.tasks.entries()) {
      if (task.tag === tag) ids.push(id);
    }
    ids.forEach((id) => this.cancel(id));
    return ids.length;
  }

  cancelAll() {
    const ids = Array.from(this.tasks.keys());
    ids.forEach((id) => this.cancel(id));
    return ids.length;
  }

  // ------------------------------------------------------------------ run
  _runMicrotasks() {
    const tasks = this.microtasks;
    this.microtasks = [];
    for (const task of tasks) {
      this._runTask(task);
    }
  }

  _drainMicrotasks() {
    if (this.state === SCHEDULER_STATE.PAUSED) return;
    this._runMicrotasks();
  }

  _runQueue() {
    if (this.state !== SCHEDULER_STATE.RUNNING) return;
    if (this.queue.length === 0) return;

    // Ejecutar hasta 20 tareas por tick para no bloquear
    const limit = Math.min(20, this.queue.length);
    for (let i = 0; i < limit; i++) {
      const task = this.queue.shift();
      if (!task) break;
      this._runTask(task);
    }
  }

  _runFrame() {
    if (this.state !== SCHEDULER_STATE.RUNNING) return;
    const now = Date.now();
    kernelBus.emit(SCHEDULER_EVENTS.FRAME, { ts: now });
    for (const task of Array.from(this.rafTasks.values())) {
      this._runTask(task);
    }
  }

  _runTask(task) {
    if (task.cancelled) return;
    if (this.state === SCHEDULER_STATE.STOPPED) return;
    if (this.state === SCHEDULER_STATE.PAUSED && task.kind !== TASK_KIND.MICROTASK)
      return;

    const t0 =
      typeof performance !== "undefined"
        ? performance.now()
        : Date.now();

    kernelBus.emit(SCHEDULER_EVENTS.TASK_STARTED, {
      id: task.id,
      name: task.name,
      kind: task.kind,
      priority: task.priority,
    });

    const result = safeCall(task.fn);

    const t1 =
      typeof performance !== "undefined"
        ? performance.now()
        : Date.now();
    const elapsed = t1 - t0;

    task.runCount++;
    task.lastRunAt = Date.now();
    task.totalTime += elapsed;

    if (this.options.trackStats) {
      this.stats.completed++;
      this.stats.totalTime += elapsed;
    }

    kernelBus.emit(SCHEDULER_EVENTS.TASK_COMPLETED, {
      id: task.id,
      name: task.name,
      kind: task.kind,
      priority: task.priority,
      elapsed,
      runCount: task.runCount,
      result,
    });

    if (task.once) {
      this.tasks.delete(task.id);
      this.rafTasks.delete(task.id);
    }

    this._notify();
  }

  // ------------------------------------------------------------------ processes
  registerProcess(processId, info = {}) {
    if (this.processes.has(processId)) return false;
    this.processes.set(processId, {
      id: processId,
      name: info.name || processId,
      priority: info.priority ?? PRIORITY.NORMAL,
      createdAt: Date.now(),
      tasks: [],
      meta: info.meta || null,
    });
    kernelBus.emit(SCHEDULER_EVENTS.PROCESS_REGISTERED, { id: processId });
    this._notify();
    return true;
  }

  unregisterProcess(processId) {
    const p = this.processes.get(processId);
    if (!p) return false;

    for (const taskId of p.tasks) {
      this.cancel(taskId);
    }
    this.processes.delete(processId);
    kernelBus.emit(SCHEDULER_EVENTS.PROCESS_UNREGISTERED, { id: processId });
    this._notify();
    return true;
  }

  getProcess(processId) {
    return this.processes.get(processId) ?? null;
  }

  listProcesses() {
    return Array.from(this.processes.values());
  }

  // ------------------------------------------------------------------ stats
  getStats() {
    const avg = this.stats.completed > 0
      ? this.stats.totalTime / this.stats.completed
      : 0;
    return {
      ...this.stats,
      avgTime: avg,
    };
  }

  resetStats() {
    this.stats = {
      scheduled: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      totalTime: 0,
    };
    this._notify();
  }

  // ------------------------------------------------------------------ teardown
  dispose() {
    this.stop();
    this.cancelAll();
    this.tasks.clear();
    this.processes.clear();
    this.subscribers.clear();
  }
}

// ============================================================================
// ESTADO / REDUCER
// ============================================================================

const initialState = {
  state: SCHEDULER_STATE.IDLE,
  tasks: 0,
  queued: 0,
  microtasks: 0,
  rafTasks: 0,
  intervals: 0,
  timeouts: 0,
  processes: 0,
  stats: {
    scheduled: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    totalTime: 0,
    avgTime: 0,
  },
  logs: [],
};

function schedulerReducer(state, action) {
  switch (action.type) {
    case "SNAPSHOT":
      return { ...state, ...action.snapshot };
    case "LOG":
      return { ...state, logs: [...state.logs.slice(-299), action.entry] };
    default:
      return state;
  }
}

// ============================================================================
// CONTEXTO + PROVIDER
// ============================================================================

const SchedulerContext = createContext(null);

export function SchedulerProvider({
  children,
  scheduler: external,
  options = {},
  autoStart = true,
}) {
  const schedulerRef = useRef(null);
  if (!schedulerRef.current) {
    schedulerRef.current = external || new Scheduler(options);
  }
  const scheduler = schedulerRef.current;

  const [state, dispatch] = useReducer(schedulerReducer, initialState);

  useEffect(() => {
    const unsub = scheduler.subscribe((snapshot) => {
      dispatch({
        type: "SNAPSHOT",
        snapshot: {
          ...snapshot,
          stats: { ...snapshot.stats, avgTime: snapshot.stats.completed > 0
            ? snapshot.stats.totalTime / snapshot.stats.completed
            : 0 },
        },
      });
    });

    const offLog = kernelBus.on(SCHEDULER_EVENTS.LOG, (entry) => {
      dispatch({ type: "LOG", entry });
    });

    if (autoStart) scheduler.start();

    return () => {
      unsub();
      offLog();
      scheduler.stop();
    };
  }, [autoStart]);

  const api = useMemo(
    () => ({
      scheduler,
      state,
      status: state.state,
      isRunning: state.state === SCHEDULER_STATE.RUNNING,
      isPaused: state.state === SCHEDULER_STATE.PAUSED,
      stats: state.stats,
      logs: state.logs,

      start: () => scheduler.start(),
      stop: () => scheduler.stop(),
      pause: () => scheduler.pause(),
      resume: () => scheduler.resume(),

      schedule: (fn, opts) => scheduler.schedule(fn, opts),
      defer: (fn, opts) => scheduler.defer(fn, opts),
      interval: (fn, ms, opts) => scheduler.interval(fn, ms, opts),
      microtask: (fn, opts) => scheduler.microtask(fn, opts),
      raf: (fn, opts) => scheduler.raf(fn, opts),
      idle: (fn, opts) => scheduler.idle(fn, opts),

      cancel: (id) => scheduler.cancel(id),
      cancelByTag: (tag) => scheduler.cancelByTag(tag),
      cancelAll: () => scheduler.cancelAll(),

      registerProcess: (id, info) => scheduler.registerProcess(id, info),
      unregisterProcess: (id) => scheduler.unregisterProcess(id),
      getProcess: (id) => scheduler.getProcess(id),
      listProcesses: () => scheduler.listProcesses(),

      getStats: () => scheduler.getStats(),
      resetStats: () => scheduler.resetStats(),

      dispose: () => scheduler.dispose(),
    }),
    [scheduler, state]
  );

  return (
    <SchedulerContext.Provider value={api}>
      {children}
    </SchedulerContext.Provider>
  );
}

export function useScheduler() {
  const ctx = useContext(SchedulerContext);
  if (!ctx)
    throw new Error("useScheduler must be used within a SchedulerProvider");
  return ctx;
}

// ============================================================================
// HOOKS AUXILIARES
// ============================================================================

/**
 * Ejecuta un callback cada vez que pasa un frame. Equivalente a un
 * requestAnimationFrame gestionado por el scheduler.
 */
export function useSchedulerFrame(callback, { autoStart = true } = {}) {
  const { raf, cancel } = useScheduler();
  const cbRef = useRef(callback);
  const idRef = useRef(null);

  useEffect(() => {
    cbRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!autoStart) return;
    idRef.current = raf(() => cbRef.current());
    return () => {
      if (idRef.current != null) cancel(idRef.current);
    };
  }, [autoStart, raf, cancel]);
}

/**
 * Programa una tarea con cancelación automática al desmontar.
 */
export function useSchedulerTask(fn, deps = [], opts = {}) {
  const { schedule, cancel } = useScheduler();
  const fnRef = useRef(fn);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    const id = schedule(() => fnRef.current(), opts);
    return () => {
      if (id != null) cancel(id);
    };
  }, deps);
}

/**
 * Devuelve el intervalo de tiempo entre frames (útil para animaciones).
 */
export function useFrameTimer() {
  const [fps, setFps] = useState(0);
  const lastRef = useRef(Date.now());
  const framesRef = useRef(0);

  useSchedulerFrame(() => {
    framesRef.current++;
    const now = Date.now();
    if (now - lastRef.current >= 1000) {
      setFps(framesRef.current);
      framesRef.current = 0;
      lastRef.current = now;
    }
  });

  return fps;
}

// ============================================================================
// EXPORTS DEFAULT
// ============================================================================

export default {
  Scheduler,
  SchedulerProvider,
  useScheduler,
  useSchedulerFrame,
  useSchedulerTask,
  useFrameTimer,
  PRIORITY,
  TASK_KIND,
  SCHEDULER_STATE,
  SCHEDULER_EVENTS,
};
