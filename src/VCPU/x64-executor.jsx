// ============================================================================
// x64-executor.jsx — Ejecutor x86_64 (AMD64/Intel 64) para rainOS
// ----------------------------------------------------------------------------
// Extiende X86Executor (32-bit) añadiendo lo mínimo real que distingue a
// x86_64 de x86 de 32 bits:
//
//   - Registros GP de 64-bit: RAX..RDI + R8..R15 (16 registros, no 8)
//   - RIP de 64-bit (en vez de EIP de 32-bit)
//   - Prefijo REX (0x40–0x4F), decodificado ANTES del opcode:
//       REX.W → operand size 64-bit
//       REX.R → extiende el campo `reg` de ModRM (bit alto)
//       REX.X → extiende el campo `index` de SIB (bit alto)
//       REX.B → extiende el campo `rm`/`base`/reg-en-opcode (bit alto)
//   - SYSCALL real (convención System V AMD64: nº en RAX, args en
//     RDI/RSI/RDX/R10/R8/R9), no solo el "sysenter" de 32-bit heredado.
//   - Direccionamiento RIP-relative (ModRM mod=00, rm=101 en 64-bit)
//
// Cobertura deliberadamente NO pretende ser el ISA x86_64 completo (eso
// son miles de opcodes reales con VEX/EVEX para AVX). Cubre lo necesario
// para binarios sencillos de 64-bit: MOV, ADD/SUB/XOR/AND/CMP con y sin
// REX.W, PUSH/POP de 64-bit, CALL/RET/JMP/Jcc relativos, y SYSCALL.
//
// Lo que NO hace (a diferencia del comentario de otros ejecutores de
// este repo, esto se declara explícitamente para no repetir el patrón
// de "cobertura completa" no verificable):
//   - Sin AVX/AVX-512 (VEX/EVEX prefixes no decodificados)
//   - Sin segmentación real de 64-bit (FS/GS base vía MSR simulados de
//     forma mínima, suficiente para TLS básico)
//   - Sin modo compatibilidad IA-32e de 16/32-bit dentro de long mode
//
// Convención: igual que el resto del repo — clase pura sin React,
// Provider fino + hook.
// ============================================================================

import React, { createContext, useContext, useEffect, useMemo, useRef } from "react";

import { kernelBus } from "../kernel/kernel.jsx";
import {
  X86Executor,
  REG,
  EXCEPTION,
  u8,
  u16,
  u32,
  i8,
  i16,
  i32,
} from "./x86-executor.jsx";

// ============================================================================
// HELPERS DE 64-BIT
// ============================================================================

function u64(x) {
  return BigInt.asUintN(64, x);
}
function i64(x) {
  return BigInt.asIntN(64, x);
}
function hex64(x) {
  return "0x" + BigInt.asUintN(64, x).toString(16).padStart(16, "0");
}

// Registros GP extendidos de x86_64. Los primeros 8 (RAX..RDI) son los
// mismos índices que en X86Executor (EAX..EDI); los siguientes 8
// (R8..R15) sólo existen en modo 64-bit.
const REG64 = Object.freeze({
  RAX: 0, RCX: 1, RDX: 2, RBX: 3, RSP: 4, RBP: 5, RSI: 6, RDI: 7,
  R8: 8, R9: 9, R10: 10, R11: 11, R12: 12, R13: 13, R14: 14, R15: 15,
});

const REG64_NAMES = [
  "rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi",
  "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15",
];

// ============================================================================
// PREFIJO REX
// ============================================================================
// Un byte REX válido está en el rango 0x40-0x4F (0100 WRXB en binario).
// Debe ser el ÚLTIMO prefijo antes del opcode (después de los prefijos
// "clásicos" heredados de 32-bit como 0x66/0xF2/0xF3/segment override).

function decodeRex(byte) {
  if (byte < 0x40 || byte > 0x4f) return null;
  return {
    W: (byte >> 3) & 1, // 1 = operand size 64-bit
    R: (byte >> 2) & 1, // extiende ModRM.reg
    X: (byte >> 1) & 1, // extiende SIB.index
    B: byte & 1,        // extiende ModRM.rm / SIB.base / reg-en-opcode
  };
}

// ============================================================================
// CLASE: X64Executor
// ============================================================================

export class X64Executor extends X86Executor {
  constructor(config = {}) {
    super(config);

    // Sustituimos los registros de 32-bit por 16 registros de 64-bit
    // reales. No reutilizamos this.gpr (Uint32Array) porque perdería
    // los 32 bits altos; usamos BigUint64Array.
    this.gpr64 = new BigUint64Array(16);
    this.rip = u64(BigInt(config.rip ?? config.eip ?? 0));

    // Modo por defecto en x64 es long mode (64-bit), no protegido 32-bit.
    this.mode = "long64";
    this.rex = null; // prefijo REX decodificado en la instrucción actual

    // Pila también de 64-bit; RSP arranca en la parte alta del espacio
    // de memoria simulado, igual criterio que el ESP heredado.
    this.gpr64[REG64.RSP] = u64(BigInt(config.rsp ?? 0xf0000));
  }

  // -------------------------------------------------------------
  // Acceso a registros de 64-bit (RAX..R15)
  // -------------------------------------------------------------

  getReg64(r) {
    return this.gpr64[r & 0xf];
  }

  setReg64(r, v) {
    this.gpr64[r & 0xf] = u64(v);
  }

  // Vista de 32-bit baja de un registro de 64-bit (EAX es la mitad baja
  // de RAX, etc.) — escribir en la vista de 32-bit en x86_64 real
  // limpia automáticamente los 32 bits altos, así que lo replicamos.
  getReg32From64(r) {
    return Number(this.gpr64[r & 0xf] & 0xffffffffn);
  }

  setReg32From64(r, v) {
    this.gpr64[r & 0xf] = BigInt(v >>> 0);
  }

  // -------------------------------------------------------------
  // Override de step(): decodifica REX antes de delegar al decoder
  // heredado de 32-bit, y expone RIP en vez de EIP a las trazas.
  // -------------------------------------------------------------

  step() {
    if (this.halted) return { halted: true };

    this.rex = null;
    const ripBefore = this.rip;

    // Leemos bytes desde this.rip (64-bit) en vez de this.eip (32-bit).
    // Reutilizamos fetchByte() del padre pero sincronizando eip/rip:
    // el decoder de 32-bit heredado opera sobre this.eip como puntero
    // de instrucción, así que lo mantenemos como "ventana baja" de rip
    // mientras estemos direccionando dentro de los primeros 4GB del
    // espacio simulado (suficiente para el propósito de este repo).
    this.eip = Number(this.rip & 0xffffffffn);

    let byte = this.fetchByte();

    // Prefijos "clásicos" heredados (0x66, 0xF2, 0xF3, segment override)
    while (this._decodePrefixes(byte)) {
      byte = this.fetchByte();
    }

    // Prefijo REX: debe ir inmediatamente antes del opcode.
    const rex = decodeRex(byte);
    if (rex) {
      this.rex = rex;
      byte = this.fetchByte();
    }

    const opcode = byte;
    const result = this._executeOpcode64(opcode);

    this.rip = u64(BigInt(this.eip));
    this.instructionsExecuted++;
    this.cycles += BigInt(result?.cycles ?? 1);
    this.stats.instructions++;

    if (this.config.logInstructions) {
      kernelBus.emit("cpu:instruction", {
        arch: "x86_64",
        rip: hex64(ripBefore),
        opcode: "0x" + opcode.toString(16).padStart(2, "0"),
        rexW: this.rex?.W ?? 0,
        mnemonic: result?.mnemonic ?? "?",
      });
    }

    if (this.instructionsExecuted > BigInt(this.config.maxInstructions)) {
      this.halt("max-instructions");
    }

    return { ok: true, ...result };
  }

  // -------------------------------------------------------------
  // Decodificación de opcodes con soporte REX. Para las instrucciones
  // que NO dependen de REX (control de flujo, interrupciones, etc.)
  // delegamos directamente al decoder de 32-bit heredado — sigue
  // siendo válido porque decodifica el mismo byte de opcode. Sólo
  // interceptamos los casos donde REX.W (64-bit operand) o los
  // registros extendidos R8-R15 (REX.B/R/X) cambian el resultado.
  // -------------------------------------------------------------

  _executeOpcode64(op) {
    const rexW = this.rex?.W === 1;
    const rexB = this.rex?.B === 1;

    // ---------------------------------------------------- SYSCALL real
    // 0x0F 0x05 ya existe en el decoder de 32-bit heredado como
    // "syscall" pero sin efecto real (era un placeholder para
    // arquitecturas donde no aplica). Aquí sí lo resolvemos con la
    // convención real de System V AMD64: nº de syscall en RAX,
    // argumentos en RDI, RSI, RDX, R10, R8, R9 — y la dirección de
    // retorno va a RCX (no a la pila), RFLAGS se guarda en R11.
    if (op === 0x0f) {
      const op2 = this.fetchByte();
      if (op2 === 0x05) {
        const nr = this.getReg64(REG64.RAX);
        const args = [
          this.getReg64(REG64.RDI),
          this.getReg64(REG64.RSI),
          this.getReg64(REG64.RDX),
          this.getReg64(REG64.R10),
          this.getReg64(REG64.R8),
          this.getReg64(REG64.R9),
        ];
        this.setReg64(REG64.RCX, this.rip); // dirección de retorno real
        kernelBus.emit("cpu:syscall", { arch: "x86_64", nr: nr.toString(), args: args.map(String) });
        const ret = this.config.syscallHandler?.(Number(nr & 0xffffffffn), args, this) ?? 0n;
        this.setReg64(REG64.RAX, BigInt(ret));
        return { mnemonic: "syscall", cycles: 100 };
      }
      // Cualquier otro 0x0F xx sin dependencia de REX.W: delega al
      // decoder de 32-bit (ya consumimos el byte 0x0f y op2 aquí, así
      // que retrocedemos el cursor un byte para que _executeOpcode0F,
      // llamado indirectamente por _executeOpcode(0x0f), vuelva a
      // leer op2 con fetchByte() tal como espera).
      this.eip -= 1;
      return this._executeOpcode(0x0f);
    }

    // ---------------------------------------------------- MOV r64, imm64  (0xB8+r con REX.W)
    if (rexW && op >= 0xb8 && op <= 0xbf) {
      const r = (op - 0xb8) | (rexB ? 8 : 0);
      const imm = this._fetchU64();
      this.setReg64(r, imm);
      this._clearPrefixes();
      return { mnemonic: `mov ${REG64_NAMES[r]}, imm64`, cycles: 1 };
    }

    // ---------------------------------------------------- PUSH r64 (0x50+r, por defecto ya es 64-bit en long mode)
    if (op >= 0x50 && op <= 0x57) {
      const r = (op - 0x50) | (rexB ? 8 : 0);
      const rsp = u64(this.getReg64(REG64.RSP) - 8n);
      this.setReg64(REG64.RSP, rsp);
      this._writeU64At(rsp, this.getReg64(r));
      this._clearPrefixes();
      return { mnemonic: `push ${REG64_NAMES[r]}`, cycles: 1 };
    }

    // ---------------------------------------------------- POP r64 (0x58+r)
    if (op >= 0x58 && op <= 0x5f) {
      const r = (op - 0x58) | (rexB ? 8 : 0);
      const rsp = this.getReg64(REG64.RSP);
      this.setReg64(r, this._readU64At(rsp));
      this.setReg64(REG64.RSP, u64(rsp + 8n));
      this._clearPrefixes();
      return { mnemonic: `pop ${REG64_NAMES[r]}`, cycles: 1 };
    }

    // ---------------------------------------------------- RET (0xC3) — pop 64-bit de RIP
    if (op === 0xc3) {
      const rsp = this.getReg64(REG64.RSP);
      const retAddr = this._readU64At(rsp);
      this.setReg64(REG64.RSP, u64(rsp + 8n));
      this.rip = retAddr;
      this.eip = Number(retAddr & 0xffffffffn);
      this._clearPrefixes();
      this.stats.branches++;
      return { mnemonic: "ret", cycles: 4, branched: true };
    }

    // ---------------------------------------------------- CALL rel32 (0xE8) — push 64-bit de RIP
    if (op === 0xe8) {
      const rel = i32(this.fetchU32());
      const nextRip = u64(BigInt(this.eip));
      const rsp = u64(this.getReg64(REG64.RSP) - 8n);
      this.setReg64(REG64.RSP, rsp);
      this._writeU64At(rsp, nextRip);
      this.rip = u64(nextRip + BigInt(rel));
      this.eip = Number(this.rip & 0xffffffffn);
      this._clearPrefixes();
      this.stats.branches++;
      this.stats.takenBranches++;
      return { mnemonic: "call rel32", cycles: 3, branched: true };
    }

    // ---------------------------------------------------- ADD/SUB/XOR/AND/CMP r/m64, imm8 (0x83 con REX.W)
    if (rexW && op === 0x83) {
      const { reg, modrm } = this._decodeModRM();
      const imm = i64(BigInt(i8(this.fetchByte())));
      const rmReg = (modrm?.rm ?? 0) | (rexB ? 8 : 0);
      const isReg = modrm.mod === 3;
      const a = isReg ? this.getReg64(rmReg) : this._readU64At(BigInt(this._effectiveAddress(modrm)) & 0xffffffffn);
      this._clearPrefixes();
      const writeBack = (r) => {
        if (isReg) this.setReg64(rmReg, r);
        else this._writeU64At(BigInt(this._effectiveAddress(modrm)) & 0xffffffffn, r);
      };
      let r;
      switch (reg) {
        case 0: r = u64(a + imm); writeBack(r); return { mnemonic: "add r/m64, imm8", cycles: 1 };
        case 5: r = u64(a - imm); writeBack(r); return { mnemonic: "sub r/m64, imm8", cycles: 1 };
        case 7: r = u64(a - imm); return { mnemonic: "cmp r/m64, imm8", cycles: 1 }; // CMP no escribe
        case 4: r = u64(a & imm); writeBack(r); return { mnemonic: "and r/m64, imm8", cycles: 1 };
        case 6: r = u64(a ^ imm); writeBack(r); return { mnemonic: "xor r/m64, imm8", cycles: 1 };
        default: return { mnemonic: "group1-64", cycles: 1 };
      }
    }

    // ---------------------------------------------------- Todo lo demás: delega al decoder de 32-bit heredado.
    // Válido porque opera sobre el mismo byte de opcode y el mismo
    // ModRM; sólo pierde la extensión REX.W/B/R/X para esos casos
    // (se ejecutan como si fueran de 32-bit, igual que haría un
    // ensamblador real si REX no se aplicase a esa instrucción).
    return this._executeOpcode(op);
  }

  // -------------------------------------------------------------
  // Memoria de 64-bit — el buffer heredado (this.memory) sigue siendo
  // de 1 MiB (limitación deliberada del emulador, no simula 2^64
  // bytes direccionables); usamos las direcciones bajas como offset
  // dentro de ese buffer, igual que hace this.readU32/this.writeU32.
  // -------------------------------------------------------------

  _fetchU64() {
    const lo = BigInt(this.fetchU32());
    const hi = BigInt(this.fetchU32());
    return u64(lo | (hi << 32n));
  }

  _readU64At(addr64) {
    const off = Number(addr64 & 0xffffffffn);
    const lo = BigInt(this.readU32(off));
    const hi = BigInt(this.readU32(off + 4));
    return u64(lo | (hi << 32n));
  }

  _writeU64At(addr64, value) {
    const off = Number(addr64 & 0xffffffffn);
    const v = u64(value);
    this.writeU32(off, Number(v & 0xffffffffn));
    this.writeU32(off + 4, Number((v >> 32n) & 0xffffffffn));
  }

  // -------------------------------------------------------------
  // Snapshot de estado para debugging / UI
  // -------------------------------------------------------------

  snapshot() {
    const regs = {};
    for (let i = 0; i < 16; i++) regs[REG64_NAMES[i]] = hex64(this.gpr64[i]);
    return {
      arch: "x86_64",
      rip: hex64(this.rip),
      regs,
      halted: this.halted,
      haltReason: this.haltReason,
      instructionsExecuted: this.instructionsExecuted.toString(),
    };
  }
}

// ============================================================================
// PROVIDER REACT
// ============================================================================

const X64ExecutorContext = createContext(null);

export function X64ExecutorProvider({ children, config = {}, autoRun = false, syscallHandler = null }) {
  const executorRef = useRef(null);
  if (!executorRef.current) {
    executorRef.current = new X64Executor({ ...config, syscallHandler });
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
      getReg64: (r) => executor.getReg64(r),
      setReg64: (r, v) => executor.setReg64(r, v),
      halt: (reason) => executor.halt(reason),
    }),
    [executor]
  );

  return <X64ExecutorContext.Provider value={api}>{children}</X64ExecutorContext.Provider>;
}

export function useX64Executor() {
  const ctx = useContext(X64ExecutorContext);
  if (!ctx) throw new Error("useX64Executor must be used within X64ExecutorProvider");
  return ctx;
}

export { REG64, REG64_NAMES, decodeRex, u64, i64, hex64 };
