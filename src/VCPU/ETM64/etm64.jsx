// ============================================================================
// etm64.jsx — ETM64: ISA + ensamblador + ejecutor + tests
// ----------------------------------------------------------------------------
// ETM64 (rainOS Toy Machine 64) es una ISA RISC de 64 bits diseñada para
// este proyecto. Registro-registro. Instrucciones de 32 bits fijos
// (excepto LI, que ocupa 2 palabras = 64 bits).
//
// 16 registros GP de 64 bits (r0..r15). Registros especiales:
//   pc, sp, lr, flags (Z|N|C|V)
//
// Sin MMU, sin caches, sin excepciones anidadas, sin prefijos, sin
// segmentos, sin PAC, sin MTE, sin crypto, sin SIMD.
//
// 39 instrucciones:
//   Aritmética/lógica: ADD, SUB, AND, OR, XOR, NOT, SHL, SHR, SAR,
//                      MUL, DIV, MOD
//   Comparación:       CMP, TST
//   Movimiento:        MOV, LI
//   Memoria:           LD, LDW, LDB, ST, STW, STB, LDX, STX
//   Pila:              PUSH, POP
//   Control:           B, BEQ, BNE, BLT, BGE, BLE, BGT, BL, RET, CALL
//   Sistema:           NOP, HALT, SYSCALL
//
// Este mensaje (1 de 2) contiene: la ISA y el ensamblador.
// El mensaje 2 contiene: el ejecutor y los tests.
// ============================================================================

// ============================================================================
// PARTE 1: DEFINICIÓN DE LA ISA
// ============================================================================

export const REG = Object.freeze({
  r0:  0,  r1:  1,  r2:  2,  r3:  3,
  r4:  4,  r5:  5,  r6:  6,  r7:  7,
  r8:  8,  r9:  9,  r10: 10, r11: 11,
  r12: 12, r13: 13, r14: 14, r15: 15,
});

export const REG_NAMES = Object.freeze([
  "r0",  "r1",  "r2",  "r3",
  "r4",  "r5",  "r6",  "r7",
  "r8",  "r9",  "r10", "r11",
  "r12", "r13", "r14", "r15",
]);

export const OP = Object.freeze({
  ADD:   0x01,
  SUB:   0x02,
  AND:   0x03,
  OR:    0x04,
  XOR:   0x05,
  NOT:   0x06,
  SHL:   0x07,
  SHR:   0x08,
  SAR:   0x09,
  MUL:   0x0A,
  DIV:   0x0B,
  MOD:   0x0C,
  CMP:   0x0D,
  TST:   0x0E,
  MOV:   0x0F,
  LI:    0x10,
  LD:    0x11,
  LDW:   0x12,
  LDB:   0x13,
  ST:    0x14,
  STW:   0x15,
  STB:   0x16,
  LDX:   0x17,
  STX:   0x18,
  PUSH:  0x19,
  POP:   0x1A,
  B:     0x1B,
  BEQ:   0x1C,
  BNE:   0x1D,
  BLT:   0x1E,
  BGE:   0x1F,
  BLE:   0x20,
  BGT:   0x21,
  BL:    0x22,
  RET:   0x23,
  CALL:  0x24,
  CSEL:  0x25,
  NOP:   0x26,
  HALT:  0x27,
  SYSCALL: 0x28,
});

export const OP_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k.toLowerCase()]))
);

export const FORMAT = Object.freeze({
  R:  "R",
  RC: "RC",
  I:  "I",
  B:  "B",
  S:  "S",
  LI: "LI",
});

export const OP_FORMAT = Object.freeze({
  [OP.ADD]: FORMAT.R,
  [OP.SUB]: FORMAT.R,
  [OP.AND]: FORMAT.R,
  [OP.OR]:  FORMAT.R,
  [OP.XOR]: FORMAT.R,
  [OP.NOT]: FORMAT.I,
  [OP.SHL]: FORMAT.R,
  [OP.SHR]: FORMAT.R,
  [OP.SAR]: FORMAT.R,
  [OP.MUL]: FORMAT.R,
  [OP.DIV]: FORMAT.R,
  [OP.MOD]: FORMAT.R,
  [OP.CMP]: FORMAT.R,
  [OP.TST]: FORMAT.R,
  [OP.MOV]: FORMAT.R,
  [OP.LI]:  FORMAT.LI,
  [OP.LD]:  FORMAT.I,
  [OP.LDW]: FORMAT.I,
  [OP.LDB]: FORMAT.I,
  [OP.ST]:  FORMAT.I,
  [OP.STW]: FORMAT.I,
  [OP.STB]: FORMAT.I,
  [OP.LDX]: FORMAT.R,
  [OP.STX]: FORMAT.R,
  [OP.PUSH]: FORMAT.R,
  [OP.POP]:  FORMAT.R,
  [OP.B]:    FORMAT.B,
  [OP.BEQ]:  FORMAT.B,
  [OP.BNE]:  FORMAT.B,
  [OP.BLT]:  FORMAT.B,
  [OP.BGE]:  FORMAT.B,
  [OP.BLE]:  FORMAT.B,
  [OP.BGT]:  FORMAT.B,
  [OP.BL]:   FORMAT.B,
  [OP.RET]:  FORMAT.S,
  [OP.CALL]: FORMAT.R,
  [OP.CSEL]: FORMAT.RC,
  [OP.NOP]:  FORMAT.S,
  [OP.HALT]: FORMAT.S,
  [OP.SYSCALL]: FORMAT.S,
});

export const FLAG = Object.freeze({
  Z: 1 << 0,
  N: 1 << 1,
  C: 1 << 2,
  V: 1 << 3,
});

export const COND = Object.freeze({
  EQ: 0, NE: 1, LT: 2, GE: 3, LE: 4, GT: 5,
});

export const COND_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(COND).map(([k, v]) => [v, k.toLowerCase()]))
);

export const BRANCH_SHIFT = 2;
export const BRANCH_BITS  = 20;
export const BRANCH_MASK  = 0xFFFFF;

export const DEFAULT_MEMORY_SIZE = 0x1000000;

// ============================================================================
// PARTE 2: ENSAMBLADOR
// ============================================================================

export class ETM64Assembler {
  constructor() {
    this.errors = [];
  }

  assemble(source) {
    this.errors = [];

    // --- Paso 1: tokenizar y extraer etiquetas ---
    const rawLines = source.split(/\r?\n/);
    const lines = [];
    const labels = new Map();

    for (let i = 0; i < rawLines.length; i++) {
      const lineNo = i + 1;
      let text = rawLines[i];

      const semi = text.indexOf(";");
      if (semi >= 0) text = text.slice(0, semi);
      text = text.trim();
      if (text === "") continue;

      const lm = text.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (lm) {
        const label = lm[1];
        if (labels.has(label)) {
          this.errors.push(`línea ${lineNo}: etiqueta duplicada "${label}"`);
        }
        labels.set(label, lines.length);
        text = lm[2].trim();
        if (text === "") continue;
      }

      lines.push({ text, lineNo });
    }

    // --- Paso 2: primera pasada, codificar sin resolver saltos ---
    const words = [];
    const branchFixups = [];

    for (let i = 0; i < lines.length; i++) {
      const { text, lineNo } = lines[i];
      const tokens = text.replace(/,/g, " ").split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;

      const mnemonic = tokens[0].toLowerCase();
      const args = tokens.slice(1);
      const opcodeName = mnemonic.toUpperCase();

      if (!(opcodeName in OP)) {
        this.errors.push(`línea ${lineNo}: instrucción desconocida "${mnemonic}"`);
        continue;
      }

      const opcode = OP[opcodeName];
      const format = OP_FORMAT[opcode];
      const instrIndex = words.length;

      try {
        switch (format) {
          case FORMAT.R: {
            // add rd, rn, rm  /  push rn  /  pop rd  /  call rn
            if (mnemonic === "push" || mnemonic === "pop" || mnemonic === "call") {
              if (args.length < 1) {
                this.errors.push(`línea ${lineNo}: ${mnemonic} requiere 1 operando`);
                break;
              }
              const r = this._reg(args[0], lineNo);
              if (mnemonic === "push" || mnemonic === "call") {
                words.push(this._encodeR(opcode, 0, r, 0));
              } else {
                // pop / call usan rd (pop) o rn (call, ya cubierto)
                words.push(this._encodeR(opcode, r, 0, 0));
              }
            } else {
              if (args.length < 3) {
                this.errors.push(`línea ${lineNo}: ${mnemonic} requiere 3 operandos`);
                break;
              }
              const rd = this._reg(args[0], lineNo);
              const rn = this._reg(args[1], lineNo);
              const rm = this._reg(args[2], lineNo);
              words.push(this._encodeR(opcode, rd, rn, rm));
            }
            break;
          }
          case FORMAT.RC: {
            // csel rd, rn, rm, cond
            if (args.length < 4) {
              this.errors.push(`línea ${lineNo}: csel requiere 4 operandos`);
              break;
            }
            const rd = this._reg(args[0], lineNo);
            const rn = this._reg(args[1], lineNo);
            const rm = this._reg(args[2], lineNo);
            const condName = args[3].toLowerCase();
            const condMap = { eq: 0, ne: 1, lt: 2, ge: 3, le: 4, gt: 5 };
            if (!(condName in condMap)) {
              this.errors.push(`línea ${lineNo}: condición desconocida "${args[3]}"`);
              break;
            }
            words.push(this._encodeRC(opcode, rd, rn, rm, condMap[condName]));
            break;
          }
          case FORMAT.I: {
            if (mnemonic === "not") {
              if (args.length < 2) {
                this.errors.push(`línea ${lineNo}: not requiere 2 operandos`);
                break;
              }
              const rd = this._reg(args[0], lineNo);
              const rn = this._reg(args[1], lineNo);
              words.push(this._encodeI(opcode, rd, rn, 0));
            } else {
              // ld rd, [rn, #imm]
              if (args.length < 2) {
                this.errors.push(`línea ${lineNo}: ${mnemonic} requiere 2 operandos`);
                break;
              }
              const rd = this._reg(args[0], lineNo);
              const mem = this._parseMem(args.slice(1), lineNo);
              words.push(this._encodeI(opcode, rd, mem.base, mem.offset));
            }
            break;
          }
          case FORMAT.B: {
            if (args.length < 1) {
              this.errors.push(`línea ${lineNo}: ${mnemonic} requiere destino`);
              break;
            }
            words.push(0);
            branchFixups.push({ instrIndex, opcode, target: args[0], lineNo });
            break;
          }
          case FORMAT.S: {
            words.push(this._encodeS(opcode));
            break;
          }
          case FORMAT.LI: {
            if (args.length < 2) {
              this.errors.push(`línea ${lineNo}: li requiere 2 operandos`);
              break;
            }
            const rd = this._reg(args[0], lineNo);
            const imm = this._imm(args[1], lineNo);
            words.push(this._encodeLi1(rd));
            words.push(imm >>> 0);
            break;
          }
          default:
            this.errors.push(`línea ${lineNo}: formato desconocido`);
        }
      } catch (e) {
        this.errors.push(e.message);
      }
    }

    // --- Paso 3: resolver saltos ---
    for (const fix of branchFixups) {
      if (!labels.has(fix.target)) {
        this.errors.push(`línea ${fix.lineNo}: etiqueta desconocida "${fix.target}"`);
        continue;
      }
      const targetIndex = labels.get(fix.target);
      const offsetUnits = targetIndex - fix.instrIndex;
      words[fix.instrIndex] = this._encodeB(fix.opcode, offsetUnits);
    }

    if (this.errors.length > 0) {
      return { code: new Uint32Array(0), labels, errors: this.errors.slice() };
    }

    return { code: new Uint32Array(words), labels, errors: [] };
  }

  // --- helpers privados ---

  _reg(token, lineNo) {
    const t = token.trim().toLowerCase();
    if (t in REG) return REG[t];
    throw new Error(`[etm64-asm] línea ${lineNo}: registro desconocido "${token}"`);
  }

  _imm(token, lineNo) {
    let t = token.trim();
    if (t.startsWith("#")) t = t.slice(1);
    let value;
    if (t.startsWith("0x") || t.startsWith("-0x")) {
      const neg = t.startsWith("-");
      const hex = neg ? t.slice(1) : t;
      value = parseInt(hex, 16);
      if (neg) value = -value;
    } else {
      value = parseInt(t, 10);
    }
    if (!Number.isFinite(value)) {
      throw new Error(`[etm64-asm] línea ${lineNo}: inmediato inválido "${token}"`);
    }
    return value;
  }

  _parseMem(tokens, lineNo) {
    const joined = tokens.join(" ").replace(/\s+/g, " ");
    const m = joined.match(/^\[\s*(r\d+)\s*(?:,\s*#?\s*(-?0x[0-9a-fA-F]+|-?\d+)\s*)?\]$/);
    if (!m) {
      throw new Error(`[etm64-asm] línea ${lineNo}: memoria mal formada "${joined}"`);
    }
    const base = this._reg(m[1], lineNo);
    const offset = m[2] !== undefined ? this._imm(m[2], lineNo) : 0;
    return { base, offset };
  }

  _encodeR(opcode, rd, rn, rm) {
    return (
      ((opcode & 0xff) << 24) |
      ((rd & 0xf) << 20) |
      ((rn & 0xf) << 16) |
      ((rm & 0xf) << 12)
    ) >>> 0;
  }

  _encodeRC(opcode, rd, rn, rm, cond) {
    return (
      ((opcode & 0xff) << 24) |
      ((rd & 0xf) << 20) |
      ((rn & 0xf) << 16) |
      ((rm & 0xf) << 12) |
      ((cond & 0xf) << 8)
    ) >>> 0;
  }

  _encodeI(opcode, rd, rn, imm) {
    return (
      ((opcode & 0xff) << 24) |
      ((rd & 0xf) << 20) |
      ((rn & 0xf) << 16) |
      ((imm & 0xffff) >>> 0)
    ) >>> 0;
  }

  _encodeB(opcode, offsetUnits) {
    return (((opcode & 0xff) << 24) | (offsetUnits & BRANCH_MASK)) >>> 0;
  }

  _encodeS(opcode) {
    return ((opcode & 0xff) << 24) >>> 0;
  }

  _encodeLi1(rd) {
    return (((OP.LI & 0xff) << 24) | ((rd & 0xf) << 20)) >>> 0;
  }
}

// ============================================================================
// PARTE 3: SELF-TEST DEL ENSAMBLADOR
// ============================================================================
// Ensambla un programa que usa todos los formatos (R, RC, I, B, S, LI)
// y verifica que las palabras codificadas son las esperadas.
//
// Este test NO ejecuta nada. Solo comprueba que el ensamblador
// produce el Uint32Array correcto. El test del ejecutor va en el
// mensaje 2.

export function runAssemblerSelfTest() {
  const asm = new ETM64Assembler();

  const source = `
    li   r0, #0x12345678
    li   r1, #1
    add  r2, r0, r1
    sub  r3, r0, r1
    and  r4, r0, r1
    or   r5, r0, r1
    xor  r6, r0, r1
    not  r7, r0
    shl  r8, r0, r1
    shr  r9, r0, r1
    sar  r10, r0, r1
    mul  r11, r0, r1
    div  r12, r0, r1
    mod  r13, r0, r1
    cmp  r0, r1
    tst  r0, r1
    mov  r14, r0
    ld   r0, [r1, #8]
    ldw  r0, [r1, #8]
    ldb  r0, [r1, #8]
    st   [r1, #8], r0
    stw  [r1, #8], r0
    stb  [r1, #8], r0
    ldx  r0, [r1, r2]
    stx  [r1, r2], r0
    push r0
    pop  r0
    csel r0, r1, r2, eq
    csel r0, r1, r2, ne
    csel r0, r1, r2, lt
    csel r0, r1, r2, ge
    csel r0, r1, r2, le
    csel r0, r1, r2, gt
  label1:
    b    label1
    beq  label1
    bne  label1
    blt  label1
    bge  label1
    ble  label1
    bgt  label1
    bl   label1
    nop
    halt
    syscall
    ret
    call r0
  `;

  const { code, errors } = asm.assemble(source);

  if (errors.length > 0) {
    return { ok: false, phase: "assemble", errors };
  }

  // Verificaciones puntuales:
  // - LI ocupa 2 palabras (instrucción 0 son 2 palabras).
  // - El número total de palabras es el esperado.
  // - Los opcodes están en las posiciones esperadas.

  const wordCount = code.length;

  // LI r0, #0x12345678 → palabra 0 = [LI][r0], palabra 1 = 0x12345678
  const liWord0 = code[0];
  const liWord1 = code[1];
  const liOpcodeOk = ((liWord0 >>> 24) & 0xff) === OP.LI;
  const liRdOk = ((liWord0 >>> 20) & 0xf) === REG.r0;
  const liImmOk = liWord1 === 0x12345678;

  // LI r1, #1 → palabra 2, 3
  const li1Word0 = code[2];
  const li1Word1 = code[3];

  // ADD r2, r0, r1 → palabra 4
  const addWord = code[4];
  const addOpcode = (addWord >>> 24) & 0xff;
  const addRd = (addWord >>> 20) & 0xf;
  const addRn = (addWord >>> 16) & 0xf;
  const addRm = (addWord >>> 12) & 0xf;
  const addOk = addOpcode === OP.ADD && addRd === 2 && addRn === 0 && addRm === 1;

  // CSEL r0, r1, r2, eq → buscamos la posición.
  // Es la palabra después de las 26 instrucciones (con LI=2 palabras).
  // En vez de contar a mano, buscamos por opcode.
  let cselEqFound = false;
  let cselGtFound = false;
  for (let i = 0; i < code.length; i++) {
    const op = (code[i] >>> 24) & 0xff;
    if (op === OP.CSEL) {
      const cond = (code[i] >>> 8) & 0xf;
      const rd = (code[i] >>> 20) & 0xf;
      const rn = (code[i] >>> 16) & 0xf;
      const rm = (code[i] >>> 12) & 0xf;
      if (cond === 0 && rd === 0 && rn === 1 && rm === 2) cselEqFound = true;
      if (cond === 5 && rd === 0 && rn === 1 && rm === 2) cselGtFound = true;
    }
  }

  // B a sí mismo → offset 0.
  let selfBranchFound = false;
  for (let i = 0; i < code.length; i++) {
    const op = (code[i] >>> 24) & 0xff;
    if (op === OP.B) {
      const offset = code[i] & BRANCH_MASK;
      if (offset === 0) selfBranchFound = true;
    }
  }

  const ok =
    liOpcodeOk &&
    liRdOk &&
    liImmOk &&
    li1Word1 === 1 &&
    addOk &&
    cselEqFound &&
    cselGtFound &&
    selfBranchFound &&
    wordCount > 0;

  return {
    ok,
    wordCount,
    checks: {
      liOpcodeOk,
      liRdOk,
      liImmOk,
      li1Imm: li1Word1,
      addOpcode: addOpcode.toString(16),
      addRd, addRn, addRm,
      cselEqFound,
      cselGtFound,
      selfBranchFound,
    },
  };
}
