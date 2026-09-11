# rainOS Window Manager

Complete technical reference for the rainOS window manager: the `WindowManager`
class, the React provider, the hooks, and every action, query and event
available for building windows, docks, multitasking and window animations.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Window Model](#window-model)
4. [Constants](#constants)
5. [Geometry Helpers](#geometry-helpers)
6. [WindowManager Class](#windowmanager-class)
7. [React Provider](#react-provider)
8. [useWindowManager Hook](#usewindowmanager-hook)
9. [useDraggable Hook](#usedraggable-hook)
10. [useResizable Hook](#useresizable-hook)
11. [Events](#events)
12. [Snapping](#snapping)
13. [Focus Stack and Z-Index](#focus-stack-and-z-index)
14. [Window States](#window-states)
15. [Viewport and Reflow](#viewport-and-reflow)
16. [Hit Testing](#hit-testing)
17. [Persistence](#persistence)
18. [Complete Recipes](#complete-recipes)

---

## Overview

The window manager is the heart of rainOS. It is a pure JavaScript class
(`WindowManager`) with no React dependency. It manages:

- Window list (open, close, update).
- Position, size and state (normal, minimized, maximized, fullscreen).
- Focus stack and dynamic z-index.
- Dragging and resizing with 8 directions.
- Snapping to edges and viewport clamping.
- Hit testing by coordinates.
- Serialization and hydration.

The React provider (`WindowManagerProvider`) wraps an instance, subscribes
to its changes, and exposes an immutable snapshot plus a set of actions
and queries via the `useWindowManager()` hook.

Two additional hooks bridge DOM events to the manager: `useDraggable` for
dragging and `useResizable` for resizing from any edge or corner.

---

## Architecture

```
                     ┌──────────────────────────┐
                     │    WindowManager         │
                     │  (pure JS class)         │
                     │                          │
                     │  - windows: Window[]     │
                     │  - focusStack: number[]  │
                     │  - activeId: number      │
                     │  - viewport: {w, h}      │
                     │  - snapshots: Map        │
                     │  - metadata: Map         │
                     └────────────┬─────────────┘
                                  │
                                  │ subscribe / notify
                                  ▼
                     ┌──────────────────────────┐
                     │  WindowManagerProvider   │
                     │   (React adapter)        │
                     │                          │
                     │  - useReducer state      │
                     │  - useMemo api           │
                     │  - resize listener       │
                     └────────────┬─────────────┘
                                  │
                                  │ Context value
                                  ▼
                     ┌──────────────────────────┐
                     │   useWindowManager()     │
                     │                          │
                     │  windows, activeId, ...  │
                     │  open, close, move, ...  │
                     └──────────────────────────┘
```

The class is entirely framework-agnostic. You can instantiate it directly
in a test, in a Web Worker, or in a Node script that just needs the
geometry math.

---

## Window Model

Every window is a plain object:

```ts
type Window = {
  id: number,
  appId: string,
  title: string,
  component: React.ComponentType | null,
  data: any,

  x: number,
  y: number,
  width: number,
  height: number,

  state: "normal" | "minimized" | "maximized" | "fullscreen",
  zIndex: number,

  createdAt: number,
  lastFocusedAt: number,

  flags: {
    resizable: boolean,
    closable: boolean,
    minimizable: boolean,
    maximizable: boolean,
    fullscreenable: boolean,
  },

  minWidth: number,
  minHeight: number,
}
```

### Field reference

| Field | Type | Description |
|---|---|---|
| `id` | number | Auto-incremented unique ID |
| `appId` | string | Logical app identifier (`"finder"`, `"terminal"`, ...) |
| `title` | string | Title shown in the titlebar |
| `component` | React.ComponentType \| null | Content rendered inside the window |
| `data` | any | Arbitrary payload attached to the window |
| `x`, `y` | number | Top-left position in viewport coordinates |
| `width`, `height` | number | Current size |
| `state` | enum | One of `normal`, `minimized`, `maximized`, `fullscreen` |
| `zIndex` | number | Computed from the focus stack |
| `createdAt` | number | Timestamp when the window was opened |
| `lastFocusedAt` | number | Timestamp of last focus event |
| `flags` | object | Permission flags for user actions |
| `minWidth`, `minHeight` | number | Minimum size for resizing |

---

## Constants

| Constant | Default | Description |
|---|---|---|
| `Z_BASE` | `100` | Base z-index for windows |
| `Z_STEP` | `1` | Step between each window in the focus stack |
| `Z_MENUBAR` | `10000` | Reserved z-index for a future menu bar |
| `Z_DOCK` | `9000` | Reserved z-index for a future dock |
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

You can import them individually:

```js
import {
  Z_BASE,
  Z_STEP,
  MIN_WIDTH,
  MIN_HEIGHT,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  TOP_RESERVED,
  BOTTOM_RESERVED,
  SNAP_THRESHOLD,
  DOUBLE_CLICK_MS,
  CASCADE_STEP,
  CASCADE_WRAP,
} from "rainos/kernel";
```

---

## Geometry Helpers

Pure functions that operate on plain objects. Useful for tests and custom
UI code.

### `clamp(value, min, max)`

Returns `min` if `value < min`, `max` if `value > max`, otherwise `value`.

```js
clamp(150, 0, 100); // → 100
clamp(-5, 0, 100);  // → 0
clamp(42, 0, 100);  // → 42
```

### `clampToViewport(x, y, width, height, viewport)`

Keeps at least 80 px of the window visible horizontally and prevents it
from moving above `TOP_RESERVED` or below `viewport.height - 40`.

```js
const pos = clampToViewport(-500, -500, 800, 600, { width: 1440, height: 900 });
// → { x: -720, y: 28 }
```

### `constrainResize(rect, dir, dx, dy)`

Computes the new rectangle for a resize from a given direction, enforcing
minimum sizes and clamping the top edge to `TOP_RESERVED`.

```js
const rect = constrainResize(
  { x: 100, y: 100, width: 600, height: 400 },
  "se",
  50,
  30
);
// → { x: 100, y: 100, width: 650, height: 430 }
```

### `applySnap(x, y, width, height, viewport)`

Snaps the given position to the viewport edges if within
`SNAP_THRESHOLD` pixels.

```js
const snapped = applySnap(4, 30, 600, 400, { width: 1440, height: 900 });
// → { x: 0, y: 28 }
```

### `cascadePosition(index, viewport, width, height)`

Computes a cascading position for a new window, offset by
`CASCADE_STEP` pixels per index, wrapping every `CASCADE_WRAP` windows.

```js
const pos = cascadePosition(3, { width: 1440, height: 900 }, 720, 480);
// → { x: 424, y: 244 }
```

### `rectsIntersect(a, b)`

Returns `true` if two rectangles overlap.

### `pointInRect(px, py, rect)`

Returns `true` if the point `(px, py)` is inside the given rectangle.

---

## WindowManager Class

### Constructor

```js
const wm = new WindowManager({
  viewport: { width: 1440, height: 900 },
});
```

If no viewport is passed, it defaults to `1440×900`.

### Methods — lifecycle

| Method | Signature | Description |
|---|---|---|
| `open` | `(opts) → id` | Opens a new window and returns its ID |
| `close` | `(id) → boolean` | Closes a window; returns `false` if it does not exist |
| `closeAll` | `() → void` | Closes every window |
| `reset` | `() → void` | Clears everything and emits `manager:reset` |
| `update` | `(id, patch) → void` | Merges arbitrary fields into the window |
| `setTitle` | `(id, title) → void` | Shortcut for updating the title |
| `setData` | `(id, data) → void` | Shortcut for updating the data |

### Methods — focus

| Method | Signature | Description |
|---|---|---|
| `focus` | `(id) → void` | Brings the window to the top of the focus stack |
| `blur` | `() → void` | Removes focus from all windows |
| `focusNext` | `() → void` | Cycles focus to the next window |
| `focusPrev` | `() → void` | Cycles focus to the previous window |

### Methods — movement

| Method | Signature | Description |
|---|---|---|
| `move` | `(id, x, y, { snap }) → void` | Moves the window, optionally snapping |
| `resize` | `(id, dir, dx, dy) → void` | Resizes from a direction, with clamping |

### Methods — state transitions

| Method | Signature | Description |
|---|---|---|
| `minimize` | `(id) → void` | Minimizes and stores a snapshot |
| `restore` | `(id) → void` | Restores from minimized |
| `toggleMinimize` | `(id) → void` | Toggles minimize |
| `toggleMaximize` | `(id) → void` | Maximizes or restores |
| `toggleFullscreen` | `(id) → void` | Fullscreen or restores |

### Methods — viewport

| Method | Signature | Description |
|---|---|---|
| `setViewport` | `(viewport) → void` | Updates the viewport and reflows all windows |
| `getViewport` | `() → { width, height }` | Returns the current viewport |

When the viewport changes:

- Maximized windows resize to fit the new viewport.
- Fullscreen windows resize to fit the entire new viewport.
- All other windows are clamped to stay inside the new viewport.

### Methods — queries

| Method | Signature | Description |
|---|---|---|
| `getWindow` | `(id) → Window \| null` | Returns a single window (copy) |
| `getWindows` | `() → Window[]` | Returns all windows (copies) |
| `getVisibleWindows` | `() → Window[]` | Excludes minimized |
| `getMinimizedWindows` | `() → Window[]` | Only minimized |
| `getActive` | `() → Window \| null` | Returns the focused window |
| `getByApp` | `(appId) → Window[]` | Windows belonging to one app |
| `getWindowsSortedByZ` | `() → Window[]` | Ascending z-index |
| `getWindowsSortedByZDesc` | `() → Window[]` | Descending z-index |
| `count` | `() → number` | Number of windows |
| `has` | `(id) → boolean` | Window existence |
| `hitTest` | `(x, y) → id \| null` | Topmost window under a point |
| `getIntersecting` | `(rect) → Window[]` | Windows intersecting a rectangle |

### Methods — metadata

Attach custom data to a window without polluting the main model.

```js
wm.setMetadata(id, { openedBy: "keyboard", tag: "beta" });
const meta = wm.getMetadata(id);
```

### Methods — persistence

| Method | Signature | Description |
|---|---|---|
| `serialize` | `() → string` | Returns JSON with all windows (minus components) |
| `hydrate` | `(json) → boolean` | Restores from JSON; preserves existing components |
| `exportLayout` | `() → object` | Returns plain object without React refs |

### Methods — events

| Method | Signature | Description |
|---|---|---|
| `subscribe` | `(fn) → unsubscribe` | Registers a subscriber, called on every state change |
| `getState` | `() → State` | Returns `{ windows, activeId, viewport }` |
| `batch` | `(fn) → void` | Groups multiple state changes into one notification |

---

## React Provider

```jsx
import { WindowManagerProvider } from "rainos";

<WindowManagerProvider manager={customWindowManager}>
  <App />
</WindowManagerProvider>
```

### Props

| Prop | Type | Default | Description |
|---|---|---|---|
| `children` | ReactNode | — | The component tree to wrap |
| `manager` | `WindowManager` | `new WindowManager()` | Optional custom instance |

### Behavior

- Instantiates the manager on first render (or uses the passed one).
- Subscribes to its changes and stores the state in `useState`.
- Attaches a `resize` listener on `window` to update the viewport.
- Cleans up on unmount.

---

## useWindowManager Hook

```jsx
import { useWindowManager } from "rainos";

const {
  windows,
  activeId,
  viewport,
  open,
  close,
  move,
  // ...
} = useWindowManager();
```

### State returned

| Key | Type | Description |
|---|---|---|
| `manager` | `WindowManager` | The underlying instance |
| `windows` | `Window[]` | Current windows |
| `activeId` | `number \| null` | Focused window ID |
| `viewport` | `{ width, height }` | Current viewport |

### Actions returned

All methods of the class, plus helpers, are exposed:

```js
open(opts)
close(id)
closeAll()
reset()
focus(id)
blur()
focusNext()
focusPrev()
move(id, x, y, { snap })
resize(id, dir, dx, dy)
minimize(id)
restore(id)
toggleMinimize(id)
toggleMaximize(id)
toggleFullscreen(id)
update(id, patch)
setTitle(id, title)
setData(id, data)
```

### Queries returned

```js
getWindow(id)
getWindows()
getVisibleWindows()
getMinimizedWindows()
getActive()
getByApp(appId)
getWindowsSortedByZ()
getWindowsSortedByZDesc()
count()
has(id)
hitTest(x, y)
getIntersecting(rect)
```

### Metadata and persistence returned

```js
setMetadata(id, metadata)
getMetadata(id)
serialize()
hydrate(json)
exportLayout()
setViewport(v)
getViewport()
batch(fn)
```

---

## useDraggable Hook

```jsx
import { useDraggable } from "rainos";

function TitleBar({ id }) {
  const { handleMouseDown } = useDraggable(id, {
    snap: true,
    threshold: 0,
    onStart: ({ id, x, y }) => console.log("start", id, x, y),
    onMove: ({ id, x, y, dx, dy }) => console.log("move", dx, dy),
    onEnd: ({ id, moved }) => console.log("end", moved),
    getOrigin: () => ({ x: 0, y: 0 }),
  });

  return <div onMouseDown={handleMouseDown} />;
}
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `snap` | boolean | `true` | Whether to snap to edges while dragging |
| `threshold` | number | `0` | Minimum pixel distance before a drag starts |
| `onStart` | function | — | Called when the drag begins |
| `onMove` | function | — | Called on every mouse move |
| `onEnd` | function | — | Called when the drag ends |
| `getOrigin` | function | — | Override the starting position |

### Behavior

- On `mousedown`, focuses the window and stores the starting position.
- Attaches `mousemove` and `mouseup` listeners on `document`.
- On each `mousemove`, calls `move(id, x, y, { snap })`.
- On `mouseup`, cleans up the listeners.

Maximized and fullscreen windows cannot be dragged.

---

## useResizable Hook

```jsx
import { useResizable } from "rainos";

function ResizeHandle({ id, dir }) {
  const { handleMouseDown } = useResizable(id, dir, {
    onStart: ({ id, dir }) => console.log("resize start", dir),
    onMove: ({ id, dir, dx, dy }) => console.log("resize move", dx, dy),
    onEnd: ({ id, dir, moved }) => console.log("resize end", moved),
  });

  return <div onMouseDown={handleMouseDown} />;
}
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `onStart` | function | — | Called when the resize begins |
| `onMove` | function | — | Called on every mouse move |
| `onEnd` | function | — | Called when the resize ends |

### Directions

One of the eight directions in `RESIZE_DIRS`:

```
n   s   e   w   ne   nw   se   sw
```

### Behavior

- Calls `preventDefault()` and `stopPropagation()` on `mousedown`.
- Refuses to resize if the window's `resizable` flag is `false`.
- Refuses to resize maximized and fullscreen windows.
- Attaches `mousemove` and `mouseup` listeners on `document`.
- On each `mousemove`, calls `resize(id, dir, dx, dy)`.

---

## Events

All events are emitted on the shared `kernelBus`.

| Event | Payload | Description |
|---|---|---|
| `window:opened` | `{ id, window }` | A window was opened |
| `window:closed` | `{ id }` | A window was closed |
| `window:focused` | `{ id, previous }` | A window gained focus |
| `window:blurred` | `{ id }` | A window lost focus |
| `window:moved` | `{ id, x, y }` | A window was moved |
| `window:resized` | `{ id, x, y, width, height }` | A window was resized |
| `window:state-changed` | `{ id, state }` | State transitioned |
| `window:minimized` | `{ id }` | Minimized |
| `window:restored` | `{ id }` | Restored from minimized |
| `window:maximized` | `{ id }` | Maximized |
| `window:unmaximized` | `{ id }` | Restored from maximized |
| `window:fullscreen-enter` | `{ id }` | Entered fullscreen |
| `window:fullscreen-exit` | `{ id }` | Exited fullscreen |
| `window:updated` | `{ id, patch }` | Arbitrary field update |
| `viewport:changed` | `{ width, height }` | Viewport resized |
| `manager:reset` | `{}` | Manager was reset |
| `kernel:blur-all` | `{ reason }` | System-wide blur request |

You can subscribe from anywhere:

```js
import { kernelBus, KERNEL_EVENTS } from "rainos";

const off = kernelBus.on(KERNEL_EVENTS.WINDOW_OPENED, ({ id, window }) => {
  console.log(`Opened ${window.title} (#${id})`);
});

// Later:
off();
```

---

## Snapping

Snapping is applied during `move()` when the `snap` option is `true`.
The current implementation snaps to:

- **Left edge**: `x` within 12 px of `0`.
- **Right edge**: `x + width` within 12 px of `viewport.width`.
- **Top edge**: `y` within 12 px of `TOP_RESERVED`.

```js
wm.move(id, 5, 30, { snap: true });
// → snaps to { x: 0, y: 28 }
```

Snapping does not override clamping: if a snap would push the window
outside the viewport, the clamp takes precedence.

Future versions may add:

- Snap to other windows.
- Snap to screen thirds and halves (like Windows Snap).
- Snap to corners.

---

## Focus Stack and Z-Index

The manager maintains a **focus stack** (`focusStack`) as an ordered
array of window IDs. The last element is the currently focused window.
Z-index is computed from the position in the stack:

```
zIndex = Z_BASE + stackIndex * Z_STEP
```

When a window is focused:

1. It is removed from the stack.
2. It is pushed to the end of the stack.
3. `_reassignZ()` recomputes z-index for all windows.
4. `window:focused` is emitted with `{ id, previous }`.

When a window is closed or minimized:

- It is removed from the stack.
- If it was the active window, focus is passed to the previous one.
- `window:blurred` is emitted for the old active window.

### Reading the focus stack

```js
const wm = useWindowManager();
const sorted = wm.getWindowsSortedByZ();
// → ascending by z-index; last item is the active window
```

---

## Window States

Four states are possible:

| State | Description | Effect |
|---|---|---|
| `normal` | Default state | Can be moved and resized |
| `minimized` | Hidden, snapshot preserved | Cannot be moved or focused |
| `maximized` | Fills the viewport minus top/bottom reserved | Cannot be moved or resized |
| `fullscreen` | Fills the entire viewport | Cannot be moved or resized |

### Transitions

```
              minimize
    normal ──────────────▶ minimized
      ▲   ◀──────────────    │
      │     restore          │
      │                      │
      │ toggleMaximize       │
      ▼                      │
   maximized ◀───────────────┘
      ▲
      │ toggleFullscreen
      ▼
   fullscreen
```

### Snapshots

Before any transition out of `normal`, the current rect is stored in
`snapshots`. When reverting, the snapshot is restored. Snapshots are also
used for restoring minimized windows.

```js
wm.minimize(id);           // stores snapshot
wm.restore(id);            // restores snapshot
wm.toggleMaximize(id);     // stores snapshot, fills viewport
wm.toggleMaximize(id);     // restores snapshot
```

---

## Viewport and Reflow

The viewport is `{ width, height }` in CSS pixels. It is set initially
by the provider from `window.innerWidth` / `window.innerHeight`, and
updated on `resize`.

On every viewport change, the manager:

1. Recomputes maximized windows to fit the new viewport.
2. Recomputes fullscreen windows to fit the entire new viewport.
3. Clamps all other windows to stay inside the new viewport.

```js
wm.setViewport({ width: 1920, height: 1080 });
```

To customize the viewport (e.g. exclude a dock area), compute it manually
and pass it to the manager before mounting the provider.

---

## Hit Testing

`hitTest(x, y)` returns the ID of the topmost window containing the point.
Minimized windows are ignored.

```js
document.addEventListener("mousedown", (e) => {
  const id = wm.hitTest(e.clientX, e.clientY);
  if (id) wm.focus(id);
});
```

`getIntersecting(rect)` returns all visible windows that intersect the
given rectangle — useful for Mission Control overlays.

---

## Persistence

### Serialize

```js
const json = wm.serialize();
localStorage.setItem("session", json);
```

The serialized JSON contains:

- `version` — schema version.
- `windows` — all windows minus the `component` field.
- `activeId` — the focused window ID.
- `focusStack` — the ordered array of window IDs.
- `snapshots` — window geometry before maximize / minimize.

### Hydrate

```js
const json = localStorage.getItem("session");
wm.hydrate(json);
```

`hydrate` preserves existing `component` references by matching IDs. This
means the same component instances are reused across hydrations.

### Export layout

```js
const layout = wm.exportLayout();
```

Returns a plain object with `windows`, `activeId`, and `focusStack`,
without React references. Useful for saving presets or building
Mission Control overlays.

---

## Complete Recipes

### Open a window with a component

```jsx
const wm = useWindowManager();

wm.open({
  title: "Notes",
  component: Notes,
  width: 640,
  height: 420,
  data: { initialNote: "Hello" },
});
```

### Open a window with per-window permissions

```jsx
wm.open({
  title: "Dialog",
  component: ConfirmDialog,
  width: 400,
  height: 220,
  resizable: false,
  maximizable: false,
  fullscreenable: false,
});
```

### Drag and resize with your own chrome

```jsx
function Chrome({ win }) {
  const drag = useDraggable(win.id, { snap: true });
  const resizeSE = useResizable(win.id, "se");
  const resizeE = useResizable(win.id, "e");
  const resizeS = useResizable(win.id, "s");

  return (
    <div style={{
      position: "absolute",
      left: win.x, top: win.y,
      width: win.width, height: win.height,
      zIndex: win.zIndex,
    }}>
      <div onMouseDown={drag.handleMouseDown}>Title</div>
      <div>{/* content */}</div>
      <div onMouseDown={resizeSE.handleMouseDown} style={{ position: "absolute", right: 0, bottom: 0, width: 16, height: 16 }} />
      <div onMouseDown={resizeE.handleMouseDown} style={{ position: "absolute", right: 0, top: 0, bottom: 16, width: 6 }} />
      <div onMouseDown={resizeS.handleMouseDown} style={{ position: "absolute", bottom: 0, left: 0, right: 16, height: 6 }} />
    </div>
  );
}
```

### React to window events

```js
useEffect(() => {
  const off = kernelBus.on(KERNEL_EVENTS.WINDOW_OPENED, ({ id, window }) => {
    console.log(`Opened ${window.title} with ID ${id}`);
  });
  return off;
}, []);
```

### Save and restore a session

```js
// Save
useEffect(() => {
  return () => {
    localStorage.setItem("session", wm.serialize());
  };
}, [wm]);

// Restore
useEffect(() => {
  const json = localStorage.getItem("session");
  if (json) wm.hydrate(json);
}, [wm]);
```

### Batch multiple changes

```js
wm.batch(() => {
  wm.open({ title: "A" });
  wm.open({ title: "B" });
  wm.open({ title: "C" });
});
// Subscribers are notified once, after the batch completes.
```

### Bring the active window forward manually

```js
const active = wm.getActive();
if (active) wm.focus(active.id);
```

### Find the window under the pointer

```js
window.addEventListener("mousemove", (e) => {
  const id = wm.hitTest(e.clientX, e.clientY);
  document.body.style.cursor = id ? "pointer" : "default";
});
```

### Close all windows of one app

```js
wm.getByApp("terminal").forEach((win) => wm.close(win.id));
```

### Move a window to a specific corner

```js
const { width, height } = wm.getViewport();
wm.move(id, width - winWidth - 20, TOP_RESERVED + 20, { snap: false });
```
