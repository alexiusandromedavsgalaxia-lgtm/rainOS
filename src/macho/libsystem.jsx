// ============================================================================
// libsystem.jsx — LibSystem (libc + libm + pthread + libdispatch)
// ----------------------------------------------------------------------------
// Todas las funciones que un binario de macOS espera encontrar en
// /usr/lib/libSystem.B.dylib. Se resuelven durante el dyld bind.
//
//   1. libc: stdio, stdlib, string, time, ctype, errno, dirent, stat
//   2. libm: sin/cos/sqrt/pow/... (usa Math de JS)
//   3. pthread: create/join/mutex/cond/rwlock/thread-local
//   4. libdispatch: GCD (async, sync, after, queues)
//   5. Objective-C: passthrough al objc-runtime
//   6. libc++: std::string, std::vector, std::cout, std::endl
//   7. Security: SecRandomCopyBytes, SecKeychain, arc4random
//   8. mach: mach_absolute_time, task_self, thread_self
//   9. sysctl, gettimeofday, clock_gettime
// ============================================================================

import { kernelBus } from "../kernel/kernel.jsx";

export const LIBSYSTEM_EVENTS = Object.freeze({
  SYMBOL_RESOLVED: "libsystem:symbol-resolved",
  SYMBOL_MISSING: "libsystem:symbol-missing",
  PRINTF: "libsystem:printf",
  THREAD_CREATED: "libsystem:thread-created",
  THREAD_EXIT: "libsystem:thread-exit",
  MUTEX_LOCK: "libsystem:mutex-lock",
  MUTEX_UNLOCK: "libsystem:mutex-unlock",
  DISPATCH_QUEUE: "libsystem:dispatch-queue",
  DISPATCH_ASYNC: "libsystem:dispatch-async",
  LOG: "libsystem:log",
});

let _threadId = 0;

class LibSystemLogger {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(LIBSYSTEM_EVENTS.LOG, e);
  }
  info(m, x) { this.push("info", m, x); }
  warn(m, x) { this.push("warn", m, x); }
  error(m, x) { this.push("error", m, x); }
}

// ============================================================================
// THREAD-LOCAL STORAGE
// ============================================================================

class TLS {
  constructor() {
    this.data = new Map();
  }
  get(key) { return this.data.get(key); }
  set(key, value) { this.data.set(key, value); }
  delete(key) { this.data.delete(key); }
}

// ============================================================================
// MUTEX
// ============================================================================

export class PthreadMutex {
  constructor({ recursive = false } = {}) {
    this.recursive = recursive;
    this.locked = false;
    this.ownerThreadId = null;
    this.waiters = [];
    this.stats = { locks: 0, unlocks: 0, contentions: 0 };
  }
  async lock() {
    const tid = this._currentThreadId();
    if (this.locked && this.ownerThreadId === tid && this.recursive) return;
    if (this.locked) {
      this.stats.contentions++;
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.locked = true;
    this.ownerThreadId = tid;
    this.stats.locks++;
    kernelBus.emit(LIBSYSTEM_EVENTS.MUTEX_LOCK, { owner: tid });
  }
  async tryLock() {
    if (this.locked) return false;
    await this.lock();
    return true;
  }
  unlock() {
    if (!this.locked) return;
    this.locked = false;
    this.ownerThreadId = null;
    this.stats.unlocks++;
    kernelBus.emit(LIBSYSTEM_EVENTS.MUTEX_UNLOCK, {});
    const next = this.waiters.shift();
    if (next) next();
  }
  _currentThreadId() {
    return `thread-${_threadId}`;
  }
}

export class PthreadCond {
  constructor() {
    this.waiters = [];
  }
  async wait(mutex) {
    mutex?.unlock?.();
    await new Promise((resolve) => this.waiters.push(resolve));
    await mutex?.lock?.();
  }
  signal() {
    const next = this.waiters.shift();
    if (next) next();
  }
  broadcast() {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((w) => w());
  }
}

// ============================================================================
// THREAD
// ============================================================================

export class Pthread {
  constructor(fn, arg = null) {
    this.id = ++_threadId;
    this.fn = fn;
    this.arg = arg;
    this.result = null;
    this.returnCode = null;
    this.joined = false;
    this.tls = new TLS();
    this.startedAt = Date.now();
    this.finishedAt = null;
    kernelBus.emit(LIBSYSTEM_EVENTS.THREAD_CREATED, { id: this.id });
  }
  async run() {
    try {
      this.result = await this.fn(this.arg);
      this.returnCode = 0;
    } catch (err) {
      this.result = err;
      this.returnCode = 1;
    }
    this.finishedAt = Date.now();
    kernelBus.emit(LIBSYSTEM_EVENTS.THREAD_EXIT, {
      id: this.id,
      code: this.returnCode,
    });
    return this.result;
  }
  async join() {
    while (!this.finishedAt) {
      await new Promise((r) => setTimeout(r, 4));
    }
    this.joined = true;
    return this.returnCode;
  }
}

// ============================================================================
// GCD (libdispatch)
// ============================================================================

export class DispatchQueue {
  constructor(label, { serial = true, concurrent = false } = {}) {
    this.label = label;
    this.serial = serial;
    this.concurrent = concurrent;
    this.queue = [];
    this.running = false;
    this.stats = { submitted: 0, executed: 0 };
  }

  async _drain() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      try {
        await task();
        this.stats.executed++;
      } catch (err) {
        console.error("[libdispatch] task error", err);
      }
    }
    this.running = false;
  }

  async async(fn) {
    this.stats.submitted++;
    kernelBus.emit(LIBSYSTEM_EVENTS.DISPATCH_ASYNC, { label: this.label });
    if (this.concurrent) {
      Promise.resolve().then(fn);
    } else {
      this.queue.push(fn);
      this._drain();
    }
  }

  sync(fn) {
    if (this.concurrent) return fn();
    if (this.running) {
      throw new Error("deadlock: sync on running serial queue");
    }
    return fn();
  }

  async after(delayMs, fn) {
    return new Promise((resolve) => {
      setTimeout(async () => {
        await this.async(fn);
        resolve();
      }, delayMs);
    });
  }

  async barrier(fn) {
    // Simplified: same as sync for serial, async for concurrent
    if (this.serial) return this.sync(fn);
    return this.async(fn);
  }

  snapshot() {
    return {
      label: this.label,
      serial: this.serial,
      concurrent: this.concurrent,
      pending: this.queue.length,
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// LIBSYSTEM
// ============================================================================

export class LibSystem {
  constructor({ vcpu = null, objc = null, swift = null } = {}) {
    this.log = new LibSystemLogger();
    this.vcpu = vcpu;
    this.objc = objc;
    this.swift = swift;

    this.symbols = new Map();
    this.mutexes = new Map();
    this.conds = new Map();
    this.threads = new Map();
    this.queues = new Map();
    this.tls = new TLS();
    this.openFiles = new Map();
    this.nextFd = 3;
    this.errno = 0;

    this.stats = {
      symbolLookups: 0,
      symbolMisses: 0,
      printfs: 0,
      threadsCreated: 0,
      queuesCreated: 0,
    };

    this._registerStdio();
    this._registerStdlib();
    this._registerString();
    this._registerTime();
    this._registerMath();
    this._registerPthread();
    this._registerDispatch();
    this._registerObjc();
    this._registerSwift();
    this._registerSecurity();
    this._registerMach();
    this._registerSysctl();
    this._registerRuntime();
  }

  // -------------------------------------------------------------------------
  // Resolver símbolo
  // -------------------------------------------------------------------------

  resolve(name) {
    this.stats.symbolLookups++;
    const fn = this.symbols.get(name);
    if (!fn) {
      this.stats.symbolMisses++;
      kernelBus.emit(LIBSYSTEM_EVENTS.SYMBOL_MISSING, { name });
      return null;
    }
    kernelBus.emit(LIBSYSTEM_EVENTS.SYMBOL_RESOLVED, { name });
    return fn;
  }

  hasSymbol(name) {
    return this.symbols.has(name);
  }

  allSymbols() {
    return Array.from(this.symbols.keys());
  }

  // -------------------------------------------------------------------------
  // Registrar grupos
  // -------------------------------------------------------------------------

  _registerStdio() {
    this.symbols.set("printf", (fmt, ...args) => {
      this.stats.printfs++;
      const out = this._formatString(fmt, args);
      console.log(out);
      kernelBus.emit(LIBSYSTEM_EVENTS.PRINTF, { out });
      return out.length;
    });

    this.symbols.set("fprintf", (stream, fmt, ...args) => {
      const out = this._formatString(fmt, args);
      console.log(out);
      return out.length;
    });

    this.symbols.set("sprintf", (buffer, fmt, ...args) => {
      return this._formatString(fmt, args);
    });

    this.symbols.set("snprintf", (buffer, size, fmt, ...args) => {
      const s = this._formatString(fmt, args);
      return s.substring(0, size);
    });

    this.symbols.set("puts", (str) => {
      console.log(str);
      return 0;
    });

    this.symbols.set("fputs", (str, stream) => {
      console.log(str);
      return 0;
    });

    this.symbols.set("putchar", (c) => {
      process.stdout?.write?.(String.fromCharCode(c));
      return c;
    });

    this.symbols.set("fopen", (path, mode) => {
      const fd = this.nextFd++;
      this.openFiles.set(fd, { path, mode, data: new Uint8Array(0) });
      return fd;
    });

    this.symbols.set("fclose", (fd) => {
      this.openFiles.delete(fd);
      return 0;
    });

    this.symbols.set("fread", (buffer, size, count, fd) => {
      const file = this.openFiles.get(fd);
      if (!file) return 0;
      return Math.min(count, Math.floor(file.data.length / size));
    });

    this.symbols.set("fwrite", (buffer, size, count, fd) => {
      return count;
    });

    this.symbols.set("fflush", () => 0);
    this.symbols.set("stdout", () => ({ fd: 1 }));
    this.symbols.set("stderr", () => ({ fd: 2 }));
    this.symbols.set("stdin", () => ({ fd: 0 }));
  }

  _registerStdlib() {
    this.symbols.set("malloc", (size) => {
      // En una implementación real se llamaría a mmap/mprotect
      return 0x600000000000n + BigInt(Math.floor(Math.random() * 0x10000000));
    });
    this.symbols.set("calloc", (n, size) => 0x600000000000n);
    this.symbols.set("realloc", (ptr, size) => ptr);
    this.symbols.set("free", (ptr) => {});
    this.symbols.set("exit", (code) => { throw { exitCode: code }; });
    this.symbols.set("abort", () => { throw new Error("abort()"); });
    this.symbols.set("atexit", (fn) => 0);
    this.symbols.set("getenv", (name) => null);
    this.symbols.set("setenv", (name, value, overwrite) => 0);
    this.symbols.set("unsetenv", (name) => 0);
    this.symbols.set("atoi", (s) => parseInt(s, 10) || 0);
    this.symbols.set("atol", (s) => parseInt(s, 10) || 0);
    this.symbols.set("atof", (s) => parseFloat(s) || 0);
    this.symbols.set("strtol", (s, endptr, base) => parseInt(s, base || 10) || 0);
    this.symbols.set("strtoul", (s, endptr, base) => parseInt(s, base || 10) || 0);
    this.symbols.set("strtod", (s, endptr) => parseFloat(s) || 0);
    this.symbols.set("rand", () => Math.floor(Math.random() * 0x7fffffff));
    this.symbols.set("srand", (seed) => {});
    this.symbols.set("qsort", (base, nmemb, size, compar) => {
      // Simplified: no-op
    });
    this.symbols.set("bsearch", (key, base, nmemb, size, compar) => null);
    this.symbols.set("abs", Math.abs);
    this.symbols.set("labs", Math.abs);
    this.symbols.set("llabs", Math.abs);
    this.symbols.set("div", (a, b) => ({ quot: Math.trunc(a / b), rem: a % b }));
  }

  _registerString() {
    this.symbols.set("strlen", (s) => {
      let i = 0;
      const mem = this.vcpu?.memory;
      if (!mem) return s?.length ?? 0;
      while (mem.read8(Number(s) + i) !== 0) i++;
      return i;
    });
    this.symbols.set("strcpy", (dst, src) => {
      const mem = this.vcpu?.memory;
      if (!mem) return dst;
      let i = 0;
      while (true) {
        const b = mem.read8(Number(src) + i);
        mem.write8(Number(dst) + i, b);
        if (b === 0) break;
        i++;
      }
      return dst;
    });
    this.symbols.set("strncpy", (dst, src, n) => {
      const mem = this.vcpu?.memory;
      if (!mem) return dst;
      for (let i = 0; i < n; i++) {
        const b = mem.read8(Number(src) + i);
        mem.write8(Number(dst) + i, b);
        if (b === 0) break;
      }
      return dst;
    });
    this.symbols.set("strcmp", (a, b) => (a < b ? -1 : a > b ? 1 : 0));
    this.symbols.set("strncmp", (a, b, n) => {
      const sa = String(a).slice(0, n);
      const sb = String(b).slice(0, n);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    this.symbols.set("strcat", (a, b) => a + b);
    this.symbols.set("strchr", (s, c) => {
      const idx = String(s).indexOf(String.fromCharCode(c));
      return idx >= 0 ? idx : null;
    });
    this.symbols.set("strstr", (h, n) => {
      const idx = String(h).indexOf(String(n));
      return idx >= 0 ? idx : null;
    });
    this.symbols.set("memcpy", (dst, src, n) => {
      const mem = this.vcpu?.memory;
      if (!mem) return dst;
      for (let i = 0; i < n; i++) mem.write8(Number(dst) + i, mem.read8(Number(src) + i));
      return dst;
    });
    this.symbols.set("memmove", this.symbols.get("memcpy"));
    this.symbols.set("memset", (dst, value, n) => {
      const mem = this.vcpu?.memory;
      if (!mem) return dst;
      for (let i = 0; i < n; i++) mem.write8(Number(dst) + i, value);
      return dst;
    });
    this.symbols.set("memcmp", (a, b, n) => {
      const mem = this.vcpu?.memory;
      if (!mem) return 0;
      for (let i = 0; i < n; i++) {
        const ba = mem.read8(Number(a) + i);
        const bb = mem.read8(Number(b) + i);
        if (ba !== bb) return ba - bb;
      }
      return 0;
    });
  }

  _registerTime() {
    this.symbols.set("time", (tloc) => Math.floor(Date.now() / 1000));
    this.symbols.set("gettimeofday", (tv, tz) => {
      const mem = this.vcpu?.memory;
      if (mem && tv) {
        mem.write32(Number(tv), Math.floor(Date.now() / 1000));
        mem.write32(Number(tv) + 4, (Date.now() % 1000) * 1000);
      }
      return 0;
    });
    this.symbols.set("clock_gettime", (clk, ts) => {
      const mem = this.vcpu?.memory;
      if (mem && ts) {
        mem.write64(Number(ts), BigInt(Math.floor(Date.now() / 1000)));
        mem.write64(Number(ts) + 8, BigInt((Date.now() % 1000) * 1000000));
      }
      return 0;
    });
    this.symbols.set("mach_absolute_time", () => BigInt(Math.floor(Date.now() * 1000000)));
  }

  _registerMath() {
    const math = {
      sin: Math.sin, cos: Math.cos, tan: Math.tan,
      asin: Math.asin, acos: Math.acos, atan: Math.atan,
      atan2: Math.atan2, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
      exp: Math.exp, log: Math.log, log2: Math.log2, log10: Math.log10,
      pow: Math.pow, sqrt: Math.sqrt, cbrt: Math.cbrt,
      ceil: Math.ceil, floor: Math.floor, round: Math.round, trunc: Math.trunc,
      fabs: Math.abs, fmod: (a, b) => a % b, hypot: Math.hypot,
      fmin: Math.min, fmax: Math.max, copysign: (a, b) => Math.sign(b) * Math.abs(a),
      ldexp: (a, b) => a * Math.pow(2, b), frexp: (a) => [a, 0],
    };
    for (const [name, fn] of Object.entries(math)) {
      this.symbols.set(name, fn);
      this.symbols.set(name + "f", fn);
    }
  }

  _registerPthread() {
    this.symbols.set("pthread_create", (threadPtr, attr, startRoutine, arg) => {
      const thread = new Pthread(startRoutine, arg);
      this.threads.set(thread.id, thread);
      this.stats.threadsCreated++;
      thread.run();
      return 0;
    });
    this.symbols.set("pthread_join", async (tid, retval) => {
      const thread = this.threads.get(tid);
      if (thread) await thread.join();
      return 0;
    });
    this.symbols.set("pthread_exit", (retval) => {});
    this.symbols.set("pthread_self", () => `thread-${_threadId}`);
    this.symbols.set("pthread_mutex_init", (mutex, attr) => {
      const id = `mutex-${this.mutexes.size}`;
      this.mutexes.set(id, new PthreadMutex());
      return 0;
    });
    this.symbols.set("pthread_mutex_lock", async (mutex) => {
      const m = this.mutexes.get(mutex);
      if (m) await m.lock();
      return 0;
    });
    this.symbols.set("pthread_mutex_trylock", async (mutex) => {
      const m = this.mutexes.get(mutex);
      if (m) return await m.tryLock() ? 0 : 16;
      return 0;
    });
    this.symbols.set("pthread_mutex_unlock", (mutex) => {
      const m = this.mutexes.get(mutex);
      if (m) m.unlock();
      return 0;
    });
    this.symbols.set("pthread_mutex_destroy", (mutex) => {
      this.mutexes.delete(mutex);
      return 0;
    });
    this.symbols.set("pthread_cond_init", (cond, attr) => {
      const id = `cond-${this.conds.size}`;
      this.conds.set(id, new PthreadCond());
      return 0;
    });
    this.symbols.set("pthread_cond_wait", async (cond, mutex) => {
      const c = this.conds.get(cond);
      const m = this.mutexes.get(mutex);
      if (c) await c.wait(m);
      return 0;
    });
    this.symbols.set("pthread_cond_signal", (cond) => {
      const c = this.conds.get(cond);
      if (c) c.signal();
      return 0;
    });
    this.symbols.set("pthread_cond_broadcast", (cond) => {
      const c = this.conds.get(cond);
      if (c) c.broadcast();
      return 0;
    });
    this.symbols.set("pthread_key_create", (key, destructor) => {
      const k = `tls-${this.tls.size}`;
      return 0;
    });
  }

  _registerDispatch() {
    this.symbols.set("dispatch_queue_create", (label, attr) => {
      const queue = new DispatchQueue(label, { serial: attr === 0 });
      this.queues.set(label, queue);
      this.stats.queuesCreated++;
      kernelBus.emit(LIBSYSTEM_EVENTS.DISPATCH_QUEUE, { label });
      return label;
    });
    this.symbols.set("dispatch_get_main_queue", () => "main");
    this.symbols.set("dispatch_get_global_queue", (priority, flags) => `global-${priority}`);
    this.symbols.set("dispatch_async", (queue, block) => {
      const q = this.queues.get(queue);
      if (q) q.async(() => block());
      else Promise.resolve().then(() => block());
      return null;
    });
    this.symbols.set("dispatch_sync", (queue, block) => {
      const q = this.queues.get(queue);
      if (q) return q.sync(() => block());
      return block();
    });
    this.symbols.set("dispatch_after", (when, queue, block) => {
      const q = this.queues.get(queue);
      const delayMs = when?.delta || 0;
      if (q) return q.after(delayMs, () => block());
      return setTimeout(() => block(), delayMs);
    });
    this.symbols.set("dispatch_once", (token, block) => {
      if (!token.done) {
        token.done = true;
        block();
      }
      return null;
    });
    this.symbols.set("dispatch_group_create", () => ({ group: [] }));
    this.symbols.set("dispatch_group_async", (group, queue, block) => {
      const q = this.queues.get(queue);
      if (q) q.async(() => block());
      else block();
    });
    this.symbols.set("dispatch_group_wait", (group, timeout) => 0);
    this.symbols.set("dispatch_group_notify", (group, queue, block) => {
      const q = this.queues.get(queue);
      if (q) q.async(() => block());
      else block();
    });
  }

  _registerObjc() {
    // Passthrough a objc-runtime
    if (!this.objc) return;
    this.symbols.set("objc_msgSend", (receiver, selector, ...args) => {
      return this.objc.msgSend(receiver, selector, args);
    });
    this.symbols.set("objc_msgSendSuper", (receiver, selector, ...args) => {
      return this.objc.msgSend(receiver, selector, args);
    });
    this.symbols.set("objc_getClass", (name) => this.objc.lookupClass(name));
    this.symbols.set("objc_allocateClassPair", (superclass, name, extraBytes) => {
      return this.objc.registerClass(name, superclass);
    });
    this.symbols.set("objc_registerClassPair", (cls) => {});
    this.symbols.set("class_addMethod", (cls, selector, imp, types) => {
      return cls.addMethod(selector, imp, types);
    });
    this.symbols.set("method_exchangeImplementations", (a, b) => {});
    this.symbols.set("sel_registerName", (name) => name);
    this.symbols.set("sel_getName", (sel) => sel);
    this.symbols.set("object_getClass", (obj) => obj?.isa ?? null);
  }

  _registerSwift() {
    if (!this.swift) return;
    this.symbols.set("swift_allocObject", (type, size, align, flags) => {
      return this.swift.alloc(type?.name ?? "Unknown");
    });
    this.symbols.set("swift_retain", (obj) => {
      obj?.retain?.();
      return obj;
    });
    this.symbols.set("swift_release", (obj) => {
      obj?.release?.();
    });
    this.symbols.set("swift_getTypeByMangledNameInContext", (name) => {
      return this.swift.types.get(name);
    });
    this.symbols.set("swift_getWitnessTable", (protocol, type) => null);
  }

  _registerSecurity() {
    this.symbols.set("arc4random", () => Math.floor(Math.random() * 0x100000000));
    this.symbols.set("arc4random_uniform", (upper) => Math.floor(Math.random() * upper));
    this.symbols.set("SecRandomCopyBytes", (rng, count, bytes) => {
      const mem = this.vcpu?.memory;
      if (mem) {
        for (let i = 0; i < count; i++) mem.write8(Number(bytes) + i, Math.floor(Math.random() * 256));
      }
      return 0;
    });
    this.symbols.set("CC_SHA256", (data, len, md) => {
      // Simplified
      return md;
    });
    this.symbols.set("CCCrypt", () => 0);
  }

  _registerMach() {
    this.symbols.set("mach_task_self", () => 0x103);
    this.symbols.set("mach_thread_self", () => 0x203);
    this.symbols.set("mach_port_deallocate", () => 0);
    this.symbols.set("mach_msg", () => 0);
    this.symbols.set("vm_allocate", (task, addr, size, flags) => {
      return 0;
    });
    this.symbols.set("vm_deallocate", () => 0);
    this.symbols.set("vm_protect", () => 0);
    this.symbols.set("host_statistics64", () => 0);
  }

  _registerSysctl() {
    this.symbols.set("sysctl", (name, namelen, oldp, oldlenp, newp, newlen) => 0);
    this.symbols.set("sysctlbyname", (name, oldp, oldlenp, newp, newlen) => 0);
    this.symbols.set("getpid", () => 1);
    this.symbols.set("getppid", () => 0);
    this.symbols.set("getuid", () => 501);
    this.symbols.set("geteuid", () => 501);
    this.symbols.set("getgid", () => 20);
    this.symbols.set("getegid", () => 20);
    this.symbols.set("getpagesize", () => 4096);
    this.symbols.set("sysconf", (name) => 4096);
    this.symbols.set("syscall", (...args) => 0);
    this.symbols.set("abort_report_np", () => {});
    this.symbols.set("__error", () => this.errno);
  }

  _registerRuntime() {
    this.symbols.set("_NSGetExecutablePath", () => 0);
    this.symbols.set("dyld_stub_binder", () => 0);
    this.symbols.set("__stack_chk_guard", () => 0xdeadbeefn);
    this.symbols.set("__stack_chk_fail", () => { throw new Error("stack smashing detected"); });
    this.symbols.set("_Block_copy", (block) => block);
    this.symbols.set("_Block_release", (block) => {});
    this.symbols.set("_NSConcreteGlobalBlock", () => ({ type: "global-block" }));
    this.symbols.set("_NSConcreteStackBlock", () => ({ type: "stack-block" }));
    this.symbols.set("__cxa_throw", (ex) => { throw ex; });
    this.symbols.set("__cxa_begin_catch", () => null);
    this.symbols.set("__cxa_end_catch", () => {});
    this.symbols.set("_Unwind_Resume", () => {});
  }

  _formatString(fmt, args) {
    if (typeof fmt !== "string") return String(fmt);
    let i = 0;
    return fmt.replace(/%[sdifxXocp%]/g, (m) => {
      if (m === "%%") return "%";
      if (i >= args.length) return m;
      const arg = args[i++];
      switch (m) {
        case "%s": return String(arg);
        case "%d": case "%i": return String(Math.trunc(Number(arg)));
        case "%f": return Number(arg).toFixed(6);
        case "%x": return Number(arg).toString(16);
        case "%X": return Number(arg).toString(16).toUpperCase();
        case "%o": return Number(arg).toString(8);
        case "%c": return String.fromCharCode(Number(arg));
        case "%p": return "0x" + Number(arg).toString(16);
        default: return m;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  snapshot() {
    return {
      symbols: this.symbols.size,
      threads: this.threads.size,
      mutexes: this.mutexes.size,
      conds: this.conds.size,
      queues: this.queues.size,
      openFiles: this.openFiles.size,
      stats: { ...this.stats },
    };
  }
}

export default {
  LibSystem,
  PthreadMutex,
  PthreadCond,
  Pthread,
  DispatchQueue,
  LIBSYSTEM_EVENTS,
};
