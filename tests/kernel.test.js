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

    it("restores a minimized window",
