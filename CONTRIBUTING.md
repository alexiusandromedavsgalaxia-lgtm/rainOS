# Contributing to rainOS

Thanks for your interest in contributing to rainOS! This document explains
how to set up the project, the conventions we follow, and how to submit
changes.

---

## Table of Contents

1. [Code of Conduct](#code-of-conduct)
2. [Getting Started](#getting-started)
3. [Project Structure](#project-structure)
4. [Development Workflow](#development-workflow)
5. [Commit Conventions](#commit-conventions)
6. [Pull Request Process](#pull-request-process)
7. [Coding Style](#coding-style)
8. [Testing](#testing)
9. [Documentation](#documentation)
10. [Release Process](#release-process)
11. [Reporting Bugs](#reporting-bugs)
12. [Requesting Features](#requesting-features)

---

## Code of Conduct

Be respectful. We are all here to build something useful. Harassment,
discrimination or personal attacks will not be tolerated.

If you experience or witness unacceptable behavior, open an issue or
contact the maintainers directly.

---

## Getting Started

### Prerequisites

- **Node.js** 18 or higher
- **npm** 9 or higher (or **pnpm** / **yarn**)
- **Git** 2.30 or higher

### Fork and clone

```bash
# 1. Fork the repo on GitHub
# 2. Clone your fork
git clone https://github.com/<your-username>/rainOS.git
cd rainOS

# 3. Add the upstream remote
git remote add upstream https://github.com/alexiusandromedavsgalaxia-lgtm/rainOS.git

# 4. Install dependencies
npm install
```

### Run the examples

```bash
npm run dev
```

Opens the minimal example at `http://localhost:5173`.

### Run the tests

```bash
npm run test          # one-shot
npm run test:watch    # watch mode
npm run test:coverage # with coverage
```

### Build the library

```bash
npm run build
```

Output goes to `dist/`.

---

## Project Structure

```
rainOS/
├── .github/              CI, templates
├── docs/                 Technical documentation
├── examples/             Runnable examples
├── src/
│   ├── kernel/           Window manager
│   ├── bootstrap/        First code that runs
│   ├── bootloader/       Boot volume scanning, countdown, flags
│   ├── safeboot/         Services, extensions, session restore
│   ├── startupinstaller/ Asset runtime installer
│   ├── initialconfig/    Setup assistant
│   ├── initsystem/       Boot screen UI
│   ├── lockscreen/       Authentication and lock cycle
│   └── index.js          Barrel export
├── tests/                Vitest tests
├── package.json
├── vite.config.js
├── vitest.config.js
└── README.md
```

Each module has the same internal layout:

```
src/<module>/
├── index.js              Barrel export
└── <module>.jsx          Full implementation
```

Inside a module file, the code follows this order:

```
1. Imports
2. Constants
3. Logger
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

## Development Workflow

### Branch naming

| Type | Prefix | Example |
|---|---|---|
| Feature | `feat/` | `feat/mission-control` |
| Bug fix | `fix/` | `fix/drag-offscreen` |
| Docs | `docs/` | `docs/api-reference` |
| Refactor | `refactor/` | `refactor/window-manager` |
| Test | `test/` | `test/geometry` |
| Chore | `chore/` | `chore/update-deps` |

Always branch from `main`:

```bash
git checkout main
git pull upstream main
git checkout -b feat/my-feature
```

### Keep your fork up to date

```bash
git fetch upstream
git checkout main
git merge upstream/main
git push origin main
```

---

## Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/).

### Format

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

### Types

| Type | Use for |
|---|---|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `style` | Formatting, missing semicolons, etc. |
| `refactor` | Neither a feature nor a bug fix |
| `perf` | Performance improvement |
| `test` | Adding or fixing tests |
| `chore` | Build, CI, tooling |
| `revert` | Reverting a previous commit |

### Scopes

Use the module name when applicable:

```
feat(kernel): add Mission Control overlay
fix(bootloader): prevent countdown from restarting
docs(api): document useResizable options
test(geometry): cover clampToViewport edge cases
chore(deps): bump vite to 5.2.0
```

### Examples

```
feat(safeboot): support for hot-swappable services

Add a new `registerService` API that accepts `deps`, `retries` and
`timeout`. Services are started in topological order. Failures in
non-critical services are logged, not thrown.

Closes #42
```

### Breaking changes

Add `BREAKING CHANGE:` in the footer:

```
feat(kernel): change WindowManager.open signature

BREAKING CHANGE: `open` now returns the window ID instead of the
window object. Use `getWindow(id)` if you need the full object.
```

---

## Pull Request Process

1. **Update the documentation** if you change the public API.
2. **Add tests** for new functionality.
3. **Run the full pipeline locally**:
   ```bash
   npm run lint && npm run test && npm run build
   ```
4. **Fill the PR template** completely.
5. **Link the issue** with `Closes #NN`.
6. **Wait for review**. At least one maintainer must approve.
7. **Squash and merge** is preferred. The PR title becomes the merge
   commit message, so follow Conventional Commits in the title too.

### What we look for in a PR

- **Scope**: does it do one thing well?
- **Tests**: are the new code paths covered?
- **Docs**: is the change documented?
- **Backwards compatibility**: does it break existing users? If yes,
  is there a migration path?
- **Performance**: does it introduce any hot-path regressions?

---

## Coding Style

- **2 spaces** indentation.
- **Double quotes** for strings.
- **Semicolons** always.
- **No semicolons on JSX-adjacent lines** if it causes visual noise.
- **`const` by default**, `let` only when reassigning. Never `var`.
- **Arrow functions** for callbacks, function declarations for top-level
  named functions.
- **JSDoc comments** for exported functions when the signature is not
  obvious.
- **File header comments** at the top of every module file (see
  existing modules for the format).

### Formatting

Prettier handles most of it:

```bash
npm run format        # write
npm run format:check  # verify
```

### Linting

```bash
npm run lint
npm run lint:fix
```

Rules of thumb:

- No unused variables. Prefix with `_` if intentional.
- No `console.log` in `src/`, only in `examples/` and `tests/`.
- Prefer `const` over `let` when possible.
- Use template literals instead of string concatenation.

---

## Testing

We use **Vitest** with **jsdom**.

### Structure

- One test file per module: `tests/<module>.test.js`.
- Pure utilities get dedicated tests: `tests/geometry.test.js`.
- Integration tests go in `tests/integration/`.
- React hooks are tested with `@testing-library/react`.

### Writing tests

```js
import { describe, it, expect, beforeEach } from "vitest";
import { WindowManager } from "../src/kernel/kernel.jsx";

describe("WindowManager", () => {
  let wm;

  beforeEach(() => {
    wm = new WindowManager({ viewport: { width: 1440, height: 900 } });
  });

  it("opens a window with default size", () => {
    const id = wm.open({ title: "Test" });
    const win = wm.getWindow(id);
    expect(win.width).toBe(720);
    expect(win.height).toBe(480);
  });

  it("focuses the most recently opened window", () => {
    const a = wm.open({ title: "A" });
    const b = wm.open({ title: "B" });
    expect(wm.getActive().id).toBe(b);
  });
});
```

### Coverage

We aim for **80% line coverage** in `src/`. Coverage is enforced
manually, not in CI (yet).

```bash
npm run test:coverage
```

---

## Documentation

When you change a public API, update:

- The JSDoc in the source file.
- `docs/API.md` with the new signature.
- `docs/EVENTS.md` if you add or change events.
- `README.md` if it changes the getting-started example.

Docs live in:

- `docs/ARCHITECTURE.md` — how the system is built.
- `docs/BOOT_SEQUENCE.md` — the boot timeline.
- `docs/WINDOW_MANAGER.md` — the window manager API.
- `docs/EVENTS.md` — every event emitted.
- `docs/API.md` — every class, provider, hook, constant and utility.

Write docs in **English**, using Markdown. Use fenced code blocks with
language tags (`js`, `jsx`, `bash`, `yaml`). Prefer tables for reference
data. Prefer diagrams in ASCII for flows.

---

## Release Process

Releases are made by maintainers. The process is:

1. **Update `CHANGELOG.md`** with the new version.
2. **Bump `package.json`** version.
3. **Commit**: `chore(release): v0.2.0`.
4. **Tag**: `git tag v0.2.0`.
5. **Push**: `git push origin main --tags`.
6. GitHub Actions runs `release.yml` and publishes to npm.
7. A GitHub Release is created automatically with generated notes.

We follow [Semantic Versioning](https://semver.org/):

- **MAJOR** for breaking changes.
- **MINOR** for new features, backwards compatible.
- **PATCH** for bug fixes, backwards compatible.

---

## Reporting Bugs

Open an issue using the **Bug report** template. Include:

- rainOS version.
- React version.
- Browser and OS.
- Minimal reproduction.
- Expected vs actual behavior.
- Console output / stack trace if any.

Before opening an issue:

- Search existing issues.
- Try the latest version.
- Try a fresh `node_modules`.

---

## Requesting Features

Open an issue using the **Feature request** template. Include:

- The problem you want to solve.
- A proposed solution.
- Alternatives you considered.
- Which module it affects.
- Example usage.

Features that touch the public API will require a discussion and possibly
an RFC (see the RFC template in `.github/ISSUE_TEMPLATE/`).

---

## Questions?

Open a GitHub Discussion or reach out in an issue.

Thanks for contributing!
