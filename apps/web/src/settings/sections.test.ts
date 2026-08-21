import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  loadSettingsSection,
  nextRailIndex,
  saveSettingsSection,
} from "./sections.js";

// This repo's web package has no jsdom/testing-library dependency (see
// Settings.tsx's own top comment) — `window`/`localStorage` don't exist
// under vitest's default Node environment. A minimal in-memory stub, the
// same plain `getItem`/`setItem` shape `sections.ts` actually calls, is the
// DOM-free way to exercise the real "save, then reload, get the same
// value back" round trip that "persists across a remount" actually means
// at the mechanism level (there is no React tree to literally remount
// without jsdom, so this is what checking that promise looks like here).
function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SETTINGS_SECTIONS", () => {
  it("lists BridgeSpace's nine sections plus History, each with a unique id", () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "appearance",
      "terminal",
      "shortcuts",
      "agents",
      "history",
      "accounts",
      "api-keys",
      "billing",
      "notifications",
      "about",
    ]);
  });

  it("gives every section a non-empty label", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.label.length).toBeGreaterThan(0);
    }
  });
});

describe("loadSettingsSection / saveSettingsSection", () => {
  it("falls back to the default section when nothing is stored (no window)", () => {
    expect(loadSettingsSection()).toBe(DEFAULT_SETTINGS_SECTION);
  });

  it("persists a selection across a fresh load call — the localStorage round trip a remount relies on", () => {
    stubLocalStorage();
    saveSettingsSection("terminal");
    expect(loadSettingsSection()).toBe("terminal");
  });

  it("falls back to the default for a stale/unknown stored id", () => {
    stubLocalStorage();
    window.localStorage.setItem("vibedeck.settings.section", "not-a-real-section");
    expect(loadSettingsSection()).toBe(DEFAULT_SETTINGS_SECTION);
  });

  it("round-trips every real section id", () => {
    stubLocalStorage();
    for (const section of SETTINGS_SECTIONS) {
      saveSettingsSection(section.id);
      expect(loadSettingsSection()).toBe(section.id);
    }
  });
});

describe("nextRailIndex (rail keyboard navigation)", () => {
  const count = SETTINGS_SECTIONS.length;

  it("ArrowDown moves to the next index, wrapping past the end", () => {
    expect(nextRailIndex(0, "ArrowDown", count)).toBe(1);
    expect(nextRailIndex(count - 1, "ArrowDown", count)).toBe(0);
  });

  it("ArrowUp moves to the previous index, wrapping past the start", () => {
    expect(nextRailIndex(1, "ArrowUp", count)).toBe(0);
    expect(nextRailIndex(0, "ArrowUp", count)).toBe(count - 1);
  });

  it("Home jumps to the first index, End to the last", () => {
    expect(nextRailIndex(3, "Home", count)).toBe(0);
    expect(nextRailIndex(3, "End", count)).toBe(count - 1);
  });

  it("returns null for a key the rail doesn't handle, so callers fall through to default behaviour", () => {
    expect(nextRailIndex(0, "Tab", count)).toBeNull();
    expect(nextRailIndex(0, "a", count)).toBeNull();
  });

  it("returns null when there are no sections to navigate to", () => {
    expect(nextRailIndex(0, "ArrowDown", 0)).toBeNull();
  });
});
