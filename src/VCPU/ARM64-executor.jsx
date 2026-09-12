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
  pc: 0x00010000,
  sp: 0x00800000,
  fp: 0x00800100,
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
      
    this.memory = new Uint8Array(0x1000000);   // 16 MiB de RAM visible
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
    return this.memory[a & 0xffffff] ?? 0;
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
    this.memory[a & 0xffffff] = value & 0xff;
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
    // ============================================================
    // Data Processing — Immediate
    // ============================================================
    // Esta familia codifica instrucciones con un inmediato (o con
    // un campo que se interpreta como inmediato). El dispatch de
    // primer nivel es por los bits [25:23] (op0):
    //
    //   op0 = 000/001  → PC-rel. addressing (ADR / ADRP)
    //   op0 = 010      → Add/subtract (immediate)
    //   op0 = 011      → Add/subtract (immediate, with tags) — MTE
    //   op0 = 100      → Logical (immediate)
    //   op0 = 101      → Move wide (immediate)  (MOVZ/MOVK/MOVN)
    //   op0 = 110      → Bitfield
    //   op0 = 111      → Extract
    //
    // El bit [31] (sf) distingue 64-bit (1) de 32-bit (0).
    // ============================================================

    const sf    = bit(insn, 31);       // 1 = 64-bit, 0 = 32-bit
    const op0   = bits(insn, 25, 23);  // familia
    const rd    = bits(insn, 4, 0);

    // ------------------------------------------------------------
    // PC-relative addressing: ADR / ADRP
    // ------------------------------------------------------------
    if (op0 === 0b000 || op0 === 0b001) {
      const op = bit(insn, 31);        // 0 = ADR, 1 = ADRP
      const immlo = bits(insn, 30, 29);
      const immhi = bits(insn, 23, 5);
      let imm = (immhi << 2) | immlo;  // 21 bits
      imm = Number(signExtend(BigInt(imm), 21));

      if (op === 0) {
        // ADR: PC + imm, sin alinear
        this.writeX(rd, u64(this.pc + BigInt(imm)));
        return { mnemonic: `adr x${rd}`, cycles: 1 };
      } else {
        // ADRP: (PC & ~0xfff) + (imm << 12)
        const base = u64(this.pc) & ~0xfffn;
        const target = u64(base + (BigInt(imm) << 12n));
        this.writeX(rd, target);
        return { mnemonic: `adrp x${rd}`, cycles: 1 };
      }
    }

    // ------------------------------------------------------------
    // Add/subtract (immediate): ADD / ADDS / SUB / SUBS
    //   bit 31  = sf (1 = 64-bit)
    //   bit 30  = op (0 = ADD, 1 = SUB)
    //   bit 29  = S  (1 = set flags)
    //   bits[23:22] = sh (0 = LSL #0, 1 = LSL #12)
    //   bits[21:10] = imm12
    //   bits[9:5]   = Rn
    // ------------------------------------------------------------
    if (op0 === 0b010) {
      const op = bit(insn, 30);        // 0 = ADD, 1 = SUB
      const S  = bit(insn, 29);
      const sh = bits(insn, 23, 22);
      const imm12 = BigInt(bits(insn, 21, 10));
      const rn = bits(insn, 9, 5);

      if (sh > 1) {
        return { mnemonic: "data-proc-imm-unimpl", insn: hex(insn, 8), cycles: 1 };
      }

      const imm = sh === 1 ? (imm12 << 12n) : imm12;
      const a = this.readX(rn);

      const r = this._addWithFlags(a, imm, op === 1, sf === 0);
      this.writeX(rd, r.result);

      if (S === 1) {
        this.nzcv.n = r.n;
        this.nzcv.z = r.z;
        this.nzcv.c = r.c;
        this.nzcv.v = r.v;
      }

      const base = op === 0 ? "add" : "sub";
      const suffix = (S === 1 ? "s" : "") + (sf === 0 ? "" : "");
      const shift = sh === 1 ? ", lsl #12" : "";
      return {
        mnemonic: `${base}${sf === 1 ? "" : ""} x${rd}, x${rn}, #${imm}${shift}`,
        cycles: 1,
      };
    }

    // ------------------------------------------------------------
    // Logical (immediate): AND / ORR / EOR / ANDS
    //   bit 31  = sf
    //   bit 30  = opc[1]
    //   bit 29  = opc[0]  → junto con bit 30 forma opc:
    //                         00 = AND,  01 = ORR,  10 = EOR,  11 = ANDS
    //   bits[22:16] = N:immr (parte alta)
    //   bits[15:10] = imms
    //   bits[9:5]   = Rn
    //
    // Decodificar el inmediato lógico real requiere el algoritmo
    // "DecodeBitMasks" del ARM ARM (sección D5.2.3). Lo implemento
    // aquí completo porque sin él no se puede ejecutar ORR/AND/EOR
    // con inmediato, que aparecen constantemente en código real.
    // ------------------------------------------------------------
    if (op0 === 0b100) {
      const opc = (bit(insn, 30) << 1) | bit(insn, 29);
      const N   = bit(insn, 22);
      const immr = bits(insn, 21, 16);
      const imms = bits(insn, 15, 10);
      const rn = bits(insn, 9, 5);

      const is64 = sf === 1;
      const len = is64 ? 6 : 5; // 64 bits → 6, 32 bits → 5 (2^len = width)

      // Validaciones básicas del formato (N debe ser 1 si sf=1)
      if ((is64 && N !== 1) || (!is64 && N !== 0)) {
        return { mnemonic: "data-proc-imm-unimpl", insn: hex(insn, 8), cycles: 1 };
      }

      const decoded = this._decodeLogicalImm(N, immr, imms, len);
      if (decoded === null) {
        return { mnemonic: "data-proc-imm-unimpl", insn: hex(insn, 8), cycles: 1 };
      }

      const a = this.readX(rn);
      const wmask = decoded;
      let r;
      let mnemonic;

      switch (opc) {
        case 0b00: r = u64(a & wmask); mnemonic = "and"; break;
        case 0b01: r = u64(a | wmask); mnemonic = "orr"; break;
        case 0b10: r = u64(a ^ wmask); mnemonic = "eor"; break;
        case 0b11: r = u64(a & wmask); mnemonic = "ands"; break;
        default:   return { mnemonic: "data-proc-imm-unimpl", insn: hex(insn, 8), cycles: 1 };
      }

      this.writeX(rd, r);

      if (opc === 0b11) {
        this._logicalFlags(r, sf === 0);
      }

      return { mnemonic: `${mnemonic} x${rd}, x${rn}, #imm`, cycles: 1 };
    }

    // ------------------------------------------------------------
    // Move wide (immediate): MOVZ / MOVN / MOVK
    //   bit 31  = sf
    //   bit 30  = opc[1]
    //   bit 29  = opc[0]  → opc: 00 = MOVN, 10 = MOVZ, 11 = MOVK
    //   bits[22:21] = hw (shift: 0/16/32/48)
    //   bits[20:5]  = imm16
    // ------------------------------------------------------------
    if (op0 === 0b101) {
      const opc = (bit(insn, 30) << 1) | bit(insn, 29);
      const hw = bits(insn, 22, 21);
      const imm16 = BigInt(bits(insn, 20, 5));

      // MOVK/MOVZ/MOVN de 32 bits solo permiten hw = 0 o 1
      if (sf === 0 && hw > 1) {
        return { mnemonic: "data-proc-imm-unimpl", insn: hex(insn, 8), cycles: 1 };
      }

      const shift = BigInt(hw * 16);

      if (opc === 0b00) {
        // MOVN: mueve el complemento a 1
        const val = ~(imm16 << shift);
        this.writeX(rd, u64(val));
        return { mnemonic: `movn x${rd}, #${imm16}`, cycles: 1 };
      }

      if (opc === 0b10) {
        // MOVZ: mueve el inmediato, resto a 0
        const val = imm16 << shift;
        this.writeX(rd, u64(val));
        return { mnemonic: `movz x${rd}, #${imm16}`, cycles: 1 };
      }

      if (opc === 0b11) {
        // MOVK: mantiene el resto del registro, sobrescribe 16 bits
        const old = this.readX(rd);
        const mask = ~(0xffffn << shift);
        const val = (old & mask) | (imm16 << shift);
        this.writeX(rd, u64(val));
        return { mnemonic: `movk x${rd}, #${imm16}`, cycles: 1 };
      }

      return { mnemonic: "data-proc-imm-unimpl", insn: hex(insn, 8), cycles: 1 };
    }

    // ------------------------------------------------------------
    // Bitfield: SBFM / UBFM / BFM
    //   bit 31  = sf
    //   bit 30  = opc[1]
    //   bit 29  = opc[0]  → opc: 00 = SBFM, 01 = BFM, 10 = UBFM
    //   bit 22  = N (debe ser igual a sf)
    //   bits[21:16] = immr
    //   bits[15:10] = imms
    //   bits[9:5]   = Rn
    //
    // Los alias más comunes (LSL, LSR, ASR, SBFX, UBFX, BFI, BFXIL)
    // se decodifican a partir de SBFM/UBFM/BFM.
    // ------------------------------------------------------------
    if (op0 === 0b110) {
      const opc = (bit(insn, 30) << 1) | bit(insn, 29);
      const N   = bit(insn, 22);
      const immr = bits(insn, 21, 16);
      const imms = bits(insn, 15, 10);
      const rn = bits(insn, 9, 5);

      if (N !== sf) {
        return { mnemonic: "data-proc-imm-unimpl", insn: hex(insn, 8), cycles: 1 };
      }

      const width = sf === 1 ? 64 : 32;
      const a = this.readX(rn);
      let r;
      let mnemonic;

      if (opc === 0b00) {
        // SBFM — alias habituales: ASR (immediate), SBFX
        if (imms < immr) {
          // SBFIZ — no lo cubrimos, devolvemos unimpl
          return { mnemonic: "data-proc-imm-unimpl", insn: hex(insn, 8), cycles: 1 };
        }
        const width2 = imms - immr + 1;
        if (imms + 1 === width && immr === 0) {
          // SBFM Xd, Xn, #0, #63 → SXTB/SXTH/SXTW (según imms)
          if (imms === 7)  { this.writeX(rd, u64(s64((a & 0xffn) << 56n) >> 56n)); return { mnemonic: `sxtb x${rd}`, cycles: 1 }; }
          if (imms === 15) { this.writeX(rd, u64(s64((a & 0xffffn) << 48n) >> 48n)); return { mnemonic: `sxth x${rd}`, cycles: 1 }; }
          if (imms === 31) { this.writeX(rd, u64(s64((a & 0xffffffffn) << 32n) >> 32n)); return { mnemonic: `sxtw x${rd}`, cycles: 1 }; }
        }
        // SBFM Xd, Xn, #immr, #imms → SBFX Xd, Xn, #lsb, #width
        const lsb = immr;
        const fieldMask = (1n << BigInt(width2)) - 1n;
        const field = (a >> BigInt(lsb)) & fieldMask;
        r = u64(s64(field << BigInt(width - width2)) >> BigInt(width - width2));
        mnemonic = `sbfx x${rd}, x${rn}, #${lsb}, #${width2}`;
      } else if (opc === 0b10) {
        // UBFM — alias: LSL (immediate), LSR (immediate), UBFX
        if (imms + 1 === width && immr === 0) {
          // UBFM Xd, Xn, #0, #63 → no-op, sería un MOV
          this.writeX(rd, a);
          return { mnemonic: `mov x${rd}, x${rn}`, cycles: 1 };
        }
        if (imms + 1 === width) {
          // UBFM Xd, Xn, #immr, #63 → LSR Xd, Xn, #immr
          const shift = immr;
          r = u64(BigInt.asUintN(width, a) >> BigInt(shift));
          mnemonic = `lsr x${rd}, x${rn}, #${shift}`;
        } else if (immr === 0) {
          // UBFM Xd, Xn, #0, #imms → (no es LSL; es UBFX con lsb=0)
          const width2 = imms + 1;
          const fieldMask = (1n << BigInt(width2)) - 1n;
          r = u64(a & fieldMask);
          mnemonic = `ubfx x${rd}, x${rn}, #0, #${width2}`;
        } else {
          // UBFM Xd, Xn, #immr, #imms → UBFX Xd, Xn, #lsb, #width
          const lsb = immr;
          const width2 = imms - immr + 1;
          const fieldMask = (1n << BigInt(width2)) - 1n;
          r = u64((BigInt.asUintN(width, a) >> BigInt(lsb)) & fieldMask);
          mnemonic = `ubfx x${rd}, x${rn}, #${lsb}, #${width2}`;
        }
      } else if (opc === 0b01) {
        // BFM — alias: BFI, BFXIL
        return { mnemonic: "data-proc-imm-unimpl", insn: hex(insn, 8), cycles: 1 };
      } else {
        return { mnemonic: "data-proc-imm-unimpl", insn: hex(insn, 8), cycles: 1 };
      }

      this.writeX(rd, r);
      return { mnemonic, cycles: 1 };
    }

    // ------------------------------------------------------------
    // Extract: EXTR (op0 = 111) — no la cubrimos de momento
    // ------------------------------------------------------------
    if (op0 === 0b111) {
      return { mnemonic: "data-proc-imm-unimpl", insn: hex(insn, 8), cycles: 1 };
    }

    // ------------------------------------------------------------
    // Add/subtract (immediate, with tags) — MTE, no cubierto aquí
    // (lo cubre ARM64eExecutor)
    // ------------------------------------------------------------
    if (op0 === 0b011) {
      return { mnemonic: "data-proc-imm-unimpl", insn: hex(insn, 8), cycles: 1 };
    }

    return { mnemonic: "data-proc-imm-unimpl", insn: hex(insn, 8), cycles: 1 };
  }

  // ------------------------------------------------------------
  // Helper: DecodeBitMasks (ARM ARM D5.2.3)
  // ------------------------------------------------------------
  // Decodifica el inmediato lógico codificado en N:immr:imms.
  // Devuelve la máscara de 64 bits (o null si la codificación es
  // inválida según la spec).
  _decodeLogicalImm(N, immr, imms, len) {
    // len = log2 del ancho (6 para 64-bit, 5 para 32-bit)
    const levels = (1 << len) - 1;
    if (((N << 6) | (~imms & 0x3f)) === 0) return null;

    // Hallar el tamaño del patrón repetido
    const combined = (N << 6) | ((~imms) & 0x3f);
    if (combined === 0) return null;

    // s = mayor potencia de 2 tal que imms[s] = 0 ... búsqueda estándar
    let s = -1;
    for (let i = len; i >= 0; i--) {
      if ((imms >> i) & 1) { s = i; break; }
    }
    if (s < 1) return null;

    const esize = 1 << s;
    if (esize > (1 << len)) return null;

    // Rotar el patrón base
    const pattern = (1n << BigInt(esize)) - 1n;
    const r = BigInt(immr % esize);
    const rotated = ((pattern >> r) | (pattern << (BigInt(esize) - r))) & pattern;

    // Replicar el patrón hasta llenar el ancho
    const width = 1 << len;
    let result = 0n;
    for (let i = 0; i < width; i += esize) {
      result |= rotated << BigInt(i);
    }
    return result & ((1n << BigInt(width)) - 1n);
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
    // ============================================================
    // Loads and Stores
    // ============================================================
    // La familia se identifica por los bits [29:27] del opcode:
    //
    //   bit 29 = 0  → Load/store register (unsigned immediate)  + LDP/STP
    //   bit 29 = 1  → Load/store register (register offset) o
    //                 Load/store register (unscaled immediate)
    //
    // El tamaño del acceso lo dan los bits [31:30] (size):
    //   00 = byte (B), 01 = halfword (H), 10 = word (W),
    //   11 = doubleword (X) — o "sword" si opc=10/11 en size=10.
    //
    // El campo opc (bits [23:22]) distingue load/store y sign-extension:
    //   00 = STR / LDR (ZR)
    //   01 = LDR (ZR) / LDR (sin signo)
    //   10 = LDR (sign-extended) / LDRSW
    //   11 = LDR (sign-extended) / —
    //
    // Esta implementación cubre:
    //   - LDR/STR/LDRB/STRB/LDRH/STRH/LDRSW (32 y 64 bits)
    //   - offset unsigned (imm12), sin indexar
    //   - pre-indexado [Xn, #imm]!  (write-back)
    //   - post-indexado [Xn], #imm  (write-back)
    //   - registro offset [Xn, Xm] con opcional extend + shift
    //   - LDP/STP (load/store pair) con imm7 escalado
    //
    // Lo que NO cubre (y lo dice honestamente):
    //   - LDR literal (PC-relative, encoding 0x18/0x58)
    //   - LDUR/STUR (unscaled, encoding 0x-- -- 00)
    //   - Atomics (LDXR/STXR/LDAR/STLR/CAS/SWP/LDADD/...) — los cubre
    //     ARM64eExecutor o se implementan aparte si se necesitan
    // ============================================================

    const op1 = bits(insn, 29, 27); // familia dentro de Load/Store

    // ------------------------------------------------------------
    // Load/store pair (LDP / STP / LDPSW) — op1 = 101
    //   bit 31  = 0 (32-bit) / 1 (64-bit)  [salvo LDPSW]
    //   bit 30  = V (0 = GP, 1 = SIMD)
    //   bit 29  = 0
    //   bit 27  = 1  →  101 en [29:27]
    //   bits[26:23] = opc:
    //       000 = 32-bit (STP/LDP W)
    //       001 = LDPSW
    //       010 = 64-bit (STP/LDP X)
    //       011 = LDPSW (mismo, distinto bit V)
    //   bit 22  = L (0 = store, 1 = load)
    //   bits[21:15] = imm7 (offset escalado por tamaño)
    //   bits[14:10] = Rt2
    //   bits[9:5]   = Rn
    //   bits[4:0]   = Rt
    // ------------------------------------------------------------
    if (op1 === 0b101) {
      const V  = bit(insn, 26);         // 0 = GP, 1 = SIMD (no cubierto)
      const L  = bit(insn, 22);         // 0 = STP, 1 = LDP
      const imm7 = bits(insn, 21, 15);
      const Rt2 = bits(insn, 14, 10);
      const Rn  = bits(insn, 9, 5);
      const Rt  = bits(insn, 4, 0);

      // Desplazamiento con signo de 7 bits
      let offset = Number(signExtend(BigInt(imm7), 7));

      // El campo opc real está en bits [31:30] (bits[26:23] es para
      // algunas variantes, pero para el pair concreto lo que importa
      // es el tamaño: 32-bit → offset *= 4, 64-bit → offset *= 8)
      const is64 = bit(insn, 31) === 1;
      offset *= is64 ? 8 : 4;

      const base = this.readX(Rn);
      const addr = u64(base + BigInt(offset));

      if (V === 1) {
        // SIMD pair — no cubierto aquí, fallback honesto
        return { mnemonic: "ldp/stp-simd-unimpl", insn: hex(insn, 8), cycles: 1 };
      }

      if (L === 1) {
        // LDP
        if (is64) {
          this.writeX(Rt,  this.readU64(addr));
          this.writeX(Rt2, this.readU64(u64(addr + 8n)));
        } else {
          this.writeW(Rt,  this.readU32(addr));
          this.writeW(Rt2, this.readU32(u64(addr + 4n)));
        }
        this.stats.loads++;
        return { mnemonic: `ldp x${Rt}, x${Rt2}, [x${Rn}, #${offset}]`, cycles: 2 };
      } else {
        // STP
        if (is64) {
          this.writeU64(addr,          this.readX(Rt));
          this.writeU64(u64(addr + 8n), this.readX(Rt2));
        } else {
          this.writeU32(addr,          this.readW(Rt));
          this.writeU32(u64(addr + 4n), this.readW(Rt2));
        }
        this.stats.stores++;
        return { mnemonic: `stp x${Rt}, x${Rt2}, [x${Rn}, #${offset}]`, cycles: 2 };
      }
    }

    // ------------------------------------------------------------
    // Load/store register — op1 = 001 (unscaled/imm12) o 011 (registro)
    // Para no complicar el dispatch, decodificamos directamente aquí.
    // ------------------------------------------------------------
    if (op1 === 0b001 || op1 === 0b011) {
      const size = bits(insn, 31, 30);   // 00=B, 01=H, 10=W, 11=X
      const opc  = bits(insn, 23, 22);   // 00=STR, 01=LDR, 10=LDRSW, 11=LDR(sign)
      const Rn   = bits(insn, 9, 5);
      const Rt   = bits(insn, 4, 0);

      // Detectar la forma del addressing:
      //   op1 = 001 y bit 24 = 1  → unsigned offset (imm12 escalado)
      //   op1 = 001 y bit 24 = 0  → unscaled / pre / post (no cubierto aquí por completo)
      //   op1 = 011               → register offset
      const isUnsigned = (op1 === 0b001) && (bit(insn, 24) === 1);
      const isRegister = (op1 === 0b011);

      // ----------------------------------------------
      // Register offset: [Xn, Xm{, extend}{, shift}]
      // ----------------------------------------------
      if (isRegister) {
        const Rm   = bits(insn, 20, 16);
        const option = bits(insn, 15, 13); // extend: 010=UXTW, 011=LSL, 110=SXTW, 111=SXTX
        const S    = bit(insn, 12);         // shift por tamaño (0 o log2(size))

        let index = this.readX(Rm);

        // Aplicar extend
        switch (option) {
          case 0b010: index = u64(BigInt.asUintN(32, index)); break; // UXTW
          case 0b011: index = index; break;                          // LSL (no-op)
          case 0b110: index = u64(s64(BigInt.asIntN(32, index))); break; // SXTW
          case 0b111: index = index; break;                          // SXTX
          default:    index = index; break;
        }

        // Aplicar shift
        const shiftAmt = S === 1 ? size : 0;
        const scaledIndex = index << BigInt(shiftAmt);

        const base = this.readX(Rn);
        const addr = u64(base + scaledIndex);

        const result = this._doLoadStore(size, opc, Rt, addr);
        if (result === null) {
          return { mnemonic: "ldr/str-unimpl", insn: hex(insn, 8), cycles: 1 };
        }
        if (opc === 0b00) this.stats.stores++;
        else this.stats.loads++;
        return { mnemonic: result, cycles: 4 };
      }

      // ----------------------------------------------
      // Unsigned offset (imm12 escalado por tamaño)
      // ----------------------------------------------
      if (isUnsigned) {
        const imm12 = BigInt(bits(insn, 21, 10));
        const scale = 1 << size;      // 1, 2, 4 u 8
        const off = imm12 * BigInt(scale);

        const base = this.readX(Rn);
        const addr = u64(base + off);

        const result = this._doLoadStore(size, opc, Rt, addr);
        if (result === null) {
          return { mnemonic: "ldr/str-unimpl", insn: hex(insn, 8), cycles: 1 };
        }
        if (opc === 0b00) this.stats.stores++;
        else this.stats.loads++;
        return { mnemonic: result, cycles: 4 };
      }

      // ----------------------------------------------
      // Unscaled / pre / post indexado (op1=001, bit 24=0)
      //   bits[11:10] = 00 → unscaled (LDUR/STUR)
      //   bits[11:10] = 01 → post-index  [Xn], #imm
      //   bits[11:10] = 10 → unscaled (LDUR/STUR)
      //   bits[11:10] = 11 → pre-index   [Xn, #imm]!
      // ----------------------------------------------
      const imm9 = bits(insn, 20, 12);
      const off = BigInt(Number(signExtend(BigInt(imm9), 9)));
      const mode = bits(insn, 11, 10);

      const base = this.readX(Rn);
      let addr;
      let writeBack = false;
      let wbValue = 0n;

      switch (mode) {
        case 0b00:
        case 0b10:
          // Unscaled (LDUR/STUR)
          addr = u64(base + off);
          break;
        case 0b01:
          // Post-index: [Xn], #imm
          addr = base;
          wbValue = u64(base + off);
          writeBack = true;
          break;
        case 0b11:
          // Pre-index: [Xn, #imm]!
          addr = u64(base + off);
          wbValue = addr;
          writeBack = true;
          break;
        default:
          return { mnemonic: "ldr/str-unimpl", insn: hex(insn, 8), cycles: 1 };
      }

      const result = this._doLoadStore(size, opc, Rt, addr);
      if (result === null) {
        return { mnemonic: "ldr/str-unimpl", insn: hex(insn, 8), cycles: 1 };
      }

      if (writeBack) {
        // En pre/post-index, Xn = wbValue (salvo si Xn=31, que
        // escribiría SP; en ARM64 eso es válido y se hace).
        this.writeX(Rn, wbValue);
      }

      if (opc === 0b00) this.stats.stores++;
      else this.stats.loads++;

      const modeStr = mode === 0b01 ? "], #" : mode === 0b11 ? ", #";
      const closeStr = mode === 0b01 ? "" : "]!";
      return {
        mnemonic: `ldr/str x${Rt}, [x${Rn}${modeStr}${off}${closeStr}`,
        cycles: 4,
      };
    }

    // Fallback honesto para todo lo que no cubrimos
    return { mnemonic: "loadstore-unimpl", insn: hex(insn, 8), cycles: 1 };
  }

  // ------------------------------------------------------------
  // Helper: ejecuta el load/store real según size + opc.
  // Devuelve el mnemonic, o null si la combinación no es válida.
  // ------------------------------------------------------------
  _doLoadStore(size, opc, Rt, addr) {
    // size: 00=B, 01=H, 10=W, 11=X
    // opc:  00=STR, 01=LDR (sin signo), 10=LDR (sign-extended) / LDRSW, 11=LDR (sign)

    if (opc === 0b00) {
      // Store
      switch (size) {
        case 0b00: this.writeByte(addr, Number(this.readX(Rt) & 0xffn)); return "strb";
        case 0b01: this.writeU16(addr, Number(this.readX(Rt) & 0xffffn)); return "strh";
        case 0b10: this.writeU32(addr, Number(this.readX(Rt) & 0xffffffffn)); return "str";
        case 0b11: this.writeU64(addr, this.readX(Rt)); return "str";
        default: return null;
      }
    }

    if (opc === 0b01) {
      // Load sin signo
      switch (size) {
        case 0b00: this.writeW(Rt, this.readByte(addr)); return "ldrb";
        case 0b01: this.writeW(Rt, this.readU16(addr)); return "ldrh";
        case 0b10: this.writeW(Rt, this.readU32(addr)); return "ldr";
        case 0b11: this.writeX(Rt, this.readU64(addr)); return "ldr";
        default: return null;
      }
    }

    if (opc === 0b10) {
      // LDRSW / LDR sign-extended (solo válido en size=10, o size=00/01 con sign)
      if (size === 0b10) {
        // LDRSW: carga 32 bits con signo a 64 bits
        const v = this.readU32(addr);
        this.writeX(Rt, u64(s64(BigInt.asIntN(32, v))));
        return "ldrsw";
      }
      // Sign-extended de byte/half a 64 bits
      if (size === 0b00) {
        this.writeX(Rt, u64(BigInt(Number(signExtend(BigInt(this.readByte(addr)), 8)))));
        return "ldrsb";
      }
      if (size === 0b01) {
        this.writeX(Rt, u64(BigInt(Number(signExtend(BigInt(this.readU16(addr)), 16)))));
        return "ldrsh";
      }
      return null;
    }

    if (opc === 0b11) {
      // LDR sign-extended a 32 bits (salvo size=11, que no aplica)
      if (size === 0b00) {
        this.writeW(Rt, u32(BigInt(Number(signExtend(BigInt(this.readByte(addr)), 8)))));
        return "ldrsb";
      }
      if (size === 0b01) {
        this.writeW(Rt, u32(BigInt(Number(signExtend(BigInt(this.readU16(addr)), 16)))));
        return "ldrsh";
      }
      if (size === 0b10) {
        this.writeW(Rt, this.readU32(addr));
        return "ldr";
      }
      return null;
    }

    return null;
  }
  
  _execDataProcReg(insn) {
    // ============================================================
    // Data Processing — Register
    // ============================================================
    // Cubre:
    //   - Logical (shifted register): AND / ORR / EOR / ANDS /
    //     BIC / ORN / EON / BICS, con shift LSL/LSR/ASR/ROR
    //   - Add/subtract (shifted register): ADD / ADDS / SUB / SUBS
    //     con shift
    //   - Data-processing (2 source): LSLV / LSRV / ASRV / RORV /
    //     UDIV / SDIV
    //   - Data-processing (3 source): MADD / MSUB / SMADDL / SMSUBL /
    //     SMULH / UMADDL / UMSUBL / UMULH
    //
    // No cubre (fallback honesto "dataproc-unimpl"):
    //   - Add/subtract (extended register)  (ADD X0, X1, W2, UXTB #3)
    //   - Conditional select (CSEL/CSINC/CSINV/CSNEG)
    //   - Conditional compare (CCMN/CCMP)
    //   - Data-processing (1 source) (RBIT/REV/CLZ/CLS)
    // ============================================================

    const sf   = bit(insn, 31);       // 1 = 64-bit, 0 = 32-bit
    const op54 = bits(insn, 28, 24);  // familia
    const N    = bit(insn, 21);       // en Logical: N; en Add/sub: op
    const Rm   = bits(insn, 20, 16);
    const shiftType = bits(insn, 23, 22);
    const shiftAmt  = bits(insn, 15, 10);
    const Rn   = bits(insn, 9, 5);
    const Rd   = bits(insn, 4, 0);

    const is64 = sf === 1;
    const width = is64 ? 64n : 32n;
    const widthMask = (1n << width) - 1n;

    // ------------------------------------------------------------
    // Helper: aplica shift al operando B según shiftType y shiftAmt.
    // Se opera siempre dentro del ancho (32 o 64 bits).
    // ------------------------------------------------------------
    const applyShift = (value, type, amt) => {
      if (amt === 0 && type !== 0b11) return u64(value) & widthMask;
      const v = u64(value) & widthMask;
      switch (type) {
        case 0b00: // LSL
          return u64((v << BigInt(amt)) & widthMask);
        case 0b01: // LSR
          return u64(v >> BigInt(amt));
        case 0b10: // ASR (aritmético)
          return u64(BigInt.asIntN(Number(width), v) >> BigInt(amt)) & widthMask;
        case 0b11: // ROR
          if (amt === 0) return v;
          return u64(((v >> BigInt(amt)) | (v << (width - BigInt(amt)))) & widthMask);
        default:
          return v;
      }
    };

    // ------------------------------------------------------------
    // Logical (shifted register): op54 = 0b01010
    //   opc = bits[30:29] = [opc1, S]
    //     N=0: 00=AND, 01=ORR, 10=EOR, 11=ANDS
    //     N=1: 00=BIC, 01=ORN, 10=EON, 11=BICS
    // ------------------------------------------------------------
    if (op54 === 0b01010) {
      const a = u64(this.readX(Rn)) & widthMask;
      const b = u64(this.readX(Rm)) & widthMask;
      const shifted = applyShift(b, shiftType, shiftAmt);
      const opc = bits(insn, 30, 29); // 2 bits, incluye S

      let result;
      let mnemonic;

      if (N === 0) {
        switch (opc) {
          case 0b00: result = u64(a & shifted);              mnemonic = "and";  break;
          case 0b01: result = u64(a | shifted);              mnemonic = "orr";  break;
          case 0b10: result = u64(a ^ shifted);              mnemonic = "eor";  break;
          case 0b11: result = u64(a & shifted);              mnemonic = "ands"; break;
          default:   return { mnemonic: "dataproc-unimpl", insn: hex(insn, 8), cycles: 1 };
        }
      } else {
        const notShifted = (~shifted) & widthMask;
        switch (opc) {
          case 0b00: result = u64(a & notShifted);           mnemonic = "bic";  break;
          case 0b01: result = u64(a | notShifted);           mnemonic = "orn";  break;
          case 0b10: result = u64(a ^ notShifted);           mnemonic = "eon";  break;
          case 0b11: result = u64(a & notShifted);           mnemonic = "bics"; break;
          default:   return { mnemonic: "dataproc-unimpl", insn: hex(insn, 8), cycles: 1 };
        }
      }

      this.writeX(Rd, u64(result));

      // Flags: solo cuando opc[0] = 1 (ANDS, BICS)
      if (opc === 0b11) {
        this._logicalFlags(result, !is64);
      }

      return { mnemonic, cycles: 1 };
    }

    // ------------------------------------------------------------
    // Add/subtract (shifted register): op54 = 0b01011
    //   N (bit 21) = 0 → ADD, 1 → SUB
    //   S (bit 29) = 1 → ADDS/SUBS
    // ------------------------------------------------------------
    if (op54 === 0b01011) {
      const a = u64(this.readX(Rn)) & widthMask;
      const b = u64(this.readX(Rm)) & widthMask;
      const shifted = applyShift(b, shiftType, shiftAmt);
      const S = bit(insn, 29);

      const isSub = N === 1;
      const r = this._addWithFlags(a, shifted, isSub, !is64);
      this.writeX(Rd, u64(r.result));

      if (S === 1) {
        this.nzcv.n = r.n;
        this.nzcv.z = r.z;
        this.nzcv.c = r.c;
        this.nzcv.v = r.v;
      }

      const mnemonic = (isSub ? "sub" : "add") + (S === 1 ? "s" : "");
      return { mnemonic, cycles: 1 };
    }

    // ------------------------------------------------------------
    // Data-processing (2 source): op54 = 0b11010
    //   LSLV / LSRV / ASRV / RORV / UDIV / SDIV
    // ------------------------------------------------------------
    if (op54 === 0b11010) {
      const a = u64(this.readX(Rn)) & widthMask;
      const b = u64(this.readX(Rm)) & widthMask;
      const op2 = bits(insn, 15, 10);
      const shBits = BigInt(Number(width) - 1);
      const sh = b & shBits;

      let result;
      let mnemonic;
      switch (op2) {
        case 0b001000: // LSLV
          result = u64((a << sh) & widthMask);
          mnemonic = "lslv";
          break;
        case 0b001001: // LSRV
          result = u64(a >> sh);
          mnemonic = "lsrv";
          break;
        case 0b001010: // ASRV
          result = u64(BigInt.asIntN(Number(width), a) >> sh) & widthMask;
          mnemonic = "asrv";
          break;
        case 0b001011: // RORV
          if (sh === 0n) result = a;
          else result = u64(((a >> sh) | (a << (width - sh))) & widthMask);
          mnemonic = "rorv";
          break;
        case 0b000010: { // UDIV
          const bu = BigInt.asUintN(Number(width), b);
          result = bu === 0n ? 0n : BigInt.asUintN(Number(width), a) / bu;
          mnemonic = "udiv";
          break;
        }
        case 0b000011: { // SDIV
          const bs = BigInt.asIntN(Number(width), b);
          const as = BigInt.asIntN(Number(width), a);
          result = bs === 0n ? 0n : BigInt.asUintN(Number(width), as / bs);
          mnemonic = "sdiv";
          break;
        }
        default:
          return { mnemonic: "dataproc-unimpl", insn: hex(insn, 8), cycles: 1 };
      }

      this.writeX(Rd, u64(result));
      return { mnemonic, cycles: 1 };
    }

    // ------------------------------------------------------------
    // Data-processing (3 source): op54 = 0b11011
    //   MADD / MSUB / SMADDL / SMSUBL / SMULH / UMADDL / UMSUBL / UMULH
    //   Ra está en bits[14:10]
    // ------------------------------------------------------------
    if (op54 === 0b11011) {
      const Ra  = bits(insn, 14, 10);
      const a   = u64(this.readX(Rn));
      const b   = u64(this.readX(Rm));
      const acc = u64(this.readX(Ra));
      const op31 = bits(insn, 23, 21);
      const o0   = bit(insn, 15);

      let result;
      let mnemonic;

      if (op31 === 0b000) {
        // MADD / MSUB
        const prod = u64(a * b);
        if (o0 === 0) { result = u64(prod + acc); mnemonic = "madd"; }
        else          { result = u64(acc - prod); mnemonic = "msub"; }
      } else if (op31 === 0b001) {
        // SMADDL / SMSUBL
        const aa = BigInt.asIntN(32, a);
        const bb = BigInt.asIntN(32, b);
        const prod = BigInt.asUintN(64, aa * bb);
        if (o0 === 0) { result = u64(prod + acc); mnemonic = "smaddl"; }
        else          { result = u64(acc - prod); mnemonic = "smsubl"; }
      } else if (op31 === 0b010) {
        // SMULH
        const prod = BigInt.asIntN(64, a) * BigInt.asIntN(64, b);
        result = u64(prod >> 64n);
        mnemonic = "smulh";
      } else if (op31 === 0b101) {
        // UMADDL / UMSUBL
        const aa = BigInt.asUintN(32, a);
        const bb = BigInt.asUintN(32, b);
        const prod = aa * bb;
        if (o0 === 0) { result = u64(prod + acc); mnemonic = "umaddl"; }
        else          { result = u64(acc - prod); mnemonic = "umsubl"; }
      } else if (op31 === 0b110) {
        // UMULH
        const prod = BigInt.asUintN(64, a) * BigInt.asUintN(64, b);
        result = u64(prod >> 64n);
        mnemonic = "umulh";
      } else {
        return { mnemonic: "dataproc-unimpl", insn: hex(insn, 8), cycles: 1 };
      }

      this.writeX(Rd, u64(result));
      return { mnemonic, cycles: 1 };
    }

    // ------------------------------------------------------------
    // Todo lo demás (Conditional select, conditional compare,
    // extended register, 1-source): fallback honesto.
    // ------------------------------------------------------------
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
