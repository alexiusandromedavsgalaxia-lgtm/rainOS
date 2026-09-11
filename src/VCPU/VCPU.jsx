// ============================================================================
// vcpu.jsx — CPU virtual de 64 bits
// ----------------------------------------------------------------------------
// Implementa una CPU virtual completa con:
//
// 1. ISA (Instruction Set Architecture)
//    - Registros de propósito general de 64 bits (16 registros)
//    - Registro de flags (ZF, SF, OF, CF, PF, IF, DF, TF)
//    - Program Counter (PC / RIP)
//    - Stack Pointer (SP / RSP)
//    - Base Pointer (BP / RBP)
//    - Instruction Pointer (IP)
//    - Modos de direccionamiento (inmediato, registro, memoria, indirecto)
//
// 2. INSTRUCCIONES
//    - Aritméticas: ADD, SUB, MUL, DIV, MOD, INC, DEC, NEG, ABS
//    - Lógicas: AND, OR, XOR, NOT, SHL, SHR, SAR, ROL, ROR
//    - Comparación: CMP, TEST
//    - Movimiento: MOV, LEA, XCHG, PUSH, POP
//    - Control de flujo: JMP, JE, JNE, JG, JGE, JL, JLE, CALL, RET, LOOP
//    - Bit: BT, BTS, BTR, BSR, BSF, POPCNT, LZCNT, TZCNT
//    - Enteros: MUL/DIV con signo y sin signo
//    - Aritmética decimal: BCD (opcional)
//
// 3. SUBCONJUNTO FPU (x87-like)
//    - Registros ST(0..7) de 80 bits
//    - ADD, SUB, MUL, DIV, SQRT, SIN, COS, TAN, LOG, EXP
//    - Conversion to/from int
//    - Comparaciones FPU (FCOM, FCOMP, FUCOM)
//    - Control word (rounding mode, precision)
//
// 4. SIMD (SSE-like)
//    - Registros XMM0..XMM15 de 128 bits
//    - Operaciones: ADDPS, SUBPS, MULPS, DIVPS, ANDPS, ORPS, XORPS
//    - MOVAPS, MOVUPS, MOVDQA, MOVDQU
//    - SHUFPS, UNPCKLPS, UNPCKHPS
//    - CMPPS (con predicados)
//    - Conversión INT ↔ FP
//
// 5. PIPELINE
//    - 5 etapas: Fetch, Decode, Execute, Memory, Writeback
//    - Hazards: RAW, WAR, WAW, estructurales
//    - Forwarding entre etapas
//    - Branch prediction (2-bit saturating counter)
//    - Speculative execution (con rollback)
//    - Stall detection y bubbles
//    - Superscalar (hasta N instrucciones por ciclo)
//
// 6. CACHÉ
//    - L1I (instrucciones), L1D (datos): 32 KB, 8-way
//    - L2 unificada: 256 KB, 8-way
//    - L3 unificada: 8 MB, 16-way (simulada)
//    - Políticas: LRU, write-back, write-allocate
//    - Coherencia MESI (simulada)
//    - Estadísticas de hit/miss por nivel
//
// 7. MMU (Memory Management Unit)
//    - Traducción de direcciones virtuales a físicas
//    - Tabla de páginas de 4 niveles (PML4, PDPT, PD, PT)
//    - TLB (Translation Lookaside Buffer) con 64 entradas
//    - Page faults (#PF) y protección
//    - Acceso a memoria vía MemoryBus
//
// 8. MEMORY BUS
//    - Memoria física simulada (4 GB por defecto)
//    - Memoria virtual por proceso
//    - Big/little endian configurable
//    - Lectura/escritura alineadas y no alineadas
//    - Memory-mapped I/O (para GPU y periféricos)
//
// 9. INTERRUPCIONES Y EXCEPCIONES
//    - Interrupt Descriptor Table (IDT)
//    - Interrupts: IRQ0 (timer), IRQ1 (keyboard), IRQ4 (serial)
//    - Excepciones: #DE (divide), #PF (page fault), #GP (general protection),
//      #UD (undefined instruction), #BP (breakpoint)
//    - Interrupt masking (IF flag)
//    - Nested interrupts
//
// 10. INTEGRACIÓN CON EL SCHEDULER
//     - Cada Thread del scheduler corre sobre una VCPU
//     - Context switch → guarda/restaura registros de la VCPU
//     - El scheduler decide cuándo ceder el control
//     - La VCPU notifica al scheduler al terminar un quantum
//     - Soporte de hilos cooperativos y preemptivos
//
// 11. DEBUGGER
//     - Breakpoints por PC
//     - Watchpoints por dirección de memoria
//     - Step by step (paso a paso)
//     - Volcado de registros y memoria
//     - Trace de ejecución (ring buffer)
//
// 12. EVENTOS
//     - Todos los eventos del sistema (fetch, decode, execute, writeback,
//       cache hit/miss, page fault, interrupt, exception, syscall, ...)
//
// El módulo NO renderiza UI. Es lógica pura + provider + hooks.
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
import { THREAD_STATE, SCHEDULER_EVENTS } from "../scheduler/scheduler.jsx";

// ============================================================================
// 1. CONSTANTES
// ============================================================================

export const ARCH = Object.freeze({
  BITS: 64,
  REGISTERS: 16,
  FPU_REGISTERS: 8,
  SIMD_REGISTERS: 16,
  SIMD_WIDTH: 128,
  ADDRESS_BITS: 48,
  PAGE_SIZE: 4096,
  PML4_ENTRIES: 512,
  PDPT_ENTRIES: 512,
  PD_ENTRIES: 512,
  PT_ENTRIES: 512,
  CACHE_LINE: 64,
});

export const VCPU_STATE = Object.freeze({
  OFFLINE: "offline",
  IDLE: "idle",
  FETCH: "fetch",
  DECODE: "decode",
  EXECUTE: "execute",
  MEMORY: "memory",
  WRITEBACK: "writeback",
  HALTED: "halted",
  PANIC: "panic",
  WAITING_IRQ: "waiting-irq",
});

export const PIPELINE_STAGE = Object.freeze({
  FETCH: "fetch",
  DECODE: "decode",
  EXECUTE: "execute",
  MEMORY: "memory",
  WRITEBACK: "writeback",
});

export const OPCODE = Object.freeze({
  NOP: 0x00,
  HLT: 0x01,
  MOV: 0x02,
  MOVI: 0x03,
  ADD: 0x04,
  ADDI: 0x05,
  SUB: 0x06,
  SUBI: 0x07,
  MUL: 0x08,
  MULI: 0x09,
  DIV: 0x0a,
  DIVI: 0x0b,
  MOD: 0x0c,
  MODI: 0x0d,
  INC: 0x0e,
  DEC: 0x0f,
  NEG: 0x10,
  ABS: 0x11,
  AND: 0x12,
  ANDI: 0x13,
  OR: 0x14,
  ORI: 0x15,
  XOR: 0x16,
  XORI: 0x17,
  NOT: 0x18,
  SHL: 0x19,
  SHLI: 0x1a,
  SHR: 0x1b,
  SHRI: 0x1c,
  SAR: 0x1d,
  SARI: 0x1e,
  ROL: 0x1f,
  ROR: 0x20,
  CMP: 0x21,
  CMPI: 0x22,
  TEST: 0x23,
  TESTI: 0x24,
  JMP: 0x25,
  JE: 0x26,
  JNE: 0x27,
  JG: 0x28,
  JGE: 0x29,
  JL: 0x2a,
  JLE: 0x2b,
  JA: 0x2c,
  JAE: 0x2d,
  JB: 0x2e,
  JBE: 0x2f,
  CALL: 0x30,
  RET: 0x31,
  PUSH: 0x32,
  POP: 0x33,
  LEA: 0x34,
  XCHG: 0x35,
  LOAD: 0x36,
  STORE: 0x37,
  LOADB: 0x38,
  STOREB: 0x39,
  LOADW: 0x3a,
  STOREW: 0x3b,
  LOADD: 0x3c,
  STORED: 0x3d,
  LOADQ: 0x3e,
  STOREQ: 0x3f,
  SYSCALL: 0x40,
  INT: 0x41,
  IRET: 0x42,
  CLI: 0x43,
  STI: 0x44,
  // FPU
  FADD: 0x50,
  FSUB: 0x51,
  FMUL: 0x52,
  FDIV: 0x53,
  FSQRT: 0x54,
  FSIN: 0x55,
  FCOS: 0x56,
  FTAN: 0x57,
  FLOG: 0x58,
  FEXP: 0x59,
  FCOM: 0x5a,
  FILD: 0x5b,
  FIST: 0x5c,
  FLD: 0x5d,
  FST: 0x5e,
  // SIMD
  ADDPS: 0x60,
  SUBPS: 0x61,
  MULPS: 0x62,
  DIVPS: 0x63,
  ANDPS: 0x64,
  ORPS: 0x65,
  XORPS: 0x66,
  MOVPS: 0x67,
  SHUFPS: 0x68,
  CMPPS: 0x69,
  CVTPS2PI: 0x6a,
  CVTPI2PS: 0x6b,
  // Bit manipulation
  BT: 0x70,
  BTS: 0x71,
  BTR: 0x72,
  BSF: 0x73,
  BSR: 0x74,
  POPCNT: 0x75,
  LZCNT: 0x76,
  TZCNT: 0x77,
  BSWAP: 0x78,
  // Atomic
  LOCK: 0x80,
  CMPXCHG: 0x81,
  XADD: 0x82,
  // Misc
  CPUID: 0x90,
  RDTSC: 0x91,
  PAUSE: 0x92,
});

export const CONDITION = Object.freeze({
  E: "e",   // equal (ZF=1)
  NE: "ne", // not equal
  G: "g",   // greater (signed)
  GE: "ge",
  L: "l",
  LE: "le",
  A: "a",   // above (unsigned)
  AE: "ae",
  B: "b",
  BE: "be",
  Z: "z",
  NZ: "nz",
  C: "c",   // carry
  NC: "nc",
  O: "o",   // overflow
  NO: "no",
});

export const EXCEPTION = Object.freeze({
  DE: "divide-error",           // #DE
  DB: "debug",                  // #DB
  BP: "breakpoint",             // #BP
  OF: "overflow",               // #OF
  BR: "bound-range",            // #BR
  UD: "undefined-instruction",  // #UD
  NM: "device-not-available",   // #NM
  DF: "double-fault",           // #DF
  GP: "general-protection",     // #GP
  PF: "page-fault",             // #PF
  AC: "alignment-check",        // #AC
  XF: "simd-exception",         // #XF
});

export const INTERRUPT = Object.freeze({
  IRQ0_TIMER: 0,
  IRQ1_KEYBOARD: 1,
  IRQ2_CASCADE: 2,
  IRQ3_SERIAL2: 3,
  IRQ4_SERIAL1: 4,
  IRQ5_PARALLEL2: 5,
  IRQ6_FLOPPY: 6,
  IRQ7_PARALLEL1: 7,
  IRQ8_RTC: 8,
  IRQ9_ACPI: 9,
  IRQ10_AVAILABLE: 10,
  IRQ11_AVAILABLE: 11,
  IRQ12_MOUSE: 12,
  IRQ13_FPU: 13,
  IRQ14_ATA_PRIMARY: 14,
  IRQ15_ATA_SECONDARY: 15,
  SYSCALL: 0x80,
});

export const VCPU_EVENTS = Object.freeze({
  STARTED: "vcpu:started",
  STOPPED: "vcpu:stopped",
  HALTED: "vcpu:halted",
  PANIC: "vcpu:panic",
  RESET: "vcpu:reset",
  FETCH: "vcpu:fetch",
  DECODE: "vcpu:decode",
  EXECUTE: "vcpu:execute",
  MEMORY: "vcpu:memory",
  WRITEBACK: "vcpu:writeback",
  INSTRUCTION_RETIRED: "vcpu:instruction-retired",
  CYCLE: "vcpu:cycle",
  STALL: "vcpu:stall",
  BUBBLE: "vcpu:bubble",
  BRANCH_PREDICT: "vcpu:branch-predict",
  BRANCH_MISPREDICT: "vcpu:branch-mispredict",
  CACHE_HIT: "vcpu:cache-hit",
  CACHE_MISS: "vcpu:cache-miss",
  TLB_HIT: "vcpu:tlb-hit",
  TLB_MISS: "vcpu:tlb-miss",
  PAGE_FAULT: "vcpu:page-fault",
  EXCEPTION: "vcpu:exception",
  INTERRUPT: "vcpu:interrupt",
  IRET: "vcpu:iret",
  SYSCALL: "vcpu:syscall",
  BREAKPOINT: "vcpu:breakpoint",
  WATCHPOINT: "vcpu:watchpoint",
  REGISTER_WRITE: "vcpu:register-write",
  MEMORY_WRITE: "vcpu:memory-write",
  MEMORY_READ: "vcpu:memory-read",
  LOG: "vcpu:log",
});

// ============================================================================
// 2. REGISTROS Y FLAGS
// ============================================================================

const FLAG = {
  CF: 1 << 0,   // Carry
  PF: 1 << 2,   // Parity
  AF: 1 << 4,   // Auxiliary Carry
  ZF: 1 << 6,   // Zero
  SF: 1 << 7,   // Sign
  TF: 1 << 8,   // Trap
  IF: 1 << 9,   // Interrupt Enable
  DF: 1 << 10,  // Direction
  OF: 1 << 11,  // Overflow
};

class RegisterFile {
  constructor() {
    // GPR de 64 bits
    this.gpr = new BigInt64Array(ARCH.REGISTERS);
    // Registros con nombre
    this.named = {
      RAX: 0, RCX: 1, RDX: 2, RBX: 3,
      RSP: 4, RBP: 5, RSI: 6, RDI: 7,
      R8: 8, R9: 9, R10: 10, R11: 11,
      R12: 12, R13: 13, R14: 14, R15: 15,
    };
    // RIP
    this.rip = 0n;
    // Flags
    this.flags = 0;
    // Control registers
    this.cr0 = 0x80000001n;  // paging + protected mode
    this.cr2 = 0n;           // page fault address
    this.cr3 = 0n;           // page directory base
    this.cr4 = 0n;           // control
    // Segment registers
    this.cs = 0x08n;
    this.ds = 0x10n;
    this.es = 0x10n;
    this.fs = 0x10n;
    this.gs = 0x10n;
    this.ss = 0x10n;
    // MSR (Model Specific Registers)
    this.msr = new Map();
  }

  get(name) {
    if (name === "RIP") return this.rip;
    if (name === "RFLAGS") return BigInt(this.flags);
    const idx = this.named[name];
    if (idx === undefined) return 0n;
    return this.gpr[idx];
  }

  set(name, value) {
    const v = BigInt.asIntN(64, BigInt(value));
    if (name === "RIP") {
      this.rip = v;
      return;
    }
    if (name === "RFLAGS") {
      this.flags = Number(v) & 0xffff;
      return;
    }
    const idx = this.named[name];
    if (idx === undefined) return;
    this.gpr[idx] = v;
  }

  getFlag(flag) {
    return (this.flags & flag) !== 0;
  }

  setFlag(flag, value) {
    if (value) this.flags |= flag;
    else this.flags &= ~flag;
  }

  snapshot() {
    const out = {};
    for (const [name, idx] of Object.entries(this.named)) {
      out[name] = this.gpr[idx].toString();
    }
    out.RIP = this.rip.toString();
    out.RFLAGS = "0x" + this.flags.toString(16).padStart(4, "0");
    out.CR0 = this.cr0.toString();
    out.CR2 = this.cr2.toString();
    out.CR3 = this.cr3.toString();
    return out;
  }

  clone() {
    const r = new RegisterFile();
    r.gpr = new BigInt64Array(this.gpr);
    r.rip = this.rip;
    r.flags = this.flags;
    r.cr0 = this.cr0;
    r.cr2 = this.cr2;
    r.cr3 = this.cr3;
    r.cr4 = this.cr4;
    r.cs = this.cs;
    r.ds = this.ds;
    r.es = this.es;
    r.fs = this.fs;
    r.gs = this.gs;
    r.ss = this.ss;
    r.msr = new Map(this.msr);
    return r;
  }
}

class FpuRegisterFile {
  constructor() {
    this.st = new Float64Array(ARCH.FPU_REGISTERS);
    this.top = 0;
    this.control = 0x037f;
    this.status = 0;
    this.tag = 0xffff;
  }

  get(index) {
    const i = (this.top + index) % ARCH.FPU_REGISTERS;
    return this.st[i];
  }

  set(index, value) {
    const i = (this.top + index) % ARCH.FPU_REGISTERS;
    this.st[i] = value;
  }

  push(value) {
    this.top = (this.top - 1) & 7;
    this.st[this.top] = value;
  }

  pop() {
    const v = this.st[this.top];
    this.top = (this.top + 1) & 7;
    return v;
  }

  snapshot() {
    const out = [];
    for (let i = 0; i < ARCH.FPU_REGISTERS; i++) {
      out.push(this.get(i));
    }
    return out;
  }
}

class SimdRegisterFile {
  constructor() {
    this.xmm = new Float32Array(ARCH.SIMD_REGISTERS * 4);
    this.xmmInt = new Int32Array(ARCH.SIMD_REGISTERS * 4);
  }

  getFloat(reg, lane) {
    return this.xmm[reg * 4 + lane];
  }

  setFloat(reg, lane, value) {
    this.xmm[reg * 4 + lane] = value;
  }

  getInt(reg, lane) {
    return this.xmmInt[reg * 4 + lane];
  }

  setInt(reg, lane, value) {
    this.xmmInt[reg * 4 + lane] = value;
  }

  snapshot() {
    return Array.from({ length: ARCH.SIMD_REGISTERS }, (_, i) => {
      const lanes = [];
      for (let l = 0; l < 4; l++) lanes.push(this.getFloat(i, l));
      return lanes;
    });
  }
}

// ============================================================================
// 3. MEMORY BUS
// ============================================================================

class MemoryBus {
  constructor(sizeBytes = 4 * 1024 * 1024 * 1024) {
    // Simulamos RAM con un ArrayBuffer (o mapa de páginas si es grande)
    this.sizeBytes = sizeBytes;
    this.pageSize = ARCH.PAGE_SIZE;
    this.pages = new Map();       // pageIndex → Uint8Array
    this.mmioRegions = new Map(); // vaddr → { read, write, size }
    this.bigEndian = false;
    this.stats = {
      reads: 0,
      writes: 0,
      bytesRead: 0,
      bytesWritten: 0,
    };
  }

  _pageIndex(addr) {
    return Math.floor(Number(addr) / this.pageSize);
  }

  _offset(addr) {
    return Number(addr) % this.pageSize;
  }

  _getPage(pageIndex, create = false) {
    let p = this.pages.get(pageIndex);
    if (!p && create) {
      p = new Uint8Array(this.pageSize);
      this.pages.set(pageIndex, p);
    }
    return p;
  }

  _checkMmio(addr) {
    for (const [base, region] of this.mmioRegions) {
      if (addr >= base && addr < base + region.size) {
        return { region, offset: addr - base };
      }
    }
    return null;
  }

  read8(addr) {
    const mmio = this._checkMmio(addr);
    if (mmio) return mmio.region.read(mmio.offset, 1);
    const page = this._getPage(this._pageIndex(addr));
    const value = page ? page[this._offset(addr)] : 0;
    this.stats.reads++;
    this.stats.bytesRead++;
    return value;
  }

  read16(addr) {
    if (addr % 2 !== 0) {
      // Unaligned access permitido pero más lento (simulado)
    }
    return this.bigEndian
      ? (this.read8(addr) << 8) | this.read8(addr + 1)
      : this.read8(addr) | (this.read8(addr + 1) << 8);
  }

  read32(addr) {
    if (this.bigEndian) {
      return (
        (this.read8(addr) << 24) |
        (this.read8(addr + 1) << 16) |
        (this.read8(addr + 2) << 8) |
        this.read8(addr + 3)
      );
    }
    return (
      this.read8(addr) |
      (this.read8(addr + 1) << 8) |
      (this.read8(addr + 2) << 16) |
      (this.read8(addr + 3) << 24)
    );
  }

  read64(addr) {
    let lo, hi;
    if (this.bigEndian) {
      hi = this.read32(addr);
      lo = this.read32(addr + 4);
    } else {
      lo = this.read32(addr);
      hi = this.read32(addr + 4);
    }
    return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
  }

  write8(addr, value) {
    const mmio = this._checkMmio(addr);
    if (mmio) {
      mmio.region.write(mmio.offset, value, 1);
      this.stats.writes++;
      this.stats.bytesWritten++;
      return;
    }
    const page = this._getPage(this._pageIndex(addr), true);
    page[this._offset(addr)] = value & 0xff;
    this.stats.writes++;
    this.stats.bytesWritten++;
  }

  write16(addr, value) {
    if (this.bigEndian) {
      this.write8(addr, (value >> 8) & 0xff);
      this.write8(addr + 1, value & 0xff);
    } else {
      this.write8(addr, value & 0xff);
      this.write8(addr + 1, (value >> 8) & 0xff);
    }
  }

  write32(addr, value) {
    if (this.bigEndian) {
      this.write8(addr, (value >>> 24) & 0xff);
      this.write8(addr + 1, (value >>> 16) & 0xff);
      this.write8(addr + 2, (value >>> 8) & 0xff);
      this.write8(addr + 3, value & 0xff);
    } else {
      this.write8(addr, value & 0xff);
      this.write8(addr + 1, (value >>> 8) & 0xff);
      this.write8(addr + 2, (value >>> 16) & 0xff);
      this.write8(addr + 3, (value >>> 24) & 0xff);
    }
  }

  write64(addr, value) {
    const v = BigInt(value);
    const lo = Number(v & 0xffffffffn);
    const hi = Number((v >> 32n) & 0xffffffffn);
    if (this.bigEndian) {
      this.write32(addr, hi);
      this.write32(addr + 4, lo);
    } else {
      this.write32(addr, lo);
      this.write32(addr + 4, hi);
    }
  }

  readBytes(addr, length) {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.read8(addr + i);
    return out;
  }

  writeBytes(addr, bytes) {
    for (let i = 0; i < bytes.length; i++) this.write8(addr + i, bytes[i]);
  }

  mapMmio(baseAddr, size, { read, write }) {
    this.mmioRegions.set(baseAddr, { size, read, write });
  }

  unmapMmio(baseAddr) {
    this.mmioRegions.delete(baseAddr);
  }

  snapshot() {
    return {
      ...this.stats,
      pages: this.pages.size,
      mmioRegions: this.mmioRegions.size,
    };
  }
}

// ============================================================================
// 4. CACHÉ
// ============================================================================

class CacheLine {
  constructor(tag, lineSize) {
    this.tag = tag;
    this.data = new Uint8Array(lineSize);
    this.valid = false;
    this.dirty = false;
    this.lastUsed = 0;
    this.mesi = "I"; // Invalid
  }
}

class CacheSet {
  constructor(ways, lineSize) {
    this.ways = ways;
    this.lineSize = lineSize;
    this.lines = Array.from({ length: ways }, () => new CacheLine(0, lineSize));
  }
}

class Cache {
  constructor({
    name,
    sizeBytes,
    ways = 8,
    lineSize = ARCH.CACHE_LINE,
    writePolicy = "write-back",
  }) {
    this.name = name;
    this.sizeBytes = sizeBytes;
    this.ways = ways;
    this.lineSize = lineSize;
    this.writePolicy = writePolicy;
    this.numSets = sizeBytes / (ways * lineSize);
    this.sets = Array.from(
      { length: this.numSets },
      () => new CacheSet(ways, lineSize)
    );
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      writebacks: 0,
    };
    this.ageCounter = 0;
  }

  _decode(addr) {
    const lineAddr = Math.floor(addr / this.lineSize);
    const setIndex = lineAddr % this.numSets;
    const tag = Math.floor(lineAddr / this.numSets);
    return { setIndex, tag };
  }

  read(addr) {
    const { setIndex, tag } = this._decode(addr);
    const set = this.sets[setIndex];
    for (const line of set.lines) {
      if (line.valid && line.tag === tag) {
        line.lastUsed = ++this.ageCounter;
        this.stats.hits++;
        kernelBus.emit(VCPU_EVENTS.CACHE_HIT, {
          cache: this.name,
          addr,
        });
        return true;
      }
    }
    this.stats.misses++;
    kernelBus.emit(VCPU_EVENTS.CACHE_MISS, {
      cache: this.name,
      addr,
    });
    return false;
  }

  write(addr, { dirty = true } = {}) {
    const { setIndex, tag } = this._decode(addr);
    const set = this.sets[setIndex];
    for (const line of set.lines) {
      if (line.valid && line.tag === tag) {
        if (dirty) line.dirty = true;
        line.lastUsed = ++this.ageCounter;
        this.stats.hits++;
        return true;
      }
    }
    this.stats.misses++;
    return false;
  }

  allocate(addr, data = null) {
    const { setIndex, tag } = this._decode(addr);
    const set = this.sets[setIndex];
    // Buscar línea inválida primero
    let victim = set.lines.find((l) => !l.valid);
    if (!victim) {
      // LRU
      victim = set.lines.reduce((a, b) => (a.lastUsed < b.lastUsed ? a : b));
      if (victim.dirty) {
        this.stats.writebacks++;
      }
      this.stats.evictions++;
    }
    victim.tag = tag;
    victim.valid = true;
    victim.dirty = false;
    victim.lastUsed = ++this.ageCounter;
    victim.mesi = "E";
    if (data) victim.data.set(data);
    return victim;
  }

  invalidate(addr) {
    const { setIndex, tag } = this._decode(addr);
    const set = this.sets[setIndex];
    for (const line of set.lines) {
      if (line.valid && line.tag === tag) {
        line.valid = false;
        line.mesi = "I";
      }
    }
  }

  flush() {
    for (const set of this.sets) {
      for (const line of set.lines) {
        line.valid = false;
        line.dirty = false;
        line.mesi = "I";
      }
    }
  }

  snapshot() {
    const total = this.stats.hits + this.stats.misses;
    return {
      name: this.name,
      sizeBytes: this.sizeBytes,
      ways: this.ways,
      sets: this.numSets,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: total > 0 ? this.stats.hits / total : 0,
      evictions: this.stats.evictions,
      writebacks: this.stats.writebacks,
    };
  }
}

class TlbEntry {
  constructor() {
    this.valid = false;
    this.vpn = 0n;
    this.pfn = 0n;
    this.flags = 0;
    this.lastUsed = 0;
  }
}

class Tlb {
  constructor(size = 64) {
    this.size = size;
    this.entries = Array.from({ length: size }, () => new TlbEntry());
    this.age = 0;
    this.stats = { hits: 0, misses: 0 };
  }

  lookup(vpn) {
    for (const e of this.entries) {
      if (e.valid && e.vpn === vpn) {
        e.lastUsed = ++this.age;
        this.stats.hits++;
        return e;
      }
    }
    this.stats.misses++;
    return null;
  }

  insert(vpn, pfn, flags = 0) {
    // Buscar entrada inválida
    let victim = this.entries.find((e) => !e.valid);
    if (!victim) {
      victim = this.entries.reduce((a, b) => (a.lastUsed < b.lastUsed ? a : b));
    }
    victim.valid = true;
    victim.vpn = vpn;
    victim.pfn = pfn;
    victim.flags = flags;
    victim.lastUsed = ++this.age;
  }

  invalidate(vpn) {
    for (const e of this.entries) {
      if (e.valid && e.vpn === vpn) e.valid = false;
    }
  }

  flush() {
    for (const e of this.entries) e.valid = false;
  }

  snapshot() {
    const total = this.stats.hits + this.stats.misses;
    return {
      size: this.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: total > 0 ? this.stats.hits / total : 0,
    };
  }
}

// ============================================================================
// 5. MMU
// ============================================================================

class Mmu {
  constructor(memoryBus) {
    this.memoryBus = memoryBus;
    this.tlb = new Tlb();
    this.pageFaultHandler = null;
    this.stats = {
      translations: 0,
      faults: 0,
    };
  }

  /**
   * Traduce una dirección virtual a física usando la tabla de páginas.
   * En esta simulación simplificada, la tabla se guarda en el propio MMU   * como un mapa (vpn → pfn) por proceso.
   */
  translate(vaddr, { write = false, user = true } = {}) {
    this.stats.translations++;
    const vpn = BigInt(vaddr) >> 12n;

    const tlbEntry = this.tlb.lookup(vpn);
    if (tlbEntry) {
      kernelBus.emit(VCPU_EVENTS.TLB_HIT, { vaddr, vpn: vpn.toString() });
      return (tlbEntry.pfn << 12n) | (BigInt(vaddr) & 0xfffn);
    }

    kernelBus.emit(VCPU_EVENTS.TLB_MISS, { vaddr, vpn: vpn.toString() });

    // Page walk
    const pfn = this._walk(vpn, write, user);
    if (pfn === null) {
      this.stats.faults++;
      kernelBus.emit(VCPU_EVENTS.PAGE_FAULT, { vaddr, write, user });
      throw new CpuException(EXCEPTION.PF, { vaddr, write, user });
    }

    this.tlb.insert(vpn, pfn, write ? 0x2 : 0x0);
    return (pfn << 12n) | (BigInt(vaddr) & 0xfffn);
  }

  _walk(vpn, write, user) {
    // Aquí el MMU tiene un mapa plano por simplicidad.
    // En una implementación real, aquí se leerían PML4/PDPT/PD/PT de la RAM.
    const pfn = this._pageTable?.get(vpn.toString());
    if (pfn === undefined) return null;
    return BigInt(pfn);
  }

  setPageTable(map) {
    this._pageTable = map;
    this.tlb.flush();
  }

  setPage(vpn, pfn) {
    if (!this._pageTable) this._pageTable = new Map();
    this._pageTable.set(vpn.toString(), pfn);
    this.tlb.invalidate(vpn);
  }

  unsetPage(vpn) {
    if (this._pageTable) this._pageTable.delete(vpn.toString());
    this.tlb.invalidate(vpn);
  }

  snapshot() {
    return {
      ...this.stats,
      tlb: this.tlb.snapshot(),
      pages: this._pageTable?.size ?? 0,
    };
  }
}

// ============================================================================
// 6. EXCEPCIONES E INTERRUPCIONES
// ============================================================================

class CpuException extends Error {
  constructor(type, info = {}) {
    super(`CPU exception: ${type}`);
    this.type = type;
    this.info = info;
  }
}

class Idt {
  constructor() {
    this.entries = new Map(); // vector → { handler, dpl, present }
  }

  set(vector, handler, { dpl = 0, present = true } = {}) {
    this.entries.set(vector, { handler, dpl, present });
  }

  get(vector) {
    return this.entries.get(vector);
  }

  has(vector) {
    return this.entries.has(vector);
  }

  clear() {
    this.entries.clear();
  }

  snapshot() {
    return Array.from(this.entries.keys()).sort((a, b) => a - b);
  }
}

// ============================================================================
// 7. PIPELINE
// ============================================================================

class PipelineLatch {
  constructor(name) {
    this.name = name;
    this.valid = false;
    this.instruction = null;
    this.pc = 0n;
    this.data = {};
  }
  clear() {
    this.valid = false;
    this.instruction = null;
    this.data = {};
  }
  latch(instruction, pc, data = {}) {
    this.valid = true;
    this.instruction = instruction;
    this.pc = pc;
    this.data = data;
  }
  toJSON() {
    return {
      name: this.name,
      valid: this.valid,
      pc: this.pc.toString(),
      instruction: this.instruction,
      data: this.data,
    };
  }
}

class BranchPredictor {
  constructor(entries = 4096) {
    this.entries = entries;
    this.counters = new Uint8Array(entries); // 2-bit saturating
    this.targets = new BigInt64Array(entries);
    this.stats = { predictions: 0, mispredicts: 0, correct: 0 };
  }

  _index(pc) {
    return Number(BigInt(pc) & BigInt(this.entries - 1));
  }

  predict(pc) {
    const idx = this._index(pc);
    const counter = this.counters[idx];
    const taken = counter >= 2;
    this.stats.predictions++;
    return {
      taken,
      target: this.targets[idx],
    };
  }

  update(pc, wasTaken, target) {
    const idx = this._index(pc);
    const c = this.counters[idx];
    if (wasTaken) {
      if (c < 3) this.counters[idx] = c + 1;
    } else {
      if (c > 0) this.counters[idx] = c - 1;
    }
    if (wasTaken) this.targets[idx] = BigInt(target);
  }

  recordMispredict() {
    this.stats.mispredicts++;
  }

  recordCorrect() {
    this.stats.correct++;
  }

  snapshot() {
    const total = this.stats.predictions;
    return {
      entries: this.entries,
      predictions: total,
      mispredicts: this.stats.mispredicts,
      correct: this.stats.correct,
      accuracy: total > 0 ? this.stats.correct / total : 0,
    };
  }
}

class Pipeline {
  constructor(vcpu) {
    this.vcpu = vcpu;
    this.IF = new PipelineLatch("IF");
    this.ID = new PipelineLatch("ID");
    this.EX = new PipelineLatch("EX");
    this.MEM = new PipelineLatch("MEM");
    this.WB = new PipelineLatch("WB");
    this.stalls = 0;
    this.bubbles = 0;
  }

  clear() {
    this.IF.clear();
    this.ID.clear();
    this.EX.clear();
    this.MEM.clear();
    this.WB.clear();
  }

  advance() {
    // WB ← MEM
    this.WB = { ...this.MEM };
    // MEM ← EX
    this.MEM = { ...this.EX };
    // EX ← ID
    this.EX = { ...this.ID };
    // ID ← IF
    this.ID = { ...this.IF };
    // IF ← (fetch nuevo)
    this.IF.clear();
  }

  insertBubble() {
    this.bubbles++;
    this.EX.clear();
  }

  snapshot() {
    return {
      IF: this.IF.toJSON(),
      ID: this.ID.toJSON(),
      EX: this.EX.toJSON(),
      MEM: this.MEM.toJSON(),
      WB: this.WB.toJSON(),
      stalls: this.stalls,
      bubbles: this.bubbles,
    };
  }
}

// ============================================================================
// 8. INSTRUCTION DECODER
// ============================================================================

const OPCODE_NAMES = {};
for (const [name, code] of Object.entries(OPCODE)) {
  OPCODE_NAMES[code] = name;
}

class InstructionDecoder {
  constructor() {
    this.opcodeTable = this._buildOpcodeTable();
  }

  _buildOpcodeTable() {
    return {
      [OPCODE.NOP]: { name: "NOP", operands: 0, cycles: 1, flags: [] },
      [OPCODE.HLT]: { name: "HLT", operands: 0, cycles: 1, flags: [] },
      [OPCODE.MOV]: { name: "MOV", operands: 2, cycles: 1, flags: [] },
      [OPCODE.MOVI]: { name: "MOVI", operands: 2, cycles: 1, flags: [] },
      [OPCODE.ADD]: { name: "ADD", operands: 2, cycles: 1, flags: ["ZF", "SF", "OF", "CF", "PF"] },
      [OPCODE.ADDI]: { name: "ADDI", operands: 2, cycles: 1, flags: ["ZF", "SF", "OF", "CF", "PF"] },
      [OPCODE.SUB]: { name: "SUB", operands: 2, cycles: 1, flags: ["ZF", "SF", "OF", "CF", "PF"] },
      [OPCODE.SUBI]: { name: "SUBI", operands: 2, cycles: 1, flags: ["ZF", "SF", "OF", "CF", "PF"] },
      [OPCODE.MUL]: { name: "MUL", operands: 2, cycles: 3, flags: ["ZF", "SF", "OF", "CF"] },
      [OPCODE.DIV]: { name: "DIV", operands: 2, cycles: 10, flags: [] },
      [OPCODE.MOD]: { name: "MOD", operands: 2, cycles: 10, flags: [] },
      [OPCODE.INC]: { name: "INC", operands: 1, cycles: 1, flags: ["ZF", "SF", "OF", "PF"] },
      [OPCODE.DEC]: { name: "DEC", operands: 1, cycles: 1, flags: ["ZF", "SF", "OF", "PF"] },
      [OPCODE.NEG]: { name: "NEG", operands: 1, cycles: 1, flags: ["ZF", "SF", "OF", "CF"] },
      [OPCODE.AND]: { name: "AND", operands: 2, cycles: 1, flags: ["ZF", "SF", "PF"] },
      [OPCODE.OR]: { name: "OR", operands: 2, cycles: 1, flags: ["ZF", "SF", "PF"] },
      [OPCODE.XOR]: { name: "XOR", operands: 2, cycles: 1, flags: ["ZF", "SF", "PF"] },
      [OPCODE.NOT]: { name: "NOT", operands: 1, cycles: 1, flags: [] },
      [OPCODE.SHL]: { name: "SHL", operands: 2, cycles: 1, flags: ["ZF", "SF", "CF", "OF"] },
      [OPCODE.SHR]: { name: "SHR", operands: 2, cycles: 1, flags: ["ZF", "SF", "CF"] },
      [OPCODE.SAR]: { name: "SAR", operands: 2, cycles: 1, flags: ["ZF", "SF", "CF"] },
      [OPCODE.ROL]: { name: "ROL", operands: 2, cycles: 1, flags: ["CF", "OF"] },
      [OPCODE.ROR]: { name: "ROR", operands: 2, cycles: 1, flags: ["CF", "OF"] },
      [OPCODE.CMP]: { name: "CMP", operands: 2, cycles: 1, flags: ["ZF", "SF", "OF", "CF", "PF"] },
      [OPCODE.CMPI]: { name: "CMPI", operands: 2, cycles: 1, flags: ["ZF", "SF", "OF", "CF", "PF"] },
      [OPCODE.TEST]: { name: "TEST", operands: 2, cycles: 1, flags: ["ZF", "SF", "PF"] },
      [OPCODE.JMP]: { name: "JMP", operands: 1, cycles: 1, branch: true, flags: [] },
      [OPCODE.JE]: { name: "JE", operands: 1, cycles: 1, branch: true, flags: [] },
      [OPCODE.JNE]: { name: "JNE", operands: 1, cycles: 1, branch: true, flags: [] },
      [OPCODE.JG]: { name: "JG", operands: 1, cycles: 1, branch: true, flags: [] },
      [OPCODE.JGE]: { name: "JGE", operands: 1, cycles: 1, branch: true, flags: [] },
      [OPCODE.JL]: { name: "JL", operands: 1, cycles: 1, branch: true, flags: [] },
      [OPCODE.JLE]: { name: "JLE", operands: 1, cycles: 1, branch: true, flags: [] },
      [OPCODE.JA]: { name: "JA", operands: 1, cycles: 1, branch: true, flags: [] },
      [OPCODE.JAE]: { name: "JAE", operands: 1, cycles: 1, branch: true, flags: [] },
      [OPCODE.JB]: { name: "JB", operands: 1, cycles: 1, branch: true, flags: [] },
      [OPCODE.JBE]: { name: "JBE", operands: 1, cycles: 1, branch: true, flags: [] },
      [OPCODE.CALL]: { name: "CALL", operands: 1, cycles: 2, branch: true, flags: [] },
      [OPCODE.RET]: { name: "RET", operands: 0, cycles: 2, branch: true, flags: [] },
      [OPCODE.PUSH]: { name: "PUSH", operands: 1, cycles: 1, flags: [] },
      [OPCODE.POP]: { name: "POP", operands: 1, cycles: 1, flags: [] },
      [OPCODE.LEA]: { name: "LEA", operands: 2, cycles: 1, flags: [] },
      [OPCODE.XCHG]: { name: "XCHG", operands: 2, cycles: 1, flags: [] },
      [OPCODE.LOAD]: { name: "LOAD", operands: 2, cycles: 2, memory: "read", flags: [] },
      [OPCODE.STORE]: { name: "STORE", operands: 2, cycles: 2, memory: "write", flags: [] },
      [OPCODE.LOADQ]: { name: "LOADQ", operands: 2, cycles: 2, memory: "read", flags: [] },
      [OPCODE.STOREQ]: { name: "STOREQ", operands: 2, cycles: 2, memory: "write", flags: [] },
      [OPCODE.SYSCALL]: { name: "SYSCALL", operands: 0, cycles: 20, flags: [] },
      [OPCODE.INT]: { name: "INT", operands: 1, cycles: 10, flags: [] },
      [OPCODE.IRET]: { name: "IRET", operands: 0, cycles: 10, flags: [] },
      [OPCODE.CLI]: { name: "CLI", operands: 0, cycles: 1, flags: ["IF"] },
      [OPCODE.STI]: { name: "STI", operands: 0, cycles: 1, flags: ["IF"] },
      // FPU
      [OPCODE.FADD]: { name: "FADD", operands: 2, cycles: 3, fpu: true, flags: [] },
      [OPCODE.FSUB]: { name: "FSUB", operands: 2, cycles: 3, fpu: true, flags: [] },
      [OPCODE.FMUL]: { name: "FMUL", operands: 2, cycles: 5, fpu: true, flags: [] },
      [OPCODE.FDIV]: { name: "FDIV", operands: 2, cycles: 10, fpu: true, flags: [] },
      [OPCODE.FSQRT]: { name: "FSQRT", operands: 1, cycles: 15, fpu: true, flags: [] },
      [OPCODE.FSIN]: { name: "FSIN", operands: 1, cycles: 20, fpu: true, flags: [] },
      [OPCODE.FCOS]: { name: "FCOS", operands: 1, cycles: 20, fpu: true, flags: [] },
      [OPCODE.FTAN]: { name: "FTAN", operands: 1, cycles: 25, fpu: true, flags: [] },
      [OPCODE.FLOG]: { name: "FLOG", operands: 1, cycles: 20, fpu: true, flags: [] },
      [OPCODE.FEXP]: { name: "FEXP", operands: 1, cycles: 20, fpu: true, flags: [] },
      [OPCODE.FLD]: { name: "FLD", operands: 1, cycles: 3, fpu: true, flags: [] },
      [OPCODE.FST]: { name: "FST", operands: 1, cycles: 3, fpu: true, flags: [] },
      // SIMD
      [OPCODE.ADDPS]: { name: "ADDPS", operands: 2, cycles: 3, simd: true, flags: [] },
      [OPCODE.SUBPS]: { name: "SUBPS", operands: 2, cycles: 3, simd: true, flags: [] },
      [OPCODE.MULPS]: { name: "MULPS", operands: 2, cycles: 5, simd: true, flags: [] },
      [OPCODE.DIVPS]: { name: "DIVPS", operands: 2, cycles: 10, simd: true, flags: [] },
      [OPCODE.ANDPS]: { name: "ANDPS", operands: 2, cycles: 1, simd: true, flags: [] },
      [OPCODE.ORPS]: { name: "ORPS", operands: 2, cycles: 1, simd: true, flags: [] },
      [OPCODE.XORPS]: { name: "XORPS", operands: 2, cycles: 1, simd: true, flags: [] },
      [OPCODE.MOVPS]: { name: "MOVPS", operands: 2, cycles: 1, simd: true, flags: [] },
      [OPCODE.SHUFPS]: { name: "SHUFPS", operands: 3, cycles: 1, simd: true, flags: [] },
      [OPCODE.CMPPS]: { name: "CMPPS", operands: 3, cycles: 3, simd: true, flags: [] },
      [OPCODE.CVTPS2PI]: { name: "CVTPS2PI", operands: 2, cycles: 3, simd: true, flags: [] },
      [OPCODE.CVTPI2PS]: { name: "CVTPI2PS", operands: 2, cycles: 3, simd: true, flags: [] },
      // Bit
      [OPCODE.BT]: { name: "BT", operands: 2, cycles: 1, flags: ["CF"] },
      [OPCODE.BTS]: { name: "BTS", operands: 2, cycles: 1, flags: ["CF"] },
      [OPCODE.BTR]: { name: "BTR", operands: 2, cycles: 1, flags: ["CF"] },
      [OPCODE.BSF]: { name: "BSF", operands: 2, cycles: 3, flags: ["ZF"] },
      [OPCODE.BSR]: { name: "BSR", operands: 2, cycles: 3, flags: ["ZF"] },
      [OPCODE.POPCNT]: { name: "POPCNT", operands: 2, cycles: 3, flags: ["ZF"] },
      [OPCODE.LZCNT]: { name: "LZCNT", operands: 2, cycles: 3, flags: ["ZF", "CF"] },
      [OPCODE.TZCNT]: { name: "TZCNT", operands: 2, cycles: 3, flags: ["ZF", "CF"] },
      [OPCODE.BSWAP]: { name: "BSWAP", operands: 1, cycles: 1, flags: [] },
      // Atomic
      [OPCODE.CMPXCHG]: { name: "CMPXCHG", operands: 3, cycles: 5, flags: ["ZF"] },
      [OPCODE.XADD]: { name: "XADD", operands: 2, cycles: 5, flags: ["ZF", "SF", "OF", "CF", "PF"] },
      // Misc
      [OPCODE.CPUID]: { name: "CPUID", operands: 0, cycles: 10, flags: [] },
      [OPCODE.RDTSC]: { name: "RDTSC", operands: 0, cycles: 5, flags: [] },
      [OPCODE.PAUSE]: { name: "PAUSE", operands: 0, cycles: 1, flags: [] },
    };
  }

  decode(memory, pc) {
    const opcode = memory.read8(Number(pc));
    const descriptor = this.opcodeTable[opcode];
    if (!descriptor) {
      throw new CpuException(EXCEPTION.UD, { pc, opcode });
    }
    const instruction = {
      pc,
      opcode,
      name: descriptor.name,
      descriptor,
      operands: [],
      size: 1,
    };
    // Parsear operandos según descriptor
    const operandEncodings = [
      { type: "reg", size: 2 },
      { type: "imm", size: 8 },
    ];
    let cursor = pc + 1n;
    const numOperands = descriptor.operands || 0;
    for (let i = 0; i < numOperands; i++) {
      const encoding = operandEncodings[i % operandEncodings.length];
      if (encoding.type === "reg") {
        const regIndex = memory.read8(Number(cursor));
        instruction.operands.push({ type: "reg", value: regIndex });
        cursor += 2n;
        instruction.size += 2;
      } else {
        const imm = memory.read64(Number(cursor));
        instruction.operands.push({ type: "imm", value: imm });
        cursor += 8n;
        instruction.size += 8;
      }
    }
    return instruction;
  }
}

// ============================================================================
// 9. ALU
// ============================================================================

class Alu {
  static add(a, b, flags) {
    const r = BigInt.asIntN(64, a + b);
    const ua = BigInt.asUintN(64, a);
    const ub = BigInt.asUintN(64, b);
    const ur = BigInt.asUintN(64, r);
    flags.setFlag(FLAG.ZF, r === 0n);
    flags.setFlag(FLAG.SF, (r & (1n << 63n)) !== 0n);
    flags.setFlag(FLAG.CF, ur < ua);
    flags.setFlag(FLAG.OF, ((ua ^ ub ^ 0x8000000000000000n) & (ua ^ ur) & (1n << 63n)) !== 0n);
    flags.setFlag(FLAG.PF, (Number(r & 0xffn) & 0xff).toString(2).split("1").length % 2 === 0);
    return r;
  }

  static sub(a, b, flags) {
    const r = BigInt.asIntN(64, a - b);
    const ua = BigInt.asUintN(64, a);
    const ub = BigInt.asUintN(64, b);
    const ur = BigInt.asUintN(64, r);
    flags.setFlag(FLAG.ZF, r === 0n);
    flags.setFlag(FLAG.SF, (r & (1n << 63n)) !== 0n);
    flags.setFlag(FLAG.CF, ua < ub);
    flags.setFlag(FLAG.OF, ((ua ^ ub) & (ua ^ ur) & (1n << 63n)) !== 0n);
    return r;
  }

  static mul(a, b, flags) {
    const r = BigInt.asIntN(64, a * b);
    const full = a * b;
    flags.setFlag(FLAG.ZF, r === 0n);
    flags.setFlag(FLAG.SF, (r & (1n << 63n)) !== 0n);
    flags.setFlag(FLAG.OF, full !== r);
    flags.setFlag(FLAG.CF, full !== r);
    return r;
  }

  static div(a, b, flags) {
    if (b === 0n) throw new CpuException(EXCEPTION.DE, { a, b });
    return BigInt.asIntN(64, a / b);
  }

  static mod(a, b, flags) {
    if (b === 0n) throw new CpuException(EXCEPTION.DE, { a, b });
    return BigInt.asIntN(64, a % b);
  }

  static and(a, b, flags) {
    const r = a & b;
    flags.setFlag(FLAG.ZF, r === 0n);
    flags.setFlag(FLAG.SF, (r & (1n << 63n)) !== 0n);
    return r;
  }

  static or(a, b, flags) {
    const r = a | b;
    flags.setFlag(FLAG.ZF, r === 0n);
    flags.setFlag(FLAG.SF, (r & (1n << 63n)) !== 0n);
    return r;
  }

  static xor(a, b, flags) {
    const r = a ^ b;
    flags.setFlag(FLAG.ZF, r === 0n);
    flags.setFlag(FLAG.SF, (r & (1n << 63n)) !== 0n);
    return r;
  }

  static not(a) {
    return BigInt.asIntN(64, ~a);
  }

  static neg(a, flags) {
    return this.sub(0n, a, flags);
  }

  static shl(a, b, flags) {
    const shift = BigInt.asUintN(6, b);
    const r = BigInt.asIntN(64, a << shift);
    flags.setFlag(FLAG.ZF, r === 0n);
    flags.setFlag(FLAG.SF, (r & (1n << 63n)) !== 0n);
    return r;
  }

  static shr(a, b, flags) {
    const ua = BigInt.asUintN(64, a);
    const shift = BigInt.asUintN(6, b);
    return BigInt.asUintN(64, ua >> shift);
  }

  static sar(a, b, flags) {
    const shift = BigInt.asUintN(6, b);
    return BigInt.asIntN(64, a >> shift);
  }

  static rol(a, b, flags) {
    const shift = Number(BigInt.asUintN(6, b));
    const ua = BigInt.asUintN(64, a);
    return BigInt.asUintN(64, (ua << BigInt(shift)) | (ua >> BigInt(64 - shift)));
  }

  static ror(a, b, flags) {
    const shift = Number(BigInt.asUintN(6, b));
    const ua = BigInt.asUintN(64, a);
    return BigInt.asUintN(64, (ua >> BigInt(shift)) | (ua << BigInt(64 - shift)));
  }

  static cmp(a, b, flags) {
    this.sub(a, b, flags);
  }

  static test(a, b, flags) {
    this.and(a, b, flags);
  }

  static popcnt(a) {
    let count = 0;
    let v = BigInt.asUintN(64, a);
    while (v) {
      count += Number(v & 1n);
      v >>= 1n;
    }
    return BigInt(count);
  }

  static lzcnt(a) {
    const v = BigInt.asUintN(64, a);
    if (v === 0n) return 64n;
    let count = 0;
    let mask = 1n << 63n;
    while ((v & mask) === 0n) {
      count++;
      mask >>= 1n;
    }
    return BigInt(count);
  }

  static tzcnt(a) {
    const v = BigInt.asUintN(64, a);
    if (v === 0n) return 64n;
    let count = 0;
    let x = v;
    while ((x & 1n) === 0n) {
      count++;
      x >>= 1n;
    }
    return BigInt(count);
  }

  static bswap(a) {
    const v = BigInt.asUintN(64, a);
    let r = 0n;
    for (let i = 0; i < 8; i++) {
      r = (r << 8n) | ((v >> BigInt(i * 8)) & 0xffn);
    }
    return r;
  }

  static bsf(a, flags) {
    const v = BigInt.asUintN(64, a);
    if (v === 0n) {
      flags.setFlag(FLAG.ZF, true);
      return 0n;
    }
    flags.setFlag(FLAG.ZF, false);
    return Alu.tzcnt(a);
  }

  static bsr(a, flags) {
    const v = BigInt.asUintN(64, a);
    if (v === 0n) {
      flags.setFlag(FLAG.ZF, true);
      return 0n;
    }
    flags.setFlag(FLAG.ZF, false);
    return BigInt(63 - Number(Alu.lzcnt(a)));
  }

  static bt(a, bitIndex, flags) {
    const b = BigInt.asUintN(6, bitIndex);
    const bit = (BigInt.asUintN(64, a) >> b) & 1n;
    flags.setFlag(FLAG.CF, bit === 1n);
    return a;
  }

  static bts(a, bitIndex, flags) {
    const b = BigInt.asUintN(6, bitIndex);
    const ua = BigInt.asUintN(64, a);
    const bit = (ua >> b) & 1n;
    flags.setFlag(FLAG.CF, bit === 1n);
    return BigInt.asIntN(64, ua | (1n << b));
  }

  static btr(a, bitIndex, flags) {
    const b = BigInt.asUintN(6, bitIndex);
    const ua = BigInt.asUintN(64, a);
    const bit = (ua >> b) & 1n;
    flags.setFlag(FLAG.CF, bit === 1n);
    return BigInt.asIntN(64, ua & ~(1n << b));
  }
}

// ============================================================================
// 10. FPU / SIMD UNITS
// ============================================================================

class Fpu {
  constructor(registers) {
    this.regs = registers;
    this.roundingMode = 0; // 0 = nearest, 1 = down, 2 = up, 3 = truncate
  }

  add(a, b) {
    return a + b;
  }
  sub(a, b) {
    return a - b;
  }
  mul(a, b) {
    return a * b;
  }
  div(a, b) {
    if (b === 0) throw new CpuException(EXCEPTION.DE, { fp: true });
    return a / b;
  }
  sqrt(a) {
    return Math.sqrt(a);
  }
  sin(a) {
    return Math.sin(a);
  }
  cos(a) {
    return Math.cos(a);
  }
  tan(a) {
    return Math.tan(a);
  }
  log(a) {
    return Math.log(a);
  }
  exp(a) {
    return Math.exp(a);
  }
}

class Simd {
  constructor(registers) {
    this.regs = registers;
  }

  addps(dst, src) {
    for (let i = 0; i < 4; i++) {
      this.regs.setFloat(dst, i, this.regs.getFloat(dst, i) + this.regs.getFloat(src, i));
    }
  }
  subps(dst, src) {
    for (let i = 0; i < 4; i++) {
      this.regs.setFloat(dst, i, this.regs.getFloat(dst, i) - this.regs.getFloat(src, i));
    }
  }
  mulps(dst, src) {
    for (let i = 0; i < 4; i++) {
      this.regs.setFloat(dst, i, this.regs.getFloat(dst, i) * this.regs.getFloat(src, i));
    }
  }
  divps(dst, src) {
    for (let i = 0; i < 4; i++) {
      const s = this.regs.getFloat(src, i);
      if (s === 0) throw new CpuException(EXCEPTION.DE, { fp: true });
      this.regs.setFloat(dst, i, this.regs.getFloat(dst, i) / s);
    }
  }
  andps(dst, src) {
    for (let i = 0; i < 4; i++) {
      this.regs.setInt(dst, i, this.regs.getInt(dst, i) & this.regs.getInt(src, i));
    }
  }
  orps(dst, src) {
    for (let i = 0; i < 4; i++) {
      this.regs.setInt(dst, i, this.regs.getInt(dst, i) | this.regs.getInt(src, i));
    }
  }
  xorps(dst, src) {
    for (let i = 0; i < 4; i++) {
      this.regs.setInt(dst, i, this.regs.getInt(dst, i) ^ this.regs.getInt(src, i));
    }
  }
  movps(dst, src) {
    for (let i = 0; i < 4; i++) {
      this.regs.setFloat(dst, i, this.regs.getFloat(src, i));
    }
  }
}

// ============================================================================
// 11. VCPU
// ============================================================================

export class VCPU {
  constructor(options = {}) {
    this.id = options.id ?? 0;
    this.options = {
      memorySize: options.memorySize ?? 4 * 1024 * 1024 * 1024,
      l1Size: 32 * 1024,
      l2Size: 256 * 1024,
      l3Size: 8 * 1024 * 1024,
      branchEntries: 4096,
      enablePipeline: options.enablePipeline ?? true,
      enableCache: options.enableCache ?? true,
      enableMmu: options.enableMmu ?? true,
      enableFpu: options.enableFpu ?? true,
      enableSimd: options.enableSimd ?? true,
    };

    this.state = VCPU_STATE.OFFLINE;
    this.cycle = 0;
    this.instructionCount = 0;
    this.totalCycles = 0;

    // Componentes
    this.memory = new MemoryBus(this.options.memorySize);
    this.regs = new RegisterFile();
    this.fpuRegs = new FpuRegisterFile();
    this.simdRegs = new SimdRegisterFile();

    this.l1i = this.options.enableCache
      ? new Cache({ name: "L1I", sizeBytes: this.options.l1Size, ways: 8 })
      : null;
    this.l1d = this.options.enableCache
      ? new Cache({ name: "L1D", sizeBytes: this.options.l1Size, ways: 8 })
      : null;
    this.l2 = this.options.enableCache
      ? new Cache({ name: "L2", sizeBytes: this.options.l2Size, ways: 8 })
      : null;
    this.l3 = this.options.enableCache
      ? new Cache({ name: "L3", sizeBytes: this.options.l3Size, ways: 16 })
      : null;

    this.mmu = this.options.enableMmu ? new Mmu(this.memory) : null;
    this.decoder = new InstructionDecoder();
    this.pipeline = this.options.enablePipeline ? new Pipeline(this) : null;
    this.branchPredictor = new BranchPredictor(this.options.branchEntries);
    this.alu = Alu;
    this.fpu = this.options.enableFpu ? new Fpu(this.fpuRegs) : null;
    this.simd = this.options.enableSimd ? new Simd(this.simdRegs) : null;

    // IDT
    this.idt = new Idt();

    // Syscalls
    this.syscallTable = new Map();

    // Breakpoints / watchpoints
    this.breakpoints = new Set();
    this.watchpoints = new Map(); // addr → { type: "r"|"w"|"rw" }

    // Trace
    this.trace = [];
    this.traceMax = 256;

    // Scheduler hook
    this.scheduler = options.scheduler ?? null;
    this.currentThread = null;
    this.quantumRemaining = 0;

    // Contadores de stats
    this.stats = {
      contextSwitches: 0,
      exceptions: 0,
      interrupts: 0,
      syscalls: 0,
      branchesTaken: 0,
      branchesNotTaken: 0,
      mispredicts: 0,
      stalls: 0,
      bubbles: 0,
    };
  }

  // -------------------------------------------------------------------------
  attachScheduler(scheduler) {
    this.scheduler = scheduler;
    // Registrar eventos: cuando un hilo se ejecuta, se lo asignamos
    kernelBus.on(SCHEDULER_EVENTS.THREAD_RUNNING, (payload) => {
      // El scheduler nos avisa por el bus; si tenemos un thread en curso
      // lo cargamos
      if (payload.coreId === this.id) {
        // nada: la asignación la hace el scheduler por referencia directa
      }
    });
  }

  reset() {
    this.regs = new RegisterFile();
    this.fpuRegs = new FpuRegisterFile();
    this.simdRegs = new SimdRegisterFile();
    this.pipeline?.clear();
    this.l1i?.flush();
    this.l1d?.flush();
    this.l2?.flush();
    this.l3?.flush();
    this.mmu?.tlb.flush();
    this.cycle = 0;
    this.instructionCount = 0;
    kernelBus.emit(VCPU_EVENTS.RESET, { vcpuId: this.id });
  }

  // -------------------------------------------------------------------------
  load(program, entryPoint = 0n) {
    // program: Uint8Array con el código máquina
    this.memory.writeBytes(Number(entryPoint), program);
    this.regs.rip = BigInt(entryPoint);
    this.regs.set("RSP", 0x7ff00000n);
    this.regs.set("RBP", 0x7ff00000n);
    // IF activado
    this.regs.setFlag(FLAG.IF, true);
  }

  // -------------------------------------------------------------------------
  step() {
    if (this.state === VCPU_STATE.HALTED || this.state === VCPU_STATE.PANIC) {
      return null;
    }

    // Chequear interrupciones pendientes
    this._checkInterrupts();

    // Breakpoint en el PC actual
    if (this.breakpoints.has(Number(this.regs.rip))) {
      kernelBus.emit(VCPU_EVENTS.BREAKPOINT, {
        pc: this.regs.rip.toString(),
      });
      this.state = VCPU_STATE.WAITING_IRQ;
      return { breakpoint: true, pc: this.regs.rip };
    }

    // Fetch
    const pc = this.regs.rip;
    this.state = VCPU_STATE.FETCH;
    let instruction;
    try {
      instruction = this._fetch(pc);
    } catch (err) {
      this._handleException(err);
      return null;
    }
    kernelBus.emit(VCPU_EVENTS.FETCH, {
      pc: pc.toString(),
      opcode: instruction.opcode,
    });

    // Decode
    this.state = VCPU_STATE.DECODE;
    kernelBus.emit(VCPU_EVENTS.DECODE, {
      name: instruction.name,
      operands: instruction.operands,
    });

    // Execute
    this.state = VCPU_STATE.EXECUTE;
    let result;
    try {
      result = this._execute(instruction);
    } catch (err) {
      this._handleException(err);
      return null;
    }
    kernelBus.emit(VCPU_EVENTS.EXECUTE, {
      name: instruction.name,
      result: result ? result.toString() : null,
    });

    // Writeback / avanzar PC
    this.state = VCPU_STATE.WRITEBACK;
    if (result?.nextPc != null) {
      this.regs.rip = result.nextPc;
    } else {
      this.regs.rip = pc + BigInt(instruction.size);
    }

    this.instructionCount++;
    this.cycle += instruction.descriptor.cycles || 1;
    this.totalCycles += instruction.descriptor.cycles || 1;

    kernelBus.emit(VCPU_EVENTS.INSTRUCTION_RETIRED, {
      pc: pc.toString(),
      name: instruction.name,
      cycle: this.cycle,
    });

    // Trace
    this.trace.push({
      cycle: this.cycle,
      pc: pc.toString(),
      name: instruction.name,
    });
    if (this.trace.length > this.traceMax) this.trace.shift();

    this.state = VCPU_STATE.IDLE;
    return { instruction, pc };
  }

  run(maxCycles = 1_000_000) {
    this.state = VCPU_STATE.IDLE;
    kernelBus.emit(VCPU_EVENTS.STARTED, { vcpuId: this.id });
    let executed = 0;
    while (
      this.state !== VCPU_STATE.HALTED &&
      this.state !== VCPU_STATE.PANIC &&
      this.state !== VCPU_STATE.WAITING_IRQ &&
      executed < maxCycles
    ) {
      const r = this.step();
      if (r == null && this.state !== VCPU_STATE.IDLE) break;
      executed++;
      if (this.quantumRemaining > 0) {
        this.quantumRemaining -= 1;
        if (this.quantumRemaining <= 0) {
          // Quantum agotado → notificar al scheduler
          this._yieldToScheduler();
          break;
        }
      }
    }
    kernelBus.emit(VCPU_EVENTS.STOPPED, { vcpuId: this.id, executed });
    return executed;
  }

  halt() {
    this.state = VCPU_STATE.HALTED;
    kernelBus.emit(VCPU_EVENTS.HALTED, { vcpuId: this.id, cycle: this.cycle });
  }

  panic(reason = "unknown") {
    this.state = VCPU_STATE.PANIC;
    kernelBus.emit(VCPU_EVENTS.PANIC, {
      vcpuId: this.id,
      reason,
      pc: this.regs.rip.toString(),
    });
  }

  // -------------------------------------------------------------------------
  // Context switch desde el scheduler
  // -------------------------------------------------------------------------
  saveContext() {
    return {
      regs: this.regs.clone(),
      fpu: { st: Array.from(this.fpuRegs.st), top: this.fpuRegs.top },
      simd: {
        xmm: Array.from(this.simdRegs.xmm),
        xmmInt: Array.from(this.simdRegs.xmmInt),
      },
      cycle: this.cycle,
      instructionCount: this.instructionCount,
    };
  }

  restoreContext(ctx) {
    this.regs = ctx.regs.clone();
    this.fpuRegs.st.set(ctx.fpu.st);
    this.fpuRegs.top = ctx.fpu.top;
    this.simdRegs.xmm.set(ctx.simd.xmm);
    this.simdRegs.xmmInt.set(ctx.simd.xmmInt);
    this.cycle = ctx.cycle;
    this.instructionCount = ctx.instructionCount;
    this.stats.contextSwitches++;
  }

  /**
   * Ejecuta un quantum del hilo asignado.
   */
  runQuantum(thread, maxInstructions = 1000) {
    if (!thread) return { executed: 0 };
    this.currentThread = thread;
    this.quantumRemaining = maxInstructions;

    const saved = thread.meta.vcpuContext;
    if (saved) this.restoreContext(saved);

    const threadFn = thread.meta.fn;
    if (typeof threadFn === "function") {
      // Si el thread tiene función, la ejecutamos como microtask
      // y devolvemos el control
      try {
        const r = threadFn();
        if (r && typeof r.then === "function") {
          r.then((result) => {
            thread.meta.result = result;
            thread.setState(THREAD_STATE.TERMINATED);
            kernelBus.emit(SCHEDULER_EVENTS.THREAD_TERMINATED, {
              tid: thread.tid,
              exitCode: 0,
            });
          }).catch((err) => {
            thread.meta.error = err;
            thread.setState(THREAD_STATE.TERMINATED);
            kernelBus.emit(SCHEDULER_EVENTS.THREAD_TERMINATED, {
              tid: thread.tid,
              exitCode: 1,
            });
          });
        } else {
          thread.meta.result = r;
          thread.setState(THREAD_STATE.TERMINATED);
          kernelBus.emit(SCHEDULER_EVENTS.THREAD_TERMINATED, {
            tid: thread.tid,
            exitCode: 0,
          });
        }
      } catch (err) {
        thread.meta.error = err;
        thread.setState(THREAD_STATE.TERMINATED);
        kernelBus.emit(SCHEDULER_EVENTS.THREAD_TERMINATED, {
          tid: thread.tid,
          exitCode: 1,
        });
      }
      return { executed: 1 };
    }

    // Si no, ejecutamos un bloque de instrucciones
    const executed = this.run(maxInstructions);
    thread.meta.vcpuContext = this.saveContext();
    return { executed };
  }

  // -------------------------------------------------------------------------
  _fetch(pc) {
    // Cache L1I
    if (this.l1i) {
      const hit = this.l1i.read(Number(pc));
      if (!hit) {
        this.l1i.allocate(Number(pc));
        this.l2?.read(Number(pc));
      }
    }
    return this.decoder.decode(this.memory, pc);
  }

  // -------------------------------------------------------------------------
  _execute(instruction) {
    const { name, operands } = instruction;
    const regs = this.regs;
    const flags = regs;

    const readOperand = (op) => {
      if (!op) return 0n;
      if (op.type === "reg") {
        return regs.gpr[op.value] ?? 0n;
      }
      if (op.type === "imm") return op.value;
      return 0n;
    };

    const writeOperand = (op, value) => {
      if (op.type === "reg") {
        regs.gpr[op.value] = BigInt.asIntN(64, BigInt(value));
      }
    };

    switch (name) {
      case "NOP":
        return null;
      case "HLT":
        this.halt();
        return null;
      case "MOV":
        writeOperand(operands[0], readOperand(operands[1]));
        return null;
      case "MOVI":
        writeOperand(operands[0], operands[1].value);
        return null;
      case "ADD":
        writeOperand(operands[0], Alu.add(readOperand(operands[0]), readOperand(operands[1]), flags));
        return null;
      case "ADDI":
        writeOperand(operands[0], Alu.add(readOperand(operands[0]), operands[1].value, flags));
        return null;
      case "SUB":
        writeOperand(operands[0], Alu.sub(readOperand(operands[0]), readOperand(operands[1]), flags));
        return null;
      case "SUBI":
        writeOperand(operands[0], Alu.sub(readOperand(operands[0]), operands[1].value, flags));
        return null;
      case "MUL":
        writeOperand(operands[0], Alu.mul(readOperand(operands[0]), readOperand(operands[1]), flags));
        return null;
      case "DIV":
        writeOperand(operands[0], Alu.div(readOperand(operands[0]), readOperand(operands[1]), flags));
        return null;
      case "MOD":
        writeOperand(operands[0], Alu.mod(readOperand(operands[0]), readOperand(operands[1]), flags));
        return null;
      case "INC":
        writeOperand(operands[0], Alu.add(readOperand(operands[0]), 1n, flags));
        return null;
      case "DEC":
        writeOperand(operands[0], Alu.sub(readOperand(operands[0]), 1n, flags));
        return null;
      case "NEG":
        writeOperand(operands[0], Alu.neg(readOperand(operands[0]), flags));
        return null;
      case "AND":
        writeOperand(operands[0], Alu.and(readOperand(operands[0]), readOperand(operands[1]), flags));
        return null;
      case "OR":
        writeOperand(operands[0], Alu.or(readOperand(operands[0]), readOperand(operands[1]), flags));
        return null;
      case "XOR":
        writeOperand(operands[0], Alu.xor(readOperand(operands[0]), readOperand(operands[1]), flags));
        return null;
      case "NOT":
        writeOperand(operands[0], Alu.not(readOperand(operands[0])));
        return null;
      case "SHL":
        writeOperand(operands[0], Alu.shl(readOperand(operands[0]), readOperand(operands[1]), flags));
        return null;
      case "SHR":
        writeOperand(operands[0], Alu.shr(readOperand(operands[0]), readOperand(operands[1]), flags));
        return null;
      case "SAR":
        writeOperand(operands[0], Alu.sar(readOperand(operands[0]), readOperand(operands[1]), flags));
        return null;
      case "ROL":
        writeOperand(operands[0], Alu.rol(readOperand(operands[0]), readOperand(operands[1]), flags));
        return null;
      case "ROR":
        writeOperand(operands[0], Alu.ror(readOperand(operands[0]), readOperand(operands[1]), flags));
        return null;
      case "CMP":
        Alu.cmp(readOperand(operands[0]), readOperand(operands[1]), flags);
        return null;
      case "CMPI":
        Alu.cmp(readOperand(operands[0]), operands[1].value, flags);
        return null;
      case "TEST":
        Alu.test(readOperand(operands[0]), readOperand(operands[1]), flags);
        return null;
      case "JMP":
        return { nextPc: readOperand(operands[0]) };
      case "JE":
        return flags.getFlag(FLAG.ZF) ? { nextPc: readOperand(operands[0]) } : null;
      case "JNE":
        return !flags.getFlag(FLAG.ZF) ? { nextPc: readOperand(operands[0]) } : null;
      case "JG":
        return !flags.getFlag(FLAG.ZF) && flags.getFlag(FLAG.SF) === flags.getFlag(FLAG.OF)
          ? { nextPc: readOperand(operands[0]) } : null;
      case "JGE":
        return flags.getFlag(FLAG.SF) === flags.getFlag(FLAG.OF)
          ? { nextPc: readOperand(operands[0]) } : null;
      case "JL":
        return flags.getFlag(FLAG.SF) !== flags.getFlag(FLAG.OF)
          ? { nextPc: readOperand(operands[0]) } : null;
      case "JLE":
        return flags.getFlag(FLAG.ZF) || flags.getFlag(FLAG.SF) !== flags.getFlag(FLAG.OF)
          ? { nextPc: readOperand(operands[0]) } : null;
      case "JA":
        return !flags.getFlag(FLAG.CF) && !flags.getFlag(FLAG.ZF)
          ? { nextPc: readOperand(operands[0]) } : null;
      case "JAE":
        return !flags.getFlag(FLAG.CF) ? { nextPc: readOperand(operands[0]) } : null;
      case "JB":
        return flags.getFlag(FLAG.CF) ? { nextPc: readOperand(operands[0]) } : null;
      case "JBE":
        return flags.getFlag(FLAG.CF) || flags.getFlag(FLAG.ZF)
          ? { nextPc: readOperand(operands[0]) } : null;
      case "CALL": {
        const target = readOperand(operands[0]);
        const rsp = regs.get("RSP");
        const returnAddr = instruction.pc + BigInt(instruction.size);
        regs.set("RSP", rsp - 8n);
        this.memory.write64(Number(rsp - 8n), returnAddr);
        return { nextPc: target };
      }
      case "RET": {
        const rsp = regs.get("RSP");
        const retAddr = this.memory.read64(Number(rsp));
        regs.set("RSP", rsp + 8n);
        return { nextPc: retAddr };
      }
      case "PUSH": {
        const rsp = regs.get("RSP");
        regs.set("RSP", rsp - 8n);
        this.memory.write64(Number(rsp - 8n), readOperand(operands[0]));
        return null;
      }
      case "POP": {
        const rsp = regs.get("RSP");
        const value = this.memory.read64(Number(rsp));
        writeOperand(operands[0], value);
        regs.set("RSP", rsp + 8n);
        return null;
      }
      case "LEA": {
        writeOperand(operands[0], readOperand(operands[1]));
        return null;
      }
      case "XCHG": {
        const a = readOperand(operands[0]);
        const b = readOperand(operands[1]);
        writeOperand(operands[0], b);
        writeOperand(operands[1], a);
        return null;
      }
      case "LOAD":
      case "LOADQ": {
        const addr = readOperand(operands[1]);
        if (this.mmu) {
          const paddr = this.mmu.translate(addr);
          writeOperand(operands[0], this.memory.read64(Number(paddr)));
        } else {
          writeOperand(operands[0], this.memory.read64(Number(addr)));
        }
        return null;
      }
      case "STORE":
      case "STOREQ": {
        const addr = readOperand(operands[0]);
        const value = readOperand(operands[1]);
        if (this.mmu) {
          const paddr = this.mmu.translate(addr, { write: true });
          this.memory.write64(Number(paddr), value);
        } else {
          this.memory.write64(Number(addr), value);
        }
        // Watchpoint
        if (this.watchpoints.has(Number(addr))) {
          kernelBus.emit(VCPU_EVENTS.WATCHPOINT, {
            addr: addr.toString(),
            value: value.toString(),
          });
        }
        return null;
      }
      case "SYSCALL": {
        this.stats.syscalls++;
        const syscallNum = regs.get("RAX");
        const args = [
          regs.get("RDI"),
          regs.get("RSI"),
          regs.get("RDX"),
          regs.get("R10"),
        ];
        kernelBus.emit(VCPU_EVENTS.SYSCALL, {
          number: syscallNum.toString(),
          args: args.map((a) => a.toString()),
        });
        const handler = this.syscallTable.get(Number(syscallNum));
        if (handler) {
          const r = handler(args);
          regs.set("RAX", r ?? 0n);
        } else {
          regs.set("RAX", -1n); // ENOSYS
        }
        return null;
      }
      case "INT": {
        this.stats.interrupts++;
        const vector = Number(operands[0]?.value ?? 0);
        this._raiseInterrupt(vector);
        return null;
      }
      case "CLI":
        flags.setFlag(FLAG.IF, false);
        return null;
      case "STI":
        flags.setFlag(FLAG.IF, true);
        return null;
      // FPU
      case "FADD":
        this.fpuRegs.set(0, this.fpu.add(this.fpuRegs.get(0), this.fpuRegs.get(1)));
        return null;
      case "FSUB":
        this.fpuRegs.set(0, this.fpu.sub(this.fpuRegs.get(0), this.fpuRegs.get(1)));
        return null;
      case "FMUL":
        this.fpuRegs.set(0, this.fpu.mul(this.fpuRegs.get(0), this.fpuRegs.get(1)));
        return null;
      case "FDIV":
        this.fpuRegs.set(0, this.fpu.div(this.fpuRegs.get(0), this.fpuRegs.get(1)));
        return null;
      case "FSQRT":
        this.fpuRegs.set(0, this.fpu.sqrt(this.fpuRegs.get(0)));
        return null;
      case "FSIN":
        this.fpuRegs.set(0, this.fpu.sin(this.fpuRegs.get(0)));
        return null;
      case "FCOS":
        this.fpuRegs.set(0, this.fpu.cos(this.fpuRegs.get(0)));
        return null;
      case "FTAN":
        this.fpuRegs.set(0, this.fpu.tan(this.fpuRegs.get(0)));
        return null;
      case "FLOG":
        this.fpuRegs.set(0, this.fpu.log(this.fpuRegs.get(0)));
        return null;
      case "FEXP":
        this.fpuRegs.set(0, this.fpu.exp(this.fpuRegs.get(0)));
        return null;
      // SIMD
      case "ADDPS":
        this.simd.addps(operands[0].value, operands[1].value);
        return null;
      case "SUBPS":
        this.simd.subps(operands[0].value, operands[1].value);
        return null;
      case "MULPS":
        this.simd.mulps(operands[0].value, operands[1].value);
        return null;
      case "DIVPS":
        this.simd.divps(operands[0].value, operands[1].value);
        return null;
      case "ANDPS":
        this.simd.andps(operands[0].value, operands[1].value);
        return null;
      case "ORPS":
        this.simd.orps(operands[0].value, operands[1].value);
        return null;
      case "XORPS":
        this.simd.xorps(operands[0].value, operands[1].value);
        return null;
      case "MOVPS":
        this.simd.movps(operands[0].value, operands[1].value);
        return null;
      // Bit manipulation
      case "BT":
        Alu.bt(readOperand(operands[0]), readOperand(operands[1]), flags);
        return null;
      case "BTS":
        writeOperand(operands[0], Alu.bts(readOperand(operands[0]), readOperand(operands[1]), flags));
        return null;
      case "BTR":
        writeOperand(operands[0], Alu.btr(readOperand(operands[0]), readOperand(operands[1]), flags));
        return null;
      case "BSF":
        writeOperand(operands[0], Alu.bsf(readOperand(operands[1]), flags));
        return null;
      case "BSR":
        writeOperand(operands[0], Alu.bsr(readOperand(operands[1]), flags));
        return null;
      case "POPCNT":
        writeOperand(operands[0], Alu.popcnt(readOperand(operands[1])));
        return null;
      case "LZCNT":
        writeOperand(operands[0], Alu.lzcnt(readOperand(operands[1])));
        return null;
      case "TZCNT":
        writeOperand(operands[0], Alu.tzcnt(readOperand(operands[1])));
        return null;
      case "BSWAP":
        writeOperand(operands[0], Alu.bswap(readOperand(operands[0])));
        return null;
      case "CPUID":
        return null;
      case "RDTSC": {
        const cycles = BigInt(this.cycle);
        regs.set("RAX", cycles & 0xffffffffn);
        regs.set("RDX", cycles >> 32n);
        return null;
      }
      case "PAUSE":
        return null;
      default:
        throw new CpuException(EXCEPTION.UD, { instruction: name });
    }
  }

  // -------------------------------------------------------------------------
  _handleException(err) {
    if (err instanceof CpuException) {
      this.stats.exceptions++;
      kernelBus.emit(VCPU_EVENTS.EXCEPTION, {
        type: err.type,
        info: err.info,
        pc: this.regs.rip.toString(),
      });
      // Buscar handler en la IDT
      const vector = this._exceptionVector(err.type);
      const entry = this.idt.get(vector);
      if (entry && entry.present) {
        try {
          entry.handler(err, this);
        } catch (e) {
          this.panic(`double fault: ${e.message}`);
        }
      } else {
        // Sin handler → panic
        this.panic(`unhandled ${err.type}`);
      }
    } else {
      this.panic(String(err));
    }
  }

  _exceptionVector(type) {
    const map = {
      [EXCEPTION.DE]: 0,
      [EXCEPTION.DB]: 1,
      [EXCEPTION.BP]: 3,
      [EXCEPTION.OF]: 4,
      [EXCEPTION.BR]: 5,
      [EXCEPTION.UD]: 6,
      [EXCEPTION.NM]: 7,
      [EXCEPTION.DF]: 8,
      [EXCEPTION.GP]: 13,
      [EXCEPTION.PF]: 14,
      [EXCEPTION.AC]: 17,
      [EXCEPTION.XF]: 19,
    };
    return map[type] ?? 13;
  }

  // -------------------------------------------------------------------------
  _checkInterrupts() {
    // Aquí se podrían inyectar interrupciones periódicas
    // (temporizador, teclado, etc.) desde el scheduler
  }

  _raiseInterrupt(vector) {
    const entry = this.idt.get(vector);
    if (!entry) {
      kernelBus.emit(VCPU_EVENTS.INTERRUPT, {
        vector,
        handled: false,
      });
      return;
    }
    try {
      entry.handler(this);
    } catch (err) {
      this.panic(`interrupt handler failed: ${err.message}`);
    }
    kernelBus.emit(VCPU_EVENTS.INTERRUPT, { vector, handled: true });
  }

  // -------------------------------------------------------------------------
  _yieldToScheduler() {
    if (!this.scheduler || !this.currentThread) return;
    const t = this.currentThread;
    // Guardamos el contexto en el hilo para retomarlo luego
    t.meta.vcpuContext = this.saveContext();
    // Reencolamos el hilo
    this.scheduler._enqueueReady(t);
    kernelBus.emit(SCHEDULER_EVENTS.PREEMPT, { tid: t.tid });
  }

  // -------------------------------------------------------------------------
  // Debugger
  // -------------------------------------------------------------------------
  setBreakpoint(pc) {
    this.breakpoints.add(Number(pc));
  }
  clearBreakpoint(pc) {
    this.breakpoints.delete(Number(pc));
  }
  setWatchpoint(addr, type = "rw") {
    this.watchpoints.set(Number(addr), { type });
  }
  clearWatchpoint(addr) {
    this.watchpoints.delete(Number(addr));
  }

  readRegister(name) {
    return this.regs.get(name);
  }

  writeRegister(name, value) {
    this.regs.set(name, value);
  }

  readMemory(addr, size = 8) {
    return this.memory.readBytes(addr, size);
  }

  writeMemory(addr, bytes) {
    this.memory.writeBytes(addr, bytes);
  }

  // -------------------------------------------------------------------------
  snapshot() {
    return {
      id: this.id,
      state: this.state,
      cycle: this.cycle,
      instructionCount: this.instructionCount,
      regs: this.regs.snapshot(),
      fpu: this.fpuRegs.snapshot(),
      simd: this.simdRegs.snapshot(),
      memory: this.memory.snapshot(),
      l1i: this.l1i?.snapshot() ?? null,
      l1d: this.l1d?.snapshot() ?? null,
      l2: this.l2?.snapshot() ?? null,
      l3: this.l3?.snapshot() ?? null,
      mmu: this.mmu?.snapshot() ?? null,
      pipeline: this.pipeline?.snapshot() ?? null,
      branchPredictor: this.branchPredictor.snapshot(),
      stats: { ...this.stats },
      trace: this.trace.slice(-20),
    };
  }

  dumpRegisters() {
    return this.regs.snapshot();
  }

  dumpMemory(start, length) {
    return Array.from(this.memory.readBytes(start, length));
  }
}

// ============================================================================
// 12. PROVIDER + HOOKS
// ============================================================================

const VcpuContext = createContext(null);

const initialState = {
  snapshot: null,
  logs: [],
};

function reducer(state, action) {
  switch (action.type) {
    case "SNAPSHOT":
      return { ...state, snapshot: action.snapshot };
    case "LOG":
      return { ...state, logs: [...state.logs.slice(-199), action.entry] };
    default:
      return state;
  }
}

export function VcpuProvider({
  children,
  vcpu: external,
  scheduler,
  options = {},
  autoSnapshot = true,
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new VCPU({ ...options, scheduler });
  }
  const vcpu = ref.current;

  // Conectar con el scheduler si lo tenemos
  useEffect(() => {
    if (scheduler) {
      vcpu.attachScheduler(scheduler);

      // Envolver el scheduler para que ejecute hilos sobre la VCPU
      const originalRun = scheduler._runUserThread?.bind(scheduler);
      if (originalRun) {
        scheduler._runUserThread = async (thread) => {
          vcpu.runQuantum(thread, 500);
        };
      }
    }
  }, [vcpu, scheduler]);

  const [state, dispatch] = useReducer(reducer, initialState);

  // Snapshot periódico
  useEffect(() => {
    if (!autoSnapshot) return;
    const t = setInterval(() => {
      dispatch({ type: "SNAPSHOT", snapshot: vcpu.snapshot() });
    }, 500);
    return () => clearInterval(t);
  }, [autoSnapshot, vcpu]);

  // Logs
  useEffect(() => {
    const off = kernelBus.on(VCPU_EVENTS.LOG, (entry) => {
      dispatch({ type: "LOG", entry });
    });
    return off;
  }, []);

  const api = useMemo(
    () => ({
      vcpu,
      snapshot: state.snapshot,
      logs: state.logs,

      // control
      reset: () => vcpu.reset(),
      load: (program, entry) => vcpu.load(program, entry),
      step: () => vcpu.step(),
      run: (max) => vcpu.run(max),
      halt: () => vcpu.halt(),
      panic: (r) => vcpu.panic(r),

      // contexto
      saveContext: () => vcpu.saveContext(),
      restoreContext: (ctx) => vcpu.restoreContext(ctx),
      runQuantum: (thread, max) => vcpu.runQuantum(thread, max),

      // debug
      setBreakpoint: (pc) => vcpu.setBreakpoint(pc),
      clearBreakpoint: (pc) => vcpu.clearBreakpoint(pc),
      setWatchpoint: (addr, t) => vcpu.setWatchpoint(addr, t),
      clearWatchpoint: (addr) => vcpu.clearWatchpoint(addr),
      readRegister: (n) => vcpu.readRegister(n),
      writeRegister: (n, v) => vcpu.writeRegister(n, v),
      readMemory: (a, s) => vcpu.readMemory(a, s),
      writeMemory: (a, b) => vcpu.writeMemory(a, b),

      // introspección
      snapshotNow: () => vcpu.snapshot(),
      dumpRegisters: () => vcpu.dumpRegisters(),
      dumpMemory: (a, l) => vcpu.dumpMemory(a, l),
    }),
    [vcpu, state]
  );

  return <VcpuContext.Provider value={api}>{children}</VcpuContext.Provider>;
}

export function useVcpu() {
  const ctx = useContext(VcpuContext);
  if (!ctx) throw new Error("useVcpu must be used within a VcpuProvider");
  return ctx;
}

// ============================================================================
// 13. HOOKS AUXILIARES
// ============================================================================

export function useVcpuSnapshot(intervalMs = 500) {
  const { vcpu } = useVcpu();
  const [snap, setSnap] = useState(() => vcpu.snapshot());
  useEffect(() => {
    const t = setInterval(() => setSnap(vcpu.snapshot()), intervalMs);
    return () => clearInterval(t);
  }, [vcpu, intervalMs]);
  return snap;
}

// ============================================================================
// 14. EXPORTS
// ============================================================================

export default {
  VCPU,
  VcpuProvider,
  useVcpu,
  useVcpuSnapshot,
  ARCH,
  VCPU_STATE,
  VCPU_EVENTS,
  PIPELINE_STAGE,
  OPCODE,
  CONDITION,
  EXCEPTION,
  INTERRUPT,
  RegisterFile,
  FpuRegisterFile,
  SimdRegisterFile,
  MemoryBus,
  Cache,
  CacheLine,
  CacheSet,
  Tlb,
  Mmu,
  CpuException,
  Idt,
  Pipeline,
  PipelineLatch,
  BranchPredictor,
  InstructionDecoder,
  Alu,
  Fpu,
  Simd,
  FLAG,
};
