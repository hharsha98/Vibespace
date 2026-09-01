import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TERMINAL_PREFS,
  clampFontSize,
  clampScrollback,
  loadTerminalPrefs,
  saveTerminalPrefs,
} from "./terminalPrefs.js";

// Same DOM-free localStorage stub as sections.test.ts — see that file's
// comment for why this repo's web package needs one at all (no jsdom).
// `removeItem` is needed on top of the original getItem/setItem shape
// because `loadTerminalPrefs` now goes through `readWithLegacyFallback`
// (legacyStorage.ts), which removes the legacy key once it's migrated.
function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DEFAULT_TERMINAL_PREFS", () => {
  it("matches the values Terminal.tsx hardcoded before this preference existed", () => {
    // Guards against silently re-colouring/resizing every existing
    // terminal the moment this file starts being read, before anyone has
    // ever opened Settings and changed anything.
    expect(DEFAULT_TERMINAL_PREFS).toEqual({
      fontSize: 13,
      cursorStyle: "block",
      cursorBlink: true,
      scrollback: 10000,
    });
  });
});

describe("loadTerminalPrefs / saveTerminalPrefs", () => {
  it("returns the defaults when nothing is stored (no window)", () => {
    expect(loadTerminalPrefs()).toEqual(DEFAULT_TERMINAL_PREFS);
  });

  it("round-trips a saved preference set", () => {
    stubLocalStorage();
    const prefs = { fontSize: 16, cursorStyle: "bar" as const, cursorBlink: false, scrollback: 5000 };
    saveTerminalPrefs(prefs);
    expect(loadTerminalPrefs()).toEqual(prefs);
  });

  it("falls back to defaults for a corrupt (non-JSON) stored blob", () => {
    stubLocalStorage();
    window.localStorage.setItem("vibespace.terminalPrefs", "{not json");
    expect(loadTerminalPrefs()).toEqual(DEFAULT_TERMINAL_PREFS);
  });

  it("merges a partial/older-version blob onto the defaults instead of discarding it entirely", () => {
    stubLocalStorage();
    window.localStorage.setItem("vibespace.terminalPrefs", JSON.stringify({ fontSize: 18 }));
    expect(loadTerminalPrefs()).toEqual({ ...DEFAULT_TERMINAL_PREFS, fontSize: 18 });
  });

  it("ignores an invalid cursorStyle value rather than trusting it verbatim", () => {
    stubLocalStorage();
    window.localStorage.setItem("vibespace.terminalPrefs", JSON.stringify({ cursorStyle: "not-a-real-style" }));
    expect(loadTerminalPrefs().cursorStyle).toBe(DEFAULT_TERMINAL_PREFS.cursorStyle);
  });

  it("falls back to a legacy vibedeck.terminalPrefs blob when the new key is unset, and migrates it forward", () => {
    const store = stubLocalStorage();
    const legacyPrefs = { fontSize: 20, cursorStyle: "underline" as const, cursorBlink: false, scrollback: 2000 };
    store.set("vibedeck.terminalPrefs", JSON.stringify(legacyPrefs));

    expect(loadTerminalPrefs()).toEqual(legacyPrefs);
    // The migration actually happened, not just a lucky read.
    expect(store.get("vibespace.terminalPrefs")).toBe(JSON.stringify(legacyPrefs));
    expect(store.has("vibedeck.terminalPrefs")).toBe(false);
  });
});

describe("clampFontSize / clampScrollback", () => {
  it("clamps font size into the sane range", () => {
    expect(clampFontSize(1)).toBeGreaterThanOrEqual(9);
    expect(clampFontSize(999)).toBeLessThanOrEqual(24);
    expect(clampFontSize(13)).toBe(13);
  });

  it("clamps scrollback into the sane range", () => {
    expect(clampScrollback(0)).toBeGreaterThanOrEqual(500);
    expect(clampScrollback(1_000_000)).toBeLessThanOrEqual(100_000);
    expect(clampScrollback(10000)).toBe(10000);
  });
});
