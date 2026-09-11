# rainOS Boot Sequence

Complete technical reference for the boot sequence in rainOS: every phase,
every event, every fallback path, from the first line of JavaScript to the
unlocked desktop.

---

## Table of Contents

1. [Overview](#overview)
2. [Timeline](#timeline)
3. [Phase 1 — Bootstrap](#phase-1--bootstrap)
4. [Phase 2 — BootLoader](#phase-2--bootloader)
5. [Phase 3 — SafeBoot](#phase-3--safeboot)
6. [Phase 4 — Kernel](#phase-4--kernel)
7. [Phase 5 — StartupInstaller](#phase-5--startupinstaller)
8. [Phase 6 — InitialConfig](#phase-6--initialconfig)
9. [Phase 7 — InitSystem](#phase-7--initsystem)
10. [Phase 8 — LockScreen](#phase-8--lockscreen)
11. [Failure Paths and Fallbacks](#failure-paths-and-fallbacks)
12. [Keyboard Flags](#keyboard-flags)
13. [Boot Volumes](#boot-volumes)
14. [Watchdogs and Timeouts](#watchdogs-and-timeouts)
15. [Complete Reference Timeline](#complete-reference-timeline)

---

## Overview

rainOS boots in **8 sequential phases**. Each phase has a state machine, a
set of emitted events, and a fallback path in case of failure. The chain
is deterministic: no phase starts before the previous one has either
completed or been bypassed.

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

Phases 1 through 4 are the **mandatory** boot chain. Phases 5 and 6 only
run the first time (or after a reset). Phase 7 is the visual layer that
runs in parallel with phases 1–4. Phase 8 is the final gate before the
user reaches the desktop.

---

## Timeline

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

**Total time budget**: ~2 seconds on a modern browser, from the first
line of JavaScript to the unlocked desktop. The countdown in BootLoader
dominates the timeline with a configurable 3-second delay (can be
reduced or skipped with a keypress).

---

## Phase 1 — Bootstrap

**Module**: `bootstrap.jsx`

Runs the very first code of the system. Depends on nothing. Validates the
environment, installs polyfills, freezes critical objects, installs
global error handlers, and prepares the module manifest.

### States

```
pending → validating → polyfilling → freezing → modules → ready
                                                          ↓
                                                       failed
                                                          ↓
                                                    skipped-ssr
                                                          ↓
                                                       aborted
```

### What happens step by step

**1. Validate environment**

Checks that required globals exist:

| Global | Required | SSR-safe |
|---|---|---|
| `window` | yes | yes |
| `document` | yes | yes |
| `navigator` | no | yes |
| `localStorage` | no | no |
| `sessionStorage` | no | no |

If `window` or `document` are missing, `isSSR` is set to `true`. If
`allowSSR` is `false`, the bootstrap fails. Otherwise it completes with
state `skipped-ssr`.

**2. Install polyfills**

| Polyfill | ID | Installs when |
|---|---|---|
| `requestAnimationFrame` | `raf` | Missing in window/globalThis |
| `performance.now` | `performance-now` | Missing |
| `crypto.getRandomValues` | `crypto-randomUUID` | Missing |
| `crypto.randomUUID` | `crypto-randomUUID` | Missing |
| `Array.prototype.at` | `array-at` | Missing |
| `Object.hasOwn` | `object-hasOwn` | Missing |
| `structuredClone` | `structuredClone` | Missing |
| `queueMicrotask` | `queue-microtask` | Missing |

If a polyfill fails to install in `strict` mode, the boot aborts.

**3. Freeze critical objects**

Freezes `BOOTSTRAP_STATE`, `BOOTSTRAP_EVENTS`, `BOOTSTRAP_PRIORITY` so
external code cannot mutate them.

**4. Install global error handlers**

Registers listeners on `window`:

- `error` → emits `bootstrap:global-error` and logs to trace.
- `unhandledrejection` → emits `bootstrap:global-rejection`.

**5. Load modules**

Reads the module manifest, resolves dependencies in topological order,
loads each module with timeout and retries. Critical modules that fail
abort the boot; non-critical failures are logged.

**6. Register Service Worker** (optional)

If `serviceWorkerUrl` is provided and the browser supports Service
Workers, registers it. Failure is non-fatal.

### Events emitted

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

### Example timeline

```
[00:00.000] bootstrap:started
[00:00.001] bootstrap:state-changed       → validating
[00:00.005] bootstrap:validation-ok
[00:00.005] bootstrap:state-changed       → polyfilling
[00:00.010] bootstrap:polyfill-installed  → raf
[00:00.012] bootstrap:polyfill-installed  → performance-now
[00:00.014] bootstrap:polyfill-skipped    → crypto-randomUUID (already exists)
[00:00.016] bootstrap:polyfill-skipped    → array-at (already exists)
[00:00.020] bootstrap:state-changed       → freezing
[00:00.021] bootstrap:frozen              → [BOOTSTRAP_STATE, BOOTSTRAP_EVENTS]
[00:00.023] bootstrap:state-changed       → modules
[00:00.030] bootstrap:module-registered   → logging
[00:00.031] bootstrap:module-registered   → storage
[00:00.040] bootstrap:module-loaded       → logging
[00:00.045] bootstrap:module-loaded       → storage
[00:00.050] bootstrap:state-changed       → ready
[00:00.051] bootstrap:ready
```

---

## Phase 2 — BootLoader

**Module**: `bootloader.jsx`

Pre-boot stage. Detects capabilities, scans boot volumes, manages the
countdown, interprets keyboard flags, and hands off to SafeBoot.

### States

```
idle → detecting → scanning → countdown → chainloading → handoff
                       ↓                                    ↓
                 waiting-input                            recovery
                       ↓                                    ↓
                    aborted                               failed
```

### What happens step by step

**1. Detect environment**

Scans browser capabilities and stores them in a report:

| Capability | Detected via |
|---|---|
| `localStorage` | Probe write/delete |
| `sessionStorage` | Probe write/delete |
| `indexedDB` | Typeof check |
| `crypto` | `crypto.getRandomValues` |
| `raf` | `requestAnimationFrame` |
| `performance` | `performance.now` |
| `fetch` | `typeof fetch` |
| `workers` | `typeof Worker` |
| `webgl` | Canvas context probe |
| `touch` | `ontouchstart` / `maxTouchPoints` |
| `pointer` | `PointerEvent` in window |
| `clipboard` | `navigator.clipboard` |
| `notifications` | `typeof Notification` |
| `fullscreen` | `requestFullscreen` |

If `raf`, `performance` or `document` are missing, the environment is
marked as unsupported and the loader falls back to Recovery.

**2. Load flags from NVRAM**

Reads persisted flags from `localStorage` under `bootloader.nvram.v1`:

```js
{
  flags: ["verbose", "safe"],
  verbose: true,
  defaultVolumeId: "main",
  lastSelected: "session"
}
```

Merges them with any `forceFlags` passed via constructor.

**3. Scan boot volumes**

| Volume ID | Type | Order | Conditions |
|---|---|---|---|
| `main` | system | 0 | Always present |
| `session` | session | 1 | If a saved session exists |
| `profile:*` | profile | 10+ | If profiles are defined |
| `recovery` | recovery | 900 | Always present |
| `network` | network | 950 | If online |

The volume with the lowest `order` is selected by default, unless
NVRAM or constructor override it.

**4. Countdown**

Runs a countdown of `countdownMs` (default 3000 ms), ticking every
100 ms. Any keypress cancels it and moves to `waiting-input`.

**5. Chainload**

Sets the selected volume, persists it to NVRAM, saves the current
flags, and emits `loader:chainload-start`.

**6. Handoff**

Computes the effective `safeMode` flag from `SAFE`, `RECOVERY` or
`SINGLE_USER`, sets it on the SafeBoot instance, and calls
`safeBoot.boot(dispatch, getState)`.

### Keyboard flags

Key combinations are handled during `countdown` and `waiting-input`:

| Key | Flag | Effect |
|---|---|---|
| `⌥` (Option) | — | Cancels countdown, waits for input |
| `⌘V` | `verbose` | Enables verbose mode |
| `⇧` (Shift) | `safe` | Enables safe mode |
| `⌘R` | `recovery` | Enables recovery mode |
| `⌘S` | `single-user` | Enables single-user mode |
| `⌘⌥PR` | — | Resets NVRAM and all flags |
| `Esc` | — | Aborts the boot process |

Any other key simply cancels the countdown.

### Events emitted

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

### Example timeline

```
[00:00.052] loader:started
[00:00.052] loader:state-changed          → detecting
[00:00.100] loader:env-detected           → { capabilities: {...} }
[00:00.101] loader:state-changed          → scanning
[00:00.150] loader:volumes-scanned        → [main, session, recovery, network]
[00:00.151] loader:volume-selected        → main
[00:00.152] loader:state-changed          → countdown
[00:01.152] loader:countdown-tick         → { seconds: 2 }
[00:02.152] loader:countdown-tick         → { seconds: 1 }
[00:03.152] loader:countdown-tick         → { seconds: 0 }
[00:03.153] loader:state-changed          → chainloading
[00:03.154] loader:chainload-start        → main
[00:03.160] loader:chainload-end
[00:03.161] loader:state-changed          → handoff
[00:03.162] loader:handoff                → { flags: [], safeMode: false }
```

---

## Phase 3 — SafeBoot

**Module**: `safeboot.jsx`

Loads services and extensions, restores the previous session, and emits
the readiness signal to the rest of the system.

### Phases

```
power-on → post → loader → kernel-init → load-extensions
        → load-services → restore-session → start-window-manager → ready
```

### What happens step by step

**1. power-on**

Emits `boot:started`. Sets `startedAt` timestamp.

**2. post (Power-On Self-Test)**

Runs integrity checks:

| Check | Purpose |
|---|---|
| `storage-available` | Can `localStorage` be written? |
| `crypto-available` | Does `crypto.getRandomValues` exist? |
| `raf-available` | Is `requestAnimationFrame` available? |
| `performance-available` | Is `performance` defined? |

If a check fails and it's not critical, a warning is recorded. If the
overall integrity fails and safe mode is not already active, the system
falls back to safe mode.

**3. loader**

Emits `boot:phase-enter` for `loader`. No work is done here by default;
this phase exists for user extensions via `onPhase`.

**4. kernel-init**

Emits `boot:phase-enter` for `kernel-init`. If `safeMode` is active, the
boot jumps directly to `_runSafeMode()`.

**5. load-extensions**

Iterates over registered extensions:

- Skips extensions with `compatibleSafeMode === false` when in safe mode.
- Calls `extension.load()` with no timeout (extensions are expected to
  be fast).
- Records successes as `boot:extension-loaded` and failures as
  `boot:extension-failed`.
- If an extension is marked `mandatory` and fails, the whole boot throws.

**6. load-services**

Resolves services in topological order:

- Skips services with `safeMode === false` when in safe mode.
- Verifies all dependencies have started; if any failed, records the
  service as failed.
- Calls `service.start({ logger })` wrapped in a timeout.
- Retries on failure up to `service.retries` times, with exponential
  backoff (100 ms, 200 ms, 300 ms...).
- If a service is marked `critical` and fails, the boot throws.

Default services (registered by the user, not built-in):

```js
safeboot.registerService("storage", {
  deps: [],
  critical: true,
  timeout: 5000,
  retries: 3,
  start: async () => {},
  stop: async () => {},
});
```

**7. restore-session**

If a saved session exists in `localStorage` under `safeboot.session.v1`,
calls `windowManager.hydrate(raw)` to restore windows. Failures are
non-fatal.

**8. start-window-manager**

Emits `boot:phase-enter`. The window manager starts accepting windows
from this point forward.

**9. ready**

Sets progress to 100, emits `boot:complete`. The system is now ready
for the UI layer.

### Events emitted

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

### Example timeline

```
[00:03.163] boot:started
[00:03.163] boot:phase-enter              → power-on
[00:03.164] boot:phase-exit               → power-on
[00:03.165] boot:phase-enter              → post
[00:03.200] boot:integrity-ok
[00:03.201] boot:phase-exit               → post
[00:03.202] boot:phase-enter              → loader
[00:03.203] boot:phase-exit               → loader
[00:03.204] boot:phase-enter              → kernel-init
[00:03.205] boot:phase-exit               → kernel-init
[00:03.206] boot:phase-enter              → load-extensions
[00:03.220] boot:extension-loaded         → core-icons
[00:03.230] boot:extension-loaded         → keyboard
[00:03.231] boot:phase-exit               → load-extensions
[00:03.232] boot:phase-enter              → load-services
[00:03.240] boot:service-registered       → storage
[00:03.241] boot:service-registered       → notifications
[00:03.242] boot:service-registered       → network
[00:03.250] boot:service-started          → storage
[00:03.255] boot:service-started          → notifications
[00:03.260] boot:service-started          → network
[00:03.261] boot:phase-exit               → load-services
[00:03.262] boot:phase-enter              → restore-session
[00:03.300] boot:session-restored
[00:03.301] boot:phase-exit               → restore-session
[00:03.302] boot:phase-enter              → start-window-manager
[00:03.303] boot:phase-exit               → start-window-manager
[00:03.304] boot:phase-enter              → ready
[00:03.305] boot:complete
```

---

## Phase 4 — Kernel

**Module**: `kernel.jsx`

Boots the window manager. From this point forward, apps can open windows.

### What happens

**1. Instantiate WindowManager**

The provider instantiates a new `WindowManager` if none is passed via
props. It reads the initial viewport from `window.innerWidth` /
`window.innerHeight`.

**2. Load saved windows**

If the SafeBoot already hydrated the manager from a saved session, the
windows are available immediately. Otherwise, the manager starts empty.

**3. Attach resize listener**

Subscribes to `window` `resize` events to update the viewport. Windows
are reflowed to stay inside the visible area.

### Events emitted

| Event | Payload |
|---|---|
| `viewport:changed` | `{ width, height }` |
| `window:opened` | `{ id, window }` |
| `window:focused` | `{ id, previous }` |
| `window:moved` | `{ id, x, y }` |
| `window:resized` | `{ id, x, y, width, height }` |
| `window:closed` | `{ id }` |

### Example timeline

```
[00:03.306] viewport:changed              → { width: 1440, height: 900 }
[00:03.320] window:opened                 → { id: 1, title: "Finder" }
[00:03.321] window:focused                → { id: 1 }
[00:03.340] window:opened                 → { id: 2, title: "Terminal" }
[00:03.341] window:focused                → { id: 2 }
```

---

## Phase 5 — StartupInstaller

**Module**: `startupinstaller.jsx`

Installs assets and graphics runtime. Runs on every boot if not already
installed, or after a reset.

### States

```
idle → loading-images → loading-windows → loading-multitask
     → wiring → verifying → ready
```

### What happens step by step

**1. loading-images**

- Registers image formats: `image/png`, `image/jpeg`, `image/gif`,
  `image/webp`, `image/svg+xml`, `image/avif`, `image/bmp`,
  `image/x-icon`.
- Registers system SVG icons (finder, terminal, notes, settings, trash,
  folder, file).
- Registers any user-provided assets.
- Optionally preloads a list of sources with concurrency control.

**2. loading-windows**

- Registers window styles: `default`, `compact`, `panel`, `utility`.
- Registers cursors per zone: `resize-n`, `resize-s`, `resize-e`,
  `resize-w`, `resize-ne`, `resize-nw`, `resize-se`, `resize-sw`,
  `titlebar`, `content`, `close`, `minimize`, `maximize`.
- Registers visual effects (blur, vibrancy, shadows).
- Registers traffic light configurations.

**3. loading-multitask**

- Registers spaces (virtual desktops).
- Registers hot corners.
- Registers gestures (swipe, pinch, rotate, pan).
- Registers keyboard shortcuts for the system.
- Registers space transitions.
- Configures Mission Control.

**4. wiring**

Connects the runtimes with the kernel and lock screen.

**5. verifying**

Runs sanity checks: formats loaded, at least one window style, no
circular dependency in spaces.

---

## Phase 6 — InitialConfig

**Module**: `initialconfig.jsx`

Setup Assistant. Runs only on first boot, or after the user resets the
system.

### Steps

```
welcome → language → region → keyboard → network → migration
        → account → appearance → dock → privacy → shortcuts
        → summary → applying → done
```

### What happens step by step

**1. autoDetect**

Reads `navigator.language`, region, timezone, and 12/24h format from
`Intl`. Falls back to `DEFAULT_CONFIG` values.

**2. Language / Region / Keyboard**

Each is a step with a picker. Validation is trivial (value must be in
the list).

**3. Network**

WiFi SSID, security type, hostname, DNS, NTP sync. Not validated.

**4. Migration**

Choose between `none`, `backup`, `another-mac`, or `time-machine`.
Source ID is stored if applicable.

**5. Account**

Validated fields: `fullName` (2–64 chars), `shortName` (regex
`^[a-z][a-z0-9_-]{1,31}$`), password (≥4 chars, must match confirm).

Password is hashed with `crypto.subtle.digest("SHA-256", ...)` and
stored as `passwordHash`. Fallback hash if `crypto.subtle` is not
available.

**6. Appearance**

Theme (`light` / `dark` / `auto`), accent color, wallpaper, transparency,
reduce motion, increase contrast.

**7. Dock**

Position (`bottom` / `left` / `right`), size, magnification, autohide,
minimize effect.

**8. Privacy**

Analytics, location, Siri, personalized ads, crash reports, app tracking.

**9. Shortcuts**

Keyboard shortcuts for Mission Control, Launchpad, Spotlight, space
switching, screenshots, lock screen, force quit, hide app, quit app,
Exposé.

**10. summary → applying**

Displays a summary and, on confirmation, applies all settings:

- Sets `document.documentElement.lang`.
- Emits `SETUP_EVENTS.LANGUAGE_SET`, `REGION_SET`, etc.
- Applies appearance to `document.documentElement.dataset`.
- Applies dock settings to `document.documentElement.dataset`.
- Persists config to `localStorage` under `initialconfig.config`.
- Marks `initialconfig.configured = true`.

**11. done**

Emits `setup:complete`. From this point forward, `InitialConfig` is
skipped on subsequent boots.

---

## Phase 7 — InitSystem

**Module**: `initsystem.jsx`

Visual layer during the boot. Runs in parallel with phases 1–4. Renders
the Apple logo, a progress bar, and a status label.

### Behavior

**Connected mode**: `ConnectedInitSystem` wires itself to Bootstrap,
BootLoader, and SafeBoot, and derives:

- `phase`: `safeboot.phase` ?? `bootloader.state` ?? `bootstrap.phase`.
- `progress`: the highest of the three, mapped to 0–100.
- `safeMode`: from any of the three.
- `failed`: from any of the three.
- `error`: the most recent error.
- `logs`: merged from all three loggers, sorted by timestamp.

**Manual mode**: `InitSystem` accepts `progress`, `phase`, `safeMode`,
`failed`, `error`, `verbose`, `logs` as props.

### Phase → label mapping

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
| `waiting-input` | Waiting for input… |
| `chainloading` | Booting selected volume… |
| `handoff` | Handing control to the system… |
| `power-on` | Powering on… |
| `post` | Self-test… |
| `loader` | Loading bootloader… |
| `kernel-init` | Initializing kernel… |
| `load-extensions` | Loading extensions… |
| `load-services` | Starting services… |
| `restore-session` | Restoring session… |
| `start-window-manager` | Starting window manager… |
| `ready` | Ready |
| `safe-mode` | Safe Mode |

### Features

- **Verbose mode**: toggled with `⌘V`. Replaces the logo with a
  scrollable log view.
- **Min duration**: `minDuration` (default 1200 ms) prevents flash on
  fast boots.
- **Hold on error**: `holdOnError` (default true) keeps the screen visible
  after a failure so the user can read the error.
- **Fade out**: 500 ms fade when the boot completes.

---

## Phase 8 — LockScreen

**Module**: `lockscreen.jsx`

Final gate. Blocks access to the desktop until the user authenticates.

### States

```
idle → locked → unlocking → unlocked
         ↓
   screen-saver / sleeping / changing-user
         ↓
   shutting-down / restarting
         ↓
       failed
```

### What happens step by step

**1. bootstrap**

- Reads the active user from `UserRegistry` (which reads the account
  created by `InitialConfig`).
- Sets initial state to `locked`.
- Attaches idle monitor.
- Starts clock tick (every 1000 ms).
- Attaches visibility change listener.

**2. Authenticate**

`authenticate(password)`:

1. Checks `lockoutUntil`; if still locked out, refuses.
2. Dispatches `AUTH_START`.
3. Retrieves the active user.
4. If the user has no password, unlocks immediately.
5. Hashes the input with `crypto.subtle`.
6. Compares in constant time with the stored `passwordHash`.
7. On success: `AUTH_OK`, emits `lock:unlocked`, calls `unlock()`.
8. On failure: increments `failedAttempts`, triggers shake animation,
   records a failed attempt, applies lockout if threshold reached.

**3. Lockout logic**

After `maxFailedAttempts` (default 5), the system locks for:

```
durationMs = lockoutBaseMs * lockoutMultiplier^(attempts - max)
```

Default: 30 s, 60 s, 120 s, ... After the timeout expires, the lockout
is cleared.

**4. Idle monitor**

Watches mouse, keyboard, touch, scroll, wheel, pointer events. After
`idleTimeoutMs` (default 5 min) without activity, calls `lock()`.

**5. Screen saver**

After `screenSaverTimeoutMs` (default 10 min), shows the screen saver
and locks the system.

**6. Sleep / wake**

`sleep()` optionally locks, then dispatches `SLEEP`. `wake()` dispatches
`WAKE` and resets the idle monitor.

**7. Shutdown / restart**

Dispatch `SHUTDOWN` or `RESTART`, emit the corresponding event, and call
the registered handlers.

**8. User switching**

`switchUser(id)` changes the active user and re-locks the system,
preserving the previous user's session.

### Events emitted

| Event | Payload |
|---|---|
| `lock:started` | `{ options }` |
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

---

## Failure Paths and Fallbacks

### Bootstrap failures

| Failure | Fallback |
|---|---|
| Missing `window`/`document` | Mark `isSSR`, complete as `skipped-ssr` (if allowed) |
| Polyfill install error | Log warning; abort only in `strict` mode |
| Critical module load error | Abort with `failed` state |
| Non-critical module load error | Log warning; continue |

### BootLoader failures

| Failure | Fallback |
|---|---|
| Missing `raf` or `performance` | Mark unsupported → enter Recovery |
| No volumes found | Log warning; attempt default volume |
| Countdown cancelled | Move to `waiting-input`; continue after 1.2 s |
| Watchdog timeout (30 s) | Abort with `failed` state |

### SafeBoot failures

| Failure | Fallback |
|---|---|
| Integrity check fail | Enter safe mode |
| Extension (mandatory) fails | Abort with `failed` state |
| Extension (optional) fails | Log and continue |
| Service dependency failed | Mark service as failed; continue if not critical |
| Service (critical) fails | Abort with `failed` state |
| Session restore fails | Log warning; start with empty session |

### Kernel failures

| Failure | Fallback |
|---|---|
| `WindowManager` init error | Fall back to default viewport 1440×900 |
| Invalid window data on hydrate | Skip invalid entries |

### LockScreen failures

| Failure | Fallback |
|---|---|
| `crypto.subtle` unavailable | Use deterministic fallback hash |
| User not found | Refuse authentication |
| Lockout active | Show lockout banner; refuse input |

---

## Keyboard Flags

All flags available during the bootloader countdown:

| Flag | Shortcut | Effect |
|---|---|---|
| `verbose` | `⌘V` | Verbose mode, logs every action to console |
| `safe` | `⇧` | Safe mode, minimal services |
| `single-user` | `⌘S` | Single-user mode, no UI |
| `recovery` | `⌘R` | Recovery mode, NVRAM cleanup |
| `target-disk` | `T` | Target disk mode (stub) |
| `network` | `N` | Network boot (stub) |
| `no-graphics` | — | Disable graphics (stub) |
| `diagnostics` | `D` | Diagnostics mode (stub) |
| — | `⌘⌥PR` | Reset NVRAM (clear flags) |
| — | `Esc` | Abort boot |

Flags are persisted in `bootloader.nvram.v1` and can be merged with
`forceFlags` passed via constructor.

---

## Boot Volumes

| Volume | ID | Type | Order | Safe-compatible | Recovery-compatible |
|---|---|---|---|---|---|
| Macintosh HD | `main` | system | 0 | yes | yes |
| Previous Session | `session` | session | 1 | yes | yes |
| Profile N | `profile:N` | profile | 10+N | yes | yes |
| Recovery | `recovery` | recovery | 900 | yes | yes |
| Network Boot | `network` | network | 950 | no | yes |

The default selected volume is the one with the lowest `order` that
exists, unless NVRAM (`defaultVolumeId`, `lastSelected`) or the
constructor override it.

---

## Watchdogs and Timeouts

| Scope | Timeout | Behavior |
|---|---|---|
| BootLoader global | 30 s (configurable) | Abort with `failed` |
| Service start | 5 s (per service, configurable) | Retry, then fail |
| Module load | 8 s (per module, configurable) | Retry, then fail |
| Countdown tick | 100 ms | Update progress |
| Countdown total | 3 s (configurable) | Proceed to chainload |
| Idle lock | 5 min (configurable) | Lock the system |
| Screen saver | 10 min (configurable) | Show saver, lock |

---

## Complete Reference Timeline

A full boot, with every event, in chronological order.

```
[00:00.000] bootstrap:started
[00:00.001] bootstrap:state-changed         → validating
[00:00.005] bootstrap:validation-ok
[00:00.005] bootstrap:state-changed         → polyfilling
[00:00.010] bootstrap:polyfill-installed    → raf
[00:00.012] bootstrap:polyfill-installed    → performance-now
[00:00.014] bootstrap:polyfill-skipped      → crypto-randomUUID
[00:00.016] bootstrap:polyfill-skipped      → array-at
[00:00.020] bootstrap:state-changed         → freezing
[00:00.021] bootstrap:frozen                → [BOOTSTRAP_STATE]
[00:00.023] bootstrap:state-changed         → modules
[00:00.030] bootstrap:module-registered     → logging
[00:00.031] bootstrap:module-registered     → storage
[00:00.040] bootstrap:module-loaded         → logging
[00:00.045] bootstrap:module-loaded         → storage
[00:00.050] bootstrap:state-changed         → ready
[00:00.051] bootstrap:ready

[00:00.052] loader:started
[00:00.052] loader:state-changed            → detecting
[00:00.100] loader:env-detected             → { capabilities }
[00:00.101] loader:state-changed            → scanning
[00:00.150] loader:volumes-scanned          → [main, session, recovery]
[00:00.151] loader:volume-selected          → main
[00:00.152] loader:state-changed            → countdown
[00:01.152] loader:countdown-tick           → { seconds: 2 }
[00:02.152] loader:countdown-tick           → { seconds: 1 }
[00:03.152] loader:countdown-tick           → { seconds: 0 }
[00:03.153] loader:state-changed            → chainloading
[00:03.154] loader:chainload-start          → main
[00:03.160] loader:chainload-end
[00:03.161] loader:state-changed            → handoff
[00:03.162] loader:handoff                  → { flags: [], safeMode: false }

[00:03.163] boot:started                    → { safeMode: false }
[00:03.163] boot:phase-enter                → power-on
[00:03.164] boot:phase-exit                 → power-on
[00:03.165] boot:phase-enter                → post
[00:03.200] boot:integrity-ok
[00:03.201] boot:phase-exit                 → post
[00:03.202] boot:phase-enter                → loader
[00:03.203] boot:phase-exit                 → loader
[00:03.204] boot:phase-enter                → kernel-init
[00:03.205] boot:phase-exit                 → kernel-init
[00:03.206] boot:phase-enter                → load-extensions
[00:03.220] boot:extension-loaded           → core-icons
[00:03.230] boot:extension-loaded           → keyboard
[00:03.231] boot:phase-exit                 → load-extensions
[00:03.232] boot:phase-enter                → load-services
[00:03.240] boot:service-registered         → storage
[00:03.241] boot:service-registered         → notifications
[00:03.242] boot:service-registered         → network
[00:03.250] boot:service-started            → storage
[00:03.255] boot:service-started            → notifications
[00:03.260] boot:service-started            → network
[00:03.261] boot:phase-exit                 → load-services
[00:03.262] boot:phase-enter                → restore-session
[00:03.300] boot:session-restored
[00:03.301] boot:phase-exit                 → restore-session
[00:03.302] boot:phase-enter                → start-window-manager
[00:03.303] boot:phase-exit                 → start-window-manager
[00:03.304] boot:phase-enter                → ready
[00:03.305] boot:complete                   → { safeMode: false }

[00:03.306] viewport:changed                → { width: 1440, height: 900 }
[00:03.310] assets:started
[00:03.350] assets:ready
[00:03.360] setup:started                   → { config }
[00:03.400] lock:started
[00:03.401] lock:locked                     → { reason: "boot" }

[user enters password]

[00:15.230] lock:key-pressed                → { key: "Enter" }
[00:15.240] lock:auth-started               → { method: "password" }
[00:15.245] lock:auth-ok                    → { method: "password" }
[00:15.246] lock:unlocked
```

Total elapsed: **~3.4 seconds** from bootstrap to ready, plus however
long the user takes to enter their password.
