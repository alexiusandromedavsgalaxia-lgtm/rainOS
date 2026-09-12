// ============================================================================
// etm64-isa.jsx — Definición de la ISA ETM64
// ----------------------------------------------------------------------------
// ETM64 (rainOS Toy Machine 64) es una ISA RISC de 64 bits diseñada para
// este proyecto. No pretende ser compatible con nada. No pretende ser
// eficiente. Pretende ser:
//
//   1. Simple de decodificar (instrucciones de tamaño fijo, 32 bits).
//   2. Simple de implementar (registro-registro, sin modos de addressing
//      complejos, sin prefijos, sin segmentos, sin excepciones anidadas).
//   3. Simple de verificar (cada instrucción tiene una semántica clara
//      y testeable de forma aislada).
//   4. Honesta (lo que no está, no está; no hay stubs que digan "esto
//      es un ADD" cuando no lo es).
//
// Este archivo SOLO contiene la definición: opcodes, registros, formato.
// No contiene lógica de ejecución ni de ensamblado. Esos van en:
//   - etm64-asm.jsx       (ensamblador de texto → Uint32Array)
//   - etm64-executor.jsx  (ejecutor del Uint32Array)
// ============================================================================

// ============================================================================
// REGISTROS
// ============================================================================
// 16 registros de propósito general (r0..r15), más cuatro registros
// especiales que NO son accesibles como operandos GP:
//
//   pc     — contador de programa (64 bits)
//   sp     — stack pointer (64 bits). Por convención, apunta al último
//            byte ocupado de la pila; PUSH decrementa, POP incrementa.
//   lr     — link register (64 bits). Guarda la dirección de retorno
//            de BL / CALL.
//   flags  — Z, N, C, V (4 bits). Se actualizan con CMP, TST, y las
//            variantes con sufijo "s" si las añadimos después.
//
// Los registros GP son de 64 bits, sin vistas de 32/16/8 bits. No hay
// "w0" ni "eax" ni nada parecido. Si necesitas los 32 bits bajos,
// enmascaras explícitamente.

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

// Registros especiales. No son índices de REG, son nombres simbólicos
// que el ensamblador reconoce y el ejecutor maneja aparte.
export const SPECIAL = Object.freeze({
  pc:    "pc",
  sp:    "sp",
  lr:    "lr",
  flags: "flags",
});

// ============================================================================
// OPCODES
// ============================================================================
// Cada instrucción de 32 bits empieza con un campo `opcode` de 8 bits
// (bits [31:24]). Estos son los valores asignados. El rango 0x00–0x7F
// está reservado para las instrucciones "core" (las 30 mínimas). El
// rango 0x80–0xFF está reservado para extensiones futuras.

export const OP = Object.freeze({
  // --- Aritmética / lógica (registro-registro) ---
  ADD:   0x01,  // rd = rn + rm
  SUB:   0x02,  // rd = rn - rm
  AND:   0x03,  // rd = rn & rm
  OR:    0x04,  // rd = rn | rm
  XOR:   0x05,  // rd = rn ^ rm
  NOT:   0x06,  // rd = ~rn          (usa rm = 0, ignorado)
  SHL:   0x07,  // rd = rn << rm     (shift amount = rm[5:0])
  SHR:   0x08,  // rd = rn >> rm     (lógico)
  SAR:   0x09,  // rd = rn >> rm     (aritmético)

  // --- Comparación (setean flags, no escriben rd) ---
  CMP:   0x0A,  // flags = rn - rm
  TST:   0x0B,  // flags = rn & rm

  // --- Movimiento ---
  MOV:   0x0C,  // rd = rn
  LI:    0x0D,  // rd = imm32        (INSTRUCCIÓN DE 2 PALABRAS, ver abajo)

  // --- Memoria ---
  LD:    0x0E,  // rd = mem64[rn + imm8]        (carga 64 bits)
  LDW:   0x0F,  // rd = zero_extend32(mem32[rn + imm8])
  LDB:   0x10,  // rd = zero_extend8 (mem8 [rn + imm8])
  ST:    0x11,  // mem64[rn + imm8] = rd        (almacena 64 bits)
  STW:   0x12,  // mem32[rn + imm8] = rd[31:0]
  STB:   0x13,  // mem8 [rn + imm8] = rd[7:0]

  // --- Control de flujo ---
  B:     0x14,  // pc += offset (offset de 20 bits, ver formato)
  BEQ:   0x15,  // si Z=1, pc += offset
  BNE:   0x16,  // si Z=0, pc += offset
  BLT:   0x17,  // si N≠V, pc += offset
  BGE:   0x18,  // si N=V, pc += offset
  BLE:   0x19,  // si Z=1 o N≠V, pc += offset
  BGT:   0x1A,  // si Z=0 y N=V, pc += offset
  BL:    0x1B,  // lr = pc + 4 ; pc += offset
  RET:   0x1C,  // pc = lr
  CALL:  0x1D,  // lr = pc + 4 ; pc = rn

  // --- Sistema ---
  NOP:   0x1E,
  HALT:  0x1F,
  SYSCALL: 0x20, // número en r0, args en r1..r5, retorno en r0
});

// Nombres legibles para trazas y debugging.
export const OP_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k.toLowerCase()]))
);

// ============================================================================
// FORMATOS DE INSTRUCCIÓN
// ============================================================================
// Hay cuatro formatos. Todos son de 32 bits (excepto LI, que son 2
// palabras = 64 bits). El campo opcode está siempre en bits [31:24].
//
// ----------------------------------------------------------------------------
// R-type (registro-registro): ADD, SUB, AND, OR, XOR, SHL, SHR, SAR, CMP, TST,
//                              MOV, CALL
// ----------------------------------------------------------------------------
//   31        24 23     20 19     16 15     12 11         0
//   +-----------+---------+---------+---------+-------------+
//   |  opcode   |   rd    |   rn    |   rm    |  (ignorado) |
//   +-----------+---------+---------+---------+-------------+
//
//   Para CMP y TST, rd se ignora.
//   Para MOV, rm se ignora.
//   Para CALL, rd se ignora y rn es el registro que contiene el destino.
//
// ----------------------------------------------------------------------------
// I-type (registro-inmediato): LD, LDW, LDB, ST, STW, STB, NOT
// ----------------------------------------------------------------------------
//   31        24 23     20 19     16 15                         0
//   +-----------+---------+---------+----------------------------+
//   |  opcode   |   rd    |   rn    |         imm8 (firmado)      |
//   +-----------+---------+---------+----------------------------+
//
//   Para ST/STW/STB, rd es el registro a almacenar y rn el registro base.
//   Para LD/LDW/LDB, rd es el registro destino y rn el registro base.
//   Para NOT, rn es el registro fuente, imm8 se ignora.
//
// ----------------------------------------------------------------------------
// B-type (branch): B, BEQ, BNE, BLT, BGE, BLE, BGT, BL
// ----------------------------------------------------------------------------
//   31        24 23                                              0
//   +-----------+-------------------------------------------------+
//   |  opcode   |         offset (20 bits, firmado)               |
//   +-----------+-------------------------------------------------+
//
//   El offset se multiplica por 4 al saltar (las instrucciones están
//   alineadas a 4 bytes). Rango: ±2 MiB.
//
// ----------------------------------------------------------------------------
// S-type (system): NOP, HALT, SYSCALL, RET
// ----------------------------------------------------------------------------
//   31        24 23                                              0
//   +-----------+-------------------------------------------------+
//   |  opcode   |                  (ignorado)                     |
//   +-----------+-------------------------------------------------+
//
// ----------------------------------------------------------------------------
// LI-type (load immediate, 2 palabras = 64 bits)
// ----------------------------------------------------------------------------
//   Palabra 1 (32 bits):
//   31        24 23     20 19                                   0
//   +-----------+---------+-----------------------------------------+
//   |  opcode   |   rd    |              (ignorado)                  |
//   +-----------+---------+-----------------------------------------+
//
//   Palabra 2 (32 bits):
//   31                                                            0
//   +-------------------------------------------------------------+
//   |                     imm32 (sin signo)                        |
//   +-------------------------------------------------------------+
//
//   El ejecutor, al encontrar OP.LI, lee la palabra siguiente y la
//   usa como inmediato. El PC avanza 8 bytes en total.
// ============================================================================

export const FORMAT = Object.freeze({
  R: "R",   // registro-registro
  I: "I",   // registro-inmediato
  B: "B",   // branch
  S: "S",   // system
  LI: "LI", // load immediate (2 palabras)
});

// Tabla de qué formato usa cada opcode. El ensamblador y el ejecutor
// consultan esta tabla para saber cómo decodificar cada instrucción.
export const OP_FORMAT = Object.freeze({
  [OP.ADD]:     FORMAT.R,
  [OP.SUB]:     FORMAT.R,
  [OP.AND]:     FORMAT.R,
  [OP.OR]:      FORMAT.R,
  [OP.XOR]:     FORMAT.R,
  [OP.NOT]:     FORMAT.I,   // usa rn, ignora imm8
  [OP.SHL]:     FORMAT.R,
  [OP.SHR]:     FORMAT.R,
  [OP.SAR]:     FORMAT.R,
  [OP.CMP]:     FORMAT.R,
  [OP.TST]:     FORMAT.R,
  [OP.MOV]:     FORMAT.R,
  [OP.LI]:      FORMAT.LI,
  [OP.LD]:      FORMAT.I,
  [OP.LDW]:     FORMAT.I,
  [OP.LDB]:     FORMAT.I,
  [OP.ST]:      FORMAT.I,
  [OP.STW]:     FORMAT.I,
  [OP.STB]:     FORMAT.I,
  [OP.B]:       FORMAT.B,
  [OP.BEQ]:     FORMAT.B,
  [OP.BNE]:     FORMAT.B,
  [OP.BLT]:     FORMAT.B,
  [OP.BGE]:     FORMAT.B,
  [OP.BLE]:     FORMAT.B,
  [OP.BGT]:     FORMAT.B,
  [OP.BL]:      FORMAT.B,
  [OP.RET]:     FORMAT.S,
  [OP.CALL]:    FORMAT.R,   // usa rn
  [OP.NOP]:     FORMAT.S,
  [OP.HALT]:    FORMAT.S,
  [OP.SYSCALL]: FORMAT.S,
});

// ============================================================================
// FLAGS
// ============================================================================
// Los flags viven en el registro `flags`, que es un entero de 4 bits
// empaquetados así:
//
//   bit 0 — Z (zero)
//   bit 1 — N (negative)
//   bit 2 — C (carry)
//   bit 3 — V (overflow)
//
// Las comparaciones BLT/BGE/BLE/BGT usan N y V. BEQ/BNE usan Z.

export const FLAG = Object.freeze({
  Z: 1 << 0,
  N: 1 << 1,
  C: 1 << 2,
  V: 1 << 3,
});

// ============================================================================
// SALTOS: cómo se codifica el offset
// ============================================================================
// El offset en las instrucciones B-type es de 20 bits, firmado, en
// unidades de 4 bytes (instrucción). Para codificar:
//
//   offset_bytes = target_pc - current_pc
//   offset_units = offset_bytes / 4
//   campo = offset_units & 0xFFFFF    (20 bits, complemento a 2)
//
// Al ejecutar:
//
//   offset_units = sign_extend_20(campo)
//   new_pc = current_pc + offset_units * 4
//
// Rango: -524288 a +524284 bytes (±512 KiB).

export const BRANCH_SHIFT = 2;   // los offsets están en unidades de 4 bytes
export const BRANCH_BITS  = 20;  // ancho del campo offset
export const BRANCH_MASK  = 0xFFFFF;

// ============================================================================
// MEMORIA
// ============================================================================
// El espacio de direcciones es plano, sin MMU, sin segmentos, sin
// páginas. El ejecutor decide cuánta memoria simular (por defecto
// 16 MiB) y enmascara las direcciones a ese rango. No hay protección
// de lectura/escritura, no hay page faults, no hay alineación.

export const DEFAULT_MEMORY_SIZE = 0x1000000; // 16 MiB

// ============================================================================
// CONVENCIÓN DE LLAMADAS (para cuando escribamos programas de prueba)
// ============================================================================
// Aunque la ISA no lo impone, esta es la convención que usaremos:
//
//   r0        — valor de retorno / primer argumento
//   r1..r5    — argumentos 2..6
//   r6..r13   — caller-saved (el que llama los puede machacar)
//   r14, r15  — callee-saved (el llamado debe preservarlos)
//   lr        — dirección de retorno (la gestiona BL/RET)
//   sp        — stack pointer
//
// SYSCALL: número en r0, args en r1..r5, retorno en r0.

export const CALL_CONVENTION = Object.freeze({
  RETURN: "r0",
  ARGS:   ["r1", "r2", "r3", "r4", "r5"],
  CALLER_SAVED: ["r6", "r7", "r8", "r9", "r10", "r11", "r12", "r13"],
  CALLEE_SAVED: ["r14", "r15"],
});

// ============================================================================
// EXPORTS
// ============================================================================
// Todo lo demás (ensamblador, ejecutor) importa de aquí.

export default {
  REG, REG_NAMES, SPECIAL,
  OP, OP_NAMES, OP_FORMAT,
  FORMAT,
  FLAG,
  BRANCH_SHIFT, BRANCH_BITS, BRANCH_MASK,
  DEFAULT_MEMORY_SIZE,
  CALL_CONVENTION,
};
