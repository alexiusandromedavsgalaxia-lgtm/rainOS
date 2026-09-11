# rainOS Events Reference

Complete reference of every event emitted by rainOS, across all modules.
Events are the primary communication mechanism between modules and between
the kernel and user code.

---

## Table of Contents

1. [Overview](#overview)
2. [Event Buses](#event-buses)
3. [Naming Convention](#naming-convention)
4. [Subscribing to Events](#subscribing-to-events)
5. [Bootstrap Events](#bootstrap-events)
6. [BootLoader Events](#bootloader-events)
7. [SafeBoot Events](#safeboot-events)
8. [Kernel Events](#kernel-events)
9. [StartupInstaller Events](#startupinstaller-events)
10. [InitialConfig Events](#initialconfig-events)
11. [LockScreen Events](#lockscreen-events)
12. [Event Order During Boot](#event-order-during-boot)
13. [Debugging Events](#debugging-events)

---

## Overview

rainOS emits events on two buses:

- **`bootstrapBus`** — used only by the bootstrap module. Exists because
  the bootstrap runs before the kernel is instantiated.
- **`kernelBus`** — used by every other module (kernel, bootloader,
  safeboot, startupinstaller, initialconfig, lockscreen).

Events are fire-and-forget: handlers cannot modify the payload that will
be received by other handlers. Exceptions thrown inside a handler are
logged and swallowed so one broken subscriber cannot break the system.

Every event name follows the pattern `namespace:event-name`.

---

## Event Buses

### `bootstrapBus`

```js
import { bootstrapBus } from "rainos";

bootstrapBus.on("bootstrap:ready", () => {
  console.log("Bootstrap ready");
});
```

### `kernelBus`

```js
import { kernelBus } from "rainos";

kernelBus.on("window:opened", ({ id, window }) => {
  console.log(`Opened ${window.title}`);
});
```

### Event bus API

Both buses expose the same API:

| Method | Signature | Description |
|---|---|---|
| `on` | `(event, handler) → unsubscribe` | Registers a listener |
| `once` | `(event, handler) → unsubscribe` | Registers a one-shot listener |
| `off` | `(event, handler) → void` | Removes a listener |
| `emit` | `(event, payload) → void` | Emits an event |
| `clear` | `(event?) → void` | Removes all listeners (or for one event) |
| `count` | `(event) → number` | Number of listeners for an event |

### History

`bootstrapBus` keeps a ring buffer of the last 1000 events:

```js
const history = bootstrapBus.getHistory();
```

Each entry is `{ ts, event, payload }`.

---

## Naming Convention

All events use the `namespace:event-name` format:

| Namespace | Module |
|---|---|
| `bootstrap:` | Bootstrap |
| `loader:` | BootLoader |
| `boot:` | SafeBoot |
| `window:` | Kernel (windows) |
| `viewport:` | Kernel (viewport) |
| `manager:` | Kernel (manager-level) |
| `kernel:` | Kernel (system-wide) |
| `assets:` | StartupInstaller |
| `setup:` | InitialConfig |
| `lock:` | LockScreen |

Event names use **kebab-case** for the action:

```
window:fullscreen-enter
window:state-changed
bootstrap:polyfill-installed
```

This makes it easy to filter events by namespace:

```js
const isWindowEvent = (name) => name.startsWith("window:");
```

---

## Subscribing to Events

### Basic subscription

```js
import { kernelBus, KERNEL_EVENTS } from "rainos";

const off = kernelBus.on(KERNEL_EVENTS.WINDOW_OPENED, (payload) => {
  console.log(payload);
});

// Later:
off();
```

### Using the event constants

Every module exports its event names as a frozen object:

```js
import { KERNEL_EVENTS, LOADER_EVENTS, BOOT_EVENTS, LOCK_EVENTS } from "rainos";

KERNEL_EVENTS.WINDOW_OPENED; // "window:opened"
LOADER_EVENTS.HANDOFF;        // "loader:handoff"
BOOT_EVENTS.COMPLETE;         // "boot:complete"
LOCK_EVENTS.UNLOCKED;         // "lock:unlocked"
```

### Using string literals

Since the bus is a plain string-keyed map, you can subscribe with the raw
event name too:

```js
kernelBus.on("window:opened", handler);
```

### Subscribing to a whole namespace

The bus does not support wildcards natively. To listen to a namespace,
subscribe to each event individually or wrap the bus:

```js
const offs = Object.values(KERNEL_EVENTS)
  .filter((name) => name.startsWith("window:"))
  .map((name) => kernelBus.on(name, (payload) => console.log(name, payload)));
```

### One-shot subscription

```js
kernelBus.once("boot:complete", () => {
  console.log("Boot completed");
});
```

### Subscribing from React

```jsx
import { useEffect } from "react";
import { kernelBus, KERNEL_EVENTS } from "rainos";

function WindowTracker() {
  useEffect(() => {
    const off = kernelBus.on(KERNEL_EVENTS.WINDOW_OPENED, ({ id, window }) => {
      console.log(`Opened ${window.title} (#${id})`);
    });
    return off;
  }, []);
  return null;
}
```

---

## Bootstrap Events

Emitted on `bootstrapBus`. Namespace: `bootstrap:`.

| Event | Payload | When |
|---|---|---|
| `bootstrap:started` | `{ options }` | Bootstrap begins |
| `bootstrap:state-changed` | `{ state }` | State machine transition |
| `bootstrap:validation-ok` | `{ validation }` | Environment validation passed |
| `bootstrap:validation-fail` | `{ validation }` | Environment validation failed |
| `bootstrap:polyfill-installed` | `{ id }` | A polyfill was installed |
| `bootstrap:polyfill-skipped` | `{ id }` | A polyfill was already present |
| `bootstrap:frozen` | `{ frozen }` | Critical objects were frozen |
| `bootstrap:module-registered` | `{ id }` | A module was registered |
| `bootstrap:module-loaded` | `{ id }` | A module finished loading |
| `bootstrap:module-failed` | `{ id, error }` | A module failed to load |
| `bootstrap:global-error` | `{ message, stack, filename, lineno }` | `window.onerror` fired |
| `bootstrap:global-rejection` | `{ reason, stack }` | `unhandledrejection` fired |
| `bootstrap:sw-registered` | `{ scope }` | Service Worker registered |
| `bootstrap:sw-failed` | `{ error }` | Service Worker registration failed |
| `bootstrap:ready` | `{ ssr }` | Bootstrap completed |
| `bootstrap:failed` | `{ error }` | Bootstrap aborted |
| `bootstrap:trace` | `{ ts, delta, level, message, meta }` | Every trace entry |

### Example

```js
bootstrapBus.on("bootstrap:polyfill-installed", ({ id }) => {
  console.log(`Installed polyfill: ${id}`);
});

bootstrapBus.on("bootstrap:ready", ({ ssr }) => {
  console.log(ssr ? "SSR context" : "Browser context");
});
```

### Constants

```js
import { BOOTSTRAP_EVENTS } from "rainos";

BOOTSTRAP_EVENTS.STARTED;
BOOTSTRAP_EVENTS.READY;
BOOTSTRAP_EVENTS.POLYFILL_INSTALLED;
BOOTSTRAP_EVENTS.FROZEN;
BOOTSTRAP_EVENTS.MODULE_LOADED;
BOOTSTRAP_EVENTS.GLOBAL_ERROR;
BOOTSTRAP_EVENTS.TRACE;
```

---

## BootLoader Events

Emitted on `kernelBus`. Namespace: `loader:`.

| Event | Payload | When |
|---|---|---|
| `loader:started` | `{ options }` | Loader begins |
| `loader:state-changed` | `{ state }` | State machine transition |
| `loader:env-detected` | `{ env }` | Environment detected |
| `loader:env-unsupported` | `{ env }` | Environment unsupported |
| `loader:volumes-scanned` | `{ volumes }` | Boot volumes listed |
| `loader:volume-selected` | `{ id }` | A volume was selected |
| `loader:countdown-tick` | `{ remainingMs, seconds }` | Countdown tick |
| `loader:countdown-cancelled` | `{ reason }` | Countdown cancelled |
| `loader:flag-toggled` | `{ flag, enabled }` | A boot flag toggled |
| `loader:flags-updated` | `{ flags }` | Full flag list changed |
| `loader:key-pressed` | `{ key, metaKey, altKey, shiftKey, ctrlKey }` | Key pressed during boot |
| `loader:chainload-start` | `{ target }` | Chainload begins |
| `loader:chainload-end` | `{}` | Chainload ends |
| `loader:handoff` | `{ flags, safeMode }` | Handoff to SafeBoot |
| `loader:recovery-entered` | `{}` | Recovery mode entered |
| `loader:recovery-exited` | `{}` | Recovery mode exited |
| `loader:failed` | `{ error }` | Boot failed |
| `loader:aborted` | `{}` | Boot aborted |
| `loader:watchdog-timeout` | `{ after }` | Watchdog fired |
| `loader:nvram-saved` | `{ data }` | NVRAM saved |
| `loader:nvram-loaded` | `{ data }` | NVRAM loaded |
| `loader:verbose-log` | `{ message, meta }` | Verbose log entry |
| `loader:log` | `{ ts, level, message, meta }` | General log entry |

### Example

```js
kernelBus.on("loader:countdown-tick", ({ seconds }) => {
  console.log(`Booting in ${seconds}...`);
});

kernelBus.on("loader:handoff", ({ flags, safeMode }) => {
  console.log(`Handoff with flags: ${flags.join(", ")}, safe: ${safeMode}`);
});
```

### Constants

```js
import { LOADER_EVENTS, BOOT_FLAG } from "rainos";

LOADER_EVENTS.STARTED;
LOADER_EVENTS.COUNTDOWN_TICK;
LOADER_EVENTS.HANDOFF;
LOADER_EVENTS.FAILED;

BOOT_FLAG.VERBOSE;       // "verbose"
BOOT_FLAG.SAFE;          // "safe"
BOOT_FLAG.RECOVERY;      // "recovery"
BOOT_FLAG.SINGLE_USER;   // "single-user"
```

---

## SafeBoot Events

Emitted on `kernelBus`. Namespace: `boot:`.

| Event | Payload | When |
|---|---|---|
| `boot:started` | `{ safeMode }` | Boot begins |
| `boot:phase-enter` | `{ phase }` | Entering a boot phase |
| `boot:phase-exit` | `{ phase }` | Exiting a boot phase |
| `boot:progress` | `{ value }` | Progress update (0–100) |
| `boot:log` | `{ ts, level, message, meta }` | Log entry |
| `boot:warning` | `{ warning }` | Non-fatal warning |
| `boot:error` | `{ error }` | Fatal error |
| `boot:service-registered` | `{ name }` | Service registered |
| `boot:service-started` | `{ name }` | Service started |
| `boot:service-failed` | `{ name, error }` | Service failed |
| `boot:service-stopped` | `{ name }` | Service stopped |
| `boot:extension-loaded` | `{ id }` | Extension loaded |
| `boot:extension-failed` | `{ id, error }` | Extension failed |
| `boot:integrity-ok` | `{ results }` | Integrity checks passed |
| `boot:integrity-fail` | `{ results }` | Integrity checks failed |
| `boot:session-restored` | `{}` | Session restored from storage |
| `boot:session-restore-failed` | `{}` | Session restore failed |
| `boot:safe-mode-entered` | `{}` | Safe mode entered |
| `boot:safe-mode-exited` | `{}` | Safe mode exited |
| `boot:complete` | `{ safeMode }` | Boot completed |
| `boot:failed` | `{ error }` | Boot failed |
| `boot:shutdown-started` | `{}` | Shutdown begins |
| `boot:shutdown-complete` | `{}` | Shutdown completed |

### Example

```js
kernelBus.on("boot:phase-enter", ({ phase }) => {
  console.log(`Entering phase: ${phase}`);
});

kernelBus.on("boot:service-started", ({ name }) => {
  console.log(`Service started: ${name}`);
});

kernelBus.on("boot:complete", ({ safeMode }) => {
  console.log(`Boot complete${safeMode ? " (safe mode)" : ""}`);
});
```

### Constants

```js
import { BOOT_EVENTS, BOOT_PHASE } from "rainos";

BOOT_EVENTS.STARTED;
BOOT_EVENTS.SERVICE_STARTED;
BOOT_EVENTS.SAFE_MODE_ENTERED;
BOOT_EVENTS.COMPLETE;

BOOT_PHASE.POWER_ON;             // "power-on"
BOOT_PHASE.POST;                 // "post"
BOOT_PHASE.KERNEL_INIT;          // "kernel-init"
BOOT_PHASE.LOAD_SERVICES;        // "load-services"
BOOT_PHASE.RESTORE_SESSION;      // "restore-session"
BOOT_PHASE.READY;                // "ready"
```

---

## Kernel Events

Emitted on `kernelBus`. Namespaces: `window:`, `viewport:`, `manager:`,
`kernel:`.

### Window events (`window:`)

| Event | Payload | When |
|---|---|---|
| `window:opened` | `{ id, window }` | A window was opened |
| `window:closed` | `{ id }` | A window was closed |
| `window:focused` | `{ id, previous }` | A window gained focus |
| `window:blurred` | `{ id }` | A window lost focus |
| `window:moved` | `{ id, x, y }` | A window was moved |
| `window:resized` | `{ id, x, y, width, height }` | A window was resized |
| `window:state-changed` | `{ id, state }` | State transitioned |
| `window:minimized` | `{ id }` | Minimized |
| `window:restored` | `{ id }` | Restored |
| `window:maximized` | `{ id }` | Maximized |
| `window:unmaximized` | `{ id }` | Unmaximized |
| `window:fullscreen-enter` | `{ id }` | Entered fullscreen |
| `window:fullscreen-exit` | `{ id }` | Exited fullscreen |
| `window:updated` | `{ id, patch }` | Arbitrary update |

### Viewport events (`viewport:`)

| Event | Payload | When |
|---|---|---|
| `viewport:changed` | `{ width, height }` | Viewport resized |

### Manager events (`manager:`)

| Event | Payload | When |
|---|---|---|
| `manager:reset` | `{}` | Manager was reset |

### Kernel-level events (`kernel:`)

| Event | Payload | When |
|---|---|---|
| `kernel:blur-all` | `{ reason }` | System-wide blur request |

### Example

```js
kernelBus.on(KERNEL_EVENTS.WINDOW_OPENED, ({ id, window }) => {
  console.log(`Opened ${window.title} (#${id})`);
});

kernelBus.on(KERNEL_EVENTS.WINDOW_STATE_CHANGED, ({ id, state }) => {
  console.log(`Window ${id} state: ${state}`);
});

kernelBus.on(KERNEL_EVENTS.VIEWPORT_CHANGED, ({ width, height }) => {
  console.log(`Viewport: ${width}×${height}`);
});
```

### Constants

```js
import { KERNEL_EVENTS, WINDOW_STATE, RESIZE_DIRS } from "rainos";

KERNEL_EVENTS.WINDOW_OPENED;      // "window:opened"
KERNEL_EVENTS.WINDOW_FOCUSED;     // "window:focused"
KERNEL_EVENTS.WINDOW_MOVED;       // "window:moved"
KERNEL_EVENTS.VIEWPORT_CHANGED;   // "viewport:changed"

WINDOW_STATE.NORMAL;              // "normal"
WINDOW_STATE.MINIMIZED;           // "minimized"
WINDOW_STATE.MAXIMIZED;           // "maximized"
WINDOW_STATE.FULLSCREEN;          // "fullscreen"

RESIZE_DIRS;                      // ["n","s","e","w","ne","nw","se","sw"]
```

---

## StartupInstaller Events

Emitted on `kernelBus`. Namespace: `assets:`.

### Runtime events

| Event | Payload | When |
|---|---|---|
| `assets:started` | `{ options }` | Installer begins |
| `assets:state-changed` | `{ state }` | State transition |
| `assets:ready` | `{}` | Installer finished |
| `assets:failed` | `{ error }` | Installer failed |
| `assets:progress` | `{ value, label }` | Progress update |

### Image runtime (`assets:image-*`)

| Event | Payload | When |
|---|---|---|
| `assets:image-format-registered` | `{ mime, ext }` | A format was registered |
| `assets:image-asset-registered` | `{ id, kind, mime }` | An asset was registered |
| `assets:image-decoded` | `{ src, cacheKey, size }` | An image was decoded |
| `assets:image-cache-hit` | `{ src, cacheKey }` | Cache hit |
| `assets:image-cache-miss` | `{ src, cacheKey }` | Cache miss |
| `assets:image-evicted` | `{ src, size }` | LRU eviction |
| `assets:image-preloaded` | `{ src }` | Preload finished for a source |
| `assets:image-failed` | `{ src, error }` | Decode failed |

### Window runtime (`assets:window-*`)

| Event | Payload | When |
|---|---|---|
| `assets:window-style-registered` | `{ id }` | A window style was registered |
| `assets:window-cursor-registered` | `{ zone, cursor }` | A cursor was registered |
| `assets:window-effect-registered` | `{ id }` | An effect was registered |

### Multitask runtime (`assets:*`)

| Event | Payload | When |
|---|---|---|
| `assets:space-registered` | `{ id }` | A virtual desktop was registered |
| `assets:hot-corner-registered` | `{ corner }` | A hot corner was registered |
| `assets:gesture-registered` | `{ id }` | A gesture was registered |
| `assets:shortcut-registered` | `{ combo }` | A keyboard shortcut was registered |
| `assets:transition-registered` | `{ id }` | A transition was registered |

### Example

```js
kernelBus.on("assets:image-decoded", ({ src, size }) => {
  console.log(`Decoded ${src} (${size} bytes)`);
});

kernelBus.on("assets:ready", () => {
  console.log("Assets installed");
});
```

### Constants

```js
import { INSTALL_EVENTS, INSTALL_STATE, ASSET_KIND, WINDOW_ZONE } from "rainos";

INSTALL_EVENTS.STARTED;
INSTALL_EVENTS.IMAGE_DECODED;
INSTALL_EVENTS.SPACE_REGISTERED;
INSTALL_EVENTS.READY;

INSTALL_STATE.LOADING_IMAGES;
INSTALL_STATE.LOADING_WINDOWS;
INSTALL_STATE.READY;

ASSET_KIND.IMAGE;
ASSET_KIND.SVG;
ASSET_KIND.SPRITE;

WINDOW_ZONE.TITLEBAR;
WINDOW_ZONE.RESIZE_N;
WINDOW_ZONE.CLOSE;
```

---

## InitialConfig Events

Emitted on `kernelBus`. Namespace: `setup:`.

| Event | Payload | When |
|---|---|---|
| `setup:started` | `{ config }` | Setup begins |
| `setup:step-enter` | `{ step }` | Entering a step |
| `setup:step-exit` | `{ step }` | Exiting a step |
| `setup:step-changed` | `{ step }` | Step changed |
| `setup:value-changed` | `{ path, value }` | A config value changed |
| `setup:language-set` | `{ language }` | Language applied |
| `setup:region-set` | `{ region, timezone, dateFormat, numberFormat, use24Hour }` | Region applied |
| `setup:keyboard-set` | `{ keyboard }` | Keyboard applied |
| `setup:network-set` | `{ network }` | Network applied |
| `setup:migration-set` | `{ migration }` | Migration applied |
| `setup:account-set` | `{ account }` | Account applied |
| `setup:appearance-set` | `{ appearance }` | Appearance applied |
| `setup:dock-set` | `{ dock }` | Dock applied |
| `setup:privacy-set` | `{ privacy }` | Privacy applied |
| `setup:shortcuts-set` | `{ shortcuts }` | Shortcuts applied |
| `setup:applying` | `{}` | Applying begins |
| `setup:applied` | `{}` | Applying finished |
| `setup:validation-error` | `{ step, errors }` | Validation failed |
| `setup:progress` | `{ value, label }` | Progress update |
| `setup:log` | `{ ts, level, message, meta }` | Log entry |
| `setup:warning` | `{ warning }` | Warning |
| `setup:error` | `{ error }` | Error |
| `setup:complete` | `{}` | Setup completed |
| `setup:failed` | `{ error }` | Setup failed |
| `setup:cancelled` | `{}` | Setup cancelled |
| `setup:reset` | `{}` | Setup reset |

### Example

```js
kernelBus.on("setup:step-changed", ({ step }) => {
  console.log(`Setup step: ${step}`);
});

kernelBus.on("setup:complete", () => {
  console.log("Setup complete");
});
```

### Constants

```js
import { SETUP_EVENTS, SETUP_STEP, SETUP_ORDER } from "rainos";

SETUP_EVENTS.STARTED;
SETUP_EVENTS.STEP_CHANGED;
SETUP_EVENTS.ACCOUNT_SET;
SETUP_EVENTS.COMPLETE;

SETUP_STEP.WELCOME;       // "welcome"
SETUP_STEP.LANGUAGE;      // "language"
SETUP_STEP.ACCOUNT;       // "account"
SETUP_STEP.APPEARANCE;    // "appearance"
SETUP_STEP.DONE;          // "done"
```

---

## LockScreen Events

Emitted on `kernelBus`. Namespace: `lock:`.

| Event | Payload | When |
|---|---|---|
| `lock:started` | `{ options }` | Lock screen initialized |
| `lock:locked` | `{ reason, graceUntil }` | System locked |
| `lock:unlocked` | `{ method }` | System unlocked |
| `lock:state-changed` | `{ state }` | State transition |
| `lock:auth-started` | `{ method }` | Authentication begins |
| `lock:auth-ok` | `{ method }` | Authentication succeeded |
| `lock:auth-fail` | `{ method }` | Authentication failed |
| `lock:biometry-started` | `{ method }` | Touch ID starts |
| `lock:biometry-ok` | `{}` | Touch ID succeeded |
| `lock:biometry-fail` | `{}` | Touch ID failed |
| `lock:failed-attempt` | `{ attempts, max }` | Failed attempt recorded |
| `lock:lockout` | `{ until, durationMs }` | Lockout triggered |
| `lock:lockout-ended` | `{}` | Lockout expired |
| `lock:screen-saver-on` | `{}` | Screen saver shown |
| `lock:screen-saver-off` | `{}` | Screen saver hidden |
| `lock:user-changed` | `{ id }` | Active user changed |
| `lock:user-switching` | `{ from, to }` | User switching in progress |
| `lock:sleep` | `{}` | System sleeping |
| `lock:wake` | `{}` | System woke |
| `lock:shutdown` | `{}` | Shutdown requested |
| `lock:restart` | `{}` | Restart requested |
| `lock:cancel` | `{}` | Cancel action |
| `lock:idle-timeout` | `{}` | Idle timeout reached |
| `lock:visibility-hidden` | `{}` | Tab hidden |
| `lock:visibility-visible` | `{}` | Tab visible |
| `lock:clock-tick` | `{ now }` | Clock update (1 Hz) |
| `lock:log` | `{ ts, level, message, meta }` | Log entry |
| `lock:error` | `{ error }` | Error |
| `lock:warning` | `{ warning }` | Warning |

### Example

```js
kernelBus.on("lock:locked", ({ reason }) => {
  console.log(`Locked: ${reason}`);
});

kernelBus.on("lock:auth-fail", () => {
  console.log("Wrong password");
});

kernelBus.on("lock:unlocked", ({ method }) => {
  console.log(`Unlocked via ${method}`);
});
```

### Constants

```js
import { LOCK_EVENTS, LOCK_STATE, AUTH_METHOD } from "rainos";

LOCK_EVENTS.LOCKED;
LOCK_EVENTS.UNLOCKED;
LOCK_EVENTS.AUTH_OK;
LOCK_EVENTS.LOCKOUT;
LOCK_EVENTS.SLEEP;

LOCK_STATE.LOCKED;
LOCK_STATE.UNLOCKED;
LOCK_STATE.SCREEN_SAVER;

AUTH_METHOD.PASSWORD;
AUTH_METHOD.TOUCH_ID;
AUTH_METHOD.WATCH;
```

---

## Event Order During Boot

A typical boot emits events in this order:

```
1. bootstrap:started
2. bootstrap:state-changed       → validating
3. bootstrap:validation-ok
4. bootstrap:state-changed       → polyfilling
5. bootstrap:polyfill-installed  (xN)
6. bootstrap:state-changed       → freezing
7. bootstrap:frozen
8. bootstrap:state-changed       → modules
9. bootstrap:module-registered   (xN)
10. bootstrap:module-loaded      (xN)
11. bootstrap:state-changed      → ready
12. bootstrap:ready

13. loader:started
14. loader:state-changed         → detecting
15. loader:env-detected
16. loader:state-changed         → scanning
17. loader:volumes-scanned
18. loader:volume-selected
19. loader:state-changed         → countdown
20. loader:countdown-tick        (xN, every 100 ms)
21. loader:state-changed         → chainloading
22. loader:chainload-start
23. loader:chainload-end
24. loader:state-changed         → handoff
25. loader:handoff

26. boot:started
27. boot:phase-enter             → power-on
28. boot:phase-exit              → power-on
29. boot:phase-enter             → post
30. boot:integrity-ok
31. boot:phase-exit              → post
32. boot:phase-enter             → kernel-init
33. boot:phase-exit              → kernel-init
34. boot:phase-enter             → load-extensions
35. boot:extension-loaded        (xN)
36. boot:phase-exit              → load-extensions
37. boot:phase-enter             → load-services
38. boot:service-registered      (xN)
39. boot:service-started         (xN)
40. boot:phase-exit              → load-services
41. boot:phase-enter             → restore-session
42. boot:session-restored
43. boot:phase-exit              → restore-session
44. boot:phase-enter             → start-window-manager
45. boot:phase-exit              → start-window-manager
46. boot:phase-enter             → ready
47. boot:complete

48. viewport:changed
49. assets:started
50. assets:ready
51. setup:started
52. lock:started
53. lock:locked
```

Note: `assets:started` and `setup:started` only fire if the respective
modules are mounted and their `autoRun` / `autoStart` props are `true`.

---

## Debugging Events

### Trace every event

```js
import { kernelBus, bootstrapBus } from "rainos";

const allEvents = [
  ...Object.values(KERNEL_EVENTS),
  ...Object.values(BOOTSTRAP_EVENTS),
];

const offs = allEvents.map((name) => {
  const bus = name.startsWith("bootstrap:") ? bootstrapBus : kernelBus;
  return bus.on(name, (payload) => {
    console.log(`[event] ${name}`, payload);
  });
});

// Later:
offs.forEach((off) => off());
```

### Filter by namespace

```js
const offs = Object.values(KERNEL_EVENTS)
  .filter((name) => name.startsWith("window:"))
  .map((name) => kernelBus.on(name, (p) => console.log(name, p)));
```

### Replay bootstrap history

```js
import { bootstrapBus } from "rainos";

const history = bootstrapBus.getHistory();
history.forEach(({ ts, event, payload }) => {
  console.log(`[+${ts}] ${event}`, payload);
});
```

### Count listeners

```js
kernelBus.count(KERNEL_EVENTS.WINDOW_OPENED); // → 3
```

### Clear all listeners

```js
kernelBus.clear();
```

Useful in tests to prevent leakage between cases.

---

## Summary Table

| Module | Namespace | Bus | Emits | Listens |
|---|---|---|---|---|
| Bootstrap | `bootstrap:` | `bootstrapBus` | ✅ | — |
| BootLoader | `loader:` | `kernelBus` | ✅ | — |
| SafeBoot | `boot:` | `kernelBus` | ✅ | `loader:*` |
| Kernel | `window:`, `viewport:`, `manager:`, `kernel:` | `kernelBus` | ✅ | `kernel:blur-all` |
| StartupInstaller | `assets:` | `kernelBus` | ✅ | — |
| InitialConfig | `setup:` | `kernelBus` | ✅ | — |
| LockScreen | `lock:` | `kernelBus` | ✅ | `kernel:blur-all` |
