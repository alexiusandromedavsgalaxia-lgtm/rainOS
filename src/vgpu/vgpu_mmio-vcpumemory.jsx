// Registrar MMIO en la VCPU para controlar la GPU
vcpu.memory.mapMmio(0xFEE00000, 0x1000, {
  read: (offset, size) => {
    if (offset === 0) return gpu.state;
    if (offset === 4) return gpu.stats.commands;
    return 0;
  },
  write: (offset, value, size) => {
    if (offset === 0) {
      // CPU escribe un comando en la cola
      gpu.commandQueue.push({
        opcode: value,
        args: {},
      });
    }
  },
});
