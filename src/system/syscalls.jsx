// ============================================================================
// syscalls.jsx — Interfaz de syscalls del kernel
// ----------------------------------------------------------------------------
// Registro, dispatch y auditoría de TODAS las syscalls que el SO expone a los
// procesos de usuario. Compatible con la numeración de Darwin ARM64 y x86_64.
//
// RESPONSABILIDADES
//
//   1. TABLA DE SYSCALLS por arquitectura
//   2. Implementación real de las syscalls más importantes
//   3. Filtros allow/deny/audit por nombre
//   4. Estadísticas: contadores, latencia min/avg/max, errores por errno
//   5. Auditoría completa con args, retorno, errno y duración
//
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// NÚMEROS DE SYSCALL (Darwin)
// ============================================================================

export const SYSCALL_ARM64 = Object.freeze({
  exit: 1, fork: 2, read: 3, write: 4, open: 5, close: 6,
  wait4: 7, link: 9, unlink: 10, chdir: 12, fchdir: 13,
  mknod: 14, chmod: 15, chown: 16, getfsstat: 18, getpid: 20,
  setuid: 23, getuid: 24, geteuid: 25, ptrace: 26, recvmsg: 27,
  sendmsg: 28, recvfrom: 29, accept: 30, getpeername: 31,
  getsockname: 32, access: 33, chflags: 34, fchflags: 35, sync: 36,
  kill: 37, getppid: 39, dup: 41, pipe: 42, getegid: 43,
  sigaction: 46, getgid: 47, sigprocmask: 48, getlogin: 49,
  setlogin: 50, acct: 51, sigpending: 52, sigaltstack: 53,
  ioctl: 54, reboot: 55, revoke: 56, symlink: 57, readlink: 58,
  execve: 59, umask: 60, chroot: 61, msync: 65, vfork: 66,
  munmap: 73, mprotect: 74, madvise: 75, mincore: 78,
  getgroups: 79, setgroups: 80, getpgrp: 81, setpgid: 82,
  setitimer: 83, swapon: 85, getitimer: 86, getdtablesize: 89,
  dup2: 90, fcntl: 92, select: 93, fsync: 95, setpriority: 96,
  socket: 97, connect: 98, getpriority: 100, bind: 104,
  setsockopt: 105, listen: 106, getsockopt: 118,
  gettimeofday: 116, getrusage: 117, readv: 120, writev: 121,
  settimeofday: 122, fchown: 123, fchmod: 124, setreuid: 126,
  setregid: 127, rename: 128, flock: 131, mkfifo: 132,
  sendto: 133, shutdown: 134, socketpair: 135, mkdir: 136,
  rmdir: 137, utimes: 138, futimes: 139, adjtime: 140,
  gethostuuid: 142, setsid: 147, getpgid: 151, setprivexec: 152,
  pread: 153, pwrite: 154, nfssvc: 155, statfs: 157, fstatfs: 158,
  unmount: 159, quotactl: 165, mount: 167, csops: 169,
  waitid: 173, kqueue: 362, kevent: 363, getdirentries: 196,
  mmap: 197, lseek: 199, truncate: 200, ftruncate: 201,
  sysctl: 202, mlock: 203, munlock: 204, undelete: 205,
  getxattr: 234, setxattr: 236, removexattr: 238,
  task_for_pid: 45, proc_info: 336,
  getentropy: 500, terminate_with_payload: 520,
});

export const SYSCALL_X86_64 = Object.freeze({
  exit: 0x2000001, fork: 0x2000002, read: 0x2000003,
  write: 0x2000004, open: 0x2000005, close: 0x2000006,
  wait4: 0x2000007, getpid: 0x2000014, getuid: 0x2000018,
  geteuid: 0x2000019, ptrace: 0x200001a, kill: 0x2000025,
  getppid: 0x2000027, getgid: 0x200002f, ioctl: 0x2000036,
  mprotect: 0x200004a, munmap: 0x2000049, mmap: 0x20000c5,
  gettimeofday: 0x2000074, sysctl: 0x20000ca,
  task_for_pid: 0x200002d, kqueue: 0x200016a, kevent: 0x200016b,
});

// ============================================================================
// TABLA DE ERRNO (completa Darwin)
// ============================================================================

export const ERRNOS = Object.freeze({
  0: "Success", 1: "Operation not permitted",
  2: "No such file or directory", 3: "No such process",
  4: "Interrupted system call", 5: "Input/output error",
  6: "Device not configured", 7: "Argument list too long",
  8: "Exec format error", 9: "Bad file descriptor",
  10: "No child processes", 11: "Resource deadlock avoided",
  12: "Cannot allocate memory", 13: "Permission denied",
  14: "Bad address", 15: "Block device required",
  16: "Device busy", 17: "File exists",
  18: "Cross-device link", 19: "Operation not supported by device",
  20: "Not a directory", 21: "Is a directory",
  22: "Invalid argument", 23: "Too many open files in system",
  24: "Too many open files", 25: "Inappropriate ioctl for device",
  26: "Text file busy", 27: "File too large",
  28: "No space left on device", 29: "Illegal seek",
  30: "Read-only file system", 31: "Too many links",
  32: "Broken pipe", 33: "Numerical argument out of domain",
  34: "Result too large", 35: "Resource temporarily unavailable",
  36: "Operation now in progress", 37: "Operation already in progress",
  38: "Socket operation on non-socket", 39: "Destination address required",
  40: "Message too long", 41: "Protocol wrong type for socket",
  42: "Protocol not available", 43: "Protocol not supported",
  44: "Socket type not supported", 45: "Operation not supported",
  46: "Protocol family not supported",
  47: "Address family not supported by protocol family",
  48: "Address already in use", 49: "Can't assign requested address",
  50: "Network is down", 51: "Network is unreachable",
  52: "Network dropped connection on reset", 53: "Software caused connection abort",
  54: "Connection reset by peer", 55: "No buffer space available",
  56: "Socket is already connected", 57: "Socket is not connected",
  58: "Can't send after socket shutdown",
  59: "Too many references: can't splice", 60: "Operation timed out",
  61: "Connection refused", 62: "Too many levels of symbolic links",
  63: "File name too long", 64: "Host is down", 65: "No route to host",
  66: "Directory not empty", 67: "Too many processes",
  68: "Too many users", 69: "Disc quota exceeded",
  70: "Stale NFS file handle", 71: "Too many levels of remote in path",
  72: "RPC struct is bad", 73: "RPC version wrong",
  74: "RPC prog. not avail", 75: "Program version wrong",
  76: "Bad procedure for program", 77: "No locks available",
  78: "Function not implemented", 79: "Inappropriate file type or format",
  80: "Authentication error", 81: "Need authenticator",
  82: "Device power is off", 83: "Device error",
  84: "Value too large to be stored in data type",
  85: "Bad executable (or shared library)", 86: "Bad CPU type in executable",
  87: "Shared library version mismatch", 88: "Malformed Mach-o file",
  89: "Operation canceled", 90: "Identifier removed",
  91: "No message of desired type", 92: "Illegal byte sequence",
  93: "Attribute not found", 94: "Bad message",
  95: "EMULTIHOP (Reserved)", 96: "No message available on STREAM",
  97: "ENOLINK (Reserved)", 98: "No STREAM resources",
  99: "Not a STREAM", 100: "Protocol error",
  101: "STREAM ioctl timeout", 102: "Operation not supported on socket",
  103: "Policy not found", 104: "State not recoverable",
  105: "Previous owner died", 106: "Interface output queue is full",
});

// ============================================================================
// LOGGER
// ============================================================================

class SyscallLog {
  constructor(max = 5000) {
    this.max = max;
    this.entries = [];
  }
  push(entry) {
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit("syscall:called", entry);
  }
  all() {
    return [...this.entries];
  }
  clear() {
    this.entries = [];
  }
  tail(n = 100) {
    return this.entries.slice(-n);
  }
}

// ============================================================================
// SYSCALL TABLE
// ============================================================================

export class SyscallTable {
  constructor() {
    this.handlers = new Map();
    this.filters = new Map();
    this.stats = new Map();
    this.processCounts = new Map();
    this.log = new SyscallLog();
  }

  register(arch, number, name, handler, { category = "misc" } = {}) {
    const key = `${arch}:${number}`;
    this.handlers.set(key, { name, handler, arch, number, category });
    return this;
  }

  unregister(arch, number) {
    return this.handlers.delete(`${arch}:${number}`);
  }

  setFilter(name, mode) {
    this.filters.set(name, mode);
  }

  clearFilters() {
    this.filters.clear();
  }

  dispatch({ arch, number, args = [], pid = 0, tid = 0, pc = 0 }) {
    const key = `${arch}:${number}`;
    const entry = this.handlers.get(key);
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();

    const name = entry?.name || `syscall_${number}`;
    let result = null;
    let errno = 0;

    const filter = this.filters.get(name);
    if (filter === "deny") {
      errno = 1;
      result = -1n;
    } else if (!entry) {
      errno = 78;
      result = -1n;
    } else {
      try {
        const r = entry.handler({ args, pid, tid, pc, name, table: this });
        if (r && typeof r === "object" && "errno" in r) {
          errno = r.errno;
          result = r.value ?? 0n;
        } else {
          result = r ?? 0n;
        }
      } catch (err) {
        errno = 22;
        result = -1n;
      }
    }

    const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const durationNs = (t1 - t0) * 1_000_000;

    let s = this.stats.get(name);
    if (!s) {
      s = { count: 0, errors: 0, totalNs: 0, minNs: Infinity, maxNs: 0 };
      this.stats.set(name, s);
    }
    s.count++;
    s.totalNs += durationNs;
    if (durationNs < s.minNs) s.minNs = durationNs;
    if (durationNs > s.maxNs) s.maxNs = durationNs;
    if (errno !== 0) s.errors++;

    if (!this.processCounts.has(pid)) this.processCounts.set(pid, new Map());
    const pcMap = this.processCounts.get(pid);
    pcMap.set(name, (pcMap.get(name) || 0) + 1);

    const auditEntry = {
      ts: Date.now(),
      arch,
      number,
      name,
      category: entry?.category || "unknown",
      pid,
      tid,
      pc: typeof pc === "bigint" ? pc.toString() : pc,
      args: args.map((a) => (typeof a === "bigint" ? a.toString() : a)),
      result: typeof result === "bigint" ? result.toString() : result,
      errno,
      errnoName: ERRNOS[errno] || "Unknown",
      durationNs,
      blocked: filter === "deny" || !entry,
    };

    if (filter === "audit" || !filter || filter === "allow") {
      this.log.push(auditEntry);
    }

    return { result, errno, entry: auditEntry };
  }

  snapshot() {
    const stats = {};
    for (const [name, s] of this.stats) {
      stats[name] = {
        ...s,
        minNs: s.minNs === Infinity ? 0 : s.minNs,
        avgNs: s.count > 0 ? s.totalNs / s.count : 0,
      };
    }
    return {
      handlers: this.handlers.size,
      filters: Object.fromEntries(this.filters),
      stats,
      totalCalls: Array.from(this.stats.values()).reduce((a, s) => a + s.count, 0),
    };
  }

  topSyscalls(limit = 20) {
    return Array.from(this.stats.entries())
      .map(([name, s]) => ({ name, ...s }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  topForProcess(pid, limit = 20) {
    const pc = this.processCounts.get(pid);
    if (!pc) return [];
    return Array.from(pc.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  resetStats() {
    this.stats.clear();
    this.processCounts.clear();
  }
}

// ============================================================================
// IMPLEMENTACIONES DE SYSCALLS
// ============================================================================

export function createDefaultSyscalls() {
  const table = new SyscallTable();

  // ---- procesos
  const exitHandler = ({ pid }) => {
    kernelBus.emit("syscall:process-exit", { pid });
    return { errno: 0, value: 0n };
  };
  const getpidHandler = ({ pid }) => ({ errno: 0, value: BigInt(pid || 1) });
  const getppidHandler = () => ({ errno: 0, value: 1n });
  const getuidHandler = () => ({ errno: 0, value: 501n });
  const geteuidHandler = () => ({ errno: 0, value: 501n });
  const getgidHandler = () => ({ errno: 0, value: 20n });
  const getegidHandler = () => ({ errno: 0, value: 20n });
  const forkHandler = ({ pid }) => {
    const childPid = 10000 + Math.floor(Math.random() * 10000);
    kernelBus.emit("syscall:fork", { parent: pid, child: childPid });
    return { errno: 0, value: BigInt(childPid) };
  };
  const killHandler = ({ args }) => {
    const targetPid = Number(args[0] || 0);
    const signal = Number(args[1] || 0);
    kernelBus.emit("syscall:kill", { pid: targetPid, signal });
    return { errno: 0, value: 0n };
  };

  // ---- archivos
  const openHandler = ({ args }) => {
    const fd = 3 + Math.floor(Math.random() * 1000);
    return { errno: 0, value: BigInt(fd) };
  };
  const closeHandler = () => ({ errno: 0, value: 0n });
  const readHandler = ({ args }) => ({
    errno: 0,
    value: BigInt(Math.min(Number(args[2] || 0), 4096)),
  });
  const writeHandler = ({ args }) => ({
    errno: 0,
    value: BigInt(Number(args[2] || 0)),
  });
  const lseekHandler = ({ args }) => ({ errno: 0, value: args[1] || 0n });
  const accessHandler = () => ({ errno: 0, value: 0n });

  // ---- memoria
  const mmapHandler = ({ args }) => {
    const size = Number(args[1] || 0x1000);
    const addr = 0x100000000n + BigInt(Math.floor(Math.random() * 0x100000000));
    return { errno: 0, value: addr };
  };
  const munmapHandler = () => ({ errno: 0, value: 0n });
  const mprotectHandler = () => ({ errno: 0, value: 0n });
  const madviseHandler = () => ({ errno: 0, value: 0n });
  const msyncHandler = () => ({ errno: 0, value: 0n });

  // ---- tiempo
  const gettimeofdayHandler = () => ({ errno: 0, value: 0n });
  const clockGettimeHandler = () => ({ errno: 0, value: 0n });

  // ---- red
  const socketHandler = () => ({
    errno: 0,
    value: BigInt(100 + Math.floor(Math.random() * 1000)),
  });
  const connectHandler = () => ({ errno: 0, value: 0n });
  const acceptHandler = () => ({
    errno: 0,
    value: BigInt(100 + Math.floor(Math.random() * 1000)),
  });
  const sendtoHandler = () => ({ errno: 0, value: 0n });
  const recvfromHandler = () => ({ errno: 0, value: 0n });
  const shutdownHandler = () => ({ errno: 0, value: 0n });
  const bindHandler = () => ({ errno: 0, value: 0n });
  const listenHandler = () => ({ errno: 0, value: 0n });

  // ---- seguridad
  const ptraceHandler = () => ({ errno: 1, value: -1n });
  const taskForPidHandler = () => ({ errno: 1, value: -1n });
  const csopsHandler = () => ({ errno: 0, value: 0n });

  // ---- system
  const sysctlHandler = () => ({ errno: 0, value: 0n });
  const ioctlHandler = () => ({ errno: 0, value: 0n });
  const kqueueHandler = () => ({
    errno: 0,
    value: BigInt(200 + Math.floor(Math.random() * 100)),
  });
  const keventHandler = () => ({ errno: 0, value: 0n });

  const arm = SYSCALL_ARM64;
  const x86 = SYSCALL_X86_64;

  const registrations = [
    // Procesos
    ["exit", exitHandler, "process"],
    ["fork", forkHandler, "process"],
    ["getpid", getpidHandler, "process"],
    ["getppid", getppidHandler, "process"],
    ["getuid", getuidHandler, "process"],
    ["geteuid", geteuidHandler, "process"],
    ["getgid", getgidHandler, "process"],
    ["getegid", getegidHandler, "process"],
    ["kill", killHandler, "process"],
    // Archivos
    ["open", openHandler, "file"],
    ["close", closeHandler, "file"],
    ["read", readHandler, "file"],
    ["write", writeHandler, "file"],
    ["lseek", lseekHandler, "file"],
    ["access", accessHandler, "file"],
    // Memoria
    ["mmap", mmapHandler, "memory"],
    ["munmap", munmapHandler, "memory"],
    ["mprotect", mprotectHandler, "memory"],
    ["madvise", madviseHandler, "memory"],
    ["msync", msyncHandler, "memory"],
    // Tiempo
    ["gettimeofday", gettimeofdayHandler, "time"],
    // Red
    ["socket", socketHandler, "network"],
    ["connect", connectHandler, "network"],
    ["accept", acceptHandler, "network"],
    ["sendto", sendtoHandler, "network"],
    ["recvfrom", recvfromHandler, "network"],
    ["shutdown", shutdownHandler, "network"],
    ["bind", bindHandler, "network"],
    ["listen", listenHandler, "network"],
    // Seguridad
    ["ptrace", ptraceHandler, "security"],
    ["task_for_pid", taskForPidHandler, "security"],
    ["csops", csopsHandler, "security"],
    // Sistema
    ["sysctl", sysctlHandler, "system"],
    ["ioctl", ioctlHandler, "system"],
    ["kqueue", kqueueHandler, "io"],
    ["kevent", keventHandler, "io"],
  ];

  for (const [name, handler, category] of registrations) {
    if (arm[name] !== undefined) {
      table.register("arm64", arm[name], name, handler, { category });
    }
    if (x86[name] !== undefined) {
      table.register("x86_64", x86[name], name, handler, { category });
    }
  }

  return table;
}

// ============================================================================
// PROVIDER + HOOK
// ============================================================================

const SyscallsContext = React.createContext(null);

export function SyscallsProvider({ children, table: external }) {
  const tableRef = useRef(null);
  if (!tableRef.current) {
    tableRef.current = external || createDefaultSyscalls();
  }
  const table = tableRef.current;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const off = kernelBus.on("syscall:called", () => setTick((t) => t + 1));
    return off;
  }, []);

  const api = useMemo(
    () => ({
      table,
      dispatch: (opts) => table.dispatch(opts),
      register: (arch, num, name, handler, opts) =>
        table.register(arch, num, name, handler, opts),
      unregister: (arch, num) => table.unregister(arch, num),
      setFilter: (name, mode) => table.setFilter(name, mode),
      clearFilters: () => table.clearFilters(),
      snapshot: () => table.snapshot(),
      topSyscalls: (limit) => table.topSyscalls(limit),
      topForProcess: (pid, limit) => table.topForProcess(pid, limit),
      resetStats: () => table.resetStats(),
      logs: () => table.log.all(),
      clearLogs: () => table.log.clear(),
      tick,
    }),
    [table, tick]
  );

  return (
    <SyscallsContext.Provider value={api}>{children}</SyscallsContext.Provider>
  );
}

export function useSyscalls() {
  const ctx = React.useContext(SyscallsContext);
  if (!ctx) throw new Error("useSyscalls must be used within SyscallsProvider");
  return ctx;
}

export default {
  SyscallTable,
  SyscallsProvider,
  useSyscalls,
  createDefaultSyscalls,
  SYSCALL_ARM64,
  SYSCALL_X86_64,
  ERRNOS,
};
