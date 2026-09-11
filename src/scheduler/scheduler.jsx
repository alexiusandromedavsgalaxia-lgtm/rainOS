// ============================================================================
// scheduler.jsx — Scheduler de sistema operativo real
// ----------------------------------------------------------------------------
// Este módulo es un planificador de tareas multi-núcleo, multi-hilo, con
// pipeline de GPU, gestión de memoria virtual, IPC entre procesos y
// políticas de planificación configurables. Está diseñado para simular el
// comportamiento de un kernel de SO real, no solo para repartir callbacks.
//
// SECCIONES
//
// 1. TIPOS Y CONSTANTES
// 2. UTILIDADES PURAS (colas, heaps, bitmaps, RNG determinista)
// 3. CPU VIRTUAL
//    - Núcleos (cores) con estado IDLE / RUNNING / BLOCKED / HALTED
//    - Colas de ejecución por prioridad (multilevel feedback queue)
//    - Registros de contexto (para save/restore de hilos)
//    - Contadores de ciclos, instrucciones y estadísticas por núcleo
//    - Afinidad (CPU affinity) por hilo
//    - Migración de hilos entre núcleos
//    - Sensores de temperatura y throttling simulados
// 4. HILOS (threads)
//    - Estados: READY, RUNNING, BLOCKED, WAITING, TERMINATED, ZOMBIE
//    - Prioridades dinámicas (nice -20..19 + real-time)
//    - Time slicing y preempción
//    - Context switch con save/restore
//    - Semáforos, mutexes, condition variables
//    - Join y detach
//    - Señales (SIGINT, SIGTERM, SIGKILL, SIGUSR1, SIGUSR2)
// 5. PROCESOS (processes)
//    - Agrupación de hilos por proceso
//    - PID y TGID
//    - Espacio de direcciones (mmap simulado)
//    - File descriptors
//    - Entorno (env) y argumentos (argv)
//    - Fork / exec / spawn / wait / kill
// 6. MEMORIA VIRTUAL
//    - Páginas de 4KB
//    - Tabla de páginas por proceso
//    - Asignación first-fit / best-fit
//    - Swapping a "disco" simulado
//    - OOM killer
//    - Estadísticas de uso
// 7. GPU PIPELINE
//    - Cola de comandos gráficos
//    - Shaders compilados (registro)
//    - Draw calls batched
//    - VRAM simulada
//    - Framebuffer y swap chain
//    - Sincronización con vsync (60/120 Hz)
//    - Presentación y composición
// 8. IPC (inter-process communication)
//    - Pipes (unidireccional / bidireccional)
//    - Message queues
//    - Shared memory
//    - Signals
//    - Sockets (Unix domain, simulados)
// 9. POLÍTICAS DE PLANIFICACIÓN
//    - FCFS
//    - SJF (shortest job first)
//    - Round Robin
//    - Multilevel Feedback Queue (por defecto)
//    - Priority (real-time)
//    - CFS (completely fair scheduler) con vruntime
//    - EDF (earliest deadline first) para tareas de tiempo real
// 10. RELOJES Y TEMPORIZADORES
//     - Reloj monotónico (no retrocede)
//     - Reloj de pared
//     - Timers de alta resolución
//     - Alarmas
//     - Tick del scheduler (jiffies)
// 11. ESTADÍSTICAS Y TELEMETRÍA
//     - Utilización por núcleo
//     - Load average 1/5/15
//     - Context switches por segundo
//     - Cache de estadísticas
// 12. EVENTOS DEL SISTEMA
// 13. CLASE PRINCIPAL Scheduler
// 14. PROVIDER REACT + HOOKS
// 15. INSPECCIÓN Y DEBUG (volcado de estado, top, ps)
//
// El scheduler NO renderiza UI. Es lógica pura + provider + hooks.
// ============================================================================

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  useReducer,
} from "react";

import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// 1. TIPOS Y CONSTANTES
// ============================================================================

export const THREAD_STATE = Object.freeze({
  NEW: "new",
  READY: "ready",
  RUNNING: "running",
  BLOCKED: "blocked",
  WAITING: "waiting",
  SLEEPING: "sleeping",
  TERMINATED: "terminated",
  ZOMBIE: "zombie",
});

export const PROCESS_STATE = Object.freeze({
  CREATED: "created",
  RUNNING: "running",
  SLEEPING: "sleeping",
  STOPPED: "stopped",
  ZOMBIE: "zombie",
  DEAD: "dead",
});

export const CORE_STATE = Object.freeze({
  OFFLINE: "offline",
  IDLE: "idle",
  RUNNING: "running",
  HALTED: "halted",
  THROTTLED: "throttled",
});

export const PRIORITY_CLASS = Object.freeze({
  REAL_TIME: "realtime",
  HIGH: "high",
  NORMAL: "normal",
  LOW: "low",
  IDLE: "idle",
});

export const SCHED_POLICY = Object.freeze({
  FCFS: "fcfs",
  SJF: "sjf",
  RR: "rr",
  MLFQ: "mlfq",
  PRIORITY: "priority",
  CFS: "cfs",
  EDF: "edf",
});

export const SIGNAL = Object.freeze({
  SIGHUP: "SIGHUP",
  SIGINT: "SIGINT",
  SIGQUIT: "SIGQUIT",
  SIGKILL: "SIGKILL",
  SIGTERM: "SIGTERM",
  SIGSTOP: "SIGSTOP",
  SIGCONT: "SIGCONT",
  SIGUSR1: "SIGUSR1",
  SIGUSR2: "SIGUSR2",
  SIGCHLD: "SIGCHLD",
});

export const GPU_STATE = Object.freeze({
  IDLE: "idle",
  PROCESSING: "processing",
  PRESENTING: "presenting",
  STALLED: "stalled",
});

export const DEFAULT_TICK_HZ = 250;         // 250 Hz → 4 ms por tick
export const DEFAULT_PAGE_SIZE = 4096;      // 4 KB
export const DEFAULT_VRAM_BYTES = 512 * 1024 * 1024;
export const DEFAULT_RAM_BYTES = 4 * 1024 * 1024 * 1024;
export const DEFAULT_SWAP_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_CORES = 4;
export const TIME_SLICE_MS = 8;             // preemption quantum
export const AGING_INTERVAL_MS = 100;
export const GPU_VSYNC_HZ = 60;
export const CFS_LATENCY_MS = 6;
export const CFS_MIN_GRANULARITY_MS = 1;

export const SCHEDULER_STATE = Object.freeze({
  OFFLINE: "offline",
  RUNNING: "running",
  PAUSED: "paused",
  HALTED: "halted",
  PANIC: "panic",
});

export const SCHEDULER_EVENTS = Object.freeze({
  STARTED: "sched:started",
  STOPPED: "sched:stopped",
  PAUSED: "sched:paused",
  RESUMED: "sched:resumed",
  HALTED: "sched:halted",
  PANIC: "sched:panic",
  TICK: "sched:tick",
  JIFFY: "sched:jiffy",
  CONTEXT_SWITCH: "sched:context-switch",
  PREEMPT: "sched:preempt",
  // threads
  THREAD_CREATED: "sched:thread-created",
  THREAD_READY: "sched:thread-ready",
  THREAD_RUNNING: "sched:thread-running",
  THREAD_BLOCKED: "sched:thread-blocked",
  THREAD_WAITING: "sched:thread-waiting",
  THREAD_SLEEPING: "sched:thread-sleeping",
  THREAD_WOKEN: "sched:thread-woken",
  THREAD_TERMINATED: "sched:thread-terminated",
  THREAD_ZOMBIE: "sched:thread-zombie",
  THREAD_MIGRATED: "sched:thread-migrated",
  THREAD_PRIORITY_CHANGED: "sched:thread-priority-changed",
  THREAD_AFFINITY_CHANGED: "sched:thread-affinity-changed",
  // processes
  PROCESS_CREATED: "sched:process-created",
  PROCESS_FORKED: "sched:process-forked",
  PROCESS_EXEC: "sched:process-exec",
  PROCESS_EXITED: "sched:process-exited",
  PROCESS_SIGNAL: "sched:process-signal",
  PROCESS_WAIT: "sched:process-wait",
  PROCESS_KILLED: "sched:process-killed",
  // cores
  CORE_ONLINE: "sched:core-online",
  CORE_OFFLINE: "sched:core-offline",
  CORE_IDLE: "sched:core-idle",
  CORE_THROTTLED: "sched:core-throttled",
  CORE_HALTED: "sched:core-halted",
  // memory
  MMAP: "sched:mmap",
  MUNMAP: "sched:munmap",
  PAGE_FAULT: "sched:page-fault",
  SWAP_OUT: "sched:swap-out",
  SWAP_IN: "sched:swap-in",
  OOM: "sched:oom",
  // gpu
  GPU_SUBMIT: "sched:gpu-submit",
  GPU_COMPILED: "sched:gpu-compiled",
  GPU_DRAW: "sched:gpu-draw",
  GPU_PRESENT: "sched:gpu-present",
  GPU_VSYNC: "sched:gpu-vsync",
  GPU_STALL: "sched:gpu-stall",
  GPU_VRAM_ALLOC: "sched:gpu-vram-alloc",
  // ipc
  PIPE_CREATED: "sched:pipe-created",
  PIPE_WRITE: "sched:pipe-write",
  PIPE_READ: "sched:pipe-read",
  MSG_SENT: "sched:msg-sent",
  MSG_RECEIVED: "sched:msg-received",
  SHM_CREATED: "sched:shm-created",
  SHM_ATTACHED: "sched:shm-attached",
  // misc
  DEADLINE_MISSED: "sched:deadline-missed",
  SIGNAL: "sched:signal",
  LOG: "sched:log",
  STATS: "sched:stats",
  TASK_SCHEDULED: "sched:task-scheduled",
  TASK_STARTED: "sched:task-started",
  TASK_COMPLETED: "sched:task-completed",
  TASK_FAILED: "sched:task-failed",
  TASK_CANCELLED: "sched:task-cancelled",
  FRAME: "sched:frame",
  QUEUE_OVERFLOW: "sched:queue-overflow",
  PROCESS_REGISTERED: "sched:process-registered",
  PROCESS_UNREGISTERED: "sched:process-unregistered",
});

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

// ============================================================================
// 2. UTILIDADES PURAS
// ============================================================================

const now = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const uid = (() => {
  let n = 0;
  return (prefix = "id") => `${prefix}-${++n}`;
})();

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

class Logger {
  constructor(max = 500) {
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

/**
 * Min-heap genérico con comparador.
 */
class Heap {
  constructor(compare) {
    this.items = [];
    this.compare = compare;
  }
  size() {
    return this.items.length;
  }
  isEmpty() {
    return this.items.length === 0;
  }
  peek() {
    return this.items[0] ?? null;
  }
  push(item) {
    this.items.push(item);
    this._bubbleUp(this.items.length - 1);
  }
  pop() {
    if (this.items.length === 0) return null;
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      this._bubbleDown(0);
    }
    return top;
  }
  remove(predicate) {
    const next = [];
    let removed = 0;
    for (const item of this.items) {
      if (predicate(item)) removed++;
      else next.push(item);
    }
    this.items = next;
    if (removed > 0) this._heapify();
    return removed;
  }
  toArray() {
    return [...this.items];
  }
  clear() {
    this.items = [];
  }
  _heapify() {
    for (let i = Math.floor(this.items.length / 2); i >= 0; i--) {
      this._bubbleDown(i);
    }
  }
  _bubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.items[i], this.items[parent]) < 0) {
        [this.items[i], this.items[parent]] = [
          this.items[parent],
          this.items[i],
        ];
        i = parent;
      } else break;
    }
  }
  _bubbleDown(i) {
    const n = this.items.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this.compare(this.items[l], this.items[smallest]) < 0)
        smallest = l;
      if (r < n && this.compare(this.items[r], this.items[smallest]) < 0)
        smallest = r;
      if (smallest === i) break;
      [this.items[i], this.items[smallest]] = [
        this.items[smallest],
        this.items[i],
      ];
      i = smallest;
    }
  }
}

/**
 * Cola FIFO simple.
 */
class FIFO {
  constructor() {
    this.items = [];
  }
  size() {
    return this.items.length;
  }
  isEmpty() {
    return this.items.length === 0;
  }
  push(x) {
    this.items.push(x);
  }
  shift() {
    return this.items.shift() ?? null;
  }
  remove(predicate) {
    const before = this.items.length;
    this.items = this.items.filter((x) => !predicate(x));
    return before - this.items.length;
  }
  toArray() {
    return [...this.items];
  }
  clear() {
    this.items = [];
  }
}

/**
 * Semáforo con contador.
 */
class Semaphore {
  constructor(initial = 1) {
    this.count = initial;
    this.waiters = new FIFO();
  }
  async acquire() {
    if (this.count > 0) {
      this.count--;
      return;
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
  release() {
    if (this.waiters.isEmpty()) {
      this.count++;
      return;
    }
    const next = this.waiters.shift();
    next();
  }
  get value() {
    return this.count;
  }
  get queueLength() {
    return this.waiters.size();
  }
}

/**
 * Mutex = semáforo de 1.
 */
class Mutex extends Semaphore {
  constructor() {
    super(1);
    this.owner = null;
  }
  async lock(ownerId) {
    await this.acquire();
    this.owner = ownerId;
  }
  unlock() {
    this.owner = null;
    this.release();
  }
}

/**
 * Condition variable.
 */
class Condition {
  constructor() {
    this.waiters = new FIFO();
  }
  async wait(mutex) {
    if (mutex) mutex.unlock();
    await new Promise((resolve) => this.waiters.push(resolve));
    if (mutex) await mutex.lock();
  }
  signal() {
    if (!this.waiters.isEmpty()) {
      const next = this.waiters.shift();
      next();
    }
  }
  broadcast() {
    const waiters = this.waiters.toArray();
    this.waiters.clear();
    waiters.forEach((w) => w());
  }
  get queueLength() {
    return this.waiters.size();
  }
}

/**
 * RNG determinista (xorshift32).
 */
class RNG {
  constructor(seed = 0x12345678) {
    this.state = seed >>> 0;
  }
  next() {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x100000000;
  }
  int(min, max) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
}

// ============================================================================
// 3. CPU VIRTUAL — Núcleo
// ============================================================================

class CpuCore {
  constructor(id, scheduler) {
    this.id = id;
    this.scheduler = scheduler;
    this.state = CORE_STATE.IDLE;
    this.currentThreadId = null;
    this.cycles = 0;
    this.instructions = 0;
    this.contextSwitches = 0;
    this.idleSince = now();
    this.busySince = null;
    this.load = 0;              // 0..1 (exponentially weighted)
    this.temperature = 40 + Math.random() * 5; // °C
    this.throttleThreshold = 85;
    this.throttleFactor = 1;
    this.frequency = 2400;      // MHz base
    this.maxFrequency = 3600;   // MHz turbo
    this.cacheHitRatio = 0.94;
    this.cache = new Map();     // simple LRU cache for cycles
    this.cacheMax = 512;
  }

  online() {
    this.state = CORE_STATE.IDLE;
    this.idleSince = now();
    kernelBus.emit(SCHEDULER_EVENTS.CORE_ONLINE, { coreId: this.id });
  }

  offline() {
    this.state = CORE_STATE.OFFLINE;
    this.currentThreadId = null;
    kernelBus.emit(SCHEDULER_EVENTS.CORE_OFFLINE, { coreId: this.id });
  }

  idle() {
    if (this.state !== CORE_STATE.IDLE) {
      this.state = CORE_STATE.IDLE;
      this.currentThreadId = null;
      this.idleSince = now();
      kernelBus.emit(SCHEDULER_EVENTS.CORE_IDLE, { coreId: this.id });
    }
  }

  /**
   * Ejecuta un quantum sobre el hilo dado.
   * @param {Thread} thread
   * @param {number} quantumMs
   * @returns {{ ran: number, blocked: boolean }}
   */
  run(thread, quantumMs) {
    if (this.state === CORE_STATE.OFFLINE || this.state === CORE_STATE.HALTED) {
      return { ran: 0, blocked: true };
    }

    this.state = CORE_STATE.RUNNING;
    if (this.busySince == null) this.busySince = now();
    this.currentThreadId = thread.tid;

    // Aplicar throttling por temperatura
    const cycles = Math.floor(quantumMs * this.frequency * 1000 * this.throttleFactor);
    this.cycles += cycles;
    this.instructions += Math.floor(cycles / 3);

    // Actualizar cache
    this._touchCache(thread.codeRef || "generic");

    // Actualizar load
    const busyMs = quantumMs;
    const alpha = 0.2;
    this.load = this.load * (1 - alpha) + Math.min(1, busyMs / quantumMs) * alpha;

    // Calor
    this.temperature = Math.min(
      100,
      this.temperature + busyMs * 0.04 - 0.5
    );
    if (this.temperature >= this.throttleThreshold) {
      this.throttleFactor = 0.7;
      if (this.state !== CORE_STATE.THROTTLED) {
        this.state = CORE_STATE.THROTTLED;
        kernelBus.emit(SCHEDULER_EVENTS.CORE_THROTTLED, {
          coreId: this.id,
          temperature: this.temperature,
        });
      }
    } else if (this.temperature < this.throttleThreshold - 10) {
      this.throttleFactor = 1;
    }

    return { ran: quantumMs, blocked: false };
  }

  halt() {
    this.state = CORE_STATE.HALTED;
    this.currentThreadId = null;
    kernelBus.emit(SCHEDULER_EVENTS.CORE_HALTED, { coreId: this.id });
  }

  contextSwitch() {
    this.contextSwitches++;
  }

  utilization(windowMs = 1000) {
    if (!this.busySince) return 0;
    const total = now() - this.idleSince;
    const busy = now() - (this.busySince || this.idleSince);
    if (total <= 0) return 0;
    return clamp(busy / Math.max(total, windowMs), 0, 1);
  }

  snapshot() {
    return {
      id: this.id,
      state: this.state,
      currentThreadId: this.currentThreadId,
      cycles: this.cycles,
      instructions: this.instructions,
      contextSwitches: this.contextSwitches,
      load: this.load,
      temperature: this.temperature,
      frequency: this.frequency,
      throttleFactor: this.throttleFactor,
      cacheHitRatio: this.cacheHitRatio,
    };
  }

  _touchCache(key) {
    const v = this.cache.get(key);
    if (v) {
      this.cache.delete(key);
      this.cache.set(key, v + 1);
    } else {
      if (this.cache.size >= this.cacheMax) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
      this.cache.set(key, 1);
    }
  }
}

// ============================================================================
// 4. HILOS (threads)
// ============================================================================

let THREAD_ID = 0;
let PROCESS_ID = 100;

class Thread {
  constructor({
    name = `thread-${++THREAD_ID}`,
    priority = PRIORITY.NORMAL,
    priorityClass = PRIORITY_CLASS.NORMAL,
    nice = 0,
    isRealTime = false,
    cpuAffinity = null,   // null = any core
    deadlineMs = null,
    budgetMs = null,
    quantumMs = TIME_SLICE_MS,
    process = null,
    entry = null,
    args = [],
  } = {}) {
    this.tid = `t-${++THREAD_ID}`;
    this.name = name;
    this.priority = priority;
    this.priorityClass = priorityClass;
    this.nice = clamp(nice, -20, 19);
    this.isRealTime = isRealTime;
    this.cpuAffinity = cpuAffinity;
    this.deadlineMs = deadlineMs;
    this.budgetMs = budgetMs;
    this.quantumMs = quantumMs;

    this.state = THREAD_STATE.NEW;
    this.coreId = null;

    this.process = process;      // weak ref al proceso
    this.entry = entry;
    this.args = args;

    this.createdAt = now();
    this.startedAt = null;
    this.finishedAt = null;
    this.lastRunAt = null;
    this.totalRunMs = 0;
    this.runCount = 0;

    this.vruntime = 0;           // CFS
    this.sliceUsedMs = 0;
    this.blockedOn = null;       // { type, resource }

    this.context = {              // contexto salvado
      pc: 0,
      sp: 0x7fff0000,
      registers: [0, 0, 0, 0],
      flags: 0,
    };

    this.signalQueue = [];
    this.pendingJoin = [];

    this.meta = {};
    this.codeRef = null;
  }

  get isTerminated() {
    return this.state === THREAD_STATE.TERMINATED || this.state === THREAD_STATE.ZOMBIE;
  }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
  }

  snapshot() {
    return {
      tid: this.tid,
      name: this.name,
      state: this.state,
      priority: this.priority,
      priorityClass: this.priorityClass,
      nice: this.nice,
      isRealTime: this.isRealTime,
      cpuAffinity: this.cpuAffinity,
      deadlineMs: this.deadlineMs,
      quantumMs: this.quantumMs,
      coreId: this.coreId,
      runCount: this.runCount,
      totalRunMs: this.totalRunMs,
      vruntime: this.vruntime,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      processId: this.process?.pid ?? null,
    };
  }
}

// ============================================================================
// 5. PROCESOS
// ============================================================================

class Process {
  constructor({
    name = "unnamed",
    argv = [],
    env = {},
    priority = PRIORITY.NORMAL,
    parent = null,
  } = {}) {
    this.pid = PROCESS_ID++;
    this.tgid = this.pid;
    this.ppid = parent ? parent.pid : 0;
    this.name = name;
    this.argv = argv;
    this.env = env;
    this.priority = priority;

    this.threads = new Set();
    this.mainThread = null;

    this.state = PROCESS_STATE.CREATED;
    this.createdAt = now();
    this.exitedAt = null;
    this.exitCode = null;

    this.addressSpace = new AddressSpace(this);
    this.fileDescriptors = new Map();
    this.signalHandlers = new Map();
    this.pendingSignals = [];
    this.workingDir = "/";

    this.uid = 501;
    this.gid = 20;
  }

  addThread(thread) {
    thread.process = this;
    this.threads.add(thread);
    if (!this.mainThread) this.mainThread = thread;
    return thread;
  }

  removeThread(thread) {
    this.threads.delete(thread);
    if (this.mainThread === thread) this.mainThread = null;
  }

  get threadCount() {
    return this.threads.size;
  }

  allThreads() {
    return Array.from(this.threads);
  }

  isAlive() {
    return (
      this.state !== PROCESS_STATE.DEAD &&
      this.state !== PROCESS_STATE.ZOMBIE
    );
  }

  snapshot() {
    return {
      pid: this.pid,
      ppid: this.ppid,
      name: this.name,
      state: this.state,
      threadCount: this.threads.size,
      uid: this.uid,
      gid: this.gid,
      cwd: this.workingDir,
      createdAt: this.createdAt,
      exitedAt: this.exitedAt,
      exitCode: this.exitCode,
      memory: this.addressSpace.usage(),
    };
  }
}

// ============================================================================
// 6. MEMORIA VIRTUAL
// ============================================================================

class Page {
  constructor(index, size) {
    this.index = index;
    this.size = size;
    this.data = null;       // contenido simulado
    this.present = false;   // en RAM
    this.dirty = false;
    this.referenced = false;
    this.swapped = false;
    this.mappedAt = null;
    this.lastAccess = null;
  }
}

class AddressSpace {
  constructor(process) {
    this.process = process;
    this.pageSize = DEFAULT_PAGE_SIZE;
    this.regions = new Map();     // id → region
    this.pages = new Map();       // vaddr → Page
    this.nextFreeVaddr = 0x10000000;
    this.heapStart = 0x20000000;
    this.heapEnd = this.heapStart;
    this.stackTop = 0x7fff0000;
    this.mmapId = 0;
    this.stats = {
      mapped: 0,
      faults: 0,
      swaps: 0,
      bytesInUse: 0,
    };
  }

  mmap(sizeBytes, { prot = "rw", name = "anon" } = {}) {
    const id = `map-${++this.mmapId}`;
    const pages = Math.ceil(sizeBytes / this.pageSize);
    const vaddr = this.nextFreeVaddr;
    this.nextFreeVaddr += pages * this.pageSize;

    const region = {
      id,
      vaddr,
      sizeBytes: pages * this.pageSize,
      pages,
      prot,
      name,
      createdAt: now(),
    };
    this.regions.set(id, region);

    for (let i = 0; i < pages; i++) {
      const addr = vaddr + i * this.pageSize;
      this.pages.set(addr, new Page(i, this.pageSize));
    }

    this.stats.mapped++;
    this.stats.bytesInUse += region.sizeBytes;
    return { id, vaddr, sizeBytes: region.sizeBytes };
  }

  munmap(id) {
    const region = this.regions.get(id);
    if (!region) return false;
    for (let i = 0; i < region.pages; i++) {
      const addr = region.vaddr + i * this.pageSize;
      this.pages.delete(addr);
    }
    this.regions.delete(id);
    this.stats.bytesInUse -= region.sizeBytes;
    return true;
  }

  brk(newHeapEnd) {
    const old = this.heapEnd;
    this.heapEnd = Math.max(this.heapStart, newHeapEnd);
    const delta = this.heapEnd - old;
    return delta;
  }

  pageFault(vaddr) {
    const pageAddr = Math.floor(vaddr / this.pageSize) * this.pageSize;
    const page = this.pages.get(pageAddr);
    if (!page) {
      this.stats.faults++;
      kernelBus.emit(SCHEDULER_EVENTS.PAGE_FAULT, {
        processId: this.process.pid,
        vaddr,
        type: "invalid",
      });
      return null;
    }
    page.present = true;
    page.referenced = true;
    page.lastAccess = now();
    this.stats.faults++;
    return page;
  }

  usage() {
    return {
      bytesInUse: this.stats.bytesInUse,
      regions: this.regions.size,
      pages: this.pages.size,
      faults: this.stats.faults,
    };
  }
}

class MemoryManager {
  constructor({
    ramBytes = DEFAULT_RAM_BYTES,
    swapBytes = DEFAULT_SWAP_BYTES,
    pageSize = DEFAULT_PAGE_SIZE,
  } = {}) {
    this.ramBytes = ramBytes;
    this.swapBytes = swapBytes;
    this.pageSize = pageSize;
    this.ramPages = new Map();      // globalPageId → { processId, vaddr, data }
    this.swapPages = new Map();
    this.stats = {
      totalPages: Math.floor(ramBytes / pageSize),
      usedPages: 0,
      swapUsedPages: 0,
      pageFaults: 0,
      swaps: 0,
      oomKills: 0,
    };
  }

  allocate(process, vaddr, data = null) {
    if (this.stats.usedPages >= this.stats.totalPages) {
      this._evictToSwap();
    }
    const gpid = `${process.pid}:${vaddr}`;
    if (this.ramPages.has(gpid)) return false;
    this.ramPages.set(gpid, { processId: process.pid, vaddr, data });
    this.stats.usedPages++;
    return true;
  }

  free(process, vaddr) {
    const gpid = `${process.pid}:${vaddr}`;
    if (this.ramPages.delete(gpid)) {
      this.stats.usedPages--;
      return true;
    }
    return this.swapPages.delete(gpid);
  }

  _evictToSwap() {
    // LRU simple: saca la primera entrada a swap
    const first = this.ramPages.keys().next().value;
    if (!first) {
      // No hay páginas; activar OOM
      this._oom();
      return;
    }
    const entry = this.ramPages.get(first);
    this.ramPages.delete(first);
    this.swapPages.set(first, entry);
    this.stats.usedPages--;
    this.stats.swapUsedPages++;
    this.stats.swaps++;
    kernelBus.emit(SCHEDULER_EVENTS.SWAP_OUT, { key: first });
  }

  swapIn(gpid) {
    const entry = this.swapPages.get(gpid);
    if (!entry) return false;
    // Sacar otra para hacer sitio
    if (this.stats.usedPages >= this.stats.totalPages) this._evictToSwap();
    this.swapPages.delete(gpid);
    this.ramPages.set(gpid, entry);
    this.stats.usedPages++;
    this.stats.swapUsedPages--;
    kernelBus.emit(SCHEDULER_EVENTS.SWAP_IN, { key: gpid });
    return true;
  }

  _oom() {
    this.stats.oomKills++;
    kernelBus.emit(SCHEDULER_EVENTS.OOM, { ts: Date.now() });
  }

  snapshot() {
    return {
      ...this.stats,
      ramBytes: this.ramBytes,
      swapBytes: this.swapBytes,
      pageSize: this.pageSize,
    };
  }
}

// ============================================================================
// 7. GPU PIPELINE
// ============================================================================

class GpuPipeline {
  constructor({
    vramBytes = DEFAULT_VRAM_BYTES,
    vsyncHz = GPU_VSYNC_HZ,
  } = {}) {
    this.state = GPU_STATE.IDLE;
    this.vramBytes = vramBytes;
    this.vramUsed = 0;
    this.vsyncHz = vsyncHz;
    this.vsyncInterval = 1000 / vsyncHz;

    this.commandQueue = [];      // draw commands pendientes
    this.shaderRegistry = new Map();
    this.buffers = new Map();    // vram allocations
    this.textures = new Map();
    this.framebuffers = new Map();
    this.swapChain = [];

    this.stats = {
      submitted: 0,
      compiled: 0,
      drawn: 0,
      presented: 0,
      stalls: 0,
      vramAllocs: 0,
      lastPresentAt: 0,
    };

    this.currentFramebuffer = null;
  }

  registerShader(id, source) {
    // Simula compilación: calcula coste y guarda "código máquina" simulado
    const lines = (source || "").split("\n").length;
    const compiled = {
      id,
      sourceLength: source?.length || 0,
      lines,
      compiledAt: now(),
      cyclesPerVertex: 4 + lines * 2,
    };
    this.shaderRegistry.set(id, compiled);
    this.stats.compiled++;
    kernelBus.emit(SCHEDULER_EVENTS.GPU_COMPILED, { id, lines });
    return compiled;
  }

  allocVram(bytes, tag = "buffer") {
    if (this.vramUsed + bytes > this.vramBytes) {
      this._evictVram();
      if (this.vramUsed + bytes > this.vramBytes) {
        kernelBus.emit(SCHEDULER_EVENTS.GPU_STALL, { reason: "vram-full" });
        this.stats.stalls++;
        return null;
      }
    }
    const id = uid("vram");
    this.buffers.set(id, { id, bytes, tag, createdAt: now() });
    this.vramUsed += bytes;
    this.stats.vramAllocs++;
    kernelBus.emit(SCHEDULER_EVENTS.GPU_VRAM_ALLOC, { id, bytes, tag });
    return id;
  }

  freeVram(id) {
    const b = this.buffers.get(id);
    if (!b) return false;
    this.buffers.delete(id);
    this.vramUsed -= b.bytes;
    return true;
  }

  _evictVram() {
    // LRU sobre buffers
    let oldest = null;
    for (const [id, b] of this.buffers.entries()) {
      if (!oldest || b.createdAt < oldest.b.createdAt) oldest = { id, b };
    }
    if (oldest) this.freeVram(oldest.id);
  }

  createTexture(id, { width, height, bytesPerPixel = 4 } = {}) {
    const bytes = width * height * bytesPerPixel;
    const vram = this.allocVram(bytes, "texture");
    if (!vram) return null;
    const tex = { id, width, height, bytes, vram };
    this.textures.set(id, tex);
    return tex;
  }

  createFramebuffer(id, { width, height } = {}) {
    const bytes = width * height * 4;
    const vram = this.allocVram(bytes, "framebuffer");
    if (!vram) return null;
    const fb = { id, width, height, bytes, vram, createdAt: now() };
    this.framebuffers.set(id, fb);
    if (!this.currentFramebuffer) this.currentFramebuffer = id;
    return fb;
  }

  submit({
    kind = "draw",
    shader = null,
    vertices = 0,
    target = null,
    params = {},
  } = {}) {
    const cmd = {
      id: uid("cmd"),
      kind,
      shader,
      vertices,
      target,
      params,
      submittedAt: now(),
    };
    this.commandQueue.push(cmd);
    this.stats.submitted++;
    kernelBus.emit(SCHEDULER_EVENTS.GPU_SUBMIT, { cmd });
    return cmd.id;
  }

  /**
   * Procesa la cola durante un quantum de tiempo.
   */
  process(quantumMs) {
    if (this.commandQueue.length === 0) {
      this.state = GPU_STATE.IDLE;
      return { processed: 0 };
    }
    this.state = GPU_STATE.PROCESSING;
    const start = now();
    let processed = 0;
    const budgetMs = quantumMs;
    const cmdsPerMs = 0.5;         // ajusta dificultad

    let budget = budgetMs * cmdsPerMs;
    while (this.commandQueue.length > 0 && budget > 0) {
      const cmd = this.commandQueue.shift();
      if (cmd.kind === "draw") {
        this.stats.drawn++;
        kernelBus.emit(SCHEDULER_EVENTS.GPU_DRAW, {
          cmdId: cmd.id,
          vertices: cmd.vertices,
        });
      }
      budget -= 1;
      processed++;
      if (now() - start > quantumMs) break;
    }
    return { processed };
  }

  /**
   * Presenta el framebuffer al swap chain (sincronizado con vsync).
   */
  present() {
    const fb = this.currentFramebuffer
      ? this.framebuffers.get(this.currentFramebuffer)
      : null;
    if (!fb) return false;
    const t = now();
    if (t - this.stats.lastPresentAt < this.vsyncInterval) {
      return false;
    }
    this.stats.lastPresentAt = t;
    this.stats.presented++;
    this.state = GPU_STATE.PRESENTING;
    this.swapChain.push({ ts: t, fbId: fb.id });
    if (this.swapChain.length > 3) this.swapChain.shift();
    kernelBus.emit(SCHEDULER_EVENTS.GPU_PRESENT, {
      fbId: fb.id,
      ts: t,
    });
    kernelBus.emit(SCHEDULER_EVENTS.GPU_VSYNC, { ts: t });
    return true;
  }

  snapshot() {
    return {
      state: this.state,
      vramBytes: this.vramBytes,
      vramUsed: this.vramUsed,
      commandQueue: this.commandQueue.length,
      shaders: this.shaderRegistry.size,
      textures: this.textures.size,
      framebuffers: this.framebuffers.size,
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// 8. IPC
// ============================================================================

class Pipe {
  constructor({ bidirectional = false, capacity = 64 * 1024 } = {}) {
    this.id = uid("pipe");
    this.capacity = capacity;
    this.buffer = [];
    this.bytes = 0;
    this.bidirectional = bidirectional;
    this.readWaiters = new FIFO();
    this.writeWaiters = new FIFO();
    this.closed = false;
    this.stats = { writes: 0, reads: 0, bytesWritten: 0, bytesRead: 0 };
  }

  write(data) {
    if (this.closed) throw new Error("pipe closed");
    const bytes = typeof data === "string" ? data.length : data.byteLength || 0;
    while (this.bytes + bytes > this.capacity) {
      // bloquear al que escribe
      if (this.readWaiters.isEmpty()) {
        // nadie va a leer → drop silencioso
        break;
      }
      this.readWaiters.shift()();
    }
    this.buffer.push({ data, bytes, ts: now() });
    this.bytes += bytes;
    this.stats.writes++;
    this.stats.bytesWritten += bytes;
    kernelBus.emit(SCHEDULER_EVENTS.PIPE_WRITE, { pipeId: this.id, bytes });
    if (!this.readWaiters.isEmpty()) this.readWaiters.shift()();
    return bytes;
  }

  async read() {
    if (this.buffer.length === 0) {
      if (this.closed) return null;
      await new Promise((resolve) => this.readWaiters.push(resolve));
    }
    const chunk = this.buffer.shift();
    if (!chunk) return null;
    this.bytes -= chunk.bytes;
    this.stats.reads++;
    this.stats.bytesRead += chunk.bytes;
    kernelBus.emit(SCHEDULER_EVENTS.PIPE_READ, {
      pipeId: this.id,
      bytes: chunk.bytes,
    });
    if (!this.writeWaiters.isEmpty()) this.writeWaiters.shift()();
    return chunk.data;
  }

  close() {
    this.closed = true;
    const r = this.readWaiters.toArray();
    const w = this.writeWaiters.toArray();
    this.readWaiters.clear();
    this.writeWaiters.clear();
    r.forEach((f) => f());
    w.forEach((f) => f());
  }
}

class MessageQueue {
  constructor({ maxMessages = 1024 } = {}) {
    this.id = uid("mq");
    this.maxMessages = maxMessages;
    this.queue = new FIFO();
    this.waiters = new FIFO();
    this.closed = false;
  }
  send(msg, from) {
    if (this.closed) throw new Error("mq closed");
    if (this.queue.size() >= this.maxMessages) {
      // drop oldest
      this.queue.shift();
    }
    this.queue.push({ msg, from, ts: now() });
    kernelBus.emit(SCHEDULER_EVENTS.MSG_SENT, { mqId: this.id, from });
    if (!this.waiters.isEmpty()) this.waiters.shift()();
    return true;
  }
  async receive() {
    if (this.queue.isEmpty()) {
      if (this.closed) return null;
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    const m = this.queue.shift();
    if (m) kernelBus.emit(SCHEDULER_EVENTS.MSG_RECEIVED, { mqId: this.id });
    return m;
  }
  close() {
    this.closed = true;
    const w = this.waiters.toArray();
    this.waiters.clear();
    w.forEach((f) => f());
  }
}

class SharedMemory {
  constructor(bytes) {
    this.id = uid("shm");
    this.bytes = bytes;
    this.data = new Uint8Array(bytes);
    this.attached = new Set();
    this.createdAt = now();
  }
  attach(processId) {
    this.attached.add(processId);
    kernelBus.emit(SCHEDULER_EVENTS.SHM_ATTACHED, {
      shmId: this.id,
      processId,
    });
  }
  detach(processId) {
    this.attached.delete(processId);
  }
}

// ============================================================================
// 9. POLÍTICAS DE PLANIFICACIÓN
// ============================================================================

/**
 * Multilevel Feedback Queue: 3 niveles (RT, NORMAL, LOW).
 * - Quantum creciente por nivel.
 * - Aging: promociona hilos que llevan mucho esperando.
 */
class MLFQ {
  constructor(scheduler) {
    this.scheduler = scheduler;
    this.levels = [
      {
        id: 0,
        name: "RT",
        quantum: 4,
        queue: new FIFO(),
        priorityClass: PRIORITY_CLASS.REAL_TIME,
      },
      {
        id: 1,
        name: "NORMAL",
        quantum: TIME_SLICE_MS,
        queue: new FIFO(),
        priorityClass: PRIORITY_CLASS.NORMAL,
      },
      {
        id: 2,
        name: "LOW",
        quantum: TIME_SLICE_MS * 3,
        queue: new FIFO(),
        priorityClass: PRIORITY_CLASS.LOW,
      },
      {
        id: 3,
        name: "IDLE",
        quantum: TIME_SLICE_MS * 6,
        queue: new FIFO(),
        priorityClass: PRIORITY_CLASS.IDLE,
      },
    ];
  }

  enqueue(thread) {
    const lvl = this._levelFor(thread);
    lvl.queue.push(thread);
  }

  dequeue(core) {
    for (const lvl of this.levels) {
      const arr = lvl.queue.toArray();
      const idx = arr.findIndex(
        (t) =>
          t.state === THREAD_STATE.READY &&
          this._canRunOn(t, core)
      );
      if (idx >= 0) {
        // Reconstruimos la FIFO sin ese hilo
        const removed = arr.splice(idx, 1)[0];
        lvl.queue.clear();
        arr.forEach((t) => lvl.queue.push(t));
        return { thread: removed, quantum: lvl.quantum, level: lvl.id };
      }
    }
    return null;
  }

  remove(thread) {
    let removed = 0;
    for (const lvl of this.levels) {
      removed += lvl.queue.remove((t) => t.tid === thread.tid);
    }
    return removed;
  }

  pickNext(core) {
    return this.dequeue(core);
  }

  _levelFor(thread) {
    if (thread.isRealTime) return this.levels[0];
    if (thread.priorityClass === PRIORITY_CLASS.HIGH) return this.levels[1];
    if (thread.priorityClass === PRIORITY_CLASS.LOW) return this.levels[2];
    if (thread.priorityClass === PRIORITY_CLASS.IDLE) return this.levels[3];
    return this.levels[1];
  }

  _canRunOn(thread, core) {
    if (!thread.cpuAffinity) return true;
    if (Array.isArray(thread.cpuAffinity)) return thread.cpuAffinity.includes(core.id);
    return thread.cpuAffinity === core.id;
  }

  snapshot() {
    return this.levels.map((l) => ({
      id: l.id,
      name: l.name,
      quantum: l.quantum,
      size: l.queue.size(),
    }));
  }
}

/**
 * CFS (Completely Fair Scheduler) con vruntime.
 */
class CFS {
  constructor(scheduler, { latencyMs = CFS_LATENCY_MS } = {}) {
    this.scheduler = scheduler;
    this.latencyMs = latencyMs;
    this.heap = new Heap((a, b) => a.vruntime - b.vruntime);
  }
  enqueue(thread) {
    thread.vruntime = thread.vruntime || this._minVruntime();
    this.heap.push(thread);
  }
  remove(thread) {
    return this.heap.remove((t) => t.tid === thread.tid);
  }
  pickNext(core) {
    while (!this.heap.isEmpty()) {
      const t = this.heap.pop();
      if (t.state !== THREAD_STATE.READY) continue;
      if (t.cpuAffinity) {
        const allowed = Array.isArray(t.cpuAffinity)
          ? t.cpuAffinity.includes(core.id)
          : t.cpuAffinity === core.id;
        if (!allowed) {
          this.heap.push(t); // vuelve a la cola
          continue;
        }
      }
      const weight = 1024 / (1 + Math.pow(1.25, t.nice));
      const quantum = Math.max(
        CFS_MIN_GRANULARITY_MS,
        (this.latencyMs * weight) / 1024
      );
      return { thread: t, quantum, level: "cfs" };
    }
    return null;
  }
  _minVruntime() {
    if (this.heap.isEmpty()) return 0;
    return this.heap.peek().vruntime;
  }
  snapshot() {
    return { size: this.heap.size(), latencyMs: this.latencyMs };
  }
}

/**
 * EDF (Earliest Deadline First) para tareas de tiempo real.
 */
class EDF {
  constructor() {
    this.heap = new Heap((a, b) => (a.deadlineMs ?? Infinity) - (b.deadlineMs ?? Infinity));
  }
  enqueue(thread) {
    if (thread.deadlineMs != null) this.heap.push(thread);
  }
  remove(thread) {
    return this.heap.remove((t) => t.tid === thread.tid);
  }
  pickNext() {
    while (!this.heap.isEmpty()) {
      const t = this.heap.pop();
      if (t.state === THREAD_STATE.READY) {
        return { thread: t, quantum: t.quantumMs, level: "edf" };
      }
    }
    return null;
  }
  snapshot() {
    return { size: this.heap.size() };
  }
}

// ============================================================================
// 10. RELOJES Y TEMPORIZADORES
// ============================================================================

class MonotonicClock {
  constructor() {
    this.base = typeof performance !== "undefined" ? performance.now() : Date.now();
  }
  now() {
    return (typeof performance !== "undefined" ? performance.now() : Date.now()) - this.base;
  }
}

class WallClock {
  now() {
    return Date.now();
  }
}

class TimerWheel {
  constructor() {
    this.timers = new Map();      // id → { deadline, cb, intervalMs }
  }
  schedule(cb, delayMs, { repeatMs = null } = {}) {
    const id = uid("timer");
    const entry = {
      id,
      deadline: now() + delayMs,
      cb,
      intervalMs: repeatMs,
      createdAt: now(),
    };
    this.timers.set(id, entry);
    return id;
  }
  cancel(id) {
    return this.timers.delete(id);
  }
  tick() {
    const t = now();
    const due = [];
    for (const [id, entry] of this.timers.entries()) {
      if (entry.deadline <= t) due.push(entry);
    }
    for (const entry of due) {
      try {
        entry.cb();
      } catch (err) {
        console.error("[timer]", err);
      }
      if (entry.intervalMs) {
        entry.deadline = now() + entry.intervalMs;
      } else {
        this.timers.delete(entry.id);
      }
    }
    return due.length;
  }
  size() {
    return this.timers.size;
  }
}

// ============================================================================
// 11. ESTADÍSTICAS
// ============================================================================

class Telemetry {
  constructor() {
    this.start = now();
    this.tickCount = 0;
    this.jiffies = 0;
    this.contextSwitches = 0;
    this.preemptions = 0;
    this.threadsCreated = 0;
    this.threadsTerminated = 0;
    this.processesCreated = 0;
    this.processesExited = 0;
    this.signalsDelivered = 0;
    this.deadlineMisses = 0;
    this.idleTicks = 0;
    this.busyTicks = 0;
    this.loadSamples = [];       // ring buffer
    this.loadSamplesMax = 3600;  // 1 hora a 1 Hz
  }
  sampleLoad(cores) {
    const avg =
      cores.reduce((s, c) => s + c.load, 0) / Math.max(1, cores.length);
    this.loadSamples.push({ ts: now(), value: avg });
    if (this.loadSamples.length > this.loadSamplesMax) this.loadSamples.shift();
    return avg;
  }
  loadAverage(seconds) {
    const t = now();
    const cutoff = t - seconds * 1000;
    const recent = this.loadSamples.filter((s) => s.ts >= cutoff);
    if (recent.length === 0) return 0;
    return recent.reduce((a, s) => a + s.value, 0) / recent.length;
  }
  snapshot() {
    return {
      uptimeMs: now() - this.start,
      tickCount: this.tickCount,
      jiffies: this.jiffies,
      contextSwitches: this.contextSwitches,
      preemptions: this.preemptions,
      threadsCreated: this.threadsCreated,
      threadsTerminated: this.threadsTerminated,
      processesCreated: this.processesCreated,
      processesExited: this.processesExited,
      signalsDelivered: this.signalsDelivered,
      deadlineMisses: this.deadlineMisses,
      idleTicks: this.idleTicks,
      busyTicks: this.busyTicks,
      loadAverage1: this.loadAverage(1),
      loadAverage5: this.loadAverage(5),
      loadAverage15: this.loadAverage(15),
    };
  }
}

// ============================================================================
// 12. SCHEDULER PRINCIPAL
// ============================================================================

export class Scheduler {
  constructor(options = {}) {
    this.options = {
      cores: DEFAULT_CORES,
      tickHz: DEFAULT_TICK_HZ,
      policy: SCHED_POLICY.MLFQ,
      ramBytes: DEFAULT_RAM_BYTES,
      swapBytes: DEFAULT_SWAP_BYTES,
      vramBytes: DEFAULT_VRAM_BYTES,
      vsyncHz: GPU_VSYNC_HZ,
      enableGPU: true,
      ...options,
    };

    this.log = new Logger();

    // Estado global
    this.state = SCHEDULER_STATE.OFFLINE;
    this.policy = this.options.policy;
    this.tickHz = this.options.tickHz;
    this.tickIntervalMs = 1000 / this.tickHz;

    // Núcleos
    this.cores = [];
    for (let i = 0; i < this.options.cores; i++) {
      this.cores.push(new CpuCore(i, this));
    }

    // Hilos y procesos
    this.threads = new Map();       // tid → Thread
    this.processes = new Map();     // pid → Process
    this.readyQueues = {
      mlfq: new MLFQ(this),
      cfs: new CFS(this),
      edf: new EDF(this),
      fcfs: new FIFO(),
      sjf: new Heap((a, b) => a._estimatedMs - b._estimatedMs),
      rr: new FIFO(),
      priority: new Heap((a, b) => a.priority - b.priority || a.createdAt - b.createdAt),
    };

    // Recursos
    this.memory = new MemoryManager({
      ramBytes: this.options.ramBytes,
      swapBytes: this.options.swapBytes,
    });
    this.gpu = this.options.enableGPU ? new GpuPipeline({
      vramBytes: this.options.vramBytes,
      vsyncHz: this.options.vsyncHz,
    }) : null;

    // IPC
    this.pipes = new Map();
    this.messageQueues = new Map();
    this.sharedMemory = new Map();

    // Relojes
    this.clock = new MonotonicClock();
    this.wallClock = new WallClock();
    this.timers = new TimerWheel();

    // Telemetría
    this.telemetry = new Telemetry();

    // Loop interno
    this._loopHandle = null;
    this._gpuHandle = null;
    this._lastTickTime = 0;
    this._lastJiffyTime = 0;
    this._lastAgingTime = 0;

    // Suscriptores
    this.subscribers = new Set();

    // Inicializar core 0 como primario
    this.cores.forEach((c) => c.online());
  }

  // ------------------------------------------------------------------ suscripción
  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _notify() {
    const snap = this.snapshot();
    for (const fn of this.subscribers) {
      try {
        fn(snap);
      } catch (err) {
        console.error("[scheduler] subscriber error", err);
      }
    }
  }

  // ------------------------------------------------------------------ start / stop
  start() {
    if (this.state === SCHEDULER_STATE.RUNNING) return;
    this.state = SCHEDULER_STATE.RUNNING;

    // Loop principal
    this._loopHandle = setInterval(() => this._tick(), this.tickIntervalMs);

    // Loop de GPU a vsync (si está habilitada)
    if (this.gpu) {
      this._gpuHandle = setInterval(
        () => this._gpuTick(),
        this.gpu.vsyncInterval
      );
    }

    kernelBus.emit(SCHEDULER_EVENTS.STARTED, {
      cores: this.cores.length,
      policy: this.policy,
      tickHz: this.tickHz,
    });
    this.log.info("scheduler started");
  }

  stop() {
    if (this._loopHandle) clearInterval(this._loopHandle);
    if (this._gpuHandle) clearInterval(this._gpuHandle);
    this._loopHandle = null;
    this._gpuHandle = null;
    this.state = SCHEDULER_STATE.HALTED;

    // Notificar waiters para que no se queden colgados
    for (const t of this.threads.values()) {
      t.pendingJoin.forEach((f) => f());
      t.pendingJoin = [];
    }

    kernelBus.emit(SCHEDULER_EVENTS.STOPPED, {});
    this.log.info("scheduler stopped");
    this._notify();
  }

  pause() {
    if (this.state !== SCHEDULER_STATE.RUNNING) return;
    this.state = SCHEDULER_STATE.PAUSED;
    kernelBus.emit(SCHEDULER_EVENTS.PAUSED, {});
  }

  resume() {
    if (this.state !== SCHEDULER_STATE.PAUSED) return;
    this.state = SCHEDULER_STATE.RUNNING;
    kernelBus.emit(SCHEDULER_EVENTS.RESUMED, {});
  }

  panic(reason = "unknown") {
    this.state = SCHEDULER_STATE.PANIC;
    kernelBus.emit(SCHEDULER_EVENTS.PANIC, { reason });
    this.log.error(`kernel panic: ${reason}`);
    this.stop();
  }

  setPolicy(policy) {
    if (!Object.values(SCHED_POLICY).includes(policy)) {
      throw new Error(`unknown policy: ${policy}`);
    }
    this.policy = policy;
    this.log.info(`policy changed: ${policy}`);
    // Requiere re-encolar todos los hilos listos
    this._requeueAllReady();
  }

  // ------------------------------------------------------------------ cores
  onlineCore(coreId) {
    const core = this.cores.find((c) => c.id === coreId);
    if (core) core.online();
  }

  offlineCore(coreId) {
    const core = this.cores.find((c) => c.id === coreId);
    if (!core) return;
    const t = core.currentThreadId
      ? this.threads.get(core.currentThreadId)
      : null;
    core.offline();
    if (t) this._enqueueReady(t);
  }

  // ------------------------------------------------------------------ procesos
  createProcess({ name = "unnamed", argv = [], env = {}, priority = PRIORITY.NORMAL, entry = null } = {}) {
    const p = new Process({ name, argv, env, priority });
    this.processes.set(p.pid, p);
    this.telemetry.processesCreated++;
    kernelBus.emit(SCHEDULER_EVENTS.PROCESS_CREATED, { pid: p.pid, name });
    this.log.info(`process created: ${p.pid} ${name}`);
    if (entry) {
      this.spawnThread({
        process: p,
        entry,
        name: `${name}-main`,
        priority,
      });
    }
    return p;
  }

  fork(parentProcess) {
    const child = new Process({
      name: parentProcess.name,
      argv: [...parentProcess.argv],
      env: { ...parentProcess.env },
      priority: parentProcess.priority,
      parent: parentProcess,
    });
    // Copia básica de memoria (COW simulado con referencia)
    this.processes.set(child.pid, child);
    this.telemetry.processesCreated++;
    kernelBus.emit(SCHEDULER_EVENTS.PROCESS_FORKED, {
      ppid: parentProcess.pid,
      pid: child.pid,
    });
    return child;
  }

  exec(process, { name, argv = [], env = {} } = {}) {
    if (name) process.name = name;
    process.argv = argv;
    process.env = { ...env };
    kernelBus.emit(SCHEDULER_EVENTS.PROCESS_EXEC, { pid: process.pid });
  }

  async waitProcess(pid) {
    const p = this.processes.get(pid);
    if (!p) return null;
    if (!p.isAlive()) return p.exitCode;
    return new Promise((resolve) => {
      const check = () => {
        if (!p.isAlive()) resolve(p.exitCode);
        else setTimeout(check, 20);
      };
      check();
    });
  }

  killProcess(pid, signal = SIGNAL.SIGTERM) {
    const p = this.processes.get(pid);
    if (!p) return false;
    return this.sendSignal(p, signal);
  }

  sendSignal(process, signal) {
    process.pendingSignals.push(signal);
    this.telemetry.signalsDelivered++;
    kernelBus.emit(SCHEDULER_EVENTS.SIGNAL, { pid: process.pid, signal });

    if (signal === SIGNAL.SIGKILL) {
      this._terminateProcess(process, 137);
      return true;
    }
    if (signal === SIGNAL.SIGTERM) {
      // Marca para terminar; el hilo principal debe reaccionar
      // Si nadie lo maneja, lo matamos tras un grace period
      setTimeout(() => {
        if (process.isAlive()) this._terminateProcess(process, 143);
      }, 500);
      return true;
    }
    return true;
  }

  _terminateProcess(process, exitCode = 0) {
    for (const t of process.allThreads()) {
      this._terminateThread(t, exitCode);
    }
    process.state = PROCESS_STATE.DEAD;
    process.exitedAt = now();
    process.exitCode = exitCode;
    this.processes.delete(process.pid);
    this.telemetry.processesExited++;
    kernelBus.emit(SCHEDULER_EVENTS.PROCESS_EXITED, {
      pid: process.pid,
      exitCode,
    });
  }

  // ------------------------------------------------------------------ hilos
  spawnThread({
    process = null,
    name = null,
    entry = null,
    args = [],
    priority = PRIORITY.NORMAL,
    priorityClass = PRIORITY_CLASS.NORMAL,
    nice = 0,
    isRealTime = false,
    cpuAffinity = null,
    deadlineMs = null,
    budgetMs = null,
    quantumMs = TIME_SLICE_MS,
  } = {}) {
    if (!process) {
      // Thread suelto: creamos un proceso implícito
      process = this.createProcess({ name: name || "anon" });
    }
    const thread = new Thread({
      name: name || `thread-${THREAD_ID + 1}`,
      priority,
      priorityClass,
      nice,
      isRealTime,
      cpuAffinity,
      deadlineMs,
      budgetMs,
      quantumMs,
      process,
      entry,
      args,
    });
    process.addThread(thread);
    this.threads.set(thread.tid, thread);
    this.telemetry.threadsCreated++;
    kernelBus.emit(SCHEDULER_EVENTS.THREAD_CREATED, {
      tid: thread.tid,
      pid: process.pid,
      name: thread.name,
    });
    this._enqueueReady(thread);
    return thread;
  }

  /**
   * Envuelve una función async para correrla como hilo del scheduler.
   * Devuelve el Thread para que puedas hacer join().
   */
  spawnFunction(fn, {
    name = fn.name || "async",
    priority = PRIORITY.NORMAL,
    nice = 0,
    isRealTime = false,
    cpuAffinity = null,
    deadlineMs = null,
    process = null,
    autoRun = true,
  } = {}) {
    if (!process) {
      process = this.createProcess({ name });
    }
    const thread = this.spawnThread({
      process,
      name,
      priority,
      nice,
      isRealTime,
      cpuAffinity,
      deadlineMs,
    });
    thread.meta.fn = fn;

    if (autoRun) {
      // Ejecutamos como microtask para que no bloquee el tick
      this._runUserThread(thread);
    }
    return thread;
  }

  async _runUserThread(thread) {
    try {
      thread.setState(THREAD_STATE.RUNNING);
      thread.startedAt = now();
      kernelBus.emit(SCHEDULER_EVENTS.THREAD_RUNNING, { tid: thread.tid });
      const fn = thread.meta.fn;
      if (typeof fn === "function") {
        const result = await fn(...(thread.args || []));
        thread.meta.result = result;
      }
      this._terminateThread(thread, 0);
    } catch (err) {
      thread.meta.error = err;
      this._terminateThread(thread, 1);
    }
  }

  async joinThread(threadOrTid) {
    const t = typeof threadOrTid === "string"
      ? this.threads.get(threadOrTid)
      : threadOrTid;
    if (!t) return null;
    if (t.isTerminated) return t.meta.result;
    return new Promise((resolve) => {
      t.pendingJoin.push(() => resolve(t.meta.result));
    });
  }

  detachThread(tid) {
    const t = this.threads.get(tid);
    if (!t) return false;
    t.pendingJoin = [];
    return true;
  }

  yield() {
    // Cede el CPU: vuelve a la cola de listos
    const current = this._currentThreadOf(0); // simplificado
    if (current) this._enqueueReady(current);
  }

  sleep(thread, ms) {
    thread.setState(THREAD_STATE.SLEEPING);
    const timerId = this.timers.schedule(() => {
      this._wakeThread(thread);
    }, ms);
    return timerId;
  }

  _wakeThread(thread) {
    if (thread.isTerminated) return;
    thread.setState(THREAD_STATE.READY);
    this._enqueueReady(thread);
    kernelBus.emit(SCHEDULER_EVENTS.THREAD_WOKEN, { tid: thread.tid });
  }

  _terminateThread(thread, exitCode = 0) {
    thread.setState(THREAD_STATE.TERMINATED);
    thread.finishedAt = now();
    this.threads.delete(thread.tid);
    if (thread.process) thread.process.removeThread(thread);
    this._removeFromQueues(thread);
    thread.pendingJoin.forEach((f) => f());
    thread.pendingJoin = [];
    this.telemetry.threadsTerminated++;
    kernelBus.emit(SCHEDULER_EVENTS.THREAD_TERMINATED, {
      tid: thread.tid,
      exitCode,
    });
    this._notify();
  }

  setThreadPriority(tid, priority) {
    const t = this.threads.get(tid);
    if (!t) return false;
    t.priority = priority;
    kernelBus.emit(SCHEDULER_EVENTS.THREAD_PRIORITY_CHANGED, { tid, priority });
    return true;
  }

  setThreadAffinity(tid, cores) {
    const t = this.threads.get(tid);
    if (!t) return false;
    t.cpuAffinity = cores;
    kernelBus.emit(SCHEDULER_EVENTS.THREAD_AFFINITY_CHANGED, { tid, cores });
    // Reencolar si cambia de núcleo
    if (t.state === THREAD_STATE.READY) {
      this._removeFromQueues(t);
      this._enqueueReady(t);
    }
    return true;
  }

  // ------------------------------------------------------------------ colas
  _enqueueReady(thread) {
    thread.setState(THREAD_STATE.READY);
    const q = this.readyQueues;
    switch (this.policy) {
      case SCHED_POLICY.MLFQ:
        q.mlfq.enqueue(thread);
        break;
      case SCHED_POLICY.CFS:
        q.cfs.enqueue(thread);
        break;
      case SCHED_POLICY.EDF:
        q.edf.enqueue(thread);
        break;
      case SCHED_POLICY.FCFS:
        q.fcfs.push(thread);
        break;
      case SCHED_POLICY.SJF:
        q.sjf.push(thread);
        break;
      case SCHED_POLICY.RR:
        q.rr.push(thread);
        break;
      case SCHED_POLICY.PRIORITY:
        q.priority.push(thread);
        break;
      default:
        q.mlfq.enqueue(thread);
    }
    kernelBus.emit(SCHEDULER_EVENTS.THREAD_READY, { tid: thread.tid });
    this._notify();
  }

  _dequeueReady(core) {
    const q = this.readyQueues;
    switch (this.policy) {
      case SCHED_POLICY.MLFQ:
        return q.mlfq.pickNext(core);
      case SCHED_POLICY.CFS:
        return q.cfs.pickNext(core);
      case SCHED_POLICY.EDF:
        return q.edf.pickNext();
      case SCHED_POLICY.FCFS:
      case SCHED_POLICY.RR: {
        const t = q.fcfs.shift() || q.rr.shift();
        return t ? { thread: t, quantum: TIME_SLICE_MS, level: "rr" } : null;
      }
      case SCHED_POLICY.SJF:
        return (() => {
          const t = q.sjf.pop();
          return t ? { thread: t, quantum: TIME_SLICE_MS, level: "sjf" } : null;
        })();
      case SCHED_POLICY.PRIORITY:
        return (() => {
          const t = q.priority.pop();
          return t ? { thread: t, quantum: TIME_SLICE_MS, level: "prio" } : null;
        })();
      default:
        return q.mlfq.pickNext(core);
    }
  }

  _removeFromQueues(thread) {
    const q = this.readyQueues;
    q.mlfq.remove(thread);
    q.cfs.remove(thread);
    q.edf.remove(thread);
    q.fcfs.remove((t) => t.tid === thread.tid);
    q.rr.remove((t) => t.tid === thread.tid);
    q.sjf.remove((t) => t.tid === thread.tid);
    q.priority.remove((t) => t.tid === thread.tid);
  }

  _requeueAllReady() {
    const all = [];
    for (const t of this.threads.values()) {
      if (t.state === THREAD_STATE.READY) all.push(t);
    }
    // Limpiar todas las colas
    this.readyQueues.mlfq = new MLFQ(this);
    this.readyQueues.cfs = new CFS(this);
    this.readyQueues.edf = new EDF();
    this.readyQueues.fcfs = new FIFO();
    this.readyQueues.rr = new FIFO();
    this.readyQueues.sjf = new Heap((a, b) => a._estimatedMs - b._estimatedMs);
    this.readyQueues.priority = new Heap(
      (a, b) => a.priority - b.priority || a.createdAt - b.createdAt
    );
    all.forEach((t) => this._enqueueReady(t));
  }

  _currentThreadOf(coreId) {
    const core = this.cores.find((c) => c.id === coreId);
    if (!core || !core.currentThreadId) return null;
    return this.threads.get(core.currentThreadId) || null;
  }

  // ------------------------------------------------------------------ tick
  _tick() {
    if (this.state !== SCHEDULER_STATE.RUNNING) return;
    const t0 = now();
    this.telemetry.tickCount++;

    // jiffies a 100 Hz
    if (t0 - this._lastJiffyTime >= 10) {
      this.telemetry.jiffies++;
      this._lastJiffyTime = t0;
      kernelBus.emit(SCHEDULER_EVENTS.JIFFY, { jiffies: this.telemetry.jiffies });
    }

    // aging cada 100 ms
    if (t0 - this._lastAgingTime >= AGING_INTERVAL_MS) {
      this._lastAgingTime = t0;
      this._applyAging();
    }

    // Timers
    this.timers.tick();

    // Programar cada core
    let busyCores = 0;
    for (const core of this.cores) {
      if (core.state === CORE_STATE.OFFLINE || core.state === CORE_STATE.HALTED) continue;
      this._scheduleOnCore(core);
      if (core.currentThreadId) busyCores++;
    }

    if (busyCores === 0) this.telemetry.idleTicks++;
    else this.telemetry.busyTicks++;

    // Load average
    this.telemetry.sampleLoad(this.cores);

    // Deadline monitoring (EDF)
    if (this.policy === SCHED_POLICY.EDF) {
      this._checkDeadlines();
    }

    kernelBus.emit(SCHEDULER_EVENTS.TICK, {
      tick: this.telemetry.tickCount,
      busyCores,
    });

    this._notify();
  }

  _scheduleOnCore(core) {
    // Si el core ya tiene un hilo, comprobar quantum
    if (core.currentThreadId) {
      const current = this.threads.get(core.currentThreadId);
      if (!current) {
        core.idle();
      } else if (current.state === THREAD_STATE.RUNNING) {
        current.sliceUsedMs += this.tickIntervalMs;
        current.totalRunMs += this.tickIntervalMs;
        core.run(current, this.tickIntervalMs);

        // Preempción
        if (current.sliceUsedMs >= current.quantumMs) {
          this.telemetry.preemptions++;
          kernelBus.emit(SCHEDULER_EVENTS.PREEMPT, { tid: current.tid });
          this._removeFromQueues(current);
          current.sliceUsedMs = 0;
          // CFS: actualizar vruntime
          if (this.policy === SCHED_POLICY.CFS) {
            current.vruntime += current.quantumMs * (1 + Math.pow(1.25, current.nice));
          }
          this._enqueueReady(current);
          core.idle();
        } else {
          return;
        }
      } else {
        core.idle();
      }
    }

    // Elegir siguiente
    const picked = this._dequeueReady(core);
    if (!picked) {
      core.idle();
      return;
    }
    const { thread, quantum } = picked;
    if (thread.isTerminated) {
      core.idle();
      return;
    }

    // Context switch
    const prev = core.currentThreadId;
    if (prev !== thread.tid) {
      this.telemetry.contextSwitches++;
      core.contextSwitch();
      kernelBus.emit(SCHEDULER_EVENTS.CONTEXT_SWITCH, {
        coreId: core.id,
        from: prev,
        to: thread.tid,
      });
    }

    thread.coreId = core.id;
    thread.quantumMs = quantum;
    thread.sliceUsedMs = 0;
    thread.runCount++;
    thread.lastRunAt = now();
    thread.setState(THREAD_STATE.RUNNING);

    core.run(thread, this.tickIntervalMs);

    kernelBus.emit(SCHEDULER_EVENTS.THREAD_RUNNING, {
      tid: thread.tid,
      coreId: core.id,
    });
  }

  _applyAging() {
    // Promocionar hilos de nivel bajo que llevan mucho tiempo esperando
    const nowMs = now();
    for (const t of this.threads.values()) {
      if (t.state !== THREAD_STATE.READY) continue;
      const waited = nowMs - (t.lastRunAt || t.createdAt);
      if (waited > 2000 && t.priorityClass === PRIORITY_CLASS.LOW) {
        t.priorityClass = PRIORITY_CLASS.NORMAL;
        this._removeFromQueues(t);
        this._enqueueReady(t);
      } else if (waited > 5000 && t.priorityClass === PRIORITY_CLASS.NORMAL) {
        t.priorityClass = PRIORITY_CLASS.HIGH;
        this._removeFromQueues(t);
        this._enqueueReady(t);
      }
    }
  }

  _checkDeadlines() {
    const nowMs = now();
    for (const t of this.threads.values()) {
      if (
        t.deadlineMs != null &&
        t.state !== THREAD_STATE.TERMINATED &&
        t.finishedAt == null
      ) {
        const deadline = t.createdAt + t.deadlineMs;
        if (nowMs > deadline) {
          this.telemetry.deadlineMisses++;
          kernelBus.emit(SCHEDULER_EVENTS.DEADLINE_MISSED, {
            tid: t.tid,
            deadline,
          });
          t.deadlineMs = null;
        }
      }
    }
  }

  _gpuTick() {
    if (!this.gpu) return;
    this.gpu.process(2);
    this.gpu.present();
  }

  // ------------------------------------------------------------------ GPU
  submitGpuCommand(cmd) {
    if (!this.gpu) return null;
    return this.gpu.submit(cmd);
  }

  registerShader(id, source) {
    if (!this.gpu) return null;
    return this.gpu.registerShader(id, source);
  }

  allocVram(bytes, tag) {
    if (!this.gpu) return null;
    return this.gpu.allocVram(bytes, tag);
  }

  createTexture(id, opts) {
    if (!this.gpu) return null;
    return this.gpu.createTexture(id, opts);
  }

  createFramebuffer(id, opts) {
    if (!this.gpu) return null;
    return this.gpu.createFramebuffer(id, opts);
  }

  // ------------------------------------------------------------------ IPC
  createPipe(opts = {}) {
    const pipe = new Pipe(opts);
    this.pipes.set(pipe.id, pipe);
    kernelBus.emit(SCHEDULER_EVENTS.PIPE_CREATED, { pipeId: pipe.id });
    return pipe;
  }

  createMessageQueue(opts = {}) {
    const mq = new MessageQueue(opts);
    this.messageQueues.set(mq.id, mq);
    return mq;
  }

  createSharedMemory(bytes) {
    const shm = new SharedMemory(bytes);
    this.sharedMemory.set(shm.id, shm);
    kernelBus.emit(SCHEDULER_EVENTS.SHM_CREATED, {
      shmId: shm.id,
      bytes,
    });
    return shm;
  }

  // ------------------------------------------------------------------ memoria
  mmapProcess(process, bytes, opts = {}) {
    const r = process.addressSpace.mmap(bytes, opts);
    kernelBus.emit(SCHEDULER_EVENTS.MMAP, {
      pid: process.pid,
      ...r,
    });
    return r;
  }

  munmapProcess(process, id) {
    const ok = process.addressSpace.munmap(id);
    if (ok) kernelBus.emit(SCHEDULER_EVENTS.MUNMAP, { pid: process.pid, id });
    return ok;
  }

  // ------------------------------------------------------------------ API para el kernel
  open(opts) {
    const id = uid("task");
    const fn = opts.fn || opts.component;
    const task = {
      id,
      fn,
      kind: TASK_KIND.ONCE,
      once: true,
      priority: opts.priority ?? PRIORITY.NORMAL,
      delay: opts.delay ?? 0,
      tag: opts.tag ?? null,
      name: opts.name ?? id,
      scheduledAt: now(),
      runCount: 0,
      lastRunAt: null,
      totalTime: 0,
      thread: null,
    };
    if (typeof fn === "function") {
      task.thread = this.spawnFunction(fn, {
        name: task.name,
        priority: task.priority,
      });
    }
    kernelBus.emit(SCHEDULER_EVENTS.TASK_SCHEDULED, { id, name: task.name });
    return id;
  }

  schedule(fn, opts = {}) {
    return this.open({ ...opts, fn });
  }

  defer(fn, opts = {}) {
    return this.open({ ...opts, fn, delay: opts.delay ?? 0 });
  }

  interval(fn, ms, opts = {}) {
    const thread = this.spawnFunction(
      async () => {
        while (true) {
          await sleep(ms);
          if (thread.state === THREAD_STATE.TERMINATED) break;
          try {
            await fn();
          } catch (err) {
            console.error("[scheduler interval]", err);
          }
        }
      },
      { name: opts.name || "interval", priority: opts.priority }
    );
    return thread.tid;
  }

  microtask(fn, opts = {}) {
    if (typeof queueMicrotask === "function") {
      queueMicrotask(fn);
    } else {
      Promise.resolve().then(fn);
    }
    return uid("micro");
  }

  raf(fn, opts = {}) {
    const id = uid("raf");
    const loop = () => {
      if (this.state !== SCHEDULER_STATE.RUNNING) return;
      try {
        fn();
      } catch (err) {
        console.error("[scheduler raf]", err);
      }
      this.rafHandle = requestAnimationFrame(loop);
    };
    this.rafHandle = requestAnimationFrame(loop);
    return id;
  }

  idle(fn, opts = {}) {
    const id = uid("idle");
    const run = () => fn();
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: opts.timeout ?? 1000 });
    } else {
      setTimeout(run, 1);
    }
    return id;
  }

  cancel(id) {
    // Buscar thread con ese id o nombre
    for (const t of this.threads.values()) {
      if (t.tid === id || t.name === id) {
        this._terminateThread(t, 143);
        kernelBus.emit(SCHEDULER_EVENTS.TASK_CANCELLED, { id });
        return true;
      }
    }
    return false;
  }

  cancelAll() {
    for (const t of Array.from(this.threads.values())) {
      this._terminateThread(t, 143);
    }
  }

  // ------------------------------------------------------------------ snapshot
  snapshot() {
    return {
      state: this.state,
      policy: this.policy,
      tickHz: this.tickHz,
      uptimeMs: this.clock.now(),
      cores: this.cores.map((c) => c.snapshot()),
      threads: {
        total: this.threads.size,
        ready: this._countByState(THREAD_STATE.READY),
        running: this._countByState(THREAD_STATE.RUNNING),
        blocked: this._countByState(THREAD_STATE.BLOCKED),
        sleeping: this._countByState(THREAD_STATE.SLEEPING),
      },
      processes: {
        total: this.processes.size,
      },
      memory: this.memory.snapshot(),
      gpu: this.gpu ? this.gpu.snapshot() : null,
      queues: {
        mlfq: this.readyQueues.mlfq.snapshot(),
        cfs: this.readyQueues.cfs.snapshot(),
        edf: this.readyQueues.edf.snapshot(),
        fcfs: this.readyQueues.fcfs.size(),
        rr: this.readyQueues.rr.size(),
        sjf: this.readyQueues.sjf.size(),
        priority: this.readyQueues.priority.size(),
      },
      ipc: {
        pipes: this.pipes.size,
        messageQueues: this.messageQueues.size,
        sharedMemory: this.sharedMemory.size,
      },
      telemetry: this.telemetry.snapshot(),
      timers: this.timers.size(),
    };
  }

  _countByState(state) {
    let n = 0;
    for (const t of this.threads.values()) if (t.state === state) n++;
    return n;
  }

  // ------------------------------------------------------------------ inspección
  ps() {
    const rows = [];
    for (const p of this.processes.values()) {
      rows.push({
        pid: p.pid,
        ppid: p.ppid,
        name: p.name,
        state: p.state,
        threads: p.threadCount,
        mem: p.addressSpace.usage().bytesInUse,
      });
    }
    return rows;
  }

  top() {
    const rows = [];
    for (const t of this.threads.values()) {
      rows.push({
        tid: t.tid,
        name: t.name,
        pid: t.process?.pid ?? "-",
        state: t.state,
        core: t.coreId,
        runCount: t.runCount,
        totalRunMs: Math.round(t.totalRunMs),
        vruntime: Math.round(t.vruntime),
        nice: t.nice,
      });
    }
    rows.sort((a, b) => b.totalRunMs - a.totalRunMs);
    return rows;
  }

  dump() {
    return JSON.stringify(this.snapshot(), null, 2);
  }

  // ------------------------------------------------------------------ dispose
  dispose() {
    this.cancelAll();
    this.threads.clear();
    this.processes.clear();
    this.pipes.clear();
    this.messageQueues.clear();
    this.sharedMemory.clear();
    this.readyQueues.mlfq = new MLFQ(this);
    this.readyQueues.cfs = new CFS(this);
    this.readyQueues.edf = new EDF();
    this.readyQueues.fcfs = new FIFO();
    this.readyQueues.rr = new FIFO();
    this.readyQueues.sjf = new Heap((a, b) => a._estimatedMs - b._estimatedMs);
    this.readyQueues.priority = new Heap(
      (a, b) => a.priority - b.priority || a.createdAt - b.createdAt
    );
    this.stop();
  }
}

// ============================================================================
// 13. PROVIDER + HOOKS
// ============================================================================

const SchedulerContext = createContext(null);

const initialState = {
  state: SCHEDULER_STATE.OFFLINE,
  snapshot: null,
  logs: [],
};

function reducer(state, action) {
  switch (action.type) {
    case "SNAPSHOT":
      return { ...state, snapshot: action.snapshot, state: action.snapshot.state };
    case "LOG":
      return { ...state, logs: [...state.logs.slice(-299), action.entry] };
    default:
      return state;
  }
}

export function SchedulerProvider({
  children,
  scheduler: external,
  options = {},
  autoStart = true,
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new Scheduler(options);
  }
  const scheduler = ref.current;

  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    const unsub = scheduler.subscribe((snap) => {
      dispatch({ type: "SNAPSHOT", snapshot: snap });
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
  }, [autoStart, scheduler]);

  const api = useMemo(
    () => ({
      scheduler,
      state: state.state,
      snapshot: state.snapshot,
      logs: state.logs,

      start: () => scheduler.start(),
      stop: () => scheduler.stop(),
      pause: () => scheduler.pause(),
      resume: () => scheduler.resume(),
      panic: (r) => scheduler.panic(r),
      setPolicy: (p) => scheduler.setPolicy(p),

      // cores
      onlineCore: (id) => scheduler.onlineCore(id),
      offlineCore: (id) => scheduler.offlineCore(id),

      // procesos
      createProcess: (opts) => scheduler.createProcess(opts),
      fork: (p) => scheduler.fork(p),
      exec: (p, opts) => scheduler.exec(p, opts),
      waitProcess: (pid) => scheduler.waitProcess(pid),
      killProcess: (pid, sig) => scheduler.killProcess(pid, sig),
      sendSignal: (p, s) => scheduler.sendSignal(p, s),

      // hilos
      spawnThread: (opts) => scheduler.spawnThread(opts),
      spawnFunction: (fn, opts) => scheduler.spawnFunction(fn, opts),
      joinThread: (t) => scheduler.joinThread(t),
      detachThread: (tid) => scheduler.detachThread(tid),
      setThreadPriority: (tid, p) => scheduler.setThreadPriority(tid, p),
      setThreadAffinity: (tid, c) => scheduler.setThreadAffinity(tid, c),
      sleep: (t, ms) => scheduler.sleep(t, ms),
      yield: () => scheduler.yield(),

      // GPU
      submitGpuCommand: (cmd) => scheduler.submitGpuCommand(cmd),
      registerShader: (id, src) => scheduler.registerShader(id, src),
      allocVram: (b, t) => scheduler.allocVram(b, t),
      createTexture: (id, o) => scheduler.createTexture(id, o),
      createFramebuffer: (id, o) => scheduler.createFramebuffer(id, o),

      // IPC
      createPipe: (o) => scheduler.createPipe(o),
      createMessageQueue: (o) => scheduler.createMessageQueue(o),
      createSharedMemory: (b) => scheduler.createSharedMemory(b),

      // memoria
      mmapProcess: (p, b, o) => scheduler.mmapProcess(p, b, o),
      munmapProcess: (p, id) => scheduler.munmapProcess(p, id),

      // API compatible
      open: (o) => scheduler.open(o),
      schedule: (fn, o) => scheduler.schedule(fn, o),
      defer: (fn, o) => scheduler.defer(fn, o),
      interval: (fn, ms, o) => scheduler.interval(fn, ms, o),
      microtask: (fn, o) => scheduler.microtask(fn, o),
      raf: (fn, o) => scheduler.raf(fn, o),
      idle: (fn, o) => scheduler.idle(fn, o),
      cancel: (id) => scheduler.cancel(id),
      cancelAll: () => scheduler.cancelAll(),

      // inspección
      ps: () => scheduler.ps(),
      top: () => scheduler.top(),
      dump: () => scheduler.dump(),

      dispose: () => scheduler.dispose(),
    }),
    [scheduler, state]
  );

  return (
    <SchedulerContext.Provider value={api}>{children}</SchedulerContext.Provider>
  );
}

export function useScheduler() {
  const ctx = useContext(SchedulerContext);
  if (!ctx)
    throw new Error("useScheduler must be used within a SchedulerProvider");
  return ctx;
}

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function useFrameTimer() {
  const [fps, setFps] = useState(0);
  const lastRef = useRef(Date.now());
  const framesRef = useRef(0);

  useSchedulerFrame(() => {
    framesRef.current++;
    const t = Date.now();
    if (t - lastRef.current >= 1000) {
      setFps(framesRef.current);
      framesRef.current = 0;
      lastRef.current = t;
    }
  });

  return fps;
}

// ============================================================================
// 14. EXPORTS
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
  THREAD_STATE,
  PROCESS_STATE,
  CORE_STATE,
  GPU_STATE,
  PRIORITY_CLASS,
  SCHED_POLICY,
  SIGNAL,
  CpuCore,
  Thread,
  Process,
  AddressSpace,
  MemoryManager,
  GpuPipeline,
  Pipe,
  MessageQueue,
  SharedMemory,
  Semaphore,
  Mutex,
  Condition,
  MLFQ,
  CFS,
  EDF,
  MonotonicClock,
  WallClock,
  TimerWheel,
  Telemetry,
  Heap,
  FIFO,
  RNG,
  Logger,
};
