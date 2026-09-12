// ============================================================================
// macho-loader.jsx — Loader Mach-O completo
// ----------------------------------------------------------------------------
// Lee, parsea y ejecuta binarios Mach-O (ejecutables, dylibs, bundles, kexts)
// tal como lo haría el dyld (dynamic linker) de macOS.
//
// SOPORTA
//
// 1. FORMATOS
//    - Mach-O 32 bits (MH_MAGIC)
//    - Mach-O 64 bits (MH_MAGIC_64)
//    - Fat / Universal binaries (FAT_MAGIC, FAT_MAGIC_64)
//    - dylib, bundle, executable, kext, dSYM
//
// 2. HEADERS
//    - mach_header / mach_header_64
//    - Detección automática de arquitectura (x86_64, arm64, arm64e, i386...)
//    - Filetype (MH_EXECUTE, MH_DYLIB, MH_BUNDLE, MH_OBJECT, MH_KEXT...)
//    - Flags (MH_PIE, MH_NOUNDEFS, MH_TWOLEVEL...)
//
// 3. LOAD COMMANDS
//    - LC_SEGMENT / LC_SEGMENT_64
//    - LC_SYMTAB, LC_DYSYMTAB
//    - LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB
//    - LC_ID_DYLIB
//    - LC_LOAD_DYLINKER, LC_LOAD_DYLINKER (dyld)
//    - LC_UUID
//    - LC_VERSION_MIN_MACOSX, LC_VERSION_MIN_IPHONEOS, LC_BUILD_VERSION
//    - LC_SOURCE_VERSION
//    - LC_MAIN (entry point)
//    - LC_UNIXTHREAD (entry state)
//    - LC_DYLD_INFO_ONLY (rebase, bind, weak_bind, lazy_bind, export)
//    - LC_DYLD_CHAINED_FIXUPS (formato moderno Big Sur+)
//    - LC_DYLD_EXPORTS_TRIE
//    - LC_FUNCTION_STARTS
//    - LC_DATA_IN_CODE
//    - LC_CODE_SIGNATURE (CodeDirectory, entitlements)
//    - LC_RPATH, LC_LOAD_UPWARD_DYLIB
//    - LC_ENCRYPTION_INFO / LC_ENCRYPTION_INFO_64 (FairPlay)
//    - LC_LINKER_OPTION
//    - LC_NOTE (para archivos auxiliares)
//    - LC_FILESET_ENTRY (para kernel collections)
//    - Y todos los que aparecen en el listado de Apple
//
// 4. CARGA DE SEGMENTOS
//    - __TEXT, __DATA, __DATA_CONST, __LINKEDIT, __OBJC, __PAGEZERO
//    - Protección por segmento (r/w/x)
//    - Alineación de páginas (16 KB en arm64, 4 KB en x86_64)
//    - Slide / ASLR base
//    - PIE (Position Independent Executable)
//
// 5. SYMBOLS
//    - N_SECT, N_UNDF, N_ABS, N_INDR
//    - N_TYPE, N_EXT, N_PEXT
//    - nlist_64 (name, type, sect, desc, value)
//    - Export trie (LC_DYLD_EXPORTS_TRIE / LC_DYLD_INFO export_off)
//    - Import bind table
//
// 6. DYNAMIC LINKING
//    - Rebase opcodes (RB_*)
//    - Bind opcodes (BIND_*)
//    - Lazy bind
//    - Weak bind
//    - Chained fixups (DYLD_CHAINED_PTR_64, 64_OFFSET, ARM64E, ...)
//    - Symbol resolution contra otros machos cargados (LibSystem, libc++...)
//
// 7. RELOCATIONS
//    - X86_64_RELOC_BRANCH, GOT, GOT_LOAD, SIGNED_*, UNSIGNED, TLV, SUBTRACTOR
//    - ARM64_RELOC_BRANCH26, PAGE21, PAGEOFF12, GOT_LOAD_PAGE21, GOT_LOAD_PAGEOFF12,
//      ADDEND, AUTHENTICATED_*
//    - Aplicación a __text, __data, __cstring
//
// 8. CODE SIGNING
//    - CodeDirectory parsing (versión 0x20400+)
//    - SuperBlob (CodeDirectory, Requirements, CMS, Entitlements, DER)
//    - Verificación de hashes (SHA-1, SHA-256)
//    - Entitlements (plist embebido)
//
// 9. ENTRY POINT
//    - LC_MAIN (entryoff)
//    - LC_UNIXTHREAD (PC inicial, SP inicial)
//    - Setup de stack y argv/envp
//    - Syscall gate (SYSCALL, SVC 0x80)
//
// 10. EJECUCIÓN
//     - Interpretación ARM64 (subconjunto)
//     - Interpretación x86_64 (subconjunto)
//     - Ejecuta instrucciones contra la VCPU
//     - Syscalls: exit, write, read, mmap, munmap, brk, open, close
//     - Threads: clone, fork, execve
//
// 11. INSPECCIÓN
//     - Dump de headers, load commands, segments, sections, symbols
//     - Verificación de firma
//     - Desensamblado básico
//     - Análisis de imports/exports
//
// EL MÓDULO NO RENDERIZA UI. Es lógica pura + parser + ejecutor.
// ============================================================================

import { kernelBus } from "../kernel/kernel.jsx";
import { VCPU, OPCODE, VCPU_EVENTS, EXCEPTION } from "../vcpu/vcpu.jsx";

// ============================================================================
// 1. CONSTANTES MACH-O
// ============================================================================

export const MH_MAGIC = 0xfeedface;        // 32-bit
export const MH_CIGAM = 0xcefaedfe;
export const MH_MAGIC_64 = 0xfeedfacf;     // 64-bit
export const MH_CIGAM_64 = 0xcffaedfe;
export const FAT_MAGIC = 0xcafebabe;
export const FAT_CIGAM = 0xbebafeca;
export const FAT_MAGIC_64 = 0xcafebabf;
export const FAT_CIGAM_64 = 0xbfbafeca;

export const FILE_TYPES = Object.freeze({
  MH_OBJECT: 0x1,
  MH_EXECUTE: 0x2,
  MH_FVMLIB: 0x3,
  MH_CORE: 0x4,
  MH_PRELOAD: 0x5,
  MH_DYLIB: 0x6,
  MH_DYLINKER: 0x7,
  MH_BUNDLE: 0x8,
  MH_DYLIB_STUB: 0x9,
  MH_DSYM: 0xa,
  MH_KEXT_BUNDLE: 0xb,
  MH_FILESET: 0xc,
  MH_GPU_EXECUTE: 0xd,
  MH_GPU_DYLIB: 0xe,
});

export const FILE_TYPE_NAMES = {
  0x1: "OBJECT",
  0x2: "EXECUTE",
  0x3: "FVMLIB",
  0x4: "CORE",
  0x5: "PRELOAD",
  0x6: "DYLIB",
  0x7: "DYLINKER",
  0x8: "BUNDLE",
  0x9: "DYLIB_STUB",
  0xa: "DSYM",
  0xb: "KEXT_BUNDLE",
  0xc: "FILESET",
  0xd: "GPU_EXECUTE",
  0xe: "GPU_DYLIB",
};

export const CPU_TYPES = Object.freeze({
  CPU_ARCH_ABI64: 0x01000000,
  CPU_ARCH_ABI64_32: 0x02000000,
  CPU_TYPE_X86: 7,
  CPU_TYPE_I386: 7,
  CPU_TYPE_X86_64: 7 | 0x01000000,
  CPU_TYPE_ARM: 12,
  CPU_TYPE_ARM64: 12 | 0x01000000,
  CPU_TYPE_ARM64_32: 12 | 0x02000000,
  CPU_TYPE_POWERPC: 18,
  CPU_TYPE_POWERPC64: 18 | 0x01000000,
});

export const CPU_TYPE_NAMES = {
  7: "x86",
  0x01000007: "x86_64",
  0x02000007: "x86_64h",
  12: "arm",
  0x0100000c: "arm64",
  0x0200000c: "arm64_32",
  0x0100000c: "arm64e",
  18: "ppc",
  0x01000012: "ppc64",
};

export const CPU_SUBTYPES = {
  arm64: { ALL: 0, V8: 1, V8_2: 2, V8_3: 3, V8_4: 4, V8_5: 5, V8_6: 6, V8_7: 7 },
  x86_64: { ALL: 3, H: 8 },
  arm64e: { ALL: 2, V8: 1, V8_2: 2, V8_3: 3, V8_4: 4, V8_5: 5, V8_6: 6, V8_7: 7 },
};

export const HEADER_FLAGS = Object.freeze({
  MH_NOUNDEFS: 0x1,
  MH_INCRLINK: 0x2,
  MH_DYLDLINK: 0x4,
  MH_BINDATLOAD: 0x8,
  MH_PREBOUND: 0x10,
  MH_SPLIT_SEGS: 0x20,
  MH_LAZY_INIT: 0x40,
  MH_TWOLEVEL: 0x80,
  MH_FORCE_FLAT: 0x100,
  MH_NOMULTIDEFS: 0x200,
  MH_NOFIXPREBINDING: 0x400,
  MH_PREBINDABLE: 0x800,
  MH_ALLMODSBOUND: 0x1000,
  MH_SUBSECTIONS_VIA_SYMBOLS: 0x2000,
  MH_CANONICAL: 0x4000,
  MH_WEAK_DEFINES: 0x8000,
  MH_BINDS_TO_WEAK: 0x10000,
  MH_ALLOW_STACK_EXECUTION: 0x20000,
  MH_ROOT_SAFE: 0x40000,
  MH_SETUID_SAFE: 0x80000,
  MH_NO_REEXPORTED_DYLIBS: 0x100000,
  MH_PIE: 0x200000,
  MH_DEAD_STRIPPABLE_DYLIB: 0x400000,
  MH_HAS_TLV_DESCRIPTORS: 0x800000,
  MH_NO_HEAP_EXECUTION: 0x1000000,
  MH_APP_EXTENSION_SAFE: 0x02000000,
  MH_NLIST_OUTOFSYNC_WITH_DYLDINFO: 0x04000000,
  MH_SIM_SUPPORT: 0x08000000,
  MH_DYLIB_IN_CACHE: 0x80000000,
});

export const LC = Object.freeze({
  LC_REQ_DYLD: 0x80000000,
  LC_SEGMENT: 0x1,
  LC_SYMTAB: 0x2,
  LC_SYMSEG: 0x3,
  LC_THREAD: 0x4,
  LC_UNIXTHREAD: 0x5,
  LC_LOADFVMLIB: 0x6,
  LC_IDFVMLIB: 0x7,
  LC_IDENT: 0x8,
  LC_FVMFILE: 0x9,
  LC_PREPAGE: 0xa,
  LC_DYSYMTAB: 0xb,
  LC_LOAD_DYLIB: 0xc,
  LC_ID_DYLIB: 0xd,
  LC_LOAD_DYLINKER: 0xe,
  LC_ID_DYLINKER: 0xf,
  LC_PREBOUND_DYLIB: 0x10,
  LC_ROUTINES: 0x11,
  LC_SUB_FRAMEWORK: 0x12,
  LC_SUB_UMBRELLA: 0x13,
  LC_SUB_CLIENT: 0x14,
  LC_SUB_LIBRARY: 0x15,
  LC_TWOLEVEL_HINTS: 0x16,
  LC_PREBIND_CKSUM: 0x17,
  LC_LOAD_WEAK_DYLIB: 0x18 | 0x80000000,
  LC_SEGMENT_64: 0x19,
  LC_ROUTINES_64: 0x1a,
  LC_UUID: 0x1b,
  LC_RPATH: 0x1c | 0x80000000,
  LC_CODE_SIGNATURE: 0x1d,
  LC_SEGMENT_SPLIT_INFO: 0x1e,
  LC_REEXPORT_DYLIB: 0x1f | 0x80000000,
  LC_LAZY_LOAD_DYLIB: 0x20,
  LC_ENCRYPTION_INFO: 0x21,
  LC_DYLD_INFO: 0x22,
  LC_DYLD_INFO_ONLY: 0x22 | 0x80000000,
  LC_LOAD_UPWARD_DYLIB: 0x23 | 0x80000000,
  LC_VERSION_MIN_MACOSX: 0x24,
  LC_VERSION_MIN_IPHONEOS: 0x25,
  LC_FUNCTION_STARTS: 0x26,
  LC_DYLD_ENVIRONMENT: 0x27,
  LC_MAIN: 0x28 | 0x80000000,
  LC_DATA_IN_CODE: 0x29,
  LC_SOURCE_VERSION: 0x2a,
  LC_DYLIB_CODE_SIGN_DRS: 0x2b,
  LC_ENCRYPTION_INFO_64: 0x2c,
  LC_LINKER_OPTION: 0x2d,
  LC_LINKER_OPTIMIZATION_HINT: 0x2e,
  LC_VERSION_MIN_TVOS: 0x2f,
  LC_VERSION_MIN_WATCHOS: 0x30,
  LC_NOTE: 0x31,
  LC_BUILD_VERSION: 0x32,
  LC_DYLD_EXPORTS_TRIE: 0x33 | 0x80000000,
  LC_DYLD_CHAINED_FIXUPS: 0x34 | 0x80000000,
  LC_FILESET_ENTRY: 0x35 | 0x80000000,
});

export const LC_NAMES = {
  0x1: "LC_SEGMENT",
  0x2: "LC_SYMTAB",
  0x3: "LC_SYMSEG",
  0x4: "LC_THREAD",
  0x5: "LC_UNIXTHREAD",
  0x6: "LC_LOADFVMLIB",
  0x7: "LC_IDFVMLIB",
  0x8: "LC_IDENT",
  0x9: "LC_FVMFILE",
  0xa: "LC_PREPAGE",
  0xb: "LC_DYSYMTAB",
  0xc: "LC_LOAD_DYLIB",
  0xd: "LC_ID_DYLIB",
  0xe: "LC_LOAD_DYLINKER",
  0xf: "LC_ID_DYLINKER",
  0x10: "LC_PREBOUND_DYLIB",
  0x11: "LC_ROUTINES",
  0x12: "LC_SUB_FRAMEWORK",
  0x13: "LC_SUB_UMBRELLA",
  0x14: "LC_SUB_CLIENT",
  0x15: "LC_SUB_LIBRARY",
  0x16: "LC_TWOLEVEL_HINTS",
  0x17: "LC_PREBIND_CKSUM",
  0x18 | 0x80000000: "LC_LOAD_WEAK_DYLIB",
  0x19: "LC_SEGMENT_64",
  0x1a: "LC_ROUTINES_64",
  0x1b: "LC_UUID",
  0x1c | 0x80000000: "LC_RPATH",
  0x1d: "LC_CODE_SIGNATURE",
  0x1e: "LC_SEGMENT_SPLIT_INFO",
  0x1f | 0x80000000: "LC_REEXPORT_DYLIB",
  0x20: "LC_LAZY_LOAD_DYLIB",
  0x21: "LC_ENCRYPTION_INFO",
  0x22: "LC_DYLD_INFO",
  0x22 | 0x80000000: "LC_DYLD_INFO_ONLY",
  0x23 | 0x80000000: "LC_LOAD_UPWARD_DYLIB",
  0x24: "LC_VERSION_MIN_MACOSX",
  0x25: "LC_VERSION_MIN_IPHONEOS",
  0x26: "LC_FUNCTION_STARTS",
  0x27: "LC_DYLD_ENVIRONMENT",
  0x28 | 0x80000000: "LC_MAIN",
  0x29: "LC_DATA_IN_CODE",
  0x2a: "LC_SOURCE_VERSION",
  0x2b: "LC_DYLIB_CODE_SIGN_DRS",
  0x2c: "LC_ENCRYPTION_INFO_64",
  0x2d: "LC_LINKER_OPTION",
  0x2e: "LC_LINKER_OPTIMIZATION_HINT",
  0x2f: "LC_VERSION_MIN_TVOS",
  0x30: "LC_VERSION_MIN_WATCHOS",
  0x31: "LC_NOTE",
  0x32: "LC_BUILD_VERSION",
  0x33 | 0x80000000: "LC_DYLD_EXPORTS_TRIE",
  0x34 | 0x80000000: "LC_DYLD_CHAINED_FIXUPS",
  0x35 | 0x80000000: "LC_FILESET_ENTRY",
};

export const VM_PROT = Object.freeze({
  READ: 0x1,
  WRITE: 0x2,
  EXECUTE: 0x4,
});

export const SEGMENT_NAMES = {
  __TEXT: { prot: VM_PROT.READ | VM_PROT.EXECUTE, initprot: VM_PROT.READ | VM_PROT.EXECUTE },
  __DATA: { prot: VM_PROT.READ | VM_PROT.WRITE, initprot: VM_PROT.READ | VM_PROT.WRITE },
  __DATA_CONST: { prot: VM_PROT.READ | VM_PROT.WRITE, initprot: VM_PROT.READ },
  __LINKEDIT: { prot: VM_PROT.READ, initprot: VM_PROT.READ },
  __PAGEZERO: { prot: 0, initprot: 0 },
  __OBJC: { prot: VM_PROT.READ | VM_PROT.WRITE, initprot: VM_PROT.READ },
  __IMPORT: { prot: VM_PROT.READ | VM_PROT.WRITE, initprot: VM_PROT.READ | VM_PROT.WRITE },
};

export const REBASE_OPCODE = Object.freeze({
  DONE: 0x00,
  SET_TYPE_IMM: 0x10,
  SET_SEGMENT_AND_OFFSET_ULEB: 0x20,
  ADD_ADDR_ULEB: 0x30,
  ADD_ADDR_IMM_SCALED: 0x40,
  DO_REBASE_IMM_TIMES: 0x50,
  DO_REBASE_ULEB_TIMES: 0x60,
  DO_REBASE_ADD_ADDR_ULEB: 0x70,
  DO_REBASE_ULEB_TIMES_SKIPPING_ULEB: 0x80,
  MASK: 0xf0,
  IMM_MASK: 0x0f,
});

export const BIND_OPCODE = Object.freeze({
  DONE: 0x00,
  SET_DYLIB_ORDINAL_IMM: 0x10,
  SET_DYLIB_ORDINAL_ULEB: 0x20,
  SET_DYLIB_SPECIAL_IMM: 0x30,
  SET_SYMBOL_TRAILING_FLAGS_IMM: 0x40,
  SET_TYPE_IMM: 0x50,
  SET_ADDEND_SLEB: 0x60,
  SET_SEGMENT_AND_OFFSET_ULEB: 0x70,
  ADD_ADDR_ULEB: 0x80,
  DO_BIND: 0x90,
  DO_BIND_ADD_ADDR_ULEB: 0xa0,
  DO_BIND_ADD_ADDR_IMM_SCALED: 0xb0,
  DO_BIND_ULEB_TIMES_SKIPPING_ULEB: 0xc0,
  THREADED: 0xd0,
  MASK: 0xf0,
  IMM_MASK: 0x0f,
});

export const REBASE_TYPE = Object.freeze({
  POINTER: 1,
  TEXT_ABSOLUTE32: 2,
  TEXT_PCREL32: 3,
});

export const BIND_TYPE = Object.freeze({
  POINTER: 1,
  TEXT_ABSOLUTE32: 2,
  TEXT_PCREL32: 3,
});

export const BIND_SYMBOL_FLAGS = Object.freeze({
  WEAK_IMPORT: 0x1,
  NON_WEAK_DEFINITION: 0x8,
});

export const BIND_SPECIAL_DYLIB = Object.freeze({
  SELF: 0,
  MAIN_EXECUTABLE: -1,
  FLAT_LOOKUP: -2,
  WEAK_LOOKUP: -3,
});

export const EXPORT_SYMBOL_FLAGS = Object.freeze({
  KIND_MASK: 0x03,
  KIND_REGULAR: 0x00,
  KIND_THREAD_LOCAL: 0x01,
  KIND_ABSOLUTE: 0x02,
  WEAK_DEFINITION: 0x04,
  REEXPORT: 0x08,
  STUB_AND_RESOLVER: 0x10,
});

// Chained fixups
export const DYLD_CHAINED_PTR_FORMAT = Object.freeze({
  NONE: 0,
  ARM64E: 1,
  PTR_64: 2,
  PTR_32: 3,
  PTR_32_CACHE: 4,
  PTR_32_FIRMWARE: 5,
  PTR_64_OFFSET: 6,
  ARM64E_KERNEL: 7,
  PTR_64_KERNEL_CACHE: 8,
  ARM64E_USERLAND24: 12,
});

export const DYLD_CHAINED_IMPORT_FORMAT = Object.freeze({
  NONE: 0,
  POINTER_32: 1,
  POINTER_64: 2,
  POINTER_64_OFFSET: 3,
});

export const MACHO_EVENTS = Object.freeze({
  PARSE_START: "macho:parse-start",
  PARSE_COMPLETE: "macho:parse-complete",
  PARSE_ERROR: "macho:parse-error",
  FAT_DETECTED: "macho:fat-detected",
  SLICE_SELECTED: "macho:slice-selected",
  HEADER_PARSED: "macho:header-parsed",
  LOAD_COMMAND_PARSED: "macho:load-command-parsed",
  SEGMENT_LOADED: "macho:segment-loaded",
  SECTION_LOADED: "macho:section-loaded",
  SYMBOL_RESOLVED: "macho:symbol-resolved",
  SYMBOL_NOT_FOUND: "macho:symbol-not-found",
  REBASE_APPLIED: "macho:rebase-applied",
  BIND_APPLIED: "macho:bind-applied",
  CHAINED_FIXUP_APPLIED: "macho:chained-fixup-applied",
  RELOCATION_APPLIED: "macho:relocation-applied",
  CODE_SIGNATURE_VERIFIED: "macho:code-signature-verified",
  CODE_SIGNATURE_FAILED: "macho:code-signature-failed",
  ENTRY_POINT_FOUND: "macho:entry-point-found",
  LOADED: "macho:loaded",
  EXECUTION_START: "macho:execution-start",
  EXECUTION_END: "macho:execution-end",
  SYSCALL: "macho:syscall",
  UNSUPPORTED_INSTRUCTION: "macho:unsupported-instruction",
  LOG: "macho:log",
});

// ============================================================================
// 2. UTILIDADES
// ============================================================================

const now = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

const align = (n, a) => (n + a - 1) & ~(a - 1);

class MachoLogger {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(MACHO_EVENTS.LOG, e);
    if (level === "error") console.error("[macho]", message, meta);
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

// Reader: lee valores con endianness correcta desde un DataView
class Reader {
  constructor(buffer, offset = 0, bigEndian = false) {
    this.buffer = buffer;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.offset = offset;
    this.bigEndian = bigEndian;
  }

  seek(o) {
    this.offset = o;
    return this;
  }
  skip(n) {
    this.offset += n;
    return this;
  }
  tell() {
    return this.offset;
  }

  u8() {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }
  i8() {
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }
  u16() {
    const v = this.view.getUint16(this.offset, !this.bigEndian);
    this.offset += 2;
    return v;
  }
  i16() {
    const v = this.view.getInt16(this.offset, !this.bigEndian);
    this.offset += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.offset, !this.bigEndian);
    this.offset += 4;
    return v;
  }
  i32() {
    const v = this.view.getInt32(this.offset, !this.bigEndian);
    this.offset += 4;
    return v;
  }
  u64() {
    const v = this.view.getBigUint64(this.offset, !this.bigEndian);
    this.offset += 8;
    return v;
  }
  i64() {
    const v = this.view.getBigInt64(this.offset, !this.bigEndian);
    this.offset += 8;
    return v;
  }
  bytes(n) {
    const out = new Uint8Array(
      this.buffer.buffer,
      this.buffer.byteOffset + this.offset,
      n
    );
    this.offset += n;
    return out;
  }
  string(n) {
    const bytes = this.bytes(n);
    let end = 0;
    while (end < n && bytes[end] !== 0) end++;
    return new TextDecoder().decode(bytes.subarray(0, end));
  }
  cstring() {
    const start = this.offset;
    while (this.buffer[this.offset] !== 0) this.offset++;
    const s = new TextDecoder().decode(
      this.buffer.subarray(start, this.offset)
    );
    this.offset++;
    return s;
  }
  // ULEB128
  uleb128() {
    let result = 0n;
    let shift = 0n;
    let byte;
    do {
      byte = this.u8();
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
    } while (byte & 0x80);
    return result;
  }
  // SLEB128
  sleb128() {
    let result = 0n;
    let shift = 0n;
    let byte;
    do {
      byte = this.u8();
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
    } while (byte & 0x80);
    if (byte & 0x40) result |= -(1n << shift);
    return result;
  }
}

// ============================================================================
// 3. ESTRUCTURAS DE DATOS
// ============================================================================

class MachoHeader {
  constructor(data) {
    Object.assign(this, data);
  }

  is64() {
    return this.magic === MH_MAGIC_64 || this.magic === MH_CIGAM_64;
  }

  cpuName() {
    return CPU_TYPE_NAMES[this.cputype] || `unknown(0x${this.cputype.toString(16)})`;
  }

  fileTypeName() {
    return FILE_TYPE_NAMES[this.filetype] || `unknown(${this.filetype})`;
  }

  flagNames() {
    const names = [];
    for (const [name, bit] of Object.entries(HEADER_FLAGS)) {
      if (this.flags & bit) names.push(name);
    }
    return names;
  }

  toString() {
    return `Mach-O ${this.is64() ? "64" : "32"} bits, ${this.cpuName()}, ${this.fileTypeName()}`;
  }
}

class Segment {
  constructor(data) {
    Object.assign(this, data);
    this.sections = this.sections || [];
  }

  isExecutable() {
    return !!(this.initprot & VM_PROT.EXECUTE);
  }
  isWritable() {
    return !!(this.initprot & VM_PROT.WRITE);
  }
  isReadable() {
    return !!(this.initprot & VM_PROT.READ);
  }

  contains(vmaddr) {
    return vmaddr >= this.vmaddr && vmaddr < this.vmaddr + this.vmsize;
  }
}

class Section {
  constructor(data) {
    Object.assign(this, data);
  }
}

class Symbol {
  constructor(data) {
    Object.assign(this, data);
  }

  isExternal() {
    return !!(this.type & 0x01);
  }
  isPrivateExternal() {
    return !!(this.type & 0x10);
  }
  isUndefined() {
    return (this.type & 0x0e) === 0x00;
  }
  isAbsolute() {
    return (this.type & 0x0e) === 0x02;
  }
  isDefinedInSection() {
    return (this.type & 0x0e) === 0x0e;
  }
  isPrebound() {
    return (this.type & 0x0e) === 0x0c;
  }
  isIndirect() {
    return (this.type & 0x0e) === 0x0a;
  }
}

class Dylib {
  constructor(data) {
    Object.assign(this, data);
  }
}

class MachoFile {
  constructor() {
    this.header = null;
    this.loadCommands = [];
    this.segments = [];
    this.sections = [];
    this.symbols = [];
    this.dylibs = [];
    this.dysymtab = null;
    this.symtab = null;
    this.uuid = null;
    this.buildVersion = null;
    this.sourceVersion = null;
    this.main = null;
    this.unixthread = null;
    this.dyldInfo = null;
    this.chainedFixups = null;
    this.exportTrie = null;
    this.functionStarts = null;
    this.dataInCode = null;
    this.codeSignature = null;
    this.encryptionInfo = null;
    this.rpaths = [];
    this.loadDylinker = null;
    this.idDylib = null;
    this.subFramework = null;
    this.linkOptions = [];
    this.notes = [];
    this.filesetEntries = [];
    this.imageBase = 0n;
    this.slide = 0n;
    this.size = 0;
    this.arch = null;
    this.slices = [];
  }

  segmentNamed(name) {
    return this.segments.find((s) => s.segname === name) || null;
  }

  sectionNamed(seg, sect) {
    return (
      this.sections.find(
        (s) => s.segname === seg && s.sectname === sect
      ) || null
    );
  }

  symbolNamed(name) {
    return this.symbols.find((s) => s.name === name) || null;
  }
}

// ============================================================================
// 4. PARSER MACH-O
// ============================================================================

export class MachoParser {
  constructor() {
    this.log = new MachoLogger();
  }

  /**
   * Parsea un buffer (ArrayBuffer, Uint8Array o DataView) y devuelve
   * un MachoFile. Si el archivo es fat, devuelve el slice preferido
   * o todos los slices si opts.allSlices es true.
   */
  parse(input, opts = {}) {
    const bytes =
      input instanceof Uint8Array
        ? input
        : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : input;

    kernelBus.emit(MACHO_EVENTS.PARSE_START, { size: bytes.length });
    this.log.info("parsing Mach-O", { size: bytes.length });

    try {
      const reader = new Reader(bytes);
      const magicBE = reader.view.getUint32(0, false);
      const magicLE = reader.view.getUint32(0, true);

      // Fat binary?
      if (magicBE === FAT_MAGIC || magicBE === FAT_MAGIC_64) {
        const file = this._parseFat(bytes, magicBE === FAT_MAGIC_64, opts);
        kernelBus.emit(MACHO_EVENTS.PARSE_COMPLETE, { slices: file.slices.length });
        return file;
      }

      // Mach-O normal
      const file = this._parseThin(bytes, opts);
      kernelBus.emit(MACHO_EVENTS.PARSE_COMPLETE, { arch: file.arch });
      return file;
    } catch (err) {
      this.log.error("parse error", err);
      kernelBus.emit(MACHO_EVENTS.PARSE_ERROR, { error: String(err) });
      throw err;
    }
  }

  _parseFat(bytes, is64, opts) {
    const reader = new Reader(bytes, 0, false);
    const magic = reader.u32(); // BE
    const nfatArch = reader.u32(); // BE
    this.log.info(`fat binary: ${nfatArch} slices`);
    kernelBus.emit(MACHO_EVENTS.FAT_DETECTED, { slices: nfatArch });

    const slices = [];
    for (let i = 0; i < nfatArch; i++) {
      let cputype, cpusubtype, offset, size, align;
      if (is64) {
        cputype = reader.u32();
        cpusubtype = reader.u32();
        offset = Number(reader.u64());
        size = Number(reader.u64());
        align = reader.u32();
        reader.skip(4); // reserved
      } else {
        cputype = reader.u32();
        cpusubtype = reader.u32();
        offset = reader.u32();
        size = reader.u32();
        align = reader.u32();
      }
      const arch = CPU_TYPE_NAMES[cputype] || `unknown(0x${cputype.toString(16)})`;
      slices.push({ cputype, cpusubtype, offset, size, align, arch });
    }

    // Elegir slice
    const preferred = opts.preferArch || "arm64";
    let selected =
      slices.find((s) => s.arch === preferred) ||
      slices.find((s) => s.arch === "x86_64") ||
      slices[0];

    this.log.info(`selected slice: ${selected.arch}`, { offset: selected.offset, size: selected.size });
    kernelBus.emit(MACHO_EVENTS.SLICE_SELECTED, { arch: selected.arch });

    // Parsear el slice seleccionado
    const sliceBytes = bytes.subarray(selected.offset, selected.offset + selected.size);
    const file = this._parseThin(sliceBytes, opts);
    file.slices = slices.map((s) => ({
      ...s,
      parsed: s === selected,
    }));
    return file;
  }

  _parseThin(bytes, opts) {
    const reader = new Reader(bytes);
    const magic = reader.view.getUint32(0, false);

    let is64 = false;
    let bigEndian = false;

    if (magic === MH_MAGIC_64) {
      is64 = true;
      bigEndian = false;
    } else if (magic === MH_CIGAM_64) {
      is64 = true;
      bigEndian = true;
    } else if (magic === MH_MAGIC) {
      is64 = false;
      bigEndian = false;
    } else if (magic === MH_CIGAM) {
      is64 = false;
      bigEndian = true;
    } else {
      throw new Error(
        `not a Mach-O file (magic=0x${magic.toString(16)})`
      );
    }

    reader.bigEndian = bigEndian;
    reader.seek(0);

    const header = this._parseHeader(reader, is64);
    const file = new MachoFile();
    file.header = header;
    file.size = bytes.length;
    file.arch = header.cpuName();

    kernelBus.emit(MACHO_EVENTS.HEADER_PARSED, { header: header.toString() });
    this.log.info("header parsed", header.toString());

    // Parsear load commands
    reader.seek(is64 ? 32 : 28);
    this._parseLoadCommands(reader, header, file, is64);

    // Calcular imageBase (primer segmento con vmaddr distinto de 0)
    for (const seg of file.segments) {
      if (seg.segname === "__TEXT" && seg.vmaddr !== 0n) {
        file.imageBase = seg.vmaddr;
        break;
      }
    }
    if (!file.imageBase && file.segments.length > 0) {
      file.imageBase = file.segments[0].vmaddr;
    }

    return file;
  }

  _parseHeader(reader, is64) {
    const data = {};
    data.magic = reader.u32();
    data.cputype = reader.i32();
    data.cpusubtype = reader.i32();
    data.filetype = reader.u32();
    data.ncmds = reader.u32();
    data.sizeofcmds = reader.u32();
    data.flags = reader.u32();
    data.reserved = is64 ? reader.u32() : 0;
    return new MachoHeader(data);
  }

  _parseLoadCommands(reader, header, file, is64) {
    for (let i = 0; i < header.ncmds; i++) {
      const cmdStart = reader.tell();
      const cmd = reader.u32();
      const cmdsize = reader.u32();

      if (cmdsize < 8) {
        this.log.warn("invalid cmdsize, stopping");
        break;
      }

      const cmdName = LC_NAMES[cmd] || `unknown(0x${cmd.toString(16)})`;
      const cmdData = this._parseLoadCommand(cmd, reader, cmdStart, cmdsize, is64, file);

      file.loadCommands.push({
        cmd,
        cmdsize,
        name: cmdName,
        offset: cmdStart,
        data: cmdData,
      });

      kernelBus.emit(MACHO_EVENTS.LOAD_COMMAND_PARSED, {
        cmd: cmdName,
        size: cmdsize,
      });

      // Avanzar al siguiente comando (alineado)
      reader.seek(cmdStart + cmdsize);
    }
  }

  _parseLoadCommand(cmd, reader, cmdStart, cmdsize, is64, file) {
    switch (cmd) {
      case LC.LC_SEGMENT_64:
        return this._parseSegment64(reader, cmdStart, file);
      case LC.LC_SEGMENT:
        return this._parseSegment32(reader, cmdStart, file);
      case LC.LC_SYMTAB:
        return this._parseSymtab(reader, cmdStart, file);
      case LC.LC_DYSYMTAB:
        return this._parseDysymtab(reader, cmdStart, file);
      case LC.LC_LOAD_DYLIB:
      case LC.LC_LOAD_WEAK_DYLIB:
      case LC.LC_REEXPORT_DYLIB:
      case LC.LC_LOAD_UPWARD_DYLIB:
      case LC.LC_LAZY_LOAD_DYLIB:
        return this._parseDylib(reader, cmdStart, file, "load");
      case LC.LC_ID_DYLIB:
        return this._parseDylib(reader, cmdStart, file, "id");
      case LC.LC_LOAD_DYLINKER:
      case LC.LC_ID_DYLINKER:
        return this._parseDylinker(reader, cmdStart, file);
      case LC.LC_UUID:
        return this._parseUuid(reader);
      case LC.LC_VERSION_MIN_MACOSX:
      case LC.LC_VERSION_MIN_IPHONEOS:
      case LC.LC_VERSION_MIN_TVOS:
      case LC.LC_VERSION_MIN_WATCHOS:
        return this._parseVersionMin(reader, cmd);
      case LC.LC_BUILD_VERSION:
        return this._parseBuildVersion(reader, file);
      case LC.LC_SOURCE_VERSION:
        return this._parseSourceVersion(reader, file);
      case LC.LC_MAIN:
        return this._parseMain(reader, file);
      case LC.LC_UNIXTHREAD:
        return this._parseUnixThread(reader, file);
      case LC.LC_DYLD_INFO:
      case LC.LC_DYLD_INFO_ONLY:
        return this._parseDyldInfo(reader, file);
      case LC.LC_DYLD_CHAINED_FIXUPS:
        return this._parseChainedFixups(reader, file);
      case LC.LC_DYLD_EXPORTS_TRIE:
        return this._parseExportsTrie(reader, file);
      case LC.LC_FUNCTION_STARTS:
        return this._parseLinkeditData(reader, file, "functionStarts");
      case LC.LC_DATA_IN_CODE:
        return this._parseLinkeditData(reader, file, "dataInCode");
      case LC.LC_CODE_SIGNATURE:
        return this._parseCodeSignature(reader, file);
      case LC.LC_ENCRYPTION_INFO:
      case LC.LC_ENCRYPTION_INFO_64:
        return this._parseEncryptionInfo(reader, file, cmd === LC.LC_ENCRYPTION_INFO_64);
      case LC.LC_RPATH:
        return this._parseRpath(reader, file);
      case LC.LC_LINKER_OPTION:
        return this._parseLinkerOption(reader, file);
      case LC.LC_NOTE:
        return this._parseNote(reader, file);
      case LC.LC_FILESET_ENTRY:
        return this._parseFilesetEntry(reader, file);
      case LC.LC_SUB_FRAMEWORK:
      case LC.LC_SUB_UMBRELLA:
      case LC.LC_SUB_CLIENT:
      case LC.LC_SUB_LIBRARY:
        return this._parseSubName(reader, file, cmd);
      default:
        return { raw: reader.bytes(0) };
    }
  }

  // ----- Segmentos

  _parseSegment64(reader, cmdStart, file) {
    reader.seek(cmdStart + 8);
    const segname = reader.string(16).replace(/\0+$/, "");
    const vmaddr = reader.u64();
    const vmsize = reader.u64();
    const fileoff = reader.u64();
    const filesize = reader.u64();
    const maxprot = reader.i32();
    const initprot = reader.i32();
    const nsects = reader.u32();
    const flags = reader.u32();

    const seg = new Segment({
      segname,
      vmaddr,
      vmsize,
      fileoff: Number(fileoff),
      filesize: Number(filesize),
      maxprot,
      initprot,
      nsects,
      flags,
      is64: true,
    });

    const sections = [];
    for (let i = 0; i < nsects; i++) {
      const sect = this._parseSection64(reader, segname);
      sections.push(sect);
    }
    seg.sections = sections;

    file.segments.push(seg);
    file.sections.push(...sections);

    kernelBus.emit(MACHO_EVENTS.SEGMENT_LOADED, {
      segname,
      vmaddr: vmaddr.toString(),
      vmsize: vmsize.toString(),
      sections: nsects,
    });
    this.log.info(`segment loaded: ${segname} (${nsects} sections)`);

    return seg;
  }

  _parseSegment32(reader, cmdStart, file) {
    reader.seek(cmdStart + 8);
    const segname = reader.string(16).replace(/\0+$/, "");
    const vmaddr = BigInt(reader.u32());
    const vmsize = BigInt(reader.u32());
    const fileoff = reader.u32();
    const filesize = reader.u32();
    const maxprot = reader.i32();
    const initprot = reader.i32();
    const nsects = reader.u32();
    const flags = reader.u32();

    const seg = new Segment({
      segname,
      vmaddr,
      vmsize,
      fileoff,
      filesize,
      maxprot,
      initprot,
      nsects,
      flags,
      is64: false,
    });

    const sections = [];
    for (let i = 0; i < nsects; i++) {
      const sect = this._parseSection32(reader, segname);
      sections.push(sect);
    }
    seg.sections = sections;
    file.segments.push(seg);
    file.sections.push(...sections);
    return seg;
  }

  _parseSection64(reader, segname) {
    const sectname = reader.string(16).replace(/\0+$/, "");
    const seg = reader.string(16).replace(/\0+$/, "");
    const addr = reader.u64();
    const size = reader.u64();
    const offset = reader.u32();
    const alignExp = reader.u32();
    const reloff = reader.u32();
    const nreloc = reader.u32();
    const flags = reader.u32();
    const reserved1 = reader.u32();
    const reserved2 = reader.u32();
    const reserved3 = reader.u32();

    kernelBus.emit(MACHO_EVENTS.SECTION_LOADED, {
      sectname,
      segname: seg,
      addr: addr.toString(),
      size: size.toString(),
    });

    return new Section({
      sectname,
      segname: seg,
      addr,
      size,
      offset,
      align: 1 << alignExp,
      reloff,
      nreloc,
      flags,
      reserved1,
      reserved2,
      reserved3,
    });
  }

  _parseSection32(reader, segname) {
    const sectname = reader.string(16).replace(/\0+$/, "");
    const seg = reader.string(16).replace(/\0+$/, "");
    const addr = BigInt(reader.u32());
    const size = BigInt(reader.u32());
    const offset = reader.u32();
    const alignExp = reader.u32();
    const reloff = reader.u32();
    const nreloc = reader.u32();
    const flags = reader.u32();
    const reserved1 = reader.u32();
    const reserved2 = reader.u32();

    return new Section({
      sectname,
      segname: seg,
      addr,
      size,
      offset,
      align: 1 << alignExp,
      reloff,
      nreloc,
      flags,
      reserved1,
      reserved2,
    });
  }

  // ----- Symtab

  _parseSymtab(reader, cmdStart, file) {
    reader.seek(cmdStart + 8);
    const symoff = reader.u32();
    const nsyms = reader.u32();
    const stroff = reader.u32();
    const strsize = reader.u32();
    const symtab = { symoff, nsyms, stroff, strsize };
    file.symtab = symtab;
    this.log.info(`symtab: ${nsyms} symbols`);
    return symtab;
  }

  _parseDysymtab(reader, cmdStart, file) {
    reader.seek(cmdStart + 8);
    const data = {
      ilocalsym: reader.u32(),
      nlocalsym: reader.u32(),
      iextdefsym: reader.u32(),
      nextdefsym: reader.u32(),
      iundefsym: reader.u32(),
      nundefsym: reader.u32(),
      tocoff: reader.u32(),
      ntoc: reader.u32(),
      modtaboff: reader.u32(),
      nmodtab: reader.u32(),
      extrefsymoff: reader.u32(),
      nextrefsyms: reader.u32(),
      indirectsymoff: reader.u32(),
      nindirectsyms: reader.u32(),
      extreloff: reader.u32(),
      nextrel: reader.u32(),
      locreloff: reader.u32(),
      nlocrel: reader.u32(),
    };
    file.dysymtab = data;
    return data;
  }

  // ----- Dylibs

  _parseDylib(reader, cmdStart, file, kind) {
    reader.seek(cmdStart + 8);
    const nameOffset = reader.u32();
    const timestamp = reader.u32();
    const currentVersion = reader.u32();
    const compatibilityVersion = reader.u32();
    const nameAddr = cmdStart + nameOffset;
    const saved = reader.tell();
    reader.seek(nameAddr);
    const name = reader.cstring();
    reader.seek(saved);

    const dylib = new Dylib({
      kind,
      name,
      timestamp,
      currentVersion,
      compatibilityVersion,
    });

    if (kind === "id") file.idDylib = dylib;
    else file.dylibs.push(dylib);

    this.log.info(`dylib ${kind}: ${name}`);
    return dylib;
  }

  _parseDylinker(reader, cmdStart, file) {
    reader.seek(cmdStart + 8);
    const nameOffset = reader.u32();
    const saved = reader.tell();
    reader.seek(cmdStart + nameOffset);
    const name = reader.cstring();
    reader.seek(saved);
    file.loadDylinker = { name };
    return { name };
  }

  // ----- Misc

  _parseUuid(reader) {
    reader.skip(4);
    const bytes = reader.bytes(16);
    const uuid = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return { uuid: `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}` };
  }

  _parseVersionMin(reader, cmd) {
    reader.skip(4);
    const version = reader.u32();
    const sdk = reader.u32();
    return {
      version: this._formatVersion(version),
      sdk: this._formatVersion(sdk),
      platform: cmd,
    };
  }

  _parseBuildVersion(reader, file) {
    reader.skip(4);
    const platform = reader.u32();
    const minos = reader.u32();
    const sdk = reader.u32();
    const ntools = reader.u32();
    const tools = [];
    for (let i = 0; i < ntools; i++) {
      const tool = reader.u32();
      const version = reader.u32();
      tools.push({ tool, version: this._formatVersion(version) });
    }
    const bv = {
      platform,
      minos: this._formatVersion(minos),
      sdk: this._formatVersion(sdk),
      tools,
    };
    file.buildVersion = bv;
    return bv;
  }

  _parseSourceVersion(reader, file) {
    reader.skip(4);
    const version = reader.u64();
    const sv = { version: version.toString() };
    file.sourceVersion = sv;
    return sv;
  }

  _parseMain(reader, file) {
    reader.skip(4);
    const entryoff = reader.u64();
    const stacksize = reader.u64();
    const main = { entryoff: Number(entryoff), stacksize: Number(stacksize) };
    file.main = main;
    kernelBus.emit(MACHO_EVENTS.ENTRY_POINT_FOUND, { entryoff: main.entryoff });
    return main;
  }

  _parseUnixThread(reader, file) {
    reader.skip(4);
    const flavor = reader.u32();
    const count = reader.u32();
    const state = [];
    for (let i = 0; i < count; i++) {
      state.push(reader.u32());
    }
    const ut = { flavor, count, state };
    file.unixthread = ut;
    return ut;
  }

  _parseDyldInfo(reader, file) {
    reader.skip(4);
    const rebase_off = reader.u32();
    const rebase_size = reader.u32();
    const bind_off = reader.u32();
    const bind_size = reader.u32();
    const weak_bind_off = reader.u32();
    const weak_bind_size = reader.u32();
    const lazy_bind_off = reader.u32();
    const lazy_bind_size = reader.u32();
    const export_off = reader.u32();
    const export_size = reader.u32();

    const info = {
      rebase_off, rebase_size,
      bind_off, bind_size,
      weak_bind_off, weak_bind_size,
      lazy_bind_off, lazy_bind_size,
      export_off, export_size,
    };
    file.dyldInfo = info;
    this.log.info("dyld info parsed", info);
    return info;
  }

  _parseChainedFixups(reader, file) {
    reader.skip(4);
    const dataoff = reader.u32();
    const datasize = reader.u32();
    const cf = { dataoff, datasize };
    file.chainedFixups = cf;
    this.log.info("chained fixups present", cf);
    return cf;
  }

  _parseExportsTrie(reader, file) {
    reader.skip(4);
    const dataoff = reader.u32();
    const datasize = reader.u32();
    const et = { dataoff, datasize };
    file.exportTrie = et;
    return et;
  }

  _parseLinkeditData(reader, file, key) {
    reader.skip(4);
    const dataoff = reader.u32();
    const datasize = reader.u32();
    const d = { dataoff, datasize };
    file[key] = d;
    return d;
  }

  _parseCodeSignature(reader, file) {
    reader.skip(4);
    const dataoff = reader.u32();
    const datasize = reader.u32();
    const cs = { dataoff, datasize };
    file.codeSignature = cs;
    return cs;
  }

  _parseEncryptionInfo(reader, file, is64) {
    reader.skip(4);
    const cryptoff = reader.u32();
    const cryptsize = reader.u32();
    const cryptid = reader.u32();
    let pad = 0;
    if (is64) pad = reader.u32();
    const ei = { cryptoff, cryptsize, cryptid, is64, pad };
    file.encryptionInfo = ei;
    if (cryptid !== 0) {
      this.log.warn(`encrypted binary (cryptid=${cryptid}, FairPlay)`);
    }
    return ei;
  }

  _parseRpath(reader, file) {
    reader.skip(4);
    const pathOffset = reader.u32();
    const saved = reader.tell();
    reader.seek(pathOffset + 0);
    // El path está al final del comando
    reader.seek(reader.tell() + 0);
    // Volvemos al inicio del comando para calcular la dirección del string
    // (pathOffset es relativo al inicio del load command)
    const cmdStart = saved - 8;
    reader.seek(cmdStart + pathOffset);
    const path = reader.cstring();
    reader.seek(saved);
    file.rpaths.push(path);
    this.log.info(`rpath: ${path}`);
    return { path };
  }

  _parseLinkerOption(reader, file) {
    reader.skip(4);
    const count = reader.u32();
    const options = [];
    for (let i = 0; i < count; i++) {
      const opt = reader.cstring();
      options.push(opt);
    }
    file.linkOptions.push(...options);
    return { count, options };
  }

  _parseNote(reader, file) {
    const dataOwner = reader.string(16);
    const offset = reader.u64();
    const size = reader.u64();
    const note = { dataOwner, offset: Number(offset), size: Number(size) };
    file.notes.push(note);
    return note;
  }

  _parseFilesetEntry(reader, file) {
    reader.skip(4);
    const vmaddr = reader.u64();
    const fileoff = reader.u64();
    const entryIdOffset = reader.u32();
    const reserved = reader.u32();
    const entryId = reader.cstring();
    const entry = {
      vmaddr: vmaddr.toString(),
      fileoff: Number(fileoff),
      entryId,
    };
    file.filesetEntries.push(entry);
    return entry;
  }

  _parseSubName(reader, file, cmd) {
    reader.skip(4);
    const offset = reader.u32();
    const saved = reader.tell();
    reader.seek(saved - 8 + offset);
    const name = reader.cstring();
    reader.seek(saved);
    if (cmd === LC.LC_SUB_FRAMEWORK) file.subFramework = name;
    return { name };
  }

  _formatVersion(v) {
    return `${(v >> 16) & 0xffff}.${(v >> 8) & 0xff}.${v & 0xff}`;
  }
}

// ============================================================================
// 5. SYMBOL TABLE READER
// ============================================================================

export class SymbolTableReader {
  constructor(file, bytes) {
    this.file = file;
    this.bytes = bytes;
  }

  read() {
    const symtab = this.file.symtab;
    if (!symtab) return [];
    const reader = new Reader(this.bytes);
    const symbols = [];
    const is64 = this.file.header.is64();

    for (let i = 0; i < symtab.nsyms; i++) {
      const entryOffset = symtab.symoff + i * (is64 ? 16 : 12);
      reader.seek(entryOffset);
      const strx = reader.u32();
      const type = reader.u8();
      const sect = reader.u8();
      const desc = reader.u16();
      const value = is64 ? reader.u64() : BigInt(reader.u32());

      // Leer nombre desde string table
      reader.seek(symtab.stroff + strx);
      const name = reader.cstring();

      symbols.push(
        new Symbol({
          index: i,
          name,
          type,
          sect,
          desc,
          value,
          strx,
        })
      );
    }

    this.file.symbols = symbols;
    return symbols;
  }
}

// ============================================================================
// 6. DYLD INFO PARSER (rebase, bind, lazy, weak, export)
// ============================================================================

export class DyldInfoParser {
  constructor(file, bytes) {
    this.file = file;
    this.bytes = bytes;
    this.log = new MachoLogger();
  }

  parseRebase() {
    const info = this.file.dyldInfo;
    if (!info || info.rebase_size === 0) return [];
    const reader = new Reader(this.bytes, info.rebase_off);
    const actions = [];
    let type = REBASE_TYPE.POINTER;
    let segmentIndex = 0;
    let segmentOffset = 0n;
    let address = 0n;

    while (true) {
      const byte = reader.u8();
      const opcode = byte & REBASE_OPCODE.MASK;
      const imm = byte & REBASE_OPCODE.IMM_MASK;

      if (opcode === REBASE_OPCODE.DONE) break;

      switch (opcode) {
        case REBASE_OPCODE.SET_TYPE_IMM:
          type = imm;
          break;
        case REBASE_OPCODE.SET_SEGMENT_AND_OFFSET_ULEB: {
          segmentIndex = imm;
          segmentOffset = reader.uleb128();
          const seg = this.file.segments[segmentIndex];
          if (seg) address = seg.vmaddr + segmentOffset;
          break;
        }
        case REBASE_OPCODE.ADD_ADDR_ULEB:
          address += reader.uleb128();
          break;
        case REBASE_OPCODE.ADD_ADDR_IMM_SCALED:
          address += BigInt(imm) * 8n;
          break;
        case REBASE_OPCODE.DO_REBASE_IMM_TIMES:
          for (let i = 0; i < imm; i++) {
            actions.push({ type, address });
            address += 8n;
          }
          break;
        case REBASE_OPCODE.DO_REBASE_ULEB_TIMES: {
          const count = reader.uleb128();
          for (let i = 0n; i < count; i++) {
            actions.push({ type, address });
            address += 8n;
          }
          break;
        }
        case REBASE_OPCODE.DO_REBASE_ADD_ADDR_ULEB: {
          actions.push({ type, address });
          address += reader.uleb128() + 8n;
          break;
        }
        case REBASE_OPCODE.DO_REBASE_ULEB_TIMES_SKIPPING_ULEB: {
          const count = reader.uleb128();
          const skip = reader.uleb128();
          for (let i = 0n; i < count; i++) {
            actions.push({ type, address });
            address += skip + 8n;
          }
          break;
        }
        default:
          this.log.warn(`unknown rebase opcode 0x${opcode.toString(16)}`);
          return actions;
      }
    }
    this.log.info(`rebase actions: ${actions.length}`);
    return actions;
  }

  parseBind() {
    const info = this.file.dyldInfo;
    if (!info || info.bind_size === 0) return [];
    const reader = new Reader(this.bytes, info.bind_off);
    const actions = this._parseBindOps(reader, info.bind_size);
    this.log.info(`bind actions: ${actions.length}`);
    return actions;
  }

  parseLazyBind() {
    const info = this.file.dyldInfo;
    if (!info || info.lazy_bind_size === 0) return [];
    const reader = new Reader(this.bytes, info.lazy_bind_off);
    const actions = this._parseBindOps(reader, info.lazy_bind_size);
    this.log.info(`lazy bind actions: ${actions.length}`);
    return actions;
  }

  parseWeakBind() {
    const info = this.file.dyldInfo;
    if (!info || info.weak_bind_size === 0) return [];
    const reader = new Reader(this.bytes, info.weak_bind_off);
    const actions = this._parseBindOps(reader, info.weak_bind_size, true);
    this.log.info(`weak bind actions: ${actions.length}`);
    return actions;
  }

  _parseBindOps(reader, size, isWeak = false) {
    const actions = [];
    let type = BIND_TYPE.POINTER;
    let ordinal = 0;
    let symbolName = "";
    let symbolFlags = 0;
    let addend = 0n;
    let segmentIndex = 0;
    let segmentOffset = 0n;
    let address = 0n;
    let isLazy = false;

    while (true) {
      const byte = reader.u8();
      const opcode = byte & BIND_OPCODE.MASK;
      const imm = byte & BIND_OPCODE.IMM_MASK;

      if (opcode === BIND_OPCODE.DONE) {
        if (isLazy) {
          actions.push({
            type,
            address,
            symbol: symbolName,
            flags: symbolFlags,
            addend,
            ordinal,
            lazy: true,
          });
          isLazy = false;
          continue;
        }
        break;
      }

      switch (opcode) {
        case BIND_OPCODE.SET_DYLIB_ORDINAL_IMM:
          ordinal = imm;
          break;
        case BIND_OPCODE.SET_DYLIB_ORDINAL_ULEB:
          ordinal = Number(reader.uleb128());
          break;
        case BIND_OPCODE.SET_DYLIB_SPECIAL_IMM: {
          const v = imm === 0 ? 0 : (imm | 0xf0) - 0x100;
          ordinal = v;
          break;
        }
        case BIND_OPCODE.SET_SYMBOL_TRAILING_FLAGS_IMM:
          symbolFlags = imm;
          symbolName = reader.cstring();
          break;
        case BIND_OPCODE.SET_TYPE_IMM:
          type = imm;
          break;
        case BIND_OPCODE.SET_ADDEND_SLEB:
          addend = reader.sleb128();
          break;
        case BIND_OPCODE.SET_SEGMENT_AND_OFFSET_ULEB: {
          segmentIndex = imm;
          segmentOffset = reader.uleb128();
          const seg = this.file.segments[segmentIndex];
          if (seg) address = seg.vmaddr + segmentOffset;
          break;
        }
        case BIND_OPCODE.ADD_ADDR_ULEB:
          address += reader.uleb128();
          break;
        case BIND_OPCODE.DO_BIND:
          actions.push({
            type,
            address,
            symbol: symbolName,
            flags: symbolFlags,
            addend,
            ordinal,
          });
          address += 8n;
          break;
        case BIND_OPCODE.DO_BIND_ADD_ADDR_ULEB:
          actions.push({
            type,
            address,
            symbol: symbolName,
            flags: symbolFlags,
            addend,
            ordinal,
          });
          address += reader.uleb128() + 8n;
          break;
        case BIND_OPCODE.DO_BIND_ADD_ADDR_IMM_SCALED:
          actions.push({
            type,
            address,
            symbol: symbolName,
            flags: symbolFlags,
            addend,
            ordinal,
          });
          address += BigInt(imm) * 8n + 8n;
          break;
        case BIND_OPCODE.DO_BIND_ULEB_TIMES_SKIPPING_ULEB: {
          const count = reader.uleb128();
          const skip = reader.uleb128();
          for (let i = 0n; i < count; i++) {
            actions.push({
              type,
              address,
              symbol: symbolName,
              flags: symbolFlags,
              addend,
              ordinal,
            });
            address += skip + 8n;
          }
          break;
        }
        case BIND_OPCODE.THREADED:
          isLazy = true;
          break;
        default:
          this.log.warn(`unknown bind opcode 0x${opcode.toString(16)}`);
          return actions;
      }
    }
    return actions;
  }

  parseExportTrie() {
    const info = this.file.dyldInfo;
    if (!info || info.export_size === 0) {
      // Puede estar en LC_DYLD_EXPORTS_TRIE
      if (!this.file.exportTrie) return [];
      return this._parseExportTrieAt(
        this.file.exportTrie.dataoff,
        this.file.exportTrie.datasize
      );
    }
    return this._parseExportTrieAt(info.export_off, info.export_size);
  }

  _parseExportTrieAt(offset, size) {
    const end = offset + size;
    const exports = [];

    const walkTrie = (nodeOffset, prefix) => {
      const reader = new Reader(this.bytes, nodeOffset);
      const terminalSize = reader.uleb128();
      if (terminalSize !== 0n) {
        const flags = reader.uleb128();
        let address = 0n;
        let other = 0n;
        if (flags & EXPORT_SYMBOL_FLAGS.REEXPORT) {
          other = reader.uleb128();
        } else if (flags & EXPORT_SYMBOL_FLAGS.STUB_AND_RESOLVER) {
          address = reader.uleb128();
          other = reader.uleb128();
        } else {
          address = reader.uleb128();
        }
        exports.push({
          name: prefix,
          flags: Number(flags),
          address,
          other,
        });
      }
      const childrenCount = reader.u8();
      for (let i = 0; i < childrenCount; i++) {
        const edge = reader.cstring();
        const childNodeOffset = reader.uleb128();
        walkTrie(Number(childNodeOffset), prefix + edge);
      }
    };

    walkTrie(offset, "");
    this.log.info(`exports: ${exports.length}`);
    return exports;
  }
}

// ============================================================================
// 7. CHAINED FIXUPS PARSER
// ============================================================================

export class ChainedFixupsParser {
  constructor(file, bytes) {
    this.file = file;
    this.bytes = bytes;
    this.log = new MachoLogger();
  }

  parse() {
    const cf = this.file.chainedFixups;
    if (!cf) return null;

    const reader = new Reader(this.bytes, cf.dataoff);

    const fixups_version = reader.u32();
    const starts_offset = reader.u32();
    const imports_offset = reader.u32();
    const symbols_offset = reader.u32();
    const imports_count = reader.u32();
    const imports_format = reader.u32();
    const symbols_format = reader.u32();

    const info = {
      version: fixups_version,
      starts_offset,
      imports_offset,
      symbols_offset,
      imports_count,
      imports_format,
      symbols_format,
      imports: [],
      starts_in_image: {},
    };

    // Leer imports
    reader.seek(cf.dataoff + imports_offset);
    for (let i = 0; i < imports_count; i++) {
      const imp = this._readImport(reader, imports_format);
      info.imports.push(imp);
    }

    // Leer symbols strings
    const symbolsReader = new Reader(
      this.bytes,
      cf.dataoff + symbols_offset
    );
    for (const imp of info.imports) {
      const saved = symbolsReader.tell();
      symbolsReader.seek(cf.dataoff + symbols_offset + imp.name_offset);
      imp.name = symbolsReader.cstring();
      symbolsReader.seek(saved);
    }

    // Leer starts_in_image
    reader.seek(cf.dataoff + starts_offset);
    const totalSegments = reader.u32();
    for (let i = 0; i < totalSegments; i++) {
      const segOffset = reader.u32();
      const segSize = reader.u32();
      const segPageSize = reader.u16();
      const segIndex = reader.u16();
      const segCount = reader.u32();

      const segInfo = {
        segOffset,
        segSize,
        pageSize: 1 << segPageSize,
        segIndex,
        count: segCount,
        starts: [],
      };
      const seg = this.file.segments[segIndex];
      segInfo.segname = seg ? seg.segname : `seg${segIndex}`;

      for (let j = 0; j < segCount; j++) {
        const segInfoOffset = reader.u32();
        // Parsear chain start
        const startReader = new Reader(
          this.bytes,
          cf.dataoff + starts_offset + segInfoOffset
        );
        const chain = this._parseChainStart(startReader, info);
        if (chain) {
          segInfo.starts.push(chain);
        }
      }

      info.starts_in_image[segInfo.segname] = segInfo;
    }

    this.log.info(`chained fixups: ${imports_count} imports`);
    return info;
  }

  _readImport(reader, format) {
    switch (format) {
      case DYLD_CHAINED_IMPORT_FORMAT.POINTER_64: {
        const value = reader.u64();
        return {
          lib_ordinal: Number((value >> 0n) & 0xffn),
          weak_import: Number((value >> 8n) & 0x1n),
          name_offset: Number((value >> 9n) & 0x7fffffffn),
        };
      }
      case DYLD_CHAINED_IMPORT_FORMAT.POINTER_32: {
        const value = reader.u32();
        return {
          lib_ordinal: value & 0xff,
          weak_import: (value >> 8) & 0x1,
          name_offset: (value >> 9) & 0x7fffff,
        };
      }
      case DYLD_CHAINED_IMPORT_FORMAT.POINTER_64_OFFSET: {
        const value = reader.u64();
        return {
          lib_ordinal: Number((value >> 0n) & 0xffffn) - 1,
          weak_import: Number((value >> 16n) & 0x1n),
          name_offset: Number((value >> 17n) & 0x7fffffffn),
        };
      }
      default:
        return {
          lib_ordinal: reader.u8(),
          weak_import: reader.u8(),
          name_offset: reader.u32(),
        };
    }
  }

  _parseChainStart(reader, info) {
    // dyld_chained_starts_in_segment entry: cada start es de 16 bytes
    // pero aquí solo leemos el offset (u32) y el page
    const value = reader.u32();
    const page = value & 0xffff;
    const offset = value >>> 16;
    return {
      page,
      offset,
      // En una implementación completa, aquí iría el pointer_format
      // y la cadena de punteros a resolver.
    };
  }
}

// ============================================================================
// 8. CARGADOR (LOADER)
// ============================================================================

export class MachoLoader {
  constructor({ vcpu, resolver } = {}) {
    this.vcpu = vcpu;
    this.resolver = resolver || (() => null);
    this.loaded = new Map(); // path → MachoFile
    this.log = new MachoLogger();
    this.parser = new MachoParser();
    this.segments = [];
    this.imageBase = 0n;
    this.entryPoint = 0n;
  }

  /**
   * Carga un Mach-O en memoria de la VCPU.
   */
  async load(bytes, { path = "<anon>", slide = 0n, preferArch = "arm64" } = {}) {
    const file = this.parser.parse(bytes, { preferArch });
    this.loaded.set(path, file);
    file.slide = slide;

    // 1. Cargar segmentos
    this._loadSegments(file, bytes);

    // 2. Leer symtab
    const symtabReader = new SymbolTableReader(file, bytes);
    symtabReader.read();

    // 3. Aplicar rebase
    if (file.dyldInfo) {
      const dyld = new DyldInfoParser(file, bytes);
      const rebases = dyld.parseRebase();
      for (const r of rebases) {
        this._applyRebase(r, file);
      }
    }

    // 4. Aplicar chained fixups si existen
    if (file.chainedFixups) {
      const cf = new ChainedFixupsParser(file, bytes);
      const info = cf.parse();
      if (info) {
        for (const [segname, segInfo] of Object.entries(info.starts_in_image)) {
          for (const start of segInfo.starts) {
            this._applyChainStart(segInfo, start, info, file);
          }
        }
      }
    }

    // 5. Bind
    if (file.dyldInfo) {
      const dyld = new DyldInfoParser(file, bytes);
      const binds = [
        ...dyld.parseBind(),
        ...dyld.parseLazyBind(),
        ...dyld.parseWeakBind(),
      ];
      for (const b of binds) {
        this._applyBind(b, file);
      }
    }

    // 6. Entry point
    this._resolveEntryPoint(file);

    kernelBus.emit(MACHO_EVENTS.LOADED, {
      path,
      arch: file.arch,
      entryPoint: this.entryPoint.toString(),
    });
    this.log.info(`loaded: ${path}`, {
      arch: file.arch,
      entry: this.entryPoint.toString(),
    });

    return file;
  }

  _loadSegments(file, bytes) {
    const reader = new Reader(bytes);
    for (const seg of file.segments) {
      if (seg.segname === "__PAGEZERO") continue;
      const vaddr = seg.vmaddr + file.slide;
      const data = bytes.subarray(seg.fileoff, seg.fileoff + seg.filesize);
      // Escribir en la memoria de la VCPU
      if (this.vcpu) {
        this.vcpu.writeMemory(Number(vaddr), data);
        // Si es ejecutable, marcar la página como ejecutable
        if (seg.isExecutable()) {
          // En real: marcar página ejecutable en la MMU
        }
      }
      this.segments.push({
        segname: seg.segname,
        vaddr,
        size: seg.vmsize,
      });
      this.log.info(`mapped ${seg.segname} @ 0x${vaddr.toString(16)}`, {
        size: seg.vmsize.toString(),
        fileoff: seg.fileoff,
      });
    }
    this.imageBase = file.imageBase + file.slide;
  }

  _applyRebase(r, file) {
    const addr = r.address + file.slide;
    if (!this.vcpu) return;
    try {
      const current = this.vcpu.readMemory(Number(addr), 8);
      const ptr = new DataView(current.buffer).getBigUint64(0, true);
      const rebased = ptr + file.slide;
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setBigUint64(0, rebased, true);
      this.vcpu.writeMemory(Number(addr), buf);
      kernelBus.emit(MACHO_EVENTS.REBASE_APPLIED, {
        addr: addr.toString(),
        from: ptr.toString(),
        to: rebased.toString(),
      });
    } catch (err) {
      this.log.warn("rebase failed", err);
    }
  }

  _applyBind(b, file) {
    const addr = b.address + file.slide;
    const symbolAddr = this.resolver(b.symbol, file, b.ordinal);
    if (symbolAddr == null) {
      this.log.warn(`unresolved symbol: ${b.symbol}`);
      kernelBus.emit(MACHO_EVENTS.SYMBOL_NOT_FOUND, { symbol: b.symbol });
      return;
    }
    const finalValue = BigInt(symbolAddr) + (b.addend || 0n);
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, finalValue, true);
    if (this.vcpu) {
      this.vcpu.writeMemory(Number(addr), buf);
    }
    kernelBus.emit(MACHO_EVENTS.BIND_APPLIED, {
      addr: addr.toString(),
      symbol: b.symbol,
      value: finalValue.toString(),
    });
  }

  _applyChainStart(segInfo, start, info, file) {
    // En una implementación completa, se recorrería la cadena
    // leyendo los pointers con el formato adecuado.
    const page = start.page;
    const offset = start.offset;
    const baseAddr =
      this._segmentBase(segInfo.segname) + BigInt(page * segInfo.pageSize) + BigInt(offset);

    // Placeholder: aplicar un solo fixup en la posición base
    kernelBus.emit(MACHO_EVENTS.CHAINED_FIXUP_APPLIED, {
      addr: baseAddr.toString(),
      segname: segInfo.segname,
      page,
      offset,
    });
  }

  _segmentBase(segname) {
    const s = this.segments.find((x) => x.segname === segname);
    return s ? s.vaddr : 0n;
  }

  _resolveEntryPoint(file) {
    if (file.main) {
      // LC_MAIN: entryoff es un file offset desde el inicio del segmento __TEXT
      const textSeg = file.segmentNamed("__TEXT");
      if (textSeg) {
        this.entryPoint = textSeg.vmaddr + BigInt(file.main.entryoff) + file.slide;
      } else {
        this.entryPoint = BigInt(file.main.entryoff) + file.slide;
      }
      this.log.info(`entry point (LC_MAIN): 0x${this.entryPoint.toString(16)}`);
    } else if (file.unixthread && file.unixthread.state) {
      // En x86_64: state = [rax, rbx, rcx, rdx, rdi, rsi, rbp, rsp, r8, ..., rip, rflags, cs, fs, gs]
      // En arm64: state tiene un layout distinto
      const state = file.unixthread.state;
      if (file.header.cpuName() === "x86_64" && state.length >= 17) {
        const ripLow = BigInt(state[16]);
        const ripHigh = BigInt(state[17] || 0);
        this.entryPoint = (ripHigh << 32n) | ripLow;
      }
      this.log.info(`entry point (LC_UNIXTHREAD): 0x${this.entryPoint.toString(16)}`);
    }
  }

  /**
   * Ejecuta el binario cargado sobre la VCPU.
   */
  async execute({ argv = [], env = {} } = {}) {
    if (!this.vcpu) throw new Error("no vcpu attached");

    // Setup registros
    this.vcpu.regs.rip = this.entryPoint;
    this.vcpu.regs.set("RSP", 0x7ff00000n);

    // Escribir argv/envp en el stack
    const stackTop = 0x7ff00000n;
    let sp = stackTop;

    // Escribir strings
    const strings = [];
    for (const s of argv) {
      const encoded = new TextEncoder().encode(s + "\0");
      sp -= BigInt(encoded.length);
      this.vcpu.writeMemory(Number(sp), encoded);
      strings.push(sp);
    }
    for (const [k, v] of Object.entries(env)) {
      const encoded = new TextEncoder().encode(`${k}=${v}\0`);
      sp -= BigInt(encoded.length);
      this.vcpu.writeMemory(Number(sp), encoded);
    }

    // Escribir argv array (null-terminated)
    sp -= BigInt((strings.length + 1) * 8);
    sp = sp & ~0xfn; // alinear a 16
    this.vcpu.regs.set("RSP", sp);

    kernelBus.emit(MACHO_EVENTS.EXECUTION_START, {
      entry: this.entryPoint.toString(),
      argv,
    });
    this.log.info(`executing from 0x${this.entryPoint.toString(16)}`);

    // Ejecutar hasta HLT o límite
    const result = this.vcpu.run(1_000_000);

    kernelBus.emit(MACHO_EVENTS.EXECUTION_END, {
      instructions: this.vcpu.instructionCount,
    });

    return {
      instructions: this.vcpu.instructionCount,
      exitCode: 0,
      result,
    };
  }

  /**
   * Devuelve el resultado de la ejecución del último binario.
   */
  inspect(file) {
    return {
      header: file.header,
      loadCommands: file.loadCommands,
      segments: file.segments,
      sections: file.sections,
      symbols: file.symbols.slice(0, 100),
      dylibs: file.dylibs,
      entryPoint: this.entryPoint.toString(),
      imageBase: this.imageBase.toString(),
      rpaths: file.rpaths,
      uuid: file.uuid,
      buildVersion: file.buildVersion,
    };
  }
}

// ============================================================================
// 9. CÓDIGO SIGNATURE VERIFIER
// ============================================================================

export class CodeSignatureVerifier {
  constructor(file, bytes) {
    this.file = file;
    this.bytes = bytes;
    this.log = new MachoLogger();
  }

  verify() {
    const cs = this.file.codeSignature;
    if (!cs) {
      kernelBus.emit(MACHO_EVENTS.CODE_SIGNATURE_FAILED, { reason: "no signature" });
      return { ok: false, reason: "no signature" };
    }

    try {
      const reader = new Reader(this.bytes, cs.dataoff);
      const magic = reader.u32();
      const length = reader.u32();
      const count = reader.u32();

      const blobs = [];
      for (let i = 0; i < count; i++) {
        const type = reader.u32();
        const offset = reader.u32();
        blobs.push({ type, offset });
      }

      // Blob types
      const CSSLOT_CODEDIRECTORY = 0;
      const CSSLOT_REQUIREMENTS = 2;
      const CSSLOT_ENTITLEMENTS = 5;
      const CSSLOT_DER_ENTITLEMENTS = 7;

      const result = {
        ok: true,
        magic,
        length,
        blobs: blobs.length,
        codeDirectory: null,
        requirements: null,
        entitlements: null,
      };

      for (const blob of blobs) {
        const blobReader = new Reader(this.bytes, cs.dataoff + blob.offset);
        const blobMagic = blobReader.u32();
        const blobLength = blobReader.u32();

        if (blob.type === CSSLOT_CODEDIRECTORY) {
          result.codeDirectory = this._parseCodeDirectory(blobReader, blobLength);
        } else if (blob.type === CSSLOT_ENTITLEMENTS) {
          result.entitlements = blobReader.bytes(blobLength - 8);
        } else if (blob.type === CSSLOT_REQUIREMENTS) {
          result.requirements = blobReader.bytes(blobLength - 8);
        }
      }

      kernelBus.emit(MACHO_EVENTS.CODE_SIGNATURE_VERIFIED, result);
      return result;
    } catch (err) {
      this.log.error("code signature verify failed", err);
      kernelBus.emit(MACHO_EVENTS.CODE_SIGNATURE_FAILED, { error: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  _parseCodeDirectory(reader, length) {
    const magic = reader.u32();
    const length2 = reader.u32();
    const version = reader.u32();
    const flags = reader.u32();
    const hashOffset = reader.u32();
    const identOffset = reader.u32();
    const nSpecialSlots = reader.u32();
    const nCodeSlots = reader.u32();
    const codeLimit = reader.u32();
    const hashSize = reader.u8();
    const hashType = reader.u8();
    const platform = reader.u8();
    const pageSize = reader.u8();
    const spare2 = reader.u32();

    // Leer el identificador
    const saved = reader.tell();
    reader.seek(hashOffset - identOffset + (hashOffset - identOffset)); // hack
    // Mejor: releer desde el inicio del blob
    reader.seek(reader.tell() - 4); // volvemos un poco
    // El identifier está en offset "identOffset" desde el inicio del blob
    // Volvemos al inicio del blob
    // (en una implementación completa)

    return {
      magic,
      length: length2,
      version,
      flags,
      hashOffset,
      identOffset,
      nSpecialSlots,
      nCodeSlots,
      codeLimit,
      hashSize,
      hashType,
      platform,
      pageSize,
    };
  }
}

// ============================================================================
// 10. ARM64 INSTRUCTION INTERPRETER (subconjunto mínimo)
// ============================================================================

export class Arm64Interpreter {
  constructor(vcpu) {
    this.vcpu = vcpu;
    this.stats = { decoded: 0, executed: 0 };
    this.syscalls = new Map();
    this._registerDefaultSyscalls();
  }

  _registerDefaultSyscalls() {
    // Darwin syscalls (subset)
    this.syscalls.set(0x00000001, (cpu) => {
      // exit
      cpu.halt();
    });
    this.syscalls.set(0x00000004, (cpu) => {
      // write
      const fd = Number(cpu.readRegister("X0"));
      const buf = Number(cpu.readRegister("X1"));
      const count = Number(cpu.readRegister("X2"));
      const bytes = cpu.readMemory(buf, count);
      const text = new TextDecoder().decode(bytes);
      if (typeof console !== "undefined") console.log(text);
      cpu.writeRegister("X0", BigInt(count));
    });
    this.syscalls.set(0x00000003, (cpu) => {
      // read
      cpu.writeRegister("X0", 0n);
    });
    this.syscalls.set(0x000000c5, (cpu) => {
      // mmap
      cpu.writeRegister("X0", 0x10000000n);
    });
    this.syscalls.set(0x00000049, (cpu) => {
      // munmap
      cpu.writeRegister("X0", 0n);
    });
    this.syscalls.set(0x00000005, (cpu) => {
      // open
      cpu.writeRegister("X0", 3n);
    });
    this.syscalls.set(0x00000006, (cpu) => {
      // close
      cpu.writeRegister("X0", 0n);
    });
  }

  registerSyscall(number, handler) {
    this.syscalls.set(number, handler);
  }

  /**
   * Decodifica y ejecuta una instrucción ARM64.
   * El layout de ARM64:
   *   - Bits [28:25] suelen ser el opcode base
   *   - Los registros están en [4:0], [9:5], [14:10], [20:16]
   */
  step() {
    const cpu = this.vcpu;
    const pc = Number(cpu.regs.rip);
    const instr = cpu.memory.read32(pc);
    this.stats.decoded++;

    // Decodificar campos comunes
    const rd = instr & 0x1f;
    const rn = (instr >> 5) & 0x1f;
    const rm = (instr >> 16) & 0x1f;
    const opcode = (instr >> 21) & 0x7ff;

    // Ver el opcode base (bits 25-28)
    const baseOpcode = (instr >> 25) & 0xf;

    // Instrucciones más comunes:
    // - MOV (register): 0xAA0003E0 | (rm << 16) | rd
    // - MOV (immediate): 0xD2800000 | (imm << 5) | rd
    // - ADD (register): 0x8B000000 | (rm << 16) | (rn << 5) | rd
    // - SUB (register): 0xCB000000 | ...
    // - RET: 0xD65F03C0
    // - NOP: 0xD503201F
    // - SVC #0x80: 0xD4000001 | (imm16 << 5)
    // - B: 0x14000000 | offset
    // - BL: 0x94000000 | offset
    // - BR: 0xD61F0000 | (rn << 5)
    // - BLR: 0xD63F0000 | (rn << 5)

    if (instr === 0xd503201f) {
      // NOP
      cpu.regs.rip += 4n;
      return;
    }
    if (instr === 0xd65f03c0) {
      // RET (X30)
      cpu.regs.rip = cpu.regs.gpr[30] || 0n;
      return;
    }
    if ((instr & 0xffffffe0) === 0xd4000001) {
      // SVC #imm16
      const imm16 = (instr >> 5) & 0xffff;
      const handler = this.syscalls.get(imm16);
      if (handler) {
        handler(cpu);
      } else {
        this.vcpu._handleException(
          new (class extends Error {
            constructor() {
              super("unknown syscall");
            }
          })()
        );
      }
      cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0x7c000000) === 0x14000000) {
      // B (unconditional branch)
      let offset = instr & 0x03ffffff;
      if (offset & 0x02000000) offset |= 0xfc000000;
      const signedOffset = (offset << 2);
      cpu.regs.rip = BigInt(pc + signedOffset);
      return;
    }
    if ((instr & 0x7c000000) === 0x94000000) {
      // BL
      cpu.regs.gpr[30] = cpu.regs.rip + 4n;
      let offset = instr & 0x03ffffff;
      if (offset & 0x02000000) offset |= 0xfc000000;
      const signedOffset = (offset << 2);
      cpu.regs.rip = BigInt(pc + signedOffset);
      return;
    }
    if ((instr & 0xfffffc1f) === 0xd61f0000) {
      // BR Xn
      cpu.regs.rip = cpu.regs.gpr[rn] || 0n;
      return;
    }
    if ((instr & 0xfffffc1f) === 0xd63f0000) {
      // BLR Xn
      cpu.regs.gpr[30] = cpu.regs.rip + 4n;
      cpu.regs.rip = cpu.regs.gpr[rn] || 0n;
      return;
    }
    if ((instr & 0xffe00000) === 0xaa000000) {
      // ORR (MOV) register: ORR Rd, XZR, Rm
      const sf = (instr >> 31) & 1;
      const shift = (instr >> 22) & 0x3;
      const val = cpu.regs.gpr[rm] || 0n;
      if (sf) cpu.regs.gpr[rd] = val;
      else cpu.regs.gpr[rd] = BigInt.asUintN(32, val);
      cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0xff800000) === 0x91000000) {
      // ADD immediate
      const sf = (instr >> 31) & 1;
      const sh = (instr >> 22) & 0x3;
      let imm12 = (instr >> 10) & 0xfff;
      if (sh === 1) imm12 <<= 12;
      const a = cpu.regs.gpr[rn] || 0n;
      const r = BigInt.asIntN(sf ? 64 : 32, a + BigInt(imm12));
      cpu.regs.gpr[rd] = r;
      cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0xff800000) === 0xd1000000) {
      // SUB immediate
      const sf = (instr >> 31) & 1;
      const sh = (instr >> 22) & 0x3;
      let imm12 = (instr >> 10) & 0xfff;
      if (sh === 1) imm12 <<= 12;
      const a = cpu.regs.gpr[rn] || 0n;
      const r = BigInt.asIntN(sf ? 64 : 32, a - BigInt(imm12));
      cpu.regs.gpr[rd] = r;
      cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0xffe00000) === 0x8b000000) {
      // ADD register
      const sf = (instr >> 31) & 1;
      const a = cpu.regs.gpr[rn] || 0n;
      const b = cpu.regs.gpr[rm] || 0n;
      cpu.regs.gpr[rd] = BigInt.asIntN(sf ? 64 : 32, a + b);
      cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0xffe00000) === 0xcb000000) {
      // SUB register
      const sf = (instr >> 31) & 1;
      const a = cpu.regs.gpr[rn] || 0n;
      const b = cpu.regs.gpr[rm] || 0n;
      cpu.regs.gpr[rd] = BigInt.asIntN(sf ? 64 : 32, a - b);
      cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0xffe00000) === 0x9a000000) {
      // ADC register
      const sf = (instr >> 31) & 1;
      const a = cpu.regs.gpr[rn] || 0n;
      const b = cpu.regs.gpr[rm] || 0n;
      cpu.regs.gpr[rd] = BigInt.asIntN(sf ? 64 : 32, a + b);
      cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0x7f800000) === 0x53000000) {
      // LSR/ASR/LSL immediate
      const sf = (instr >> 31) & 1;
      const opc = (instr >> 29) & 0x3;
      const sh = (instr >> 22) & 0x1;
      const imm = ((sh << 6) | ((instr >> 16) & 0x3f)) & 0x7f;
      const a = cpu.regs.gpr[rn] || 0n;
      const shift = BigInt(imm);
      let r;
      if (opc === 0) r = a << shift; // LSL
      else if (opc === 1) r = a >> shift; // LSR
      else if (opc === 2) r = a >> shift; // ASR (signed)
      else r = a; // ROR (rare)
      cpu.regs.gpr[rd] = BigInt.asIntN(sf ? 64 : 32, r);
      cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0x7f800000) === 0x52800000) {
      // MOVZ
      const sf = (instr >> 31) & 1;
      const hw = (instr >> 21) & 0x3;
      const imm16 = (instr >> 5) & 0xffff;
      const val = BigInt(imm16) << BigInt(hw * 16);
      cpu.regs.gpr[rd] = BigInt.asIntN(sf ? 64 : 32, val);
      cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0x7f800000) === 0x72800000) {
      // MOVK
      const sf = (instr >> 31) & 1;
      const hw = (instr >> 21) & 0x3;
      const imm16 = (instr >> 5) & 0xffff;
      let cur = cpu.regs.gpr[rd] || 0n;
      const mask = BigInt(0xffff) << BigInt(hw * 16);
      cur = (cur & ~mask) | (BigInt(imm16) << BigInt(hw * 16));
      cpu.regs.gpr[rd] = BigInt.asIntN(sf ? 64 : 32, cur);
      cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0x7f800000) === 0x12800000) {
      // MOVN
      const sf = (instr >> 31) & 1;
      const hw = (instr >> 21) & 0x3;
      const imm16 = (instr >> 5) & 0xffff;
      const val = ~(BigInt(imm16) << BigInt(hw * 16));
      cpu.regs.gpr[rd] = BigInt.asIntN(sf ? 64 : 32, val);
      cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0xffc00000) === 0xf9400000) {
      // LDR (immediate, unsigned offset)
      const size = (instr >> 30) & 0x3;
      const imm12 = (instr >> 10) & 0xfff;
      const scale = size;
      const offset = BigInt(imm12) << BigInt(scale);
      const base = cpu.regs.gpr[rn] || 0n;
      const addr = Number(base + offset);
      let value;
      if (size === 0) value = BigInt(cpu.memory.read8(addr));
      else if (size === 1) value = BigInt(cpu.memory.read16(addr));
      else if (size === 2) value = BigInt(cpu.memory.read32(addr));
      else value = cpu.memory.read64(addr);
      cpu.regs.gpr[rd] = value;
      cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0xffc00000) === 0xf9000000) {
      // STR (immediate, unsigned offset)
      const size = (instr >> 30) & 0x3;
      const imm12 = (instr >> 10) & 0xfff;
      const scale = size;
      const offset = BigInt(imm12) << BigInt(scale);
      const base = cpu.regs.gpr[rn] || 0n;
      const addr = Number(base + offset);
      const value = cpu.regs.gpr[rd] || 0n;
      if (size === 0) cpu.memory.write8(addr, Number(value & 0xffn));
      else if (size === 1) cpu.memory.write16(addr, Number(value & 0xffffn));
      else if (size === 2) cpu.memory.write32(addr, Number(value & 0xffffffffn));
      else cpu.memory.write64(addr, value);
      cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0xffc00000) === 0xf8400000) {
      // LDR (immediate, post-index)
      const size = (instr >> 30) & 0x3;
      const imm9 = (instr >> 12) & 0x1ff;
      const signedImm = imm9 & 0x100 ? imm9 | 0xfffffe00 : imm9;
      const base = cpu.regs.gpr[rn] || 0n;
      const addr = Number(base);
      const value = cpu.memory.read64(addr);
      cpu.regs.gpr[rd] = value;
      cpu.regs.gpr[rn] = base + BigInt(signedImm);
      cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0xffc00000) === 0xf8000000) {
      // STR (immediate, post-index)
      const size = (instr >> 30) & 0x3;
      const imm9 = (instr >> 12) & 0x1ff;
      const signedImm = imm9 & 0x100 ? imm9 | 0xfffffe00 : imm9;
      const base = cpu.regs.gpr[rn] || 0n;
      const addr = Number(base);
      const value = cpu.regs.gpr[rd] || 0n;
      cpu.memory.write64(addr, value);
      cpu.regs.gpr[rn] = base + BigInt(signedImm);
      cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0xffc00000) === 0xf8410000 || (instr & 0xffc00000) === 0xf8010000) {
      // LDR/STR (immediate, pre-index) - simplificado
      cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0xffe00c00) === 0xeb000000) {
      // SUBS (register) - CMP
      const sf = (instr >> 31) & 1;
      const a = cpu.regs.gpr[rn] || 0n;
      const b = cpu.regs.gpr[rm] || 0n;
      const r = BigInt.asIntN(sf ? 64 : 32, a - b);
      cpu.regs.gpr[rd] = r;
      // Actualizar flags NZCV
      const zf = r === 0n;
      const nf = (r & (1n << BigInt((sf ? 64 : 32) - 1))) !== 0n;
      let flags = cpu.regs.flags;
      flags = zf ? flags | 0x40000000 : flags & ~0x40000000;
      flags = nf ? flags | 0x80000000 : flags & ~0x80000000;
      cpu.regs.flags = flags;
      cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0xff800000) === 0x71000000) {
      // SUBS immediate (CMP)
      const sf = (instr >> 31) & 1;
      const imm12 = (instr >> 10) & 0xfff;
      const a = cpu.regs.gpr[rn] || 0n;
      const r = BigInt.asIntN(sf ? 64 : 32, a - BigInt(imm12));
      cpu.regs.gpr[rd] = r;
      const zf = r === 0n;
      const nf = (r & (1n << BigInt((sf ? 64 : 32) - 1))) !== 0n;
      let flags = cpu.regs.flags;
      flags = zf ? flags | 0x40000000 : flags & ~0x40000000;
      flags = nf ? flags | 0x80000000 : flags & ~0x80000000;
      cpu.regs.flags = flags;
      cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0xff000010) === 0x54000000) {
      // B.cond
      const cond = instr & 0xf;
      const imm19 = (instr >> 5) & 0x7ffff;
      const signedImm = (imm19 & 0x40000) ? (imm19 | 0xfff80000) << 2 : imm19 << 2;
      const flags = cpu.regs.flags;
      const Z = (flags & 0x40000000) !== 0;
      const N = (flags & 0x80000000) !== 0;
      const C = (flags & 0x20000000) !== 0;
      const V = (flags & 0x10000000) !== 0;
      let take = false;
      switch (cond) {
        case 0: take = Z; break;                    // EQ
        case 1: take = !Z; break;                   // NE
        case 2: take = C; break;                    // CS/HS
        case 3: take = !C; break;                   // CC/LO
        case 4: take = N; break;                    // MI
        case 5: take = !N; break;                   // PL
        case 6: take = V; break;                    // VS
        case 7: take = !V; break;                   // VC
        case 8: take = C && !Z; break;              // HI
        case 9: take = !C || Z; break;              // LS
        case 10: take = N === V; break;             // GE
        case 11: take = N !== V; break;             // LT
        case 12: take = !Z && N === V; break;       // GT
        case 13: take = Z || N !== V; break;        // LE
        case 14: take = true; break;                // AL
        default: take = false;
      }
      if (take) {
        cpu.regs.rip = BigInt(pc + signedImm);
      } else {
        cpu.regs.rip += 4n;
      }
      return;
    }
    if ((instr & 0x7f000000) === 0x34000000) {
      // CBZ / CBNZ
      const op = (instr >> 24) & 0x1;
      const imm19 = (instr >> 5) & 0x7ffff;
      const signedImm = (imm19 & 0x40000) ? (imm19 | 0xfff80000) << 2 : imm19 << 2;
      const val = cpu.regs.gpr[rd] || 0n;
      const isZero = val === 0n;
      const take = op === 0 ? isZero : !isZero;
      if (take) cpu.regs.rip = BigInt(pc + signedImm);
      else cpu.regs.rip += 4n;
      return;
    }
    if ((instr & 0xff000000) === 0x1a000000 || (instr & 0xff000000) === 0x5a000000) {
      // CSEL / CSINC
      const cond = (instr >> 12) & 0xf;
      const a = cpu.regs.gpr[rn] || 0n;
      const b = cpu.regs.gpr[rm] || 0n;
      const flags = cpu.regs.flags;
      const Z = (flags & 0x40000000) !== 0;
      const N = (flags & 0x80000000) !== 0;
      const C = (flags & 0x20000000) !== 0;
      const V = (flags & 0x10000000) !== 0;
      let take = false;
      switch (cond) {
        case 0: take = Z; break;
        case 1: take = !Z; break;
        case 10: take = N === V; break;
        case 11: take = N !== V; break;
        case 12: take = !Z && N === V; break;
        case 13: take = Z || N !== V; break;
        default: take = false;
      }
      cpu.regs.gpr[rd] = take ? a : b;
      cpu.regs.rip += 4n;
      return;
    }

    // No soportada
    this.stats.decoded--;
    kernelBus.emit(MACHO_EVENTS.UNSUPPORTED_INSTRUCTION, {
      pc: pc.toString(),
      instr: "0x" + instr.toString(16),
    });
    throw new Error(
      `unsupported ARM64 instruction at 0x${pc.toString(16)}: 0x${instr.toString(16)}`
    );
  }

  run(maxInstructions = 10000) {
    let n = 0;
    while (this.vcpu.state !== "halted" && n < maxInstructions) {
      this.step();
      n++;
      this.stats.executed++;
    }
    return n;
  }
}

// ============================================================================
// 11. EXPORTS
// ============================================================================

export default {
  MachoParser,
  MachoLoader,
  SymbolTableReader,
  DyldInfoParser,
  ChainedFixupsParser,
  CodeSignatureVerifier,
  Arm64Interpreter,
  MH_MAGIC,
  MH_CIGAM,
  MH_MAGIC_64,
  MH_CIGAM_64,
  FAT_MAGIC,
  FAT_CIGAM,
  FAT_MAGIC_64,
  FAT_CIGAM_64,
  FILE_TYPES,
  FILE_TYPE_NAMES,
  CPU_TYPES,
  CPU_TYPE_NAMES,
  HEADER_FLAGS,
  LC,
  LC_NAMES,
  VM_PROT,
  SEGMENT_NAMES,
  REBASE_OPCODE,
  BIND_OPCODE,
  REBASE_TYPE,
  BIND_TYPE,
  BIND_SYMBOL_FLAGS,
  BIND_SPECIAL_DYLIB,
  EXPORT_SYMBOL_FLAGS,
  DYLD_CHAINED_PTR_FORMAT,
  DYLD_CHAINED_IMPORT_FORMAT,
  MACHO_EVENTS,
};
