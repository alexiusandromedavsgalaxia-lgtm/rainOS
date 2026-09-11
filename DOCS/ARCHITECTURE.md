# rainOS Architecture

Complete technical documentation for rainOS: architecture, boot sequence,
window manager, events, and full API reference — all in one document.

---

## Table of Contents

1. [Overview](#overview)
2. [Design Principles](#design-principles)
3. [Boot Sequence](#boot-sequence)
4. [Modules](#modules)
5. [Window Manager](#window-manager)
6. [Events Reference](#events-reference)
7. [API Reference](#api-reference)
8. [State Model](#state-model)
9. [Persistence](#persistence)
10. [Conventions](#conventions)
11. [Design Decisions](#design-decisions)
12. [Future Extensions](#future-extensions)

---

## Overview

rainOS is a **kernel of an operating system written in pure React** that
simulates macOS behavior at the logic level: boot, windows, multitasking,
configuration, and locking. It does not render a full desktop on its own,
but provides all the primitives needed to build one.

The system is composed of **8 independent modules** wired together in a
deterministic boot chain, just like a real OS:

```
┌─────────────┐   ┌────────────┐   ┌──────────┐   ┌──────────┐
│  Bootstrap  │ → │ BootLoader │ → │ SafeBoot │ → │  Kernel  │
└─────────────┘   └────────────┘   └──────────┘   └──────────┘
                                                        │
                        ┌───────────────────────────────┤
                        │                               │
                ┌───────▼────────┐             ┌────────▼────────┐
                │ StartupInstal. │             │  InitialConfig  │
                └───────┬────────┘             └────────┬────────┘
                        │                               │
                        └───────────────┬───────────────┘
                                        │
                                ┌───────▼────────┐
                                │   InitSystem   │
                                └───────┬────────┘
                                        │
                                ┌───────▼────────┐
                                │   LockScreen   │
                                └────────────────┘
```

Each module:

- Is **autonomous**: exposes its own class, provider, hooks, and events.
- Is **composable**: can be used alone or combined with others.
- Has **zero external dependencies** (React is the only peer dependency).
- Separates **pure logic** (classes) from **React binding** (providers/hooks).
- Emits **events** on a global bus so other modules can react without
  coupling to internal state.

---

## Design Principles

### 1. Pure Logic Separated from React

Every module has a **pure class** (e.g. `WindowManager`, `BootLoader`,
`SafeBoot`) that does all the work. The React provider is only an adapter
that instantiates the class, subscribes to its changes, and exposes
actions and state via `useReducer` + `useMemo`.

This makes it possible to test the logic without mounting React, and to
swap frameworks without rewriting the kernel.

### 2. Decoupled Event Bus

All modules emit events to a shared `EventBus`. No module imports another
directly to react to changes; it listens to events instead.

```js
kernelBus.on(KERNEL_EVENTS.WINDOW_FOCUSED, ({ id }) => {
  console.log(`Window ${id} focused`);
});
```

### 3. Nested Providers, One Context per Module

Each module has its own `createContext`. They are nested in the React tree
following the boot chain:

```jsx
<BootstrapProvider>
  <WindowManagerProvider>
    <SafeBootProvider>
      <BootLoaderProvider>
        <LockScreenProvider>
          <App />
        </LockScreenProvider>
      </BootLoaderProvider>
    </SafeBootProvider>
  </WindowManagerProvider>
</BootstrapProvider>
```

### 4. Zero CSS, Zero Mandatory UI

Modules do not impose any UI. Only two of them ship an optional visual
component (`InitSystem`, `LockScreenView`) because without them the system
would not be usable during boot. Everything else is logic.

### 5. Opt-in Persistence

Each module persists its state in `localStorage` with independent
namespaces. If `localStorage` is unavailable, it falls back to memory.

---

## Boot Sequence

### Timeline

```
 T+0ms       T+50ms      T+200ms     T+800ms     T+1500ms    T+2000ms
   │           │           │           │           │           │
   ▼           ▼           ▼           ▼           ▼           ▼
┌─────┐    ┌──────┐    ┌───────┐   ┌─────────┐ ┌────────┐  ┌──────┐
│Boot │───▶│Loader│───▶│Safe   │──▶│ Window  │▶│ Init   │─▶│ Lock │
│strap│    │      │    │Boot   │   │ Manager │ │ System │  │Screen│
└─────┘    └──────┘    └───────┘   └─────────┘ └────────┘  └──────┘
  polyfills   detect      services    open windows  UI        auth
  validate    scan        kexts       multitask    progress
  freeze      countdown   session     dock         verbose
  modules     chainload   recovery
```

### Phase 1 — Bootstrap

**Module**: `bootstrap.jsx`

Runs the very first code of the system. Depends on nothing.

**Responsibilities**:
- Validate that `document`, `window`, `navigator` exist.
- Detect SSR and abort cleanly.
- Install polyfills (RAF, `performance.now`, `crypto.randomUUID`,
  `Array.at`, `Object.hasOwn`, `structuredClone`, `queueMicrotask`).
- Freeze critical objects to prevent external mutation.
- Install global handlers (`error`, `unhandledrejection`).
- Register and load initial modules in topological order.
- Optionally register a Service Worker.

**States**: `pending → validating → polyfilling → freezing → modules → ready`

**Events**: `bootstrap:started`, `bootstrap:validation-ok`,
`bootstrap:polyfill-installed`, `bootstrap:frozen`,
`bootstrap:module-registered`, `bootstrap:module-loaded`,
`bootstrap:ready`, `bootstrap:failed`

**Example timeline**:

```
[00:00.000] bootstrap:started
[00:00.001] bootstrap:state-changed       → validating
[00:00.005] bootstrap:validation-ok
[00:00.005] bootstrap:state-changed       → polyfilling
[00:00.010] bootstrap:polyfill-installed  → raf
[00:00.012] bootstrap:polyfill-installed  → performance-now
[00:00.014] bootstrap:polyfill-skipped    → crypto-randomUUID
[00:00.020] bootstrap:state-changed       → freezing
[00:00.021] bootstrap:frozen              → [BOOTSTRAP_STATE, BOOTSTRAP_EVENTS]
[00:00.023] bootstrap:state-changed       → modules
[00:00.050] bootstrap:state-changed       → ready
[00:00.051] bootstrap:ready
```

### Phase 2 — BootLoader

**Module**: `bootloader.jsx`

Pre-boot stage.

**Responsibilities**:
- Detect browser capabilities (WebGL, pointer, touch, fullscreen, etc.).
- Scan boot volumes (saved session, recovery, network).
- Manage countdown with keyboard flags.
- Interpret keys: `⌥` volume, `⌘V` verbose, `⇧` safe mode,
  `⌘R` recovery, `⌘S` single user, `⌘⌥PR` reset NVRAM, `Esc` abort.
- Chainload and hand off to SafeBoot.
- Watchdog (default 30s).

**States**: `idle → detecting → scanning → countdown → chainloading → handoff`

**Events**: `loader:started`, `loader:env-detected`,
`loader:volumes-scanned`, `loader:countdown-tick`,
`loader:chainload-start`, `loader:handoff`, `loader:failed`

**Example timeline**:

```
[00:00.052] loader:started
[00:00.052] loader:state-changed          → detecting
[00:00.100] loader:env-detected           → { capabilities: {...} }
[00:00.101] loader:state-changed          → scanning
[00:00.150] loader:volumes-scanned        → [main, session, recovery, network]
[00:00.152] loader:state-changed          → countdown
[00:01.152] loader:countdown-tick         → { seconds: 2 }
[00:02.152] loader:countdown-tick         → { seconds: 1 }
[00:03.152] loader:countdown-tick         → { seconds: 0 }
[00:03.153] loader:state-changed          → chainloading
[00:03.162] loader:handoff                → { flags: [], safeMode: false }
```

### Phase 3 — SafeBoot

**Module**: `safeboot.jsx`

Service and extension loading.

**Responsibilities**:
- Sort services by dependencies (topological order).
- Load each service with timeout and retries.
- Load extensions (kexts).
- Restore previous session from `localStorage`.
- Enter safe mode if integrity checks fail.

**Phases**: `power-on → post → loader → kernel-init → load-extensions →
load-services → restore-session → start-window-manager → ready`

**Events**: `boot:started`, `boot:phase-enter`, `boot:service-started`,
`boot:safe-mode-entered`, `boot:complete`, `boot:failed`

**Example timeline**:

```
[00:03.163] boot:started
[00:03.163] boot:phase-enter              → power-on
[00:03.165] boot:phase-enter              → post
[00:03.200] boot:integrity-ok
[00:03.204] boot:phase-enter              → kernel-init
[00:03.206] boot:phase-enter              → load-extensions
[00:03.220] boot:extension-loaded         → core-icons
[00:03.232] boot:phase-enter              → load-services
[00:03.250] boot:service-started          → storage
[00:03.255] boot:service-started          → notifications
[00:03.262] boot:phase-enter              → restore-session
[00:03.300] boot:session-restored
[00:03.304] boot:phase-enter              → ready
[00:03.305] boot:complete
```

### Phase 4 — Kernel

**Module**: `kernel.jsx`

Boots the window manager.

**Responsibilities**:
- Instantiate `WindowManager`.
- Load saved windows if any.
- Expose window API to React.

**States**: `normal`, `minimized`, `maximized`, `fullscreen`

### Phase 5 — StartupInstaller

**Module**: `startupinstaller.jsx`

Installs assets and graphic runtime.

**Responsibilities**:
- Install `ImageRuntime` (formats, decoder, LRU cache, preload).
- Install `WindowRuntime` (chrome, cursors, effects, traffic lights).
- Install `MultitaskRuntime` (spaces, hot corners, gestures, shortcuts).

**States**: `idle → loading-images → loading-windows → loading-multitask →
wiring → verifying → ready`

### Phase 6 — InitialConfig

**Module**: `initialconfig.jsx`

Setup Assistant. Runs only on first boot or after a reset.

**Steps**: `welcome → language → region → keyboard → network → migration →
account → appearance → dock → privacy → shortcuts → summary → applying → done`

### Phase 7 — InitSystem

**Module**: `initsystem.jsx`

Visual layer during boot. Shows the Apple logo and progress bar.

**Components**: `AppleLogo`, `Spinner`, `ProgressBar`, `InitSystem`,
`ConnectedInitSystem`

**Phase → label mapping**:

| Phase | Label |
|---|---|
| `pending` | Starting up… |
| `validating` | Verifying environment… |
| `polyfilling` | Preparing system… |
| `freezing` | Locking critical resources… |
| `modules` | Loading modules… |
| `detecting` | Detecting hardware… |
| `scanning` | Searching for boot volumes… |
| `countdown` | Press a key for boot options… |
| `chainloading` | Booting selected volume… |
| `handoff` | Handing control to the system… |
| `power-on` | Powering on… |
| `post` | Self-test… |
| `kernel-init` | Initializing kernel… |
| `load-extensions` | Loading extensions… |
| `load-services` | Starting services… |
| `restore-session` | Restoring session… |
| `start-window-manager` | Starting window manager… |
| `ready` | Ready |

### Phase 8 — LockScreen

**Module**: `lockscreen.jsx`

Intermediate layer between "the system booted" and "the user logged in".

**Responsibilities**:
- Password authentication (SHA-256, constant-time compare).
- Simulated Touch ID.
- Idle lock after X minutes of inactivity.
- Progressive lockout after N failed attempts.
- User switching, screensaver, sleep, shutdown, restart.

**States**: `idle`, `locked`, `unlocking`, `unlocked`, `screen-saver`,
`changing-user`, `shutting-down`, `restarting`, `sleeping`, `failed`

---

## Modules

### Module Table

| Module | Class | Provider | Main Hook | Bus |
|---|---|---|---|---|
| Kernel | `WindowManager` | `WindowManagerProvider` | `useWindowManager` | `kernelBus` |
| Bootstrap | `Bootstrap` | `BootstrapProvider` | `useBootstrap` | `bootstrapBus` |
| BootLoader | `BootLoader` | `BootLoaderProvider` | `useBootLoader` | `kernelBus` |
| SafeBoot | `SafeBoot` | `SafeBootProvider` | `useSafeBoot` | `kernelBus` |
| StartupInstaller | `StartupInstaller` | `StartupInstallerProvider` | `useStartupInstaller` | `kernelBus` |
| InitialConfig | `InitialConfig` | `InitialConfigProvider` | `useInitialConfig` | `kernelBus` |
| InitSystem | — | — | `useInitSystem` | — |
| LockScreen | `LockScreen` | `LockScreenProvider` | `useLockScreen` | `kernelBus` |

### Dependency Graph

```
bootstrap ─────────► (no dependencies)
bootloader ────────► kernel (kernelBus)
safeboot ──────────► kernel (kernelBus, WindowManager)
kernel ────────────► (no dependencies except React)
startupinstaller ──► kernel, bootstrap (buses)
initialconfig ─────► kernel, bootstrap (buses)
initsystem ────────► (receives everything via props)
lockscreen ────────► kernel, bootstrap (buses)
```

No module imports another provider. They communicate via events.

---

## Window Manager

The kernel is the heart of rainOS. It exposes a pure `WindowManager`
class, a React provider, a hook, and two interaction hooks
(`useDraggable`, `useResizable`).

### Window Model

```js
{
  id: number,
  appId: string,
  title: string,
  component: ReactComponent,
  data: any,
  x, y, width, height: number,
  state: "normal" | "minimized" | "maximized" | "fullscreen",
  zIndex: number,
  createdAt: number,
  lastFocusedAt: number,
  flags: {
    resizable, closable, minimizable, maximizable, fullscreenable: boolean,
  },
  minWidth, minHeight: number,
}
```

### Constants

| Constant | Default | Description |
|---|---|---|
| `Z_BASE` | `100` | Base z-index for windows |
| `Z_STEP` | `1` | Step between each window in the focus stack |
| `MIN_WIDTH` | `320` | Minimum window width |
| `MIN_HEIGHT` | `200` | Minimum window height |
| `DEFAULT_WIDTH` | `720` | Default width when opening a window |
| `DEFAULT_HEIGHT` | `480` | Default height when opening a window |
| `TOP_RESERVED` | `28` | Space reserved for the menu bar |
| `BOTTOM_RESERVED` | `96` | Space reserved for the dock |
| `SNAP_THRESHOLD` | `12` | Pixels to trigger edge snapping |
| `DOUBLE_CLICK_MS` | `280` | Double-click threshold |
| `CASCADE_STEP` | `28` | Offset between cascading windows |
| `CASCADE_WRAP` | `8` | When to reset cascade offset |

### Geometry Helpers (pure functions)

```js
clampToViewport(x, y, width, height, viewport) → { x, y }
constrainResize(rect, dir, dx, dy) → { x, y, width, height }
applySnap(x, y, width, height, viewport) → { x, y }
cascadePosition(index, viewport, width, height) → { x, y }
rectsIntersect(a, b) → boolean
pointInRect(px, py, rect) → boolean
```

### Actions

| Action | Signature | Description |
|---|---|---|
| `open` | `(opts) → id` | Opens a new window |
| `close` | `(id) → boolean` | Closes a window |
| `closeAll` | `() → void` | Closes all windows |
| `reset` | `() → void` | Resets the whole manager |
| `focus` | `(id) → void` | Focuses a window |
| `blur` | `() → void` | Removes focus from all windows |
| `focusNext` | `() → void` | Cycles focus forward |
| `focusPrev` | `() → void` | Cycles focus backward |
| `move` | `(id, x, y, { snap }) → void` | Moves a window |
| `resize` | `(id, dir, dx, dy) → void` | Resizes a window |
| `minimize` | `(id) → void` | Minimizes a window |
| `restore` | `(id) → void` | Restores a minimized window |
| `toggleMinimize` | `(id) → void` | Toggles minimize |
| `toggleMaximize` | `(id) → void` | Toggles maximize |
| `toggleFullscreen` | `(id) → void` | Toggles fullscreen |
| `update` | `(id, patch) → void` | Updates arbitrary fields |
| `setTitle` | `(id, title) → void` | Updates the title |
| `setData` | `(id, data) → void` | Updates attached data |

### Queries

| Query | Signature | Description |
|---|---|---|
| `getWindow` | `(id) → win \| null` | Returns one window |
| `getWindows` | `() → win[]` | Returns all windows |
| `getVisibleWindows` | `() → win[]` | Excludes minimized |
| `getMinimizedWindows` | `() → win[]` | Only minimized |
| `getActive` | `() → win \| null` | Returns the focused window |
| `getByApp` | `(appId) → win[]` | Windows of one app |
| `getWindowsSortedByZ` | `() → win[]` | Ascending z-index |
| `getWindowsSortedByZDesc` | `() → win[]` | Descending z-index |
| `count` | `() → number` | Number of windows |
| `has` | `(id) → boolean` | Window existence |
| `hitTest` | `(x, y) → id \| null` | Topmost window under a point |
| `getIntersecting` | `(rect) → win[]` | Windows intersecting a rect |

### Persistence

| Method | Description |
|---|---|
| `serialize()` | Returns JSON string of all windows |
| `hydrate(json)` | Restores state from JSON |
| `exportLayout()` | Returns plain object (no React refs) |

### Interaction Hooks

```js
const { handleMouseDown } = useDraggable(id, {
  snap: true,
  onStart: ({ id, x, y }) => {},
  onMove: ({ id, x, y, dx, dy }) => {},
  onEnd: ({ id, x, y, moved }) => {},
  getOrigin: () => ({ x, y }),
  threshold: 0,
});
```

```js
const { handleMouseDown } = useResizable(id, "se", {
  onStart: ({ id, dir }) => {},
  onMove: ({ id, dir, dx, dy }) => {},
  onEnd: ({ id, dir, moved }) => {},
});
```

---

## Events Reference

### Kernel Events (`kernelBus`)

| Event | Payload | Description |
|---|---|---|
| `window:opened` | `{ id, window }` | A window was opened |
| `window:closed` | `{ id }` | A window was closed |
| `window:focused` | `{ id, previous }` | A window gained focus |
| `window:blurred` | `{ id }` | A window lost focus |
| `window:moved` | `{ id, x, y }` | A window was moved |
| `window:resized` | `{ id, x, y, width, height }` | A window was resized |
| `window:state-changed` | `{ id, state }` | State changed |
| `window:minimized` | `{ id }` | Window minimized |
| `window:restored` | `{ id }` | Window restored |
| `window:maximized` | `{ id }` | Window maximized |
| `window:unmaximized` | `{ id }` | Window unmaximized |
| `window:fullscreen-enter` | `{ id }` | Entered fullscreen |
| `window:fullscreen-exit` | `{ id }` | Exited fullscreen |
| `window:updated` | `{ id, patch }` | Arbitrary update |
| `viewport:changed` | `{ width, height }` | Viewport resized |
| `manager:reset` | `{}` | Manager was reset |
| `kernel:blur-all` | `{ reason }` | System-wide blur request |

### Bootstrap Events (`bootstrapBus`)

| Event | Payload |
|---|---|
| `bootstrap:started` | `{ options }` |
| `bootstrap:state-changed` | `{ state }` |
| `bootstrap:validation-ok` | `{ validation }` |
| `bootstrap:validation-fail` | `{ validation }` |
| `bootstrap:polyfill-installed` | `{ id }` |
| `bootstrap:polyfill-skipped` | `{ id }` |
| `bootstrap:frozen` | `{ frozen }` |
| `bootstrap:module-registered` | `{ id }` |
| `bootstrap:module-loaded` | `{ id }` |
| `bootstrap:module-failed` | `{ id, error }` |
| `bootstrap:global-error` | `{ message, stack }` |
| `bootstrap:global-rejection` | `{ reason, stack }` |
| `bootstrap:sw-registered` | `{ scope }` |
| `bootstrap:sw-failed` | `{ error }` |
| `bootstrap:ready` | `{ ssr }` |
| `bootstrap:failed` | `{ error }` |
| `bootstrap:trace` | `{ ts, level, message, meta }` |

### BootLoader Events (`kernelBus`)

| Event | Payload |
|---|---|
| `loader:started` | `{ options }` |
| `loader:state-changed` | `{ state }` |
| `loader:env-detected` | `{ env }` |
| `loader:env-unsupported` | `{ env }` |
| `loader:volumes-scanned` | `{ volumes }` |
| `loader:volume-selected` | `{ id }` |
| `loader:countdown-tick` | `{ remainingMs, seconds }` |
| `loader:countdown-cancelled` | `{ reason }` |
| `loader:flag-toggled` | `{ flag, enabled }` |
| `loader:flags-updated` | `{ flags }` |
| `loader:key-pressed` | `{ key, metaKey, altKey, shiftKey, ctrlKey }` |
| `loader:chainload-start` | `{ target }` |
| `loader:chainload-end` | `{}` |
| `loader:handoff` | `{ flags, safeMode }` |
| `loader:recovery-entered` | `{}` |
| `loader:recovery-exited` | `{}` |
| `loader:failed` | `{ error }` |
| `loader:aborted` | `{}` |
| `loader:watchdog-timeout` | `{ after }` |

### SafeBoot Events (`kernelBus`)

| Event | Payload |
|---|---|
| `boot:started` | `{ safeMode }` |
| `boot:phase-enter` | `{ phase }` |
| `boot:phase-exit` | `{ phase }` |
| `boot:progress` | `{ value }` |
| `boot:log` | `{ ts, level, message, meta }` |
| `boot:service-registered` | `{ name }` |
| `boot:service-started` | `{ name }` |
| `boot:service-failed` | `{ name, error }` |
| `boot:extension-loaded` | `{ id }` |
| `boot:extension-failed` | `{ id, error }` |
| `boot:integrity-ok` | `{ results }` |
| `boot:integrity-fail` | `{ results }` |
| `boot:session-restored` | `{}` |
| `boot:safe-mode-entered` | `{}` |
| `boot:complete` | `{ safeMode }` |
| `boot:failed` | `{ error }` |

### LockScreen Events (`kernelBus`)

| Event | Payload |
|---|---|
| `lock:locked` | `{ reason, graceUntil }` |
| `lock:unlocked` | `{ method }` |
| `lock:auth-started` | `{ method }` |
| `lock:auth-ok` | `{ method }` |
| `lock:auth-fail` | `{ method }` |
| `lock:failed-attempt` | `{ attempts, max }` |
| `lock:lockout` | `{ until, durationMs }` |
| `lock:lockout-ended` | `{}` |
| `lock:screen-saver-on` | `{}` |
| `lock:screen-saver-off` | `{}` |
| `lock:user-changed` | `{ id }` |
| `lock:sleep` | `{}` |
| `lock:wake` | `{}` |
| `lock:shutdown` | `{}` |
| `lock:restart` | `{}` |
| `lock:idle-timeout` | `{}` |

### StartupInstaller Events (`kernelBus`)

| Event | Payload |
|---|---|
| `assets:started` | `{}` |
| `assets:state-changed` | `{ state }` |
| `assets:image-format-registered` | `{ mime, ext }` |
| `assets:image-asset-registered` | `{ id, kind, mime }` |
| `assets:image-decoded` | `{ src, cacheKey, size }` |
| `assets:image-cache-hit` | `{ src, cacheKey }` |
| `assets:image-cache-miss` | `{ src, cacheKey }` |
| `assets:image-evicted` | `{ src, size }` |
| `assets:window-style-registered` | `{ id }` |
| `assets:window-cursor-registered` | `{ zone, cursor }` |
| `assets:space-registered` | `{ id }` |
| `assets:hot-corner-registered` | `{ corner }` |
| `assets:gesture-registered` | `{ id }` |
| `assets:shortcut-registered` | `{ combo }` |
| `assets:ready` | `{}` |
| `assets:failed` | `{ error }` |

### InitialConfig Events (`kernelBus`)

| Event | Payload |
|---|---|
| `setup:started` | `{ config }` |
| `setup:step-changed` | `{ step }` |
| `setup:value-changed` | `{ path, value }` |
| `setup:language-set` | `{ language }` |
| `setup:region-set` | `{ region, timezone, ... }` |
| `setup:account-set` | `{ account }` |
| `setup:appearance-set` | `{ appearance }` |
| `setup:dock-set` | `{ dock }` |
| `setup:applied` | `{}` |
| `setup:complete` | `{}` |
| `setup:failed` | `{ error }` |

---

## API Reference

### Kernel

#### `WindowManager` (class)

```js
const wm = new WindowManager({ viewport: { width: 1440, height: 900 } });
```

Methods: see [Window Manager](#window-manager).

#### `WindowManagerProvider`

```jsx
<WindowManagerProvider manager={customManager}>
  <App />
</WindowManagerProvider>
```

#### `useWindowManager()`

Returns an object with:

- `manager` — the class instance.
- `windows`, `activeId`, `viewport` — reactive state.
- All actions and queries (see [Window Manager](#window-manager)).
- `batch(fn)` — groups state changes.

#### `useDraggable(id, options)` / `useResizable(id, dir, options)`

See [Interaction Hooks](#interaction-hooks).

### Bootstrap

#### `Bootstrap` (class)

```js
const bootstrap = new Bootstrap({
  serviceWorkerUrl: "/sw.js",
  installErrorHandlers: true,
  installPolyfills: true,
  freeze: true,
  allowSSR: true,
  strict: false,
});

await bootstrap.run({ dispatch, onReady, onFail });
```

Methods:

| Method | Description |
|---|---|
| `registerModule(id, mod)` | Registers a module |
| `registerModules(list)` | Registers many modules |
| `run({ dispatch, onReady, onFail })` | Runs the boot sequence |
| `abort()` | Aborts mid-boot |
| `dispose()` | Cleans up global handlers |

#### `BootstrapProvider`

```jsx
<BootstrapProvider autoRun options={{ strict: false }}>
  <App />
</BootstrapProvider>
```

#### `useBootstrap()`

Returns:

- `bootstrap`, `state`, `phase`, `isReady`, `isFailed`, `isSSR`
- `validation`, `polyfills`, `frozen`, `modules`, `sw`, `durationMs`
- `globalErrors`, `globalRejections`
- `trace` — the trace logger
- `run`, `abort`, `dispose`, `registerModule`, `onEvent`

### BootLoader

#### `BootLoader` (class)

```js
const loader = new BootLoader({
  countdownMs: 3000,
  watchdogMs: 30000,
  defaultVolumeId: "main",
  forceFlags: [],
});

await loader.run({
  dispatch,
  safeBoot,
  safeBootDispatch,
  safeBootGetState,
});
```

Methods:

| Method | Description |
|---|---|
| `run(opts)` | Runs the bootloader |
| `abort(dispatch)` | Aborts the boot |
| `setSelectedVolume(id, dispatch)` | Sets the boot volume |
| `toggleFlag(flag, dispatch)` | Toggles a boot flag |
| `enterRecovery(dispatch)` | Enters recovery mode |
| `exitRecovery(dispatch)` | Exits recovery mode |
| `attachKeyHandler` / `detachKeyHandler` | Manage keyboard listeners |

#### `BootLoaderProvider`

```jsx
<BootLoaderProvider autoRun countdownMs={3000}>
  <App />
</BootLoaderProvider>
```

#### `useBootLoader()`

Returns:

- `loader`, `state`, `phase`, `isReady`, `isFailed`
- `env`, `volumes`, `selectedVolumeId`, `countdown`
- `flags`, `verbose`, `recovery`, `errors`, `warnings`, `logs`
- `abort`, `setSelectedVolume`, `toggleFlag`, `enterRecovery`,
  `exitRecovery`, `hasFlag`, `getFlagList`
- `nvramGet`, `nvramSet`, `nvramReset`

### SafeBoot

#### `SafeBoot` (class)

```js
const safeboot = new SafeBoot({ windowManager });

safeboot.registerService("storage", {
  deps: [],
  critical: true,
  timeout: 5000,
  retries: 3,
  start: async () => {},
  stop: async () => {},
});

safeboot.registerExtension("core-icons", {
  version: "1.0.0",
  mandatory: true,
  load: async () => {},
});

await safeboot.boot(dispatch, getState);
await safeboot.shutdown();
await safeboot.reboot(dispatch, getState);
```

#### `SafeBootProvider`

```jsx
<SafeBootProvider autoStart windowManager={wm}>
  <App />
</SafeBootProvider>
```

#### `useSafeBoot()`

Returns:

- `boot`, `state`, `phase`, `progress`, `safeMode`
- `isReady`, `isSafeMode`, `isFailed`
- `errors`, `warnings`, `logs`
- `start`, `shutdown`, `reboot`, `abort`
- `enableSafeModeForNextBoot`, `disableSafeModeForNextBoot`
- `hasSavedSession`, `saveCurrentSession`, `loadSavedSession`,
  `clearSavedSession`
- `registerService`, `registerExtension`, `registerIntegrityCheck`, `onPhase`

### StartupInstaller

#### `StartupInstaller` (class)

```js
const installer = new StartupInstaller({
  imageMaxBytes: 64 * 1024 * 1024,
  imageConcurrency: 4,
  assets: { "custom.icon": { src: "/icon.png" } },
  preload: ["/img/logo.png"],
  strict: false,
});

await installer.run({ dispatch });
```

#### `StartupInstallerProvider`

```jsx
<StartupInstallerProvider autoRun>
  <App />
</StartupInstallerProvider>
```

#### `useStartupInstaller()`

Returns:

- `installer`, `state`, `progress`, `isReady`, `isFailed`
- `imageRuntime`, `windowRuntime`, `multitaskRuntime`
- `run`, `abort`
- `getStyle`, `getCursor`, `getEffect`, `getTrafficLights`
- `decode`, `preload`, `registerAsset`
- `registerSpace`, `registerHotCorner`, `registerGesture`,
  `registerShortcut`, `registerTransition`

### InitialConfig

#### `InitialConfig` (class)

```js
const config = new InitialConfig({ autoDetect: true });

config.onStep("account", ({ config }) => {
  console.log("Account step:", config.account);
});

await config.apply(configState, dispatch);
```

#### `InitialConfigProvider`

```jsx
<InitialConfigProvider autoStart onComplete={() => {}}>
  <App />
</InitialConfigProvider>
```

#### `useInitialConfig()`

Returns:

- `config`, `state`, `step`, `progress`, `values`, `errors`
- `isComplete`, `isFailed`
- `goTo`, `next`, `prev`
- `setValue`, `setValues`, `validate`, `apply`
- `reset`

### InitSystem

#### `InitSystem` (component)

```jsx
<InitSystem
  progress={75}
  phase="load-services"
  safeMode={false}
  failed={false}
  verbose={false}
  logs={[]}
  minDuration={1200}
  holdOnError
  onFinished={() => {}}
/>
```

#### `ConnectedInitSystem`

Same but auto-wires `bootstrap`, `bootloader` and `safeboot` APIs:

```jsx
<ConnectedInitSystem
  bootstrap={bootstrapApi}
  bootloader={bootloaderApi}
  safeboot={safebootApi}
  onFinished={() => {}}
/>
```

#### Sub-components

- `AppleLogo({ size, color, opacity })`
- `Spinner({ size, color, thickness })`
- `ProgressBar({ value, width, height, color, indeterminate })`

### LockScreen

#### `LockScreen` (class)

```js
const lock = new LockScreen({
  idleTimeoutMs: 5 * 60 * 1000,
  screenSaverTimeoutMs: 10 * 60 * 1000,
  lockOnVisibilityHidden: true,
  maxFailedAttempts: 5,
  lockoutBaseMs: 30 * 1000,
  lockoutMultiplier: 2,
});

lock.bootstrap(dispatch);
await lock.authenticate(dispatch, "password");
lock.lock(dispatch, "manual");
lock.unlock(dispatch, "programmatic");
```

#### `LockScreenProvider`

```jsx
<LockScreenProvider autoLock onUnlocked={() => {}}>
  <App />
</LockScreenProvider>
```

#### `useLockScreen()`

Returns:

- `lock`, `state`, `locked`, `unlocking`, `showScreenSaver`
- `currentUserId`, `failedAttempts`, `lockoutUntil`, `banner`, `users`
- `lockNow`, `lockIdle`, `lockGrace`, `unlock`
- `authenticate`, `authenticateBiometry`, `switchUser`
- `showScreenSaver`, `hideScreenSaver`
- `sleep`, `wake`, `shutdown`, `restart`, `cancel`
- `clearBanner`, `setOptions`, `reloadUsers`

#### `LockScreenView` (component)

```jsx
<LockScreenView onUnlocked={() => {}} />
```

---

## State Model

### `WindowManager`

```js
{
  windows: [ /* Window[] */ ],
  activeId: number | null,
  viewport: { width, height },
  focusStack: number[],
  snapshots: Map<id, rect>,
  metadata: Map<id, any>,
}
```

### `Bootstrap`

```js
{
  state: "pending" | "validating" | "polyfilling" | "freezing"
       | "modules" | "ready" | "failed" | "skipped-ssr" | "aborted",
  isSSR: boolean | null,
  validation: { ok, isSSR, results } | null,
  polyfills: { installed: string[], skipped: string[], failed: any[] },
  frozen: string[],
  modules: { registered: string[], loaded: string[], failed: string[] },
  globalErrors: any[],
  globalRejections: any[],
  sw: { scope } | null,
  startedAt, finishedAt, durationMs: number,
  error: string | null,
}
```

### `BootLoader`

```js
{
  state: "idle" | "detecting" | "scanning" | "countdown"
       | "waiting-input" | "loading" | "chainloading" | "handoff"
       | "recovery" | "failed" | "aborted",
  env: { capabilities, ... } | null,
  volumes: Volume[],
  selectedVolumeId: string | null,
  countdown: number | null,
  flags: string[],
  verbose: boolean,
  errors: any[],
  warnings: any[],
  logs: any[],
  chainloadTarget: string | null,
  recovery: boolean,
  handoffDone: boolean,
  durationMs: number,
}
```

### `SafeBoot`

```js
{
  phase: string,
  safeMode: boolean,
  progress: number,
  servicesStarted: string[],
  servicesFailed: { name, error }[],
  extensionsLoaded: string[],
  extensionsFailed: { id, error }[],
  integrityOk: boolean | null,
  sessionRestored: boolean,
  logs: { ts, level, message, meta }[],
}
```

### `StartupInstaller`

```js
{
  state: string,
  progress: number,
  steps: {
    images: { done, count, error },
    windows: { done, count, error },
    multitask: { done, count, error },
    wiring: { done },
    verifying: { done, ok },
  },
  stats: {
    imageFormats, imageAssets, windowStyles, windowCursors,
    windowEffects, spaces, hotCorners, gestures, shortcuts, transitions,
  },
  errors: any[],
  warnings: any[],
  durationMs: number,
}
```

### `InitialConfig`

```js
{
  step: string,
  progress: number,
  config: DefaultConfig,
  errors: Record<string, string>,
  warnings: any[],
  error: string | null,
  logs: any[],
  completed: boolean,
  durationMs: number,
}
```

### `LockScreen`

```js
{
  state: string,
  locked: boolean,
  showScreenSaver: boolean,
  currentUserId: string | null,
  unlocking: boolean,
  authMethod: string | null,
  failedAttempts: number,
  lockoutUntil: number | null,
  lastError: string | null,
  now: number,
  banner: { type, message } | null,
  shakeKey: number,
  graceUntil: number | null,
  lastUnlockAt: number | null,
  logs: any[],
  options: LockOptions,
}
```

---

## Persistence

| Module | Key | Stores |
|---|---|---|
| SafeBoot | `safeboot.session.v1` | Serialized windows and layout |
| SafeBoot | `safeboot.enabled` | Force safe mode on next boot |
| BootLoader | `bootloader.nvram.v1` | Flags, default volume, verbose |
| BootLoader | `bootloader.profiles.v1` | Boot profiles |
| InitialConfig | `initialconfig.config` | Full user configuration |
| InitialConfig | `initialconfig.configured` | First-run flag |
| InitialConfig | `initialconfig.configuredAt` | Timestamp of setup |
| LockScreen | `lockscreen.*` | Attempts, lockout, active user |
| StartupInstaller | `installer.*` | Installed assets registry |

---

## Conventions

### File Naming

- Modules: `src/<module>/<module>.jsx`
- Barrel exports: `src/<module>/index.js`
- Tests: `tests/<module>.test.js`
- Docs: `docs/<TOPIC>.md`

### Symbol Naming

- Pure classes: `PascalCase` (`WindowManager`)
- Providers: `PascalCase + Provider` (`WindowManagerProvider`)
- Hooks: `usePascalCase` (`useWindowManager`)
- Constants: `UPPER_SNAKE_CASE` (`WINDOW_STATE`)
- Events: `namespace:kebab-case` (`window:opened`)
- Buses: `camelCase + Bus` (`kernelBus`)

### Header Comments

Every file starts with a block comment describing its responsibility:

```js
// ============================================================================
// <file name> — <short description>
// ----------------------------------------------------------------------------
// - Bullet 1
// - Bullet 2
// - No UI. Logic only.
// ============================================================================
```

### Internal Structure of a Module

```
1. Imports
2. Constants (STATES, EVENTS, DEFAULTS)
3. Logger (optional)
4. Pure helpers
5. Pure class
6. Context
7. Provider
8. Main hook
9. Auxiliary hooks
10. Optional visual component
11. Default exports
```

---

## Design Decisions

**Why not use Zustand / Redux?**
Because the kernel does not need a shared global store. Each module has
its own state and modules communicate via events. Using Zustand would add
a dependency without real gain.

**Why pure classes instead of functions?**
Because the kernel state (windows, focus stack, loaded services) is
mutable and has identity. A class allows encapsulating state and methods,
instantiating multiple managers if needed, testing without React, and
serializing / hydrating.

**Why an event bus instead of shared contexts?**
React contexts couple to the component tree. A bus allows listening from
outside React, modules to communicate without importing each other, and
tests without mounting the full tree.

**Why `localStorage` instead of IndexedDB?**
Because the amount of data is small (serialized windows, config, flags)
and the synchronous API simplifies the code. If in the future large
sessions or images need to be persisted, it can be migrated.

**Why 8 modules instead of 1?**
Because each module has a clear responsibility and can be used separately.
If you only want the window manager, import `rainos/kernel` and that's it.
If you want the full chain, import everything.

**Why doesn't the kernel render anything?**
Because each app decides how its desktop looks. The kernel only manages
windows: position, size, focus, z-index. The chrome (titlebar, buttons,
shadows) comes from the UI you use.

**Why SHA-256 and not bcrypt?**
Because `crypto.subtle.digest` is native to the browser and requires no
dependencies. For a browser-based system there is no need for protection
against offline attacks (there is no server). If migrated to real
production, a slower hash with salt should be used.

**Why do events start with `namespace:`?**
To avoid collisions between modules. `window:opened` is from the kernel,
`boot:complete` is from safeboot, `lock:unlocked` is from lockscreen.
They all share `kernelBus` but each one writes in its own namespace.

---

## Future Extensions

Ideas to expand the kernel without breaking the current architecture:

- **Mission Control** — overlay that shows all windows in a grid.
- **Spaces** — multiple virtual desktops with transitions.
- **Launchpad** — fullscreen app view with search.
- **Notifications** — notification center with history.
- **Spotlight** — global search with commands.
- **Clipboard** — copy history.
- **Trackpad gestures** — swipe, pinch, rotation.
- **Context menu** — right-click on windows and icons.
- **Example apps** — Finder, Terminal, Notes, simulated Safari.
- **Themes** — light, dark, high contrast.
- **Accessibility** — keyboard navigation, screen readers.

Each extension can be its own module that listens to kernel events and
emits its own.
