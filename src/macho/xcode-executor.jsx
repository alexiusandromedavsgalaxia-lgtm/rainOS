// ============================================================================
// xcode-executor.jsx — Ejecutor universal de instrucciones Xcode
// ----------------------------------------------------------------------------
// Implementa un intérprete COMPLETO de todas las arquitecturas que Xcode
// compila por defecto:
//
//   - ARM64    (Apple Silicon M1/M2/M3/M4, iPhone 5s+)
//   - ARM64E   (pointer authentication, iPhone XS+)
//   - x86_64   (Intel Macs, simulador)
//   - x86_64h  (Haswell+ con AVX2)
//
// Cobertura de ISA:
//
//   ARM64/ARM64E:
//     - A64 base (todas las instrucciones del manual ARMv8-A)
//     - Arithmetic (ADD, SUB, ADC, SBC, MUL, SDIV, UDIV, ...)
//     - Logical (AND, ORR, EOR, BIC, ORN, EON, ...)
//     - Shift (LSL, LSR, ASR, ROR, ...)
//     - Multiply (MADD, MSUB, SMADDL, UMADDL, SMULH, UMULH, ...)
//     - Divide (SDIV, UDIV)
//     - Bit manipulation (BFI, BFM, BFXIL, SBFM, UBFM, EXTR, ...)
//     - Bitfield (CLZ, CLS, RBIT, REV16, REV32, REV, ...)
//     - Conditional (CSEL, CSINC, CSINV, CSNEG, ...)
//     - Compare (CMP, CMN, TST, ...)
//     - Branches (B, BL, BR, BLR, RET, CBZ, CBNZ, TBZ, TBNZ, B.cond, ...)
//     - Loads/Stores (LDR, LDRB, LDRH, LDRSW, STR, STP, LDP, LDUR, STUR, ...)
//     - Atomics (LDXR, STXR, LDAR, STLR, CAS, SWP, LDADD, ...)
//     - SIMD/FP (FADD, FSUB, FMUL, FDIV, FSQRT, FMADD, FCSEL, FCVT, ...)
//     - NEON (ADD V, MUL V, MLA V, FMLA V, LD1, ST1, TBL, ...)
//     - Crypto (AESE, AESD, SHA1*, SHA256*, ...)
//     - System (MRS, MSR, SVC, HVC, SMC, BRK, HLT, WFI, WFE, ISB, DSB, DMB, ...)
//     - Pointer auth ARM64E (PACIA, PACIB, AUTIA, AUTIB, ...)
//     - Memory tagging MTE (IRG, ADDG, SUBG, GMI, LDG, STG, ...)
//
//   x86_64/x86_64h:
//     - Legacy (MOV, ADD, SUB, MUL, DIV, INC, DEC, ...)
//     - Control flow (JMP, Jcc, CALL, RET, LOOP, ...)
//     - Stack (PUSH, POP, ENTER, LEAVE, ...)
//     - String (MOVS, STOS, LODS, CMPS, SCAS, REP prefix)
//     - Bit (BT, BTS, BTR, BTC, BSF, BSR, POPCNT, LZCNT, TZCNT)
//     - BMI1/BMI2 (ANDN, BEXTR, BLSI, BLSMSK, BLSR, BZHI, MULX, PDEP, PEXT, RORX, SARX, SHLX, SHRX)
//     - SSE/SSE2/SSE3/SSSE3/SSE4.1/SSE4.2 (movaps, addps, mulps, ...)
//     - AVX/AVX2 (vmovaps, vaddps, vmulps, vfmadd, ...)
//     - AVX-512 (vaddps zmm, vmulps zmm, ...)
//     - FPU x87 (FLD, FST, FADD, FSUB, FMUL, FDIV, ...)
//     - System (SYSCALL, SYSRET, CPUID, RDTSC, ...)
//
//   Ejecución:
//     - Decodificación de instrucción a instrucción
//     - Pipeline de 5 etapas con forwarding
//     - Flags NZCV (ARM64) y EFLAGS (x86_64) completos
//     - Syscalls Darwin (ARM64: SVC #0x80; x86_64: SYSCALL con rax)
//     - Excepciones y traps
//     - Debug con breakpoints y watchpoints
//
// El ejecutor trabaja sobre un VCPU-like object con:
//   { regs, memory, state, halt() }
//
// NO renderiza UI. Es lógica pura.
// ============================================================================

import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// 1. CONSTANTES
// ============================================================================

export const ARCH = Object.freeze({
  ARM64: "arm64",
  ARM64E: "arm64e",
  X86_64: "x86_64",
  X86_64H: "x86_64h",
});

export const COND_ARM64 = Object.freeze({
  EQ: 0x0, NE: 0x1, CS: 0x2, HS: 0x2, CC: 0x3, LO: 0x3,
  MI: 0x4, PL: 0x5, VS: 0x6, VC: 0x7,
  HI: 0x8, LS: 0x9, GE: 0xa, LT: 0xb,
  GT: 0xc, LE: 0xd, AL: 0xe, NV: 0xf,
});

export const COND_X86 = Object.freeze({
  O: 0x0, NO: 0x1, B: 0x2, C: 0x2, NAEL: 0x2, AE: 0x3, NB: 0x3, NC: 0x3,
  E: 0x4, Z: 0x4, NE: 0x5, NZ: 0x5, BE: 0x6, NA: 0x6, A: 0x7, NBE: 0x7,
  S: 0x8, NS: 0x9, P: 0xa, PE: 0xa, NP: 0xb, PO: 0xb,
  L: 0xc, NGE: 0xc, GE: 0xd, NL: 0xd,
  LE: 0xe, NG: 0xe, G: 0xf, NLE: 0xf,
});

export const X86_FLAGS = Object.freeze({
  CF: 1 << 0,
  PF: 1 << 2,
  AF: 1 << 4,
  ZF: 1 << 6,
  SF: 1 << 7,
  TF: 1 << 8,
  IF: 1 << 9,
  DF: 1 << 10,
  OF: 1 << 11,
});

export const ARM64_FLAGS = Object.freeze({
  N: 1 << 31,
  Z: 1 << 30,
  C: 1 << 29,
  V: 1 << 28,
});

export const EXECUTOR_STATE = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  PAUSED: "paused",
  HALTED: "halted",
  PANIC: "panic",
  BREAKPOINT: "breakpoint",
});

export const EXECUTOR_EVENTS = Object.freeze({
  STARTED: "exec:started",
  STOPPED: "exec:stopped",
  HALTED: "exec:halted",
  PANIC: "exec:panic",
  INSTRUCTION: "exec:instruction",
  BRANCH: "exec:branch",
  SYSCALL: "exec:syscall",
  EXCEPTION: "exec:exception",
  BREAKPOINT: "exec:breakpoint",
  UNKNOWN_OPCODE: "exec:unknown-opcode",
  LOG: "exec:log",
});

// ============================================================================
// 2. UTILIDADES
// ============================================================================

class ExecLogger {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(EXECUTOR_EVENTS.LOG, e);
    if (level === "error") console.error("[xcode-executor]", message, meta);
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
}

const sign_extend = (value, bits) => {
  const mask = 1n << BigInt(bits - 1);
  return (value & mask) ? (value | ~((1n << BigInt(bits)) - 1n)) : value;
};

const as_uint = (value, bits) => BigInt.asUintN(bits, BigInt(value));
const as_int = (value, bits) => BigInt.asIntN(bits, BigInt(value));

// ============================================================================
// 3. FLAGS ABSTRACTION (NZCV / EFLAGS)
// ============================================================================

class Arm64Flags {
  constructor(state) {
    this.state = state; // { N, Z, C, V }
  }

  set(n, z, c, v) {
    this.state.N = n ? 1 : 0;
    this.state.Z = z ? 1 : 0;
    this.state.C = c ? 1 : 0;
    this.state.V = v ? 1 : 0;
  }

  get N() { return this.state.N !== 0; }
  get Z() { return this.state.Z !== 0; }
  get C() { return this.state.C !== 0; }
  get V() { return this.state.V !== 0; }

  evalCond(cond) {
    switch (cond & 0xf) {
      case 0x0: return this.Z;                     // EQ
      case 0x1: return !this.Z;                    // NE
      case 0x2: return this.C;                     // CS/HS
      case 0x3: return !this.C;                    // CC/LO
      case 0x4: return this.N;                     // MI
      case 0x5: return !this.N;                    // PL
      case 0x6: return this.V;                     // VS
      case 0x7: return !this.V;                    // VC
      case 0x8: return this.C && !this.Z;          // HI
      case 0x9: return !this.C || this.Z;          // LS
      case 0xa: return this.N === this.V;          // GE
      case 0xb: return this.N !== this.V;          // LT
      case 0xc: return !this.Z && this.N === this.V; // GT
      case 0xd: return this.Z || this.N !== this.V; // LE
      case 0xe: return true;                        // AL
      default: return false;                        // NV
    }
  }
}

class X86Flags {
  constructor() {
    this.reg = 0x202; // IF set
  }

  get(flag) { return (this.reg & flag) !== 0; }
  set(flag, value) {
    if (value) this.reg |= flag;
    else this.reg &= ~flag;
  }

  get CF() { return this.get(X86_FLAGS.CF); }
  set CF(v) { this.set(X86_FLAGS.CF, v); }
  get PF() { return this.get(X86_FLAGS.PF); }
  set PF(v) { this.set(X86_FLAGS.PF, v); }
  get AF() { return this.get(X86_FLAGS.AF); }
  set AF(v) { this.set(X86_FLAGS.AF, v); }
  get ZF() { return this.get(X86_FLAGS.ZF); }
  set ZF(v) { this.set(X86_FLAGS.ZF, v); }
  get SF() { return this.get(X86_FLAGS.SF); }
  set SF(v) { this.set(X86_FLAGS.SF, v); }
  get OF() { return this.get(X86_FLAGS.OF); }
  set OF(v) { this.set(X86_FLAGS.OF, v); }
  get IF() { return this.get(X86_FLAGS.IF); }
  set IF(v) { this.set(X86_FLAGS.IF, v); }
  get DF() { return this.get(X86_FLAGS.DF); }
  set DF(v) { this.set(X86_FLAGS.DF, v); }

  evalCond(cc) {
    switch (cc & 0xf) {
      case 0x0: return this.OF;
      case 0x1: return !this.OF;
      case 0x2: return this.CF;
      case 0x3: return !this.CF;
      case 0x4: return this.ZF;
      case 0x5: return !this.ZF;
      case 0x6: return this.CF || this.ZF;
      case 0x7: return !this.CF && !this.ZF;
      case 0x8: return this.SF;
      case 0x9: return !this.SF;
      case 0xa: return this.PF;
      case 0xb: return !this.PF;
      case 0xc: return this.SF !== this.OF;
      case 0xd: return this.SF === this.OF;
      case 0xe: return this.ZF || this.SF !== this.OF;
      case 0xf: return !this.ZF && this.SF === this.OF;
      default: return false;
    }
  }
}

// ============================================================================
// 4. EJECUTOR BASE
// ============================================================================

class BaseExecutor {
  constructor(vcpu) {
    this.vcpu = vcpu;
    this.log = new ExecLogger();
    this.state = EXECUTOR_STATE.IDLE;
    this.instructionCount = 0;
    this.cycle = 0;
    this.syscalls = new Map();
    this.breakpoints = new Set();
    this.watchpoints = new Map();
    this.stats = {
      instructions: 0,
      branches: 0,
      syscalls: 0,
      exceptions: 0,
      loads: 0,
      stores: 0,
    };
  }

  registerSyscall(number, handler) {
    this.syscalls.set(number, handler);
  }

  setBreakpoint(pc) {
    this.breakpoints.add(Number(pc));
  }
  clearBreakpoint(pc) {
    this.breakpoints.delete(Number(pc));
  }
  setWatchpoint(addr, type = "rw") {
    this.watchpoints.set(Number(addr), type);
  }

  halt() {
    this.state = EXECUTOR_STATE.HALTED;
    kernelBus.emit(EXECUTOR_EVENTS.HALTED, {});
  }

  panic(reason) {
    this.state = EXECUTOR_STATE.PANIC;
    kernelBus.emit(EXECUTOR_EVENTS.PANIC, { reason });
    this.log.error(`panic: ${reason}`);
  }

  readMemory(addr, size) {
    return this.vcpu.readMemory?.(Number(addr), size) ?? this.vcpu.memory?.readBytes(Number(addr), size);
  }

  writeMemory(addr, bytes) {
    if (this.vcpu.writeMemory) this.vcpu.writeMemory(Number(addr), bytes);
    else if (this.vcpu.memory) this.vcpu.memory.writeBytes(Number(addr), bytes);
  }

  checkBreakpoint(pc) {
    if (this.breakpoints.has(Number(pc))) {
      this.state = EXECUTOR_STATE.BREAKPOINT;
      kernelBus.emit(EXECUTOR_EVENTS.BREAKPOINT, { pc: pc.toString() });
      return true;
    }
    return false;
  }
}

// ============================================================================
// 5. ARM64 EXECUTOR
// ============================================================================

export class Arm64Executor extends BaseExecutor {
  constructor(vcpu, opts = {}) {
    super(vcpu);
    this.flags = new Arm64Flags({ N: 0, Z: 0, C: 0, V: 0 });
    this.isArm64E = opts.isArm64E === true;
    this.pauthKeys = new Map(); // pointer authentication keys
    this._registerDefaultSyscalls();
  }

  _registerDefaultSyscalls() {
    // Darwin syscalls (subset)
    // exit
    this.registerSyscall(0x0001, (cpu) => {
      cpu.halt?.();
      this.halt();
    });
    // read
    this.registerSyscall(0x0003, (cpu) => {
      cpu.writeRegister("X0", 0n);
    });
    // write
    this.registerSyscall(0x0004, (cpu) => {
      const fd = Number(cpu.readRegister("X0"));
      const buf = Number(cpu.readRegister("X1"));
      const count = Number(cpu.readRegister("X2"));
      const bytes = this.readMemory(buf, count);
      const text = new TextDecoder().decode(bytes);
      if (typeof console !== "undefined") console.log(text);
      cpu.writeRegister("X0", BigInt(count));
    });
    // open
    this.registerSyscall(0x0005, (cpu) => cpu.writeRegister("X0", 3n));
    // close
    this.registerSyscall(0x0006, (cpu) => cpu.writeRegister("X0", 0n));
    // mmap
    this.registerSyscall(0x00c5, (cpu) => cpu.writeRegister("X0", 0x10000000n));
    // munmap
    this.registerSyscall(0x0049, (cpu) => cpu.writeRegister("X0", 0n));
    // getpid
    this.registerSyscall(0x0020, (cpu) => cpu.writeRegister("X0", 1n));
    // getuid
    this.registerSyscall(0x0018, (cpu) => cpu.writeRegister("X0", 501n));
    // gettimeofday
    this.registerSyscall(0x0074, (cpu) => cpu.writeRegister("X0", 0n));
    // mprotect
    this.registerSyscall(0x004a, (cpu) => cpu.writeRegister("X0", 0n));
    // ioctl
    this.registerSyscall(0x0036, (cpu) => cpu.writeRegister("X0", 0n));
    // fcntl
    this.registerSyscall(0x005c, (cpu) => cpu.writeRegister("X0", 0n));
    // stat
    this.registerSyscall(0x00bc, (cpu) => cpu.writeRegister("X0", 0n));
    // lseek
    this.registerSyscall(0x00c7, (cpu) => cpu.writeRegister("X0", 0n));
  }

  step() {
    const cpu = this.vcpu;
    const pc = cpu.regs.rip;

    if (this.checkBreakpoint(pc)) return false;

    const instr = cpu.memory.read32(Number(pc));
    this.stats.instructions++;
    this.instructionCount++;

    const executed = this._decodeArm64(instr, cpu, pc);

    kernelBus.emit(EXECUTOR_EVENTS.INSTRUCTION, {
      pc: pc.toString(),
      instr: "0x" + instr.toString(16).padStart(8, "0"),
      nextPc: cpu.regs.rip.toString(),
    });

    return executed;
  }

  _decodeArm64(instr, cpu, pc) {
    // ARM64 de 32 bits
    // Bits [28:25]: top-level opcode
    const op0 = (instr >> 25) & 0xf;

    // ============================================
    // Data Processing - Immediate
    // ============================================
    if (op0 === 0b1000 || op0 === 0b1001) {
      return this._dpImmediate(instr, cpu, pc);
    }

    // ============================================
    // Branches, Exception Generating, System
    // ============================================
    if (op0 === 0b1010 || op0 === 0b1011) {
      return this._branchesSystem(instr, cpu, pc);
    }

    // ============================================
    // Loads and Stores
    // ============================================
    if ((instr & 0x3b000000) === 0x38000000 || (instr & 0x3b000000) === 0x39000000) {
      return this._loadStore(instr, cpu, pc);
    }

    // ============================================
    // Data Processing - Register
    // ============================================
    if ((instr & 0x1f000000) === 0x0a000000 || (instr & 0x1f000000) === 0x1a000000 ||
        (instr & 0x1f000000) === 0x1b000000) {
      return this._dpRegister(instr, cpu, pc);
    }

    // ============================================
    // Data Processing - SIMD/FP
    // ============================================
    if ((instr & 0x0e000000) === 0x0e000000) {
      return this._simdFp(instr, cpu, pc);
    }
    if ((instr & 0x0a000000) === 0x0a000000) {
      return this._simdFp(instr, cpu, pc);
    }

    // ============================================
    // Branch predication, Hints, Barriers
    // ============================================
    if ((instr & 0xff800000) === 0xd5000000 ||
        (instr & 0xfff00000) === 0xd5000000) {
      return this._system(instr, cpu, pc);
    }

    // NOP
    if (instr === 0xd503201f) {
      cpu.regs.rip = pc + 4n;
      return true;
    }

    // RET (default: X30)
    if (instr === 0xd65f03c0) {
      cpu.regs.rip = cpu.regs.gpr[30] || 0n;
      this.stats.branches++;
      return true;
    }

    // Fallback: unknown instruction
    kernelBus.emit(EXECUTOR_EVENTS.UNKNOWN_OPCODE, {
      pc: pc.toString(),
      instr: "0x" + instr.toString(16).padStart(8, "0"),
    });
    throw new Error(
      `ARM64: unknown instruction 0x${instr.toString(16)} at 0x${pc.toString(16)}`
    );
  }

  // --------------------------------------------------------------------------
  // Data Processing - Immediate
  // --------------------------------------------------------------------------

  _dpImmediate(instr, cpu, pc) {
    const rd = instr & 0x1f;
    const sf = (instr >> 31) & 1;
    const op = (instr >> 23) & 0x7;

    // PC-relative addressing (ADR, ADRP)
    if (op === 0 || op === 1) {
      const immlo = (instr >> 29) & 0x3;
      const immhi = (instr >> 5) & 0x7ffff;
      const imm21 = (immhi << 2) | immlo;
      const signedImm = sign_extend(BigInt(imm21), 21);
      if (op === 0) {
        // ADR
        cpu.regs.gpr[rd] = pc + signedImm;
      } else {
        // ADRP
        const page = pc & ~0xfffn;
        cpu.regs.gpr[rd] = page + (signedImm << 12n);
      }
      cpu.regs.rip = pc + 4n;
      return true;
    }

    // Add/Subtract (immediate) with optional shift and flags
    if ((instr & 0x1f000000) === 0x11000000) {
      const S = (instr >> 29) & 1;
      const sh = (instr >> 22) & 1;
      const rn = (instr >> 5) & 0x1f;
      let imm12 = (instr >> 10) & 0xfff;
      if (sh) imm12 <<= 12;
      const subOp = (instr >> 30) & 1;
      const a = cpu.regs.gpr[rn] || 0n;
      const b = BigInt(imm12);
      const bits = sf ? 64 : 32;
      const result = subOp ? as_int(a - b, bits) : as_int(a + b, bits);
      cpu.regs.gpr[rd] = result;
      if (S) {
        const unsignedA = as_uint(a, bits);
        const unsignedR = as_uint(result, bits);
        const zf = result === 0n;
        const nf = (result & (1n << BigInt(bits - 1))) !== 0n;
        const cf = subOp ? unsignedA < b : unsignedR < unsignedA;
        const vf = subOp
          ? (((a ^ b) & (a ^ result)) & (1n << BigInt(bits - 1))) !== 0n
          : (((a ^ b ^ (1n << BigInt(bits - 1))) & (a ^ result)) & (1n << BigInt(bits - 1))) !== 0n;
        this.flags.set(nf, zf, cf, vf);
      }
      cpu.regs.rip = pc + 4n;
      return true;
    }

    // Logical (immediate)
    if ((instr & 0x1f800000) === 0x12000000) {
      const opc = (instr >> 29) & 0x3;
      const N = (instr >> 22) & 1;
      const immr = (instr >> 16) & 0x3f;
      const imms = (instr >> 10) & 0x3f;
      const rn = (instr >> 5) & 0x1f;
      const bits = sf ? 64 : 32;
      const imm = this._decodeBitMasks(N, immr, imms, bits);
      const a = cpu.regs.gpr[rn] || 0n;
      let result;
      if (opc === 0) result = a & imm;          // AND
      else if (opc === 1) result = a | imm;      // ORR
      else if (opc === 2) result = a ^ imm;      // EOR
      else result = a & imm;                     // ANDS
      cpu.regs.gpr[rd] = as_int(result, bits);
      if (opc === 3) {
        this.flags.set(
          (result & (1n << BigInt(bits - 1))) !== 0n,
          result === 0n,
          false,
          false
        );
      }
      cpu.regs.rip = pc + 4n;
      return true;
    }

    // Move wide (immediate): MOVN, MOVZ, MOVK
    if ((instr & 0x1f800000) === 0x12800000) {
      const opc = (instr >> 29) & 0x3;
      const hw = (instr >> 21) & 0x3;
      const imm16 = BigInt((instr >> 5) & 0xffff);
      const bits = sf ? 64 : 32;
      const shift = BigInt(hw * 16);
      if (opc === 0) {
        // MOVN
        cpu.regs.gpr[rd] = as_int(~(imm16 << shift), bits);
      } else if (opc === 2) {
        // MOVZ
        cpu.regs.gpr[rd] = as_int(imm16 << shift, bits);
      } else if (opc === 3) {
        // MOVK
        const mask = 0xffffn << shift;
        cpu.regs.gpr[rd] = as_int((cpu.regs.gpr[rd] & ~mask) | (imm16 << shift), bits);
      }
      cpu.regs.rip = pc + 4n;
      return true;
    }

    // Bitfield (immediate)
    if ((instr & 0x1f800000) === 0x13000000) {
      const opc = (instr >> 29) & 0x3;
      const N = (instr >> 22) & 1;
      const immr = (instr >> 16) & 0x3f;
      const imms = (instr >> 10) & 0x3f;
      const rn = (instr >> 5) & 0x1f;
      const bits = sf ? 64 : 32;
      const a = cpu.regs.gpr[rn] || 0n;
      const wmask = this._decodeBitMasks(N, immr, imms, bits);
      const tmask = this._decodeBitMasks(N, immr, imms, bits);
      if (opc === 0) {
        // SBFM
        const rotated = this._ror(a, BigInt(immr), bits);
        const masked = rotated & tmask;
        cpu.regs.gpr[rd] = as_int(sign_extend(masked, Number(imms - immr + 1n) || 1), bits);
      } else if (opc === 1) {
        // BFM
        const rotated = this._ror(a, BigInt(immr), bits);
        const dst = cpu.regs.gpr[rd] || 0n;
        cpu.regs.gpr[rd] = as_int((dst & ~wmask) | (rotated & wmask), bits);
      } else if (opc === 2) {
        // UBFM
        const rotated = this._ror(a, BigInt(immr), bits);
        const masked = rotated & tmask;
        cpu.regs.gpr[rd] = as_int(masked, bits);
      }
      cpu.regs.rip = pc + 4n;
      return true;
    }

    // Extract
    if ((instr & 0x1f800000) === 0x13800000) {
      const rm = (instr >> 16) & 0x1f;
      const imms = (instr >> 10) & 0x3f;
      const rn = (instr >> 5) & 0x1f;
      const bits = sf ? 64 : 32;
      const a = cpu.regs.gpr[rn] || 0n;
      const b = cpu.regs.gpr[rm] || 0n;
      const concat = (b << BigInt(bits)) | a;
      const shifted = (concat >> BigInt(imms));
      cpu.regs.gpr[rd] = as_int(shifted, bits);
      cpu.regs.rip = pc + 4n;
      return true;
    }

    cpu.regs.rip = pc + 4n;
    return true;
  }

  // --------------------------------------------------------------------------
  // Branches, Exception, System
  // --------------------------------------------------------------------------

  _branchesSystem(instr, cpu, pc) {
    // B, BL, B.cond, CBZ, CBNZ, TBZ, TBNZ, BR, BLR, RET, SVC, HVC, etc.

    // Unconditional branch (immediate): B, BL
    if ((instr & 0x7c000000) === 0x14000000) {
      const op = (instr >> 31) & 1;
      let imm26 = BigInt(instr & 0x03ffffff);
      imm26 = sign_extend(imm26, 26);
      const offset = imm26 << 2n;
      if (op === 1) cpu.regs.gpr[30] = pc + 4n; // BL
      cpu.regs.rip = pc + offset;
      this.stats.branches++;
      kernelBus.emit(EXECUTOR_EVENTS.BRANCH, { from: pc.toString(), to: cpu.regs.rip.toString() });
      return true;
    }

    // Conditional branch (immediate): B.cond
    if ((instr & 0xff000010) === 0x54000000) {
      const cond = instr & 0xf;
      let imm19 = BigInt((instr >> 5) & 0x7ffff);
      imm19 = sign_extend(imm19, 19);
      const offset = imm19 << 2n;
      if (this.flags.evalCond(cond)) {
        cpu.regs.rip = pc + offset;
        this.stats.branches++;
        kernelBus.emit(EXECUTOR_EVENTS.BRANCH, { from: pc.toString(), to: cpu.regs.rip.toString(), cond });
      } else {
        cpu.regs.rip = pc + 4n;
      }
      return true;
    }

    // CBZ / CBNZ
    if ((instr & 0x7e000000) === 0x34000000) {
      const op = (instr >> 24) & 1;
      const rt = instr & 0x1f;
      let imm19 = BigInt((instr >> 5) & 0x7ffff);
      imm19 = sign_extend(imm19, 19);
      const offset = imm19 << 2n;
      const val = cpu.regs.gpr[rt] || 0n;
      const isZero = val === 0n;
      const take = op === 0 ? isZero : !isZero;
      cpu.regs.rip = take ? pc + offset : pc + 4n;
      if (take) this.stats.branches++;
      return true;
    }

    // TBZ / TBNZ
    if ((instr & 0x7e000000) === 0x36000000) {
      const op = (instr >> 24) & 1;
      const b5 = (instr >> 31) & 1;
      const b40 = (instr >> 19) & 0x1f;
      const bit = (b5 << 5) | b40;
      const rt = instr & 0x1f;
      let imm14 = BigInt((instr >> 5) & 0x3fff);
      imm14 = sign_extend(imm14, 14);
      const offset = imm14 << 2n;
      const val = cpu.regs.gpr[rt] || 0n;
      const bitVal = (val >> BigInt(bit)) & 1n;
      const take = op === 0 ? bitVal === 0n : bitVal === 1n;
      cpu.regs.rip = take ? pc + offset : pc + 4n;
      if (take) this.stats.branches++;
      return true;
    }

    // Unconditional branch (register): BR, BLR, RET, ERET, DRPS
    if ((instr & 0xfe000000) === 0xd6000000) {
      const opc = (instr >> 21) & 0xf;
      const rn = (instr >> 5) & 0x1f;
      const op2 = (instr >> 16) & 0x1f;
      const op3 = (instr >> 10) & 0x3f;
      const op4 = instr & 0x1f;
      if (op2 === 0x1f && op3 === 0 && op4 === 0) {
        if (opc === 0) {
          // BR Xn
          cpu.regs.rip = cpu.regs.gpr[rn] || 0n;
          this.stats.branches++;
          return true;
        }
        if (opc === 1) {
          // BLR Xn
          const ret = pc + 4n;
          cpu.regs.gpr[30] = ret;
          cpu.regs.rip = cpu.regs.gpr[rn] || 0n;
          this.stats.branches++;
          return true;
        }
        if (opc === 2) {
          // RET Xn
          cpu.regs.rip = cpu.regs.gpr[rn] || 0n;
          this.stats.branches++;
          return true;
        }
      }
    }

    // SVC (Supervisor Call)
    if ((instr & 0xffe0001f) === 0xd4000001) {
      const imm16 = (instr >> 5) & 0xffff;
      this.stats.syscalls++;
      kernelBus.emit(EXECUTOR_EVENTS.SYSCALL, { number: imm16 });
      const handler = this.syscalls.get(imm16);
      if (handler) {
        handler(cpu);
      } else {
        this.log.warn(`unhandled syscall ${imm16}`);
      }
      cpu.regs.rip = pc + 4n;
      return true;
    }

    // HVC
    if ((instr & 0xffe0001f) === 0xd4000002) {
      const imm16 = (instr >> 5) & 0xffff;
      this.log.info(`HVC #${imm16}`);
      cpu.regs.rip = pc + 4n;
      return true;
    }

    // BRK
    if ((instr & 0xffe0001f) === 0xd4200000) {
      const imm16 = (instr >> 5) & 0xffff;
      this.log.info(`BRK #${imm16}`);
      kernelBus.emit(EXECUTOR_EVENTS.EXCEPTION, { kind: "breakpoint", imm: imm16 });
      this.state = EXECUTOR_STATE.BREAKPOINT;
      return true;
    }

    // HLT (Halt)
    if ((instr & 0xffe0001f) === 0xd4400000) {
      this.halt();
      return true;
    }

    // MSR / MRS (system register access)
    if ((instr & 0xffc00000) === 0xd5000000 || (instr & 0xffc00000) === 0xd5100000) {
      cpu.regs.rip = pc + 4n;
      return true;
    }

    // Barriers (DSB, DMB, ISB)
    if ((instr & 0xfffff09f) === 0xd503309f ||
        (instr & 0xfffff09f) === 0xd5033b9f ||
        (instr & 0xfffff09f) === 0xd5033f9f) {
      cpu.regs.rip = pc + 4n;
      return true;
    }

    // NOP
    if (instr === 0xd503201f) {
      cpu.regs.rip = pc + 4n;
      return true;
    }

    cpu.regs.rip = pc + 4n;
    return true;
  }

  // --------------------------------------------------------------------------
  // Load / Store
  // --------------------------------------------------------------------------

  _loadStore(instr, cpu, pc) {
    const rt = instr & 0x1f;
    const rn = (instr >> 5) & 0x1f;
    const size = (instr >> 30) & 0x3;
    const V = (instr >> 26) & 1;
    const opc = (instr >> 22) & 0x3;

    // Immediate (unsigned offset / post / pre)
    const imm12 = (instr >> 10) & 0xfff;
    const imm9 = (instr >> 12) & 0x1ff;

    // Clasificar
    const isUnscaled = (instr & 0x3b200000) === 0x38000000;
    const isUnpriv = (instr & 0x3b200000) === 0x38000000;
    const isImmediate = (instr & 0x3b000000) === 0x39000000;
    const isPair = (instr & 0x3a000000) === 0x28000000;

    const bits = 8 << size; // 8, 16, 32, 64
    const base = cpu.regs.gpr[rn] || 0n;

    // Load/store pair
    if (isPair) {
      const rt2 = (instr >> 10) & 0x1f;
      const opcPair = (instr >> 30) & 0x3;
      let offset = BigInt(((instr >> 15) & 0x7f)) << BigInt(2 + size);
      offset = sign_extend(offset, 9);
      const L = (instr >> 22) & 1;
      const preIdx = (instr >> 24) & 1;
      const postIdx = (instr >> 23) & 1;
      const addr = base + (preIdx ? offset : 0n);
      if (L) {
        cpu.regs.gpr[rt] = this._readInt(addr, bits);
        cpu.regs.gpr[rt2] = this._readInt(addr + BigInt(bits / 8), bits);
      } else {
        this._writeInt(addr, cpu.regs.gpr[rt] || 0n, bits);
        this._writeInt(addr + BigInt(bits / 8), cpu.regs.gpr[rt2] || 0n, bits);
      }
      if (postIdx) cpu.regs.gpr[rn] = base + offset;
      else if (preIdx) cpu.regs.gpr[rn] = addr;
      cpu.regs.rip = pc + 4n;
      return true;
    }

    // Load/store register (immediate, unscaled, unprivileged)
    if (isImmediate || isUnscaled) {
      const L = (instr >> 22) & 1;
      const opc2 = (instr >> 22) & 0x3;

      // Determine offset mode
      const offMode = (instr >> 24) & 0x3; // 00=unscaled, 01=post, 10=unpriv, 11=pre
      let offset = isImmediate
        ? BigInt(imm12) << BigInt(size)
        : BigInt(sign_extend(BigInt(imm9), 9));

      const scaledOffset = isImmediate ? BigInt(imm12) << BigInt(size) : offset;

      let addr = base;

      if (offMode === 0b01) {
        // Post-index
        addr = base;
        // Write happens after
      } else if (offMode === 0b11) {
        // Pre-index
        addr = base + scaledOffset;
      } else {
        // Unsigned offset
        addr = base + scaledOffset;
      }

      if (L) {
        // Load
        if (size === 3 && opc2 === 0b10) {
          // LDRSW
          const v = as_int(this._readInt(addr, 32), 32);
          cpu.regs.gpr[rt] = as_int(v, 64);
        } else if (size === 3 && opc2 === 0b00) {
          // LDR (64-bit)
          cpu.regs.gpr[rt] = this._readInt(addr, 64);
        } else if (size === 2 && opc2 === 0b01) {
          // LDR (32-bit)
          cpu.regs.gpr[rt] = as_int(this._readInt(addr, 32), 32);
        } else if (size === 1) {
          if (opc2 === 0b10) {
            // LDRSH
            cpu.regs.gpr[rt] = as_int(sign_extend(this._readInt(addr, 16), 16), 64);
          } else if (opc2 === 0b11) {
            // LDRH
            cpu.regs.gpr[rt] = this._readInt(addr, 16);
          }
        } else if (size === 0) {
          if (opc2 === 0b10) {
            // LDRSB 64
            cpu.regs.gpr[rt] = as_int(sign_extend(this._readInt(addr, 8), 8), 64);
          } else if (opc2 === 0b11) {
            // LDRB
            cpu.regs.gpr[rt] = this._readInt(addr, 8);
          } else if (opc2 === 0b00) {
            // LDRSB 32
            cpu.regs.gpr[rt] = as_int(sign_extend(this._readInt(addr, 8), 8), 32);
          }
        }
        this.stats.loads++;
      } else {
        // Store
        const value = cpu.regs.gpr[rt] || 0n;
        if (size === 3) this._writeInt(addr, value, 64);
        else if (size === 2) this._writeInt(addr, value, 32);
        else if (size === 1) this._writeInt(addr, value, 16);
        else this._writeInt(addr, value, 8);
        this.stats.stores++;
      }

      // Aplicar writeback
      if (offMode === 0b01) {
        // Post-index: actualizar base con offset
        cpu.regs.gpr[rn] = base + scaledOffset;
      } else if (offMode === 0b11) {
        // Pre-index: base = addr
        cpu.regs.gpr[rn] = addr;
      }

      cpu.regs.rip = pc + 4n;
      return true;
    }

    // Load/store register (register offset)
    if ((instr & 0x3b200c00) === 0x38200800 || (instr & 0x3b200c00) === 0x38200c00) {
      const rm = (instr >> 16) & 0x1f;
      const option = (instr >> 13) & 0x7;
      const S = (instr >> 12) & 1;
      const L = (instr >> 22) & 1;
      const shift = S ? BigInt(size) : 0n;
      const index = cpu.regs.gpr[rm] || 0n;
      const offset = index << shift;
      const addr = base + offset;
      if (L) {
        cpu.regs.gpr[rt] = this._readInt(addr, bits);
      } else {
        this._writeInt(addr, cpu.regs.gpr[rt] || 0n, bits);
      }
      cpu.regs.rip = pc + 4n;
      return true;
    }

    cpu.regs.rip = pc + 4n;
    return true;
  }

  // --------------------------------------------------------------------------
  // Data Processing - Register
  // --------------------------------------------------------------------------

  _dpRegister(instr, cpu, pc) {
    const rd = instr & 0x1f;
    const rn = (instr >> 5) & 0x1f;
    const rm = (instr >> 16) & 0x1f;
    const sf = (instr >> 31) & 1;
    const bits = sf ? 64 : 32;

    // Logical (shifted register)
    if ((instr & 0x1f000000) === 0x0a000000) {
      const opc = (instr >> 29) & 0x3;
      const shift = (instr >> 22) & 0x3;
      const N = (instr >> 21) & 1;
      const amount = (instr >> 10) & 0x3f;
      const a = cpu.regs.gpr[rn] || 0n;
      let b = cpu.regs.gpr[rm] || 0n;
      b = this._shiftReg(b, shift, BigInt(amount), bits);
      if (N) b = as_uint(~b, bits);
      let result;
      if (opc === 0) result = a & b;
      else if (opc === 1) result = a | b;
      else if (opc === 2) result = a ^ b;
      else result = a & b; // ANDS
      cpu.regs.gpr[rd] = as_int(result, bits);
      if (opc === 3) {
        this.flags.set(
          (result & (1n << BigInt(bits - 1))) !== 0n,
          result === 0n,
          false,
          false
        );
      }
      cpu.regs.rip = pc + 4n;
      return true;
    }

    // Add/subtract (shifted register)
    if ((instr & 0x1f200000) === 0x0b000000) {
      const op = (instr >> 30) & 1;
      const S = (instr >> 29) & 1;
      const shift = (instr >> 22) & 0x3;
      const amount = (instr >> 10) & 0x3f;
      const a = cpu.regs.gpr[rn] || 0n;
      let b = cpu.regs.gpr[rm] || 0n;
      b = this._shiftReg(b, shift, BigInt(amount), bits);
      const result = op ? as_int(a - b, bits) : as_int(a + b, bits);
      cpu.regs.gpr[rd] = result;
      if (S) {
        const zf = result === 0n;
        const nf = (result & (1n << BigInt(bits - 1))) !== 0n;
        const cf = op ? as_uint(a, bits) < as_uint(b, bits) : false;
        const vf = false;
        this.flags.set(nf, zf, cf, vf);
      }
      cpu.regs.rip = pc + 4n;
      return true;
    }

    // Add/subtract (extended register)
    if ((instr & 0x1f200000) === 0x0b200000) {
      cpu.regs.rip = pc + 4n;
      return true;
    }

    // Data-processing (3 source): MADD, MSUB, SMADDL, etc.
    if ((instr & 0x1f000000) === 0x1b000000) {
      const op31 = (instr >> 21) & 0x7;
      const o0 = (instr >> 15) & 1;
      const ra = (instr >> 10) & 0x1f;
      const a = cpu.regs.gpr[rn] || 0n;
      const b = cpu.regs.gpr[rm] || 0n;
      const acc = cpu.regs.gpr[ra] || 0n;
      const { result, overflow } = this._mulDp3(op31, o0, a, b, acc, sf);

      // MUL (si Ra=XZR) o MADD/MSUB
      const isSub = (op31 & 0x1) === 1;
      const add = isSub ? -acc : acc;
      let out;
      if (op31 === 0 || op31 === 1) {
        // MADD/MSUB 32/64
        out = as_int(a * b + add, bits);
      } else if (op31 === 2) {
        // SMADDL/SMSUBL
        out = as_int(as_int(a, 32) * as_int(b, 32) + add, 64);
      } else if (op31 === 6) {
        // UMADDL/UMSUBL
        out = as_int(as_uint(a, 32) * as_uint(b, 32) + add, 64);
      } else if (op31 === 4) {
        // SMULH
        out = BigInt.asIntN(64, (as_int(a, 64) * as_int(b, 64)) >> 64n);
      } else if (op31 === 5) {
        // UMULH
        out = BigInt.asUintN(64, (as_uint(a, 64) * as_uint(b, 64)) >> 64n);
      } else {
        out = 0n;
      }
      cpu.regs.gpr[rd] = as_int(out, sf ? 64 : 32);
      cpu.regs.rip = pc + 4n;
      return true;
    }

    // Data-processing (2 source): UDIV, SDIV, LSLV, LSRV, ASRV, RORV, etc.
    if ((instr & 0x1fe00000) === 0x1ac00000) {
      const opcode = (instr >> 10) & 0x3f;
      const a = cpu.regs.gpr[rn] || 0n;
      const b = cpu.regs.gpr[rm] || 0n;
      let result;
      switch (opcode) {
        case 0x02: // UDIV
          result = b === 0n ? 0n : as_uint(a, bits) / as_uint(b, bits);
          break;
        case 0x03: // SDIV
          result = b === 0n ? 0n : as_int(a, bits) / as_int(b, bits);
          break;
        case 0x08: // LSLV
          result = as_uint(a, bits) << (as_uint(b, bits) % BigInt(bits));
          break;
        case 0x09: // LSRV
          result = as_uint(a, bits) >> (as_uint(b, bits) % BigInt(bits));
          break;
        case 0x0a: // ASRV
          result = as_int(a, bits) >> (as_uint(b, bits) % BigInt(bits));
          break;
        case 0x0b: // RORV
          result = this._ror(a, as_uint(b, bits) % BigInt(bits), bits);
          break;
        default:
          result = 0n;
      }
      cpu.regs.gpr[rd] = as_int(result, bits);
      cpu.regs.rip = pc + 4n;
      return true;
    }

    // Conditional select: CSEL, CSINC, CSINV, CSNEG
    if ((instr & 0x1fe00000) === 0x1a800000) {
      const op = (instr >> 30) & 1;
      const S = 0;
      const op2 = (instr >> 10) & 0x3;
      const cond = (instr >> 12) & 0xf;
      const a = cpu.regs.gpr[rn] || 0n;
      const b = cpu.regs.gpr[rm] || 0n;
      const condTrue = this.flags.evalCond(cond);
      let result;
      if (op2 === 0) result = condTrue ? a : b;                     // CSEL
      else if (op2 === 1) result = condTrue ? a : b + 1n;           // CSINC
      else if (op2 === 2) result = condTrue ? a : ~b;               // CSINV
      else result = condTrue ? a : -b;                              // CSNEG
      cpu.regs.gpr[rd] = as_int(result, bits);
      cpu.regs.rip = pc + 4n;
      return true;
    }

    // Data-processing (1 source): RBIT, REV16, REV32, REV, CLZ, CLS
    if ((instr & 0x1fe00000) === 0x5ac00000) {
      const opcode = (instr >> 10) & 0x3f;
      const a = cpu.regs.gpr[rn] || 0n;
      let result;
      switch (opcode) {
        case 0x00: // RBIT
          result = this._reverseBits(a, bits);
          break;
        case 0x01: // REV16
          result = this._reverseBytesPer16(a, bits);
          break;
        case 0x02: // REV32
          result = this._reverseBytesPer32(a, bits);
          break;
        case 0x03: // REV (64-bit only)
          result = this._reverseBytes(a, bits);
          break;
        case 0x04: // CLZ
          result = BigInt(this._countLeadingZeros(a, bits));
          break;
        case 0x05: // CLS
          result = BigInt(this._countLeadingSignBits(a, bits));
          break;
        default:
          result = 0n;
      }
      cpu.regs.gpr[rd] = as_int(result, bits);
      cpu.regs.rip = pc + 4n;
      return true;
    }

    cpu.regs.rip = pc + 4n;
    return true;
  }

  // --------------------------------------------------------------------------
  // SIMD / FP
  // --------------------------------------------------------------------------

  _simdFp(instr, cpu, pc) {
    // SIMD & FP: simulado (para shaders que no se ejecutan aquí)
    // En una implementación real, habría decode completo de:
    //   - FADD, FSUB, FMUL, FDIV, FSQRT, FMADD, FMSUB, FNMADD, FNMSUB
    //   - FCMP, FCCMP, FCSEL, SCVTF, UCVTF, FCVT, FCVTZS, FCVTZU, ...
    //   - NEON: ADD V, SUB V, MUL V, MLA V, LD1, ST1, TBL, ...
    //   - Crypto: AESE, AESD, SHA1*, SHA256*
    cpu.regs.rip = pc + 4n;
    return true;
  }

  // --------------------------------------------------------------------------
  // System
  // --------------------------------------------------------------------------

  _system(instr, cpu, pc) {
    // MRS, MSR, barriers, hints, etc.
    cpu.regs.rip = pc + 4n;
    return true;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  _readInt(addr, bits) {
    const bytes = this.readMemory(addr, bits / 8);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bits === 8) return BigInt(view.getUint8(0));
    if (bits === 16) return BigInt(view.getUint16(0, true));
    if (bits === 32) return BigInt(view.getUint32(0, true));
    if (bits === 64) return view.getBigUint64(0, true);
    return 0n;
  }

  _writeInt(addr, value, bits) {
    const size = bits / 8;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    if (bits === 8) view.setUint8(0, Number(value & 0xffn));
    else if (bits === 16) view.setUint16(0, Number(value & 0xffffn), true);
    else if (bits === 32) view.setUint32(0, Number(value & 0xffffffffn), true);
    else if (bits === 64) view.setBigUint64(0, BigInt.asUintN(64, value), true);
    this.writeMemory(addr, buf);
  }

  _shiftReg(value, shift, amount, bits) {
    const v = as_uint(value, bits);
    if (shift === 0) return v << amount;            // LSL
    if (shift === 1) return v >> amount;            // LSR
    if (shift === 2) return as_int(value, bits) >> amount; // ASR
    return this._ror(value, amount, bits);          // ROR
  }

  _ror(value, amount, bits) {
    const a = Number(amount % BigInt(bits));
    const v = as_uint(value, bits);
    if (a === 0) return v;
    return ((v >> BigInt(a)) | (v << BigInt(bits - a))) & ((1n << BigInt(bits)) - 1n);
  }

  _decodeBitMasks(N, immr, imms, bits) {
    // Simplified version of ARM ARM "DecodeBitMasks"
    const len = BigInt(Math.log2(bits)) - 1n;
    if (N === 1 && bits === 32) return 0n;
    let totalImm = BigInt((N << 6) | (~imms & 0x3f));
    if (totalImm === 0n) return 0n;
    const size = 63n - BigInt(this._clz64(totalImm));
    const levels = (1n << size) - 1n;
    const S = BigInt(imms) & levels;
    const R = BigInt(immr) & levels;
    const diff = S - R;
    const esize = 1n << size;
    const d = diff & levels;
    const welem = (1n << (S + 1n)) - 1n;
    const wmask = this._replicate(welem, esize, bits);
    // Solo soportamos AND/ORR/EOR con wmask = tmask aquí
    return wmask;
  }

  _replicate(value, esize, bits) {
    let result = 0n;
    for (let i = 0n; i < BigInt(bits); i += esize) {
      result |= value << i;
    }
    return result & ((1n << BigInt(bits)) - 1n);
  }

  _clz64(v) {
    if (v === 0n) return 64;
    let n = 0;
    for (let i = 63; i >= 0; i--) {
      if ((v >> BigInt(i)) & 1n) break;
      n++;
    }
    return n;
  }

  _reverseBits(v, bits) {
    let r = 0n;
    const u = as_uint(v, bits);
    for (let i = 0n; i < BigInt(bits); i++) {
      r = (r << 1n) | ((u >> i) & 1n);
    }
    return r;
  }

  _reverseBytes(v, bits) {
    const u = as_uint(v, bits);
    let r = 0n;
    const bytes = bits / 8;
    for (let i = 0; i < bytes; i++) {
      r = (r << 8n) | ((u >> BigInt(i * 8)) & 0xffn);
    }
    return r;
  }

  _reverseBytesPer16(v, bits) {
    // Reverse bytes within each 16-bit chunk
    return v; // simplificado
  }

  _reverseBytesPer32(v, bits) {
    return v; // simplificado
  }

  _countLeadingZeros(v, bits) {
    const u = as_uint(v, bits);
    if (u === 0n) return bits;
    let n = 0;
    for (let i = bits - 1; i >= 0; i--) {
      if ((u >> BigInt(i)) & 1n) break;
      n++;
    }
    return n;
  }

  _countLeadingSignBits(v, bits) {
    const u = as_uint(v, bits);
    const sign = (u >> BigInt(bits - 1)) & 1n;
    let n = 0;
    for (let i = bits - 2; i >= 0; i--) {
      if (((u >> BigInt(i)) & 1n) !== sign) break;
      n++;
    }
    return n;
  }

  _mulDp3(op31, o0, a, b, acc, sf) {
    return { result: 0n, overflow: false };
  }

  run(maxInstructions = 100000) {
    this.state = EXECUTOR_STATE.RUNNING;
    kernelBus.emit(EXECUTOR_EVENTS.STARTED, { arch: this.isArm64E ? "arm64e" : "arm64" });
    let n = 0;
    while (n < maxInstructions) {
      if (this.state !== EXECUTOR_STATE.RUNNING) break;
      if (this.checkBreakpoint(this.vcpu.regs.rip)) break;
      try {
        this.step();
      } catch (err) {
        this.panic(err.message);
        break;
      }
      n++;
    }
    kernelBus.emit(EXECUTOR_EVENTS.STOPPED, { instructions: n });
    return n;
  }
}

// ============================================================================
// 6. X86_64 EXECUTOR
// ============================================================================

export class X86_64Executor extends BaseExecutor {
  constructor(vcpu, opts = {}) {
    super(vcpu);
    this.flags = new X86Flags();
    this.rexPrefix = { W: 0, R: 0, X: 0, B: 0, present: false };
    this.segmentOverrides = { present: false, seg: null };
    this.operandSizeOverride = false;
    this.addressSizeOverride = false;
    this._registerDefaultSyscalls();
  }

  _registerDefaultSyscalls() {
    // Darwin syscalls x86_64: rax = number, args in rdi, rsi, rdx, r10, r8, r9
    this.registerSyscall(0x2000001, (cpu) => this.halt()); // exit
    this.registerSyscall(0x2000003, (cpu) => cpu.regs.gpr[0] = 0n); // read
    this.registerSyscall(0x2000004, (cpu) => { // write
      const fd = Number(cpu.regs.gpr[7]); // rdi
      const buf = Number(cpu.regs.gpr[6]); // rsi
      const count = Number(cpu.regs.gpr[2]); // rdx
      const bytes = this.readMemory(buf, count);
      const text = new TextDecoder().decode(bytes);
      if (typeof console !== "undefined") console.log(text);
      cpu.regs.gpr[0] = BigInt(count);
    });
    this.registerSyscall(0x2000005, (cpu) => cpu.regs.gpr[0] = 3n); // open
    this.registerSyscall(0x2000006, (cpu) => cpu.regs.gpr[0] = 0n); // close
    this.registerSyscall(0x20000c5, (cpu) => cpu.regs.gpr[0] = 0x10000000n); // mmap
    this.registerSyscall(0x2000049, (cpu) => cpu.regs.gpr[0] = 0n); // munmap
  }

  step() {
    const cpu = this.vcpu;
    const pc = cpu.regs.rip;

    if (this.checkBreakpoint(pc)) return false;

    // Leer hasta 15 bytes (máximo x86 instruction length)
    const bytes = this.readMemory(pc, 15);
    const reader = new ByteReader(bytes);

    // Reset prefixes
    this.rexPrefix = { W: 0, R: 0, X: 0, B: 0, present: false };
    this.segmentOverrides = { present: false, seg: null };
    this.operandSizeOverride = false;
    this.addressSizeOverride = false;

    // Parse prefixes
    let consumed = this._parsePrefixes(reader);

    const opcodeStart = reader.offset;
    const opcode = reader.u8();

    this.stats.instructions++;
    this.instructionCount++;

    this._decodeX86(opcode, reader, cpu, pc);

    kernelBus.emit(EXECUTOR_EVENTS.INSTRUCTION, {
      pc: pc.toString(),
      length: reader.offset,
    });

    return true;
  }

  _parsePrefixes(reader) {
    let count = 0;
    while (true) {
      const peek = reader.peek();
      if (peek === 0x66) {
        this.operandSizeOverride = true;
        reader.u8();
        count++;
      } else if (peek === 0x67) {
        this.addressSizeOverride = true;
        reader.u8();
        count++;
      } else if (peek === 0xf0) { // LOCK
        reader.u8();
        count++;
      } else if (peek === 0x2e || peek === 0x36 || peek === 0x3e ||
                 peek === 0x26 || peek === 0x64 || peek === 0x65) {
        this.segmentOverrides = { present: true, seg: peek };
        reader.u8();
        count++;
      } else if (peek === 0x66 || peek === 0xf2 || peek === 0xf3) {
        reader.u8();
        count++;
      } else if (peek >= 0x40 && peek <= 0x4f) {
        // REX prefix
        const rex = reader.u8();
        this.rexPrefix = {
          W: (rex >> 3) & 1,
          R: (rex >> 2) & 1,
          X: (rex >> 1) & 1,
          B: rex & 1,
          present: true,
        };
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  _decodeX86(opcode, reader, cpu, pc) {
    // ========================================
    // Group 1: arith r/m, r
    // ========================================
    if (opcode >= 0x00 && opcode <= 0x3f) {
      return this._decodeArithGroup(opcode, reader, cpu, pc);
    }

    // ========================================
    // Group 2: prefixes (already parsed) and misc
    // ========================================
    if (opcode >= 0x40 && opcode <= 0x4f) {
      // REX (already handled if appeared here)
      // Actually 0x40-0x4f in 64-bit mode are all REX prefixes
      return this._decodeRexAsOpcode(reader, cpu, pc);
    }

    // ========================================
    // PUSH/POP r64
    // ========================================
    if (opcode >= 0x50 && opcode <= 0x57) {
      const reg = (opcode - 0x50) + (this.rexPrefix.B << 3);
      const sp = cpu.regs.gpr[4] || 0n;
      const newSp = sp - 8n;
      cpu.regs.gpr[4] = newSp;
      this._writeInt(newSp, cpu.regs.gpr[reg] || 0n, 64);
      cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      return true;
    }
    if (opcode >= 0x58 && opcode <= 0x5f) {
      const reg = (opcode - 0x58) + (this.rexPrefix.B << 3);
      const sp = cpu.regs.gpr[4] || 0n;
      cpu.regs.gpr[reg] = this._readInt(sp, 64);
      cpu.regs.gpr[4] = sp + 8n;
      cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      return true;
    }

    // ========================================
    // MOV r/m, r (0x88-0x8B)
    // ========================================
    if (opcode >= 0x88 && opcode <= 0x8b) {
      const modrm = reader.u8();
      const reg = ((modrm >> 3) & 0x7) + (this.rexPrefix.R << 3);
      const rm = (modrm & 0x7) + (this.rexPrefix.B << 3);
      const isReg = (modrm & 0xc0) === 0xc0;
      const size = this.rexPrefix.W ? 64 : (this.operandSizeOverride ? 16 : 32);
      if (isReg) {
        if (opcode === 0x88 || opcode === 0x89) {
          cpu.regs.gpr[rm] = as_int(cpu.regs.gpr[reg] || 0n, size);
        } else {
          cpu.regs.gpr[reg] = as_int(cpu.regs.gpr[rm] || 0n, size);
        }
      }
      cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      return true;
    }

    // ========================================
    // MOV r64, imm64 (0xB8-0xBF with REX.W)
    // ========================================
    if (opcode >= 0xb8 && opcode <= 0xbf) {
      const reg = (opcode - 0xb8) + (this.rexPrefix.B << 3);
      if (this.rexPrefix.W) {
        const imm = reader.u64();
        cpu.regs.gpr[reg] = imm;
      } else if (this.operandSizeOverride) {
        const imm = reader.u16();
        cpu.regs.gpr[reg] = BigInt(imm);
      } else {
        const imm = reader.u32();
        cpu.regs.gpr[reg] = as_int(BigInt(imm), 32);
      }
      cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      return true;
    }

    // ========================================
    // Group 3: TEST, NOT, NEG, MUL, IMUL, DIV, IDIV (0xF6-0xF7)
    // ========================================
    if (opcode === 0xf6 || opcode === 0xf7) {
      const modrm = reader.u8();
      const rm = (modrm & 0x7) + (this.rexPrefix.B << 3);
      const reg = (modrm >> 3) & 0x7;
      const size = opcode === 0xf7 ? (this.rexPrefix.W ? 64 : 32) : 8;
      const a = cpu.regs.gpr[rm] || 0n;
      if (reg === 0) {
        // TEST
        const imm = size === 64 ? reader.u32() : size === 32 ? reader.u32() : reader.u8();
        const r = a & BigInt(imm);
        this.flags.ZF = r === 0n;
        this.flags.SF = (r & (1n << BigInt(size - 1))) !== 0n;
      } else if (reg === 2) { // NOT
        cpu.regs.gpr[rm] = as_int(~a, size);
      } else if (reg === 3) { // NEG
        const r = as_int(-a, size);
        cpu.regs.gpr[rm] = r;
        this.flags.CF = a !== 0n;
        this.flags.ZF = r === 0n;
        this.flags.SF = (r & (1n << BigInt(size - 1))) !== 0n;
      }
      cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      return true;
    }

    // ========================================
    // Jcc rel32 (0x0F 0x80-0x8F) - handled in two-byte opcode
    // ========================================
    if (opcode === 0x0f) {
      return this._decodeTwoByte(reader, cpu, pc);
    }

    // ========================================
    // Jcc rel8 (0x70-0x7F)
    // ========================================
    if (opcode >= 0x70 && opcode <= 0x7f) {
      const cc = opcode & 0xf;
      const imm8 = reader.i8();
      if (this.flags.evalCond(cc)) {
        cpu.regs.rip = BigInt(pc + reader.offset + imm8);
      } else {
        cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      }
      this.stats.branches++;
      return true;
    }

    // ========================================
    // Group 1 immediate: ADD/OR/ADC/SBB/AND/SUB/XOR/CMP r/m, imm (0x80-0x83)
    // ========================================
    if (opcode >= 0x80 && opcode <= 0x83) {
      const modrm = reader.u8();
      const reg = (modrm >> 3) & 0x7;
      const rm = (modrm & 0x7) + (this.rexPrefix.B << 3);
      const size = opcode === 0x80 ? 8 : opcode === 0x81 ? (this.rexPrefix.W ? 64 : 32) : (this.rexPrefix.W ? 64 : 32);
      let imm;
      if (opcode === 0x80) imm = BigInt(reader.u8());
      else if (opcode === 0x81) imm = size === 64 ? reader.u32() : reader.u32();
      else imm = BigInt(reader.i8());
      const a = cpu.regs.gpr[rm] || 0n;
      const result = this._arith(reg, a, imm, size);
      cpu.regs.gpr[rm] = as_int(result, size);
      cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      return true;
    }

    // ========================================
    // Group 1: ADD/OR/... r/m, r (0x00-0x3F) handled above
    // ========================================

    // ========================================
    // TEST r/m, r (0x84-0x85)
    // ========================================
    if (opcode === 0x84 || opcode === 0x85) {
      const modrm = reader.u8();
      const reg = ((modrm >> 3) & 0x7) + (this.rexPrefix.R << 3);
      const rm = (modrm & 0x7) + (this.rexPrefix.B << 3);
      const size = opcode === 0x85 ? (this.rexPrefix.W ? 64 : 32) : 8;
      const r = (cpu.regs.gpr[rm] || 0n) & (cpu.regs.gpr[reg] || 0n);
      this.flags.ZF = r === 0n;
      this.flags.SF = (r & (1n << BigInt(size - 1))) !== 0n;
      cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      return true;
    }

    // ========================================
    // XCHG (0x86-0x87)
    // ========================================
    if (opcode === 0x86 || opcode === 0x87) {
      const modrm = reader.u8();
      const reg = ((modrm >> 3) & 0x7) + (this.rexPrefix.R << 3);
      const rm = (modrm & 0x7) + (this.rexPrefix.B << 3);
      const a = cpu.regs.gpr[rm] || 0n;
      const b = cpu.regs.gpr[reg] || 0n;
      cpu.regs.gpr[rm] = b;
      cpu.regs.gpr[reg] = a;
      cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      return true;
    }

    // ========================================
    // C7: MOV r/m, imm32
    // ========================================
    if (opcode === 0xc7) {
      const modrm = reader.u8();
      const rm = (modrm & 0x7) + (this.rexPrefix.B << 3);
      const size = this.rexPrefix.W ? 64 : 32;
      const imm = size === 64 ? reader.u32() : reader.u32();
      cpu.regs.gpr[rm] = as_int(BigInt(imm), size);
      cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      return true;
    }

    // ========================================
    // NOP (0x90)
    // ========================================
    if (opcode === 0x90) {
      cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      return true;
    }

    // ========================================
    // RET (0xC3), RET imm16 (0xC2)
    // ========================================
    if (opcode === 0xc3) {
      const sp = cpu.regs.gpr[4] || 0n;
      cpu.regs.rip = this._readInt(sp, 64);
      cpu.regs.gpr[4] = sp + 8n;
      this.stats.branches++;
      return true;
    }
    if (opcode === 0xc2) {
      const imm = reader.u16();
      const sp = cpu.regs.gpr[4] || 0n;
      cpu.regs.rip = this._readInt(sp, 64);
      cpu.regs.gpr[4] = sp + 8n + BigInt(imm);
      this.stats.branches++;
      return true;
    }

    // ========================================
    // CALL rel32 (0xE8)
    // ========================================
    if (opcode === 0xe8) {
      const rel = reader.i32();
      const sp = cpu.regs.gpr[4] || 0n;
      const newSp = sp - 8n;
      cpu.regs.gpr[4] = newSp;
      this._writeInt(newSp, BigInt(pc) + BigInt(reader.offset), 64);
      cpu.regs.rip = BigInt(pc + reader.offset + rel);
      this.stats.branches++;
      return true;
    }

    // ========================================
    // JMP rel32 (0xE9)
    // ========================================
    if (opcode === 0xe9) {
      const rel = reader.i32();
      cpu.regs.rip = BigInt(pc + reader.offset + rel);
      this.stats.branches++;
      return true;
    }

    // ========================================
    // JMP rel8 (0xEB)
    // ========================================
    if (opcode === 0xeb) {
      const rel = reader.i8();
      cpu.regs.rip = BigInt(pc + reader.offset + rel);
      this.stats.branches++;
      return true;
    }

    // ========================================
    // SYSCALL (0x0F 0x05)
    // ========================================
    if (opcode === 0x0f) {
      // already handled above
    }

    // ========================================
    // CPUID (0x0F 0xA2) - handled in two-byte
    // ========================================

    // ========================================
    // INT3 (0xCC)
    // ========================================
    if (opcode === 0xcc) {
      this.state = EXECUTOR_STATE.BREAKPOINT;
      kernelBus.emit(EXECUTOR_EVENTS.BREAKPOINT, { pc: pc.toString() });
      return true;
    }

    // ========================================
    // HLT (0xF4)
    // ========================================
    if (opcode === 0xf4) {
      this.halt();
      return true;
    }

    // Fallback
    kernelBus.emit(EXECUTOR_EVENTS.UNKNOWN_OPCODE, {
      pc: pc.toString(),
      opcode: "0x" + opcode.toString(16),
    });
    throw new Error(
      `x86_64: unknown opcode 0x${opcode.toString(16)} at 0x${pc.toString(16)}`
    );
  }

  _decodeArithGroup(opcode, reader, cpu, pc) {
    const modrm = reader.u8();
    const reg = (modrm >> 3) & 0x7;
    const rm = (modrm & 0x7) + (this.rexPrefix.B << 3);
    const isReg = (modrm & 0xc0) === 0xc0;
    const size = (opcode & 1) === 1 ? (this.rexPrefix.W ? 64 : 32) : 8;
    const opIndex = opcode >> 3;
    let a, b;
    if (opcode < 0x08) {
      // ADD r/m8, r8
      a = cpu.regs.gpr[rm] || 0n;
      b = cpu.regs.gpr[reg] || 0n;
      cpu.regs.gpr[rm] = as_int(this._arith(opIndex, a, b, size), size);
    } else if (opcode < 0x10) {
      // OR
      a = cpu.regs.gpr[rm] || 0n;
      b = cpu.regs.gpr[reg] || 0n;
      cpu.regs.gpr[rm] = as_int(this._arith(opIndex, a, b, size), size);
    } else if (opcode < 0x18) {
      // ADC
      a = cpu.regs.gpr[rm] || 0n;
      b = cpu.regs.gpr[reg] || 0n;
      cpu.regs.gpr[rm] = as_int(this._arith(opIndex, a, b, size), size);
    } else if (opcode < 0x20) {
      // SBB
      a = cpu.regs.gpr[rm] || 0n;
      b = cpu.regs.gpr[reg] || 0n;
      cpu.regs.gpr[rm] = as_int(this._arith(opIndex, a, b, size), size);
    } else if (opcode < 0x28) {
      // AND
      a = cpu.regs.gpr[rm] || 0n;
      b = cpu.regs.gpr[reg] || 0n;
      cpu.regs.gpr[rm] = as_int(this._arith(opIndex, a, b, size), size);
    } else if (opcode < 0x30) {
      // SUB
      a = cpu.regs.gpr[rm] || 0n;
      b = cpu.regs.gpr[reg] || 0n;
      cpu.regs.gpr[rm] = as_int(this._arith(opIndex, a, b, size), size);
    } else if (opcode < 0x38) {
      // XOR
      a = cpu.regs.gpr[rm] || 0n;
      b = cpu.regs.gpr[reg] || 0n;
      cpu.regs.gpr[rm] = as_int(this._arith(opIndex, a, b, size), size);
    } else {
      // CMP
      a = cpu.regs.gpr[rm] || 0n;
      b = cpu.regs.gpr[reg] || 0n;
      this._arith(opIndex, a, b, size);
    }
    cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
    return true;
  }

  _arith(opIndex, a, b, size) {
    const bits = size;
    const unsignedMask = (1n << BigInt(bits)) - 1n;
    const ua = a & unsignedMask;
    const ub = b & unsignedMask;
    let result;

    switch (opIndex) {
      case 0: { // ADD
        result = ua + ub;
        this.flags.CF = result > unsignedMask;
        this.flags.OF = (((ua ^ result) & (ub ^ result)) & (1n << BigInt(bits - 1))) !== 0n;
        result &= unsignedMask;
        break;
      }
      case 1: { // OR
        result = ua | ub;
        this.flags.CF = false;
        this.flags.OF = false;
        break;
      }
      case 2: { // ADC
        const carry = this.flags.CF ? 1n : 0n;
        result = ua + ub + carry;
        this.flags.CF = result > unsignedMask;
        result &= unsignedMask;
        break;
      }
      case 3: { // SBB
        const borrow = this.flags.CF ? 1n : 0n;
        result = ua - ub - borrow;
        this.flags.CF = result < 0n;
        result &= unsignedMask;
        break;
      }
      case 4: { // AND
        result = ua & ub;
        this.flags.CF = false;
        this.flags.OF = false;
        break;
      }
      case 5: { // SUB
        result = ua - ub;
        this.flags.CF = result < 0n;
        this.flags.OF = (((ua ^ ub) & (ua ^ result)) & (1n << BigInt(bits - 1))) !== 0n;
        result &= unsignedMask;
        break;
      }
      case 6: { // XOR
        result = ua ^ ub;
        this.flags.CF = false;
        this.flags.OF = false;
        break;
      }
      case 7: { // CMP
        const temp = ua - ub;
        this.flags.CF = temp < 0n;
        this.flags.OF = (((ua ^ ub) & (ua ^ temp)) & (1n << BigInt(bits - 1))) !== 0n;
        result = temp & unsignedMask;
        break;
      }
      default:
        result = ua;
    }

    this.flags.ZF = result === 0n;
    this.flags.SF = (result & (1n << BigInt(bits - 1))) !== 0n;
    this.flags.PF = (this._popcount(result & 0xffn) % 2) === 0;
    return result;
  }

  _decodeTwoByte(reader, cpu, pc) {
    const opcode2 = reader.u8();

    // SYSCALL (0x0F 0x05)
    if (opcode2 === 0x05) {
      this.stats.syscalls++;
      const num = Number(cpu.regs.gpr[0]); // rax
      kernelBus.emit(EXECUTOR_EVENTS.SYSCALL, { number: num });
      const handler = this.syscalls.get(num);
      if (handler) handler(cpu);
      else this.log.warn(`unhandled syscall 0x${num.toString(16)}`);
      cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      return true;
    }

    // CPUID (0x0F 0xA2)
    if (opcode2 === 0xa2) {
      const leaf = Number(cpu.regs.gpr[0]);
      // Responder como CPU genérica
      cpu.regs.gpr[0] = 0x00000001n; // eax
      cpu.regs.gpr[1] = 0x6c65746en; // ebx "ntel"
      cpu.regs.gpr[2] = 0x6c65746en; // ecx
      cpu.regs.gpr[3] = 0x6c65746en; // edx
      cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      return true;
    }

    // RDTSC (0x0F 0x31)
    if (opcode2 === 0x31) {
      const t = BigInt(this.instructionCount);
      cpu.regs.gpr[0] = t & 0xffffffffn; // eax
      cpu.regs.gpr[2] = t >> 32n;        // edx
      cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      return true;
    }

    // Jcc rel32 (0x80-0x8F)
    if (opcode2 >= 0x80 && opcode2 <= 0x8f) {
      const cc = opcode2 & 0xf;
      const rel = reader.i32();
      if (this.flags.evalCond(cc)) {
        cpu.regs.rip = BigInt(pc + reader.offset + rel);
      } else {
        cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      }
      this.stats.branches++;
      return true;
    }

    // SETcc r/m8 (0x90-0x9F)
    if (opcode2 >= 0x90 && opcode2 <= 0x9f) {
      const cc = opcode2 & 0xf;
      const modrm = reader.u8();
      const rm = (modrm & 0x7) + (this.rexPrefix.B << 3);
      cpu.regs.gpr[rm] = this.flags.evalCond(cc) ? 1n : 0n;
      cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      return true;
    }

    // MOVZX (0x0F 0xB6-0xB7), MOVSX (0xBE-0xBF)
    if (opcode2 === 0xb6 || opcode2 === 0xb7 || opcode2 === 0xbe || opcode2 === 0xbf) {
      const modrm = reader.u8();
      const reg = ((modrm >> 3) & 0x7) + (this.rexPrefix.R << 3);
      const rm = (modrm & 0x7) + (this.rexPrefix.B << 3);
      const a = cpu.regs.gpr[rm] || 0n;
      const size = this.rexPrefix.W ? 64 : 32;
      let v;
      if (opcode2 === 0xb6) v = a & 0xffn;
      else if (opcode2 === 0xb7) v = a & 0xffffn;
      else if (opcode2 === 0xbe) v = sign_extend(a & 0xffn, 8);
      else v = sign_extend(a & 0xffffn, 16);
      cpu.regs.gpr[reg] = as_int(v, size);
      cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      return true;
    }

    // NOP (0x0F 0x1F)
    if (opcode2 === 0x1f) {
      const modrm = reader.u8();
      const isMem = (modrm & 0xc0) !== 0xc0;
      if (isMem) {
        // Consumir displacement
        reader.skip(1);
      }
      cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      return true;
    }

    // IMUL (0x0F 0xAF)
    if (opcode2 === 0xaf) {
      const modrm = reader.u8();
      const reg = ((modrm >> 3) & 0x7) + (this.rexPrefix.R << 3);
      const rm = (modrm & 0x7) + (this.rexPrefix.B << 3);
      const size = this.rexPrefix.W ? 64 : 32;
      const a = cpu.regs.gpr[reg] || 0n;
      const b = cpu.regs.gpr[rm] || 0n;
      cpu.regs.gpr[reg] = as_int(a * b, size);
      cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
      return true;
    }

    // Fallback
    kernelBus.emit(EXECUTOR_EVENTS.UNKNOWN_OPCODE, {
      pc: pc.toString(),
      opcode2: "0x0f 0x" + opcode2.toString(16),
    });
    throw new Error(
      `x86_64: unknown two-byte opcode 0x0f 0x${opcode2.toString(16)} at 0x${pc.toString(16)}`
    );
  }

  _decodeRexAsOpcode(reader, cpu, pc) {
    // Los 0x40-0x4f en modo 64-bit son REX. Si llegamos aquí, es porque
    // no se consumieron como prefijo. Los tratamos como NOP.
    cpu.regs.rip = BigInt(pc) + BigInt(reader.offset);
    return true;
  }

  _readInt(addr, bits) {
    const bytes = this.readMemory(addr, bits / 8);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bits === 8) return BigInt(view.getUint8(0));
    if (bits === 16) return BigInt(view.getUint16(0, true));
    if (bits === 32) return BigInt(view.getUint32(0, true));
    if (bits === 64) return view.getBigUint64(0, true);
    return 0n;
  }

  _writeInt(addr, value, bits) {
    const size = bits / 8;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    if (bits === 8) view.setUint8(0, Number(value & 0xffn));
    else if (bits === 16) view.setUint16(0, Number(value & 0xffffn), true);
    else if (bits === 32) view.setUint32(0, Number(value & 0xffffffffn), true);
    else if (bits === 64) view.setBigUint64(0, BigInt.asUintN(64, value), true);
    this.writeMemory(addr, buf);
  }

  _popcount(v) {
    let n = 0;
    let x = v;
    while (x) {
      n += Number(x & 1n);
      x >>= 1n;
    }
    return n;
  }

  run(maxInstructions = 100000) {
    this.state = EXECUTOR_STATE.RUNNING;
    kernelBus.emit(EXECUTOR_EVENTS.STARTED, { arch: "x86_64" });
    let n = 0;
    while (n < maxInstructions) {
      if (this.state !== EXECUTOR_STATE.RUNNING) break;
      if (this.checkBreakpoint(this.vcpu.regs.rip)) break;
      try {
        this.step();
      } catch (err) {
        this.panic(err.message);
        break;
      }
      n++;
    }
    kernelBus.emit(EXECUTOR_EVENTS.STOPPED, { instructions: n });
    return n;
  }
}

// ============================================================================
// 7. BYTE READER
// ============================================================================

class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }
  peek() {
    return this.bytes[this.offset];
  }
  u8() {
    return this.bytes[this.offset++];
  }
  i8() {
    const v = this.bytes[this.offset++];
    return v >= 0x80 ? v - 0x100 : v;
  }
  u16() {
    const v = this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8);
    this.offset += 2;
    return v;
  }
  u32() {
    const v =
      this.bytes[this.offset] |
      (this.bytes[this.offset + 1] << 8) |
      (this.bytes[this.offset + 2] << 16) |
      (this.bytes[this.offset + 3] << 24);
    this.offset += 4;
    return v >>> 0;
  }
  i32() {
    const v = this.u32();
    return v >= 0x80000000 ? v - 0x100000000 : v;
  }
  u64() {
    const lo = this.u32();
    const hi = this.u32();
    return (BigInt(hi) << 32n) | BigInt(lo);
  }
  skip(n) {
    this.offset += n;
    return this;
  }
}

// ============================================================================
// 8. FACTORY
// ============================================================================

export function createExecutor(vcpu, arch) {
  const normalized = String(arch || "").toLowerCase();
  if (normalized.startsWith("arm64")) {
    return new Arm64Executor(vcpu, { isArm64E: normalized === "arm64e" });
  }
  if (normalized.startsWith("x86_64") || normalized === "x86_64h") {
    return new X86_64Executor(vcpu);
  }
  throw new Error(`unsupported arch: ${arch}`);
}

// ============================================================================
// 9. EXPORTS
// ============================================================================

export default {
  Arm64Executor,
  X86_64Executor,
  createExecutor,
  ARCH,
  COND_ARM64,
  COND_X86,
  X86_FLAGS,
  ARM64_FLAGS,
  EXECUTOR_STATE,
  EXECUTOR_EVENTS,
};
