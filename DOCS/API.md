# rainOS API Reference

Complete API reference for every class, provider, hook, constant and
utility exported by rainOS.

---

## Table of Contents

1. [Package Exports](#package-exports)
2. [Kernel](#kernel)
3. [Bootstrap](#bootstrap)
4. [BootLoader](#bootloader)
5. [SafeBoot](#safeboot)
6. [StartupInstaller](#startupinstaller)
7. [InitialConfig](#initialconfig)
8. [InitSystem](#initsystem)
9. [LockScreen](#lockscreen)
10. [Constants Index](#constants-index)
11. [Utility Index](#utility-index)

---

## Package Exports

Import everything from the root:

```js
import * as rainOS from "rainos";
```

Or import from subpaths for tree-shaking:

```js
import { WindowManager, useWindowManager } from "rainos/kernel";
import { Bootstrap, BootstrapProvider } from "rainos/bootstrap";
import { BootLoader, BootLoaderProvider } from "rainos/bootloader";
import { SafeBoot, SafeBootProvider } from "rainos/safeboot";
import { StartupInstaller } from "rainos/startupinstaller";
import { InitialConfig } from "rainos/initialconfig";
import { InitSystem, AppleLogo } from "rainos/initsystem";
import { LockScreen, LockScreenView } from "rainos/lockscreen";
```

### Subpaths

| Subpath | Contents |
|---|---|
| `rainos/kernel` | Window manager, providers, hooks, geometry, buses |
| `rainos/bootstrap` | Bootstrap module |
| `rainos/bootloader` | Boot loader module |
| `rainos/safeboot` | Safe boot module |
| `rainos/startupinstaller` | Asset installer module |
| `rainos/initialconfig` | Setup assistant module |
| `rainos/initsystem` | Boot screen UI |
| `rainos/lockscreen` | Lock screen and auth |

---

## Kernel

### `WindowManager` (class)

```ts
class WindowManager {
  constructor(options?: { viewport?: { width: number; height: number } });

  // Lifecycle
  open(opts: OpenOptions): number;
  close(id: number): boolean;
  closeAll(): void;
  reset(): void;
  update(id: number, patch: Partial<Window>): void;
  setTitle(id: number, title: string): void;
  setData(id: number, data: any): void;

  // Focus
  focus(id: number): void;
  blur(): void;
  focusNext(): void;
  focusPrev(): void;

  // Movement
  move(id: number, x: number, y: number, opts?: { snap?: boolean }): void;
  resize(id: number, dir: ResizeDir, dx: number, dy: number): void;

  // State transitions
  minimize(id: number): void;
  restore(id: number): void;
  toggleMinimize(id: number): void;
  toggleMaximize(id: number): void;
  toggleFullscreen(id: number): void;

  // Viewport
  setViewport(viewport: { width: number; height: number }): void;
  getViewport(): { width: number; height: number };

  // Queries
  getWindow(id: number): Window | null;
  getWindows(): Window[];
  getVisibleWindows(): Window[];
  getMinimizedWindows(): Window[];
  getActive(): Window | null;
  getByApp(appId: string): Window[];
  getWindowsSortedByZ(): Window[];
  getWindowsSortedByZDesc(): Window[];
  count(): number;
  has(id: number): boolean;
  hitTest(x: number, y: number): number | null;
  getIntersecting(rect: Rect): Window[];

  // Metadata
  setMetadata(id: number, metadata: any): void;
  getMetadata(id: number): any;

  // Persistence
  serialize(): string;
  hydrate(json: string | object): boolean;
  exportLayout(): Layout;

  // Events
  subscribe(fn: (state: State) => void): () => void;
  getState(): State;
  batch(fn: () => void): void;
}
```

#### `OpenOptions`

```ts
type OpenOptions = {
  appId?: string;
  title?: string;
  component?: React.ComponentType | null;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  data?: any;
  state?: "normal" | "minimized" | "maximized" | "fullscreen";
  resizable?: boolean;
  closable?: boolean;
  minimizable?: boolean;
  maximizable?: boolean;
  fullscreenable?: boolean;
  minWidth?: number;
  minHeight?: number;
  metadata?: any;
};
```

#### `Window`

```ts
type Window = {
  id: number;
  appId: string;
  title: string;
  component: React.ComponentType | null;
  data: any;
  x: number;
  y: number;
  width: number;
  height: number;
  state: "normal" | "minimized" | "maximized" | "fullscreen";
  zIndex: number;
  createdAt: number;
  lastFocusedAt: number;
  flags: {
    resizable: boolean;
    closable: boolean;
    minimizable: boolean;
    maximizable: boolean;
    fullscreenable: boolean;
  };
  minWidth: number;
  minHeight: number;
};
```

#### `State`

```ts
type State = {
  windows: Window[];
  activeId: number | null;
  viewport: { width: number; height: number };
};
```

#### `ResizeDir`

```ts
type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
```

### `WindowManagerProvider` (component)

```tsx
<WindowManagerProvider manager={optionalManager}>
  {children}
</WindowManagerProvider>
```

| Prop | Type | Default | Description |
|---|---|---|---|
| `children` | ReactNode | — | Tree to wrap |
| `manager` | `WindowManager` | auto | Optional instance |

### `useWindowManager()` (hook)

Returns:

```ts
{
  manager: WindowManager;
  windows: Window[];
  activeId: number | null;
  viewport: { width: number; height: number };

  // Lifecycle
  open(opts: OpenOptions): number;
  close(id: number): boolean;
  closeAll(): void;
  reset(): void;
  update(id: number, patch: Partial<Window>): void;
  setTitle(id: number, title: string): void;
  setData(id: number, data: any): void;

  // Focus
  focus(id: number): void;
  blur(): void;
  focusNext(): void;
  focusPrev(): void;

  // Movement
  move(id: number, x: number, y: number, opts?: { snap?: boolean }): void;
  resize(id: number, dir: ResizeDir, dx: number, dy: number): void;

  // State
  minimize(id: number): void;
  restore(id: number): void;
  toggleMinimize(id: number): void;
  toggleMaximize(id: number): void;
  toggleFullscreen(id: number): void;

  // Queries
  getWindow(id: number): Window | null;
  getWindows(): Window[];
  getVisibleWindows(): Window[];
  getMinimizedWindows(): Window[];
  getActive(): Window | null;
  getByApp(appId: string): Window[];
  getWindowsSortedByZ(): Window[];
  getWindowsSortedByZDesc(): Window[];
  count(): number;
  has(id: number): boolean;
  hitTest(x: number, y: number): number | null;
  getIntersecting(rect: Rect): Window[];

  // Metadata
  setMetadata(id: number, metadata: any): void;
  getMetadata(id: number): any;

  // Persistence
  serialize(): string;
  hydrate(json: string | object): boolean;
  exportLayout(): Layout;

  // Viewport
  setViewport(v: { width: number; height: number }): void;
  getViewport(): { width: number; height: number };

  // Batch
  batch(fn: () => void): void;
}
```

### `useDraggable(id, options)` (hook)

```ts
function useDraggable(
  id: number,
  options?: {
    snap?: boolean;
    threshold?: number;
    onStart?: (info: DragInfo) => void;
    onMove?: (info: DragMoveInfo) => void;
    onEnd?: (info: DragEndInfo) => void;
    getOrigin?: () => { x: number; y: number };
  }
): {
  handleMouseDown: (e: React.MouseEvent) => void;
};

type DragInfo = { id: number; x: number; y: number };
type DragMoveInfo = { id: number; x: number; y: number; dx: number; dy: number };
type DragEndInfo = { id: number; x: number | null; y: number | null; moved: boolean };
```

### `useResizable(id, dir, options)` (hook)

```ts
function useResizable(
  id: number,
  dir: ResizeDir,
  options?: {
    onStart?: (info: { id: number; dir: ResizeDir }) => void;
    onMove?: (info: { id: number; dir: ResizeDir; dx: number; dy: number }) => void;
    onEnd?: (info: { id: number; dir: ResizeDir; moved: boolean }) => void;
  }
): {
  handleMouseDown: (e: React.MouseEvent) => void;
};
```

### Kernel constants

```ts
const Z_BASE = 100;
const Z_STEP = 1;
const Z_MENUBAR = 10000;
const Z_DOCK = 9000;

const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;
const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 480;

const TOP_RESERVED = 28;
const BOTTOM_RESERVED = 96;

const SNAP_THRESHOLD = 12;
const DOUBLE_CLICK_MS = 280;
const CASCADE_STEP = 28;
const CASCADE_WRAP = 8;

const WINDOW_STATE = {
  NORMAL: "normal",
  MINIMIZED: "minimized",
  MAXIMIZED: "maximized",
  FULLSCREEN: "fullscreen",
} as const;

const RESIZE_DIRS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
```

### Kernel geometry utilities

```ts
function clamp(v: number, min: number, max: number): number;
function clampToViewport(x, y, width, height, viewport): { x: number; y: number };
function constrainResize(rect, dir, dx, dy): Rect;
function applySnap(x, y, width, height, viewport): { x: number; y: number };
function cascadePosition(index, viewport, width, height): { x: number; y: number };
function rectsIntersect(a: Rect, b: Rect): boolean;
function pointInRect(px, py, rect: Rect): boolean;
function isObject(v: any): boolean;
function deepClone<T>(v: T): T;
function noop(): void;
function now(): number;
```

### Kernel bus

```ts
kernelBus.on(event, handler): () => void;
kernelBus.once(event, handler): () => void;
kernelBus.off(event, handler): void;
kernelBus.emit(event, payload): void;
kernelBus.clear(event?): void;
kernelBus.count(event): number;
```

---

## Bootstrap

### `Bootstrap` (class)

```ts
class Bootstrap {
  constructor(options?: BootstrapOptions);

  registerModule(id: string, mod: ModuleDefinition): boolean;
  registerModules(list: [string, ModuleDefinition][]): void;
  run(opts?: { dispatch?; onReady?; onFail? }): Promise<BootstrapResult>;
  abort(): void;
  dispose(): void;
}

type BootstrapOptions = {
  serviceWorkerUrl?: string | null;
  serviceWorkerOptions?: RegistrationOptions;
  installErrorHandlers?: boolean;
  installPolyfills?: boolean;
  freeze?: boolean;
  allowSSR?: boolean;
  strict?: boolean;
};

type ModuleDefinition = {
  priority?: number;
  critical?: boolean;
  deps?: string[];
  loader?: () => Promise<void>;
  timeout?: number;
  retries?: number;
};

type BootstrapResult =
  | { ok: true; ssr: boolean; moduleResults?: { ok: string[]; failed: string[] } }
  | { ok: false; error: any };
```

### `BootstrapProvider` (component)

```tsx
<BootstrapProvider
  bootstrap={optionalInstance}
  autoRun={true}
  options={{ strict: false }}
  onReady={(info) => {}}
  onFail={(err) => {}}
>
  {children}
</BootstrapProvider>
```

### `useBootstrap()` (hook)

```ts
{
  bootstrap: Bootstrap;
  state: BootstrapState;
  phase: BootstrapPhase;
  isReady: boolean;
  isFailed: boolean;
  isSSR: boolean | null;

  validation: ValidationResult | null;
  polyfills: { installed: string[]; skipped: string[]; failed: any[] };
  frozen: string[];
  modules: { registered: string[]; loaded: string[]; failed: string[] };
  globalErrors: any[];
  globalRejections: any[];
  sw: { scope: string } | null;
  durationMs: number;
  error: string | null;
  trace: TraceLog;

  run(opts?): Promise<BootstrapResult>;
  abort(): void;
  dispose(): void;
  registerModule(id: string, mod: ModuleDefinition): boolean;
  registerModules(list: [string, ModuleDefinition][]): void;
  onEvent(event: string, handler: Function): () => void;
}
```

### Bootstrap utilities

```ts
function validateEnvironment(): ValidationResult;
function installPolyfills(): { installed: string[]; skipped: string[]; failed: any[] };
function freezeCriticalObjects(): string[];
function installGlobalErrorHandlers(): () => void;
function registerServiceWorker(url: string, opts?: RegistrationOptions): Promise<ServiceWorkerRegistration | null>;
function bootstrapSystem(options?: BootstrapOptions): Promise<{ bootstrap: Bootstrap; result: BootstrapResult }>;

class ModuleManifest {
  register(id: string, mod: ModuleDefinition): boolean;
  get(id: string): ModuleDefinition | null;
  order(): ModuleDefinition[];
  load(id: string): Promise<boolean>;
  loadAll(): Promise<{ ok: string[]; failed: string[] }>;
  reset(): void;
  all(): ModuleDefinition[];
}

class TraceLog {
  push(level: string, message: string, meta?: any): LogEntry;
  info(msg: string, meta?: any): LogEntry;
  warn(msg: string, meta?: any): LogEntry;
  error(msg: string, meta?: any): LogEntry;
  debug(msg: string, meta?: any): LogEntry;
  all(): LogEntry[];
  clear(): void;
  dump(): string;
}
```

### Bootstrap hooks

```ts
function useBootstrapTrace(): TraceLog;
function useGlobalErrors(): { globalErrors: any[]; globalRejections: any[] };
function useSystemModule(id: string, mod: ModuleDefinition): boolean;
```

---

## BootLoader

### `BootLoader` (class)

```ts
class BootLoader {
  constructor(options?: BootLoaderOptions);

  onPhase(phase: string, handler: (info: any) => void): () => void;

  run(opts: {
    dispatch: Function;
    safeBoot?: SafeBoot;
    safeBootDispatch?: Function;
    safeBootGetState?: Function;
    onAbort?: () => void;
  }): Promise<boolean>;

  abort(dispatch: Function): void;
  setSelectedVolume(id: string, dispatch: Function): void;
  toggleFlag(flag: string, dispatch: Function): void;
  enterRecovery(dispatch: Function): Promise<boolean>;
  exitRecovery(dispatch: Function): void;
  attachKeyHandler(dispatch: Function, onAbort?: () => void): void;
  detachKeyHandler(): void;
  saveFlagsToNVRAM(): void;
}

type BootLoaderOptions = {
  countdownMs?: number;
  watchdogMs?: number;
  nvramKey?: string;
  autoStart?: boolean;
  defaultVolumeId?: string;
  forceFlags?: string[];
  storage?: Storage;
};
```

### `BootLoaderProvider` (component)

```tsx
<BootLoaderProvider
  loader={optionalInstance}
  safeBoot={safeBootInstance}
  autoRun={true}
  onAbort={() => {}}
  options={{ countdownMs: 3000 }}
>
  {children}
</BootLoaderProvider>
```

### `useBootLoader()` (hook)

```ts
{
  loader: BootLoader;
  state: LoaderState;
  phase: LoaderPhase;
  isReady: boolean;
  isFailed: boolean;

  env: EnvReport | null;
  volumes: Volume[];
  selectedVolumeId: string | null;
  countdown: number | null;
  flags: string[];
  verbose: boolean;
  recovery: boolean;
  errors: any[];
  warnings: any[];
  logs: LogEntry[];
  durationMs: number;

  abort(): void;
  setSelectedVolume(id: string): void;
  toggleFlag(flag: string): void;
  enterRecovery(): Promise<boolean>;
  exitRecovery(): void;
  hasFlag(flag: string): boolean;
  getFlagList(): string[];

  nvramGet(key: string, def?: any): any;
  nvramSet(key: string, value: any): void;
  nvramReset(): void;
}
```

### BootLoader classes

```ts
class NVRAM {
  constructor(key?: string, storage?: Storage);
  save(): void;
  load(): Record<string, any>;
  get(key: string, def?: any): any;
  set(key: string, value: any): void;
  remove(key: string): void;
  reset(): void;
  all(): Record<string, any>;
}

class VolumeScanner {
  constructor(storage?: Storage);
  scan(): Promise<Volume[]>;
}

class BootFlags {
  constructor(initial?: Record<string, boolean>);
  has(flag: string): boolean;
  add(flag: string): boolean;
  remove(flag: string): boolean;
  toggle(flag: string): void;
  set(list: string[]): void;
  list(): string[];
  clear(): void;
}

class Watchdog {
  constructor(timeoutMs: number);
  start(onTimeout: () => void): void;
  kick(): void;
  stop(): void;
  elapsed(): number;
}
```

### BootLoader hooks

```ts
function useBootFlags(): { flags: string[]; toggleFlag: Function; hasFlag: Function };
function useCountdown(): number | null;
```

---

## SafeBoot

### `SafeBoot` (class)

```ts
class SafeBoot {
  constructor(options?: SafeBootOptions);

  onPhase(phase: string, handler: PhaseHandler): () => void;

  registerService(name: string, service: ServiceDefinition): void;
  registerExtension(id: string, ext: ExtensionDefinition): void;
  registerIntegrityCheck(name: string, fn: () => any): void;

  subscribe(fn: (state: any) => void): () => void;

  boot(dispatch: Function, getState: () => any): Promise<void>;
  shutdown(): Promise<void>;
  reboot(dispatch: Function, getState: () => any): Promise<void>;
  abort(): void;

  isSafeModeEnabled(): boolean;
  enableSafeModeForNextBoot(): void;
  disableSafeModeForNextBoot(): void;

  hasSavedSession(): boolean;
  saveCurrentSession(): void;
  loadSavedSession(): boolean;
  clearSavedSession(): void;
}

type SafeBootOptions = {
  windowManager?: WindowManager;
  storage?: Storage;
  storageKey?: string;
  sessionKey?: string;
  maxLogs?: number;
  forceSafeMode?: boolean;
};

type ServiceDefinition = {
  deps?: string[];
  critical?: boolean;
  safeMode?: boolean;
  start?: (ctx: { logger: BootLogger }) => Promise<void>;
  stop?: (ctx: { logger: BootLogger }) => Promise<void>;
  timeout?: number;
  retries?: number;
};

type ExtensionDefinition = {
  version?: string;
  mandatory?: boolean;
  compatibleSafeMode?: boolean;
  load?: () => Promise<void>;
};

type PhaseHandler = (info: { phase: string; state: any; logger: BootLogger }) => Promise<void> | void;
```

### `SafeBootProvider` (component)

```tsx
<SafeBootProvider
  boot={optionalInstance}
  autoStart={true}
  windowManager={optionalWindowManager}
  forceSafeMode={false}
>
  {children}
</SafeBootProvider>
```

### `useSafeBoot()` (hook)

```ts
{
  boot: SafeBoot;
  state: SafeBootState;
  phase: BootPhase;
  progress: number;
  safeMode: boolean;
  isReady: boolean;
  isSafeMode: boolean;
  isFailed: boolean;

  errors: any[];
  warnings: any[];
  logs: LogEntry[];

  start(): Promise<void>;
  shutdown(): Promise<void>;
  reboot(): Promise<void>;
  abort(): void;

  enableSafeModeForNextBoot(): void;
  disableSafeModeForNextBoot(): void;
  isSafeModeEnabled(): boolean;

  hasSavedSession(): boolean;
  saveCurrentSession(): void;
  loadSavedSession(): boolean;
  clearSavedSession(): void;

  registerService(name: string, svc: ServiceDefinition): void;
  registerExtension(id: string, ext: ExtensionDefinition): void;
  registerIntegrityCheck(name: string, fn: () => any): void;
  onPhase(phase: string, handler: PhaseHandler): () => void;
}
```

### SafeBoot hooks

```ts
function useBootPhase(targetPhase: string): boolean;
function useBootProgress(): number;
```

### SafeBoot classes

```ts
class ServiceRegistry {
  register(name: string, service: ServiceDefinition): void;
  get(name: string): ServiceDefinition | null;
  all(): ServiceDefinition[];
  order(): string[];
  markStarted(name: string): void;
  markFailed(name: string): void;
  isStarted(name: string): boolean;
  isFailed(name: string): boolean;
  reset(): void;
}

class ExtensionRegistry {
  register(id: string, ext: ExtensionDefinition): void;
  get(id: string): ExtensionDefinition | null;
  all(): ExtensionDefinition[];
}

class BootLogger {
  log(level: string, message: string, meta?: any): void;
  info(msg: string, meta?: any): void;
  warn(msg: string, meta?: any): void;
  error(msg: string, meta?: any): void;
  debug(msg: string, meta?: any): void;
  getEntries(): LogEntry[];
  clear(): void;
}
```

---

## StartupInstaller

### `StartupInstaller` (class)

```ts
class StartupInstaller {
  constructor(options?: InstallerOptions);

  run(opts: { dispatch: Function }): Promise<void>;
  abort(): void;
}

type InstallerOptions = {
  imageMaxBytes?: number;
  imageConcurrency?: number;
  assets?: Record<string, AssetDefinition>;
  preload?: string[];
  strict?: boolean;
};

type AssetDefinition = {
  src: string;
  kind?: "image" | "svg" | "sprite" | "sound" | "font";
  mime?: string;
  size?: number;
  meta?: any;
};
```

### `StartupInstallerProvider` (component)

```tsx
<StartupInstallerProvider autoRun options={{ imageMaxBytes: 64 * 1024 * 1024 }}>
  {children}
</StartupInstallerProvider>
```

### `useStartupInstaller()` (hook)

```ts
{
  installer: StartupInstaller;
  state: InstallerState;
  progress: number;
  isReady: boolean;
  isFailed: boolean;

  imageRuntime: ImageRuntime;
  windowRuntime: WindowRuntime;
  multitaskRuntime: MultitaskRuntime;

  run(): Promise<void>;
  abort(): void;

  // Image runtime
  decode(src: string, opts?): Promise<ImageBitmap | HTMLImageElement>;
  preload(list: (string | { src: string })[], opts?): Promise<any[]>;
  registerAsset(id: string, asset: AssetDefinition): void;
  registerAssets(map: Record<string, AssetDefinition>): void;
  getAsset(id: string): AssetDefinition | null;
  listAssets(): AssetDefinition[];
  clearCache(): void;
  stats(): ImageRuntimeStats;

  // Window runtime
  getStyle(id: string): WindowStyle | null;
  getCursor(zone: string): string;
  getEffect(id: string): WindowEffect | null;
  getTrafficLights(id: string): TrafficLights | null;

  // Multitask runtime
  registerSpace(id: string, space: SpaceDefinition): void;
  registerHotCorner(corner: string, cfg: HotCornerDefinition): void;
  registerGesture(id: string, gesture: GestureDefinition): void;
  registerShortcut(combo: string, shortcut: ShortcutDefinition): void;
  registerTransition(id: string, transition: TransitionDefinition): void;
  setMissionControl(cfg: MissionControlConfig): void;
  getMissionControl(): MissionControlConfig;
}
```

### Installer classes

```ts
class ImageRuntime {
  constructor(opts?: { maxBytes?: number; concurrency?: number });
  registerFormat(mime: string, info: { ext: string[]; decoder?: Function }): void;
  hasFormat(mime: string): boolean;
  formatsList(): string[];
  registerAsset(id: string, asset: AssetDefinition): void;
  registerAssets(map: Record<string, AssetDefinition>): void;
  hasAsset(id: string): boolean;
  getAsset(id: string): AssetDefinition | null;
  listAssets(): AssetDefinition[];
  decode(src: string, opts?): Promise<ImageBitmap | HTMLImageElement>;
  preload(list: (string | { src: string })[], opts?): Promise<any[]>;
  preloadAssets(ids: string[], opts?): Promise<any[]>;
  load(idOrSrc: string, opts?): Promise<ImageBitmap | HTMLImageElement>;
  release(src: string, opts?): boolean;
  clearCache(): void;
  stats(): ImageRuntimeStats;
}

class WindowRuntime {
  registerStyle(id: string, style: WindowStyle): void;
  getStyle(id: string): WindowStyle | null;
  registerCursor(zone: string, cursor: string): void;
  getCursor(zone: string): string;
  registerEffect(id: string, effect: WindowEffect): void;
  getEffect(id: string): WindowEffect | null;
  registerTrafficLights(id: string, cfg: TrafficLights): void;
  getTrafficLights(id: string): TrafficLights | null;
}

class MultitaskRuntime {
  registerSpace(id: string, space: SpaceDefinition): void;
  getSpace(id: string): SpaceDefinition | null;
  listSpaces(): SpaceDefinition[];
  registerHotCorner(corner: string, cfg: HotCornerDefinition): void;
  getHotCorner(corner: string): HotCornerDefinition | null;
  listHotCorners(): HotCornerDefinition[];
  registerGesture(id: string, gesture: GestureDefinition): void;
  getGesture(id: string): GestureDefinition | null;
  listGestures(): GestureDefinition[];
  registerShortcut(combo: string, shortcut: ShortcutDefinition): void;
  getShortcut(combo: string): ShortcutDefinition | null;
  listShortcuts(): ShortcutDefinition[];
  registerTransition(id: string, transition: TransitionDefinition): void;
  getTransition(id: string): TransitionDefinition | null;
  listTransitions(): TransitionDefinition[];
  setMissionControl(cfg: MissionControlConfig): void;
  getMissionControl(): MissionControlConfig;
}
```

---

## InitialConfig

### `InitialConfig` (class)

```ts
class InitialConfig {
  constructor(options?: InitialConfigOptions);

  onStep(step: string, handler: StepHandler): () => void;

  autoDetect(): Promise<Partial<Config>>;
  save(config: Config): boolean;
  load(): Config | null;
  isConfigured(): boolean;
  reset(): void;

  apply(config: Config, dispatch: Function): Promise<void>;
  abort(): void;
}

type InitialConfigOptions = {
  storageNamespace?: string;
  autoDetect?: boolean;
  strict?: boolean;
};

type Config = typeof DEFAULT_CONFIG;
```

### `InitialConfigProvider` (component)

```tsx
<InitialConfigProvider
  initialConfig={optionalInstance}
  autoStart={true}
  options={{ autoDetect: true }}
  onComplete={() => {}}
  onFail={(err) => {}}
>
  {children}
</InitialConfigProvider>
```

### `useInitialConfig()` (hook)

```ts
{
  config: InitialConfig;
  state: InitialConfigState;
  step: SetupStep;
  progress: number;
  values: Config;
  errors: Record<string, string>;
  isComplete: boolean;
  isFailed: boolean;

  goTo(step: SetupStep): void;
  next(): void;
  prev(): void;
  setValue(path: string, value: any): void;
  setValues(partial: Partial<Config>): void;
  validate(step?: SetupStep): { ok: boolean; errors: Record<string, string> };
  apply(): Promise<void>;
  reset(): void;
}
```

### InitialConfig constants

```ts
const DEFAULT_CONFIG = { /* see below */ };
const LANGUAGES: Language[];
const REGIONS: Region[];
const TIMEZONES: Timezone[];
const KEYBOARDS: Keyboard[];
const DATE_FORMATS: DateFormat[];
const NUMBER_FORMATS: NumberFormat[];
const ACCENT_COLORS: AccentColor[];
const WALLPAPERS: Wallpaper[];
const DOCK_POSITIONS: string[];
const DOCK_SIZES: string[];
```

### InitialConfig validators

```ts
function validateConfig(config: Config, step?: SetupStep): { ok: boolean; errors: Record<string, string> };
```

---

## InitSystem

### `InitSystem` (component)

```tsx
<InitSystem
  progress={0}
  phase="power-on"
  safeMode={false}
  failed={false}
  error={null}
  verbose={false}
  logs={[]}
  onFinished={() => {}}
  minDuration={1200}
  holdOnError={true}
  bg="#000"
  fg="#fff"
/>
```

| Prop | Type | Default | Description |
|---|---|---|---|
| `progress` | number | — | Progress 0–100 |
| `phase` | string | `"pending"` | Current boot phase |
| `safeMode` | boolean | `false` | Safe mode flag |
| `failed` | boolean | `false` | Failed flag |
| `error` | any | `null` | Error to display |
| `verbose` | boolean | `false` | Verbose mode |
| `logs` | LogEntry[] | `[]` | Log entries for verbose mode |
| `onFinished` | function | — | Called after fade-out |
| `minDuration` | number | `1200` | Min display time in ms |
| `holdOnError` | boolean | `true` | Keep screen on error |
| `bg` | string | `"#000"` | Background color |
| `fg` | string | `"#fff"` | Foreground color |

### `ConnectedInitSystem` (component)

Same props as `InitSystem`, plus:

| Prop | Type | Description |
|---|---|---|
| `bootstrap` | object | Return value of `useBootstrap()` |
| `bootloader` | object | Return value of `useBootLoader()` |
| `safeboot` | object | Return value of `useSafeBoot()` |

### InitSystem sub-components

```tsx
<AppleLogo size={120} color="#fff" opacity={1} className="custom" />
<Spinner size={24} color="#fff" thickness={3} />
<ProgressBar value={75} width={260} height={4} color="#fff" indeterminate={false} />
```

### InitSystem hook

```ts
function useInitGate(): { booted: boolean; onFinished: () => void };
```

---

## LockScreen

### `LockScreen` (class)

```ts
class LockScreen {
  constructor(options?: LockOptions);

  onUnlocked(fn: (reason: string) => void): () => void;
  onLocked(fn: (reason: string) => void): () => void;
  onShutdown(fn: () => void): () => void;
  onRestart(fn: () => void): () => void;

  bootstrap(dispatch: Function): void;
  dispose(): void;

  lock(dispatch: Function, reason?: string, opts?: { grace?: boolean }): void;
  unlock(dispatch: Function, method: string): void;

  authenticate(dispatch: Function, password: string): Promise<boolean>;
  authenticateBiometry(dispatch: Function): Promise<boolean>;

  switchUser(dispatch: Function, userId: string): void;

  showScreenSaver(dispatch: Function): void;
  hideScreenSaver(dispatch: Function): void;

  sleep(dispatch: Function): void;
  wake(dispatch: Function): void;
  shutdown(dispatch: Function): void;
  restart(dispatch: Function): void;
  cancel(dispatch: Function): void;

  startClock(dispatch: Function): void;
  stopClock(): void;
}

type LockOptions = {
  idleTimeoutMs?: number;
  screenSaverTimeoutMs?: number;
  lockOnVisibilityHidden?: boolean;
  lockOnSuspend?: boolean;
  requirePasswordAfterMs?: number;
  maxFailedAttempts?: number;
  lockoutBaseMs?: number;
  lockoutMultiplier?: number;
  gracePeriodMs?: number;
  showClock?: boolean;
  clockFormat?: "12h" | "24h";
  showBattery?: boolean;
  showNetwork?: boolean;
  enableTouchId?: boolean;
  enableWatchUnlock?: boolean;
  shakeOnFail?: boolean;
  blurWallpaper?: boolean;
  dimBackground?: boolean;
};
```

### `LockScreenProvider` (component)

```tsx
<LockScreenProvider
  lock={optionalInstance}
  autoLock={true}
  options={{}}
  onUnlocked={(reason) => {}}
  onLocked={(reason) => {}}
  onShutdown={() => {}}
  onRestart={() => {}}
>
  {children}
</LockScreenProvider>
```

### `useLockScreen()` (hook)

```ts
{
  lock: LockScreen;
  state: LockState;
  locked: boolean;
  unlocking: boolean;
  showScreenSaver: boolean;
  currentUserId: string | null;
  failedAttempts: number;
  lockoutUntil: number | null;
  banner: { type: string; message: string } | null;
  shakeKey: number;
  now: number;
  options: LockOptions;
  logs: LogEntry[];
  users: User[];

  // Actions
  lockNow(): void;
  lockIdle(): void;
  lockGrace(): void;
  unlock(): void;
  authenticate(password: string): Promise<boolean>;
  authenticateBiometry(): Promise<boolean>;
  switchUser(id: string): void;
  showScreenSaver(): void;
  hideScreenSaver(): void;
  sleep(): void;
  wake(): void;
  shutdown(): void;
  restart(): void;
  cancel(): void;
  clearBanner(): void;
  setOptions(opts: Partial<LockOptions>): void;
  reloadUsers(): void;
}
```

### `LockScreenView` (component)

```tsx
<LockScreenView
  bg="#000"
  fg="#fff"
  onUnlocked={() => {}}
/>
```

### LockScreen hooks

```ts
function useLocked(): boolean;
function useLockActions(): {
  lockNow: () => void;
  sleep: () => void;
  shutdown: () => void;
  restart: () => void;
};
```

### LockScreen classes

```ts
class NVRAM { /* see BootLoader */ }
class IdleMonitor {
  constructor(opts: { onIdle: Function; onActive: Function; idleMs: number });
  attach(): void;
  detach(): void;
  setIdleMs(ms: number): void;
  isIdle(): boolean;
  lastActivityAt(): number;
}

class UserRegistry {
  list(): User[];
  get(id: string): User | null;
  getActive(): User | null;
  setActive(id: string): boolean;
  hasPassword(user: User): boolean;
  reload(): void;
}
```

---

## Constants Index

Every constant exported by rainOS.

| Constant | Module | Purpose |
|---|---|---|
| `BOOTSTRAP_STATE` | bootstrap | Bootstrap state machine |
| `BOOTSTRAP_EVENTS` | bootstrap | Bootstrap event names |
| `BOOTSTRAP_PRIORITY` | bootstrap | Module priorities |
| `LOADER_STATE` | bootloader | BootLoader state machine |
| `LOADER_EVENTS` | bootloader | BootLoader event names |
| `BOOT_FLAG` | bootloader | Boot flags |
| `BOOT_PHASE` | safeboot | SafeBoot phases |
| `BOOT_ORDER` | safeboot | Phase order |
| `SAFE_BOOT_PHASES` | safeboot | Safe mode phases |
| `BOOT_EVENTS` | safeboot | SafeBoot event names |
| `WINDOW_STATE` | kernel | Window states |
| `RESIZE_DIRS` | kernel | Resize directions |
| `KERNEL_EVENTS` | kernel | Kernel event names |
| `Z_BASE`, `Z_STEP`, `Z_MENUBAR`, `Z_DOCK` | kernel | Z-index constants |
| `MIN_WIDTH`, `MIN_HEIGHT` | kernel | Minimum sizes |
| `DEFAULT_WIDTH`, `DEFAULT_HEIGHT` | kernel | Default sizes |
| `TOP_RESERVED`, `BOTTOM_RESERVED` | kernel | Reserved areas |
| `SNAP_THRESHOLD`, `DOUBLE_CLICK_MS` | kernel | Behavior constants |
| `CASCADE_STEP`, `CASCADE_WRAP` | kernel | Cascade constants |
| `INSTALL_STATE` | startupinstaller | Installer state machine |
| `INSTALL_EVENTS` | startupinstaller | Installer event names |
| `ASSET_KIND` | startupinstaller | Asset kinds |
| `WINDOW_ZONE` | startupinstaller | Window interaction zones |
| `SETUP_STEP` | initialconfig | Setup steps |
| `SETUP_ORDER` | initialconfig | Step order |
| `SETUP_EVENTS` | initialconfig | Setup event names |
| `DEFAULT_CONFIG` | initialconfig | Default configuration |
| `LANGUAGES`, `REGIONS`, `TIMEZONES` | initialconfig | Locale data |
| `KEYBOARDS`, `DATE_FORMATS`, `NUMBER_FORMATS` | initialconfig | Input data |
| `ACCENT_COLORS`, `WALLPAPERS` | initialconfig | Appearance data |
| `DOCK_POSITIONS`, `DOCK_SIZES` | initialconfig | Dock data |
| `LOCK_STATE` | lockscreen | Lock state machine |
| `AUTH_METHOD` | lockscreen | Auth methods |
| `LOCK_EVENTS` | lockscreen | Lock event names |
| `DEFAULT_LOCK_OPTIONS` | lockscreen | Default lock options |

---

## Utility Index

Every pure utility exported by rainOS.

### Kernel

| Utility | Description |
|---|---|
| `clamp` | Clamp a number between min and max |
| `clampToViewport` | Keep a rect inside the viewport |
| `constrainResize` | Compute resize respecting minimums |
| `applySnap` | Apply edge snapping |
| `cascadePosition` | Compute cascade position for new window |
| `rectsIntersect` | Test if two rects overlap |
| `pointInRect` | Test if a point is inside a rect |
| `isObject` | Type check |
| `deepClone` | Deep clone any value |
| `noop` | Empty function |
| `now` | High-resolution timestamp |

### Bootstrap

| Utility | Description |
|---|---|
| `validateEnvironment` | Check required globals |
| `installPolyfills` | Install missing APIs |
| `freezeCriticalObjects` | Freeze exported constants |
| `installGlobalErrorHandlers` | Register error/rejection handlers |
| `registerServiceWorker` | Register a Service Worker |
| `bootstrapSystem` | Run bootstrap without React |

### BootLoader

| Utility | Description |
|---|---|
| `detectEnvironment` (internal) | Detect browser capabilities |

### InitialConfig

| Utility | Description |
|---|---|
| `validateConfig` | Validate config for a given step |

### LockScreen

| Utility | Description |
|---|---|
| `hashPassword` (internal) | SHA-256 hash with fallback |
| `constantTimeEqual` (internal) | Constant-time string compare |

---

## Notes

- All classes are **pure**: they can be instantiated outside React.
- All providers are **optional**: you can use the class directly and skip
  React entirely.
- All hooks assume the corresponding provider is mounted in the tree.
  Calling `useWindowManager` outside `WindowManagerProvider` throws.
- All buses are **global singletons** shared across the app. Subscribe in
  `useEffect` and unsubscribe on cleanup.
- All persistence uses `localStorage` with namespaced keys.
