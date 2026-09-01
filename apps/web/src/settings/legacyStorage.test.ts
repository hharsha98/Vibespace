import { afterEach, describe, expect, it, vi } from "vitest";
import { readWithLegacyFallback } from "./legacyStorage.js";

// Same DOM-free localStorage stub as terminalPrefs.test.ts/sections.test.ts
// — see those files' comments for why this repo's web package needs one at
// all (no jsdom). `removeItem` is included here (those two files' original
// stubs didn't need it) because `readWithLegacyFallback` removes the
// legacy key after migrating it forward.
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

/** A stub whose every method throws — simulating private-browsing Safari,
 * which throws on ANY localStorage access, not just writes (see
 * `legacyStorage.ts`'s own top comment). */
function stubThrowingLocalStorage() {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: () => {
        throw new Error("SecurityError: access denied");
      },
      setItem: () => {
        throw new Error("SecurityError: access denied");
      },
      removeItem: () => {
        throw new Error("SecurityError: access denied");
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readWithLegacyFallback", () => {
  it("returns null when there's no window (SSR/Node)", () => {
    expect(readWithLegacyFallback("new.key", "old.key")).toBeNull();
  });

  it("returns null when neither key has a value", () => {
    stubLocalStorage();
    expect(readWithLegacyFallback("new.key", "old.key")).toBeNull();
  });

  it("returns the new key's value directly when it's present, without touching the legacy key", () => {
    const store = stubLocalStorage();
    store.set("new.key", "current-value");
    store.set("old.key", "stale-value");

    expect(readWithLegacyFallback("new.key", "old.key")).toBe("current-value");
    // The legacy key is left alone — the new key already won, so there's
    // nothing to migrate.
    expect(store.get("old.key")).toBe("stale-value");
  });

  it("falls back to the legacy key's value when the new key is unset, and migrates it forward", () => {
    const store = stubLocalStorage();
    store.set("old.key", "legacy-value");

    const result = readWithLegacyFallback("new.key", "old.key");

    expect(result).toBe("legacy-value");
    expect(store.get("new.key")).toBe("legacy-value");
    expect(store.has("old.key")).toBe(false);
  });

  it("only migrates once — a second call reads the new key directly", () => {
    const store = stubLocalStorage();
    store.set("old.key", "legacy-value");

    readWithLegacyFallback("new.key", "old.key");
    store.set("new.key", "changed-after-migration");
    const second = readWithLegacyFallback("new.key", "old.key");

    expect(second).toBe("changed-after-migration");
  });

  it("returns null and never throws when localStorage throws on every access (private-browsing Safari)", () => {
    stubThrowingLocalStorage();
    expect(() => readWithLegacyFallback("new.key", "old.key")).not.toThrow();
    expect(readWithLegacyFallback("new.key", "old.key")).toBeNull();
  });
});
