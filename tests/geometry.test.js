// ============================================================================
// tests/geometry.test.js — Geometry utilities
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  clamp,
  clampToViewport,
  constrainResize,
  applySnap,
  cascadePosition,
  rectsIntersect,
  pointInRect,
  MIN_WIDTH,
  MIN_HEIGHT,
  TOP_RESERVED,
  SNAP_THRESHOLD,
  CASCADE_STEP,
  CASCADE_WRAP,
} from "../src/kernel/kernel.jsx";

const VIEWPORT = { width: 1440, height: 900 };

describe("clamp", () => {
  it("returns the value when inside range", () => {
    expect(clamp(50, 0, 100)).toBe(50);
  });

  it("returns min when value is below", () => {
    expect(clamp(-10, 0, 100)).toBe(0);
  });

  it("returns max when value is above", () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });

  it("handles min === max", () => {
    expect(clamp(50, 10, 10)).toBe(10);
  });
});

describe("clampToViewport", () => {
  it("returns the same position when inside the viewport", () => {
    const pos = clampToViewport(100, 200, 800, 600, VIEWPORT);
    expect(pos).toEqual({ x: 100, y: 200 });
  });

  it("clamps y to TOP_RESERVED", () => {
    const pos = clampToViewport(100, -50, 800, 600, VIEWPORT);
    expect(pos.y).toBe(TOP_RESERVED);
  });

  it("keeps 80px of the window visible horizontally on the left", () => {
    const pos = clampToViewport(-5000, 200, 800, 600, VIEWPORT);
    expect(pos.x).toBe(80 - 800);
  });

  it("keeps 80px of the window visible horizontally on the right", () => {
    const pos = clampToViewport(5000, 200, 800, 600, VIEWPORT);
    expect(pos.x).toBe(VIEWPORT.width - 80);
  });
});

describe("constrainResize", () => {
  const base = { x: 100, y: 100, width: 600, height: 400 };

  it("resizes from the east direction", () => {
    const rect = constrainResize(base, "e", 50, 0);
    expect(rect).toEqual({ x: 100, y: 100, width: 650, height: 400 });
  });

  it("resizes from the south direction", () => {
    const rect = constrainResize(base, "s", 0, 30);
    expect(rect).toEqual({ x: 100, y: 100, width: 600, height: 430 });
  });

  it("resizes from the west without moving below MIN_WIDTH", () => {
    const rect = constrainResize(base, "w", 10000, 0);
    expect(rect.width).toBe(MIN_WIDTH);
    expect(rect.x).toBe(base.x + base.width - MIN_WIDTH);
  });

  it("resizes from the north without moving below MIN_HEIGHT", () => {
    const rect = constrainResize(base, "n", 0, 10000);
    expect(rect.height).toBe(MIN_HEIGHT);
    expect(rect.y).toBe(base.y + base.height - MIN_HEIGHT);
  });

  it("does not let the window go above TOP_RESERVED", () => {
    const rect = constrainResize(base, "n", 0, -10000);
    expect(rect.y).toBe(TOP_RESERVED);
  });
});

describe("applySnap", () => {
  it("snaps to the left edge", () => {
    const snapped = applySnap(
      SNAP_THRESHOLD - 1,
      100,
      800,
      600,
      VIEWPORT
    );
    expect(snapped.x).toBe(0);
  });

  it("snaps to the right edge", () => {
    const x = VIEWPORT.width - 800 - (SNAP_THRESHOLD - 1);
    const snapped = applySnap(x, 100, 800, 600, VIEWPORT);
    expect(snapped.x).toBe(VIEWPORT.width - 800);
  });

  it("snaps to TOP_RESERVED", () => {
    const snapped = applySnap(100, TOP_RESERVED + 4, 800, 600, VIEWPORT);
    expect(snapped.y).toBe(TOP_RESERVED);
  });

  it("does not snap when far from edges", () => {
    const snapped = applySnap(500, 500, 800, 600, VIEWPORT);
    expect(snapped).toEqual({ x: 500, y: 500 });
  });
});

describe("cascadePosition", () => {
  it("offsets each window by CASCADE_STEP", () => {
    const a = cascadePosition(0, VIEWPORT, 720, 480);
    const b = cascadePosition(1, VIEWPORT, 720, 480);
    expect(b.x - a.x).toBe(CASCADE_STEP);
    expect(b.y - a.y).toBe(CASCADE_STEP);
  });

  it("wraps every CASCADE_WRAP windows", () => {
    const a = cascadePosition(0, VIEWPORT, 720, 480);
    const b = cascadePosition(CASCADE_WRAP, VIEWPORT, 720, 480);
    expect(b.x).toBe(a.x);
    expect(b.y).toBe(a.y);
  });
});

describe("rectsIntersect", () => {
  it("returns true for overlapping rects", () => {
    const a = { x: 0, y: 0, width: 100, height: 100 };
    const b = { x: 50, y: 50, width: 100, height: 100 };
    expect(rectsIntersect(a, b)).toBe(true);
  });

  it("returns false for disjoint rects", () => {
    const a = { x: 0, y: 0, width: 100, height: 100 };
    const b = { x: 200, y: 200, width: 100, height: 100 };
    expect(rectsIntersect(a, b)).toBe(false);
  });

  it("treats touching edges as non-overlapping", () => {
    const a = { x: 0, y: 0, width: 100, height: 100 };
    const b = { x: 100, y: 0, width: 100, height: 100 };
    expect(rectsIntersect(a, b)).toBe(false);
  });
});

describe("pointInRect", () => {
  const rect = { x: 100, y: 100, width: 200, height: 200 };

  it("returns true for a point inside", () => {
    expect(pointInRect(150, 150, rect)).toBe(true);
  });

  it("returns true for the top-left corner", () => {
    expect(pointInRect(100, 100, rect)).toBe(true);
  });

  it("returns true for the bottom-right corner", () => {
    expect(pointInRect(300, 300, rect)).toBe(true);
  });

  it("returns false for a point outside", () => {
    expect(pointInRect(50, 50, rect)).toBe(false);
  });
});
