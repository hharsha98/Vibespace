import { describe, expect, it } from "vitest";
import { isCopyShortcut } from "./copyShortcut.js";

/** Base "nothing held, no selection, on Mac" input — every test overrides
 * just the fields it cares about, so each case reads as a diff from a
 * known-neutral starting point. */
const base = {
  key: "c",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  hasSelection: false,
  isMac: true,
};

describe("isCopyShortcut", () => {
  it("Mac: Cmd+C with a selection copies", () => {
    expect(isCopyShortcut({ ...base, metaKey: true, hasSelection: true })).toBe(true);
  });

  it("Mac: Cmd+C with NO selection does not copy (stays a no-op, not an interrupt either)", () => {
    expect(isCopyShortcut({ ...base, metaKey: true, hasSelection: false })).toBe(false);
  });

  it("Mac: bare Ctrl+C (no Cmd) never copies, even with a selection — must stay the interrupt chord", () => {
    expect(isCopyShortcut({ ...base, ctrlKey: true, hasSelection: true })).toBe(false);
  });

  it("non-Mac: Ctrl+C with a selection copies", () => {
    expect(isCopyShortcut({ ...base, isMac: false, ctrlKey: true, hasSelection: true })).toBe(true);
  });

  it("non-Mac: Ctrl+C with NO selection does not copy — must fall through as the interrupt signal", () => {
    expect(isCopyShortcut({ ...base, isMac: false, ctrlKey: true, hasSelection: false })).toBe(false);
  });

  it("non-Mac: Cmd/Meta+C (no Ctrl) never copies", () => {
    expect(isCopyShortcut({ ...base, isMac: false, metaKey: true, hasSelection: true })).toBe(false);
  });

  it("Shift held alongside the copy modifier is refused, even with a selection", () => {
    expect(isCopyShortcut({ ...base, metaKey: true, shiftKey: true, hasSelection: true })).toBe(false);
  });

  it("Alt/Option held alongside the copy modifier is refused, even with a selection", () => {
    expect(isCopyShortcut({ ...base, metaKey: true, altKey: true, hasSelection: true })).toBe(false);
  });

  it("a different key entirely (Cmd+V) never copies", () => {
    expect(isCopyShortcut({ ...base, key: "v", metaKey: true, hasSelection: true })).toBe(false);
  });

  it("key comparison is case-insensitive", () => {
    expect(isCopyShortcut({ ...base, key: "C", metaKey: true, hasSelection: true })).toBe(true);
  });
});
