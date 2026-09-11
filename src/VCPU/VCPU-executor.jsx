const vcpu = useVcpu();

// Programa máquina: incrementa RAX 10 veces y hace HLT
const program = new Uint8Array([
  // MOVI RAX, 0
  OPCODE.MOVI, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  // ADDI RAX, 1
  OPCODE.ADDI, 0, 1, 0, 0, 0, 0, 0, 0, 0,
  // CMPI RAX, 10
  OPCODE.CMPI, 0, 10, 0, 0, 0, 0, 0, 0, 0,
  // JNE -18
  OPCODE.JNE, 0, 0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  // HLT
  OPCODE.HLT,
]);

vcpu.load(program, 0x1000);
vcpu.run(10000);

const result = vcpu.readRegister("RAX"); // → 10n
