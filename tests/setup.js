// ============================================================================
// tests/setup.js — Global test setup
// ============================================================================

import { afterEach, beforeEach, vi } from "vitest";

// Reset localStorage between tests
beforeEach(() => {
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// Silence console.warn/error during tests (opt-in to see them)
if (process.env.SILENCE_LOGS !== "1") {
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args) => {
    if (process.env.SHOW_WARNINGS === "1") origWarn(...args);
  };
  console.error = (...args) => {
    if (process.env.SHOW_ERRORS === "1") origError(...args);
  };
}
