import { describe, expect, it, vi } from "vitest";
import { fitIfVisible } from "./fitIfVisible.js";

describe("fitIfVisible", () => {
  it("fits when the container has a real box", () => {
    const fit = vi.fn();
    expect(fitIfVisible({ offsetWidth: 800, offsetHeight: 600 }, { fit })).toBe(true);
    expect(fit).toHaveBeenCalledTimes(1);
  });

  // The regression this whole module exists for: a terminal in the hidden
  // view (Settings is open) measures zero, and fitting it shipped a
  // degenerate grid to the real pty — observed live as a shell stuck at
  // ~11 columns, prompt wrapped in half, typing no longer echoing.
  it("does NOT fit a container hidden by display:none (both dimensions zero)", () => {
    const fit = vi.fn();
    expect(fitIfVisible({ offsetWidth: 0, offsetHeight: 0 }, { fit })).toBe(false);
    expect(fit).not.toHaveBeenCalled();
  });

  // Either dimension alone being zero is still a meaningless fit — a
  // collapsed pane in the grid can be zero-width while keeping its height.
  it("does NOT fit when only the width is zero", () => {
    const fit = vi.fn();
    expect(fitIfVisible({ offsetWidth: 0, offsetHeight: 600 }, { fit })).toBe(false);
    expect(fit).not.toHaveBeenCalled();
  });

  it("does NOT fit when only the height is zero", () => {
    const fit = vi.fn();
    expect(fitIfVisible({ offsetWidth: 800, offsetHeight: 0 }, { fit })).toBe(false);
    expect(fit).not.toHaveBeenCalled();
  });

  // Becoming visible is itself a size change, so the ResizeObserver fires
  // and this is asked again with real numbers — the reason skipping a
  // hidden fit loses nothing rather than deferring a problem.
  it("fits on the next call once the container has been laid out", () => {
    const fit = vi.fn();
    const container = { offsetWidth: 0, offsetHeight: 0 };
    expect(fitIfVisible(container, { fit })).toBe(false);

    container.offsetWidth = 1200;
    container.offsetHeight = 800;
    expect(fitIfVisible(container, { fit })).toBe(true);
    expect(fit).toHaveBeenCalledTimes(1);
  });
});
