// ============================================================================
// tests/kernel.test.js — WindowManager class
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import {
  WindowManager,
  WINDOW_STATE,
  Z_BASE,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
  kernelBus,
  KERNEL_EVENTS,
} from "../src/kernel/kernel.jsx";

const VIEWPORT = { width: 1440, height: 900 };

describe("WindowManager", () => {
  let wm;

  beforeEach(() => {
    wm = new WindowManager({ viewport: VIEWPORT });
    kernelBus.clear();
  });

  // -------------------------------------------------------------------- open
  describe("open", () => {
    it("opens a window with default size", () => {
      const id = wm.open({ title: "Test" });
      const win = wm.getWindow(id);
      expect(win.width).toBe(DEFAULT_WIDTH);
      expect(win.height).toBe(DEFAULT_HEIGHT);
    });

    it("opens a window with custom size", () => {
      const id = wm.open({ title: "Test", width: 400, height: 300 });
      const win = wm.getWindow(id);
      expect(win.width).toBe(400);
      expect(win.height).toBe(300);
    });

    it("opens a window with custom position", () => {
      const id = wm.open({ title: "Test", x: 50, y: 100 });
      const win = wm.getWindow(id);
      expect(win.x).toBe(50);
      expect(win.y).toBe(100);
    });

    it("focuses the newly opened window", () => {
      const a = wm.open({ title: "A" });
      const b = wm.open({ title: "B" });
      expect(wm.getActive().id).toBe(b);
      expect(wm.getActive().id).not.toBe(a);
    });

    it("emits window:opened", () => {
      let payload = null;
      kernelBus.on(KERNEL_EVENTS.WINDOW_OPENED, (p) => {
        payload = p;
      });
      const id = wm.open({ title: "Test" });
      expect(payload).not.toBeNull();
      expect(payload.id).toBe(id);
    });

    it("respects flags", () => {
      const id = wm.open({
        title: "Test",
        resizable: false,
        closable: false,
      });
      const win = wm.getWindow(id);
      expect(win.flags.resizable).toBe(false);
      expect(win.flags.closable).toBe(false);
      expect(win.flags.minimizable).toBe(true);
    });
  });

  // ------------------------------------------------------------------- close
  describe("close", () => {
    it("closes an existing window", () => {
      const id = wm.open({ title: "Test" });
      expect(wm.close(id)).toBe(true);
      expect(wm.getWindow(id)).toBeNull();
    });

    it("returns false for a non-existent window", () => {
      expect(wm.close(999)).toBe(false);
    });

    it("refuses to close a non-closable window", () => {
      const id = wm.open({ title: "Test", closable: false });
      expect(wm.close(id)).toBe(false);
    });

    it("passes focus to the previous window", () => {
      const a = wm.open({ title: "A" });
      const b = wm.open({ title: "B" });
      wm.close(b);
      expect(wm.getActive().id).toBe(a);
    });

    it("emits window:closed", () => {
      let called = false;
      kernelBus.on(KERNEL_EVENTS.WINDOW_CLOSED, () => {
        called = true;
      });
      const id = wm.open({ title: "Test" });
      wm.close(id);
      expect(called).toBe(true);
    });
  });

  // ------------------------------------------------------------------- focus
  describe("focus", () => {
    it("moves focus to the requested window", () => {
      const a = wm.open({ title: "A" });
      const b = wm.open({ title: "B" });
      wm.focus(a);
      expect(wm.getActive().id).toBe(a);
    });

    it("reassigns z-index based on focus stack", () => {
      const a = wm.open({ title: "A" });
      const b = wm.open({ title: "B" });
      const zA = wm.getWindow(a).zIndex;
      const zB = wm.getWindow(b).zIndex;
      expect(zB).toBeGreaterThan(zA);
    });

    it("focusNext cycles forward", () => {
      const a = wm.open({ title: "A" });
      const b = wm.open({ title: "B" });
      const c = wm.open({ title: "C" });
      wm.focusNext();
      expect(wm.getActive().id).toBe(a);
      wm.focusNext();
      expect(wm.getActive().id).toBe(b);
      wm.focusNext();
      expect(wm.getActive().id).toBe(c);
    });

    it("focusPrev cycles backward", () => {
      const a = wm.open({ title: "A" });
      const b = wm.open({ title: "B" });
      const c = wm.open({ title: "C" });
      wm.focusPrev();
      expect(wm.getActive().id).toBe(b);
      wm.focusPrev();
      expect(wm.getActive().id).toBe(a);
      wm.focusPrev();
      expect(wm.getActive().id).toBe(c);
    });
  });

  // -------------------------------------------------------------------- move
  describe("move", () => {
    it("moves a window", () => {
      const id = wm.open({ title: "Test" });
      wm.move(id, 300, 400);
      const win = wm.getWindow(id);
      expect(win.x).toBe(300);
      expect(win.y).toBe(400);
    });

    it("clamps y to TOP_RESERVED", () => {
      const id = wm.open({ title: "Test" });
      wm.move(id, 300, -1000);
      expect(wm.getWindow(id).y).toBe(TOP_RESERVED);
    });

    it("does not move a maximized window", () => {
      const id = wm.open({ title: "Test" });
      wm.toggleMaximize(id);
      const before = wm.getWindow(id);
      wm.move(id, 500, 500);
      const after = wm.getWindow(id);
      expect(after.x).toBe(before.x);
      expect(after.y).toBe(before.y);
    });
  });

  // ------------------------------------------------------------------ resize
  describe("resize", () => {
    it("resizes from se", () => {
      const id = wm.open({ title: "Test", width: 500, height: 400 });
      wm.resize(id, "se", 100, 50);
      const win = wm.getWindow(id);
      expect(win.width).toBe(600);
      expect(win.height).toBe(450);
    });

    it("enforces minimum width", () => {
      const id = wm.open({ title: "Test", width: 500, height: 400 });
      wm.resize(id, "e", -10000, 0);
      expect(wm.getWindow(id).width).toBe(MIN_WIDTH);
    });

    it("enforces minimum height", () => {
      const id = wm.open({ title: "Test", width: 500, height: 400 });
      wm.resize(id, "s", 0, -10000);
      expect(wm.getWindow(id).height).toBe(MIN_HEIGHT);
    });

    it("refuses to resize a non-resizable window", () => {
      const id = wm.open({ title: "Test", resizable: false });
      const before = wm.getWindow(id).width;
      wm.resize(id, "e", 100, 0);
      expect(wm.getWindow(id).width).toBe(before);
    });
  });

  // --------------------------------------------------------------- minimize
  describe("minimize and restore", () => {
    it("minimizes a window", () => {
      const id = wm.open({ title: "Test" });
      wm.minimize(id);
      expect(wm.getWindow(id).state).toBe(WINDOW_STATE.MINIMIZED);
    });

    it("restores a minimized window", () => {
      const id = wm.open({ title: "Test", x: 100, y: 200 });
      wm.minimize(id);
      wm.restore(id);
      const win = wm.getWindow(id);
      expect(win.state).toBe(WINDOW_STATE.NORMAL);
      expect(win.x).toBe(100);
      expect(win.y).toBe(200);
    });

    it("removes the window from the focus stack when minimized", () => {
      const id = wm.open({ title: "Test" });
      wm.minimize(id);
      expect(wm.getActive()).toBeNull();
    });

    it("toggleMinimize flips the state", () => {
      const id = wm.open({ title: "Test" });
      wm.toggleMinimize(id);
      expect(wm.getWindow(id).state).toBe(WINDOW_STATE.MINIMIZED);
      wm.toggleMinimize(id);
      expect(wm.getWindow(id).state).toBe(WINDOW_STATE.NORMAL);
    });
  });

  // -------------------------------------------------------------- maximize
  describe("toggleMaximize", () => {
    it("maximizes a window", () => {
      const id = wm.open({ title: "Test" });
      wm.toggleMaximize(id);
      const win = wm.getWindow(id);
      expect(win.state).toBe(WINDOW_STATE.MAXIMIZED);
      expect(win.width).toBe(VIEWPORT.width);
      expect(win.y).toBe(TOP_RESERVED);
    });

    it("restores the previous size when toggled back", () => {
      const id = wm.open({ title: "Test", width: 500, height: 400 });
      wm.toggleMaximize(id);
      wm.toggleMaximize(id);
      const win = wm.getWindow(id);
      expect(win.width).toBe(500);
      expect(win.height).toBe(400);
    });
  });

  // ------------------------------------------------------------- fullscreen
  describe("toggleFullscreen", () => {
    it("goes fullscreen", () => {
      const id = wm.open({ title: "Test" });
      wm.toggleFullscreen(id);
      const win = wm.getWindow(id);
      expect(win.state).toBe(WINDOW_STATE.FULLSCREEN);
      expect(win.width).toBe(VIEWPORT.width);
      expect(win.height).toBe(VIEWPORT.height);
      expect(win.x).toBe(0);
      expect(win.y).toBe(0);
    });
  });

  // -------------------------------------------------------------- hit test
  describe("hitTest", () => {
    it("returns the topmost window under a point", () => {
      const a = wm.open({ title: "A", x: 0, y: 0, width: 500, height: 500 });
      const b = wm.open({
        title: "B",
        x: 300,
        y: 300,
        width: 500,
        height: 500,
      });
      // Point inside both windows: topmost is B (focused last)
      expect(wm.hitTest(350, 350)).toBe(b);
      // Point only inside A
      expect(wm.hitTest(50, 50)).toBe(a);
    });

    it("ignores minimized windows", () => {
      const id = wm.open({ title: "Test", x: 0, y: 0 });
      wm.minimize(id);
      expect(wm.hitTest(100, 100)).toBeNull();
    });

    it("returns null when nothing is under the point", () => {
      wm.open({ title: "Test", x: 0, y: 0, width: 100, height: 100 });
      expect(wm.hitTest(500, 500)).toBeNull();
    });
  });

  // ------------------------------------------------------------ viewport
  describe("setViewport", () => {
    it("reflows windows to fit the new viewport", () => {
      const id = wm.open({
        title: "Test",
        x: VIEWPORT.width - 100,
        y: 200,
        width: 500,
        height: 400,
      });
      wm.setViewport({ width: 800, height: 600 });
      const win = wm.getWindow(id);
      expect(win.x).toBeLessThanOrEqual(800);
    });
  });

  // ------------------------------------------------------------- persistence
  describe("serialize and hydrate", () => {
    it("round-trips a window list", () => {
      const a = wm.open({ title: "A", width: 500, height: 400 });
      const b = wm.open({ title: "B", x: 100, y: 100 });
      const json = wm.serialize();

      const wm2 = new WindowManager({ viewport: VIEWPORT });
      wm2.hydrate(json);

      const winA = wm2.getWindow(a);
      const winB = wm2.getWindow(b);
      expect(winA.title).toBe("A");
      expect(winA.width).toBe(500);
      expect(winB.title).toBe("B");
      expect(winB.x).toBe(100);
    });

    it("preserves the active window", () => {
      const a = wm.open({ title: "A" });
      const b = wm.open({ title: "B" });
      wm.focus(a);
      const json = wm.serialize();

      const wm2 = new WindowManager({ viewport: VIEWPORT });
      wm2.hydrate(json);
      expect(wm2.getActive().id).toBe(a);
    });
  });

  // ---------------------------------------------------------------- queries
  describe("queries", () => {
    it("getByApp returns only matching windows", () => {
      wm.open({ title: "A", appId: "app-a" });
      wm.open({ title: "B", appId: "app-b" });
      wm.open({ title: "C", appId: "app-a" });
      expect(wm.getByApp("app-a")).toHaveLength(2);
      expect(wm.getByApp("app-b")).toHaveLength(1);
    });

    it("getVisibleWindows excludes minimized", () => {
      const a = wm.open({ title: "A" });
      const b = wm.open({ title: "B" });
      wm.minimize(a);
      expect(wm.getVisibleWindows()).toHaveLength(1);
      expect(wm.getVisibleWindows()[0].id).toBe(b);
    });

    it("getMinimizedWindows returns only minimized", () => {
      const a = wm.open({ title: "A" });
      wm.open({ title: "B" });
      wm.minimize(a);
      expect(wm.getMinimizedWindows()).toHaveLength(1);
      expect(wm.getMinimizedWindows()[0].id).toBe(a);
    });

    it("count returns the number of windows", () => {
      wm.open({ title: "A" });
      wm.open({ title: "B" });
      expect(wm.count()).toBe(2);
    });

    it("has returns true for existing windows", () => {
      const id = wm.open({ title: "Test" });
      expect(wm.has(id)).toBe(true);
      expect(wm.has(9999)).toBe(false);
    });
  });

  // --------------------------------------------------------------- metadata
  describe("metadata", () => {
    it("stores and retrieves metadata", () => {
      const id = wm.open({ title: "Test" });
      wm.setMetadata(id, { tag: "beta" });
      expect(wm.getMetadata(id)).toEqual({ tag: "beta" });
    });

    it("returns null for non-existent metadata", () => {
      expect(wm.getMetadata(9999)).toBeNull();
    });
  });

  // ----------------------------------------------------------------- batch
  describe("batch", () => {
    it("notifies subscribers only once per batch", () => {
      let calls = 0;
      wm.subscribe(() => calls++);
      wm.batch(() => {
        wm.open({ title: "A" });
        wm.open({ title: "B" });
        wm.open({ title: "C" });
      });
      expect(calls).toBe(1);
    });
  });
});
