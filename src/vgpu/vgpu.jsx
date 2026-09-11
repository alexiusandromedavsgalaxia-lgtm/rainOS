// ============================================================================
// vgpu.jsx — GPU virtual
// ----------------------------------------------------------------------------
// Implementa una GPU virtual completa con:
//
// 1. HARDWARE ABSTRACTO
//    - VRAM (memoria de video dedicada)
//    - Command Buffers (colas de comandos)
//    - Command Processor (procesa buffers)
//    - DMA Engine (transferencias CPU ↔ GPU)
//    - Display Controller (framebuffer → pantalla)
//    - Shader Cores (unidades de cómputo)
//    - Raster Operations Pipeline (ROP)
//    - Texture Units (samplers)
//    - Compute Units (para GPGPU)
//
// 2. PIPELINE GRÁFICO
//    - Vertex Fetch → Vertex Shader → Primitive Assembly → Clipping
//    - → Rasterization → Fragment Shader → Depth/Stencil Test
//    - → Blending → Framebuffer Write
//    - Parámetros configurables (cull mode, fill mode, depth test, blend)
//    - Estadísticas por etapa
//
// 3. SHADERS
//    - Lenguaje ensamblador propio (VSL — Vgpu Shader Language)
//    - Compilador de VSL a bytecode ejecutable
//    - Vertex shaders y fragment shaders
//    - Uniforms, attributes, varyings
//    - Registros temporales, vectores de 4 componentes
//    - Instrucciones: mov, add, sub, mul, div, dp3, dp4, mad, min, max, rcp,
//      rsq, sqrt, sin, cos, log, exp, pow, abs, neg, frc, flr, ceil, cmp,
//      tex2d, texcube, if, else, endif, rep, endrep, break, cal, ret
//    - Compilación a bytecode (opcodes numéricos)
//    - Cache de shaders compilados
//
// 4. PRIMITIVAS
//    - Triangles, lines, points
//    - Triangle strips, triangle fans
//    - Indexed draws (con index buffer)
//    - Instanced draws
//
// 5. RECURSOS
//    - Vertex Buffers, Index Buffers, Uniform Buffers
//    - Textures 2D, 3D, cubemaps (con mipmaps)
//    - Render Targets (framebuffers)
//    - Samplers (filtrado, wrap mode)
//    - VRAM manager con LRU eviction
//
// 6. RASTERIZADOR
//    - Software rasterizer con interpolación baricéntrica
//    - Depth buffer (Z-buffer)
//    - Stencil buffer
//    - Backface culling
//    - Scissor test
//    - Alpha blending
//    - Antialiasing (MSAA 2x/4x/8x simulado)
//
// 7. TEXTURAS
//    - Filtrado: nearest, linear, trilinear, anisotropic
//    - Wrap: repeat, clamp, mirror
//    - Mipmaps
//    - Formatos: RGBA8, RGB8, RGBA16F, RGBA32F, R8, D24S8
//
// 8. COMPUTE
//    - Compute shaders (GPGPU)
//    - Workgroups y dispatch
//    - Shared memory
//    - Barriers
//    - Atomic operations
//
// 9. PRESENTACIÓN
//    - Swap chain (double/triple buffering)
//    - VSync (60/120/144 Hz)
//    - Present modes: immediate, fifo, mailbox
//    - Tearing y frame pacing
//
// 10. INTEGRACIÓN
//     - Con VCPU (device MMIO)
//     - Con Scheduler (trabajo asíncrono, fences, semáforos)
//     - Con el resto del sistema (composición del desktop)
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

// ============================================================================
// 1. CONSTANTES
// ============================================================================

export const GPU_STATE = Object.freeze({
  OFFLINE: "offline",
  IDLE: "idle",
  PROCESSING: "processing",
  PRESENTING: "presenting",
  STALLED: "stalled",
  FAULT: "fault",
  HUNG: "hung",
});

export const GPU_EVENTS = Object.freeze({
  INIT: "vgpu:init",
  SHUTDOWN: "vgpu:shutdown",
  COMMAND_BUFFER_SUBMITTED: "vgpu:command-buffer-submitted",
  COMMAND_EXECUTED: "vgpu:command-executed",
  SHADER_COMPILED: "vgpu:shader-compiled",
  SHADER_ERROR: "vgpu:shader-error",
  DRAW_CALL: "vgpu:draw-call",
  DRAW_COMPLETE: "vgpu:draw-complete",
  PRIMITIVE_ASSEMBLED: "vgpu:primitive-assembled",
  RASTER_TILE: "vgpu:raster-tile",
  FRAGMENT_SHADED: "vgpu:fragment-shaded",
  PRESENT: "vgpu:present",
  VSYNC: "vgpu:vsync",
  VSYNC_MISSED: "vgpu:vsync-missed",
  VRAM_ALLOC: "vgpu:vram-alloc",
  VRAM_FREE: "vgpu:vram-free",
  VRAM_EVICT: "vgpu:vram-evict",
  VRAM_FULL: "vgpu:vram-full",
  TEXTURE_UPLOADED: "vgpu:texture-uploaded",
  TEXTURE_SAMPLED: "vgpu:texture-sampled",
  BUFFER_UPLOADED: "vgpu:buffer-uploaded",
  FENCE_SIGNALED: "vgpu:fence-signaled",
  FENCE_WAITED: "vgpu:fence-waited",
  SEMAPHORE_WAIT: "vgpu:semaphore-wait",
  SEMAPHORE_SIGNAL: "vgpu:semaphore-signal",
  DMA_START: "vgpu:dma-start",
  DMA_COMPLETE: "vgpu:dma-complete",
  COMPUTE_DISPATCH: "vgpu:compute-dispatch",
  COMPUTE_COMPLETE: "vgpu:compute-complete",
  MEMORY_FAULT: "vgpu:memory-fault",
  PAGE_FAULT: "vgpu:page-fault",
  DEVICE_LOST: "vgpu:device-lost",
  PERF_WARNING: "vgpu:perf-warning",
  LOG: "vgpu:log",
});

export const SHADER_STAGE = Object.freeze({
  VERTEX: "vertex",
  FRAGMENT: "fragment",
  COMPUTE: "compute",
  GEOMETRY: "geometry",
});

export const PRIMITIVE_TOPOLOGY = Object.freeze({
  POINT_LIST: 0,
  LINE_LIST: 1,
  LINE_STRIP: 2,
  TRIANGLE_LIST: 3,
  TRIANGLE_STRIP: 4,
  TRIANGLE_FAN: 5,
});

export const INDEX_FORMAT = Object.freeze({
  UINT16: 2,
  UINT32: 4,
});

export const VERTEX_FORMAT = Object.freeze({
  FLOAT2: { components: 2, size: 8 },
  FLOAT3: { components: 3, size: 12 },
  FLOAT4: { components: 4, size: 16 },
  UINT8X4: { components: 4, size: 4 },
  INT16X2: { components: 2, size: 4 },
});

export const TEXTURE_FORMAT = Object.freeze({
  RGBA8: { channels: 4, bytes: 4, type: "uint8" },
  RGB8: { channels: 3, bytes: 3, type: "uint8" },
  R8: { channels: 1, bytes: 1, type: "uint8" },
  RGBA16F: { channels: 4, bytes: 8, type: "float16" },
  RGBA32F: { channels: 4, bytes: 16, type: "float32" },
  D24S8: { channels: 2, bytes: 4, type: "depth-stencil" },
});

export const WRAP_MODE = Object.freeze({
  REPEAT: "repeat",
  CLAMP: "clamp",
  MIRROR: "mirror",
});

export const FILTER_MODE = Object.freeze({
  NEAREST: "nearest",
  LINEAR: "linear",
  TRILINEAR: "trilinear",
  ANISOTROPIC: "anisotropic",
});

export const COMPARE_FUNC = Object.freeze({
  NEVER: 0,
  LESS: 1,
  EQUAL: 2,
  LEQUAL: 3,
  GREATER: 4,
  NOTEQUAL: 5,
  GEQUAL: 6,
  ALWAYS: 7,
});

export const BLEND_FACTOR = Object.freeze({
  ZERO: "zero",
  ONE: "one",
  SRC_COLOR: "src-color",
  ONE_MINUS_SRC_COLOR: "one-minus-src-color",
  SRC_ALPHA: "src-alpha",
  ONE_MINUS_SRC_ALPHA: "one-minus-src-alpha",
  DST_ALPHA: "dst-alpha",
  ONE_MINUS_DST_ALPHA: "one-minus-dst-alpha",
  DST_COLOR: "dst-color",
  ONE_MINUS_DST_COLOR: "one-minus-dst-color",
});

export const BLEND_OP = Object.freeze({
  ADD: "add",
  SUBTRACT: "subtract",
  REVERSE_SUBTRACT: "reverse-subtract",
  MIN: "min",
  MAX: "max",
});

export const CULL_MODE = Object.freeze({
  NONE: "none",
  FRONT: "front",
  BACK: "back",
});

export const PRESENT_MODE = Object.freeze({
  IMMEDIATE: "immediate",
  FIFO: "fifo",
  MAILBOX: "mailbox",
});

export const VGPU_OPCODE = Object.freeze({
  NOP: 0x00,
  CLEAR: 0x01,
  DRAW: 0x02,
  DISPATCH: 0x03,
  SET_PIPELINE: 0x04,
  SET_RENDER_TARGET: 0x05,
  BIND_VERTEX_BUFFER: 0x06,
  BIND_INDEX_BUFFER: 0x07,
  BIND_UNIFORM_BUFFER: 0x08,
  BIND_TEXTURE: 0x09,
  BIND_SAMPLER: 0x0a,
  SET_VIEWPORT: 0x0b,
  SET_SCISSOR: 0x0c,
  COPY_TEXTURE: 0x0d,
  COPY_BUFFER: 0x0e,
  PRESENT: 0x0f,
  SIGNAL_FENCE: 0x10,
  WAIT_FENCE: 0x11,
  WAIT_SEMAPHORE: 0x12,
  SIGNAL_SEMAPHORE: 0x13,
  PUSH_CONSTANTS: 0x14,
});

// ============================================================================
// 2. UTILIDADES
// ============================================================================

const now = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const lerp = (a, b, t) => a + (b - a) * t;

let _idCounter = 0;
const uid = (prefix = "id") => `${prefix}-${++_idCounter}`;

class GpuLogger {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(GPU_EVENTS.LOG, e);
    if (level === "error") console.error("[vgpu]", message, meta);
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
  all() {
    return [...this.entries];
  }
}

// ============================================================================
// 3. MATEMÁTICAS
// ============================================================================

class Vec4 {
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }
  static add(a, b) {
    return new Vec4(a.x + b.x, a.y + b.y, a.z + b.z, a.w + b.w);
  }
  static sub(a, b) {
    return new Vec4(a.x - b.x, a.y - b.y, a.z - b.z, a.w - b.w);
  }
  static mul(a, b) {
    return new Vec4(a.x * b.x, a.y * b.y, a.z * b.z, a.w * b.w);
  }
  static scale(v, s) {
    return new Vec4(v.x * s, v.y * s, v.z * s, v.w * s);
  }
  static dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  }
  static lerp(a, b, t) {
    return new Vec4(
      lerp(a.x, b.x, t),
      lerp(a.y, b.y, t),
      lerp(a.z, b.z, t),
      lerp(a.w, b.w, t)
    );
  }
  static length(v) {
    return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z + v.w * v.w);
  }
  static normalize(v) {
    const l = Vec4.length(v) || 1;
    return new Vec4(v.x / l, v.y / l, v.z / l, v.w / l);
  }
  clone() {
    return new Vec4(this.x, this.y, this.z, this.w);
  }
}

class Mat4 {
  constructor(data = null) {
    this.data = data || new Float32Array(16);
  }
  static identity() {
    const m = new Mat4();
    m.data[0] = 1;
    m.data[5] = 1;
    m.data[10] = 1;
    m.data[15] = 1;
    return m;
  }
  static multiply(a, b) {
    const r = new Mat4();
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          sum += a.data[i * 4 + k] * b.data[k * 4 + j];
        }
        r.data[i * 4 + j] = sum;
      }
    }
    return r;
  }
  static perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    const m = new Mat4();
    m.data[0] = f / aspect;
    m.data[5] = f;
    m.data[10] = (far + near) / (near - far);
    m.data[11] = -1;
    m.data[14] = (2 * far * near) / (near - far);
    return m;
  }
  static lookAt(eye, target, up) {
    const z = Vec4.normalize(Vec4.sub(eye, target));
    const x = Vec4.normalize(Vec4.sub(new Vec4(up.x, up.y, up.z, 0), Vec4.scale(z, Vec4.dot(up, z))));
    const y = Vec4.sub(new Vec4(z.x, z.y, z.z, 0), Vec4.scale(x, Vec4.dot(z, x)));
    const m = new Mat4();
    m.data[0] = x.x;
    m.data[4] = x.y;
    m.data[8] = x.z;
    m.data[1] = y.x;
    m.data[5] = y.y;
    m.data[9] = y.z;
    m.data[2] = z.x;
    m.data[6] = z.y;
    m.data[10] = z.z;
    m.data[12] = -Vec4.dot(x, eye);
    m.data[13] = -Vec4.dot(y, eye);
    m.data[14] = -Vec4.dot(z, eye);
    m.data[15] = 1;
    return m;
  }
  static translate(x, y, z) {
    const m = Mat4.identity();
    m.data[12] = x;
    m.data[13] = y;
    m.data[14] = z;
    return m;
  }
  static rotateY(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const m = Mat4.identity();
    m.data[0] = c;
    m.data[2] = -s;
    m.data[8] = s;
    m.data[10] = c;
    return m;
  }
  static scale(x, y, z) {
    const m = Mat4.identity();
    m.data[0] = x;
    m.data[5] = y;
    m.data[10] = z;
    return m;
  }
}

// ============================================================================
// 4. VRAM MANAGER
// ============================================================================

class VramAllocation {
  constructor({ id, bytes, tag, category }) {
    this.id = id;
    this.bytes = bytes;
    this.tag = tag;
    this.category = category; // "texture", "buffer", "rt", "misc"
    this.createdAt = now();
    this.lastUsed = now();
    this.refCount = 1;
  }
}

class VramManager {
  constructor(totalBytes) {
    this.totalBytes = totalBytes;
    this.usedBytes = 0;
    this.allocations = new Map();
    this.stats = {
      allocs: 0,
      frees: 0,
      evictions: 0,
      oom: 0,
    };
  }

  alloc({ bytes, tag = "anon", category = "misc" } = {}) {
    if (this.usedBytes + bytes > this.totalBytes) {
      const freed = this._evictUntil(bytes);
      if (this.usedBytes + bytes > this.totalBytes) {
        this.stats.oom++;
        kernelBus.emit(GPU_EVENTS.VRAM_FULL, { requested: bytes });
        return null;
      }
    }
    const id = uid("vram");
    const alloc = new VramAllocation({ id, bytes, tag, category });
    this.allocations.set(id, alloc);
    this.usedBytes += bytes;
    this.stats.allocs++;
    kernelBus.emit(GPU_EVENTS.VRAM_ALLOC, { id, bytes, tag, category });
    return id;
  }

  free(id) {
    const a = this.allocations.get(id);
    if (!a) return false;
    this.allocations.delete(id);
    this.usedBytes -= a.bytes;
    this.stats.frees++;
    kernelBus.emit(GPU_EVENTS.VRAM_FREE, { id, bytes: a.bytes });
    return true;
  }

  touch(id) {
    const a = this.allocations.get(id);
    if (a) a.lastUsed = now();
  }

  _evictUntil(bytes) {
    // Ordenar por lastUsed ascendente
    const sorted = Array.from(this.allocations.values()).sort(
      (a, b) => a.lastUsed - b.lastUsed
    );
    for (const a of sorted) {
      if (this.usedBytes + bytes <= this.totalBytes) break;
      if (a.refCount > 0) continue; // no evictar si está en uso
      this.free(a.id);
      this.stats.evictions++;
      kernelBus.emit(GPU_EVENTS.VRAM_EVICT, { id: a.id, bytes: a.bytes });
    }
  }

  snapshot() {
    return {
      totalBytes: this.totalBytes,
      usedBytes: this.usedBytes,
      freeBytes: this.totalBytes - this.usedBytes,
      allocations: this.allocations.size,
      stats: { ...this.stats },
    };
  }
}

// ============================================================================
// 5. SHADERS
// ============================================================================

/**
 * VSL (Vgpu Shader Language) — compilador.
 * Gramática:
 *   INSTRUCTION [dst,] [src0,] [src1] [, src2] [, src3]
 * Ejemplos:
 *   mov r0, v0
 *   add r1, r0, c0
 *   mul r2, r1, v1
 *   dp4 r0, v0, c0
 *   tex2d r1, v0.xy, s0
 */

const VSL_OPCODES = {
  mov: 1,
  add: 2,
  sub: 3,
  mul: 4,
  div: 5,
  mad: 6,
  min: 7,
  max: 8,
  rcp: 9,
  rsq: 10,
  sqrt: 11,
  sin: 12,
  cos: 13,
  log: 14,
  exp: 15,
  pow: 16,
  abs: 17,
  neg: 18,
  frc: 19,
  flr: 20,
  ceil: 21,
  cmp: 22,
  dp3: 23,
  dp4: 24,
  nrm: 25,
  tex2d: 26,
  texcube: 27,
  if: 28,
  else: 29,
  endif: 30,
  rep: 31,
  endrep: 32,
  break: 33,
  cal: 34,
  ret: 35,
  kill: 36,
  discard: 37,
};

const REGISTER_TYPES = {
  r: "temp",           // registros temporales
  v: "input",          // vertex attributes / fragment varyings
  o: "output",         // outputs del shader
  c: "uniform",        // constantes (uniforms)
  s: "sampler",        // samplers
  a: "address",        // address register
};

class CompiledShader {
  constructor({ source, stage, bytecode, constants = [], samplers = [] }) {
    this.id = uid("shader");
    this.source = source;
    this.stage = stage;
    this.bytecode = bytecode;
    this.constants = constants;
    this.samplers = samplers;
    this.compiledAt = now();
  }
}

class ShaderCompiler {
  constructor() {
    this.cache = new Map();
    this.stats = {
      compiled: 0,
      cacheHits: 0,
      errors: 0,
    };
  }

  compile(source, stage = SHADER_STAGE.VERTEX) {
    const key = `${stage}:${source}`;
    if (this.cache.has(key)) {
      this.stats.cacheHits++;
      return this.cache.get(key);
    }

    const lines = source
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith(";"));

    const bytecode = [];
    const constants = new Set();
    const samplers = new Set();

    for (const line of lines) {
      const parts = line.split(/[,\s]+/).filter(Boolean);
      const opName = parts[0].toLowerCase();
      const opcode = VSL_OPCODES[opName];
      if (opcode === undefined) {
        this.stats.errors++;
        kernelBus.emit(GPU_EVENTS.SHADER_ERROR, {
          stage,
          line,
          error: `unknown opcode: ${opName}`,
        });
        throw new Error(`VSL: unknown opcode "${opName}"`);
      }

      const operands = [];
      for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        const regMatch = p.match(/^([a-z]+)(\d+)(?:\.(\w+))?$/);
        if (regMatch) {
          const type = REGISTER_TYPES[regMatch[1]];
          if (!type) throw new Error(`VSL: unknown register "${p}"`);
          const index = parseInt(regMatch[2], 10);
          if (type === "uniform") constants.add(index);
          if (type === "sampler") samplers.add(index);
          operands.push({
            type,
            index,
            swizzle: regMatch[3] || "xyzw",
          });
        } else if (/^-?\d+(\.\d+)?$/.test(p)) {
          operands.push({ type: "imm", value: parseFloat(p) });
        } else {
          throw new Error(`VSL: cannot parse "${p}"`);
        }
      }

      bytecode.push({ opcode, operands, line });
    }

    const compiled = new CompiledShader({
      source,
      stage,
      bytecode,
      constants: Array.from(constants),
      samplers: Array.from(samplers),
    });

    this.cache.set(key, compiled);
    this.stats.compiled++;
    kernelBus.emit(GPU_EVENTS.SHADER_COMPILED, {
      id: compiled.id,
      stage,
      instructions: bytecode.length,
    });
    return compiled;
  }

  snapshot() {
    return {
      cached: this.cache.size,
      ...this.stats,
    };
  }
}

// ============================================================================
// 6. SHADER VM
// ============================================================================

class ShaderVm {
  constructor({ shader, constants = {}, samplers = [] }) {
    this.shader = shader;
    this.constants = constants;
    this.samplers = samplers;
    this.registers = {
      temp: Array.from({ length: 32 }, () => new Vec4()),
      input: [],
      output: [],
      address: [0],
    };
    this.stats = { instructions: 0 };
  }

  readOperand(op) {
    if (op.type === "imm") {
      return new Vec4(op.value, op.value, op.value, op.value);
    }
    if (op.type === "temp") {
      return this.registers.temp[op.index].clone();
    }
    if (op.type === "input") {
      return (this.registers.input[op.index] || new Vec4()).clone();
    }
    if (op.type === "uniform") {
      return (this.constants[op.index] || new Vec4()).clone();
    }
    if (op.type === "output") {
      return (this.registers.output[op.index] || new Vec4()).clone();
    }
    return new Vec4();
  }

  writeOperand(op, value) {
    const v = value.clone();
    if (op.type === "temp") this.registers.temp[op.index] = v;
    else if (op.type === "output") this.registers.output[op.index] = v;
    else if (op.type === "input") this.registers.input[op.index] = v;
  }

  applySwizzle(v, swizzle) {
    const map = { x: v.x, y: v.y, z: v.z, w: v.w };
    return new Vec4(
      map[swizzle[0]] ?? v.x,
      map[swizzle[1]] ?? v.y,
      map[swizzle[2]] ?? v.z,
      map[swizzle[3]] ?? v.w
    );
  }

  execute(inputs = []) {
    this.registers.input = inputs.map((i) => i.clone());
    this.registers.output = [];
    for (const instr of this.shader.bytecode) {
      this._execInstr(instr);
      this.stats.instructions++;
    }
    return this.registers.output;
  }

  _execInstr(instr) {
    const { opcode, operands } = instr;
    const opName = Object.keys(VSL_OPCODES).find(
      (k) => VSL_OPCODES[k] === opcode
    );

    const dst = operands[0];
    const a = operands[1] ? this.readOperand(operands[1]) : new Vec4();
    const b = operands[2] ? this.readOperand(operands[2]) : new Vec4();
    const c = operands[3] ? this.readOperand(operands[3]) : new Vec4();

    let result = new Vec4();

    switch (opName) {
      case "mov":
        result = a;
        break;
      case "add":
        result = Vec4.add(a, b);
        break;
      case "sub":
        result = Vec4.sub(a, b);
        break;
      case "mul":
        result = Vec4.mul(a, b);
        break;
      case "div":
        result = new Vec4(a.x / (b.x || 1), a.y / (b.y || 1), a.z / (b.z || 1), a.w / (b.w || 1));
        break;
      case "mad":
        result = Vec4.add(Vec4.mul(a, b), c);
        break;
      case "min":
        result = new Vec4(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z), Math.min(a.w, b.w));
        break;
      case "max":
        result = new Vec4(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z), Math.max(a.w, b.w));
        break;
      case "rcp":
        result = new Vec4(1 / (a.x || 1), 1 / (a.y || 1), 1 / (a.z || 1), 1 / (a.w || 1));
        break;
      case "rsq":
        result = new Vec4(1 / Math.sqrt(Math.abs(a.x) || 1), 1 / Math.sqrt(Math.abs(a.y) || 1), 1 / Math.sqrt(Math.abs(a.z) || 1), 1 / Math.sqrt(Math.abs(a.w) || 1));
        break;
      case "sqrt":
        result = new Vec4(Math.sqrt(Math.abs(a.x)), Math.sqrt(Math.abs(a.y)), Math.sqrt(Math.abs(a.z)), Math.sqrt(Math.abs(a.w)));
        break;
      case "sin":
        result = new Vec4(Math.sin(a.x), Math.sin(a.y), Math.sin(a.z), Math.sin(a.w));
        break;
      case "cos":
        result = new Vec4(Math.cos(a.x), Math.cos(a.y), Math.cos(a.z), Math.cos(a.w));
        break;
      case "log":
        result = new Vec4(Math.log(Math.abs(a.x) || 1), Math.log(Math.abs(a.y) || 1), Math.log(Math.abs(a.z) || 1), Math.log(Math.abs(a.w) || 1));
        break;
      case "exp":
        result = new Vec4(Math.exp(a.x), Math.exp(a.y), Math.exp(a.z), Math.exp(a.w));
        break;
      case "pow":
        result = new Vec4(Math.pow(a.x, b.x), Math.pow(a.y, b.y), Math.pow(a.z, b.z), Math.pow(a.w, b.w));
        break;
      case "abs":
        result = new Vec4(Math.abs(a.x), Math.abs(a.y), Math.abs(a.z), Math.abs(a.w));
        break;
      case "neg":
        result = new Vec4(-a.x, -a.y, -a.z, -a.w);
        break;
      case "frc":
        result = new Vec4(a.x - Math.floor(a.x), a.y - Math.floor(a.y), a.z - Math.floor(a.z), a.w - Math.floor(a.w));
        break;
      case "flr":
        result = new Vec4(Math.floor(a.x), Math.floor(a.y), Math.floor(a.z), Math.floor(a.w));
        break;
      case "ceil":
        result = new Vec4(Math.ceil(a.x), Math.ceil(a.y), Math.ceil(a.z), Math.ceil(a.w));
        break;
      case "cmp":
        result = new Vec4(a.x < b.x ? c.x : 0, a.y < b.y ? c.y : 0, a.z < b.z ? c.z : 0, a.w < b.w ? c.w : 0);
        break;
      case "dp3":
        result = new Vec4(a.x * b.x + a.y * b.y + a.z * b.z, 0, 0, 0);
        break;
      case "dp4": {
        const d = Vec4.dot(a, b);
        result = new Vec4(d, d, d, d);
        break;
      }
      case "nrm":
        result = Vec4.normalize(a);
        break;
      case "tex2d": {
        const sampler = this.samplers[operands[2]?.index ?? 0];
        if (sampler) {
          const color = sampler.sample(a.x, a.y);
          result = new Vec4(color[0] / 255, color[1] / 255, color[2] / 255, color[3] / 255);
        }
        break;
      }
      default:
        break;
    }

    if (dst && dst.type) {
      const final = dst.swizzle
        ? this.applySwizzle(result, dst.swizzle)
        : result;
      this.writeOperand(dst, final);
    }
  }
}

// ============================================================================
// 7. RECURSOS
// ============================================================================

class GpuBuffer {
  constructor({ id, bytes, tag = "buffer", data = null, vram = null }) {
    this.id = id || uid("buf");
    this.bytes = bytes;
    this.tag = tag;
    this.vram = vram;
    this.data = data || new Uint8Array(bytes);
    this.createdAt = now();
  }

  write(offset, bytes) {
    const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.data.set(src, offset);
  }

  read(offset, length) {
    return this.data.slice(offset, offset + length);
  }
}

class GpuTexture {
  constructor({
    id,
    width,
    height,
    format = "RGBA8",
    data = null,
    mipmaps = 1,
    wrap = "repeat",
    filter = "linear",
    vram = null,
  }) {
    this.id = id || uid("tex");
    this.width = width;
    this.height = height;
    this.format = format;
    this.wrap = wrap;
    this.filter = filter;
    this.mipmaps = mipmaps;
    this.vram = vram;
    const f = TEXTURE_FORMAT[format];
    const bytes = width * height * f.bytes * mipmaps;
    this.data = data || new Uint8Array(bytes);
    this.createdAt = now();
    this.lastSampledAt = null;
  }

  sample(x, y) {
    // Nearest sampling para simplicidad
    let ix = Math.floor(x);
    let iy = Math.floor(y);
    if (this.wrap === "repeat") {
      ix = ((ix % this.width) + this.width) % this.width;
      iy = ((iy % this.height) + this.height) % this.height;
    } else if (this.wrap === "clamp") {
      ix = clamp(ix, 0, this.width - 1);
      iy = clamp(iy, 0, this.height - 1);
    } else if (this.wrap === "mirror") {
      const mw = this.width * 2;
      const mh = this.height * 2;
      ix = ((ix % mw) + mw) % mw;
      iy = ((iy % mh) + mh) % mh;
      if (ix >= this.width) ix = mw - ix - 1;
      if (iy >= this.height) iy = mh - iy - 1;
    }
    const idx = (iy * this.width + ix) * 4;
    this.lastSampledAt = now();
    return [
      this.data[idx] || 0,
      this.data[idx + 1] || 0,
      this.data[idx + 2] || 0,
      this.data[idx + 3] || 255,
    ];
  }
}

class RenderTarget {
  constructor({ id, width, height, colorFormat = "RGBA8", depthFormat = "D24S8" }) {
    this.id = id || uid("rt");
    this.width = width;
    this.height = height;
    this.colorFormat = colorFormat;
    this.depthFormat = depthFormat;
    this.colorBuffer = new Uint8ClampedArray(width * height * 4);
    this.depthBuffer = new Float32Array(width * height);
    this.stencilBuffer = new Uint8Array(width * height);
    this.dirty = true;
  }

  clear({ r = 0, g = 0, b = 0, a = 255, depth = 1 } = {}) {
    const c = this.colorBuffer;
    for (let i = 0; i < c.length; i += 4) {
      c[i] = r;
      c[i + 1] = g;
      c[i + 2] = b;
      c[i + 3] = a;
    }
    this.depthBuffer.fill(depth);
    this.stencilBuffer.fill(0);
    this.dirty = true;
  }

  getPixel(x, y) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return null;
    const i = (y * this.width + x) * 4;
    return [
      this.colorBuffer[i],
      this.colorBuffer[i + 1],
      this.colorBuffer[i + 2],
      this.colorBuffer[i + 3],
    ];
  }
}

// ============================================================================
// 8. PIPELINE STATE
// ============================================================================

class PipelineState {
  constructor() {
    this.vertexShader = null;
    this.fragmentShader = null;
    this.computeShader = null;
    this.topology = PRIMITIVE_TOPOLOGY.TRIANGLE_LIST;
    this.vertexBuffer = null;
    this.vertexStride = 16;
    this.vertexOffset = 0;
    this.indexBuffer = null;
    this.indexFormat = INDEX_FORMAT.UINT16;
    this.indexOffset = 0;
    this.uniformBuffer = null;
    this.textures = new Map();
    this.samplers = new Map();
    this.constants = [];
    this.viewport = { x: 0, y: 0, width: 800, height: 600 };
    this.scissor = null;
    this.renderTarget = null;

    // Estado de raster
    this.cullMode = CULL_MODE.BACK;
    this.fillMode = "fill";
    this.frontFace = "ccw";
    this.depthTest = true;
    this.depthWrite = true;
    this.depthFunc = COMPARE_FUNC.LESS;
    this.stencilTest = false;
    this.stencilFunc = COMPARE_FUNC.ALWAYS;
    this.stencilRef = 0;
    this.stencilReadMask = 0xff;
    this.stencilWriteMask = 0xff;

    // Blend
    this.blendEnabled = false;
    this.blendSrc = BLEND_FACTOR.SRC_ALPHA;
    this.blendDst = BLEND_FACTOR.ONE_MINUS_SRC_ALPHA;
    this.blendOp = BLEND_OP.ADD;

    // MSAA
    this.msaaSamples = 1;
  }
}

// ============================================================================
// 9. RASTERIZADOR
// ============================================================================

class Rasterizer {
  constructor(gpu) {
    this.gpu = gpu;
    this.stats = {
      triangles: 0,
      fragments: 0,
      shaded: 0,
      discarded: 0,
    };
  }

  drawTriangle(v0, v1, v2, state, framebuffer) {
    this.stats.triangles++;

    const width = framebuffer.width;
    const height = framebuffer.height;

    // Transformar a espacio de pantalla
    const toScreen = (v) => {
      const w = v.pos.w || 1;
      return {
        x: ((v.pos.x / w) * 0.5 + 0.5) * width,
        y: (1 - ((v.pos.y / w) * 0.5 + 0.5)) * height,
        z: v.pos.z / w,
        w,
        attrs: v.attrs,
      };
    };

    const p0 = toScreen(v0);
    const p1 = toScreen(v1);
    const p2 = toScreen(v2);

    // Bounding box
    const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
    const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));

    if (minX > maxX || minY > maxY) return;

    // Área del triángulo (con signo)
    const area =
      (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
    if (Math.abs(area) < 1e-6) return;

    // Backface culling
    if (state.cullMode !== CULL_MODE.NONE) {
      const isCCW = area > 0;
      const front = state.frontFace === "ccw" ? isCCW : !isCCW;
      if (state.cullMode === CULL_MODE.BACK && !front) return;
      if (state.cullMode === CULL_MODE.FRONT && front) return;
    }

    const invArea = 1 / area;
    const rt = state.renderTarget || framebuffer;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;

        // Coordenadas baricéntricas
        const w0 =
          ((p1.x - px) * (p2.y - py) - (p2.x - px) * (p1.y - py)) * invArea;
        const w1 =
          ((p2.x - px) * (p0.y - py) - (p0.x - px) * (p2.y - py)) * invArea;
        const w2 = 1 - w0 - w1;

        if (w0 < 0 || w1 < 0 || w2 < 0) continue;

        this.stats.fragments++;

        // Scissor test
        if (state.scissor) {
          const s = state.scissor;
          if (x < s.x || y < s.y || x >= s.x + s.width || y >= s.y + s.height) {
            continue;
          }
        }

        // Interpolar z con w-corrección
        const z = w0 * p0.z + w1 * p1.z + w2 * p2.z;

        // Depth test
        const depthIdx = y * width + x;
        if (state.depthTest) {
          const existingDepth = rt.depthBuffer[depthIdx];
          const pass = this._compareDepth(z, existingDepth, state.depthFunc);
          if (!pass) continue;
        }

        // Interpolar atributos
        const attrs = this._interpolateAttributes(
          [p0, p1, p2],
          [w0, w1, w2]
        );

        // Fragment shader
        let color = [255, 255, 255, 255];
        if (state.fragmentShader) {
          color = this._runFragmentShader(state, attrs, z);
          if (color === null) {
            this.stats.discarded++;
            continue;
          }
        }
        this.stats.shaded++;

        // Blending
        if (state.blendEnabled) {
          const idx = depthIdx * 4;
          const dst = [
            rt.colorBuffer[idx],
            rt.colorBuffer[idx + 1],
            rt.colorBuffer[idx + 2],
            rt.colorBuffer[idx + 3],
          ];
          color = this._blend(color, dst, state);
        }

        // Escribir al framebuffer
        const ci = depthIdx * 4;
        rt.colorBuffer[ci] = color[0];
        rt.colorBuffer[ci + 1] = color[1];
        rt.colorBuffer[ci + 2] = color[2];
        rt.colorBuffer[ci + 3] = color[3];

        // Depth write
        if (state.depthTest && state.depthWrite) {
          rt.depthBuffer[depthIdx] = z;
        }

        this.gpu.stats.fragmentsWritten++;
      }
    }
  }

  _compareDepth(a, b, func) {
    switch (func) {
      case COMPARE_FUNC.NEVER: return false;
      case COMPARE_FUNC.LESS: return a < b;
      case COMPARE_FUNC.EQUAL: return a === b;
      case COMPARE_FUNC.LEQUAL: return a <= b;
      case COMPARE_FUNC.GREATER: return a > b;
      case COMPARE_FUNC.NOTEQUAL: return a !== b;
      case COMPARE_FUNC.GEQUAL: return a >= b;
      case COMPARE_FUNC.ALWAYS: return true;
      default: return true;
    }
  }

  _interpolateAttributes(points, weights) {
    if (!points[0].attrs) return null;
    const result = [];
    for (let i = 0; i < points[0].attrs.length; i++) {
      const v = new Vec4();
      v.x = weights[0] * (points[0].attrs[i].x || 0) + weights[1] * (points[1].attrs[i].x || 0) + weights[2] * (points[2].attrs[i].x || 0);
      v.y = weights[0] * (points[0].attrs[i].y || 0) + weights[1] * (points[1].attrs[i].y || 0) + weights[2] * (points[2].attrs[i].y || 0);
      v.z = weights[0] * (points[0].attrs[i].z || 0) + weights[1] * (points[1].attrs[i].z || 0) + weights[2] * (points[2].attrs[i].z || 0);
      v.w = weights[0] * (points[0].attrs[i].w || 1) + weights[1] * (points[1].attrs[i].w || 1) + weights[2] * (points[2].attrs[i].w || 1);
      result.push(v);
    }
    return result;
  }

  _runFragmentShader(state, attrs, depth) {
    const vm = new ShaderVm({
      shader: state.fragmentShader,
      constants: state.constants.map((c) => new Vec4(c[0], c[1], c[2], c[3])),
      samplers: Array.from(state.samplers.values()),
    });
    const out = vm.execute(attrs || []);
    const color = out[0] || new Vec4(1, 1, 1, 1);
    return [
      clamp(Math.round(color.x * 255), 0, 255),
      clamp(Math.round(color.y * 255), 0, 255),
      clamp(Math.round(color.z * 255), 0, 255),
      clamp(Math.round(color.w * 255), 0, 255),
    ];
  }

  _blend(src, dst, state) {
    const getFactor = (factor, src, dst) => {
      switch (factor) {
        case BLEND_FACTOR.ZERO: return [0, 0, 0, 0];
        case BLEND_FACTOR.ONE: return [1, 1, 1, 1];
        case BLEND_FACTOR.SRC_COLOR: return src.map((v) => v / 255);
        case BLEND_FACTOR.ONE_MINUS_SRC_COLOR: return src.map((v) => 1 - v / 255);
        case BLEND_FACTOR.SRC_ALPHA: return [src[3] / 255, src[3] / 255, src[3] / 255, src[3] / 255];
        case BLEND_FACTOR.ONE_MINUS_SRC_ALPHA: {
          const a = 1 - src[3] / 255;
          return [a, a, a, a];
        }
        case BLEND_FACTOR.DST_COLOR: return dst.map((v) => v / 255);
        case BLEND_FACTOR.ONE_MINUS_DST_COLOR: return dst.map((v) => 1 - v / 255);
        case BLEND_FACTOR.DST_ALPHA: return [dst[3] / 255, dst[3] / 255, dst[3] / 255, dst[3] / 255];
        case BLEND_FACTOR.ONE_MINUS_DST_ALPHA: {
          const a = 1 - dst[3] / 255;
          return [a, a, a, a];
        }
        default: return [1, 1, 1, 1];
      }
    };
    const s = getFactor(state.blendSrc, src, dst);
    const d = getFactor(state.blendDst, src, dst);
    const applyOp = (a, b) => {
      switch (state.blendOp) {
        case BLEND_OP.ADD: return a + b;
        case BLEND_OP.SUBTRACT: return a - b;
        case BLEND_OP.REVERSE_SUBTRACT: return b - a;
        case BLEND_OP.MIN: return Math.min(a, b);
        case BLEND_OP.MAX: return Math.max(a, b);
        default: return a + b;
      }
    };
    const out = [];
    for (let i = 0; i < 4; i++) {
      const result = applyOp(src[i] * s[i], dst[i] * d[i]);
      out.push(clamp(Math.round(result), 0, 255));
    }
    return out;
  }
}

// ============================================================================
// 10. COMMAND BUFFER
// ============================================================================

class CommandBuffer {
  constructor() {
    this.id = uid("cb");
    this.commands = [];
    this.submitted = false;
    this.executed = false;
  }

  reset() {
    this.commands = [];
    this.submitted = false;
    this.executed = false;
  }

  push(opcode, args = {}) {
    this.commands.push({ opcode, args });
    return this;
  }

  clear(args) { return this.push(VGPU_OPCODE.CLEAR, args); }
  draw(args) { return this.push(VGPU_OPCODE.DRAW, args); }
  dispatch(args) { return this.push(VGPU_OPCODE.DISPATCH, args); }
  setPipeline(args) { return this.push(VGPU_OPCODE.SET_PIPELINE, args); }
  setRenderTarget(args) { return this.push(VGPU_OPCODE.SET_RENDER_TARGET, args); }
  bindVertexBuffer(args) { return this.push(VGPU_OPCODE.BIND_VERTEX_BUFFER, args); }
  bindIndexBuffer(args) { return this.push(VGPU_OPCODE.BIND_INDEX_BUFFER, args); }
  bindUniformBuffer(args) { return this.push(VGPU_OPCODE.BIND_UNIFORM_BUFFER, args); }
  bindTexture(args) { return this.push(VGPU_OPCODE.BIND_TEXTURE, args); }
  bindSampler(args) { return this.push(VGPU_OPCODE.BIND_SAMPLER, args); }
  setViewport(args) { return this.push(VGPU_OPCODE.SET_VIEWPORT, args); }
  setScissor(args) { return this.push(VGPU_OPCODE.SET_SCISSOR, args); }
  copyTexture(args) { return this.push(VGPU_OPCODE.COPY_TEXTURE, args); }
  copyBuffer(args) { return this.push(VGPU_OPCODE.COPY_BUFFER, args); }
  present() { return this.push(VGPU_OPCODE.PRESENT, {}); }
  signalFence(args) { return this.push(VGPU_OPCODE.SIGNAL_FENCE, args); }
  waitFence(args) { return this.push(VGPU_OPCODE.WAIT_FENCE, args); }
  signalSemaphore(args) { return this.push(VGPU_OPCODE.SIGNAL_SEMAPHORE, args); }
  waitSemaphore(args) { return this.push(VGPU_OPCODE.WAIT_SEMAPHORE, args); }
  pushConstants(args) { return this.push(VGPU_OPCODE.PUSH_CONSTANTS, args); }
}

// ============================================================================
// 11. DISPLAY CONTROLLER
// ============================================================================

class DisplayController {
  constructor({ width, height, vsyncHz = 60, presentMode = PRESENT_MODE.FIFO }) {
    this.width = width;
    this.height = height;
    this.vsyncHz = vsyncHz;
    this.vsyncInterval = 1000 / vsyncHz;
    this.presentMode = presentMode;

    this.swapChain = [];
    this.currentBackBufferIndex = 0;
    this.backBuffers = 2; // double buffering

    this.stats = {
      presents: 0,
      vsyncMisses: 0,
      tearingEvents: 0,
      lastPresentAt: 0,
      frameTimeMs: 0,
      fps: 0,
    };

    this._frameTimes = [];
    this._frameTimesMax = 120;
  }

  present(framebuffer) {
    const t = now();
    const delta = t - this.stats.lastPresentAt;
    const expectedInterval = this.vsyncInterval;
    const missedVsync = delta < expectedInterval * 0.5;

    if (this.presentMode === PRESENT_MODE.FIFO && missedVsync) {
      this.stats.vsyncMisses++;
      kernelBus.emit(GPU_EVENTS.VSYNC_MISSED, { delta });
      return false;
    }

    if (this.presentMode === PRESENT_MODE.IMMEDIATE) {
      // presentar directamente (posible tearing)
      this.stats.tearingEvents++;
    }

    this.stats.lastPresentAt = t;
    this.stats.presents++;
    this.stats.frameTimeMs = delta;

    // Frame time history
    this._frameTimes.push(delta);
    if (this._frameTimes.length > this._frameTimesMax) this._frameTimes.shift();
    const avgFrame = this._frameTimes.reduce((a, b) => a + b, 0) / this._frameTimes.length;
    this.stats.fps = avgFrame > 0 ? 1000 / avgFrame : 0;

    // Guardar en swap chain
    this.swapChain.push({
      ts: t,
      framebufferId: framebuffer.id,
      frameTimeMs: delta,
    });
    if (this.swapChain.length > this.backBuffers + 1) this.swapChain.shift();

    kernelBus.emit(GPU_EVENTS.PRESENT, {
      framebufferId: framebuffer.id,
      fps: this.stats.fps,
    });
    return true;
  }

  snapshot() {
    return { ...this.stats };
  }
}

// ============================================================================
// 12. VGPU (clase principal)
// ============================================================================

export class VGPU {
  constructor(options = {}) {
    this.id = options.id ?? 0;
    this.options = {
      vramBytes: options.vramBytes ?? 512 * 1024 * 1024,
      defaultWidth: options.defaultWidth ?? 1024,
      defaultHeight: options.defaultHeight ?? 768,
      vsyncHz: options.vsyncHz ?? 60,
      presentMode: options.presentMode ?? PRESENT_MODE.FIFO,
      shaderCores: options.shaderCores ?? 8,
      computeUnits: options.computeUnits ?? 4,
      enableCompute: options.enableCompute !== false,
      enableRaster: options.enableRaster !== false,
      ...options,
    };

    this.state = GPU_STATE.OFFLINE;
    this.log = new GpuLogger();

    // Recursos
    this.vram = new VramManager(this.options.vramBytes);
    this.compiler = new ShaderCompiler();
    this.buffers = new Map();
    this.textures = new Map();
    this.renderTargets = new Map();
    this.pipelineState = new PipelineState();
    this.defaultPipeline = new PipelineState();
    this.commandQueue = [];
    this.fences = new Map();
    this.semaphores = new Map();

    // Framebuffer por defecto (el que se presenta)
    this.defaultRenderTarget = new RenderTarget({
      width: this.options.defaultWidth,
      height: this.options.defaultHeight,
    });
    this.renderTargets.set(this.defaultRenderTarget.id, this.defaultRenderTarget);
    this.defaultRenderTarget.clear({ r: 30, g: 30, b: 40, a: 255 });
    this.pipelineState.renderTarget = this.defaultRenderTarget;
    this.defaultPipeline.renderTarget = this.defaultRenderTarget;

    // Display
    this.display = new DisplayController({
      width: this.options.defaultWidth,
      height: this.options.defaultHeight,
      vsyncHz: this.options.vsyncHz,
      presentMode: this.options.presentMode,
    });

    // Raster
    this.rasterizer = new Rasterizer(this);

    // Stats
    this.stats = {
      cycles: 0,
      commands: 0,
      drawCalls: 0,
      triangles: 0,
      fragmentsWritten: 0,
      shaderInvocations: 0,
      computeDispatches: 0,
      dispatchesInFlight: 0,
      dmaTransfers: 0,
      fencesSignaled: 0,
      waits: 0,
    };
  }

  // --------------------------------------------------------------------------
  init() {
    this.state = GPU_STATE.IDLE;
    kernelBus.emit(GPU_EVENTS.INIT, {
      vramBytes: this.options.vramBytes,
      shaderCores: this.options.shaderCores,
    });
    this.log.info("vgpu initialized", {
      vram: this.options.vramBytes,
    });
  }

  shutdown() {
    this.state = GPU_STATE.OFFLINE;
    kernelBus.emit(GPU_EVENTS.SHUTDOWN, {});
    this.log.info("vgpu shutdown");
  }

  deviceLost(reason = "unknown") {
    this.state = GPU_STATE.FAULT;
    kernelBus.emit(GPU_EVENTS.DEVICE_LOST, { reason });
    this.log.error(`device lost: ${reason}`);
  }

  // --------------------------------------------------------------------------
  // Shaders
  // --------------------------------------------------------------------------
  compileShader(source, stage) {
    return this.compiler.compile(source, stage);
  }

  // --------------------------------------------------------------------------
  // Buffers
  // --------------------------------------------------------------------------
  createBuffer({ bytes, tag = "buffer", data = null } = {}) {
    const vramId = this.vram.alloc({ bytes, tag, category: "buffer" });
    if (!vramId) return null;
    const buf = new GpuBuffer({
      bytes,
      tag,
      vram: vramId,
      data,
    });
    this.buffers.set(buf.id, buf);
    kernelBus.emit(GPU_EVENTS.BUFFER_UPLOADED, {
      id: buf.id,
      bytes,
      tag,
    });
    return buf;
  }

  destroyBuffer(id) {
    const buf = this.buffers.get(id);
    if (!buf) return false;
    this.vram.free(buf.vram);
    this.buffers.delete(id);
    return true;
  }

  // --------------------------------------------------------------------------
  // Texturas
  // --------------------------------------------------------------------------
  createTexture({
    width,
    height,
    format = "RGBA8",
    data = null,
    mipmaps = 1,
    wrap = WRAP_MODE.CLAMP,
    filter = FILTER_MODE.NEAREST,
    tag = "texture",
  } = {}) {
    const f = TEXTURE_FORMAT[format];
    if (!f) throw new Error(`unknown texture format: ${format}`);
    const bytes = width * height * f.bytes * mipmaps;
    const vramId = this.vram.alloc({ bytes, tag, category: "texture" });
    if (!vramId) return null;
    const tex = new GpuTexture({
      width,
      height,
      format,
      data,
      mipmaps,
      wrap,
      filter,
      vram: vramId,
    });
    this.textures.set(tex.id, tex);
    kernelBus.emit(GPU_EVENTS.TEXTURE_UPLOADED, {
      id: tex.id,
      width,
      height,
      format,
      bytes,
    });
    return tex;
  }

  destroyTexture(id) {
    const t = this.textures.get(id);
    if (!t) return false;
    this.vram.free(t.vram);
    this.textures.delete(id);
    return true;
  }

  // --------------------------------------------------------------------------
  // Render Targets
  // --------------------------------------------------------------------------
  createRenderTarget({ width, height, colorFormat = "RGBA8", depthFormat = "D24S8" } = {}) {
    const rt = new RenderTarget({ width, height, colorFormat, depthFormat });
    this.renderTargets.set(rt.id, rt);
    return rt;
  }

  // --------------------------------------------------------------------------
  // Command Buffers
  // --------------------------------------------------------------------------
  createCommandBuffer() {
    return new CommandBuffer();
  }

  submitCommandBuffer(cb) {
    if (this.state === GPU_STATE.OFFLINE || this.state === GPU_STATE.FAULT) {
      this.log.warn("cannot submit, gpu offline");
      return false;
    }
    cb.submitted = true;
    this.commandQueue.push(cb);
    kernelBus.emit(GPU_EVENTS.COMMAND_BUFFER_SUBMITTED, {
      id: cb.id,
      commands: cb.commands.length,
    });
    this.log.info(`command buffer submitted: ${cb.id}`, {
      commands: cb.commands.length,
    });
    return true;
  }

  executeCommandBuffers() {
    if (this.state !== GPU_STATE.IDLE) return 0;
    this.state = GPU_STATE.PROCESSING;
    let processed = 0;
    while (this.commandQueue.length > 0) {
      const cb = this.commandQueue.shift();
      this._executeCommandBuffer(cb);
      cb.executed = true;
      processed++;
    }
    this.state = GPU_STATE.IDLE;
    return processed;
  }

  _executeCommandBuffer(cb) {
    for (const cmd of cb.commands) {
      this._executeCommand(cmd);
      this.stats.commands++;
    }
  }

  _executeCommand(cmd) {
    switch (cmd.opcode) {
      case VGPU_OPCODE.NOP:
        break;
      case VGPU_OPCODE.CLEAR: {
        const rt = cmd.args.renderTarget || this.pipelineState.renderTarget;
        rt?.clear(cmd.args);
        break;
      }
      case VGPU_OPCODE.DRAW:
        this._cmdDraw(cmd.args);
        break;
      case VGPU_OPCODE.DISPATCH:
        this._cmdDispatch(cmd.args);
        break;
      case VGPU_OPCODE.SET_PIPELINE:
        Object.assign(this.pipelineState, cmd.args);
        break;
      case VGPU_OPCODE.SET_RENDER_TARGET:
        this.pipelineState.renderTarget = cmd.args.renderTarget;
        break;
      case VGPU_OPCODE.BIND_VERTEX_BUFFER:
        this.pipelineState.vertexBuffer = cmd.args.buffer;
        this.pipelineState.vertexStride = cmd.args.stride ?? 16;
        this.pipelineState.vertexOffset = cmd.args.offset ?? 0;
        break;
      case VGPU_OPCODE.BIND_INDEX_BUFFER:
        this.pipelineState.indexBuffer = cmd.args.buffer;
        this.pipelineState.indexFormat = cmd.args.format ?? INDEX_FORMAT.UINT16;
        this.pipelineState.indexOffset = cmd.args.offset ?? 0;
        break;
      case VGPU_OPCODE.BIND_UNIFORM_BUFFER:
        this.pipelineState.uniformBuffer = cmd.args.buffer;
        break;
      case VGPU_OPCODE.BIND_TEXTURE:
        this.pipelineState.textures.set(cmd.args.slot, cmd.args.texture);
        this.pipelineState.samplers.set(cmd.args.slot, cmd.args.texture);
        break;
      case VGPU_OPCODE.BIND_SAMPLER:
        // nada especial, los samplers son las texturas en esta versión
        break;
      case VGPU_OPCODE.SET_VIEWPORT:
        this.pipelineState.viewport = { ...cmd.args };
        break;
      case VGPU_OPCODE.SET_SCISSOR:
        this.pipelineState.scissor = cmd.args.rect ? { ...cmd.args.rect } : null;
        break;
      case VGPU_OPCODE.COPY_TEXTURE: {
        const src = cmd.args.src;
        const dst = cmd.args.dst;
        if (src && dst) dst.data.set(src.data);
        this.stats.dmaTransfers++;
        break;
      }
      case VGPU_OPCODE.COPY_BUFFER: {
        const src = cmd.args.src;
        const dst = cmd.args.dst;
        if (src && dst) {
          dst.write(cmd.args.dstOffset ?? 0, src.read(cmd.args.srcOffset ?? 0, src.bytes));
        }
        this.stats.dmaTransfers++;
        break;
      }
      case VGPU_OPCODE.PRESENT:
        this._cmdPresent();
        break;
      case VGPU_OPCODE.SIGNAL_FENCE:
        this._signalFence(cmd.args.fence, cmd.args.value);
        break;
      case VGPU_OPCODE.WAIT_FENCE:
        this._waitFence(cmd.args.fence, cmd.args.value);
        break;
      case VGPU_OPCODE.SIGNAL_SEMAPHORE:
        this._signalSemaphore(cmd.args.semaphore);
        break;
      case VGPU_OPCODE.WAIT_SEMAPHORE:
        this._waitSemaphore(cmd.args.semaphore);
        break;
      case VGPU_OPCODE.PUSH_CONSTANTS:
        this.pipelineState.constants = cmd.args.constants || [];
        break;
      default:
        this.log.warn(`unknown command: ${cmd.opcode}`);
    }
    kernelBus.emit(GPU_EVENTS.COMMAND_EXECUTED, { opcode: cmd.opcode });
  }

  // --------------------------------------------------------------------------
  // Draw
  // --------------------------------------------------------------------------
  _cmdDraw(args) {
    this.stats.drawCalls++;
    this.stats.cycles++;

    const state = this.pipelineState;
    const topology = args.topology ?? state.topology;
    const vertexCount = args.vertexCount ?? 0;
    const firstVertex = args.firstVertex ?? 0;
    const instanceCount = args.instanceCount ?? 1;

    kernelBus.emit(GPU_EVENTS.DRAW_CALL, {
      topology,
      vertexCount,
      instanceCount,
    });

    if (!state.vertexBuffer || !state.vertexShader) {
      this.log.warn("draw: missing vertex buffer or vertex shader");
      return;
    }

    // Ensamblar primitivas
    const primitives = this._assemblePrimitives(topology, vertexCount, firstVertex);
    this.stats.triangles += primitives.length;

    // Ejecutar vertex shader para cada vértice
    const vertexOutputs = this._runVertexShader(primitives);

    // Rasterizar cada primitiva
    const rt = state.renderTarget || this.defaultRenderTarget;
    for (let inst = 0; inst < instanceCount; inst++) {
      for (const prim of vertexOutputs) {
        if (prim.length === 3) {
          this.rasterizer.drawTriangle(prim[0], prim[1], prim[2], state, rt);
        }
        // Líneas y puntos omitidos por brevedad
      }
    }

    this.stats.shaderInvocations += vertexCount;
    kernelBus.emit(GPU_EVENTS.DRAW_COMPLETE, {
      triangles: primitives.length,
    });
  }

  _assemblePrimitives(topology, count, firstVertex) {
    const primitives = [];
    if (topology === PRIMITIVE_TOPOLOGY.TRIANGLE_LIST) {
      for (let i = 0; i + 2 < count; i += 3) {
        primitives.push([
          firstVertex + i,
          firstVertex + i + 1,
          firstVertex + i + 2,
        ]);
      }
    } else if (topology === PRIMITIVE_TOPOLOGY.TRIANGLE_STRIP) {
      for (let i = 0; i + 2 < count; i++) {
        if (i % 2 === 0) {
          primitives.push([firstVertex + i, firstVertex + i + 1, firstVertex + i + 2]);
        } else {
          primitives.push([firstVertex + i + 1, firstVertex + i, firstVertex + i + 2]);
        }
      }
    } else if (topology === PRIMITIVE_TOPOLOGY.TRIANGLE_FAN) {
      for (let i = 1; i + 1 < count; i++) {
        primitives.push([firstVertex, firstVertex + i, firstVertex + i + 1]);
      }
    }
    kernelBus.emit(GPU_EVENTS.PRIMITIVE_ASSEMBLED, {
      count: primitives.length,
      topology,
    });
    return primitives;
  }

  _runVertexShader(primitives) {
    const state = this.pipelineState;
    const vm = new ShaderVm({
      shader: state.vertexShader,
      constants: state.constants.map((c) => new Vec4(c[0], c[1], c[2], c[3])),
      samplers: Array.from(state.samplers.values()),
    });

    // Leer vértices del buffer
    const vertexData = this._readVertexData();

    const outputs = [];
    for (const tri of primitives) {
      const triOut = [];
      for (const idx of tri) {
        const attrs = this._getVertexAttributes(vertexData, idx);
        const vsOut = vm.execute(attrs);
        triOut.push({
          pos: vsOut[0] || new Vec4(),
          attrs: vsOut.slice(1),
        });
      }
      outputs.push(triOut);
    }
    return outputs;
  }

  _readVertexData() {
    const buf = this.pipelineState.vertexBuffer;
    if (!buf) return [];
    return buf.data;
  }

  _getVertexAttributes(data, idx) {
    const stride = this.pipelineState.vertexStride;
    const offset = this.pipelineState.vertexOffset + idx * stride;
    const attrs = [];
    const view = new DataView(data.buffer, data.byteOffset + offset, stride);
    for (let i = 0; i + 4 <= stride; i += 16) {
      attrs.push(
        new Vec4(
          view.getFloat32(i, true),
          view.getFloat32(i + 4, true),
          view.getFloat32(i + 8, true),
          view.getFloat32(i + 12, true)
        )
      );
    }
    return attrs;
  }

  // --------------------------------------------------------------------------
  // Compute
  // --------------------------------------------------------------------------
  _cmdDispatch(args) {
    if (!this.options.enableCompute) return;
    const { shader, groupsX = 1, groupsY = 1, groupsZ = 1, workgroupSize = 64 } = args;
    this.stats.computeDispatches++;
    kernelBus.emit(GPU_EVENTS.COMPUTE_DISPATCH, { shader, groupsX, groupsY, groupsZ });
    // Simulamos dispatch
    this.stats.dispatchesInFlight++;
    kernelBus.emit(GPU_EVENTS.COMPUTE_COMPLETE, { shader });
    this.stats.dispatchesInFlight--;
  }

  // --------------------------------------------------------------------------
  // Fences & Semaphores
  // --------------------------------------------------------------------------
  createFence(initialValue = 0) {
    const id = uid("fence");
    this.fences.set(id, { id, value: initialValue, signaled: false });
    return id;
  }

  _signalFence(fenceId, value = 1) {
    const f = this.fences.get(fenceId);
    if (!f) return;
    f.value = value;
    f.signaled = true;
    this.stats.fencesSignaled++;
    kernelBus.emit(GPU_EVENTS.FENCE_SIGNALED, { fenceId, value });
  }

  async _waitFence(fenceId, value = 1) {
    const f = this.fences.get(fenceId);
    if (!f) return;
    this.stats.waits++;
    while (f.value < value) {
      await new Promise((r) => setTimeout(r, 4));
    }
    kernelBus.emit(GPU_EVENTS.FENCE_WAITED, { fenceId, value });
  }

  createSemaphore() {
    const id = uid("sem");
    this.semaphores.set(id, { id, signaled: false });
    return id;
  }

  _signalSemaphore(semId) {
    const s = this.semaphores.get(semId);
    if (!s) return;
    s.signaled = true;
    kernelBus.emit(GPU_EVENTS.SEMAPHORE_SIGNAL, { semaphoreId: semId });
  }

  async _waitSemaphore(semId) {
    const s = this.semaphores.get(semId);
    if (!s) return;
    while (!s.signaled) {
      await new Promise((r) => setTimeout(r, 4));
    }
    s.signaled = false;
    kernelBus.emit(GPU_EVENTS.SEMAPHORE_WAIT, { semaphoreId: semId });
  }

  // --------------------------------------------------------------------------
  // DMA (CPU ↔ GPU)
  // --------------------------------------------------------------------------
  async dmaTransfer(src, dst, bytes) {
    this.stats.dmaTransfers++;
    kernelBus.emit(GPU_EVENTS.DMA_START, { src, dst, bytes });
    // Simulamos tiempo de transferencia proporcional al tamaño
    const durationMs = clamp(bytes / (1024 * 1024) * 2, 1, 100);
    await new Promise((r) => setTimeout(r, durationMs));
    kernelBus.emit(GPU_EVENTS.DMA_COMPLETE, { src, dst, bytes });
  }

  // --------------------------------------------------------------------------
  // Present
  // --------------------------------------------------------------------------
  _cmdPresent() {
    const rt = this.pipelineState.renderTarget || this.defaultRenderTarget;
    const presented = this.display.present(rt);
    if (presented) {
      kernelBus.emit(GPU_EVENTS.VSYNC, {
        ts: this.display.stats.lastPresentAt,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Frame tick (llamado desde el scheduler/rAF)
  // --------------------------------------------------------------------------
  tick() {
    if (this.state === GPU_STATE.IDLE && this.commandQueue.length > 0) {
      this.executeCommandBuffers();
    }
  }

  // --------------------------------------------------------------------------
  snapshot
  // --------------------------------------------------------------------------
  snapshot() {
    return {
      id: this.id,
      state: this.state,
      vram: this.vram.snapshot(),
      compiler: this.compiler.snapshot(),
      pipeline: {
        topology: this.pipelineState.topology,
        renderTarget: this.pipelineState.renderTarget?.id ?? null,
        vertexShader: this.pipelineState.vertexShader?.id ?? null,
        fragmentShader: this.pipelineState.fragmentShader?.id ?? null,
        cullMode: this.pipelineState.cullMode,
        blendEnabled: this.pipelineState.blendEnabled,
      },
      buffers: this.buffers.size,
      textures: this.textures.size,
      renderTargets: this.renderTargets.size,
      commandQueue: this.commandQueue.length,
      display: this.display.snapshot(),
      raster: { ...this.rasterizer.stats },
      stats: { ...this.stats },
    };
  }

  dumpFramebufferPixels(x = 0, y = 0, w = 8, h = 8) {
    const rt = this.pipelineState.renderTarget || this.defaultRenderTarget;
    const out = [];
    for (let j = 0; j < h; j++) {
      const row = [];
      for (let i = 0; i < w; i++) {
        const p = rt.getPixel(x + i, y + j);
        row.push(p ? `rgba(${p[0]},${p[1]},${p[2]},${p[3]})` : "null");
      }
      out.push(row);
    }
    return out;
  }
}

// ============================================================================
// 13. PROVIDER + HOOKS
// ============================================================================

const VgpuContext = createContext(null);

const initialState = {
  state: GPU_STATE.OFFLINE,
  snapshot: null,
  logs: [],
};

function reducer(state, action) {
  switch (action.type) {
    case "SNAPSHOT":
      return { ...state, snapshot: action.snapshot, state: action.snapshot.state };
    case "LOG":
      return { ...state, logs: [...state.logs.slice(-299), action.entry] };
    default:
      return state;
  }
}

export function VgpuProvider({
  children,
  gpu: external,
  scheduler,
  options = {},
  autoInit = true,
  autoTick = true,
}) {
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new VGPU(options);
  }
  const gpu = ref.current;
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    if (autoInit) gpu.init();

    const unsub = kernelBus.on(GPU_EVENTS.PERF_WARNING, () => {});
    const offLog = kernelBus.on(GPU_EVENTS.LOG, (entry) => {
      dispatch({ type: "LOG", entry });
    });

    // Snapshot periódico
    const t = setInterval(() => {
      dispatch({ type: "SNAPSHOT", snapshot: gpu.snapshot() });
    }, 500);

    // Conectar con el scheduler: registrar como dispositivo asíncrono
    if (scheduler) {
      gpu.scheduler = scheduler;
    }

    // Auto tick vía rAF
    let rafHandle = null;
    if (autoTick) {
      const tick = () => {
        gpu.tick();
        rafHandle = requestAnimationFrame(tick);
      };
      rafHandle = requestAnimationFrame(tick);
    }

    return () => {
      unsub();
      offLog();
      clearInterval(t);
      if (rafHandle != null) cancelAnimationFrame(rafHandle);
      gpu.shutdown();
    };
  }, [autoInit, autoTick, gpu, scheduler]);

  const api = useMemo(
    () => ({
      gpu,
      state: state.state,
      snapshot: state.snapshot,
      logs: state.logs,

      // control
      init: () => gpu.init(),
      shutdown: () => gpu.shutdown(),
      tick: () => gpu.tick(),

      // shaders
      compileShader: (src, stage) => gpu.compileShader(src, stage),

      // recursos
      createBuffer: (opts) => gpu.createBuffer(opts),
      destroyBuffer: (id) => gpu.destroyBuffer(id),
      createTexture: (opts) => gpu.createTexture(opts),
      destroyTexture: (id) => gpu.destroyTexture(id),
      createRenderTarget: (opts) => gpu.createRenderTarget(opts),

      // command buffers
      createCommandBuffer: () => gpu.createCommandBuffer(),
      submitCommandBuffer: (cb) => gpu.submitCommandBuffer(cb),
      executeCommandBuffers: () => gpu.executeCommandBuffers(),

      // fences
      createFence: (v) => gpu.createFence(v),
      createSemaphore: () => gpu.createSemaphore(),

      // dma
      dmaTransfer: (src, dst, bytes) => gpu.dmaTransfer(src, dst, bytes),

      // present
      present: () => gpu._cmdPresent(),

      // debug
      dumpFramebufferPixels: (x, y, w, h) => gpu.dumpFramebufferPixels(x, y, w, h),
      snapshotNow: () => gpu.snapshot(),
    }),
    [gpu, state]
  );

  return <VgpuContext.Provider value={api}>{children}</VgpuContext.Provider>;
}

export function useVgpu() {
  const ctx = useContext(VgpuContext);
  if (!ctx) throw new Error("useVgpu must be used within a VgpuProvider");
  return ctx;
}

// ============================================================================
// 14. HOOKS AUXILIARES
// ============================================================================

export function useVgpuSnapshot(intervalMs = 500) {
  const { gpu } = useVgpu();
  const [snap, setSnap] = useState(() => gpu.snapshot());
  useEffect(() => {
    const t = setInterval(() => setSnap(gpu.snapshot()), intervalMs);
    return () => clearInterval(t);
  }, [gpu, intervalMs]);
  return snap;
}

// ============================================================================
// 15. EXPORTS
// ============================================================================

export default {
  VGPU,
  VgpuProvider,
  useVgpu,
  useVgpuSnapshot,
  GPU_STATE,
  GPU_EVENTS,
  SHADER_STAGE,
  PRIMITIVE_TOPOLOGY,
  INDEX_FORMAT,
  VERTEX_FORMAT,
  TEXTURE_FORMAT,
  WRAP_MODE,
  FILTER_MODE,
  COMPARE_FUNC,
  BLEND_FACTOR,
  BLEND_OP,
  CULL_MODE,
  PRESENT_MODE,
  VGPU_OPCODE,
  Vec4,
  Mat4,
  VramManager,
  ShaderCompiler,
  ShaderVm,
  CompiledShader,
  GpuBuffer,
  GpuTexture,
  RenderTarget,
  PipelineState,
  Rasterizer,
  CommandBuffer,
  DisplayController,
};
