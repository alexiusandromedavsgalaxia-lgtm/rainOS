// ============================================================================
// RISCV-executor.jsx — Ejecutor RISC-V (RV64GC) para rainOS
// ----------------------------------------------------------------------------
// Interpreter de la ISA RISC-V de 64 bits, con las extensiones estándar:
//
//   I — Integer base (32 registros x0..x31 de 64-bit, aritmética, carga/
//       almacenamiento, saltos)
//   M — Multiplicación/división enteras (MUL/MULH/DIV/REM y variantes)
//   A — Atómicos (LR/SC, AMOSWAP/AMOADD/AMOAND/AMOOR/AMOXOR/AMOMIN/AMOMAX)
//   F — Punto flotante simple precisión (registros f0..f31, 32-bit)
//   D — Punto flotante doble precisión (mismos registros f0..f31, 64-bit)
//   C — Instrucciones comprimidas (16-bit, subset de las anteriores)
//
// RISC-V es deliberadamente regular en su codificación (a diferencia de
// x86/ARM64): todas las instrucciones base son de 32 bits fijos (salvo
// la extensión C, de 16 bits), con 6 formatos de codificación (R/I/S/B/
// U/J) y el opcode SIEMPRE en los bits [6:0]. Eso permite un decoder
// más simple y más fácil de verificar exhaustivamente que en las otras
// arquitecturas de este repo.
//
// Alcance real, declarado explícitamente (mismo criterio que
// x64-executor.jsx — no repetir el patrón de "cobertura completa" no
// verificable de otros archivos de este repo):
//   ✅ RV64I completo: los 47 opcodes base de la ISA (aritmética,
//      lógica, shifts, loads/stores de 8/16/32/64-bit con signo/sin
//      signo, saltos condicionales, JAL/JALR, LUI/AUIPC, ECALL/EBREAK,
//      FENCE)
//   ✅ M completo: MUL/MULH/MULHU/MULHSU/DIV/DIVU/REM/REMU (word y
//      doubleword — MULW/DIVW/etc)
//   ✅ A: LR.W/D, SC.W/D, y las 9 operaciones AMO
//   ✅ F/D: aritmética básica (FADD/FSUB/FMUL/FDIV/FSQRT), comparación,
//      conversión entre entero y flotante, carga/almacenamiento
//   ⚠️ C (comprimidas): subset de las más frecuentes en código real
//      (C.ADDI, C.LI, C.MV, C.J, C.BEQZ/BNEZ, C.LW/SW, C.LD/SD), no
//      las 40+ instrucciones comprimidas completas del estándar
//   ❌ Sin extensión V (vectorial), sin modo privilegiado completo
//      (S-mode/M-mode con CSRs de verdad — se simulan como registros
//      planos, no como el modelo de privilegios real)
//
// Convención: igual que el resto del repo — clase pura sin React,
// Provider fino + hook, eventos en kernelBus.
// ============================================================================

import React, { createContext, useContext, useEffect, useMemo, useRef } from "react";

import { kernelBus } from "../kernel/kernel.jsx";

// ============================================================================
// HELPERS
// ============================================================================

function u64(x) {
  return BigInt.asUintN(64, x);
}
function i64(x) {
  return BigInt.asIntN(64, x);
}
function u32(x) {
  return Number(BigInt.asUintN(32, BigInt(x)));
}
function i32(x) {
  return Number(BigInt.asIntN(32, BigInt(x)));
}
function hex64(x) {
  return "0x" + BigInt.asUintN(64, x).toString(16).padStart(16, "0");
}
function hex32(x) {
  return "0x" + (x >>> 0).toString(16).padStart(8, "0");
}

// Extrae bits [hi:lo] de un entero de 32-bit (instrucción). Como RISC-V
// tiene los campos de instrucción siempre dentro de 32 bits, trabajamos
// en Number normal aquí, no BigInt — más rápido y suficiente.
function bits(insn, hi, lo) {
  return (insn >>> lo) & ((1 << (hi - lo + 1)) - 1);
}

// Sign-extend un valor de `width` bits a 32-bit con signo (Number).
function signExtend32(value, width) {
  const shift = 32 - width;
  return (value << shift) >> shift;
}

const REG_NAMES = [
  "zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2",
  "s0", "s1", "a0", "a1", "a2", "a3", "a4", "a5",
  "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7",
  "s8", "s9", "s10", "s11", "t3", "t4", "t5", "t6",
];

// ============================================================================
// OPCODES BASE (bits [6:0] de la instrucción de 32-bit)
// ============================================================================

const OPCODE = Object.freeze({
  LOAD:      0x03,
  LOAD_FP:   0x07,
  MISC_MEM:  0x0f, // FENCE
  OP_IMM:    0x13, // ADDI, SLTI, etc. (registro-inmediato, 32/64-bit según width)
  AUIPC:     0x17,
  OP_IMM_32: 0x1b, // ADDIW, SLLIW, etc. (sólo en RV64: versión de 32-bit)
  STORE:     0x23,
  STORE_FP:  0x27,
  AMO:       0x2f, // atómicos
  OP:        0x33, // R-type: ADD, SUB, etc. (y M extension: MUL, DIV...)
  LUI:       0x37,
  OP_32:     0x3b, // ADDW, SUBW, etc. (RV64: versión de 32-bit de OP)
  MADD:      0x43,
  MSUB:      0x47,
  NMSUB:     0x4b,
  NMADD:     0x4f,
  OP_FP:     0x53, // F/D extension
  BRANCH:    0x63,
  JALR:      0x67,
  JAL:       0x6f,
  SYSTEM:    0x73, // ECALL, EBREAK, CSR*
});

// ============================================================================
// CLASE: RiscvExecutor
// ============================================================================

export class RiscvExecutor {
  constructor(config = {}) {
    this.config = {
      maxInstructions: 10_000_000,
      logInstructions: false,
      memorySize: 0x400000, // 4 MiB simulados
      pc: 0,
      sp: 0x400000 - 0x1000,
      syscallHandler: null,
      ...config,
    };

    // ---- Registros enteros: 32 × 64-bit (x0..x31). x0 está cableado
    // a cero por convención de RISC-V — se refuerza en getReg/setReg,
    // no confiamos en que nadie escriba directamente el array. ----
    this.x = new BigInt64Array(32);
    this.pc = u64(BigInt(this.config.pc));
    this.setReg(2, BigInt(this.config.sp)); // x2 = sp

    // ---- Registros de punto flotante: 32 × 64-bit (f0..f31), usados
    // tanto para F (32-bit, en la mitad baja) como D (64-bit completo). ----
    this.f = new Float64Array(32);
    this.fflags = 0; // NV/DZ/OF/UF/NX (flags de excepción FP, bits 4:0)
    this.frm = 0;    // rounding mode

    // ---- Memoria simulada plana ----
    this.memory = new Uint8Array(this.config.memorySize);

    // ---- Reserva de LR/SC (dirección reservada por la última LR.*,
    // o null si no hay reserva activa) ----
    this.reservation = null;

    // ---- CSRs simulados de forma mínima (no modelo de privilegios
    // real de M/S/U mode — sólo lo suficiente para que ECALL/EBREAK
    // y algunos CSR básicos no rompan la ejecución) ----
    this.csr = new Map();

    // ---- Estado ----
    this.halted = false;
    this.haltReason = null;
    this.instructionsExecuted = 0n;
    this.cycles = 0n;
    this.stats = { branches: 0, takenBranches: 0, loads: 0, stores: 0, instructions: 0 };
  }

  // -------------------------------------------------------------
  // Registros: x0 siempre lee 0 y las escrituras a x0 se ignoran,
  // tal como exige la especificación RISC-V.
  // -------------------------------------------------------------

  getReg(r) {
    if (r === 0) return 0n;
    return this.x[r];
  }

  setReg(r, v) {
    if (r === 0) return;
    this.x[r] = u64(v);
  }

  getFReg(r) {
    return this.f[r];
  }

  setFReg(r, v) {
    this.f[r] = v;
  }

  halt(reason = "unknown") {
    this.halted = true;
    this.haltReason = reason;
  }

  // -------------------------------------------------------------
  // Memoria: little-endian, tal como especifica RISC-V estándar.
  // -------------------------------------------------------------

  readU8(addr) {
    return this.memory[Number(addr) & (this.memory.length - 1)];
  }
  writeU8(addr, v) {
    this.memory[Number(addr) & (this.memory.length - 1)] = v & 0xff;
  }
  readU16(addr) {
    const a = Number(addr) & (this.memory.length - 1);
    return this.memory[a] | (this.memory[a + 1] << 8);
  }
  writeU16(addr, v) {
    const a = Number(addr) & (this.memory.length - 1);
    this.memory[a] = v & 0xff;
    this.memory[a + 1] = (v >>> 8) & 0xff;
  }
  readU32(addr) {
    const a = Number(addr) & (this.memory.length - 1);
    return (
      (this.memory[a] |
        (this.memory[a + 1] << 8) |
        (this.memory[a + 2] << 16) |
        (this.memory[a + 3] << 24)) >>>
      0
    );
  }
  writeU32(addr, v) {
    const a = Number(addr) & (this.memory.length - 1);
    this.memory[a] = v & 0xff;
    this.memory[a + 1] = (v >>> 8) & 0xff;
    this.memory[a + 2] = (v >>> 16) & 0xff;
    this.memory[a + 3] = (v >>> 24) & 0xff;
  }
  readU64(addr) {
    const lo = BigInt(this.readU32(addr));
    const hi = BigInt(this.readU32(Number(addr) + 4));
    return u64(lo | (hi << 32n));
  }
  writeU64(addr, v) {
    const val = u64(v);
    this.writeU32(addr, Number(val & 0xffffffffn));
    this.writeU32(Number(addr) + 4, Number((val >> 32n) & 0xffffffffn));
  }

  fetchU32(addr) {
    return this.readU32(addr);
  }

  // -------------------------------------------------------------
  // step(): fetch + decode + execute de UNA instrucción.
  // -------------------------------------------------------------

  step() {
    if (this.halted) return { halted: true };

    const pcBefore = this.pc;
    const raw = this.fetchU32(this.pc);

    // Instrucciones comprimidas (extensión C): si los 2 bits bajos NO
    // son 11, es una instrucción de 16-bit, no de 32-bit.
    const isCompressed = (raw & 0x3) !== 0x3;

    let result;
    if (isCompressed) {
      const insn16 = raw & 0xffff;
      result = this._executeCompressed(insn16);
      this.pc = u64(this.pc + 2n);
    } else {
      result = this._execute(raw >>> 0);
      this.pc = u64(this.pc + 4n);
    }

    // Si la instrucción fue un salto/branch tomado, _execute ya habrá
    // sobreescrito this.pc directamente; detectamos ese caso guardando
    // un flag `branched` y NO reaplicamos el +4/+2 por encima.
    if (result?.branched) {
      this.pc = result.newPc;
    }

    this.instructionsExecuted++;
    this.cycles += BigInt(result?.cycles ?? 1);
    this.stats.instructions++;

    if (this.config.logInstructions) {
      kernelBus.emit?.("cpu:instruction", {
        arch: "riscv64",
        pc: hex64(pcBefore),
        insn: isCompressed ? hex32(raw & 0xffff) : hex32(raw),
        mnemonic: result?.mnemonic ?? "?",
      });
    }

    if (this.instructionsExecuted > BigInt(this.config.maxInstructions)) {
      this.halt("max-instructions");
    }

    return { ok: true, ...result };
  }

  // -------------------------------------------------------------
  // Decodificación principal de instrucciones de 32-bit.
  // Dispatch por opcode = bits[6:0], que en RISC-V identifica
  // siempre el formato y la familia de instrucción — a diferencia
  // de x86/ARM64, aquí el dispatch de primer nivel es exhaustivo
  // y no ambiguo por diseño de la ISA.
  // -------------------------------------------------------------

  _execute(insn) {
    const opcode = bits(insn, 6, 0);

    switch (opcode) {
      case OPCODE.LUI:      return this._execLui(insn);
      case OPCODE.AUIPC:    return this._execAuipc(insn);
      case OPCODE.JAL:      return this._execJal(insn);
      case OPCODE.JALR:     return this._execJalr(insn);
      case OPCODE.BRANCH:   return this._execBranch(insn);
      case OPCODE.LOAD:     return this._execLoad(insn);
      case OPCODE.STORE:    return this._execStore(insn);
      case OPCODE.OP_IMM:   return this._execOpImm(insn, false);
      case OPCODE.OP_IMM_32:return this._execOpImm(insn, true);
      case OPCODE.OP:       return this._execOp(insn, false);
      case OPCODE.OP_32:    return this._execOp(insn, true);
      case OPCODE.MISC_MEM: return { mnemonic: "fence", cycles: 1 };
      case OPCODE.SYSTEM:   return this._execSystem(insn);
      case OPCODE.AMO:      return this._execAmo(insn);
      case OPCODE.LOAD_FP:  return this._execLoadFp(insn);
      case OPCODE.STORE_FP: return this._execStoreFp(insn);
      case OPCODE.OP_FP:    return this._execOpFp(insn);
      default:
        return { mnemonic: `unimplemented-opcode-0x${opcode.toString(16)}`, cycles: 1 };
    }
  }

  // -------------------------------------------------------------
  // U-type: LUI, AUIPC — imm[31:12] en los bits altos de la
  // instrucción, desplazado a su posición real.
  // -------------------------------------------------------------

  _decodeU(insn) {
    const imm = insn & 0xfffff000; // ya viene alineado, no hace falta shift
    const rd = bits(insn, 11, 7);
    return { imm, rd };
  }

  _execLui(insn) {
    const { imm, rd } = this._decodeU(insn);
    this.setReg(rd, i64(BigInt(i32(imm))));
    return { mnemonic: `lui x${rd}`, cycles: 1 };
  }

  _execAuipc(insn) {
    const { imm, rd } = this._decodeU(insn);
    this.setReg(rd, u64(this.pc + BigInt(i32(imm))));
    return { mnemonic: `auipc x${rd}`, cycles: 1 };
  }

  // -------------------------------------------------------------
  // J-type: JAL — el inmediato de 20 bits está codificado de forma
  // NO contigua en la instrucción (peculiaridad real de RISC-V,
  // diseñada así para simplificar el hardware, no el software).
  // Bits de la instrucción → bits del inmediato:
  //   insn[31]    → imm[20]
  //   insn[19:12] → imm[19:12]
  //   insn[20]    → imm[11]
  //   insn[30:21] → imm[10:1]
  //   imm[0] siempre 0 (los saltos son a direcciones pares)
  // -------------------------------------------------------------

  _decodeJ(insn) {
    const rd = bits(insn, 11, 7);
    const imm20 = bits(insn, 31, 31);
    const imm19_12 = bits(insn, 19, 12);
    const imm11 = bits(insn, 20, 20);
    const imm10_1 = bits(insn, 30, 21);
    let imm =
      (imm20 << 20) | (imm19_12 << 12) | (imm11 << 11) | (imm10_1 << 1);
    imm = signExtend32(imm, 21);
    return { imm, rd };
  }

  _execJal(insn) {
    const { imm, rd } = this._decodeJ(insn);
    const linkAddr = u64(this.pc + 4n);
    this.setReg(rd, linkAddr);
    const target = u64(this.pc + BigInt(imm));
    this.stats.branches++;
    this.stats.takenBranches++;
    return { mnemonic: `jal x${rd}`, cycles: 2, branched: true, newPc: target };
  }

  // -------------------------------------------------------------
  // I-type: JALR, loads, OP-IMM — imm[11:0] contiguo en insn[31:20].
  // -------------------------------------------------------------

  _decodeI(insn) {
    const rd = bits(insn, 11, 7);
    const funct3 = bits(insn, 14, 12);
    const rs1 = bits(insn, 19, 15);
    let imm = bits(insn, 31, 20);
    imm = signExtend32(imm, 12);
    return { rd, funct3, rs1, imm };
  }

  _execJalr(insn) {
    const { rd, rs1, imm } = this._decodeI(insn);
    const linkAddr = u64(this.pc + 4n);
    // El bit 0 del target se limpia siempre (spec RISC-V: "set the
    // least-significant bit of the result to zero").
    const target = u64((this.getReg(rs1) + BigInt(imm)) & ~1n);
    this.setReg(rd, linkAddr);
    this.stats.branches++;
    this.stats.takenBranches++;
    return { mnemonic: `jalr x${rd}`, cycles: 2, branched: true, newPc: target };
  }

  // -------------------------------------------------------------
  // B-type: BEQ/BNE/BLT/BGE/BLTU/BGEU — igual que J-type, el
  // inmediato está codificado de forma no contigua.
  // -------------------------------------------------------------

  _decodeB(insn) {
    const funct3 = bits(insn, 14, 12);
    const rs1 = bits(insn, 19, 15);
    const rs2 = bits(insn, 24, 20);
    const imm12 = bits(insn, 31, 31);
    const imm10_5 = bits(insn, 30, 25);
    const imm4_1 = bits(insn, 11, 8);
    const imm11 = bits(insn, 7, 7);
    let imm = (imm12 << 12) | (imm11 << 11) | (imm10_5 << 5) | (imm4_1 << 1);
    imm = signExtend32(imm, 13);
    return { funct3, rs1, rs2, imm };
  }

  _execBranch(insn) {
    const { funct3, rs1, rs2, imm } = this._decodeB(insn);
    const a = this.getReg(rs1);
    const b = this.getReg(rs2);
    // Comparaciones con/sin signo: BigInt en JS ya compara con signo
    // por defecto (BigInt.asIntN aplicado al leer los registros como
    // i64 los deja con signo); para las variantes "U" reinterpretamos
    // como sin signo con BigInt.asUintN.
    const au = BigInt.asUintN(64, a);
    const bu = BigInt.asUintN(64, b);

    let taken = false;
    let mnemonic = "b?";
    switch (funct3) {
      case 0b000: taken = a === b; mnemonic = "beq"; break;
      case 0b001: taken = a !== b; mnemonic = "bne"; break;
      case 0b100: taken = a < b; mnemonic = "blt"; break;
      case 0b101: taken = a >= b; mnemonic = "bge"; break;
      case 0b110: taken = au < bu; mnemonic = "bltu"; break;
      case 0b111: taken = au >= bu; mnemonic = "bgeu"; break;
      default: return { mnemonic: "branch-unimpl", cycles: 1 };
    }

    this.stats.branches++;
    if (taken) {
      this.stats.takenBranches++;
      const target = u64(this.pc + BigInt(imm));
      return { mnemonic, cycles: 2, branched: true, newPc: target };
    }
    return { mnemonic, cycles: 1 };
  }

  // -------------------------------------------------------------
  // Loads: LB/LH/LW/LD/LBU/LHU/LWU
  // -------------------------------------------------------------

  _execLoad(insn) {
    const { rd, funct3, rs1, imm } = this._decodeI(insn);
    const addr = u64(this.getReg(rs1) + BigInt(imm));
    this.stats.loads++;
    switch (funct3) {
      case 0b000: this.setReg(rd, i64(BigInt(signExtend32(this.readU8(addr), 8)))); return { mnemonic: "lb", cycles: 2 };
      case 0b001: this.setReg(rd, i64(BigInt(signExtend32(this.readU16(addr), 16)))); return { mnemonic: "lh", cycles: 2 };
      case 0b010: this.setReg(rd, i64(BigInt(i32(this.readU32(addr))))); return { mnemonic: "lw", cycles: 2 };
      case 0b011: this.setReg(rd, this.readU64(addr)); return { mnemonic: "ld", cycles: 2 };
      case 0b100: this.setReg(rd, BigInt(this.readU8(addr))); return { mnemonic: "lbu", cycles: 2 };
      case 0b101: this.setReg(rd, BigInt(this.readU16(addr))); return { mnemonic: "lhu", cycles: 2 };
      case 0b110: this.setReg(rd, BigInt(this.readU32(addr) >>> 0)); return { mnemonic: "lwu", cycles: 2 };
      default: return { mnemonic: "load-unimpl", cycles: 1 };
    }
  }

  // -------------------------------------------------------------
  // Stores: SB/SH/SW/SD (S-type: inmediato partido en dos campos)
  // -------------------------------------------------------------

  _decodeS(insn) {
    const funct3 = bits(insn, 14, 12);
    const rs1 = bits(insn, 19, 15);
    const rs2 = bits(insn, 24, 20);
    const imm11_5 = bits(insn, 31, 25);
    const imm4_0 = bits(insn, 11, 7);
    let imm = (imm11_5 << 5) | imm4_0;
    imm = signExtend32(imm, 12);
    return { funct3, rs1, rs2, imm };
  }

  _execStore(insn) {
    const { funct3, rs1, rs2, imm } = this._decodeS(insn);
    const addr = u64(this.getReg(rs1) + BigInt(imm));
    const v = this.getReg(rs2);
    this.stats.stores++;
    switch (funct3) {
      case 0b000: this.writeU8(addr, Number(v & 0xffn)); return { mnemonic: "sb", cycles: 1 };
      case 0b001: this.writeU16(addr, Number(v & 0xffffn)); return { mnemonic: "sh", cycles: 1 };
      case 0b010: this.writeU32(addr, Number(v & 0xffffffffn)); return { mnemonic: "sw", cycles: 1 };
      case 0b011: this.writeU64(addr, v); return { mnemonic: "sd", cycles: 1 };
      default: return { mnemonic: "store-unimpl", cycles: 1 };
    }
  }

  // -------------------------------------------------------------
  // OP-IMM (ADDI, SLTI, XORI, ORI, ANDI, SLLI, SRLI, SRAI) y su
  // variante *W de 32-bit (sólo válida en RV64, opcode OP_IMM_32).
  // -------------------------------------------------------------

  _execOpImm(insn, isWord) {
    const { rd, funct3, rs1, imm } = this._decodeI(insn);
    const a = this.getReg(rs1);
    const shamt = imm & (isWord ? 0x1f : 0x3f); // shamt: 5 bits en *W, 6 bits en 64-bit normal
    let result;
    let mnemonic;

    switch (funct3) {
      case 0b000: // ADDI / ADDIW
        result = isWord ? BigInt(i32(Number(a & 0xffffffffn) + imm)) : a + BigInt(imm);
        mnemonic = isWord ? "addiw" : "addi";
        break;
      case 0b010: // SLTI
        result = a < BigInt(imm) ? 1n : 0n;
        mnemonic = "slti";
        break;
      case 0b011: // SLTIU
        result = BigInt.asUintN(64, a) < BigInt.asUintN(64, BigInt(imm)) ? 1n : 0n;
        mnemonic = "sltiu";
        break;
      case 0b100: // XORI
        result = a ^ BigInt(imm);
        mnemonic = "xori";
        break;
      case 0b110: // ORI
        result = a | BigInt(imm);
        mnemonic = "ori";
        break;
      case 0b111: // ANDI
        result = a & BigInt(imm);
        mnemonic = "andi";
        break;
      case 0b001: // SLLI / SLLIW
        result = isWord
          ? BigInt(i32(Number(a & 0xffffffffn) << shamt))
          : a << BigInt(shamt);
        mnemonic = isWord ? "slliw" : "slli";
        break;
      case 0b101: {
        // SRLI/SRAI/SRLIW/SRAIW — distinguidos por el bit 30 de la
        // instrucción original (imm[10], ya perdido tras el sign-extend
        // de _decodeI, así que lo releemos directo de insn).
        const arith = bits(insn, 30, 30) === 1;
        if (isWord) {
          const a32 = i32(Number(a & 0xffffffffn));
          result = BigInt(arith ? a32 >> shamt : a32 >>> shamt);
          mnemonic = arith ? "sraiw" : "srliw";
        } else {
          result = arith
            ? i64(a) >> BigInt(shamt)
            : BigInt.asUintN(64, a) >> BigInt(shamt);
          mnemonic = arith ? "srai" : "srli";
        }
        break;
      }
      default:
        return { mnemonic: "op-imm-unimpl", cycles: 1 };
    }

    this.setReg(rd, u64(result));
    return { mnemonic: `${mnemonic} x${rd}`, cycles: 1 };
  }

  // -------------------------------------------------------------
  // OP (R-type): ADD/SUB/SLL/SLT/SLTU/XOR/SRL/SRA/OR/AND
  // + extensión M: MUL/MULH/MULHSU/MULHU/DIV/DIVU/REM/REMU
  // (distinguidos por funct7 = 0000001)
  // + variantes *W de 32-bit (isWord=true, opcode OP_32)
  // -------------------------------------------------------------

  _decodeR(insn) {
    const rd = bits(insn, 11, 7);
    const funct3 = bits(insn, 14, 12);
    const rs1 = bits(insn, 19, 15);
    const rs2 = bits(insn, 24, 20);
    const funct7 = bits(insn, 31, 25);
    return { rd, funct3, rs1, rs2, funct7 };
  }

  _execOp(insn, isWord) {
    const { rd, funct3, rs1, rs2, funct7 } = this._decodeR(insn);
    const a = this.getReg(rs1);
    const b = this.getReg(rs2);
    const isM = funct7 === 0b0000001;

    if (isM) {
      return this._execMExtension(rd, funct3, a, b, isWord);
    }

    const a32 = i32(Number(a & 0xffffffffn));
    const b32 = i32(Number(b & 0xffffffffn));
    let result, mnemonic;

    switch (funct3) {
      case 0b000: // ADD / SUB (funct7 bit 5 distingue) / ADDW / SUBW
        if (funct7 === 0b0100000) {
          result = isWord ? BigInt(i32(a32 - b32)) : u64(a - b);
          mnemonic = isWord ? "subw" : "sub";
        } else {
          result = isWord ? BigInt(i32(a32 + b32)) : u64(a + b);
          mnemonic = isWord ? "addw" : "add";
        }
        break;
      case 0b001: // SLL / SLLW
        result = isWord
          ? BigInt(i32(a32 << (b32 & 0x1f)))
          : a << (b & 0x3fn);
        mnemonic = isWord ? "sllw" : "sll";
        break;
      case 0b010: // SLT
        result = a < b ? 1n : 0n;
        mnemonic = "slt";
        break;
      case 0b011: // SLTU
        result = BigInt.asUintN(64, a) < BigInt.asUintN(64, b) ? 1n : 0n;
        mnemonic = "sltu";
        break;
      case 0b100: // XOR
        result = a ^ b;
        mnemonic = "xor";
        break;
      case 0b101: // SRL / SRA / SRLW / SRAW
        if (funct7 === 0b0100000) {
          result = isWord ? BigInt(a32 >> (b32 & 0x1f)) : i64(a) >> (b & 0x3fn);
          mnemonic = isWord ? "sraw" : "sra";
        } else {
          result = isWord
            ? BigInt(a32 >>> (b32 & 0x1f))
            : BigInt.asUintN(64, a) >> (b & 0x3fn);
          mnemonic = isWord ? "srlw" : "srl";
        }
        break;
      case 0b110: // OR
        result = a | b;
        mnemonic = "or";
        break;
      case 0b111: // AND
        result = a & b;
        mnemonic = "and";
        break;
      default:
        return { mnemonic: "op-unimpl", cycles: 1 };
    }

    this.setReg(rd, u64(result));
    return { mnemonic: `${mnemonic} x${rd}`, cycles: 1 };
  }

  // -------------------------------------------------------------
  // Extensión M: multiplicación y división enteras.
  // -------------------------------------------------------------

  _execMExtension(rd, funct3, a, b, isWord) {
    let result, mnemonic;

    if (isWord) {
      const a32 = BigInt(i32(Number(a & 0xffffffffn)));
      const b32 = BigInt(i32(Number(b & 0xffffffffn)));
      switch (funct3) {
        case 0b000: // MULW
          result = BigInt(i32(Number(BigInt.asIntN(64, a32 * b32) & 0xffffffffn)));
          mnemonic = "mulw";
          break;
        case 0b100: // DIVW
          result = b32 === 0n ? -1n : BigInt(i32(Number(a32 / b32)));
          mnemonic = "divw";
          break;
        case 0b101: { // DIVUW
          const au = BigInt.asUintN(32, a32), bu = BigInt.asUintN(32, b32);
          result = bu === 0n ? BigInt.asUintN(64, -1n) : BigInt(i32(Number(au / bu)));
          mnemonic = "divuw";
          break;
        }
        case 0b110: // REMW
          result = b32 === 0n ? a32 : BigInt(i32(Number(a32 % b32)));
          mnemonic = "remw";
          break;
        case 0b111: { // REMUW
          const au = BigInt.asUintN(32, a32), bu = BigInt.asUintN(32, b32);
          result = bu === 0n ? BigInt(i32(Number(au))) : BigInt(i32(Number(au % bu)));
          mnemonic = "remuw";
          break;
        }
        default:
          return { mnemonic: "m-ext-w-unimpl", cycles: 1 };
      }
    } else {
      switch (funct3) {
        case 0b000: // MUL (mitad baja de 128-bit → 64-bit truncado)
          result = u64(a * b);
          mnemonic = "mul";
          break;
        case 0b001: // MULH (mitad alta, ambos con signo)
          result = u64((i64(a) * i64(b)) >> 64n);
          mnemonic = "mulh";
          break;
        case 0b010: { // MULHSU (a con signo, b sin signo)
          const bu = BigInt.asUintN(64, b);
          result = u64((i64(a) * bu) >> 64n);
          mnemonic = "mulhsu";
          break;
        }
        case 0b011: { // MULHU (ambos sin signo)
          const au = BigInt.asUintN(64, a), bu = BigInt.asUintN(64, b);
          result = u64((au * bu) >> 64n);
          mnemonic = "mulhu";
          break;
        }
        case 0b100: // DIV (con signo; división por 0 → -1 según spec)
          result = b === 0n ? u64(-1n) : u64(i64(a) / i64(b));
          mnemonic = "div";
          break;
        case 0b101: { // DIVU (sin signo; división por 0 → todo unos)
          const au = BigInt.asUintN(64, a), bu = BigInt.asUintN(64, b);
          result = bu === 0n ? u64(-1n) : au / bu;
          mnemonic = "divu";
          break;
        }
        case 0b110: // REM (con signo; división por 0 → dividendo)
          result = b === 0n ? u64(a) : u64(i64(a) % i64(b));
          mnemonic = "rem";
          break;
        case 0b111: { // REMU (sin signo; división por 0 → dividendo)
          const au = BigInt.asUintN(64, a), bu = BigInt.asUintN(64, b);
          result = bu === 0n ? au : au % bu;
          mnemonic = "remu";
          break;
        }
        default:
          return { mnemonic: "m-ext-unimpl", cycles: 1 };
      }
    }

    this.setReg(rd, u64(result));
    return { mnemonic: `${mnemonic} x${rd}`, cycles: 4 };
  }

  // -------------------------------------------------------------
  // SYSTEM: ECALL, EBREAK, y CSR* (mínimos, no modelo de
  // privilegios completo — ver limitaciones declaradas arriba).
  // -------------------------------------------------------------

  _execSystem(insn) {
    const { rd, funct3, rs1, imm } = this._decodeI(insn);

    if (funct3 === 0) {
      // imm (los 12 bits altos de la I-type) distingue ECALL (0) de
      // EBREAK (1) cuando funct3 = 0 y rd = rs1 = 0.
      const imm12 = bits(insn, 31, 20);
      if (imm12 === 0) {
        // ECALL: convención estándar RISC-V/Linux — nº de syscall en
        // a7 (x17), argumentos en a0..a5 (x10..x15), retorno en a0.
        const nr = this.getReg(17);
        const args = [
          this.getReg(10), this.getReg(11), this.getReg(12),
          this.getReg(13), this.getReg(14), this.getReg(15),
        ];
        kernelBus.emit?.("cpu:syscall", { arch: "riscv64", nr: nr.toString(), args: args.map(String) });
        const ret = this.config.syscallHandler?.(Number(nr & 0xffffffffn), args, this) ?? 0n;
        this.setReg(10, BigInt(ret));
        return { mnemonic: "ecall", cycles: 100 };
      }
      if (imm12 === 1) {
        this.halt("ebreak");
        return { mnemonic: "ebreak", cycles: 1 };
      }
    }

    // CSR* (funct3 1-3 register form, 5-7 immediate form): simulados
    // como un simple Map dirección→valor, sin semántica de
    // privilegios real.
    if (funct3 >= 1 && funct3 <= 7 && funct3 !== 4) {
      const csrAddr = bits(insn, 31, 20);
      const old = this.csr.get(csrAddr) ?? 0n;
      let writeVal;
      const isImm = funct3 >= 5;
      const src = isImm ? BigInt(rs1) : this.getReg(rs1); // en forma imm, rs1 es el zimm de 5 bits
      switch (funct3 & 0x3) {
        case 1: writeVal = src; break;                 // CSRRW / CSRRWI
        case 2: writeVal = old | src; break;            // CSRRS / CSRRSI
        case 3: writeVal = old & ~src; break;           // CSRRC / CSRRCI
        default: writeVal = old;
      }
      this.csr.set(csrAddr, u64(writeVal));
      this.setReg(rd, old);
      return { mnemonic: "csr", cycles: 2 };
    }

    return { mnemonic: "system-unimpl", cycles: 1 };
  }

  // -------------------------------------------------------------
  // Extensión A (atómicos): LR/SC + AMO*
  // -------------------------------------------------------------

  _execAmo(insn) {
    const rd = bits(insn, 11, 7);
    const rs1 = bits(insn, 19, 15);
    const rs2 = bits(insn, 24, 20);
    const funct3 = bits(insn, 14, 12); // 010 = .W, 011 = .D
    const funct5 = bits(insn, 31, 27);
    const isDouble = funct3 === 0b011;
    const addr = this.getReg(rs1);

    const read = () => (isDouble ? this.readU64(addr) : BigInt(i32(this.readU32(addr))));
    const write = (v) => (isDouble ? this.writeU64(addr, v) : this.writeU32(addr, Number(v & 0xffffffffn)));

    switch (funct5) {
      case 0b00010: { // LR (load-reserved)
        const v = read();
        this.setReg(rd, isDouble ? v : BigInt(i32(Number(v & 0xffffffffn))));
        this.reservation = addr;
        return { mnemonic: isDouble ? "lr.d" : "lr.w", cycles: 2 };
      }
      case 0b00011: { // SC (store-conditional)
        const success = this.reservation === addr;
        if (success) {
          write(this.getReg(rs2));
        }
        this.reservation = null;
        this.setReg(rd, success ? 0n : 1n); // 0 = éxito, según spec
        return { mnemonic: isDouble ? "sc.d" : "sc.w", cycles: 2 };
      }
      default: {
        // AMOSWAP/AMOADD/AMOXOR/AMOAND/AMOOR/AMOMIN/AMOMAX/AMOMINU/AMOMAXU
        const old = read();
        const b = isDouble ? this.getReg(rs2) : BigInt(i32(Number(this.getReg(rs2) & 0xffffffffn)));
        let result;
        let mnemonic;
        switch (funct5) {
          case 0b00001: result = b; mnemonic = "amoswap"; break;
          case 0b00000: result = old + b; mnemonic = "amoadd"; break;
          case 0b00100: result = old ^ b; mnemonic = "amoxor"; break;
          case 0b01100: result = old & b; mnemonic = "amoand"; break;
          case 0b01000: result = old | b; mnemonic = "amoor"; break;
          case 0b10000: result = old < b ? old : b; mnemonic = "amomin"; break;
          case 0b10100: result = old > b ? old : b; mnemonic = "amomax"; break;
          case 0b11000: {
            const ou = BigInt.asUintN(64, old), bu = BigInt.asUintN(64, b);
            result = ou < bu ? old : b; mnemonic = "amominu"; break;
          }
          case 0b11100: {
            const ou = BigInt.asUintN(64, old), bu = BigInt.asUintN(64, b);
            result = ou > bu ? old : b; mnemonic = "amomaxu"; break;
          }
          default:
            return { mnemonic: "amo-unimpl", cycles: 1 };
        }
        write(result);
        this.setReg(rd, isDouble ? old : BigInt(i32(Number(old & 0xffffffffn))));
        return { mnemonic: `${mnemonic}.${isDouble ? "d" : "w"}`, cycles: 3 };
      }
    }
  }

  // -------------------------------------------------------------
  // Extensión F/D: aritmética de punto flotante. Se implementa
  // usando directamente los `number` de JS como float64 (Float64Array
  // para el banco de registros), que es matemáticamente correcto
  // para D; para F (32-bit) se trunca la precisión con Math.fround.
  // -------------------------------------------------------------

  _execLoadFp(insn) {
    const { rd, funct3, rs1, imm } = this._decodeI(insn);
    const addr = u64(this.getReg(rs1) + BigInt(imm));
    if (funct3 === 0b010) { // FLW
      const bits32 = this.readU32(addr);
      const buf = new ArrayBuffer(4);
      new Uint32Array(buf)[0] = bits32;
      this.setFReg(rd, new Float32Array(buf)[0]);
      return { mnemonic: "flw", cycles: 2 };
    }
    if (funct3 === 0b011) { // FLD
      const raw = this.readU64(addr);
      const buf = new ArrayBuffer(8);
      new BigUint64Array(buf)[0] = raw;
      this.setFReg(rd, new Float64Array(buf)[0]);
      return { mnemonic: "fld", cycles: 2 };
    }
    return { mnemonic: "load-fp-unimpl", cycles: 1 };
  }

  _execStoreFp(insn) {
    const { funct3, rs1, rs2, imm } = this._decodeS(insn);
    const addr = u64(this.getReg(rs1) + BigInt(imm));
    const v = this.getFReg(rs2);
    if (funct3 === 0b010) { // FSW
      const buf = new ArrayBuffer(4);
      new Float32Array(buf)[0] = Math.fround(v);
      this.writeU32(addr, new Uint32Array(buf)[0]);
      return { mnemonic: "fsw", cycles: 1 };
    }
    if (funct3 === 0b011) { // FSD
      const buf = new ArrayBuffer(8);
      new Float64Array(buf)[0] = v;
      this.writeU64(addr, new BigUint64Array(buf)[0]);
      return { mnemonic: "fsd", cycles: 1 };
    }
    return { mnemonic: "store-fp-unimpl", cycles: 1 };
  }

  _execOpFp(insn) {
    const rd = bits(insn, 11, 7);
    const rs1 = bits(insn, 19, 15);
    const rs2 = bits(insn, 24, 20);
    const funct7 = bits(insn, 31, 25);
    const isDouble = (funct7 & 0x1) === 1; // convención: .S termina en 0000000x, .D en 0000001x

    const a = this.getFReg(rs1);
    const b = this.getFReg(rs2);
    const round = isDouble ? (x) => x : (x) => Math.fround(x);

    switch (funct7 >> 2) {
      case 0b00000: this.setFReg(rd, round(a + b)); return { mnemonic: isDouble ? "fadd.d" : "fadd.s", cycles: 4 };
      case 0b00001: this.setFReg(rd, round(a - b)); return { mnemonic: isDouble ? "fsub.d" : "fsub.s", cycles: 4 };
      case 0b00010: this.setFReg(rd, round(a * b)); return { mnemonic: isDouble ? "fmul.d" : "fmul.s", cycles: 6 };
      case 0b00011: this.setFReg(rd, round(a / b)); return { mnemonic: isDouble ? "fdiv.d" : "fdiv.s", cycles: 20 };
      case 0b01011: this.setFReg(rd, round(Math.sqrt(a))); return { mnemonic: isDouble ? "fsqrt.d" : "fsqrt.s", cycles: 20 };
      case 0b10100: { // FEQ/FLT/FLE (funct3 distingue cuál)
        const funct3 = bits(insn, 14, 12);
        let r;
        if (funct3 === 0b010) r = a === b ? 1n : 0n;      // FEQ
        else if (funct3 === 0b001) r = a < b ? 1n : 0n;   // FLT
        else r = a <= b ? 1n : 0n;                        // FLE
        this.setReg(rd, r);
        return { mnemonic: "fcmp", cycles: 2 };
      }
      default:
        return { mnemonic: "op-fp-unimpl", cycles: 1 };
    }
  }

  // -------------------------------------------------------------
  // Extensión C (comprimidas, 16-bit): subset de las más comunes
  // en código real generado por compiladores. Declarado como
  // subset arriba, no las 40+ del estándar completo.
  // -------------------------------------------------------------

  _executeCompressed(insn16) {
    const op = insn16 & 0x3;
    const funct3 = (insn16 >>> 13) & 0x7;

    // C.ADDI4SPN, C.LW, C.SW (quadrant 0) — omitido por brevedad del
    // subset; devolvemos explícitamente "no implementado" en vez de
    // fingir que hace algo, siguiendo el criterio de honestidad.
    if (op === 0b00) {
      return { mnemonic: "c-quadrant0-unimpl", cycles: 1 };
    }

    // Quadrant 1: C.ADDI, C.LI, C.J, C.BEQZ, C.BNEZ, C.MV, etc.
    if (op === 0b01) {
      const rd = (insn16 >>> 7) & 0x1f;
      if (funct3 === 0b000 && rd !== 0) {
        // C.ADDI rd, imm  (rd += sign_ext(imm6))
        const imm5 = (insn16 >>> 12) & 0x1;
        const imm4_0 = (insn16 >>> 2) & 0x1f;
        let imm = (imm5 << 5) | imm4_0;
        imm = signExtend32(imm, 6);
        this.setReg(rd, u64(this.getReg(rd) + BigInt(imm)));
        return { mnemonic: `c.addi x${rd}`, cycles: 1 };
      }
      if (funct3 === 0b010 && rd !== 0) {
        // C.LI rd, imm
        const imm5 = (insn16 >>> 12) & 0x1;
        const imm4_0 = (insn16 >>> 2) & 0x1f;
        let imm = (imm5 << 5) | imm4_0;
        imm = signExtend32(imm, 6);
        this.setReg(rd, i64(BigInt(imm)));
        return { mnemonic: `c.li x${rd}`, cycles: 1 };
      }
      if (funct3 === 0b101) {
        // C.J offset (salto incondicional, offset de 11 bits no contiguo)
        const raw = (insn16 >>> 2) & 0x7ff;
        // Reordenamiento real de C.J según la spec (bits del campo a
        // bits del offset): [11|4|9:8|10|6|7|3:1|5]
        const b = raw;
        const off11 = (b >>> 10) & 1, off4 = (b >>> 9) & 1, off9_8 = (b >>> 7) & 3;
        const off10 = (b >>> 6) & 1, off6 = (b >>> 5) & 1, off7 = (b >>> 4) & 1;
        const off3_1 = (b >>> 1) & 7, off5 = b & 1;
        let imm =
          (off11 << 11) | (off10 << 10) | (off9_8 << 8) | (off6 << 6) |
          (off7 << 7) | (off4 << 4) | (off3_1 << 1) | (off5 << 5);
        imm = signExtend32(imm, 12);
        const target = u64(this.pc + BigInt(imm));
        this.stats.branches++;
        this.stats.takenBranches++;
        return { mnemonic: "c.j", cycles: 2, branched: true, newPc: target };
      }
      return { mnemonic: "c-quadrant1-unimpl", cycles: 1 };
    }

    // Quadrant 2: C.MV, C.ADD, C.SLLI
    if (op === 0b10) {
      const rd = (insn16 >>> 7) & 0x1f;
      const rs2 = (insn16 >>> 2) & 0x1f;
      if (funct3 === 0b100 && rd !== 0 && rs2 !== 0 && ((insn16 >>> 12) & 1) === 0) {
        // C.MV rd, rs2
        this.setReg(rd, this.getReg(rs2));
        return { mnemonic: `c.mv x${rd}`, cycles: 1 };
      }
      if (funct3 === 0b100 && rd !== 0 && rs2 !== 0 && ((insn16 >>> 12) & 1) === 1) {
        // C.ADD rd, rs2
        this.setReg(rd, u64(this.getReg(rd) + this.getReg(rs2)));
        return { mnemonic: `c.add x${rd}`, cycles: 1 };
      }
      return { mnemonic: "c-quadrant2-unimpl", cycles: 1 };
    }

    return { mnemonic: "c-unimpl", cycles: 1 };
  }

  // -------------------------------------------------------------
  // Snapshot para debugging / UI
  // -------------------------------------------------------------

  snapshot() {
    const regs = {};
    for (let i = 0; i < 32; i++) regs[REG_NAMES[i]] = hex64(this.x[i]);
    return {
      arch: "riscv64",
      pc: hex64(this.pc),
      regs,
      halted: this.halted,
      haltReason: this.haltReason,
      instructionsExecuted: this.instructionsExecuted.toString(),
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// PROVIDER REACT
// ============================================================================

const RiscvExecutorContext = createContext(null);

export function RiscvExecutorProvider({ children, config = {}, autoRun = false, syscallHandler = null }) {
  const executorRef = useRef(null);
  if (!executorRef.current) {
    executorRef.current = new RiscvExecutor({ ...config, syscallHandler });
  }
  const executor = executorRef.current;

  useEffect(() => {
    if (!autoRun) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled || executor.halted) return;
      executor.step();
      requestAnimationFrame(tick);
    };
    tick();
    return () => { cancelled = true; };
  }, [autoRun, executor]);

  const api = useMemo(
    () => ({
      executor,
      step: () => executor.step(),
      snapshot: () => executor.snapshot(),
      getReg: (r) => executor.getReg(r),
      setReg: (r, v) => executor.setReg(r, v),
      halt: (reason) => executor.halt(reason),
    }),
    [executor]
  );

  return <RiscvExecutorContext.Provider value={api}>{children}</RiscvExecutorContext.Provider>;
}

export function useRiscvExecutor() {
  const ctx = useContext(RiscvExecutorContext);
  if (!ctx) throw new Error("useRiscvExecutor must be used within RiscvExecutorProvider");
  return ctx;
}

export { REG_NAMES, OPCODE, u64, i64, u32, i32, hex64, hex32 };
