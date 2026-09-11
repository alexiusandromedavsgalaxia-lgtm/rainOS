# Changelog

All notable changes to rainOS will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- Nothing yet.

### Changed

- Nothing yet.

### Deprecated

- Nothing yet.

### Removed

- Nothing yet.

### Fixed

- Nothing yet.

### Security

- Nothing yet.

---

## [0.1.0] — 2026-09-11

### Added

- **Kernel module** (`src/kernel/`)
  - `WindowManager` pure class with full window lifecycle.
  - Focus stack with dynamic z-index.
  - Drag and resize in 8 directions.
  - Snapping to viewport edges.
  - Clamping to viewport.
  - Hit testing by coordinates.
  - Serialization and hydration.
  - `WindowManagerProvider` + `useWindowManager` hook.
  - `useDraggable` and `useResizable` interaction hooks.
  - Geometry utilities: `clampToViewport`, `constrainResize`, `applySnap`,
    `cascadePosition`, `rectsIntersect`, `pointInRect`.
  - `kernelBus` event bus with `window:*`, `viewport:*`, `manager:*`,
    `kernel:*` events.

- **Bootstrap module** (`src/bootstrap/`)
  - `Bootstrap` class with environment validation, polyfills, freeze of
    critical objects, global error handlers, and module manifest.
  - Polyfills for `raf`, `performance.now`, `crypto.randomUUID`,
    `Array.prototype.at`, `Object.hasOwn`, `structuredClone`,
    `queueMicrotask`.
  - `BootstrapProvider` + `useBootstrap` hook.
  - `bootstrapBus` event bus with `bootstrap:*` events.
  - `TraceLog` ring buffer for boot traces.
  - Optional Service Worker registration.

- **BootLoader module** (`src/bootloader/`)
  - `BootLoader` class with environment detection, volume scanning,
    countdown, boot flags, chainloading, and handoff to SafeBoot.
  - Keyboard flags: `⌥` volume, `⌘V` verbose, `⇧` safe mode,
    `⌘R` recovery, `⌘S` single user, `⌘⌥PR` reset NVRAM, `Esc` abort.
  - `NVRAM` for persistent boot options.
  - `Watchdog` for global boot timeout.
  - `BootLoaderProvider` + `useBootLoader` hook.

- **SafeBoot module** (`src/safeboot/`)
  - `SafeBoot` class with phased boot: power-on, post, loader,
    kernel-init, load-extensions, load-services, restore-session,
    start-window-manager, ready.
  - `ServiceRegistry` with topological ordering, timeouts and retries.
  - `ExtensionRegistry` with safe-mode compatibility.
  - Integrity checks: storage, crypto, raf, performance.
  - Session restoration via `WindowManager.serialize/hydrate`.
  - Fallback to Safe Mode.
  - `SafeBootProvider` + `useSafeBoot` hook.

- **StartupInstaller module** (`src/startupinstaller/`)
  - `ImageRuntime` with format registry, decoder, LRU cache, preload.
  - `WindowRuntime` with styles, cursors, effects, traffic lights.
  - `MultitaskRuntime` with spaces, hot corners, gestures, shortcuts,
    transitions.
  - `StartupInstallerProvider` + `useStartupInstaller` hook.

- **InitialConfig module** (`src/initialconfig/`)
  - `InitialConfig` class with full setup assistant.
  - Steps: welcome, language, region, keyboard, network, migration,
    account, appearance, dock, privacy, shortcuts, summary, applying.
  - Auto-detection of locale, timezone, and date format.
  - Password hashing with SHA-256 via `crypto.subtle`.
  - `InitialConfigProvider` + `useInitialConfig` hook.
  - Constants: `LANGUAGES`, `REGIONS`, `TIMEZONES`, `KEYBOARDS`,
    `ACCENT_COLORS`, `WALLPAPERS`, `DEFAULT_CONFIG`.

- **InitSystem module** (`src/initsystem/`)
  - `InitSystem` visual component with Apple logo, progress bar, and
    status label.
  - `ConnectedInitSystem` that wires itself to Bootstrap, BootLoader,
    and SafeBoot.
  - Verbose mode with `⌘V`.
  - Sub-components: `AppleLogo`, `Spinner`, `ProgressBar`.
  - `useInitGate` hook.

- **LockScreen module** (`src/lockscreen/`)
  - `LockScreen` class with password authentication, Touch ID simulation,
    idle lock, lockout progressivo, user switching, screensaver, sleep,
    shutdown, restart.
  - `LockScreenProvider` + `useLockScreen` hook.
  - `LockScreenView` visual component.
  - `IdleMonitor` for inactivity detection.
  - `UserRegistry` reading the account from `initialconfig`.
  - `useLocked` and `useLockActions` hooks.

- **Documentation**
  - `docs/ARCHITECTURE.md` — full architecture in a single file.
  - `docs/BOOT_SEQUENCE.md` — full boot timeline with events.
  - `docs/WINDOW_MANAGER.md` — window manager API reference.
  - `docs/EVENTS.md` — every event emitted by every module.
  - `docs/API.md` — every class, provider, hook, constant and utility.

- **Tooling**
  - Vite build with multi-entry lib mode.
  - Vitest with jsdom environment.
  - ESLint + Prettier.
  - GitHub Actions CI (Node 18, 20, 22).
  - GitHub Actions release workflow.
  - Issue and PR templates.

- **Examples**
  - `examples/minimal/` — minimal kernel demo.
  - `examples/full-boot/` — full boot chain with lock screen.

### Notes

This is the **first public release** of rainOS. The API is stable enough
for experimentation but may change in future minor versions until `1.0.0`.

---

## Release Template

When adding a new version, use this template:

```markdown
## [X.Y.Z] — YYYY-MM-DD

### Added

- ...

### Changed

- ...

### Deprecated

- ...

### Removed

- ...

### Fixed

- ...

### Security

- ...
```

---

[Unreleased]: https://github.com/alexiusandromedavsgalaxia-lgtm/rainOS/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/alexiusandromedavsgalaxia-lgtm/rainOS/releases/tag/v0.1.0
