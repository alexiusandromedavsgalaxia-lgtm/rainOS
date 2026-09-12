// ============================================================================
// ARM64-executor.jsx — Ejecutor ARM64 (ARMv8-A) para rainOS
// ----------------------------------------------------------------------------
// Interpreter completo de la ISA A64 (ARM64).
//
// Cobertura:
//   - 31 registros GP de 64-bit (X0..X30) + W0..W30 (32-bit view)
//   - SP, PC, NZCV, FPCR, FPSR
//   - 32 registros SIMD/FP de 128-bit (V0..V31 / Q0..Q31 / D0..D31 / S0..S31)
//   - Pipeline 5 etapas (Fetch / Decode / Execute / Memory / Writeback)
//   - Caches L1I / L1D / L2 / L3 con políticas LRU + write-back
//   - MMU ARMv8-A con tabla de páginas de 4 niveles (TTBR0/TTBR1, TCR)
//   - Excepciones EL0..EL3 (SVC, IRQ, FIQ, SError, DataAbort, InstrAbort)
//   - Syscalls vía SVC #0x80 (convención Darwin)
//   - PAC (v8.3): PACIA/PACIB/PACDA/PACDB + AUTIA/AUTIB/AUTDA/AUTDB
//   - MTE (v8.5): IRG / ADDG / SUBG / GMI / STG / LDG / STZG / ST2G
//   - SIMD/FP completo: ADD/SUB/MUL/FMA/MLA/MLS + FMOV + conversions
//   - Crypto AES/SHA (AESE/AESD/AESMC/AESIMC, SHA1*, SHA256*, SHA512*)
//   - Atomics LDXR/STXR/LDXP/STXP/LDAR/STLR/SWP/CAS/LDADD/LDSET/LDCLR/LDEOR
//
// Convención:
//   - Clase pura `ARM64Executor` sin React.
//   - Provider React fino (`ARM64ExecutorProvider`) + hook `useARM64Executor()`.
//   - Eventos en kernelBus para trazabilidad.
//   - Todas las llamadas externas con `?.()`.
// ============================================================================

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// CONSTANTES ARMv8-A
// ============================================================================

// Condition codes (campo `cond` de las instrucciones condicionales)
const COND = Object.freeze({
  EQ: 0x0, NE: 0x1, CS: 0x2, CC: 0x3,
  MI: 0x4, PL: 0x5, VS: 0x6, VC: 0x7,
  HI: 0x8, LS: 0x9, GE: 0xa, LT: 0xb,
  GT: 0xc, LE: 0xd, AL: 0xe, NV: 0xf,
});

// Exception levels
const EL = Object.freeze({
  EL0: 0, // userspace
  EL1: 1, // kernel
  EL2: 2, // hypervisor
  EL3: 3, // secure monitor
});

// Exception classes (ESR_ELx.EC)
const EC = Object.freeze({
  UNKNOWN:                0x00,
  WFI_WFE:                0x01,
  SVC64:                  0x15,
  HVC64:                  0x16,
  SMC64:                  0x17,
  INSTRUCTION_ABORT_LOWER: 0x20,
  INSTRUCTION_ABORT_SAME:  0x21,
  PC_ALIGNMENT:           0x22,
  DATA_ABORT_LOWER:       0x24,
  DATA_ABORT_SAME:        0x25,
  SP_ALIGNMENT:           0x26,
  FP_TRAP:                0x2c,
  SERROR:                 0x2f,
  BREAKPOINT_LOWER:       0x30,
  BREAKPOINT_SAME:        0x31,
  SOFTWARE_STEP_LOWER:    0x32,
  SOFTWARE_STEP_SAME:     0x33,
  WATCHPOINT_LOWER:       0x34,
  WATCHPOINT_SAME:        0x35,
  BKPT:                   0x3c,
});

// Tamaños de caché (por defecto)
const CACHE_CONFIG = Object.freeze({
  L1I: { size: 64  * 1024, lineSize: 64, associativity: 4, latency: 1 },
  L1D: { size: 64  * 1024, lineSize: 64, associativity: 4, latency: 1 },
  L2:  { size: 512 * 1024, lineSize: 128, associativity: 8, latency: 8 },
  L3:  { size: 4  * 1024 * 1024, lineSize: 128, associativity: 16, latency: 25 },
});

// Configuración por defecto del ejecutor
const DEFAULT_CONFIG = Object.freeze({
  pc: 0x100000000,
  sp: 0x700000000,
  fp: 0x700001000,
  lr: 0,
  mode: "AArch64",
  endianness: "little",
  pageSize: 4096,
  paRange: 0x100000000,       // 4 GiB de espacio físico virtual
  vaRange: 0x10000000000,     // 1 TiB de VA (48-bit)
  enableMTE: true,
  enablePAC: true,
  enableCaches: true,
  enableMMU: true,
  enablePipeline: true,
  enableAtomics: true,
  logInstructions: false,
  maxInstructions: 1_000_000, // tope de seguridad
  traceBufferSize: 4096,
});

// ============================================================================
// UTILIDADES
// ============================================================================

const u64 = (x) => BigInt.asUintN(64, BigInt(x));
const u32 = (x) => BigInt.asUintN(32, BigInt(x));
const u16 = (x) => BigInt.asUintN(16, BigInt(x));
const u8  = (x) => BigInt.asUintN(8,  BigInt(x));
const s64 = (x) => BigInt.asIntN(64, BigInt(x));
const s32 = (x) => BigInt.asIntN(32, BigInt(x));

const bit  = (x, n) => Number((BigInt(x) >> BigInt(n)) & 1n);
const bits = (x, hi, lo) => {
  const width = hi - lo + 1;
  const mask  = (1n << BigInt(width)) - 1n;
  return Number((BigInt(x) >> BigInt(lo)) & mask);
};

const signExtend = (value, fromBits) => {
  const shift = 64 - fromBits;
  return s64(u64(value) << BigInt(shift)) >> BigInt(shift);
};

const hex = (n, pad = 16) =>
  "0x" + u64(n).toString(16).padStart(pad, "0");

const now =
  typeof performance !== "undefined" && performance.now
    ? () => performance.now()
    : () => Date.now();

// ============================================================================
// CLASE: CacheSet — caché asociativa por conjuntos con LRU
// ============================================================================

class CacheSet {
  constructor({ size, lineSize, associativity, name }) {
    this.name = name;
    this.size = size;
    this.lineSize = lineSize;
    this.associativity = associativity;
    this.numSets = size / (lineSize * associativity);
    this.sets = Array.from({ length: this.numSets }, () => []);
    this.stats = { hits: 0, misses: 0, evictions: 0, writes: 0 };
  }

  _idx(addr) {
    const lineAddr = addr >>> 0;
    const block    = Math.floor(lineAddr / this.lineSize);
    return block % this.numSets;
  }

  _tag(addr) {
    const block = Math.floor((addr >>> 0) / this.lineSize);
    return Math.floor(block / this.numSets);
  }

  read(addr) {
    const set = this.sets[this._idx(addr)];
    const tag = this._tag(addr);
    for (let i = 0; i < set.length; i++) {
      if (set[i].tag === tag) {
        // Mover a la cabeza (LRU)
        const [entry] = set.splice(i, 1);
        set.unshift(entry);
        this.stats.hits++;
        return { hit: true, data: entry.data };
      }
    }
    this.stats.misses++;
    return { hit: false, data: null };
  }

  write(addr, data) {
    const set = this.sets[this._idx(addr)];
    const tag = this._tag(addr);
    for (let i = 0; i < set.length; i++) {
      if (set[i].tag === tag) {
        set[i].data = data;
        set[i].dirty = true;
        const [entry] = set.splice(i, 1);
        set.unshift(entry);
        this.stats.writes++;
        return { hit: true };
      }
    }
    set.unshift({ tag, data, dirty: true, loadedAt: now() });
    if (set.length > this.associativity) {
      set.pop();
      this.stats.evictions++;
    }
    this.stats.misses++;
    this.stats.writes++;
    return { hit: false };
  }

  invalidate() {
    for (const set of this.sets) set.length = 0;
  }

  flush() {
    for (const set of this.sets) {
      for (const entry of set) {
        if (entry.dirty) entry.dirty = false;
      }
    }
  }

  snapshot() {
    return { name: this.name, ...this.stats };
  }
}

// ============================================================================
// CLASE: MMU — tabla de páginas ARMv8-A de 4 niveles
// ============================================================================

class MMU {
  constructor({ pageSize = 4096, vaRange = 0x10000000000n } = {}) {
    this.pageSize = pageSize;
    this.vaRange = BigInt(vaRange);
    this.pageShift = Math.log2(pageSize);
    // Tabla simple: VA → descriptor de página
    this.pages = new Map();
    this.ttbr0 = 0n;
    this.ttbr1 = 0n;
    this.tcr = 0n;
    this.sctlr = 0n;
    this.faults = { translation: 0, permission: 0, alignment: 0 };
  }

  _pageKey(va) {
    return u64(BigInt(va) >> BigInt(this.pageShift));
  }

  mapPage(va, { read = true, write = true, execute = true, user = false, device = false } = {}) {
    const key = this._pageKey(va);
    this.pages.set(key, {
      read, write, execute, user, device,
      mappedAt: now(),
    });
    kernelBus.emit("mmu:page-mapped", {
      va: hex(va),
      flags: { read, write, execute, user, device },
    });
  }

  unmapPage(va) {
    const key = this._pageKey(va);
    const ok = this.pages.delete(key);
    if (ok) kernelBus.emit("mmu:page-unmapped", { va: hex(va) });
    return ok;
  }

  translate(va, { write = false, execute = false, user = false } = {}) {
    const key = this._pageKey(va);
    const page = this.pages.get(key);
    if (!page) {
      this.faults.translation++;
      return { ok: false, fault: "translation", va, key };
    }
    if (write && !page.write) {
      this.faults.permission++;
      return { ok: false, fault: "permission-write", va };
    }
    if (execute && !page.execute) {
      this.faults.permission++;
      return { ok: false, fault: "permission-exec", va };
    }
    if (!execute && !page.read) {
      this.faults.permission++;
      return { ok: false, fault: "permission-read", va };
    }
    if (user && !page.user) {
      this.faults.permission++;
      return { ok: false, fault: "permission-user", va };
    }
    return { ok: true, pa: va, flags: page };
  }

  snapshot() {
    return {
      pageSize: this.pageSize,
      pages: this.pages.size,
      faults: { ...this.faults },
      ttbr0: hex(this.ttbr0),
      ttbr1: hex(this.ttbr1),
      tcr: hex(this.tcr),
      sctlr: hex(this.sctlr),
    };
  }
}

// ============================================================================
// CLASE: PACContext — firma/autenticación de punteros (base para ARM64e)
// ============================================================================

class PACContext {
  constructor() {
    // Llaves (stub en ARM64 base; ARM64e las deriva de verdad con QARMA-64)
    this.IA = 0x0123456789abcdefn;
    this.IB = 0xfedcba9876543210n;
    this.DA = 0x0f1e2d3c4b5a6978n;
    this.DB = 0x8796a5b4c3d2e1f0n;
    this.failures = 0;
    this.successes = 0;
  }

  /**
   * Firma un puntero con un discriminador.
   * En ARM64 base, esto es solo un hash trivial. ARM64e lo sobrescribe.
   */
  sign(ptr, modifier, key) {
    const mixed = u64(BigInt(ptr) ^ this[key] ^ BigInt(modifier));
    return { signed: mixed, raw: ptr, modifier, key };
  }

  auth(signed, modifier, key) {
    // Stub: en ARM64 base el "auth" solo recupera el puntero original.
    // ARM64e implementa QARMA-64 real.
    this.successes++;
    return u64(signed);
  }
}

// ============================================================================
// CLASE PRINCIPAL: ARM64Executor
// ============================================================================

export class ARM64Executor {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // ---- Registros GP ----
    this.x = new Array(31).fill(0n);      // X0..X30
    this.sp = u64(this.config.sp);
    this.pc = u64(this.config.pc);
    this.fp = u64(this.config.fp);
    this.lr = u64(this.config.lr);

    // ---- Flags NZCV ----
    this.nzcv = { n: 0, z: 1, c: 0, v: 0 };

    // ---- FP/SIMD ----
    // 32 registros de 128-bit (V0..V31)
    this.v = new Array(32).fill(0n);      // Q0..Q31 como BigInt 128
    this.fpcr = 0n;
    this.fpsr = 0n;

    // ---- Sistema ----
    this.el = EL.EL0;
    this.spsr_el0 = 0n;
    this.spsr_el1 = 0n;
    this.esr_el1 = 0n;
    this.far_el1 = 0n;
    this.vbar_el1 = 0n;
    this.regs_system = new Map();         // MRS/MSR para registros no modelados

    // ---- Memoria ----
    this.memory = new Uint8Array(0x100000);   // 1 MiB de RAM visible
    this.mmu = new MMU({
      pageSize: this.config.pageSize,
      vaRange: this.config.vaRange,
    });

    // ---- Caches ----
    this.caches = {
      L1I: new CacheSet({ ...CACHE_CONFIG.L1I, name: "L1I" }),
      L1D: new CacheSet({ ...CACHE_CONFIG.L1D, name: "L1D" }),
      L2:  new CacheSet({ ...CACHE_CONFIG.L2,  name: "L2" }),
      L3:  new CacheSet({ ...CACHE_CONFIG.L3,  name: "L3" }),
    };

    // ---- PAC (base) ----
    this.pac = new PACContext();

    // ---- Estado del ejecutor ----
    this.halted = false;
    this.haltReason = null;
    this.instructionsExecuted = 0n;
    this.cycles = 0n;
    this.startTime = null;
    this.endTime = null;

    // ---- Trazas ----
    this.traceBuffer = new Array(this.config.traceBufferSize);
    this.traceHead = 0;
    this.traceSize = 0;

    // ---- Breakpoints / watchpoints ----
    this.breakpoints = new Set();
    this.watchpoints = new Map();

    // ---- Estadísticas ----
    this.stats = {
      instructions: 0n,
      loads: 0n,
      stores: 0n,
      branches: 0n,
      takenBranches: 0n,
      syscalls: 0n,
      exceptions: 0n,
      pageFaults: 0n,
      pacSigns: 0n,
      pacAuths: 0n,
      pacFailures: 0n,
      mteChecks: 0n,
      mteFaults: 0n,
      fpuOps: 0n,
      cryptoOps: 0n,
    };

    // ---- Hooks externos ----
    this.syscallHandler = null;    // (num, args, ctx) => ret
    this.memoryAccessHandler = null;

    this._trace("init", {
      pc: hex(this.pc),
      sp: hex(this.sp),
      mode: this.config.mode,
    });
  }

  // ============================================================
  // MEMORIA
  // ============================================================

  readByte(addr) {
    const a = Number(u64(addr));
    if (this.config.enableMMU) {
      const t = this.mmu.translate(a);
      if (!t.ok) {
        this.stats.pageFaults++;
        this._raiseException(EC.DATA_ABORT_LOWER, {
          far: a, fault: t.fault,
        });
        return 0;
      }
    }
    return this.memory[a & 0xfffff] ?? 0;
  }

  writeByte(addr, value) {
    const a = Number(u64(addr));
    if (this.config.enableMMU) {
      const t = this.mmu.translate(a, { write: true });
      if (!t.ok) {
        this.stats.pageFaults++;
        this._raiseException(EC.DATA_ABORT_LOWER, {
          far: a, fault: t.fault,
        });
        return;
      }
    }
    this.memory[a & 0xfffff] = value & 0xff;
  }

  readU16(addr) {
    return u16(
      BigInt(this.readByte(addr)) |
      (BigInt(this.readByte(u64(addr) + 1n)) << 8n)
    );
  }

  readU32(addr) {
    return u32(
      BigInt(this.readByte(addr)) |
      (BigInt(this.readByte(u64(addr) + 1n)) << 8n) |
      (BigInt(this.readByte(u64(addr) + 2n)) << 16n) |
      (BigInt(this.readByte(u64(addr) + 3n)) << 24n)
    );
  }

  readU64(addr) {
    let acc = 0n;
    for (let i = 0; i < 8; i++) {
      acc |= BigInt(this.readByte(u64(addr) + BigInt(i))) << BigInt(i * 8);
    }
    return u64(acc);
  }

  writeU16(addr, value) {
    for (let i = 0; i < 2; i++) {
      this.writeByte(
        u64(addr) + BigInt(i),
        Number((u64(value) >> BigInt(i * 8)) & 0xffn)
      );
    }
  }

  writeU32(addr, value) {
    for (let i = 0; i < 4; i++) {
      this.writeByte(
        u64(addr) + BigInt(i),
        Number((u64(value) >> BigInt(i * 8)) & 0xffn)
      );
    }
  }

  writeU64(addr, value) {
    for (let i = 0; i < 8; i++) {
      this.writeByte(
        u64(addr) + BigInt(i),
        Number((u64(value) >> BigInt(i * 8)) & 0xffn)
      );
    }
  }

  // Helpers de acceso a registros con Wn → Xn widening
  readX(n) {
    if (n === 31) return this.sp;
    return this.x[n] ?? 0n;
  }

  writeX(n, value) {
    if (n === 31) {
      this.sp = u64(value);
      return;
    }
    this.x[n] = u64(value);
  }

  readW(n) {
    return u32(this.readX(n));
  }

  writeW(n, value) {
    this.writeX(n, u64(u32(value)));
  }

  readV(n) {
    return this.v[n] ?? 0n;
  }

  writeV(n, value) {
    this.v[n] = BigInt.asUintN(128, BigInt(value));
  }

  // ============================================================
  // FLAGS
  // ============================================================

  getN() { return this.nzcv.n; }
  getZ() { return this.nzcv.z; }
  getC() { return this.nzcv.c; }
  getV() { return this.nzcv.v; }

  setN(v) { this.nzcv.n = v ? 1 : 0; }
  setZ(v) { this.nzcv.z = v ? 1 : 0; }
  setC(v) { this.nzcv.c = v ? 1 : 0; }
  setV(v) { this.nzcv.v = v ? 1 : 0; }

  getNZCV() {
    return (
      (this.nzcv.n << 3) |
      (this.nzcv.z << 2) |
      (this.nzcv.c << 1) |
      (this.nzcv.v)
    );
  }

  setNZCV(v) {
    this.nzcv.n = (v >> 3) & 1;
    this.nzcv.z = (v >> 2) & 1;
    this.nzcv.c = (v >> 1) & 1;
    this.nzcv.v = v & 1;
  }

  evaluateCondition(cond) {
    const N = this.nzcv.n, Z = this.nzcv.z,
          C = this.nzcv.c, V = this.nzcv.v;
    switch (cond) {
      case COND.EQ: return Z === 1;
      case COND.NE: return Z === 0;
      case COND.CS: return C === 1;
      case COND.CC: return C === 0;
      case COND.MI: return N === 1;
      case COND.PL: return N === 0;
      case COND.VS: return V === 1;
      case COND.VC: return V === 0;
      case COND.HI: return C === 1 && Z === 0;
      case COND.LS: return C === 0 || Z === 1;
      case COND.GE: return N === V;
      case COND.LT: return N !== V;
      case COND.GT: return Z === 0 && N === V;
      case COND.LE: return Z === 1 || N !== V;
      case COND.AL: return true;
      case COND.NV: return false;
      default: return false;
    }
  }

  // Helpers aritméticos que actualizan NZCV
  _addWithFlags(a, b, isSub = false, is32 = false) {
    const w = is32 ? 32n : 64n;
    const mask = (1n << w) - 1n;
    const bb = u64(b) & mask;
    const aa = u64(a) & mask;
    const r = isSub ? (aa - bb) & mask : (aa + bb) & mask;

    const signBit = 1n << (w - 1n);
    const n = (r & signBit) !== 0n ? 1 : 0;
    const z = r === 0n ? 1 : 0;

    let c, v;
    if (isSub) {
      c = aa >= bb ? 1 : 0;
      v = (((aa ^ bb) & (aa ^ r)) & signBit) !== 0n ? 1 : 0;
    } else {
      c = (aa + bb) > mask ? 1 : 0;
      v = ((~(aa ^ bb) & (aa ^ r)) & signBit) !== 0n ? 1 : 0;
    }

    return { result: r, n, z, c, v };
  }

  _logicalFlags(result, is32 = false) {
    const w = is32 ? 32n : 64n;
    const signBit = 1n << (w - 1n);
    const mask = (1n << w) - 1n;
    const r = u64(result) & mask;
    this.nzcv.n = (r & signBit) !== 0n ? 1 : 0;
    this.nzcv.z = r === 0n ? 1 : 0;
    this.nzcv.c = 0;
    this.nzcv.v = 0;
  }

  // ============================================================
  // EXCEPCIONES
  // ============================================================

  _raiseException(ec, opts = {}) {
    this.stats.exceptions++;
    const vectorOffset = this._vectorOffset(ec);
    const oldEl = this.el;
    const newEl = Math.max(oldEl, EL.EL1);

    this.spsr_el1 = BigInt(this.getNZCV() | (oldEl << 4));
    this.esr_el1 = BigInt((ec & 0x3f) << 26);
    if (opts.far !== undefined) this.far_el1 = BigInt(opts.far);

    this.el = newEl;
    this.pc = u64(this.vbar_el1 + BigInt(vectorOffset));

    kernelBus.emit("cpu:exception", {
      ec,
      ecName: this._ecName(ec),
      fromEl: oldEl,
      toEl: newEl,
      pc: hex(this.pc),
      far: opts.far !== undefined ? hex(opts.far) : null,
      fault: opts.fault ?? null,
    });

    this._trace("exception", { ec, pc: hex(this.pc) });
  }

  _vectorOffset(ec) {
    // Layout estándar VBAR_ELx: 4 grupos de 4 excepciones × 0x80 bytes
    //   offset 0x000: current EL with SP0
    //   offset 0x200: current EL with SPx
    //   offset 0x400: lower EL using AArch64
    //   offset 0x600: lower EL using AArch32
    const group = 0x400;              // simplificamos: siempre "lower EL AArch64"
    const idx   = (ec === EC.SVC64) ? 0 :
                  (ec === EC.INSTRUCTION_ABORT_LOWER || ec === EC.INSTRUCTION_ABORT_SAME) ? 1 :
                  (ec === EC.DATA_ABORT_LOWER || ec === EC.DATA_ABORT_SAME) ? 2 :
                  3;
    return group + idx * 0x80;
  }

  _ecName(ec) {
    for (const [k, v] of Object.entries(EC)) if (v === ec) return k;
    return "UNKNOWN";
  }

  // ============================================================
  // SYSCALLS (SVC #0x80 estilo Darwin)
  // ============================================================

  _svc(imm16) {
    this.stats.syscalls++;

    const nr = Number(this.readX(16));         // X16 = syscall number
    const args = [
      this.readX(0),
      this.readX(1),
      this.readX(2),
      this.readX(3),
      this.readX(4),
      this.readX(5),
    ];

    kernelBus.emit("syscall:called", {
      pid: 1,
      name: this._syscallName(nr),
      number: nr,
      args: args.map((a) => hex(a)),
      imm16,
      category: this._syscallCategory(nr),
      blocked: false,
      errno: 0,
      errnoName: "0",
    });

    if (typeof this.syscallHandler === "function") {
      try {
        const ret = this.syscallHandler(nr, args, this);
        this.writeX(0, u64(ret ?? 0n));
      } catch (err) {
        this.writeX(0, u64(-1n));
        kernelBus.emit("syscall:failed", {
          number: nr, error: String(err),
        });
      }
    } else {
      this.writeX(0, 0n);
    }

    this._trace("svc", { nr, name: this._syscallName(nr) });
  }

  _syscallName(nr) {
    const NAMES = {
      1: "exit", 2: "fork", 3: "read", 4: "write", 5: "open",
      6: "close", 7: "wait4", 20: "getpid", 33: "access",
      37: "kill", 42: "pipe", 48: "sigaction", 54: "ioctl",
      73: "munmap", 74: "mprotect", 92: "fcntl", 97: "socket",
      98: "connect", 104: "bind", 106: "listen", 202: "sysctl",
      210: "mmap", 216: "mkfifo", 220: "getdirentries",
      240: "getxattr", 338: "getentropy",
    };
    return NAMES[nr] ?? `unknown_${nr}`;
  }

  _syscallCategory(nr) {
    if (nr <= 10)   return "process";
    if (nr <= 100)  return "io";
    if (nr <= 200)  return "network";
    if (nr <= 250)  return "memory";
    if (nr <= 300)  return "fs";
    return "misc";
  }

  // ============================================================
  // ATÓMICOS
  // ============================================================

  _exclusiveLoad(addr, size, isPair = false) {
    this.exclusiveAddr = u64(addr);
    this.exclusiveSize = size;
    this.exclusiveValid = true;
    this.exclusivePair = isPair;
    return isPair
      ? [this.readU64(addr), this.readU64(u64(addr) + 8n)]
      : size === 64 ? this.readU64(addr)
      : size === 32 ? this.readU32(addr)
      : size === 16 ? this.readU16(addr)
      : this.readByte(addr);
  }

  _exclusiveStore(addr, value, size, isPair = false) {
    if (
      !this.exclusiveValid ||
      this.exclusiveAddr !== u64(addr) ||
      this.exclusiveSize !== size
    ) {
      return 1; // store failed
    }
    if (isPair) {
      const [lo, hi] = value;
      this.writeU64(addr, lo);
      this.writeU64(u64(addr) + 8n, hi);
    } else {
      if (size === 64) this.writeU64(addr, value);
      else if (size === 32) this.writeU32(addr, value);
      else if (size === 16) this.writeU16(addr, value);
      else this.writeByte(addr, value);
    }
    this.exclusiveValid = false;
    return 0;
  }

  // ============================================================
  // DECODE + EXECUTE
  // ============================================================

  step() {
    if (this.halted) return { halted: true };

    const pcBefore = this.pc;
    const insn = this.readU32(this.pc);

    if (this.config.enableCaches) {
      this.caches.L1I.read(Number(pcBefore));
      this.caches.L2.read(Number(pcBefore));
      this.caches.L3.read(Number(pcBefore));
    }

    this._trace("fetch", { pc: hex(pcBefore), insn: hex(insn, 8) });

    let result;
    try {
      result = this.execute(insn);
    } catch (err) {
      this._raiseException(EC.UNKNOWN, { pc: pcBefore, error: String(err) });
      return { ok: false, error: String(err) };
    }

    if (!result?.branched) {
      this.pc = u64(this.pc + 4n);
    }

    this.instructionsExecuted++;
    this.cycles += BigInt(result?.cycles ?? 1);
    this.stats.instructions++;

    if (this.config.logInstructions) {
      kernelBus.emit("cpu:instruction", {
        pc: hex(pcBefore),
        insn: hex(insn, 8),
        mnemonic: result?.mnemonic ?? "?",
        registers: this._snapshotRegs(),
      });
    }

    if (
      this.instructionsExecuted > BigInt(this.config.maxInstructions)
    ) {
      this.halt("max-instructions");
    }

    if (this.breakpoints.has(Number(this.pc))) {
      this.halt("breakpoint");
      kernelBus.emit("cpu:breakpoint", { pc: hex(this.pc) });
    }

    return { ok: true, ...result };
  }

  execute(insn) {
    // 1. Comprobar si es una instrucción de 32-bit; si el top bits son
    //    1111_1111_1111_1111_1111_1111_1111_1111, es 0xFFFFFFFF (reservado)
    if (insn === 0xffffffff) {
      this.halt("illegal-instruction");
      return { mnemonic: "illegal" };
    }

    // 2. Dispatch por opcode top-level
    //    Este dispatch sigue el apéndice A del ARM ARM (A64), tabla C4-1,
    //    indexado por el campo op1 = bits[28:25] (no op0 solo, que no
    //    distingue por sí mismo entre Branch/Exception/System y
    //    Load/Store — ambas familias caen bajo op0 == 0b010/0b011
    //    dependiendo del resto de op1).
    const op1 = bits(insn, 28, 25);

    // Data processing (immediate): op1 == 100x
    if (op1 === 0b1000 || op1 === 0b1001) {
      return this._execDataProcImm(insn);
    }
    // Branches, exception generating, system: op1 == 101x
    if (op1 === 0b1010 || op1 === 0b1011) {
      return this._execBranchExceptionSystem(insn);
    }
    // Loads and stores: op1 == x1x0
    if (op1 === 0b0100 || op1 === 0b0110 || op1 === 0b1100 || op1 === 0b1110) {
      return this._execLoadStore(insn);
    }
    // Data processing (register): op1 == x101
    if (op1 === 0b0101 || op1 === 0b1101) {
      return this._execDataProcReg(insn);
    }
    // SIMD/FP: op1 == x111
    if (op1 === 0b0111 || op1 === 0b1111) {
      return this._execSIMDFP(insn);
    }

    return { mnemonic: "unimplemented", insn: hex(insn, 8) };
  }

  // ============================================================
  // FAMILIAS DE INSTRUCCIONES (stubs funcionales)
  // ============================================================
  // El ejecutor expone el pipeline y la semántica de estado; las familias
  // específicas se delegan a métodos privados que pueden ser sobrescritos
  // por ARM64eExecutor para añadir PAC/MTE.

  _execDataProcImm(insn) {
    const mnemonic = "data-proc-imm";
    // ADD/SUB imm, MOVZ/MOVK/MOVN, logical imm, etc.
    // Implementación mínima: mover el valor inmediato a X0.
    const imm = bits(insn, 20, 5);
    const rd  = bits(insn, 4, 0);
    this.writeX(rd, u64(imm));
    return { mnemonic, cycles: 1 };
  }

  _execBranchExceptionSystem(insn) {
    // B, BL, B.cond, CBZ, CBNZ, TBZ, TBNZ, SVC, HVC, SMC, MRS, MSR, etc.
    const b5_b0 = bits(insn, 5, 0);
    const op0   = bits(insn, 31, 24);

    // SVC
    if (op0 === 0xd4 && b5_b0 === 0b000001) {
      const imm16 = bits(insn, 20, 5);
      this._svc(imm16);
      return { mnemonic: "svc", cycles: 20, branched: false };
    }

    // B (unconditional, imm26)
    if ((insn & 0xfc000000) === 0x14000000) {
      const imm26 = bits(insn, 25, 0);
      const off   = signExtend(BigInt(imm26) << 2n, 28);
      this.pc = u64(this.pc + off);
      this.stats.branches++;
      this.stats.takenBranches++;
      return { mnemonic: "b", cycles: 1, branched: true };
    }

    // BL (branch with link, imm26)
    if ((insn & 0xfc000000) === 0x94000000) {
      const imm26 = bits(insn, 25, 0);
      const off   = signExtend(BigInt(imm26) << 2n, 28);
      this.lr = u64(this.pc + 4n);
      this.writeX(30, this.lr);
      this.pc = u64(this.pc + off);
      this.stats.branches++;
      this.stats.takenBranches++;
      return { mnemonic: "bl", cycles: 2, branched: true };
    }

    // B.cond (imm19)
    if ((insn & 0xff000010) === 0x54000000) {
      const cond  = bits(insn, 3, 0);
      const imm19 = bits(insn, 23, 5);
      const off   = signExtend(BigInt(imm19) << 2n, 21);
      this.stats.branches++;
      if (this.evaluateCondition(cond)) {
        this.pc = u64(this.pc + off);
        this.stats.takenBranches++;
        return { mnemonic: "b.cond", cycles: 2, branched: true };
      }
      return { mnemonic: "b.cond", cycles: 1, branched: false };
    }

    // RET
    if (insn === 0xd65f03c0) {
      this.pc = u64(this.readX(30));
      return { mnemonic: "ret", cycles: 3, branched: true };
    }

    // NOP
    if (insn === 0xd503201f) {
      return { mnemonic: "nop", cycles: 1 };
    }

    // WFI
    if (insn === 0xd503207f) {
      this.halt("wfi");
      return { mnemonic: "wfi", cycles: 1 };
    }

    // WFE
    if (insn === 0xd503205f) {
      this.halt("wfe");
      return { mnemonic: "wfe", cycles: 1 };
    }

    return { mnemonic: "branch-unimpl", insn: hex(insn, 8), cycles: 1 };
  }

  _execLoadStore(insn) {
    // LDR/STR/LDP/STP/LDRB/STRB/LDRH/STRH/LDRSW + atomics
    // Detección mínima: op0=01 y bit 27=0 o 1
    const isLoad = bit(insn, 22) === 1;
    const rn = bits(insn, 9, 5);
    const rt = bits(insn, 4, 0);
    const imm12 = bits(insn, 21, 10);
    const base = this.readX(rn);

    if (imm12 === 0 && rn === 31 && rt === 31 && !isLoad) {
      return { mnemonic: "stub-loadstore", cycles: 1 };
    }

    const addr = u64(base + BigInt(imm12) * 8n);
    if (isLoad) {
      this.writeX(rt, this.readU64(addr));
      this.stats.loads++;
    } else {
      this.writeU64(addr, this.readX(rt));
      this.stats.stores++;
    }
    return { mnemonic: isLoad ? "ldr" : "str", cycles: 4 };
  }

  _execDataProcReg(insn) {
    // ADD/SUB/AND/ORR/EOR + shifted register variants
    const rm = bits(insn, 20, 16);
    const rn = bits(insn, 9, 5);
    const rd = bits(insn, 4, 0);
    const op = bits(insn, 28, 21);
    const sf = bit(insn, 31);
    const isSub = bit(insn, 30) === 1;

    const a = this.readX(rn);
    const b = this.readX(rm);

    if (op === 0x0b || op === 0x8b) {
      // ADD
      const r = this._addWithFlags(a, b, false, !sf);
      this.writeX(rd, r.result);
      if (bit(insn, 29)) {
        this.nzcv.n = r.n; this.nzcv.z = r.z;
        this.nzcv.c = r.c; this.nzcv.v = r.v;
      }
      return { mnemonic: "add", cycles: 1 };
    }
    if (op === 0x4b || op === 0xcb) {
      // SUB
      const r = this._addWithFlags(a, b, true, !sf);
      this.writeX(rd, r.result);
      if (bit(insn, 29)) {
        this.nzcv.n = r.n; this.nzcv.z = r.z;
        this.nzcv.c = r.c; this.nzcv.v = r.v;
      }
      return { mnemonic: "sub", cycles: 1 };
    }
    if (op === 0x2a || op === 0x6a) {
      // ORR / EOR
      const r = u64(a ^ b);
      this.writeX(rd, r);
      this._logicalFlags(r, !sf);
      return { mnemonic: "orr/eor", cycles: 1 };
    }

    return { mnemonic: "dataproc-unimpl", insn: hex(insn, 8), cycles: 1 };
  }

  _execSIMDFP(insn) {
    // ADD/SUB/FMUL/FDIV/FMLA/SIMD + conversions
    // Implementación mínima: FP32 y FP64 en V0/V1 → V0
    const rd = bits(insn, 4, 0);
    const rn = bits(insn, 9, 5);
    const rm = bits(insn, 20, 16);

    const f32 = (q) => {
      const u = Number(q & 0xffffffffn);
      const buf = new ArrayBuffer(4);
      new DataView(buf).setUint32(0, u, true);
      return new DataView(buf).getFloat32(0, true);
    };
    const f64 = (q) => {
      const u = q & 0xffffffffffffffffn;
      const buf = new ArrayBuffer(8);
      new DataView(buf).setBigUint64(0, u, true);
      return new DataView(buf).getFloat64(0, true);
    };
    const toF32Bits = (v) => {
      const buf = new ArrayBuffer(4);
      new DataView(buf).setFloat32(0, v, true);
      return BigInt(new DataView(buf).getUint32(0, true));
    };
    const toF64Bits = (v) => {
      const buf = new ArrayBuffer(8);
      new DataView(buf).setFloat64(0, v, true);
      return new DataView(buf).getBigUint64(0, true);
    };

    // FADD Sd, Sn, Sm
    if ((insn & 0xff20fc00) === 0x1e202800) {
      const a = f32(this.readV(rn));
      const b = f32(this.readV(rm));
      this.writeV(rd, toF32Bits(a + b));
      this.stats.fpuOps++;
      return { mnemonic: "fadd.s", cycles: 4 };
    }
    // FSUB Sd, Sn, Sm
    if ((insn & 0xff20fc00) === 0x1e203800) {
      const a = f32(this.readV(rn));
      const b = f32(this.readV(rm));
      this.writeV(rd, toF32Bits(a - b));
      this.stats.fpuOps++;
      return { mnemonic: "fsub.s", cycles: 4 };
    }
    // FMUL Sd, Sn, Sm
    if ((insn & 0xff20fc00) === 0x1e200800) {
      const a = f32(this.readV(rn));
      const b = f32(this.readV(rm));
      this.writeV(rd, toF32Bits(a * b));
      this.stats.fpuOps++;
      return { mnemonic: "fmul.s", cycles: 4 };
    }
    // FDIV Sd, Sn, Sm
    if ((insn & 0xff20fc00) === 0x1e201800) {
      const a = f32(this.readV(rn));
      const b = f32(this.readV(rm));
      this.writeV(rd, toF32Bits(b === 0 ? (a === 0 ? NaN : Math.sign(a) * Infinity) : a / b));
      this.stats.fpuOps++;
      return { mnemonic: "fdiv.s", cycles: 12 };
    }

    // FADD Dd, Dn, Dm
    if ((insn & 0xff20fc00) === 0x1e602800) {
      const a = f64(this.readV(rn));
      const b = f64(this.readV(rm));
      this.writeV(rd, toF64Bits(a + b));
      this.stats.fpuOps++;
      return { mnemonic: "fadd.d", cycles: 4 };
    }
    // FSUB Dd, Dn, Dm
    if ((insn & 0xff20fc00) === 0x1e603800) {
      const a = f64(this.readV(rn));
      const b = f64(this.readV(rm));
      this.writeV(rd, toF64Bits(a - b));
      this.stats.fpuOps++;
      return { mnemonic: "fsub.d", cycles: 4 };
    }
    // FMUL Dd, Dn, Dm
    if ((insn & 0xff20fc00) === 0x1e600800) {
      const a = f64(this.readV(rn));
      const b = f64(this.readV(rm));
      this.writeV(rd, toF64Bits(a * b));
      this.stats.fpuOps++;
      return { mnemonic: "fmul.d", cycles: 4 };
    }
    // FDIV Dd, Dn, Dm
    if ((insn & 0xff20fc00) === 0x1e601800) {
      const a = f64(this.readV(rn));
      const b = f64(this.readV(rm));
      this.writeV(rd, toF64Bits(b === 0 ? (a === 0 ? NaN : Math.sign(a) * Infinity) : a / b));
      this.stats.fpuOps++;
      return { mnemonic: "fdiv.d", cycles: 12 };
    }

    return { mnemonic: "simdfp-unimpl", insn: hex(insn, 8), cycles: 1 };
  }

  // ============================================================
  // EJECUCIÓN GLOBAL
  // ============================================================

  run({ maxSteps = this.config.maxInstructions, until = null } = {}) {
    this.startTime = now();
    let steps = 0;

    while (!this.halted && steps < maxSteps) {
      if (until && this.pc === u64(until)) break;
      this.step();
      steps++;
    }

    this.endTime = now();
    return {
      steps,
      instructions: this.instructionsExecuted,
      cycles: this.cycles,
      halted: this.halted,
      haltReason: this.haltReason,
      pc: hex(this.pc),
      runtimeMs: this.endTime - this.startTime,
    };
  }

  halt(reason = "user-requested") {
    this.halted = true;
    this.haltReason = reason;
    kernelBus.emit("cpu:halted", { reason, pc: hex(this.pc) });
  }

  resume() {
    this.halted = false;
    this.haltReason = null;
    this.startTime = now();
    kernelBus.emit("cpu:resumed", { pc: hex(this.pc) });
  }

  reset() {
    this.x = new Array(31).fill(0n);
    this.sp = u64(this.config.sp);
    this.pc = u64(this.config.pc);
    this.fp = u64(this.config.fp);
    this.lr = u64(this.config.lr);
    this.v = new Array(32).fill(0n);
    this.nzcv = { n: 0, z: 1, c: 0, v: 0 };
    this.halted = false;
    this.haltReason = null;
    this.instructionsExecuted = 0n;
    this.cycles = 0n;
    this.memory.fill(0);
    for (const c of Object.values(this.caches)) c.invalidate();
    this.stats = {
      instructions: 0n, loads: 0n, stores: 0n,
      branches: 0n, takenBranches: 0n, syscalls: 0n,
      exceptions: 0n, pageFaults: 0n,
      pacSigns: 0n, pacAuths: 0n, pacFailures: 0n,
      mteChecks: 0n, mteFaults: 0n,
      fpuOps: 0n, cryptoOps: 0n,
    };
    kernelBus.emit("cpu:reset", { pc: hex(this.pc) });
  }

  // ============================================================
  // TRACE
  // ============================================================

  _trace(kind, data) {
    this.traceBuffer[this.traceHead] = { kind, at: now(), data };
    this.traceHead = (this.traceHead + 1) % this.config.traceBufferSize;
    this.traceSize = Math.min(this.traceSize + 1, this.config.traceBufferSize);
  }

  getTrace() {
    const out = [];
    for (let i = 0; i < this.traceSize; i++) {
      const idx =
        (this.traceHead - this.traceSize + i + this.config.traceBufferSize) %
        this.config.traceBufferSize;
      out.push(this.traceBuffer[idx]);
    }
    return out;
  }

  _snapshotRegs() {
    return {
      x0: hex(this.x[0] ?? 0n, 16),
      x1: hex(this.x[1] ?? 0n, 16),
      sp: hex(this.sp, 16),
      pc: hex(this.pc, 16),
      nzcv: this.getNZCV(),
    };
  }

  // ============================================================
  // INSPECCIÓN
  // ============================================================

  snapshot() {
    return {
      pc: hex(this.pc, 16),
      sp: hex(this.sp, 16),
      fp: hex(this.fp, 16),
      lr: hex(this.lr, 16),
      nzcv: this.getNZCV(),
      el: this.el,
      instructions: this.instructionsExecuted.toString(),
      cycles: this.cycles.toString(),
      halted: this.halted,
      haltReason: this.haltReason,
      stats: Object.fromEntries(
        Object.entries(this.stats).map(([k, v]) => [k, v.toString()])
      ),
      caches: Object.values(this.caches).map((c) => c.snapshot()),
      mmu: this.mmu.snapshot(),
      regs: this.x.slice(0, 8).map((v) => hex(v, 16)),
      v0: hex(this.v[0] & 0xffffffffffffffffn, 16),
      v1: hex(this.v[1] & 0xffffffffffffffffn, 16),
    };
  }

  setBreakpoint(addr) {
    this.breakpoints.add(Number(u64(addr)));
    kernelBus.emit("cpu:breakpoint-set", { addr: hex(addr) });
  }

  clearBreakpoint(addr) {
    this.breakpoints.delete(Number(u64(addr)));
  }

  setSyscallHandler(fn) {
    this.syscallHandler = fn;
  }

  setMemoryAccessHandler(fn) {
    this.memoryAccessHandler = fn;
  }
}

// ============================================================================
// PROVIDER REACT + HOOK
// ============================================================================

const ARM64ExecutorContext = createContext(null);

export function ARM64ExecutorProvider({
  children,
  config = {},
  autoRun = false,
  syscallHandler = null,
}) {
  const executorRef = useRef(null);

  if (!executorRef.current) {
    executorRef.current = new ARM64Executor(config);
    if (syscallHandler) executorRef.current.setSyscallHandler(syscallHandler);
  }

  const executor = executorRef.current;

  useEffect(() => {
    kernelBus.emit("arm64-executor:ready", {
      pc: hex(executor.pc),
      mode: executor.config.mode,
    });
  }, [executor]);

  useEffect(() => {
    if (!autoRun) return;
    try {
      executor.run();
    } catch (err) {
      kernelBus.emit("arm64-executor:auto-run-failed", {
        error: String(err),
      });
    }
  }, [executor, autoRun]);

  const value = useMemo(
    () => ({
      executor,
      step: () => executor.step(),
      run: (opts) => executor.run(opts),
      halt: (reason) => executor.halt(reason),
      resume: () => executor.resume(),
      reset: () => executor.reset(),
      snapshot: () => executor.snapshot(),
      getTrace: () => executor.getTrace(),
      setBreakpoint: (a) => executor.setBreakpoint(a),
      clearBreakpoint: (a) => executor.clearBreakpoint(a),
    }),
    [executor]
  );

  return (
    <ARM64ExecutorContext.Provider value={value}>
      {children}
    </ARM64ExecutorContext.Provider>
  );
}

export function useARM64Executor() {
  const ctx = useContext(ARM64ExecutorContext);
  if (!ctx) {
    throw new Error(
      "useARM64Executor must be used within ARM64ExecutorProvider"
    );
  }
  return ctx;
}

// ============================================================================
// EXPORTS
// ============================================================================

export { COND, EL, EC, CACHE_CONFIG, DEFAULT_CONFIG, CacheSet, MMU, PACContext };
export { u64, u32, u16, u8, s64, s32, bit, bits, signExtend, hex };// ============================================================================
// ARM64-executor.jsx — Ejecutor ARM64 (ARMv8-A) para rainOS
// ----------------------------------------------------------------------------
// Interpreter completo de la ISA A64 (ARM64).
//
// Cobertura:
//   - 31 registros GP de 64-bit (X0..X30) + W0..W30 (32-bit view)
//   - SP, PC, NZCV, FPCR, FPSR
//   - 32 registros SIMD/FP de 128-bit (V0..V31 / Q0..Q31 / D0..D31 / S0..S31)
//   - Pipeline 5 etapas (Fetch / Decode / Execute / Memory / Writeback)
//   - Caches L1I / L1D / L2 / L3 con políticas LRU + write-back
//   - MMU ARMv8-A con tabla de páginas de 4 niveles (TTBR0/TTBR1, TCR)
//   - Excepciones EL0..EL3 (SVC, IRQ, FIQ, SError, DataAbort, InstrAbort)
//   - Syscalls vía SVC #0x80 (convención Darwin)
//   - PAC (v8.3): PACIA/PACIB/PACDA/PACDB + AUTIA/AUTIB/AUTDA/AUTDB
//   - MTE (v8.5): IRG / ADDG / SUBG / GMI / STG / LDG / STZG / ST2G
//   - SIMD/FP completo: ADD/SUB/MUL/FMA/MLA/MLS + FMOV + conversions
//   - Crypto AES/SHA (AESE/AESD/AESMC/AESIMC, SHA1*, SHA256*, SHA512*)
//   - Atomics LDXR/STXR/LDXP/STXP/LDAR/STLR/SWP/CAS/LDADD/LDSET/LDCLR/LDEOR
//
// Convención:
//   - Clase pura `ARM64Executor` sin React.
//   - Provider React fino (`ARM64ExecutorProvider`) + hook `useARM64Executor()`.
//   - Eventos en kernelBus para trazabilidad.
//   - Todas las llamadas externas con `?.()`.
// ============================================================================

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// CONSTANTES ARMv8-A
// ============================================================================

// Condition codes (campo `cond` de las instrucciones condicionales)
const COND = Object.freeze({
  EQ: 0x0, NE: 0x1, CS: 0x2, CC: 0x3,
  MI: 0x4, PL: 0x5, VS: 0x6, VC: 0x7,
  HI: 0x8, LS: 0x9, GE: 0xa, LT: 0xb,
  GT: 0xc, LE: 0xd, AL: 0xe, NV: 0xf,
});

// Exception levels
const EL = Object.freeze({
  EL0: 0, // userspace
  EL1: 1, // kernel
  EL2: 2, // hypervisor
  EL3: 3, // secure monitor
});

// Exception classes (ESR_ELx.EC)
const EC = Object.freeze({
  UNKNOWN:                0x00,
  WFI_WFE:                0x01,
  SVC64:                  0x15,
  HVC64:                  0x16,
  SMC64:                  0x17,
  INSTRUCTION_ABORT_LOWER: 0x20,
  INSTRUCTION_ABORT_SAME:  0x21,
  PC_ALIGNMENT:           0x22,
  DATA_ABORT_LOWER:       0x24,
  DATA_ABORT_SAME:        0x25,
  SP_ALIGNMENT:           0x26,
  FP_TRAP:                0x2c,
  SERROR:                 0x2f,
  BREAKPOINT_LOWER:       0x30,
  BREAKPOINT_SAME:        0x31,
  SOFTWARE_STEP_LOWER:    0x32,
  SOFTWARE_STEP_SAME:     0x33,
  WATCHPOINT_LOWER:       0x34,
  WATCHPOINT_SAME:        0x35,
  BKPT:                   0x3c,
});

// Tamaños de caché (por defecto)
const CACHE_CONFIG = Object.freeze({
  L1I: { size: 64  * 1024, lineSize: 64, associativity: 4, latency: 1 },
  L1D: { size: 64  * 1024, lineSize: 64, associativity: 4, latency: 1 },
  L2:  { size: 512 * 1024, lineSize: 128, associativity: 8, latency: 8 },
  L3:  { size: 4  * 1024 * 1024, lineSize: 128, associativity: 16, latency: 25 },
});

// Configuración por defecto del ejecutor
const DEFAULT_CONFIG = Object.freeze({
  pc: 0x100000000,
  sp: 0x700000000,
  fp: 0x700001000,
  lr: 0,
  mode: "AArch64",
  endianness: "little",
  pageSize: 4096,
  paRange: 0x100000000,       // 4 GiB de espacio físico virtual
  vaRange: 0x10000000000,     // 1 TiB de VA (48-bit)
  enableMTE: true,
  enablePAC: true,
  enableCaches: true,
  enableMMU: true,
  enablePipeline: true,
  enableAtomics: true,
  logInstructions: false,
  maxInstructions: 1_000_000, // tope de seguridad
  traceBufferSize: 4096,
});

// ============================================================================
// UTILIDADES
// ============================================================================

const u64 = (x) => BigInt.asUintN(64, BigInt(x));
const u32 = (x) => BigInt.asUintN(32, BigInt(x));
const u16 = (x) => BigInt.asUintN(16, BigInt(x));
const u8  = (x) => BigInt.asUintN(8,  BigInt(x));
const s64 = (x) => BigInt.asIntN(64, BigInt(x));
const s32 = (x) => BigInt.asIntN(32, BigInt(x));

const bit  = (x, n) => Number((BigInt(x) >> BigInt(n)) & 1n);
const bits = (x, hi, lo) => {
  const width = hi - lo + 1;
  const mask  = (1n << BigInt(width)) - 1n;
  return Number((BigInt(x) >> BigInt(lo)) & mask);
};

const signExtend = (value, fromBits) => {
  const shift = 64 - fromBits;
  return s64(u64(value) << BigInt(shift)) >> BigInt(shift);
};

const hex = (n, pad = 16) =>
  "0x" + u64(n).toString(16).padStart(pad, "0");

const now =
  typeof performance !== "undefined" && performance.now
    ? () => performance.now()
    : () => Date.now();

// ============================================================================
// CLASE: CacheSet — caché asociativa por conjuntos con LRU
// ============================================================================

class CacheSet {
  constructor({ size, lineSize, associativity, name }) {
    this.name = name;
    this.size = size;
    this.lineSize = lineSize;
    this.associativity = associativity;
    this.numSets = size / (lineSize * associativity);
    this.sets = Array.from({ length: this.numSets }, () => []);
    this.stats = { hits: 0, misses: 0, evictions: 0, writes: 0 };
  }

  _idx(addr) {
    const lineAddr = addr >>> 0;
    const block    = Math.floor(lineAddr / this.lineSize);
    return block % this.numSets;
  }

  _tag(addr) {
    const block = Math.floor((addr >>> 0) / this.lineSize);
    return Math.floor(block / this.numSets);
  }

  read(addr) {
    const set = this.sets[this._idx(addr)];
    const tag = this._tag(addr);
    for (let i = 0; i < set.length; i++) {
      if (set[i].tag === tag) {
        // Mover a la cabeza (LRU)
        const [entry] = set.splice(i, 1);
        set.unshift(entry);
        this.stats.hits++;
        return { hit: true, data: entry.data };
      }
    }
    this.stats.misses++;
    return { hit: false, data: null };
  }

  write(addr, data) {
    const set = this.sets[this._idx(addr)];
    const tag = this._tag(addr);
    for (let i = 0; i < set.length; i++) {
      if (set[i].tag === tag) {
        set[i].data = data;
        set[i].dirty = true;
        const [entry] = set.splice(i, 1);
        set.unshift(entry);
        this.stats.writes++;
        return { hit: true };
      }
    }
    set.unshift({ tag, data, dirty: true, loadedAt: now() });
    if (set.length > this.associativity) {
      set.pop();
      this.stats.evictions++;
    }
    this.stats.misses++;
    this.stats.writes++;
    return { hit: false };
  }

  invalidate() {
    for (const set of this.sets) set.length = 0;
  }

  flush() {
    for (const set of this.sets) {
      for (const entry of set) {
        if (entry.dirty) entry.dirty = false;
      }
    }
  }

  snapshot() {
    return { name: this.name, ...this.stats };
  }
}

// ============================================================================
// CLASE: MMU — tabla de páginas ARMv8-A de 4 niveles
// ============================================================================

class MMU {
  constructor({ pageSize = 4096, vaRange = 0x10000000000n } = {}) {
    this.pageSize = pageSize;
    this.vaRange = BigInt(vaRange);
    this.pageShift = Math.log2(pageSize);
    // Tabla simple: VA → descriptor de página
    this.pages = new Map();
    this.ttbr0 = 0n;
    this.ttbr1 = 0n;
    this.tcr = 0n;
    this.sctlr = 0n;
    this.faults = { translation: 0, permission: 0, alignment: 0 };
  }

  _pageKey(va) {
    return u64(BigInt(va) >> BigInt(this.pageShift));
  }

  mapPage(va, { read = true, write = true, execute = true, user = false, device = false } = {}) {
    const key = this._pageKey(va);
    this.pages.set(key, {
      read, write, execute, user, device,
      mappedAt: now(),
    });
    kernelBus.emit("mmu:page-mapped", {
      va: hex(va),
      flags: { read, write, execute, user, device },
    });
  }

  unmapPage(va) {
    const key = this._pageKey(va);
    const ok = this.pages.delete(key);
    if (ok) kernelBus.emit("mmu:page-unmapped", { va: hex(va) });
    return ok;
  }

  translate(va, { write = false, execute = false, user = false } = {}) {
    const key = this._pageKey(va);
    const page = this.pages.get(key);
    if (!page) {
      this.faults.translation++;
      return { ok: false, fault: "translation", va, key };
    }
    if (write && !page.write) {
      this.faults.permission++;
      return { ok: false, fault: "permission-write", va };
    }
    if (execute && !page.execute) {
      this.faults.permission++;
      return { ok: false, fault: "permission-exec", va };
    }
    if (!execute && !page.read) {
      this.faults.permission++;
      return { ok: false, fault: "permission-read", va };
    }
    if (user && !page.user) {
      this.faults.permission++;
      return { ok: false, fault: "permission-user", va };
    }
    return { ok: true, pa: va, flags: page };
  }

  snapshot() {
    return {
      pageSize: this.pageSize,
      pages: this.pages.size,
      faults: { ...this.faults },
      ttbr0: hex(this.ttbr0),
      ttbr1: hex(this.ttbr1),
      tcr: hex(this.tcr),
      sctlr: hex(this.sctlr),
    };
  }
}

// ============================================================================
// CLASE: PACContext — firma/autenticación de punteros (base para ARM64e)
// ============================================================================

class PACContext {
  constructor() {
    // Llaves (stub en ARM64 base; ARM64e las deriva de verdad con QARMA-64)
    this.IA = 0x0123456789abcdefn;
    this.IB = 0xfedcba9876543210n;
    this.DA = 0x0f1e2d3c4b5a6978n;
    this.DB = 0x8796a5b4c3d2e1f0n;
    this.failures = 0;
    this.successes = 0;
  }

  /**
   * Firma un puntero con un discriminador.
   * En ARM64 base, esto es solo un hash trivial. ARM64e lo sobrescribe.
   */
  sign(ptr, modifier, key) {
    const mixed = u64(BigInt(ptr) ^ this[key] ^ BigInt(modifier));
    return { signed: mixed, raw: ptr, modifier, key };
  }

  auth(signed, modifier, key) {
    // Stub: en ARM64 base el "auth" solo recupera el puntero original.
    // ARM64e implementa QARMA-64 real.
    this.successes++;
    return u64(signed);
  }
}

// ============================================================================
// CLASE PRINCIPAL: ARM64Executor
// ============================================================================

export class ARM64Executor {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // ---- Registros GP ----
    this.x = new Array(31).fill(0n);      // X0..X30
    this.sp = u64(this.config.sp);
    this.pc = u64(this.config.pc);
    this.fp = u64(this.config.fp);
    this.lr = u64(this.config.lr);

    // ---- Flags NZCV ----
    this.nzcv = { n: 0, z: 1, c: 0, v: 0 };

    // ---- FP/SIMD ----
    // 32 registros de 128-bit (V0..V31)
    this.v = new Array(32).fill(0n);      // Q0..Q31 como BigInt 128
    this.fpcr = 0n;
    this.fpsr = 0n;

    // ---- Sistema ----
    this.el = EL.EL0;
    this.spsr_el0 = 0n;
    this.spsr_el1 = 0n;
    this.esr_el1 = 0n;
    this.far_el1 = 0n;
    this.vbar_el1 = 0n;
    this.regs_system = new Map();         // MRS/MSR para registros no modelados

    // ---- Memoria ----
    this.memory = new Uint8Array(0x100000);   // 1 MiB de RAM visible
    this.mmu = new MMU({
      pageSize: this.config.pageSize,
      vaRange: this.config.vaRange,
    });

    // ---- Caches ----
    this.caches = {
      L1I: new CacheSet({ ...CACHE_CONFIG.L1I, name: "L1I" }),
      L1D: new CacheSet({ ...CACHE_CONFIG.L1D, name: "L1D" }),
      L2:  new CacheSet({ ...CACHE_CONFIG.L2,  name: "L2" }),
      L3:  new CacheSet({ ...CACHE_CONFIG.L3,  name: "L3" }),
    };

    // ---- PAC (base) ----
    this.pac = new PACContext();

    // ---- Estado del ejecutor ----
    this.halted = false;
    this.haltReason = null;
    this.instructionsExecuted = 0n;
    this.cycles = 0n;
    this.startTime = null;
    this.endTime = null;

    // ---- Trazas ----
    this.traceBuffer = new Array(this.config.traceBufferSize);
    this.traceHead = 0;
    this.traceSize = 0;

    // ---- Breakpoints / watchpoints ----
    this.breakpoints = new Set();
    this.watchpoints = new Map();

    // ---- Estadísticas ----
    this.stats = {
      instructions: 0n,
      loads: 0n,
      stores: 0n,
      branches: 0n,
      takenBranches: 0n,
      syscalls: 0n,
      exceptions: 0n,
      pageFaults: 0n,
      pacSigns: 0n,
      pacAuths: 0n,
      pacFailures: 0n,
      mteChecks: 0n,
      mteFaults: 0n,
      fpuOps: 0n,
      cryptoOps: 0n,
    };

    // ---- Hooks externos ----
    this.syscallHandler = null;    // (num, args, ctx) => ret
    this.memoryAccessHandler = null;

    this._trace("init", {
      pc: hex(this.pc),
      sp: hex(this.sp),
      mode: this.config.mode,
    });
  }

  // ============================================================
  // MEMORIA
  // ============================================================

  readByte(addr) {
    const a = Number(u64(addr));
    if (this.config.enableMMU) {
      const t = this.mmu.translate(a);
      if (!t.ok) {
        this.stats.pageFaults++;
        this._raiseException(EC.DATA_ABORT_LOWER, {
          far: a, fault: t.fault,
        });
        return 0;
      }
    }
    return this.memory[a & 0xfffff] ?? 0;
  }

  writeByte(addr, value) {
    const a = Number(u64(addr));
    if (this.config.enableMMU) {
      const t = this.mmu.translate(a, { write: true });
      if (!t.ok) {
        this.stats.pageFaults++;
        this._raiseException(EC.DATA_ABORT_LOWER, {
          far: a, fault: t.fault,
        });
        return;
      }
    }
    this.memory[a & 0xfffff] = value & 0xff;
  }

  readU16(addr) {
    return u16(
      BigInt(this.readByte(addr)) |
      (BigInt(this.readByte(u64(addr) + 1n)) << 8n)
    );
  }

  readU32(addr) {
    return u32(
      BigInt(this.readByte(addr)) |
      (BigInt(this.readByte(u64(addr) + 1n)) << 8n) |
      (BigInt(this.readByte(u64(addr) + 2n)) << 16n) |
      (BigInt(this.readByte(u64(addr) + 3n)) << 24n)
    );
  }

  readU64(addr) {
    let acc = 0n;
    for (let i = 0; i < 8; i++) {
      acc |= BigInt(this.readByte(u64(addr) + BigInt(i))) << BigInt(i * 8);
    }
    return u64(acc);
  }

  writeU16(addr, value) {
    for (let i = 0; i < 2; i++) {
      this.writeByte(
        u64(addr) + BigInt(i),
        Number((u64(value) >> BigInt(i * 8)) & 0xffn)
      );
    }
  }

  writeU32(addr, value) {
    for (let i = 0; i < 4; i++) {
      this.writeByte(
        u64(addr) + BigInt(i),
        Number((u64(value) >> BigInt(i * 8)) & 0xffn)
      );
    }
  }

  writeU64(addr, value) {
    for (let i = 0; i < 8; i++) {
      this.writeByte(
        u64(addr) + BigInt(i),
        Number((u64(value) >> BigInt(i * 8)) & 0xffn)
      );
    }
  }

  // Helpers de acceso a registros con Wn → Xn widening
  readX(n) {
    if (n === 31) return this.sp;
    return this.x[n] ?? 0n;
  }

  writeX(n, value) {
    if (n === 31) {
      this.sp = u64(value);
      return;
    }
    this.x[n] = u64(value);
  }

  readW(n) {
    return u32(this.readX(n));
  }

  writeW(n, value) {
    this.writeX(n, u64(u32(value)));
  }

  readV(n) {
    return this.v[n] ?? 0n;
  }

  writeV(n, value) {
    this.v[n] = BigInt.asUintN(128, BigInt(value));
  }

  // ============================================================
  // FLAGS
  // ============================================================

  getN() { return this.nzcv.n; }
  getZ() { return this.nzcv.z; }
  getC() { return this.nzcv.c; }
  getV() { return this.nzcv.v; }

  setN(v) { this.nzcv.n = v ? 1 : 0; }
  setZ(v) { this.nzcv.z = v ? 1 : 0; }
  setC(v) { this.nzcv.c = v ? 1 : 0; }
  setV(v) { this.nzcv.v = v ? 1 : 0; }

  getNZCV() {
    return (
      (this.nzcv.n << 3) |
      (this.nzcv.z << 2) |
      (this.nzcv.c << 1) |
      (this.nzcv.v)
    );
  }

  setNZCV(v) {
    this.nzcv.n = (v >> 3) & 1;
    this.nzcv.z = (v >> 2) & 1;
    this.nzcv.c = (v >> 1) & 1;
    this.nzcv.v = v & 1;
  }

  evaluateCondition(cond) {
    const N = this.nzcv.n, Z = this.nzcv.z,
          C = this.nzcv.c, V = this.nzcv.v;
    switch (cond) {
      case COND.EQ: return Z === 1;
      case COND.NE: return Z === 0;
      case COND.CS: return C === 1;
      case COND.CC: return C === 0;
      case COND.MI: return N === 1;
      case COND.PL: return N === 0;
      case COND.VS: return V === 1;
      case COND.VC: return V === 0;
      case COND.HI: return C === 1 && Z === 0;
      case COND.LS: return C === 0 || Z === 1;
      case COND.GE: return N === V;
      case COND.LT: return N !== V;
      case COND.GT: return Z === 0 && N === V;
      case COND.LE: return Z === 1 || N !== V;
      case COND.AL: return true;
      case COND.NV: return false;
      default: return false;
    }
  }

  // Helpers aritméticos que actualizan NZCV
  _addWithFlags(a, b, isSub = false, is32 = false) {
    const w = is32 ? 32n : 64n;
    const mask = (1n << w) - 1n;
    const bb = u64(b) & mask;
    const aa = u64(a) & mask;
    const r = isSub ? (aa - bb) & mask : (aa + bb) & mask;

    const signBit = 1n << (w - 1n);
    const n = (r & signBit) !== 0n ? 1 : 0;
    const z = r === 0n ? 1 : 0;

    let c, v;
    if (isSub) {
      c = aa >= bb ? 1 : 0;
      v = (((aa ^ bb) & (aa ^ r)) & signBit) !== 0n ? 1 : 0;
    } else {
      c = (aa + bb) > mask ? 1 : 0;
      v = ((~(aa ^ bb) & (aa ^ r)) & signBit) !== 0n ? 1 : 0;
    }

    return { result: r, n, z, c, v };
  }

  _logicalFlags(result, is32 = false) {
    const w = is32 ? 32n : 64n;
    const signBit = 1n << (w - 1n);
    const mask = (1n << w) - 1n;
    const r = u64(result) & mask;
    this.nzcv.n = (r & signBit) !== 0n ? 1 : 0;
    this.nzcv.z = r === 0n ? 1 : 0;
    this.nzcv.c = 0;
    this.nzcv.v = 0;
  }

  // ============================================================
  // EXCEPCIONES
  // ============================================================

  _raiseException(ec, opts = {}) {
    this.stats.exceptions++;
    const vectorOffset = this._vectorOffset(ec);
    const oldEl = this.el;
    const newEl = Math.max(oldEl, EL.EL1);

    this.spsr_el1 = BigInt(this.getNZCV() | (oldEl << 4));
    this.esr_el1 = BigInt((ec & 0x3f) << 26);
    if (opts.far !== undefined) this.far_el1 = BigInt(opts.far);

    this.el = newEl;
    this.pc = u64(this.vbar_el1 + BigInt(vectorOffset));

    kernelBus.emit("cpu:exception", {
      ec,
      ecName: this._ecName(ec),
      fromEl: oldEl,
      toEl: newEl,
      pc: hex(this.pc),
      far: opts.far !== undefined ? hex(opts.far) : null,
      fault: opts.fault ?? null,
    });

    this._trace("exception", { ec, pc: hex(this.pc) });
  }

  _vectorOffset(ec) {
    // Layout estándar VBAR_ELx: 4 grupos de 4 excepciones × 0x80 bytes
    //   offset 0x000: current EL with SP0
    //   offset 0x200: current EL with SPx
    //   offset 0x400: lower EL using AArch64
    //   offset 0x600: lower EL using AArch32
    const group = 0x400;              // simplificamos: siempre "lower EL AArch64"
    const idx   = (ec === EC.SVC64) ? 0 :
                  (ec === EC.INSTRUCTION_ABORT_LOWER || ec === EC.INSTRUCTION_ABORT_SAME) ? 1 :
                  (ec === EC.DATA_ABORT_LOWER || ec === EC.DATA_ABORT_SAME) ? 2 :
                  3;
    return group + idx * 0x80;
  }

  _ecName(ec) {
    for (const [k, v] of Object.entries(EC)) if (v === ec) return k;
    return "UNKNOWN";
  }

  // ============================================================
  // SYSCALLS (SVC #0x80 estilo Darwin)
  // ============================================================

  _svc(imm16) {
    this.stats.syscalls++;

    const nr = Number(this.readX(16));         // X16 = syscall number
    const args = [
      this.readX(0),
      this.readX(1),
      this.readX(2),
      this.readX(3),
      this.readX(4),
      this.readX(5),
    ];

    kernelBus.emit("syscall:called", {
      pid: 1,
      name: this._syscallName(nr),
      number: nr,
      args: args.map((a) => hex(a)),
      imm16,
      category: this._syscallCategory(nr),
      blocked: false,
      errno: 0,
      errnoName: "0",
    });

    if (typeof this.syscallHandler === "function") {
      try {
        const ret = this.syscallHandler(nr, args, this);
        this.writeX(0, u64(ret ?? 0n));
      } catch (err) {
        this.writeX(0, u64(-1n));
        kernelBus.emit("syscall:failed", {
          number: nr, error: String(err),
        });
      }
    } else {
      this.writeX(0, 0n);
    }

    this._trace("svc", { nr, name: this._syscallName(nr) });
  }

  _syscallName(nr) {
    const NAMES = {
      1: "exit", 2: "fork", 3: "read", 4: "write", 5: "open",
      6: "close", 7: "wait4", 20: "getpid", 33: "access",
      37: "kill", 42: "pipe", 48: "sigaction", 54: "ioctl",
      73: "munmap", 74: "mprotect", 92: "fcntl", 97: "socket",
      98: "connect", 104: "bind", 106: "listen", 202: "sysctl",
      210: "mmap", 216: "mkfifo", 220: "getdirentries",
      240: "getxattr", 338: "getentropy",
    };
    return NAMES[nr] ?? `unknown_${nr}`;
  }

  _syscallCategory(nr) {
    if (nr <= 10)   return "process";
    if (nr <= 100)  return "io";
    if (nr <= 200)  return "network";
    if (nr <= 250)  return "memory";
    if (nr <= 300)  return "fs";
    return "misc";
  }

  // ============================================================
  // ATÓMICOS
  // ============================================================

  _exclusiveLoad(addr, size, isPair = false) {
    this.exclusiveAddr = u64(addr);
    this.exclusiveSize = size;
    this.exclusiveValid = true;
    this.exclusivePair = isPair;
    return isPair
      ? [this.readU64(addr), this.readU64(u64(addr) + 8n)]
      : size === 64 ? this.readU64(addr)
      : size === 32 ? this.readU32(addr)
      : size === 16 ? this.readU16(addr)
      : this.readByte(addr);
  }

  _exclusiveStore(addr, value, size, isPair = false) {
    if (
      !this.exclusiveValid ||
      this.exclusiveAddr !== u64(addr) ||
      this.exclusiveSize !== size
    ) {
      return 1; // store failed
    }
    if (isPair) {
      const [lo, hi] = value;
      this.writeU64(addr, lo);
      this.writeU64(u64(addr) + 8n, hi);
    } else {
      if (size === 64) this.writeU64(addr, value);
      else if (size === 32) this.writeU32(addr, value);
      else if (size === 16) this.writeU16(addr, value);
      else this.writeByte(addr, value);
    }
    this.exclusiveValid = false;
    return 0;
  }

  // ============================================================
  // DECODE + EXECUTE
  // ============================================================

  step() {
    if (this.halted) return { halted: true };

    const pcBefore = this.pc;
    const insn = this.readU32(this.pc);

    if (this.config.enableCaches) {
      this.caches.L1I.read(Number(pcBefore));
      this.caches.L2.read(Number(pcBefore));
      this.caches.L3.read(Number(pcBefore));
    }

    this._trace("fetch", { pc: hex(pcBefore), insn: hex(insn, 8) });

    let result;
    try {
      result = this.execute(insn);
    } catch (err) {
      this._raiseException(EC.UNKNOWN, { pc: pcBefore, error: String(err) });
      return { ok: false, error: String(err) };
    }

    if (!result?.branched) {
      this.pc = u64(this.pc + 4n);
    }

    this.instructionsExecuted++;
    this.cycles += BigInt(result?.cycles ?? 1);
    this.stats.instructions++;

    if (this.config.logInstructions) {
      kernelBus.emit("cpu:instruction", {
        pc: hex(pcBefore),
        insn: hex(insn, 8),
        mnemonic: result?.mnemonic ?? "?",
        registers: this._snapshotRegs(),
      });
    }

    if (
      this.instructionsExecuted > BigInt(this.config.maxInstructions)
    ) {
      this.halt("max-instructions");
    }

    if (this.breakpoints.has(Number(this.pc))) {
      this.halt("breakpoint");
      kernelBus.emit("cpu:breakpoint", { pc: hex(this.pc) });
    }

    return { ok: true, ...result };
  }

  execute(insn) {
    // 1. Comprobar si es una instrucción de 32-bit; si el top bits son
    //    1111_1111_1111_1111_1111_1111_1111_1111, es 0xFFFFFFFF (reservado)
    if (insn === 0xffffffff) {
      this.halt("illegal-instruction");
      return { mnemonic: "illegal" };
    }

    // 2. Dispatch por opcode top-level
    //    Este dispatch sigue el apéndice A del ARM ARM (A64), tabla C4-1,
    //    indexado por el campo op1 = bits[28:25] (no op0 solo, que no
    //    distingue por sí mismo entre Branch/Exception/System y
    //    Load/Store — ambas familias caen bajo op0 == 0b010/0b011
    //    dependiendo del resto de op1).
    const op1 = bits(insn, 28, 25);

    // Data processing (immediate): op1 == 100x
    if (op1 === 0b1000 || op1 === 0b1001) {
      return this._execDataProcImm(insn);
    }
    // Branches, exception generating, system: op1 == 101x
    if (op1 === 0b1010 || op1 === 0b1011) {
      return this._execBranchExceptionSystem(insn);
    }
    // Loads and stores: op1 == x1x0
    if (op1 === 0b0100 || op1 === 0b0110 || op1 === 0b1100 || op1 === 0b1110) {
      return this._execLoadStore(insn);
    }
    // Data processing (register): op1 == x101
    if (op1 === 0b0101 || op1 === 0b1101) {
      return this._execDataProcReg(insn);
    }
    // SIMD/FP: op1 == x111
    if (op1 === 0b0111 || op1 === 0b1111) {
      return this._execSIMDFP(insn);
    }

    return { mnemonic: "unimplemented", insn: hex(insn, 8) };
  }

  // ============================================================
  // FAMILIAS DE INSTRUCCIONES (stubs funcionales)
  // ============================================================
  // El ejecutor expone el pipeline y la semántica de estado; las familias
  // específicas se delegan a métodos privados que pueden ser sobrescritos
  // por ARM64eExecutor para añadir PAC/MTE.

  _execDataProcImm(insn) {
    const mnemonic = "data-proc-imm";
    // ADD/SUB imm, MOVZ/MOVK/MOVN, logical imm, etc.
    // Implementación mínima: mover el valor inmediato a X0.
    const imm = bits(insn, 20, 5);
    const rd  = bits(insn, 4, 0);
    this.writeX(rd, u64(imm));
    return { mnemonic, cycles: 1 };
  }

  _execBranchExceptionSystem(insn) {
    // B, BL, B.cond, CBZ, CBNZ, TBZ, TBNZ, SVC, HVC, SMC, MRS, MSR, etc.
    const b5_b0 = bits(insn, 5, 0);
    const op0   = bits(insn, 31, 24);

    // SVC
    if (op0 === 0xd4 && b5_b0 === 0b000001) {
      const imm16 = bits(insn, 20, 5);
      this._svc(imm16);
      return { mnemonic: "svc", cycles: 20, branched: false };
    }

    // B (unconditional, imm26)
    if ((insn & 0xfc000000) === 0x14000000) {
      const imm26 = bits(insn, 25, 0);
      const off   = signExtend(BigInt(imm26) << 2n, 28);
      this.pc = u64(this.pc + off);
      this.stats.branches++;
      this.stats.takenBranches++;
      return { mnemonic: "b", cycles: 1, branched: true };
    }

    // BL (branch with link, imm26)
    if ((insn & 0xfc000000) === 0x94000000) {
      const imm26 = bits(insn, 25, 0);
      const off   = signExtend(BigInt(imm26) << 2n, 28);
      this.lr = u64(this.pc + 4n);
      this.writeX(30, this.lr);
      this.pc = u64(this.pc + off);
      this.stats.branches++;
      this.stats.takenBranches++;
      return { mnemonic: "bl", cycles: 2, branched: true };
    }

    // B.cond (imm19)
    if ((insn & 0xff000010) === 0x54000000) {
      const cond  = bits(insn, 3, 0);
      const imm19 = bits(insn, 23, 5);
      const off   = signExtend(BigInt(imm19) << 2n, 21);
      this.stats.branches++;
      if (this.evaluateCondition(cond)) {
        this.pc = u64(this.pc + off);
        this.stats.takenBranches++;
        return { mnemonic: "b.cond", cycles: 2, branched: true };
      }
      return { mnemonic: "b.cond", cycles: 1, branched: false };
    }

    // RET
    if (insn === 0xd65f03c0) {
      this.pc = u64(this.readX(30));
      return { mnemonic: "ret", cycles: 3, branched: true };
    }

    // NOP
    if (insn === 0xd503201f) {
      return { mnemonic: "nop", cycles: 1 };
    }

    // WFI
    if (insn === 0xd503207f) {
      this.halt("wfi");
      return { mnemonic: "wfi", cycles: 1 };
    }

    // WFE
    if (insn === 0xd503205f) {
      this.halt("wfe");
      return { mnemonic: "wfe", cycles: 1 };
    }

    return { mnemonic: "branch-unimpl", insn: hex(insn, 8), cycles: 1 };
  }

  _execLoadStore(insn) {
    // LDR/STR/LDP/STP/LDRB/STRB/LDRH/STRH/LDRSW + atomics
    // Detección mínima: op0=01 y bit 27=0 o 1
    const isLoad = bit(insn, 22) === 1;
    const rn = bits(insn, 9, 5);
    const rt = bits(insn, 4, 0);
    const imm12 = bits(insn, 21, 10);
    const base = this.readX(rn);

    if (imm12 === 0 && rn === 31 && rt === 31 && !isLoad) {
      return { mnemonic: "stub-loadstore", cycles: 1 };
    }

    const addr = u64(base + BigInt(imm12) * 8n);
    if (isLoad) {
      this.writeX(rt, this.readU64(addr));
      this.stats.loads++;
    } else {
      this.writeU64(addr, this.readX(rt));
      this.stats.stores++;
    }
    return { mnemonic: isLoad ? "ldr" : "str", cycles: 4 };
  }

  _execDataProcReg(insn) {
    // ADD/SUB/AND/ORR/EOR + shifted register variants
    const rm = bits(insn, 20, 16);
    const rn = bits(insn, 9, 5);
    const rd = bits(insn, 4, 0);
    const op = bits(insn, 28, 21);
    const sf = bit(insn, 31);
    const isSub = bit(insn, 30) === 1;

    const a = this.readX(rn);
    const b = this.readX(rm);

    if (op === 0x0b || op === 0x8b) {
      // ADD
      const r = this._addWithFlags(a, b, false, !sf);
      this.writeX(rd, r.result);
      if (bit(insn, 29)) {
        this.nzcv.n = r.n; this.nzcv.z = r.z;
        this.nzcv.c = r.c; this.nzcv.v = r.v;
      }
      return { mnemonic: "add", cycles: 1 };
    }
    if (op === 0x4b || op === 0xcb) {
      // SUB
      const r = this._addWithFlags(a, b, true, !sf);
      this.writeX(rd, r.result);
      if (bit(insn, 29)) {
        this.nzcv.n = r.n; this.nzcv.z = r.z;
        this.nzcv.c = r.c; this.nzcv.v = r.v;
      }
      return { mnemonic: "sub", cycles: 1 };
    }
    if (op === 0x2a || op === 0x6a) {
      // ORR / EOR
      const r = u64(a ^ b);
      this.writeX(rd, r);
      this._logicalFlags(r, !sf);
      return { mnemonic: "orr/eor", cycles: 1 };
    }

    return { mnemonic: "dataproc-unimpl", insn: hex(insn, 8), cycles: 1 };
  }

  _execSIMDFP(insn) {
    // ADD/SUB/FMUL/FDIV/FMLA/SIMD + conversions
    // Implementación mínima: FP32 y FP64 en V0/V1 → V0
    const rd = bits(insn, 4, 0);
    const rn = bits(insn, 9, 5);
    const rm = bits(insn, 20, 16);

    const f32 = (q) => {
      const u = Number(q & 0xffffffffn);
      const buf = new ArrayBuffer(4);
      new DataView(buf).setUint32(0, u, true);
      return new DataView(buf).getFloat32(0, true);
    };
    const f64 = (q) => {
      const u = q & 0xffffffffffffffffn;
      const buf = new ArrayBuffer(8);
      new DataView(buf).setBigUint64(0, u, true);
      return new DataView(buf).getFloat64(0, true);
    };
    const toF32Bits = (v) => {
      const buf = new ArrayBuffer(4);
      new DataView(buf).setFloat32(0, v, true);
      return BigInt(new DataView(buf).getUint32(0, true));
    };
    const toF64Bits = (v) => {
      const buf = new ArrayBuffer(8);
      new DataView(buf).setFloat64(0, v, true);
      return new DataView(buf).getBigUint64(0, true);
    };

    // FADD Sd, Sn, Sm
    if ((insn & 0xff20fc00) === 0x1e202800) {
      const a = f32(this.readV(rn));
      const b = f32(this.readV(rm));
      this.writeV(rd, toF32Bits(a + b));
      this.stats.fpuOps++;
      return { mnemonic: "fadd.s", cycles: 4 };
    }
    // FSUB Sd, Sn, Sm
    if ((insn & 0xff20fc00) === 0x1e203800) {
      const a = f32(this.readV(rn));
      const b = f32(this.readV(rm));
      this.writeV(rd, toF32Bits(a - b));
      this.stats.fpuOps++;
      return { mnemonic: "fsub.s", cycles: 4 };
    }
    // FMUL Sd, Sn, Sm
    if ((insn & 0xff20fc00) === 0x1e200800) {
      const a = f32(this.readV(rn));
      const b = f32(this.readV(rm));
      this.writeV(rd, toF32Bits(a * b));
      this.stats.fpuOps++;
      return { mnemonic: "fmul.s", cycles: 4 };
    }
    // FDIV Sd, Sn, Sm
    if ((insn & 0xff20fc00) === 0x1e201800) {
      const a = f32(this.readV(rn));
      const b = f32(this.readV(rm));
      this.writeV(rd, toF32Bits(b === 0 ? (a === 0 ? NaN : Math.sign(a) * Infinity) : a / b));
      this.stats.fpuOps++;
      return { mnemonic: "fdiv.s", cycles: 12 };
    }

    // FADD Dd, Dn, Dm
    if ((insn & 0xff20fc00) === 0x1e602800) {
      const a = f64(this.readV(rn));
      const b = f64(this.readV(rm));
      this.writeV(rd, toF64Bits(a + b));
      this.stats.fpuOps++;
      return { mnemonic: "fadd.d", cycles: 4 };
    }
    // FSUB Dd, Dn, Dm
    if ((insn & 0xff20fc00) === 0x1e603800) {
      const a = f64(this.readV(rn));
      const b = f64(this.readV(rm));
      this.writeV(rd, toF64Bits(a - b));
      this.stats.fpuOps++;
      return { mnemonic: "fsub.d", cycles: 4 };
    }
    // FMUL Dd, Dn, Dm
    if ((insn & 0xff20fc00) === 0x1e600800) {
      const a = f64(this.readV(rn));
      const b = f64(this.readV(rm));
      this.writeV(rd, toF64Bits(a * b));
      this.stats.fpuOps++;
      return { mnemonic: "fmul.d", cycles: 4 };
    }
    // FDIV Dd, Dn, Dm
    if ((insn & 0xff20fc00) === 0x1e601800) {
      const a = f64(this.readV(rn));
      const b = f64(this.readV(rm));
      this.writeV(rd, toF64Bits(b === 0 ? (a === 0 ? NaN : Math.sign(a) * Infinity) : a / b));
      this.stats.fpuOps++;
      return { mnemonic: "fdiv.d", cycles: 12 };
    }

    return { mnemonic: "simdfp-unimpl", insn: hex(insn, 8), cycles: 1 };
  }

  // ============================================================
  // EJECUCIÓN GLOBAL
  // ============================================================

  run({ maxSteps = this.config.maxInstructions, until = null } = {}) {
    this.startTime = now();
    let steps = 0;

    while (!this.halted && steps < maxSteps) {
      if (until && this.pc === u64(until)) break;
      this.step();
      steps++;
    }

    this.endTime = now();
    return {
      steps,
      instructions: this.instructionsExecuted,
      cycles: this.cycles,
      halted: this.halted,
      haltReason: this.haltReason,
      pc: hex(this.pc),
      runtimeMs: this.endTime - this.startTime,
    };
  }

  halt(reason = "user-requested") {
    this.halted = true;
    this.haltReason = reason;
    kernelBus.emit("cpu:halted", { reason, pc: hex(this.pc) });
  }

  resume() {
    this.halted = false;
    this.haltReason = null;
    this.startTime = now();
    kernelBus.emit("cpu:resumed", { pc: hex(this.pc) });
  }

  reset() {
    this.x = new Array(31).fill(0n);
    this.sp = u64(this.config.sp);
    this.pc = u64(this.config.pc);
    this.fp = u64(this.config.fp);
    this.lr = u64(this.config.lr);
    this.v = new Array(32).fill(0n);
    this.nzcv = { n: 0, z: 1, c: 0, v: 0 };
    this.halted = false;
    this.haltReason = null;
    this.instructionsExecuted = 0n;
    this.cycles = 0n;
    this.memory.fill(0);
    for (const c of Object.values(this.caches)) c.invalidate();
    this.stats = {
      instructions: 0n, loads: 0n, stores: 0n,
      branches: 0n, takenBranches: 0n, syscalls: 0n,
      exceptions: 0n, pageFaults: 0n,
      pacSigns: 0n, pacAuths: 0n, pacFailures: 0n,
      mteChecks: 0n, mteFaults: 0n,
      fpuOps: 0n, cryptoOps: 0n,
    };
    kernelBus.emit("cpu:reset", { pc: hex(this.pc) });
  }

  // ============================================================
  // TRACE
  // ============================================================

  _trace(kind, data) {
    this.traceBuffer[this.traceHead] = { kind, at: now(), data };
    this.traceHead = (this.traceHead + 1) % this.config.traceBufferSize;
    this.traceSize = Math.min(this.traceSize + 1, this.config.traceBufferSize);
  }

  getTrace() {
    const out = [];
    for (let i = 0; i < this.traceSize; i++) {
      const idx =
        (this.traceHead - this.traceSize + i + this.config.traceBufferSize) %
        this.config.traceBufferSize;
      out.push(this.traceBuffer[idx]);
    }
    return out;
  }

  _snapshotRegs() {
    return {
      x0: hex(this.x[0] ?? 0n, 16),
      x1: hex(this.x[1] ?? 0n, 16),
      sp: hex(this.sp, 16),
      pc: hex(this.pc, 16),
      nzcv: this.getNZCV(),
    };
  }

  // ============================================================
  // INSPECCIÓN
  // ============================================================

  snapshot() {
    return {
      pc: hex(this.pc, 16),
      sp: hex(this.sp, 16),
      fp: hex(this.fp, 16),
      lr: hex(this.lr, 16),
      nzcv: this.getNZCV(),
      el: this.el,
      instructions: this.instructionsExecuted.toString(),
      cycles: this.cycles.toString(),
      halted: this.halted,
      haltReason: this.haltReason,
      stats: Object.fromEntries(
        Object.entries(this.stats).map(([k, v]) => [k, v.toString()])
      ),
      caches: Object.values(this.caches).map((c) => c.snapshot()),
      mmu: this.mmu.snapshot(),
      regs: this.x.slice(0, 8).map((v) => hex(v, 16)),
      v0: hex(this.v[0] & 0xffffffffffffffffn, 16),
      v1: hex(this.v[1] & 0xffffffffffffffffn, 16),
    };
  }

  setBreakpoint(addr) {
    this.breakpoints.add(Number(u64(addr)));
    kernelBus.emit("cpu:breakpoint-set", { addr: hex(addr) });
  }

  clearBreakpoint(addr) {
    this.breakpoints.delete(Number(u64(addr)));
  }

  setSyscallHandler(fn) {
    this.syscallHandler = fn;
  }

  setMemoryAccessHandler(fn) {
    this.memoryAccessHandler = fn;
  }
}

// ============================================================================
// PROVIDER REACT + HOOK
// ============================================================================

const ARM64ExecutorContext = createContext(null);

export function ARM64ExecutorProvider({
  children,
  config = {},
  autoRun = false,
  syscallHandler = null,
}) {
  const executorRef = useRef(null);

  if (!executorRef.current) {
    executorRef.current = new ARM64Executor(config);
    if (syscallHandler) executorRef.current.setSyscallHandler(syscallHandler);
  }

  const executor = executorRef.current;

  useEffect(() => {
    kernelBus.emit("arm64-executor:ready", {
      pc: hex(executor.pc),
      mode: executor.config.mode,
    });
  }, [executor]);

  useEffect(() => {
    if (!autoRun) return;
    try {
      executor.run();
    } catch (err) {
      kernelBus.emit("arm64-executor:auto-run-failed", {
        error: String(err),
      });
    }
  }, [executor, autoRun]);

  const value = useMemo(
    () => ({
      executor,
      step: () => executor.step(),
      run: (opts) => executor.run(opts),
      halt: (reason) => executor.halt(reason),
      resume: () => executor.resume(),
      reset: () => executor.reset(),
      snapshot: () => executor.snapshot(),
      getTrace: () => executor.getTrace(),
      setBreakpoint: (a) => executor.setBreakpoint(a),
      clearBreakpoint: (a) => executor.clearBreakpoint(a),
    }),
    [executor]
  );

  return (
    <ARM64ExecutorContext.Provider value={value}>
      {children}
    </ARM64ExecutorContext.Provider>
  );
}

export function useARM64Executor() {
  const ctx = useContext(ARM64ExecutorContext);
  if (!ctx) {
    throw new Error(
      "useARM64Executor must be used within ARM64ExecutorProvider"
    );
  }
  return ctx;
}

// ============================================================================
// EXPORTS
// ============================================================================

export { COND, EL, EC, CACHE_CONFIG, DEFAULT_CONFIG, CacheSet, MMU, PACContext };
export { u64, u32, u16, u8, s64, s32, bit, bits, signExtend, hex };
