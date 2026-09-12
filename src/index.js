// ============================================================================
// index.js — Barrel export de rainOS
// ----------------------------------------------------------------------------
// Punto de entrada del paquete npm. Reexporta todos los módulos públicos.
//
// Uso:
//   import { WindowManagerProvider, useWindowManager } from "rainos";
//   import { Desktop, MenuBar, Dock } from "rainos";
//   import { Finder, Safari, Music, Photos } from "rainos";
//
// Lo que NO se exporta aquí:
//   - src/App.jsx    → es solo la demo
//   - src/main.jsx   → es solo el entry point de la demo
//   - src/security/* → algunos helpers internos
// ============================================================================

// ============================================================================
// 1. KERNEL — gestor de ventanas
// ============================================================================
export * from "./kernel";

// ============================================================================
// 2. CADENA DE ARRANQUE
// ============================================================================
export * from "./bootstrap";
export * from "./bootloader";
export * from "./safeboot";
export * from "./scheduler";

// ============================================================================
// 3. CPU / GPU VIRTUALES
// ============================================================================
export * from "./VCPU";

// vgpu puede tener colisiones con VCPU (por ejemplo `Vec4`, `Mat4`)
// Por eso exportamos solo lo importante de vgpu.
export {
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
  VramManager,
  ShaderCompiler,
  ShaderVm,
  GpuBuffer,
  GpuTexture,
  RenderTarget,
  PipelineState,
  Rasterizer,
  CommandBuffer,
  DisplayController,
} from "./vgpu/vgpu.jsx";

// swiftui-bridge
export {
  SwiftUIBridge,
  SwiftUIProvider,
  useSwiftUI,
  SwiftUI,
  UIKit,
  AppKit,
  AVKit,
  CoreImage,
  CoreAnimation,
  Metal,
} from "./vgpu/swiftui-bridge.jsx";

// ============================================================================
// 4. MACH-O — cargador y ejecutor de binarios
// ============================================================================
export * from "./macho";

// ============================================================================
// 5. SEGURIDAD
// ============================================================================
export * from "./security";

// ============================================================================
// 6. INSTALACIÓN Y CONFIGURACIÓN INICIAL
// ============================================================================
export * from "./startupinstaller";
export * from "./initialconfig";
export * from "./initsystem";

// ============================================================================
// 7. BLOQUEO
// ============================================================================
export * from "./lockscreen";

// ============================================================================
// 8. CHROME DEL ESCRITORIO
// ============================================================================
export * from "./desktop";
export * from "./menubar";
export * from "./dock";
export * from "./launchpad";
export * from "./spotlight";
export * from "./notifications";
export * from "./missioncontrol";
export * from "./controlcenter";
export * from "./appswitcher";
export * from "./toast";

// ============================================================================
// 9. INSTALADORES
// ============================================================================
export * from "./appinstaller";
export * from "./dmginstaller";
export * from "./updater";

// ============================================================================
// 10. RUNTIME DE APPS
// ============================================================================
export * from "./runtime";

// ============================================================================
// 11. APPS DEL SISTEMA
// ============================================================================
export * from "./apps";

// ============================================================================
// 12. METADATA
// ============================================================================

export const RAINOS_VERSION = "0.1.0";
export const RAINOS_NAME = "rainOS";
export const RAINOS_CODENAME = "Sonoma";

export const RAINOS_INFO = Object.freeze({
  name: RAINOS_NAME,
  version: RAINOS_VERSION,
  codename: RAINOS_CODENAME,
  builtWith: "React 18",
  architecture: "arm64, x86_64",
});
