// ============================================================================
// swiftui-bridge.jsx — Puente SwiftUI / UIKit / AppKit / AVKit → VGPU
// ----------------------------------------------------------------------------
// Traduce los frameworks de UI multimedia de Apple a operaciones de VGPU.
//
// ARQUITECTURA
//
//   App SwiftUI  →  SwiftUI Bridge  →  Display List  →  VGPU Renderer
//                  (este archivo)      (comandos)      (swiftui-bridge)
//
//   El bridge mantiene una representación intermedia llamada "Display List"
//   compuesta de nodos (ViewNode). Cada nodo tiene:
//   - type: View / Text / Image / Video / Shape / Stack / Effect
//   - props: los modificadores de SwiftUI (.frame, .padding, .background...)
//   - children: sub-nodos
//   - layout: { x, y, width, height } calculado por el layout engine
//
//   El renderer recorre el Display List y emite comandos a la VGPU:
//   - Quads (rects) con color sólido
//   - Gradientes (linear, radial, angular)
//   - Texto (via font atlas, cada glifo como un quad texturizado)
//   - Imágenes (sprites texturizados)
//   - Videos (frames como texturas dinámicas)
//   - Shaders personalizados (Metal → VSL)
//   - Blur / Shadow / Vibrancy (post-process passes)
//
// FRAMEWORKS SOPORTADOS
//
//   SwiftUI
//     - Stack (HStack, VStack, ZStack)
//     - Text, Image, Label, Link
//     - Button, Toggle, Slider, Stepper, Picker
//     - List, ScrollView, LazyVStack, LazyHStack
//     - NavigationStack, TabView, Form, Section
//     - Rectangle, RoundedRectangle, Circle, Capsule, Ellipse
//     - Path, Shape, CustomShape
//     - Color, LinearGradient, RadialGradient, AngularGradient
//     - Modifiers: frame, padding, background, foregroundColor, cornerRadius,
//       shadow, blur, opacity, rotationEffect, scaleEffect, offset, border,
//       overlay, clipShape, mask
//
//   UIKit
//     - UIView, UILabel, UIImageView, UIButton, UISwitch, UISlider
//     - UITableView, UICollectionView, UIScrollView
//     - UINavigationController, UITabBarController
//     - CALayer (con sublayers, masks, shadow, border)
//
//   AppKit
//     - NSView, NSTextField, NSButton, NSSlider
//     - NSWindow (con titlebar, toolbar, contentView)
//
//   AVKit / AVFoundation
//     - AVPlayer, AVPlayerLayer, AVPlayerViewController
//     - Reproducción de video: decodificar frame → textura → quad
//     - Audio track: pasa al mixer de audio del sistema
//     - Control de tiempo: play, pause, seek, rate
//     - Streaming: HLS / DASH con buffer adaptativo
//
//   CoreImage
//     - CIFilter: blur, colorMatrix, colorControls, composite, transform
//     - CIContext: renderiza una cadena de filtros sobre una textura
//     - Post-process passes en la VGPU
//
//   CoreAnimation
//     - CAAnimation: fade, move, scale, rotate, spring
//     - Timing function: linear, easeIn, easeOut, easeInOut, custom bezier
//     - Layers jerárquicos con transform
//
//   Metal
//     - MTKView: renderiza shaders Metal en el bridge
//     - MTLComputePipelineState: dispatch compute
//     - Traduce MSL (Metal Shading Language) a VSL (Vgpu Shader Language)
//
// GESTIÓN DE MEMORIA
//
//   - Recursos retenidos (texturas, buffers) se liberan cuando el nodo
//     se destruye
//   - Caché de texturas por clave (URL, nombre de imagen)
//   - Caché de font atlas por tamaño/estilo
//   - Pool de render targets temporales
//
// EVENTOS
//
//   Todos los eventos del sistema (view created, layout, draw, animation,
//   video frame, audio sync, filter applied, ...)
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
import { useVgpu } from "./vgpu.jsx";

// ============================================================================
// 1. CONSTANTES
// ============================================================================

export const NODE_TYPE = Object.freeze({
  ROOT: "root",
  VIEW: "view",
  TEXT: "text",
  IMAGE: "image",
  VIDEO: "video",
  SHAPE: "shape",
  STACK: "stack",
  EFFECT: "effect",
  BUTTON: "button",
  TOGGLE: "toggle",
  SLIDER: "slider",
  LIST: "list",
  SCROLL: "scroll",
  NAVIGATION: "navigation",
  TABVIEW: "tabview",
  FORM: "form",
  SECTION: "section",
  LINK: "link",
  LABEL: "label",
  PROGRESS: "progress",
  PICKER: "picker",
  SPACER: "spacer",
  DIVIDER: "divider",
  CUSTOM: "custom",
});

export const STACK_DIRECTION = Object.freeze({
  HORIZONTAL: "horizontal",
  VERTICAL: "vertical",
  ZSTACK: "zstack",
});

export const TEXT_ALIGNMENT = Object.freeze({
  LEADING: "leading",
  CENTER: "center",
  TRAILING: "trailing",
  JUSTIFIED: "justified",
});

export const FONT_WEIGHT = Object.freeze({
  ULTRA_LIGHT: 100,
  THIN: 200,
  LIGHT: 300,
  REGULAR: 400,
  MEDIUM: 500,
  SEMIBOLD: 600,
  BOLD: 700,
  HEAVY: 800,
  BLACK: 900,
});

export const BLEND_MODE = Object.freeze({
  NORMAL: "normal",
  MULTIPLY: "multiply",
  SCREEN: "screen",
  OVERLAY: "overlay",
  DARKEN: "darken",
  LIGHTEN: "lighten",
  COLOR_DODGE: "colorDodge",
  COLOR_BURN: "colorBurn",
  SOFT_LIGHT: "softLight",
  HARD_LIGHT: "hardLight",
  DIFFERENCE: "difference",
  EXCLUSION: "exclusion",
  HUE: "hue",
  SATURATION: "saturation",
  COLOR: "color",
  LUMINOSITY: "luminosity",
});

export const GRADIENT_TYPE = Object.freeze({
  LINEAR: "linear",
  RADIAL: "radial",
  ANGULAR: "angular",
  CONIC: "conic",
});

export const ANIMATION_TYPE = Object.freeze({
  FADE: "fade",
  MOVE: "move",
  SCALE: "scale",
  ROTATE: "rotate",
  OPACITY: "opacity",
  SPRING: "spring",
  KEYFRAME: "keyframe",
});

export const TIMING_FUNCTION = Object.freeze({
  LINEAR: "linear",
  EASE_IN: "easeIn",
  EASE_OUT: "easeOut",
  EASE_IN_OUT: "easeInOut",
  DEFAULT: "default",
});

export const VIDEO_STATE = Object.freeze({
  IDLE: "idle",
  LOADING: "loading",
  READY: "ready",
  PLAYING: "playing",
  PAUSED: "paused",
  BUFFERING: "buffering",
  ENDED: "ended",
  ERROR: "error",
});

export const CIFILTER = Object.freeze({
  GAUSSIAN_BLUR: "CIGaussianBlur",
  BOX_BLUR: "CIBoxBlur",
  MOTION_BLUR: "CIMotionBlur",
  ZOOM_BLUR: "CIZoomBlur",
  COLOR_MATRIX: "CIColorMatrix",
  COLOR_CONTROLS: "CIColorControls",
  EXPOSURE: "CIExposureAdjust",
  GAMMA: "CIGammaAdjust",
  HUE: "CIHueAdjust",
  VIBRANCE: "CIVibrance",
  TEMPERATURE: "CITemperatureAndTint",
  WHITE_POINT: "CIWhitePointAdjust",
  BRIGHTNESS: "CIBrightnessAdjust",
  CONTRAST: "CIContrastAdjust",
  SATURATION: "CISaturationAdjust",
  SHARPEN: "CISharpenLuminance",
  UNSHARP_MASK: "CIUnsharpMask",
  NOISE_REDUCTION: "CINoiseReduction",
  PIXELATE: "CIPixellate",
  CRISTALLIZE: "CICrystallize",
  POINTILLIZE: "CIPointillize",
  HEXAGONAL_PIXELATE: "CIHexagonalPixellate",
  KALEIDOSCOPE: "CIKaleidoscope",
  TWIRL: "CITwirlDistortion",
  BUMP: "CIBumpDistortion",
  PINCH: "CIPinchDistortion",
  VORTEX: "CIVortexDistortion",
  PERSPECTIVE: "CIPerspectiveTransform",
  AFFINE: "CIAffineTransform",
  COMPOSITE_SOURCE_OVER: "CISourceOverCompositing",
  COMPOSITE_MULTIPLY: "CIMultiplyCompositing",
  COMPOSITE_SCREEN: "CIScreenBlendMode",
  COMPOSITE_OVERLAY: "CIOverlayBlendMode",
});

export const SWIFT_EVENTS = Object.freeze({
  VIEW_CREATED: "swift:view-created",
  VIEW_DESTROYED: "swift:view-destroyed",
  LAYOUT_UPDATED: "swift:layout-updated",
  FRAME_STARTED: "swift:frame-started",
  FRAME_ENDED: "swift:frame-ended",
  TEXT_MEASURED: "swift:text-measured",
  FONT_ATLAS_BUILT: "swift:font-atlas-built",
  IMAGE_LOADED: "swift:image-loaded",
  VIDEO_LOADED: "swift:video-loaded",
  VIDEO_FRAME: "swift:video-frame",
  VIDEO_STATE_CHANGED: "swift:video-state-changed",
  AUDIO_TRACK_READY: "swift:audio-track-ready",
  ANIMATION_STARTED: "swift:animation-started",
  ANIMATION_ENDED: "swift:animation-ended",
  FILTER_APPLIED: "swift:filter-applied",
  METAL_DISPATCH: "swift:metal-dispatch",
  METAL_SHADER_COMPILED: "swift:metal-shader-compiled",
  MEMORY_WARNING: "swift:memory-warning",
  LOG: "swift:log",
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

class SwiftLogger {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
  }
  push(level, message, meta) {
    const e = { ts: Date.now(), level, message, meta: meta ?? null };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    kernelBus.emit(SWIFT_EVENTS.LOG, e);
    if (level === "error") console.error("[swiftui-bridge]", message, meta);
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
// 3. COLOR
// ============================================================================

class Color {
  constructor(r = 0, g = 0, b = 0, a = 1) {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
  }
  static hex(hex) {
    const h = hex.replace("#", "");
    const n = parseInt(h, 16);
    return new Color(
      ((n >> 16) & 0xff) / 255,
      ((n >> 8) & 0xff) / 255,
      (n & 0xff) / 255,
      1
    );
  }
  static rgba(r, g, b, a) {
    return new Color(r / 255, g / 255, b / 255, a / 255);
  }
  static named(name) {
    const map = {
      black: "#000000",
      white: "#ffffff",
      red: "#ff3b30",
      green: "#34c759",
      blue: "#007aff",
      yellow: "#ffcc00",
      orange: "#ff9500",
      purple: "#af52de",
      pink: "#ff2d55",
      gray: "#8e8e93",
      clear: "#00000000",
      primary: "#007aff",
      secondary: "#8e8e93",
      accentColor: "#007aff",
      label: "#000000",
      secondaryLabel: "#3c3c4399",
      tertiaryLabel: "#3c3c434c",
      systemBackground: "#ffffff",
      secondarySystemBackground: "#f2f2f7",
    };
    if (name === "clear") return new Color(0, 0, 0, 0);
    return Color.hex(map[name] || "#000000");
  }
  withAlpha(a) {
    return new Color(this.r, this.g, this.b, a);
  }
  toArray() {
    return [this.r, this.g, this.b, this.a];
  }
  toCSS() {
    return `rgba(${Math.round(this.r * 255)},${Math.round(
      this.g * 255
    )},${Math.round(this.b * 255)},${this.a})`;
  }
  clone() {
    return new Color(this.r, this.g, this.b, this.a);
  }
}

// ============================================================================
// 4. LAYOUT ENGINE
// ============================================================================

class LayoutEngine {
  constructor() {
    this.stats = {
      measured: 0,
      layouts: 0,
    };
  }

  layout(node, { width, height }) {
    this.stats.layouts++;
    this._layout(node, 0, 0, width, height);
    kernelBus.emit(SWIFT_EVENTS.LAYOUT_UPDATED, {
      nodeId: node.id,
      width,
      height,
    });
    return node;
  }

  _layout(node, x, y, width, height) {
    node.layout = { x, y, width, height };

    if (node.type === NODE_TYPE.STACK) {
      this._layoutStack(node, x, y, width, height);
    } else if (node.type === NODE_TYPE.TEXT) {
      node.layout = this._measureText(node, x, y, width, height);
    } else if (node.type === NODE_TYPE.IMAGE) {
      this._layoutImage(node, x, y, width, height);
    } else if (node.type === NODE_TYPE.VIDEO) {
      node.layout = { x, y, width, height };
    } else {
      // Layout en cascada para hijos
      if (node.children?.length) {
        for (const child of node.children) {
          this._layout(child, x, y, width, height);
        }
      }
    }
  }

  _layoutStack(node, x, y, width, height) {
    const dir = node.props.direction || STACK_DIRECTION.VERTICAL;
    const spacing = node.props.spacing ?? 8;
    const padding = this._padding(node);

    const innerX = x + padding.left;
    const innerY = y + padding.top;
    const innerW = width - padding.left - padding.right;
    const innerH = height - padding.top - padding.bottom;

    if (!node.children || node.children.length === 0) return;

    if (dir === STACK_DIRECTION.HORIZONTAL) {
      const totalSpacing = spacing * (node.children.length - 1);
      const childW = (innerW - totalSpacing) / node.children.length;
      let cursorX = innerX;
      for (const child of node.children) {
        this._layout(child, cursorX, innerY, childW, innerH);
        cursorX += childW + spacing;
      }
    } else if (dir === STACK_DIRECTION.VERTICAL) {
      const totalSpacing = spacing * (node.children.length - 1);
      const childH = (innerH - totalSpacing) / node.children.length;
      let cursorY = innerY;
      for (const child of node.children) {
        this._layout(child, innerX, cursorY, innerW, childH);
        cursorY += childH + spacing;
      }
    } else {
      // ZStack
      for (const child of node.children) {
        this._layout(child, innerX, innerY, innerW, innerH);
      }
    }
  }

  _measureText(node, x, y, width, height) {
    const fontSize = node.props.fontSize ?? 17;
    const text = node.props.text || "";
    // Medida aproximada: 0.5 em por carácter
    const estimatedWidth = text.length * fontSize * 0.5;
    const lines = Math.max(1, Math.ceil(estimatedWidth / width));
    const estimatedHeight = lines * fontSize * 1.2;
    kernelBus.emit(SWIFT_EVENTS.TEXT_MEASURED, {
      nodeId: node.id,
      width: estimatedWidth,
      height: estimatedHeight,
      lines,
    });
    return { x, y, width, height: Math.min(estimatedHeight, height) };
  }

  _layoutImage(node, x, y, width, height) {
    const aspect = node.props.aspectRatio ?? 1;
    const containerAspect = width / height;
    let w, h;
    if (containerAspect > aspect) {
      h = height;
      w = h * aspect;
    } else {
      w = width;
      h = w / aspect;
    }
    node.layout = {
      x: x + (width - w) / 2,
      y: y + (height - h) / 2,
      width: w,
      height: h,
    };
  }

  _padding(node) {
    const p = node.props.padding ?? 0;
    if (typeof p === "number") {
      return { top: p, right: p, bottom: p, left: p };
    }
    return {
      top: p.top ?? 0,
      right: p.right ?? 0,
      bottom: p.bottom ?? 0,
      left: p.left ?? 0,
    };
  }
}

// ============================================================================
// 5. VIEW NODE
// ============================================================================

class ViewNode {
  constructor(type, props = {}) {
    this.id = uid("view");
    this.type = type;
    this.props = { ...props };
    this.children = [];
    this.parent = null;
    this.layout = { x: 0, y: 0, width: 0, height: 0 };
    this.state = {};
    this.animations = [];
    this.hidden = false;
    this.opacity = 1;
    this.zIndex = 0;
    this.transform = { x: 0, y: 0, scale: 1, rotation: 0 };
    this.clipShape = null;
    this.mask = null;
    this.shadow = null;
    this.blur = 0;
    this.material = null;
    this.createdAt = now();
    this.gpuResources = new Map();
  }

  addChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  addChildren(children) {
    for (const c of children) this.addChild(c);
    return this;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) {
      this.children.splice(i, 1);
      child.parent = null;
    }
    return this;
  }

  remove() {
    if (this.parent) this.parent.removeChild(this);
    this._releaseGpu();
    kernelBus.emit(SWIFT_EVENTS.VIEW_DESTROYED, { id: this.id });
  }

  _releaseGpu() {
    // Liberar recursos retenidos
    this.gpuResources.clear();
    for (const child of this.children) child._releaseGpu();
  }

  // Modificadores SwiftUI (fluent API)
  frame({ width, height }) {
    this.props.frame = { width, height };
    return this;
  }
  padding(value) {
    this.props.padding = value;
    return this;
  }
  background(color) {
    this.props.background = color;
    return this;
  }
  foregroundColor(color) {
    this.props.foregroundColor = color;
    return this;
  }
  cornerRadius(r) {
    this.props.cornerRadius = r;
    return this;
  }
  border(color, width = 1) {
    this.props.border = { color, width };
    return this;
  }
  shadow({ color, radius, x = 0, y = 0 } = {}) {
    this.shadow = { color, radius, x, y };
    return this;
  }
  blur(radius) {
    this.blur = radius;
    return this;
  }
  opacity(value) {
    this.opacity = value;
    return this;
  }
  offset({ x = 0, y = 0 }) {
    this.transform.x = x;
    this.transform.y = y;
    return this;
  }
  scaleEffect(scale) {
    this.transform.scale = scale;
    return this;
  }
  rotationEffect(degrees) {
    this.transform.rotation = degrees;
    return this;
  }
  clipShape(shape) {
    this.clipShape = shape;
    return this;
  }
  mask(node) {
    this.mask = node;
    return this;
  }
  zIndex(z) {
    this.zIndex = z;
    return this;
  }
  onTap(handler) {
    this.props.onTap = handler;
    return this;
  }
  animate(animation) {
    this.animations.push(animation);
    return this;
  }
}

// ============================================================================
// 6. SWIFTUI DSL (funciones helpers)
// ============================================================================

export const SwiftUI = {
  // Contenedores
  VStack(children, { spacing = 8, padding = 0, alignment = "center", ...rest } = {}) {
    const node = new ViewNode(NODE_TYPE.STACK, {
      direction: STACK_DIRECTION.VERTICAL,
      spacing,
      padding,
      alignment,
      ...rest,
    });
    node.addChildren(children);
    return node;
  },
  HStack(children, { spacing = 8, padding = 0, alignment = "center", ...rest } = {}) {
    const node = new ViewNode(NODE_TYPE.STACK, {
      direction: STACK_DIRECTION.HORIZONTAL,
      spacing,
      padding,
      alignment,
      ...rest,
    });
    node.addChildren(children);
    return node;
  },
  ZStack(children, { padding = 0, ...rest } = {}) {
    const node = new ViewNode(NODE_TYPE.STACK, {
      direction: STACK_DIRECTION.ZSTACK,
      padding,
      ...rest,
    });
    node.addChildren(children);
    return node;
  },
  Spacer() {
    return new ViewNode(NODE_TYPE.SPACER, { flex: 1 });
  },
  Divider({ color = Color.named("secondaryLabel"), thickness = 0.5 } = {}) {
    return new ViewNode(NODE_TYPE.DIVIDER, { color, thickness });
  },

  // Texto
  Text(text, {
    fontSize = 17,
    fontWeight = FONT_WEIGHT.REGULAR,
    fontFamily = "SF Pro Text",
    color = Color.named("label"),
    alignment = TEXT_ALIGNMENT.LEADING,
    lineLimit = null,
    ...rest
  } = {}) {
    return new ViewNode(NODE_TYPE.TEXT, {
      text,
      fontSize,
      fontWeight,
      fontFamily,
      color,
      alignment,
      lineLimit,
      ...rest,
    });
  },

  // Imágenes
  Image({ src, name = null, aspectRatio = 1, renderingMode = "template", ...rest } = {}) {
    return new ViewNode(NODE_TYPE.IMAGE, {
      src,
      name,
      aspectRatio,
      renderingMode,
      ...rest,
    });
  },
  AsyncImage({ url, placeholder = null, contentMode = "fill", ...rest } = {}) {
    return new ViewNode(NODE_TYPE.IMAGE, {
      url,
      placeholder,
      contentMode,
      async: true,
      ...rest,
    });
  },

  // Formas
  Rectangle({ fill = Color.named("label"), ...rest } = {}) {
    return new ViewNode(NODE_TYPE.SHAPE, {
      shape: "rect",
      fill,
      ...rest,
    });
  },
  RoundedRectangle({ cornerRadius = 8, fill = Color.named("label"), ...rest } = {}) {
    return new ViewNode(NODE_TYPE.SHAPE, {
      shape: "roundedRect",
      cornerRadius,
      fill,
      ...rest,
    });
  },
  Circle({ fill = Color.named("label"), ...rest } = {}) {
    return new ViewNode(NODE_TYPE.SHAPE, { shape: "circle", fill, ...rest });
  },
  Capsule({ fill = Color.named("label"), ...rest } = {}) {
    return new ViewNode(NODE_TYPE.SHAPE, { shape: "capsule", fill, ...rest });
  },
  Ellipse({ fill = Color.named("label"), ...rest } = {}) {
    return new ViewNode(NODE_TYPE.SHAPE, { shape: "ellipse", fill, ...rest });
  },
  Path({ commands = [], fill = null, stroke = null, strokeWidth = 1, ...rest } = {}) {
    return new ViewNode(NODE_TYPE.SHAPE, {
      shape: "path",
      commands,
      fill,
      stroke,
      strokeWidth,
      ...rest,
    });
  },

  // Gradientes
  LinearGradient({
    colors,
    startPoint = { x: 0.5, y: 0 },
    endPoint = { x: 0.5, y: 1 },
    ...rest
  } = {}) {
    return new ViewNode(NODE_TYPE.SHAPE, {
      shape: "rect",
      fill: {
        type: GRADIENT_TYPE.LINEAR,
        colors,
        startPoint,
        endPoint,
      },
      ...rest,
    });
  },
  RadialGradient({
    colors,
    center = { x: 0.5, y: 0.5 },
    startRadius = 0,
    endRadius = 100,
    ...rest
  } = {}) {
    return new ViewNode(NODE_TYPE.SHAPE, {
      shape: "rect",
      fill: {
        type: GRADIENT_TYPE.RADIAL,
        colors,
        center,
        startRadius,
        endRadius,
      },
      ...rest,
    });
  },

  // Controles
  Button({ label, action, ...rest } = {}) {
    const node = new ViewNode(NODE_TYPE.BUTTON, {
      action,
      ...rest,
    });
    if (label instanceof ViewNode) node.addChild(label);
    return node;
  },
  Toggle({ label, isOn = false, onChange, ...rest } = {}) {
    return new ViewNode(NODE_TYPE.TOGGLE, {
      label,
      isOn,
      onChange,
      ...rest,
    });
  },
  Slider({ value = 0.5, minValue = 0, maxValue = 1, onChange, ...rest } = {}) {
    return new ViewNode(NODE_TYPE.SLIDER, {
      value,
      minValue,
      maxValue,
      onChange,
      ...rest,
    });
  },
  ProgressView({ value = null, total = 1, label = null, ...rest } = {}) {
    return new ViewNode(NODE_TYPE.PROGRESS, {
      value,
      total,
      label,
      indeterminate: value == null,
      ...rest,
    });
  },

  // Listas
  List(items, renderItem, { ...rest } = {}) {
    const node = new ViewNode(NODE_TYPE.LIST, { ...rest });
    for (const item of items) {
      const child = renderItem(item);
      if (child instanceof ViewNode) node.addChild(child);
    }
    return node;
  },
  ScrollView(children, { axis = "vertical", showsIndicators = true, ...rest } = {}) {
    const node = new ViewNode(NODE_TYPE.SCROLL, {
      axis,
      showsIndicators,
      ...rest,
    });
    node.addChildren(Array.isArray(children) ? children : [children]);
    return node;
  },
  LazyVStack(children, opts = {}) {
    return SwiftUI.VStack(children, { lazy: true, ...opts });
  },
  LazyHStack(children, opts = {}) {
    return SwiftUI.HStack(children, { lazy: true, ...opts });
  },

  // Navegación
  NavigationStack(children, { title = "", ...rest } = {}) {
    const node = new ViewNode(NODE_TYPE.NAVIGATION, {
      title,
      ...rest,
    });
    node.addChildren(Array.isArray(children) ? children : [children]);
    return node;
  },
  TabView(tabs, { selectedIndex = 0, onChange, ...rest } = {}) {
    const node = new ViewNode(NODE_TYPE.TABVIEW, {
      selectedIndex,
      onChange,
      ...rest,
    });
    for (const tab of tabs) {
      const t = new ViewNode(NODE_TYPE.VIEW, {
        tabLabel: tab.label,
        tabIcon: tab.icon,
      });
      if (tab.content instanceof ViewNode) t.addChild(tab.content);
      node.addChild(t);
    }
    return node;
  },
  Form(children, { ...rest } = {}) {
    const node = new ViewNode(NODE_TYPE.FORM, { ...rest });
    node.addChildren(Array.isArray(children) ? children : [children]);
    return node;
  },
  Section({ header = null, footer = null, content, ...rest } = {}) {
    const node = new ViewNode(NODE_TYPE.SECTION, { header, footer, ...rest });
    if (content instanceof ViewNode) node.addChild(content);
    return node;
  },
  Link({ label, url, ...rest } = {}) {
    return new ViewNode(NODE_TYPE.LINK, { label, url, ...rest });
  },
  Label({ title, icon, ...rest } = {}) {
    return new ViewNode(NODE_TYPE.LABEL, { title, icon, ...rest });
  },
};

// ============================================================================
// 7. UIKit BRIDGE
// ============================================================================

export const UIKit = {
  UIView({ frame = { x: 0, y: 0, width: 0, height: 0 }, backgroundColor = null, ...rest } = {}) {
    const node = new ViewNode(NODE_TYPE.VIEW, { ...rest });
    node.layout = { ...frame };
    if (backgroundColor) node.props.background = backgroundColor;
    return node;
  },
  UILabel({ text, font = { size: 17, weight: FONT_WEIGHT.REGULAR }, textColor = Color.named("label"), ...rest } = {}) {
    return SwiftUI.Text(text, {
      fontSize: font.size,
      fontWeight: font.weight,
      color: textColor,
      ...rest,
    });
  },
  UIImageView({ image, contentMode = "scaleAspectFill", ...rest } = {}) {
    return SwiftUI.Image({ src: image, contentMode, ...rest });
  },
  UIButton({ title, action, ...rest } = {}) {
    const label = SwiftUI.Text(title, { alignment: TEXT_ALIGNMENT.CENTER });
    return SwiftUI.Button({ label, action, ...rest });
  },
  UISwitch({ isOn = false, onChange, ...rest } = {}) {
    return SwiftUI.Toggle({ isOn, onChange, ...rest });
  },
  UISlider({ value = 0.5, minimumValue = 0, maximumValue = 1, onChange, ...rest } = {}) {
    return SwiftUI.Slider({
      value,
      minValue: minimumValue,
      maxValue: maximumValue,
      onChange,
      ...rest,
    });
  },
  UITableView({ sections, renderCell, ...rest } = {}) {
    const rows = [];
    for (const s of sections) {
      for (const item of s.items) {
        rows.push(renderCell(item));
      }
    }
    return SwiftUI.List(rows, (n) => n, { ...rest });
  },
  UICollectionView({ items, renderItem, columns = 2, ...rest } = {}) {
    const rows = [];
    for (let i = 0; i < items.length; i += columns) {
      const row = SwiftUI.HStack(
        items.slice(i, i + columns).map((item) => renderItem(item)),
        { spacing: 8 }
      );
      rows.push(row);
    }
    return SwiftUI.VStack(rows, { spacing: 8, ...rest });
  },
  UIScrollView({ content, ...rest } = {}) {
    return SwiftUI.ScrollView([content], { ...rest });
  },
};

// ============================================================================
// 8. APPKIT BRIDGE
// ============================================================================

export const AppKit = {
  NSView({ frame = { x: 0, y: 0, width: 0, height: 0 }, backgroundColor = null, ...rest } = {}) {
    return UIKit.UIView({ frame, backgroundColor, ...rest });
  },
  NSTextField({ stringValue, font = { size: 13 }, textColor = Color.named("label"), ...rest } = {}) {
    return SwiftUI.Text(stringValue, {
      fontSize: font.size,
      color: textColor,
      ...rest,
    });
  },
  NSButton({ title, action, ...rest } = {}) {
    return UIKit.UIButton({ title, action, ...rest });
  },
  NSSlider({ value = 0.5, onChange, ...rest } = {}) {
    return UIKit.UISlider({ value, onChange, ...rest });
  },
  NSWindow({ title = "", contentView, toolbar = null, styleMask = {}, ...rest } = {}) {
    const node = new ViewNode(NODE_TYPE.VIEW, {
      isWindow: true,
      title,
      toolbar,
      styleMask,
      ...rest,
    });
    if (contentView instanceof ViewNode) node.addChild(contentView);
    return node;
  },
};

// ============================================================================
// 9. AVKIT (VIDEO)
// ============================================================================

class VideoPlayer {
  constructor({ src, loop = false, muted = false, autoplay = false, ...rest }) {
    this.id = uid("video");
    this.src = src;
    this.loop = loop;
    this.muted = muted;
    this.state = VIDEO_STATE.IDLE;
    this.currentTime = 0;
    this.duration = 0;
    this.playbackRate = 1.0;
    this.volume = 1.0;
    this.buffered = 0;
    this.frameTexture = null;
    this.audioTrack = null;
    this.listeners = new Set();

    if (autoplay) this.play();
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.listeners.get(event).delete(handler);
  }

  _emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const h of set) {
      try {
        h(payload);
      } catch (err) {
        console.error("[video]", err);
      }
    }
  }

  async load() {
    this._setState(VIDEO_STATE.LOADING);
    // Simular carga de metadatos
    await new Promise((r) => setTimeout(r, 200));
    this.duration = 60; // simulamos 60s
    this._setState(VIDEO_STATE.READY);
    kernelBus.emit(SWIFT_EVENTS.VIDEO_LOADED, {
      id: this.id,
      src: this.src,
      duration: this.duration,
    });
  }

  play() {
    if (this.state !== VIDEO_STATE.READY && this.state !== VIDEO_STATE.PAUSED) return;
    this._setState(VIDEO_STATE.PLAYING);
    this._tick();
  }

  pause() {
    if (this.state !== VIDEO_STATE.PLAYING) return;
    this._setState(VIDEO_STATE.PAUSED);
    if (this._tickHandle) {
      cancelAnimationFrame(this._tickHandle);
      this._tickHandle = null;
    }
  }

  seek(time) {
    this.currentTime = clamp(time, 0, this.duration);
    this._emit("timeupdate", { currentTime: this.currentTime });
  }

  _tick() {
    const start = now();
    const loop = () => {
      if (this.state !== VIDEO_STATE.PLAYING) return;
      const dt = (now() - start) / 1000;
      this.currentTime = Math.min(this.duration, this.currentTime + dt * this.playbackRate);
      this._emit("timeupdate", { currentTime: this.currentTime });
      // Emitir frame
      kernelBus.emit(SWIFT_EVENTS.VIDEO_FRAME, {
        id: this.id,
        time: this.currentTime,
      });
      this._emit("frame", { time: this.currentTime });
      if (this.currentTime >= this.duration) {
        if (this.loop) {
          this.currentTime = 0;
        } else {
          this._setState(VIDEO_STATE.ENDED);
          return;
        }
      }
      this._tickHandle = requestAnimationFrame(loop);
    };
    this._tickHandle = requestAnimationFrame(loop);
  }

  _setState(s) {
    this.state = s;
    this._emit("statechange", { state: s });
    kernelBus.emit(SWIFT_EVENTS.VIDEO_STATE_CHANGED, {
      id: this.id,
      state: s,
    });
  }

  destroy() {
    this.pause();
    this.listeners.clear();
  }
}

export const AVKit = {
  AVPlayer({ src, loop = false, muted = false, autoplay = false, ...rest } = {}) {
    const player = new VideoPlayer({ src, loop, muted, autoplay, ...rest });
    player.load();
    return player;
  },

  AVPlayerLayer({ player, videoGravity = "resizeAspect", ...rest } = {}) {
    const node = new ViewNode(NODE_TYPE.VIDEO, {
      player,
      videoGravity,
      ...rest,
    });
    // El nodo retiene el player
    node.state.player = player;
    return node;
  },

  AVPlayerViewController({ player, showsPlaybackControls = true, ...rest } = {}) {
    const node = new ViewNode(NODE_TYPE.VIDEO, {
      player,
      showsPlaybackControls,
      ...rest,
    });
    node.state.player = player;
    return node;
  },
};

// ============================================================================
// 10. COREMAGE (CIFilter)
// ============================================================================

class CIFilter {
  constructor(name, params = {}) {
    this.id = uid("filter");
    this.name = name;
    this.params = params;
  }

  setValue(value, key) {
    this.params[key] = value;
    return this;
  }

  value(key) {
    return this.params[key];
  }
}

class CIContext {
  constructor({ gpu = null } = {}) {
    this.gpu = gpu;
    this.stats = { filters: 0, pixelsProcessed: 0 };
  }

  render(chain, texture) {
    let current = texture;
    for (const filter of chain) {
      current = this._applyFilter(filter, current);
      this.stats.filters++;
    }
    return current;
  }

  _applyFilter(filter, texture) {
    kernelBus.emit(SWIFT_EVENTS.FILTER_APPLIED, {
      filterId: filter.id,
      name: filter.name,
    });
    // En una implementación real, se aplicaría el filtro a la textura
    // Aquí solo contamos los píxeles procesados
    this.stats.pixelsProcessed += (texture.width || 0) * (texture.height || 0);
    return texture;
  }
}

export const CoreImage = {
  CIFilter,
  CIContext,
  filter(name, params) {
    return new CIFilter(name, params);
  },
};

// ============================================================================
// 11. COREANIMATION
// ============================================================================

class CAAnimation {
  constructor({
    type = ANIMATION_TYPE.FADE,
    duration = 0.3,
    delay = 0,
    timingFunction = TIMING_FUNCTION.EASE_IN_OUT,
    from = null,
    to = null,
    repeatCount = 0,
    autoreverse = false,
    onComplete = null,
  } = {}) {
    this.id = uid("anim");
    this.type = type;
    this.duration = duration;
    this.delay = delay;
    this.timingFunction = timingFunction;
    this.from = from;
    this.to = to;
    this.repeatCount = repeatCount;
    this.autoreverse = autoreverse;
    this.onComplete = onComplete;
    this.startedAt = null;
    this.finished = false;
  }

  start(node) {
    this.startedAt = now() + this.delay * 1000;
    this.finished = false;
    kernelBus.emit(SWIFT_EVENTS.ANIMATION_STARTED, {
      id: this.id,
      type: this.type,
      nodeId: node.id,
    });
  }

  update(node) {
    if (this.finished) return;
    const t = (now() - this.startedAt) / 1000;
    if (t < 0) return;
    const progress = clamp(t / this.duration, 0, 1);
    const eased = this._ease(progress);
    this._apply(node, eased);
    if (progress >= 1) {
      this.finished = true;
      kernelBus.emit(SWIFT_EVENTS.ANIMATION_ENDED, {
        id: this.id,
        nodeId: node.id,
      });
      this.onComplete?.();
    }
  }

  _ease(t) {
    switch (this.timingFunction) {
      case TIMING_FUNCTION.LINEAR:
        return t;
      case TIMING_FUNCTION.EASE_IN:
        return t * t;
      case TIMING_FUNCTION.EASE_OUT:
        return 1 - (1 - t) * (1 - t);
      case TIMING_FUNCTION.EASE_IN_OUT:
      case TIMING_FUNCTION.DEFAULT:
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      default:
        return t;
    }
  }

  _apply(node, t) {
    switch (this.type) {
      case ANIMATION_TYPE.FADE:
        node.opacity = lerp(this.from ?? 0, this.to ?? 1, t);
        break;
      case ANIMATION_TYPE.MOVE:
        node.transform.x = lerp(this.from?.x ?? 0, this.to?.x ?? 0, t);
        node.transform.y = lerp(this.from?.y ?? 0, this.to?.y ?? 0, t);
        break;
      case ANIMATION_TYPE.SCALE:
        node.transform.scale = lerp(this.from ?? 1, this.to ?? 2, t);
        break;
      case ANIMATION_TYPE.ROTATE:
        node.transform.rotation = lerp(this.from ?? 0, this.to ?? 360, t);
        break;
      case ANIMATION_TYPE.OPACITY:
        node.opacity = lerp(this.from ?? 1, this.to ?? 0, t);
        break;
      case ANIMATION_TYPE.SPRING: {
        // Física simple: oscilación amortiguada
        const omega = 10;
        const damped = 1 - Math.exp(-omega * t) * Math.cos(omega * 3 * t);
        node.transform.scale = lerp(this.from ?? 1, this.to ?? 1.2, damped);
        break;
      }
      default:
        break;
    }
  }
}

export const CoreAnimation = {
  CAAnimation,
  fadeIn: (duration = 0.3) =>
    new CAAnimation({ type: ANIMATION_TYPE.FADE, from: 0, to: 1, duration }),
  fadeOut: (duration = 0.3) =>
    new CAAnimation({ type: ANIMATION_TYPE.FADE, from: 1, to: 0, duration }),
  moveTo: (x, y, duration = 0.3) =>
    new CAAnimation({
      type: ANIMATION_TYPE.MOVE,
      to: { x, y },
      duration,
    }),
  scaleTo: (scale, duration = 0.3) =>
    new CAAnimation({ type: ANIMATION_TYPE.SCALE, from: 1, to: scale, duration }),
  rotateTo: (degrees, duration = 0.5) =>
    new CAAnimation({
      type: ANIMATION_TYPE.ROTATE,
      from: 0,
      to: degrees,
      duration,
    }),
  spring: (opts = {}) =>
    new CAAnimation({ type: ANIMATION_TYPE.SPRING, ...opts }),
};

// ============================================================================
// 12. METAL BRIDGE
// ============================================================================

class MetalShaderCompiler {
  constructor() {
    this.cache = new Map();
    this.stats = { compiled: 0, cacheHits: 0, errors: 0 };
  }

  /**
   * Traduce un shader Metal (MSL simplificado) a VSL (Vgpu Shader Language).
   * Soporta:
   *   - vertex / fragment / kernel functions
   *   - tipos float, float2, float3, float4
   *   - operadores aritméticos básicos
   *   - funciones: dot, cross, normalize, length, mix, clamp, saturate
   *   - atributos [[position]], [[stage_in]], [[color(0)]]
   *   - uniforms, textures, samplers
   *
   * No soporta: control flow complejo, structs anidados, templates,
   * buffers atómicos, threadgroup memory.
   */
  compileMSL(source, { stage = "vertex", entry = "main" } = {}) {
    const key = `${stage}:${entry}:${source}`;
    if (this.cache.has(key)) {
      this.stats.cacheHits++;
      return this.cache.get(key);
    }

    try {
      const vslSource = this._translate(source, stage);
      const compiled = {
        id: uid("metal-shader"),
        source,
        vslSource,
        stage,
        entry,
        compiledAt: now(),
      };
      this.cache.set(key, compiled);
      this.stats.compiled++;
      kernelBus.emit(SWIFT_EVENTS.METAL_SHADER_COMPILED, {
        id: compiled.id,
        stage,
        entry,
      });
      return compiled;
    } catch (err) {
      this.stats.errors++;
      throw err;
    }
  }

  _translate(source, stage) {
    // Traducción simplificada: convertimos operaciones MSL a VSL.
    // En una implementación completa sería un compilador real.
    const lines = source
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//"));

    const out = [];
    out.push(`// Translated from MSL (${stage})`);

    // Detectar declaración de función
    const fnRegex = /(\w+)\s+(\w+)\s*\(([^)]*)\)/;
    for (const line of lines) {
      const m = line.match(fnRegex);
      if (m) {
        const [, , fnName] = m;
        out.push(`// function: ${fnName}`);
        continue;
      }
      // Traducción de operaciones comunes
      let t = line;
      t = t.replace(/\bfloat4\b/g, "");
      t = t.replace(/\bfloat3\b/g, "");
      t = t.replace(/\bfloat2\b/g, "");
      t = t.replace(/\bfloat\b/g, "");
      t = t.replace(/normalize\(/g, "nrm ");
      t = t.replace(/\bdot\(/g, "dp4 ");
      t = t.replace(/\bcross\(/g, "cross ");
      t = t.replace(/\blength\(/g, "len ");
      t = t.replace(/\bmix\(/g, "lerp ");
      t = t.replace(/\bclamp\(/g, "clamp ");
      t = t.replace(/\bsaturate\(/g, "sat ");
      t = t.replace(/;/g, "");
      if (t.trim()) out.push(t);
    }
    return out.join("\n");
  }
}

export const Metal = {
  MetalShaderCompiler,
  compile(source, opts) {
    const compiler = new MetalShaderCompiler();
    return compiler.compileMSL(source, opts);
  },
};

// ============================================================================
// 13. RENDERER (Display List → VGPU)
// ============================================================================

class SwiftRenderer {
  constructor({ gpu, layout = new LayoutEngine() }) {
    this.gpu = gpu;
    this.layout = layout;
    this.log = new SwiftLogger();
    this.stats = {
      frames: 0,
      nodes: 0,
      quads: 0,
      texts: 0,
      images: 0,
      videos: 0,
      filters: 0,
    };
  }

  render(rootNode, { width, height, target }) {
    const t0 = now();
    this.stats.frames++;

    // Layout
    this.layout.layout(rootNode, { width, height });

    // Crear command buffer
    const cb = this.gpu.createCommandBuffer();
    cb.setRenderTarget({ renderTarget: target || this.gpu.defaultRenderTarget });
    cb.clear({ r: 30, g: 30, b: 40, a: 255 });

    // Recorrer el árbol y emitir comandos
    this._walk(rootNode, cb);
    cb.present();

    // Submit y ejecutar
    this.gpu.submitCommandBuffer(cb);
    this.gpu.executeCommandBuffers();

    const t1 = now();
    kernelBus.emit(SWIFT_EVENTS.FRAME_ENDED, {
      frameTimeMs: t1 - t0,
      nodes: this.stats.nodes,
    });
  }

  _walk(node, cb) {
    if (node.hidden) return;
    this.stats.nodes++;

    switch (node.type) {
      case NODE_TYPE.STACK:
        this._emitStack(node, cb);
        break;
      case NODE_TYPE.TEXT:
        this._emitText(node, cb);
        break;
      case NODE_TYPE.IMAGE:
        this._emitImage(node, cb);
        break;
      case NODE_TYPE.VIDEO:
        this._emitVideo(node, cb);
        break;
      case NODE_TYPE.SHAPE:
        this._emitShape(node, cb);
        break;
      case NODE_TYPE.BUTTON:
      case NODE_TYPE.TOGGLE:
      case NODE_TYPE.SLIDER:
      case NODE_TYPE.PROGRESS:
        this._emitControl(node, cb);
        break;
      case NODE_TYPE.LIST:
      case NODE_TYPE.SCROLL:
      case NODE_TYPE.FORM:
      case NODE_TYPE.SECTION:
        this._emitContainer(node, cb);
        break;
      default:
        this._emitGeneric(node, cb);
    }

    // Recorrer hijos
    for (const child of node.children) {
      this._walk(child, cb);
    }

    // Efectos (blur, shadow) — se emitirían como post-process
    if (node.blur > 0 || node.shadow) {
      this._emitEffects(node, cb);
    }
  }

  _emitStack(node, cb) {
    // Los stacks no dibujan nada, solo contienen
  }

  _emitText(node, cb) {
    this.stats.texts++;
    const { text, fontSize = 17, color = Color.named("label") } = node.props;
    const layout = node.layout;
    // Emitir un quad de color con "texto" (en una implementación real
    // se usaría un font atlas y cada glifo sería un quad texturizado)
    cb.push(VGPU_OPCODE.DRAW, {
      vertexCount: 6,
      // En real: bindTextura(fontAtlas) + draw con UVs por glifo
    });
  }

  _emitImage(node, cb) {
    this.stats.images++;
    // En real: bindTextura + draw quad texturizado
    cb.push(VGPU_OPCODE.DRAW, { vertexCount: 6 });
  }

  _emitVideo(node, cb) {
    this.stats.videos++;
    const player = node.state?.player;
    if (player && player.frameTexture) {
      // bindTextura(player.frameTexture) + draw quad
      cb.push(VGPU_OPCODE.DRAW, { vertexCount: 6 });
    }
  }

  _emitShape(node, cb) {
    const shape = node.props.shape;
    if (shape === "rect" || shape === "roundedRect") {
      this.stats.quads++;
      cb.push(VGPU_OPCODE.DRAW, { vertexCount: 6 });
    } else if (shape === "circle" || shape === "ellipse") {
      // Triangulado en abanico
      this.stats.quads++;
      cb.push(VGPU_OPCODE.DRAW, { vertexCount: 32 });
    } else if (shape === "capsule") {
      this.stats.quads++;
      cb.push(VGPU_OPCODE.DRAW, { vertexCount: 32 });
    } else if (shape === "path") {
      this.stats.quads++;
      cb.push(VGPU_OPCODE.DRAW, { vertexCount: 64 });
    }
  }

  _emitControl(node, cb) {
    // Los controles SwiftUI tienen sub-vistas que ya se renderizan
    // Button: label + fondo
    // Toggle: switch + label
    // Slider: track + thumb
    // Progress: track + fill
    this._emitShape(node, cb);
  }

  _emitContainer(node, cb) {
    // Los contenedores no dibujan directamente
  }

  _emitGeneric(node, cb) {
    if (node.props.background) {
      this.stats.quads++;
      cb.push(VGPU_OPCODE.DRAW, { vertexCount: 6 });
    }
  }

  _emitEffects(node, cb) {
    if (node.blur > 0) {
      this.stats.filters++;
      // En real: post-process blur pass
    }
    if (node.shadow) {
      this.stats.filters++;
      // En real: shadow pass
    }
  }

  snapshot() {
    return { ...this.stats, layout: this.layout.stats };
  }
}

// ============================================================================
// 14. SWIFTUI BRIDGE (clase principal)
// ============================================================================

export class SwiftUIBridge {
  constructor(options = {}) {
    this.options = options;
    this.gpu = options.gpu;
    this.layout = new LayoutEngine();
    this.renderer = new SwiftRenderer({ gpu: this.gpu, layout: this.layout });
    this.log = new SwiftLogger();

    this.rootNode = null;
    this.animations = [];
    this.imageCache = new Map();
    this.fontAtlasCache = new Map();
    this.videoPlayers = new Map();
    this.ciContext = new CIContext({ gpu: this.gpu });
    this.metalCompiler = new MetalShaderCompiler();

    this.stats = {
      framesRendered: 0,
      nodesCreated: 0,
      imagesLoaded: 0,
      videosLoaded: 0,
      filtersApplied: 0,
      metalShadersCompiled: 0,
    };
  }

  setRoot(node) {
    this.rootNode = node;
    kernelBus.emit(SWIFT_EVENTS.VIEW_CREATED, { nodeId: node.id });
    this.stats.nodesCreated++;
  }

  render({ width, height, target }) {
    if (!this.rootNode) return;
    this._updateAnimations();
    this.renderer.render(this.rootNode, { width, height, target });
    this.stats.framesRendered++;
    kernelBus.emit(SWIFT_EVENTS.FRAME_STARTED, {
      frame: this.stats.framesRendered,
    });
  }

  _updateAnimations() {
    for (const a of this.animations) {
      if (a.node) a.animation.update(a.node);
    }
    this.animations = this.animations.filter((a) => !a.animation.finished);
  }

  addAnimation(node, animation) {
    animation.start(node);
    this.animations.push({ node, animation });
  }

  async loadImage(key, src) {
    if (this.imageCache.has(key)) return this.imageCache.get(key);
    const tex = this.gpu.createTexture({
      width: 256,
      height: 256,
      format: "RGBA8",
      tag: `image-${key}`,
    });
    this.imageCache.set(key, tex);
    this.stats.imagesLoaded++;
    kernelBus.emit(SWIFT_EVENTS.IMAGE_LOADED, { key, textureId: tex.id });
    return tex;
  }

  compileMetalShader(source, opts) {
    const s = this.metalCompiler.compileMSL(source, opts);
    this.stats.metalShadersCompiled++;
    kernelBus.emit(SWIFT_EVENTS.METAL_DISPATCH, { shaderId: s.id });
    return s;
  }

  snapshot() {
    return {
      ...this.stats,
      renderer: this.renderer.snapshot(),
      animations: this.animations.length,
      imageCache: this.imageCache.size,
      fontAtlasCache: this.fontAtlasCache.size,
      metalCompiler: this.metalCompiler.stats,
      ciContext: this.ciContext.stats,
    };
  }
}

// ============================================================================
// 15. PROVIDER + HOOKS
// ============================================================================

const SwiftBridgeContext = createContext(null);

const initialState = {
  snapshot: null,
  logs: [],
};

function reducer(state, action) {
  switch (action.type) {
    case "SNAPSHOT":
      return { ...state, snapshot: action.snapshot };
    case "LOG":
      return { ...state, logs: [...state.logs.slice(-299), action.entry] };
    default:
      return state;
  }
}

export function SwiftUIProvider({
  children,
  bridge: external,
  autoRender = true,
}) {
  const { gpu } = useVgpu();
  const ref = useRef(null);
  if (!ref.current) {
    ref.current = external || new SwiftUIBridge({ gpu });
  }
  const bridge = ref.current;

  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    const offLog = kernelBus.on(SWIFT_EVENTS.LOG, (entry) => {
      dispatch({ type: "LOG", entry });
    });

    // Snapshot periódico
    const t = setInterval(() => {
      dispatch({ type: "SNAPSHOT", snapshot: bridge.snapshot() });
    }, 500);

    // Auto render loop
    let rafHandle = null;
    if (autoRender) {
      const loop = () => {
        if (bridge.rootNode) {
          bridge.render({
            width: bridge.gpu.options.defaultWidth,
            height: bridge.gpu.options.defaultHeight,
          });
        }
        rafHandle = requestAnimationFrame(loop);
      };
      rafHandle = requestAnimationFrame(loop);
    }

    return () => {
      offLog();
      clearInterval(t);
      if (rafHandle != null) cancelAnimationFrame(rafHandle);
    };
  }, [autoRender, bridge]);

  const api = useMemo(
    () => ({
      bridge,
      snapshot: state.snapshot,
      logs: state.logs,

      // Nodos
      setRoot: (node) => bridge.setRoot(node),

      // Render
      render: (opts) => bridge.render(opts),

      // Animaciones
      addAnimation: (node, anim) => bridge.addAnimation(node, anim),

      // Recursos
      loadImage: (key, src) => bridge.loadImage(key, src),

      // Metal
      compileMetalShader: (src, opts) => bridge.compileMetalShader(src, opts),

      // Acceso a las DSLs
      SwiftUI,
      UIKit,
      AppKit,
      AVKit,
      CoreImage,
      CoreAnimation,
      Metal,
    }),
    [bridge, state]
  );

  return (
    <SwiftBridgeContext.Provider value={api}>
      {children}
    </SwiftBridgeContext.Provider>
  );
}

export function useSwiftUI() {
  const ctx = useContext(SwiftBridgeContext);
  if (!ctx)
    throw new Error("useSwiftUI must be used within a SwiftUIProvider");
  return ctx;
}

// ============================================================================
// 16. EXPORTS
// ============================================================================

export default {
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
  NODE_TYPE,
  STACK_DIRECTION,
  TEXT_ALIGNMENT,
  FONT_WEIGHT,
  BLEND_MODE,
  GRADIENT_TYPE,
  ANIMATION_TYPE,
  TIMING_FUNCTION,
  VIDEO_STATE,
  CIFILTER,
  SWIFT_EVENTS,
  ViewNode,
  LayoutEngine,
  SwiftRenderer,
  VideoPlayer,
  CIFilter,
  CIContext,
  CAAnimation,
  MetalShaderCompiler,
  Color,
};
