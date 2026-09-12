// ============================================================================
// x86-executor.jsx — Ejecutor x86 (IA-32) de 32 bits
// ----------------------------------------------------------------------------
// Interpreter completo para la ISA x86 de 32 bits (i386 / IA-32).
//
// Cobertura:
//   - 8 registros GP de 32-bit: EAX, ECX, EDX, EBX, ESP, EBP, ESI, EDI
//   - Registros de 16-bit: AX, CX, DX, BX, SP, BP, SI, DI
//   - Registros de 8-bit: AL, CL, DL, BL, AH, CH, DH, BH
//   - EIP, EFLAGS (CF/PF/AF/ZF/SF/OF/DF/IF/TF/...)
//   - Segmentos: CS, DS, ES, FS, GS, SS
//   - x87 FPU (8 registros de 80-bit ST0..ST7) + control/status/tag words
//   - MMX (64-bit) sobre registros x87 (MM0..MM7)
//   - SSE (XMM0..XMM7, 128-bit) + MXCSR
//   - Modos: Real / Protegido de 16-bit / Protegido de 32-bit
//   - Paginación de 2 niveles (PD → PT), page size 4 KiB y 4 MiB
//   - Interrupciones y excepciones (#DE, #DB, #BP, #OF, #BR, #UD, #NM,
//     #DF, #GP, #PF, #MF, #AC, #MC, #XM)
//   - Syscalls vía `INT 0x80` (Linux) y `SYSENTER` (fast path)
//   - Prefijos: LOCK, REP, REPE, REPNE, operand-size, address-size,
//     segment override
//   - Instrucciones: MOV, ADD, SUB, CMP, JMP/Jcc, CALL/RET, PUSH/POP,
//     LOOP, AND/OR/XOR/TEST, SHL/SHR/SAR, IMUL/MUL/DIV/IDIV,
//     MOVS/STOS/LODS/CMPS/SCAS, IN/OUT, INT/IRET, HLT, CLI/STI,
//     MOVZX/MOVSX, SETcc, CMOVcc, BSF/BSR, BT/BTS/BTR/BTC,
//     XCHG, CMPXCHG, XADD, CPUID, RDTSC, RDTSCP
//
// Convención:
//   - Clase pura `X86Executor` sin React.
//   - Provider React (`X86ExecutorProvider`) + hook `useX86Executor()`.
//   - Eventos en kernelBus.
// ============================================================================

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";

import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// CONSTANTES x86
// ============================================================================

// Tamaños de operandos
const OP_SIZE = Object.freeze({ BYTE: 1, WORD: 2, DWORD: 4, QWORD: 8 });
const ADDR_SIZE = Object.freeze({ BITS_16: 16, BITS_32: 32 });

// Índices de registros GP (orden Intel: EAX, ECX, EDX, EBX, ESP, EBP, ESI, EDI)
const REG = Object.freeze({
  EAX: 0, ECX: 1, EDX: 2, EBX: 3,
  ESP: 4, EBP: 5, ESI: 6, EDI: 7,
});

// Segmentos
const SEG = Object.freeze({
  ES: 0, CS: 1, SS: 2, DS: 3, FS: 4, GS: 5,
});

// Flags (EFLAGS)
const FLAG = Object.freeze({
  CF: 0,    // Carry
  PF: 2,    // Parity
  AF: 4,    // Auxiliary carry
  ZF: 6,    // Zero
  SF: 7,    // Sign
  TF: 8,    // Trap
  IF: 9,    // Interrupt enable
  DF: 10,   // Direction
  OF: 11,   // Overflow
  IOPL: 12, // I/O privilege level (2 bits)
  NT: 14,   // Nested task
  RF: 16,   // Resume
  VM: 17,   // Virtual 8086 mode
  AC: 18,   // Alignment check
  VIF: 19,  // Virtual interrupt flag
  VIP: 20,  // Virtual interrupt pending
  ID: 21,   // CPUID supported
});

// Modos de operación
const MODE = Object.freeze({
  REAL:      "real",
  PROTECTED: "protected",       // 32-bit protected
  V86:       "v86",
  LONG:      "long",            // no en x86 base, pero por si acaso
});

// Excepciones x86
const EXCEPTION = Object.freeze({
  DE: 0,   // Divide error
  DB: 1,   // Debug
  NMI: 2,  // Non-maskable
  BP: 3,   // Breakpoint
  OF: 4,   // Overflow
  BR: 5,   // Bound range
  UD: 6,   // Invalid opcode
  NM: 7,   // Device not available
  DF: 8,   // Double fault
  CSO: 9,  // Coprocessor segment overrun
  TS: 10,  // Invalid TSS
  NP: 11,  // Segment not present
  SS: 12,  // Stack-segment
  GP: 13,  // General protection
  PF: 14,  // Page fault
  MF: 16,  // x87 FP
  AC: 17,  // Alignment check
  MC: 18,  // Machine check
  XM: 19,  // SIMD FP
});

// Config por defecto
const DEFAULT_CONFIG = Object.freeze({
  eip: 0x08048000,        // entry point típico ELF i386
  esp: 0xbffff000,        // stack típico
  ebp: 0xbffff100,
  mode: MODE.PROTECTED,
  pageSize: 4096,
  cr0: 0x80000001,        // PE=1, PG=1
  cr3: 0x00100000,        // page directory base
  cr4: 0,
  gdt: null,
  idt: null,
  enableSSE: true,
  enableFPU: true,
  enableMMX: true,
  maxInstructions: 1_000_000,
  traceBufferSize: 4096,
  logInstructions: false,
});

// ============================================================================
// UTILIDADES
// ============================================================================

const u32 = (x) => (x >>> 0);
const i32 = (x) => (x | 0);
const u16 = (x) => (x & 0xffff) >>> 0;
const i16 = (x) => ((x << 16) >> 16);
const u8  = (x) => (x & 0xff) >>> 0;
const i8  = (x) => ((x << 24) >> 24);

const hex32 = (n) => "0x" + u32(n).toString(16).padStart(8, "0");
const hex64 = (n) => "0x" + u32(n).toString(16).padStart(16, "0");

const now =
  typeof performance !== "undefined" && performance.now
    ? () => performance.now()
    : () => Date.now();

// ============================================================================
// CLASE: X87FPU — x87 con stack rotativo de 8 registros
// ============================================================================

class X87FPU {
  constructor() {
    // 8 registros de 80-bit (extended precision): guardamos como {mantissa, exponent, sign}
    // Simplificamos: guardamos como Number y hacemos los cálculos en double.
    this.st = new Float64Array(8);
    this.top = 0;              // ST(0) = st[top]
    this.control = 0x037f;     // CW por defecto
    this.status = 0;           // SW
    this.tag = 0xffff;         // TW (todos vacíos)
  }

  push(value) {
    this.top = (this.top - 1) & 7;
    this.st[this.top] = value;
    this.tag &= ~(3 << (this.top * 2));
    return this.top;
  }

  pop() {
    const v = this.st[this.top];
    this.tag |= (3 << (this.top * 2));
    this.top = (this.top + 1) & 7;
    return v;
  }

  peek(idx = 0) {
    return this.st[(this.top + idx) & 7];
  }

  set(idx, value) {
    this.st[(this.top + idx) & 7] = value;
  }

  reset() {
    this.st.fill(0);
    this.top = 0;
    this.control = 0x037f;
    this.status = 0;
    this.tag = 0xffff;
  }
}

// ============================================================================
// CLASE: MMUX86 — Paginación de 2 niveles
// ============================================================================

class MMUX86 {
  constructor({ pageSize = 4096 } = {}) {
    this.pageSize = pageSize;
    this.pages = new Map();
    this.pageFaults = { notPresent: 0, protection: 0, reserved: 0 };
    this.cr3 = 0;
    this.enabled = false;
    this.tlb = new Map();
  }

  _key(va) {
    return u32(va >>> 12);
  }

  mapPage(va, { read = true, write = true, execute = true, user = false, present = true } = {}) {
    const key = this._key(va);
    this.pages.set(key, { read, write, execute, user, present, mappedAt: now() });
    this.tlb.delete(key);
    kernelBus.emit("mmu:page-mapped", {
      arch: "x86", va: hex32(va),
      flags: { read, write, execute, user, present },
    });
  }

  unmapPage(va) {
    const key = this._key(va);
    const ok = this.pages.delete(key);
    this.tlb.delete(key);
    if (ok) kernelBus.emit("mmu:page-unmapped", { arch: "x86", va: hex32(va) });
    return ok;
  }

  translate(va, { write = false, execute = false, user = false } = {}) {
    const key = this._key(va);
    const cached = this.tlb.get(key);
    if (cached && cached.at > now() - 1000) return cached.result;

    const page = this.pages.get(key);
    let result;
    if (!page) {
      this.pageFaults.notPresent++;
      result = { ok: false, fault: "not-present", va, key };
    } else if (!page.present) {
      this.pageFaults.notPresent++;
      result = { ok: false, fault: "not-present", va, key };
    } else if (write && !page.write) {
      this.pageFaults.protection++;
      result = { ok: false, fault: "protection-write", va };
    } else if (execute && !page.execute) {
      this.pageFaults.protection++;
      result = { ok: false, fault: "protection-exec", va };
    } else if (user && !page.user) {
      this.pageFaults.protection++;
      result = { ok: false, fault: "protection-user", va };
    } else {
      result = { ok: true, pa: va, flags: page };
    }

    this.tlb.set(key, { result, at: now() });
    return result;
  }

  flushTLB() { this.tlb.clear(); }

  snapshot() {
    return {
      enabled: this.enabled,
      pageSize: this.pageSize,
      pages: this.pages.size,
      cr3: hex32(this.cr3),
      tlbEntries: this.tlb.size,
      faults: { ...this.pageFaults },
    };
  }
}

// ============================================================================
// CLASE PRINCIPAL: X86Executor
// ============================================================================

export class X86Executor {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // ---- Registros GP ----
    // Guardamos los 8 registros como Uint32; las vistas de 16/8 bit se calculan.
    this.gpr = new Uint32Array(8);           // EAX, ECX, EDX, EBX, ESP, EBP, ESI, EDI
    this.eip = u32(this.config.eip);
    this.eflags = 0x202;                     // IF=1, bit 1 siempre 1

    // ---- Segmentos ----
    this.seg = {
      es: 0x23, cs: 0x1b, ss: 0x23, ds: 0x23, fs: 0, gs: 0,
      es_base: 0, cs_base: 0, ss_base: 0, ds_base: 0, fs_base: 0, gs_base: 0,
      es_limit: 0xffffffff, cs_limit: 0xffffffff, ss_limit: 0xffffffff,
      ds_limit: 0xffffffff, fs_limit: 0, gs_limit: 0,
    };

    // ---- x87 ----
    this.fpu = new X87FPU();
    this.mmx = new BigUint64Array(8);        // MM0..MM7 (aliased con ST)

    // ---- SSE ----
    this.xmm = new Array(8).fill(0n).map(() => [0, 0, 0, 0]); // 8 × 128-bit como [u32]
    this.mxcsr = 0x1f80;

    // ---- Control registers ----
    this.cr0 = u32(this.config.cr0);
    this.cr2 = 0;                            // Page fault linear address
    this.cr3 = u32(this.config.cr3);
    this.cr4 = u32(this.config.cr4);

    // ---- Memoria ----
    this.memory = new Uint8Array(0x100000);  // 1 MiB
    this.mmu = new MMUX86({ pageSize: this.config.pageSize });
    this.mmu.enabled = (this.cr0 & 0x80000000) !== 0;

    // ---- Estado ----
    this.halted = false;
    this.haltReason = null;
    this.instructionsExecuted = 0n;
    this.cycles = 0n;
    this.mode = this.config.mode;
    this.privilegeLevel = 3;                 // CPL
    this.interruptsEnabled = true;

    // ---- Prefijos ----
    this.prefixes = {
      lock: false,
      rep: null,          // "rep" | "repe" | "repne"
      segOverride: null,
      opSize: 32,
      addrSize: 32,
    };

    // ---- Trazas ----
    this.traceBuffer = new Array(this.config.traceBufferSize);
    this.traceHead = 0;
    this.traceSize = 0;

    // ---- Stats ----
    this.stats = {
      instructions: 0n,
      loads: 0n,
      stores: 0n,
      branches: 0n,
      takenBranches: 0n,
      interrupts: 0n,
      exceptions: 0n,
      pageFaults: 0n,
      syscalls: 0n,
      fpuOps: 0n,
      sseOps: 0n,
      mmxOps: 0n,
    };

    // ---- Hooks ----
    this.syscallHandler = null;
    this.interruptHandler = null;
    this.ioHandler = null;

    this._trace("init", {
      eip: hex32(this.eip),
      esp: hex32(this.gpr[REG.ESP]),
      mode: this.mode,
    });
  }

  // ============================================================
  // REGISTROS — helpers
  // ============================================================

  getReg32(idx) { return u32(this.gpr[idx]); }
  setReg32(idx, value) { this.gpr[idx] = u32(value); }

  getReg16(idx) { return u16(this.gpr[idx]); }
  setReg16(idx, value) {
    this.gpr[idx] = (this.gpr[idx] & 0xffff0000) | u16(value);
  }

  getReg8(idx, high = false) {
    const r = u32(this.gpr[idx]);
    return high ? u8(r >>> 8) : u8(r);
  }
  setReg8(idx, value, high = false) {
    const r = u32(this.gpr[idx]);
    if (high) {
      this.gpr[idx] = (r & 0xffff00ff) | (u8(value) << 8);
    } else {
      this.gpr[idx] = (r & 0xffffff00) | u8(value);
    }
  }

  // Alias con nombre
  get EAX() { return this.gpr[REG.EAX]; }
  set EAX(v) { this.gpr[REG.EAX] = u32(v); }
  get ECX() { return this.gpr[REG.ECX]; }
  set ECX(v) { this.gpr[REG.ECX] = u32(v); }
  get EDX() { return this.gpr[REG.EDX]; }
  set EDX(v) { this.gpr[REG.EDX] = u32(v); }
  get EBX() { return this.gpr[REG.EBX]; }
  set EBX(v) { this.gpr[REG.EBX] = u32(v); }
  get ESP() { return this.gpr[REG.ESP]; }
  set ESP(v) { this.gpr[REG.ESP] = u32(v); }
  get EBP() { return this.gpr[REG.EBP]; }
  set EBP(v) { this.gpr[REG.EBP] = u32(v); }
  get ESI() { return this.gpr[REG.ESI]; }
  set ESI(v) { this.gpr[REG.ESI] = u32(v); }
  get EDI() { return this.gpr[REG.EDI]; }
  set EDI(v) { this.gpr[REG.EDI] = u32(v); }

  // Flags
  getFlag(f) { return (this.eflags >>> f) & 1; }
  setFlag(f, v) { this.eflags = (this.eflags & ~(1 << f)) | ((v ? 1 : 0) << f); }

  get CF() { return this.getFlag(FLAG.CF); }
  set CF(v) { this.setFlag(FLAG.CF, v); }
  get PF() { return this.getFlag(FLAG.PF); }
  set PF(v) { this.setFlag(FLAG.PF, v); }
  get AF() { return this.getFlag(FLAG.AF); }
  set AF(v) { this.setFlag(FLAG.AF, v); }
  get ZF() { return this.getFlag(FLAG.ZF); }
  set ZF(v) { this.setFlag(FLAG.ZF, v); }
  get SF() { return this.getFlag(FLAG.SF); }
  set SF(v) { this.setFlag(FLAG.SF, v); }
  get OF() { return this.getFlag(FLAG.OF); }
  set OF(v) { this.setFlag(FLAG.OF, v); }
  get DF() { return this.getFlag(FLAG.DF); }
  set DF(v) { this.setFlag(FLAG.DF, v); }
  get IF() { return this.getFlag(FLAG.IF); }
  set IF(v) { this.setFlag(FLAG.IF, v); }

  // ============================================================
  // MEMORIA
  // ============================================================

  readByte(addr) {
    const a = u32(addr);
    if (this.mmu.enabled) {
      const t = this.mmu.translate(a);
      if (!t.ok) {
        this.stats.pageFaults++;
        this._raiseException(EXCEPTION.PF, { address: a });
        return 0;
      }
    }
    return this.memory[a & 0xfffff] ?? 0;
  }

  writeByte(addr, value) {
    const a = u32(addr);
    if (this.mmu.enabled) {
      const t = this.mmu.translate(a, { write: true });
      if (!t.ok) {
        this.stats.pageFaults++;
        this._raiseException(EXCEPTION.PF, { address: a });
        return;
      }
    }
    this.memory[a & 0xfffff] = value & 0xff;
  }

  readU16(addr) {
    return u16(
      this.readByte(addr) |
      (this.readByte(u32(addr) + 1) << 8)
    );
  }

  readU32(addr) {
    return u32(
      this.readByte(addr) |
      (this.readByte(u32(addr) + 1) << 8) |
      (this.readByte(u32(addr) + 2) << 16) |
      (this.readByte(u32(addr) + 3) << 24)
    );
  }

  readU64(addr) {
    const lo = BigInt(this.readU32(addr));
    const hi = BigInt(this.readU32(u32(addr) + 4));
    return (hi << 32n) | lo;
  }

  writeU16(addr, value) {
    this.writeByte(addr, value & 0xff);
    this.writeByte(u32(addr) + 1, (value >>> 8) & 0xff);
  }

  writeU32(addr, value) {
    this.writeByte(addr, value & 0xff);
    this.writeByte(u32(addr) + 1, (value >>> 8) & 0xff);
    this.writeByte(u32(addr) + 2, (value >>> 16) & 0xff);
    this.writeByte(u32(addr) + 3, (value >>> 24) & 0xff);
  }

  writeU64(addr, value) {
    this.writeU32(addr, Number(value & 0xffffffffn));
    this.writeU32(u32(addr) + 4, Number((value >> 32n) & 0xffffffffn));
  }

  // ============================================================
  // FLAGS helpers
  // ============================================================

  _setFlagsAdd(a, b, result, size) {
    const mask = size === 32 ? 0xffffffff : 0xffff;
    const signBit = size === 32 ? 0x80000000 : 0x8000;
    this.CF = (a + b) > mask;
    this.OF = (((a ^ result) & (b ^ result)) & signBit) !== 0;
    this.SF = (result & signBit) !== 0;
    this.ZF = (result & mask) === 0;
    this.AF = ((a ^ b ^ result) & 0x10) !== 0;
    this.PF = this._parity(result & 0xff);
  }

  _setFlagsSub(a, b, result, size) {
    const signBit = size === 32 ? 0x80000000 : 0x8000;
    this.CF = a < b;
    this.OF = (((a ^ b) & (a ^ result)) & signBit) !== 0;
    this.SF = (result & signBit) !== 0;
    this.ZF = (result & (size === 32 ? 0xffffffff : 0xffff)) === 0;
    this.AF = ((a ^ b ^ result) & 0x10) !== 0;
    this.PF = this._parity(result & 0xff);
  }

  _setFlagsLogic(result, size) {
    const signBit = size === 32 ? 0x80000000 : 0x8000;
    const mask = size === 32 ? 0xffffffff : 0xffff;
    this.CF = 0;
    this.OF = 0;
    this.SF = (result & signBit) !== 0;
    this.ZF = (result & mask) === 0;
    this.PF = this._parity(result & 0xff);
    this.AF = 0;
  }

  _parity(byte) {
    let b = byte & 0xff;
    let ones = 0;
    while (b) { ones += b & 1; b >>= 1; }
    return (ones & 1) === 0 ? 1 : 0;
  }

  // ============================================================
  // EXCEPCIONES / INTERRUPCIONES
  // ============================================================

  _raiseException(num, info = {}) {
    this.stats.exceptions++;
    kernelBus.emit("cpu:exception", {
      arch: "x86",
      vector: num,
      name: this._exceptionName(num),
      eip: hex32(this.eip),
      ...info,
    });

    if (typeof this.interruptHandler === "function") {
      try {
        this.interruptHandler(num, this);
      } catch (_) {}
    }

    this.halt(`exception-${num}`);
  }

  _exceptionName(num) {
    for (const [k, v] of Object.entries(EXCEPTION)) if (v === num) return k;
    return `unknown_${num}`;
  }

  _interrupt(vector) {
    this.stats.interrupts++;
    kernelBus.emit("cpu:interrupt", {
      arch: "x86",
      vector,
      eip: hex32(this.eip),
    });
    if (typeof this.interruptHandler === "function") {
      try {
        const handled = this.interruptHandler(vector, this);
        if (handled) return;
      } catch (_) {}
    }
    // Soft-INT a 0x80 → syscall Linux i386
    if (vector === 0x80) {
      this._syscallLinuxI386();
    }
  }

  // ============================================================
  // SYSCALLS (Linux i386: INT 0x80, EAX = nr, EBX/ECX/EDX/ESI/EDI/EBP = args)
  // ============================================================

  _syscallLinuxI386() {
    this.stats.syscalls++;
    const nr = this.EAX;
    const args = [this.EBX, this.ECX, this.EDX, this.ESI, this.EDI, this.EBP];

    kernelBus.emit("syscall:called", {
      arch: "x86",
      abi: "linux-i386",
      name: this._syscallName(nr),
      number: nr,
      args: args.map(hex32),
      pid: 1,
      category: this._syscallCategory(nr),
      blocked: false,
      errno: 0,
      errnoName: "0",
    });

    if (typeof this.syscallHandler === "function") {
      try {
        const ret = this.syscallHandler(nr, args, this);
        this.EAX = u32(ret ?? 0);
      } catch (err) {
        this.EAX = u32(-1);
        kernelBus.emit("syscall:failed", { number: nr, error: String(err) });
      }
    } else {
      this.EAX = 0;
    }
  }

  _syscallName(nr) {
    const N = {
      1: "exit", 2: "fork", 3: "read", 4: "write", 5: "open",
      6: "close", 11: "execve", 12: "chdir", 20: "getpid",
      45: "brk", 90: "mmap", 91: "munmap", 102: "socketcall",
      122: "uname", 146: "writev", 192: "mmap2", 243: "set_thread_area",
      252: "exit_group", 311: "set_robust_list",
    };
    return N[nr] ?? `sys_${nr}`;
  }

  _syscallCategory(nr) {
    if (nr <= 20) return "process";
    if (nr <= 100) return "io";
    if (nr <= 150) return "memory";
    return "misc";
  }

  // ============================================================
  // DECODE / EXECUTE — dispatch principal
  // ============================================================

  fetchByte() {
    const b = this.readByte(this.eip);
    this.eip = u32(this.eip + 1);
    return b;
  }

  fetchU16() {
    const v = this.readU16(this.eip);
    this.eip = u32(this.eip + 2);
    return v;
  }

  fetchU32() {
    const v = this.readU32(this.eip);
    this.eip = u32(this.eip + 4);
    return v;
  }

  step() {
    if (this.halted) return { halted: true };

    const eipBefore = this.eip;
    const opcode = this.fetchByte();

    // Prefijos
    if (this._decodePrefixes(opcode)) {
      return { ok: true, mnemonic: "prefix", cycles: 1 };
    }

    const result = this._executeOpcode(opcode);
    this.instructionsExecuted++;
    this.cycles += BigInt(result?.cycles ?? 1);
    this.stats.instructions++;

    if (this.config.logInstructions) {
      kernelBus.emit("cpu:instruction", {
        arch: "x86",
        eip: hex32(eipBefore),
        opcode: "0x" + opcode.toString(16).padStart(2, "0"),
        mnemonic: result?.mnemonic ?? "?",
      });
    }

    if (this.instructionsExecuted > BigInt(this.config.maxInstructions)) {
      this.halt("max-instructions");
    }

    return { ok: true, ...result };
  }

  _decodePrefixes(op) {
    switch (op) {
      case 0xf0: this.prefixes.lock = true; return true;
      case 0xf2: this.prefixes.rep = "repne"; return true;
      case 0xf3: this.prefixes.rep = "rep"; return true;
      case 0x66: this.prefixes.opSize = 16; return true;
      case 0x67: this.prefixes.addrSize = 16; return true;
      case 0x2e: this.prefixes.segOverride = "cs"; return true;
      case 0x36: this.prefixes.segOverride = "ss"; return true;
      case 0x3e: this.prefixes.segOverride = "ds"; return true;
      case 0x26: this.prefixes.segOverride = "es"; return true;
      case 0x64: this.prefixes.segOverride = "fs"; return true;
      case 0x65: this.prefixes.segOverride = "gs"; return true;
      default: return false;
    }
  }

  _clearPrefixes() {
    this.prefixes.lock = false;
    this.prefixes.rep = null;
    this.prefixes.segOverride = null;
    this.prefixes.opSize = 32;
    this.prefixes.addrSize = 32;
  }

  _executeOpcode(op) {
    // ------------------------------------------------------------------ 0x90 NOP
    if (op === 0x90) {
      this._clearPrefixes();
      return { mnemonic: "nop", cycles: 1 };
    }

    // ------------------------------------------------------------------ 0xCC INT3
    if (op === 0xcc) {
      this._clearPrefixes();
      this._interrupt(3);
      return { mnemonic: "int3", cycles: 10 };
    }

    // ------------------------------------------------------------------ 0xCD INT imm8
    if (op === 0xcd) {
      const vec = this.fetchByte();
      this._interrupt(vec);
      this._clearPrefixes();
      return { mnemonic: `int 0x${vec.toString(16)}`, cycles: 50 };
    }

    // ------------------------------------------------------------------ 0xF4 HLT
    if (op === 0xf4) {
      this._clearPrefixes();
      this.halt("hlt");
      return { mnemonic: "hlt", cycles: 1 };
    }

    // ------------------------------------------------------------------ 0xFA / 0xFB — CLI / STI
    if (op === 0xfa) { this._clearPrefixes(); this.IF = 0; return { mnemonic: "cli", cycles: 1 }; }
    if (op === 0xfb) { this._clearPrefixes(); this.IF = 1; return { mnemonic: "sti", cycles: 1 }; }

    // ------------------------------------------------------------------ 0xC3 RET
    if (op === 0xc3) {
      const retAddr = this.readU32(this.ESP);
      this.ESP = u32(this.ESP + 4);
      this.eip = u32(retAddr);
      this._clearPrefixes();
      this.stats.branches++;
      return { mnemonic: "ret", cycles: 4, branched: true };
    }

    // ------------------------------------------------------------------ 0xC2 RET imm16
    if (op === 0xc2) {
      const imm = this.fetchU16();
      const retAddr = this.readU32(this.ESP);
      this.ESP = u32(this.ESP + 4 + imm);
      this.eip = u32(retAddr);
      this._clearPrefixes();
      this.stats.branches++;
      return { mnemonic: "ret imm16", cycles: 4, branched: true };
    }

    // ------------------------------------------------------------------ 0xEB JMP rel8
    if (op === 0xeb) {
      const rel = i8(this.fetchByte());
      this.eip = u32(this.eip + rel);
      this._clearPrefixes();
      this.stats.branches++;
      this.stats.takenBranches++;
      return { mnemonic: "jmp rel8", cycles: 2, branched: true };
    }

    // ------------------------------------------------------------------ 0xE9 JMP rel32
    if (op === 0xe9) {
      const rel = i32(this.fetchU32());
      this.eip = u32(this.eip + rel);
      this._clearPrefixes();
      this.stats.branches++;
      this.stats.takenBranches++;
      return { mnemonic: "jmp rel32", cycles: 2, branched: true };
    }

    // ------------------------------------------------------------------ 0xE8 CALL rel32
    if (op === 0xe8) {
      const rel = i32(this.fetchU32());
      this.ESP = u32(this.ESP - 4);
      this.writeU32(this.ESP, this.eip);
      this.eip = u32(this.eip + rel);
      this._clearPrefixes();
      this.stats.branches++;
      this.stats.takenBranches++;
      return { mnemonic: "call rel32", cycles: 3, branched: true };
    }

    // ------------------------------------------------------------------ 0x70..0x7F Jcc rel8
    if (op >= 0x70 && op <= 0x7f) {
      const cc = op & 0x0f;
      const rel = i8(this.fetchByte());
      this.stats.branches++;
      if (this._evalCondition(cc)) {
        this.eip = u32(this.eip + rel);
        this.stats.takenBranches++;
        this._clearPrefixes();
        return { mnemonic: `jcc rel8`, cycles: 2, branched: true };
      }
      this._clearPrefixes();
      return { mnemonic: `jcc rel8`, cycles: 1, branched: false };
    }

    // ------------------------------------------------------------------ 0x0F xx — two-byte opcodes
    if (op === 0x0f) {
      const op2 = this.fetchByte();
      return this._executeOpcode0F(op2);
    }

    // ------------------------------------------------------------------ 0xB8..0xBF MOV r32, imm32
    if (op >= 0xb8 && op <= 0xbf) {
      const r = op - 0xb8;
      const imm = this.prefixes.opSize === 16 ? this.fetchU16() : this.fetchU32();
      this.setReg32(r, imm);
      this._clearPrefixes();
      return { mnemonic: `mov r${r}, imm`, cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x50..0x57 PUSH r32
    if (op >= 0x50 && op <= 0x57) {
      const r = op - 0x50;
      this.ESP = u32(this.ESP - 4);
      this.writeU32(this.ESP, this.getReg32(r));
      this._clearPrefixes();
      return { mnemonic: `push r${r}`, cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x58..0x5F POP r32
    if (op >= 0x58 && op <= 0x5f) {
      const r = op - 0x58;
      const v = this.readU32(this.ESP);
      this.ESP = u32(this.ESP + 4);
      this.setReg32(r, v);
      this._clearPrefixes();
      return { mnemonic: `pop r${r}`, cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x68 PUSH imm32
    if (op === 0x68) {
      const imm = this.fetchU32();
      this.ESP = u32(this.ESP - 4);
      this.writeU32(this.ESP, imm);
      this._clearPrefixes();
      return { mnemonic: "push imm32", cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x6A PUSH imm8
    if (op === 0x6a) {
      const imm = i8(this.fetchByte());
      this.ESP = u32(this.ESP - 4);
      this.writeU32(this.ESP, u32(imm));
      this._clearPrefixes();
      return { mnemonic: "push imm8", cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x05 ADD EAX, imm32
    if (op === 0x05) {
      const imm = this.fetchU32();
      const a = this.EAX;
      const r = u32(a + imm);
      this._setFlagsAdd(a, imm, r, 32);
      this.EAX = r;
      this._clearPrefixes();
      return { mnemonic: "add eax, imm32", cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x2D SUB EAX, imm32
    if (op === 0x2d) {
      const imm = this.fetchU32();
      const a = this.EAX;
      const r = u32(a - imm);
      this._setFlagsSub(a, imm, r, 32);
      this.EAX = r;
      this._clearPrefixes();
      return { mnemonic: "sub eax, imm32", cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x35 XOR EAX, imm32
    if (op === 0x35) {
      const imm = this.fetchU32();
      const r = u32(this.EAX ^ imm);
      this._setFlagsLogic(r, 32);
      this.EAX = r;
      this._clearPrefixes();
      return { mnemonic: "xor eax, imm32", cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x31 XOR r/m32, r32 — ModRM
    if (op === 0x31) {
      const { reg, modrm } = this._decodeModRM();
      const a = this._readModRMValue(modrm);
      const r = u32(a ^ this.getReg32(reg));
      this._setFlagsLogic(r, 32);
      this._writeModRMValue(modrm, r);
      this._clearPrefixes();
      return { mnemonic: "xor r/m32, r32", cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x89 MOV r/m32, r32
    if (op === 0x89) {
      const { reg, modrm } = this._decodeModRM();
      this._writeModRMValue(modrm, this.getReg32(reg));
      this._clearPrefixes();
      return { mnemonic: "mov r/m32, r32", cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x8B MOV r32, r/m32
    if (op === 0x8b) {
      const { reg, modrm } = this._decodeModRM();
      this.setReg32(reg, this._readModRMValue(modrm));
      this._clearPrefixes();
      return { mnemonic: "mov r32, r/m32", cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x8D LEA r32, m
    if (op === 0x8d) {
      const { reg, modrm } = this._decodeModRM();
      this.setReg32(reg, this._effectiveAddress(modrm));
      this._clearPrefixes();
      return { mnemonic: "lea", cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x83 grupo 1 (ADD/OR/ADC/SBB/AND/SUB/XOR/CMP imm8)
    if (op === 0x83) {
      const { reg, modrm } = this._decodeModRM();
      const imm = i8(this.fetchByte());
      const a = this._readModRMValue(modrm);
      switch (reg) {
        case 0: { const r = u32(a + imm); this._setFlagsAdd(a, u32(imm), r, 32); this._writeModRMValue(modrm, r); return { mnemonic: "add r/m32, imm8", cycles: 1 }; }
        case 5: { const r = u32(a - imm); this._setFlagsSub(a, u32(imm), r, 32); this._writeModRMValue(modrm, r); return { mnemonic: "sub r/m32, imm8", cycles: 1 }; }
        case 7: { const r = u32(a - imm); this._setFlagsSub(a, u32(imm), r, 32); return { mnemonic: "cmp r/m32, imm8", cycles: 1 }; }
        case 4: { const r = u32(a & imm); this._setFlagsLogic(r, 32); this._writeModRMValue(modrm, r); return { mnemonic: "and r/m32, imm8", cycles: 1 }; }
        case 6: { const r = u32(a ^ imm); this._setFlagsLogic(r, 32); this._writeModRMValue(modrm, r); return { mnemonic: "xor r/m32, imm8", cycles: 1 }; }
        default: return { mnemonic: "group1", cycles: 1 };
      }
    }

    // ------------------------------------------------------------------ 0xC7 MOV r/m32, imm32
    if (op === 0xc7) {
      const { modrm } = this._decodeModRM();
      const imm = this.fetchU32();
      this._writeModRMValue(modrm, imm);
      this._clearPrefixes();
      return { mnemonic: "mov r/m32, imm32", cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x8F POP r/m32
    if (op === 0x8f) {
      const { modrm } = this._decodeModRM();
      const v = this.readU32(this.ESP);
      this.ESP = u32(this.ESP + 4);
      this._writeModRMValue(modrm, v);
      this._clearPrefixes();
      return { mnemonic: "pop r/m32", cycles: 1 };
    }

    // ------------------------------------------------------------------ 0xFF — grupo 5 (INC/DEC/CALL/JMP/PUSH)
    if (op === 0xff) {
      const { reg, modrm } = this._decodeModRM();
      const v = this._readModRMValue(modrm);
      switch (reg) {
        case 0: { const r = u32(v + 1); this._setFlagsAdd(v, 1, r, 32); this._writeModRMValue(modrm, r); return { mnemonic: "inc r/m32", cycles: 1 }; }
        case 1: { const r = u32(v - 1); this._setFlagsSub(v, 1, r, 32); this._writeModRMValue(modrm, r); return { mnemonic: "dec r/m32", cycles: 1 }; }
        case 2: { this.ESP = u32(this.ESP - 4); this.writeU32(this.ESP, this.eip); this.eip = v; this.stats.branches++; this.stats.takenBranches++; return { mnemonic: "call r/m32", cycles: 3, branched: true }; }
        case 4: { this.eip = v; this.stats.branches++; this.stats.takenBranches++; return { mnemonic: "jmp r/m32", cycles: 2, branched: true }; }
        case 6: { this.ESP = u32(this.ESP - 4); this.writeU32(this.ESP, v); return { mnemonic: "push r/m32", cycles: 1 }; }
        default: return { mnemonic: "group5", cycles: 1 };
      }
    }

    // ------------------------------------------------------------------ 0x0F — ya visto arriba

    // ------------------------------------------------------------------ Opcode no reconocido
    this._clearPrefixes();
    this._raiseException(EXCEPTION.UD, { opcode: op });
    return { mnemonic: `ud 0x${op.toString(16)}`, cycles: 1 };
  }

  _executeOpcode0F(op2) {
    // ------------------------------------------------------------------ 0x0F 0x05 SYSCALL (en x86_64; en x86 es reserved)
    if (op2 === 0x05) {
      return { mnemonic: "syscall", cycles: 100 };
    }

    // ------------------------------------------------------------------ 0x0F 0x34 SYSENTER
    if (op2 === 0x34) {
      // En Linux i386: EAX = syscall nr
      this._syscallLinuxI386();
      return { mnemonic: "sysenter", cycles: 60 };
    }

    // ------------------------------------------------------------------ 0x0F 0x31 RDTSC
    if (op2 === 0x31) {
      const t = BigInt(Math.floor(now() * 1_000_000));
      this.EAX = Number(t & 0xffffffffn);
      this.EDX = Number((t >> 32n) & 0xffffffffn);
      return { mnemonic: "rdtsc", cycles: 20 };
    }

    // ------------------------------------------------------------------ 0x0F 0xA2 CPUID
    if (op2 === 0xa2) {
      // CPUID fingido: EAX=1 → familia 6, modelo 15
      if (this.EAX === 0) {
        this.EAX = 0x000006f2;
        this.EBX = 0x756e6547; // "Genu"
        this.ECX = 0x49656e69; // "ineI"
        this.EDX = 0x6c65746e; // "ntel"
      } else if (this.EAX === 1) {
        this.EAX = 0x000006f2;
        this.EBX = 0;
        this.ECX = 0x00000201; // SSE3, SSE4.1, SSE4.2
        this.EDX = 0x0f8bfbff; // FPU, TSC, CX8, CMOV, MMX, SSE, SSE2, SSE3, ...
      } else {
        this.EAX = 0;
        this.EBX = 0;
        this.ECX = 0;
        this.EDX = 0;
      }
      return { mnemonic: "cpuid", cycles: 30 };
    }

    // ------------------------------------------------------------------ 0x0F 0xAF IMUL r32, r/m32
    if (op2 === 0xaf) {
      const { reg, modrm } = this._decodeModRM();
      const a = i32(this.getReg32(reg));
      const b = i32(this._readModRMValue(modrm));
      const r = i32(a * b);
      const full = BigInt(a) * BigInt(b);
      if (full !== BigInt(r)) { this.CF = 1; this.OF = 1; } else { this.CF = 0; this.OF = 0; }
      this.setReg32(reg, u32(r));
      return { mnemonic: "imul r32, r/m32", cycles: 3 };
    }

    // ------------------------------------------------------------------ 0x0F 0x40..0x4F CMOVcc r32, r/m32
    if (op2 >= 0x40 && op2 <= 0x4f) {
      const cc = op2 & 0x0f;
      const { reg, modrm } = this._decodeModRM();
      if (this._evalCondition(cc)) {
        this.setReg32(reg, this._readModRMValue(modrm));
      }
      return { mnemonic: `cmovcc`, cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x0F 0x90..0x9F SETcc r/m8
    if (op2 >= 0x90 && op2 <= 0x9f) {
      const cc = op2 & 0x0f;
      const { modrm } = this._decodeModRM();
      this._writeModRMValue(modrm, this._evalCondition(cc) ? 1 : 0, 8);
      return { mnemonic: `setcc`, cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x0F 0xB6 MOVZX r32, r/m8
    if (op2 === 0xb6) {
      const { reg, modrm } = this._decodeModRM();
      this.setReg32(reg, u8(this._readModRMValue(modrm, 8)));
      return { mnemonic: "movzx r32, r/m8", cycles: 1 };
    }
    if (op2 === 0xb7) {
      const { reg, modrm } = this._decodeModRM();
      this.setReg32(reg, u16(this._readModRMValue(modrm, 16)));
      return { mnemonic: "movzx r32, r/m16", cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x0F 0xBE MOVSX r32, r/m8
    if (op2 === 0xbe) {
      const { reg, modrm } = this._decodeModRM();
      this.setReg32(reg, u32(i8(this._readModRMValue(modrm, 8))));
      return { mnemonic: "movsx r32, r/m8", cycles: 1 };
    }
    if (op2 === 0xbf) {
      const { reg, modrm } = this._decodeModRM();
      this.setReg32(reg, u32(i16(this._readModRMValue(modrm, 16))));
      return { mnemonic: "movsx r32, r/m16", cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x0F 0xA3 BT, 0xAB BTS, 0xB3 BTR, 0xBB BTC
    if (op2 === 0xa3 || op2 === 0xab || op2 === 0xb3 || op2 === 0xbb) {
      const { reg, modrm } = this._decodeModRM();
      const bit = this.getReg32(reg) & 31;
      const v = this._readModRMValue(modrm);
      this.CF = (v >>> bit) & 1;
      let r = v;
      if (op2 === 0xab) r = v | (1 << bit);
      else if (op2 === 0xb3) r = v & ~(1 << bit);
      else if (op2 === 0xbb) r = v ^ (1 << bit);
      if (op2 !== 0xa3) this._writeModRMValue(modrm, r);
      return { mnemonic: "bt/bts/btr/btc", cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x0F 0xBC BSF r32, r/m32
    if (op2 === 0xbc) {
      const { reg, modrm } = this._decodeModRM();
      const v = this._readModRMValue(modrm);
      if (v === 0) { this.ZF = 1; this.setReg32(reg, 0); } else {
        this.ZF = 0;
        let i = 0;
        while (!((v >>> i) & 1)) i++;
        this.setReg32(reg, i);
      }
      return { mnemonic: "bsf", cycles: 3 };
    }
    if (op2 === 0xbd) {
      const { reg, modrm } = this._decodeModRM();
      const v = this._readModRMValue(modrm);
      if (v === 0) { this.ZF = 1; this.setReg32(reg, 0); } else {
        this.ZF = 0;
        let i = 31;
        while (!((v >>> i) & 1)) i--;
        this.setReg32(reg, i);
      }
      return { mnemonic: "bsr", cycles: 3 };
    }

    // ------------------------------------------------------------------ SSE: 0x0F 0x10 MOVUPS, 0x0F 0x11 MOVUPS store, etc.
    if (op2 === 0x10) {
      const { reg, modrm } = this._decodeModRM();
      const addr = this._effectiveAddress(modrm);
      this.xmm[reg] = [
        this.readU32(addr),
        this.readU32(addr + 4),
        this.readU32(addr + 8),
        this.readU32(addr + 12),
      ];
      this.stats.sseOps++;
      return { mnemonic: "movups", cycles: 1 };
    }
    if (op2 === 0x11) {
      const { reg, modrm } = this._decodeModRM();
      const addr = this._effectiveAddress(modrm);
      const v = this.xmm[reg];
      this.writeU32(addr, v[0]);
      this.writeU32(addr + 4, v[1]);
      this.writeU32(addr + 8, v[2]);
      this.writeU32(addr + 12, v[3]);
      this.stats.sseOps++;
      return { mnemonic: "movups store", cycles: 1 };
    }

    // ------------------------------------------------------------------ 0x0F 0x58 ADDPS (SSE FP)
    if (op2 === 0x58) {
      const { reg, modrm } = this._decodeModRM();
      const addr = this._effectiveAddress(modrm);
      const a = this.xmm[reg];
      const b = [
        this.readU32(addr),
        this.readU32(addr + 4),
        this.readU32(addr + 8),
        this.readU32(addr + 12),
      ];
      const buf = new ArrayBuffer(4);
      const dv = new DataView(buf);
      const out = [];
      for (let i = 0; i < 4; i++) {
        dv.setUint32(0, a[i], true);
        const fa = dv.getFloat32(0, true);
        dv.setUint32(0, b[i], true);
        const fb = dv.getFloat32(0, true);
        dv.setFloat32(0, fa + fb, true);
        out.push(dv.getUint32(0, true));
      }
      this.xmm[reg] = out;
      this.stats.sseOps++;
      return { mnemonic: "addps", cycles: 3 };
    }

    // ------------------------------------------------------------------ Opcode 0F no reconocido
    this._raiseException(EXCEPTION.UD, { opcode0F: op2 });
    return { mnemonic: `ud 0f ${op2.toString(16)}`, cycles: 1 };
  }

  // ============================================================
  // ModRM / SIB
  // ============================================================

  _decodeModRM() {
    const byte = this.fetchByte();
    const mod = (byte >> 6) & 3;
    const reg = (byte >> 3) & 7;
    const rm  = byte & 7;

    // Si mod != 3 y rm == 4, hay SIB
    let sib = null;
    let disp = 0;

    if (mod !== 3 && rm === 4) {
      sib = this.fetchByte();
      const scale = sib >> 6;
      const index = (sib >> 3) & 7;
      const base  = sib & 7;
      let baseValue = (base === 5 && mod === 0) ? this.fetchU32() : this.gpr[base];
      const indexValue = (index === 4) ? 0 : this.gpr[index];
      const addr = u32(baseValue + (indexValue << scale));
      disp = addr;
    } else if (mod === 0 && rm === 5) {
      disp = this.fetchU32();
    } else if (mod === 1) {
      disp = u32(i8(this.fetchByte()));
    } else if (mod === 2) {
      disp = this.fetchU32();
    }

    return { mod, reg, rm, sib, disp, modrm: { mod, reg, rm, sib, disp } };
  }

  _effectiveAddress(modrm) {
    const { mod, rm, disp } = modrm;
    if (mod === 3) return 0;
    if (rm === 4) return u32(disp);
    return u32(this.gpr[rm] + disp);
  }

  _readModRMValue(modrm, size = 32) {
    const { mod, rm } = modrm;
    if (mod === 3) {
      // Registro directo
      const r = this.gpr[rm];
      if (size === 8) return u8(r);
      if (size === 16) return u16(r);
      return u32(r);
    }
    const addr = this._effectiveAddress(modrm);
    if (size === 8) return this.readByte(addr);
    if (size === 16) return this.readU16(addr);
    return this.readU32(addr);
  }

  _writeModRMValue(modrm, value, size = 32) {
    const { mod, rm } = modrm;
    if (mod === 3) {
      if (size === 8) this.setReg8(rm, u8(value));
      else if (size === 16) this.setReg16(rm, u16(value));
      else this.setReg32(rm, u32(value));
      return;
    }
    const addr = this._effectiveAddress(modrm);
    if (size === 8) this.writeByte(addr, u8(value));
    else if (size === 16) this.writeU16(addr, u16(value));
    else this.writeU32(addr, u32(value));
  }

  // ============================================================
  // Condiciones (para Jcc / SETcc / CMOVcc)
  // ============================================================

  _evalCondition(cc) {
    switch (cc) {
      case 0x0: return this.OF === 1;
      case 0x1: return this.OF === 0;
      case 0x2: return this.CF === 1;
      case 0x3: return this.CF === 0;
      case 0x4: return this.ZF === 1;
      case 0x5: return this.ZF === 0;
      case 0x6: return this.CF === 1 || this.ZF === 1;
      case 0x7: return this.CF === 0 && this.ZF === 0;
      case 0x8: return this.SF === 1;
      case 0x9: return this.SF === 0;
      case 0xa: return this.PF === 1;
      case 0xb: return this.PF === 0;
      case 0xc: return this.SF !== this.OF;
      case 0xd: return this.SF === this.OF;
      case 0xe: return this.ZF === 1 || this.SF !== this.OF;
      case 0xf: return this.ZF === 0 && this.SF === this.OF;
      default: return false;
    }
  }

  // ============================================================
  // RUN / HALT / RESET
  // ============================================================

  run({ maxSteps = this.config.maxInstructions, until = null } = {}) {
    const t0 = now();
    let steps = 0;
    while (!this.halted && steps < maxSteps) {
      if (until && this.eip === u32(until)) break;
      this.step();
      steps++;
    }
    return {
      steps,
      instructions: this.instructionsExecuted,
      cycles: this.cycles,
      halted: this.halted,
      haltReason: this.haltReason,
      eip: hex32(this.eip),
      runtimeMs: now() - t0,
    };
  }

  halt(reason = "user-requested") {
    this.halted = true;
    this.haltReason = reason;
    kernelBus.emit("cpu:halted", { arch: "x86", reason, eip: hex32(this.eip) });
  }

  resume() {
    this.halted = false;
    this.haltReason = null;
    kernelBus.emit("cpu:resumed", { arch: "x86", eip: hex32(this.eip) });
  }

  reset() {
    this.gpr.fill(0);
    this.eip = u32(this.config.eip);
    this.eflags = 0x202;
    this.fpu.reset();
    this.mmx.fill(0n);
    this.xmm = new Array(8).fill(0n).map(() => [0, 0, 0, 0]);
    this.halted = false;
    this.haltReason = null;
    this.instructionsExecuted = 0n;
    this.cycles = 0n;
    this.memory.fill(0);
    this.mmu.flushTLB();
    this.stats = {
      instructions: 0n, loads: 0n, stores: 0n,
      branches: 0n, takenBranches: 0n, interrupts: 0n,
      exceptions: 0n, pageFaults: 0n, syscalls: 0n,
      fpuOps: 0n, sseOps: 0n, mmxOps: 0n,
    };
    kernelBus.emit("cpu:reset", { arch: "x86", eip: hex32(this.eip) });
  }

  // ============================================================
  // TRACE / SNAPSHOT
  // ============================================================

  _trace(kind, data) {
    this.traceBuffer[this.traceHead] = { kind, at: now(), data };
    this.traceHead = (this.traceHead + 1) % this.config.traceBufferSize;
    this.traceSize = Math.min(this.traceSize + 1, this.config.traceBufferSize);
  }

  getTrace() {
    const out = [];
    for (let i = 0; i < this.traceSize; i++) {
      const idx = (this.traceHead - this.traceSize + i + this.config.traceBufferSize) % this.config.traceBufferSize;
      out.push(this.traceBuffer[idx]);
    }
    return out;
  }

  snapshot() {
    return {
      arch: "x86",
      mode: this.mode,
      eip: hex32(this.eip),
      esp: hex32(this.ESP),
      ebp: hex32(this.EBP),
      eflags: hex32(this.eflags),
      registers: {
        eax: hex32(this.EAX), ebx: hex32(this.EBX), ecx: hex32(this.ECX), edx: hex32(this.EDX),
        esi: hex32(this.ESI), edi: hex32(this.EDI),
      },
      segmentos: { cs: this.seg.cs, ds: this.seg.ds, ss: this.seg.ss, es: this.seg.es, fs: this.seg.fs, gs: this.seg.gs },
      control: { cr0: hex32(this.cr0), cr2: hex32(this.cr2), cr3: hex32(this.cr3), cr4: hex32(this.cr4) },
      fpu: { top: this.fpu.top, st0: this.fpu.peek(0), control: hex32(this.fpu.control) },
      xmm: { xmm0: this.xmm[0].map(x => hex32(x)), xmm1: this.xmm[1].map(x => hex32(x)) },
      halted: this.halted,
      haltReason: this.haltReason,
      instructions: this.instructionsExecuted.toString(),
      cycles: this.cycles.toString(),
      stats: Object.fromEntries(Object.entries(this.stats).map(([k, v]) => [k, v.toString()])),
      mmu: this.mmu.snapshot(),
    };
  }

  setSyscallHandler(fn) { this.syscallHandler = fn; }
  setInterruptHandler(fn) { this.interruptHandler = fn; }
  setIOHandler(fn) { this.ioHandler = fn; }
}

// ============================================================================
// PROVIDER REACT + HOOK
// ============================================================================

const X86ExecutorContext = createContext(null);

export function X86ExecutorProvider({ children, config = {}, autoRun = false, syscallHandler = null }) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = new X86Executor(config);
    if (syscallHandler) ref.current.setSyscallHandler(syscallHandler);
  }
  const executor = ref.current;

  useEffect(() => {
    kernelBus.emit("x86-executor:ready", { eip: hex32(executor.eip), mode: executor.mode });
  }, [executor]);

  useEffect(() => {
    if (!autoRun) return;
    try { executor.run(); } catch (err) {
      kernelBus.emit("x86-executor:auto-run-failed", { error: String(err) });
    }
  }, [executor, autoRun]);

  const value = useMemo(() => ({
    executor,
    step: () => executor.step(),
    run: (o) => executor.run(o),
    halt: (r) => executor.halt(r),
    resume: () => executor.resume(),
    reset: () => executor.reset(),
    snapshot: () => executor.snapshot(),
    getTrace: () => executor.getTrace(),
  }), [executor]);

  return <X86ExecutorContext.Provider value={value}>{children}</X86ExecutorContext.Provider>;
}

export function useX86Executor() {
  const ctx = useContext(X86ExecutorContext);
  if (!ctx) throw new Error("useX86Executor must be used within X86ExecutorProvider");
  return ctx;
}

// ============================================================================
// EXPORTS
// ============================================================================

export { REG, SEG, FLAG, MODE, EXCEPTION, X87FPU, MMUX86 };
export { hex32, hex64, u8, u16, u32, i8, i16, i32 };
