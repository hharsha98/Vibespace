/**
 * Tests for the vibedeck -> vibespace back-compat logic in `schema.ts`:
 * `resolveDataDir`'s full resolution order (including the one-time
 * directory migration and its failure path) and `resolveDbFilename`'s
 * fallback to the legacy `.db` name. Every path used here is a fresh
 * `mkdtempSync` temp directory — `resolveDataDir`/`resolveDbFilename` are
 * pure functions that take paths as arguments rather than reading
 * `homedir()`/`process.env` themselves (see schema.ts's own comment on
 * `resolveDataDir`), so this file never touches a real `~/.vibespace` or
 * `~/.vibedeck`, unlike `getDataDir()` itself which this file does not
 * call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDataDir, resolveDbFilename } from "./schema.js";

let root: string;
let target: string;
let legacy: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vibespace-data-dir-test-"));
  target = join(root, ".vibespace");
  legacy = join(root, ".vibedeck");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("resolveDataDir", () => {
  it("uses VIBESPACE_DATA_DIR verbatim and never migrates, even if a legacy dir exists", () => {
    mkdirSync(legacy, { recursive: true });
    const override = join(root, "explicit-override");

    const result = resolveDataDir({ vibespaceDataDir: override, vibedeckDataDir: undefined, target, legacy });

    expect(result).toBe(override);
    expect(existsSync(legacy)).toBe(true); // untouched
    expect(existsSync(target)).toBe(false);
  });

  it("uses VIBEDECK_DATA_DIR verbatim when VIBESPACE_DATA_DIR is unset, and never migrates", () => {
    mkdirSync(legacy, { recursive: true });
    const override = join(root, "explicit-legacy-override");

    const result = resolveDataDir({ vibespaceDataDir: undefined, vibedeckDataDir: override, target, legacy });

    expect(result).toBe(override);
    expect(existsSync(legacy)).toBe(true); // untouched
  });

  it("prefers VIBESPACE_DATA_DIR over VIBEDECK_DATA_DIR when both are set", () => {
    const spaceOverride = join(root, "space-override");
    const deckOverride = join(root, "deck-override");

    const result = resolveDataDir({
      vibespaceDataDir: spaceOverride,
      vibedeckDataDir: deckOverride,
      target,
      legacy,
    });

    expect(result).toBe(spaceOverride);
  });

  it("returns target as-is when it already exists, even if a legacy dir also exists", () => {
    mkdirSync(target, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "vibedeck.db"), "legacy data", "utf8");

    const result = resolveDataDir({ vibespaceDataDir: undefined, vibedeckDataDir: undefined, target, legacy });

    expect(result).toBe(target);
    expect(existsSync(legacy)).toBe(true); // left alone — target already won
  });

  it("returns target for a fresh install with neither directory present", () => {
    const result = resolveDataDir({ vibespaceDataDir: undefined, vibedeckDataDir: undefined, target, legacy });

    expect(result).toBe(target);
    expect(existsSync(target)).toBe(false); // resolveDataDir itself never creates it
  });

  it("migrates a real legacy directory (with its db file) to target on first run", () => {
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "vibedeck.db"), "real workspace data", "utf8");
    writeFileSync(join(legacy, "other-file.txt"), "sentinel", "utf8");

    const result = resolveDataDir({ vibespaceDataDir: undefined, vibedeckDataDir: undefined, target, legacy });

    expect(result).toBe(target);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(target, "vibespace.db"))).toBe(true);
    expect(existsSync(join(target, "other-file.txt"))).toBe(true);
    // The old-named file was renamed away, not merely copied alongside.
    expect(existsSync(join(target, "vibedeck.db"))).toBe(false);
  });

  it("does not rename vibedeck.db -> vibespace.db if vibespace.db somehow already exists", () => {
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "vibedeck.db"), "old", "utf8");
    writeFileSync(join(legacy, "vibespace.db"), "already renamed by hand", "utf8");

    resolveDataDir({ vibespaceDataDir: undefined, vibedeckDataDir: undefined, target, legacy });

    // Directory migration still happens; the file-level rename is skipped
    // because vibespace.db was already present, so both files survive
    // untouched inside the migrated directory.
    expect(existsSync(join(target, "vibedeck.db"))).toBe(true);
    expect(existsSync(join(target, "vibespace.db"))).toBe(true);
  });

  it("is a no-op the second time it's called after a successful migration", () => {
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "vibedeck.db"), "data", "utf8");

    resolveDataDir({ vibespaceDataDir: undefined, vibedeckDataDir: undefined, target, legacy });
    const secondResult = resolveDataDir({ vibespaceDataDir: undefined, vibedeckDataDir: undefined, target, legacy });

    expect(secondResult).toBe(target);
  });

  it("falls back to the legacy directory in place, without throwing, if the directory rename fails", () => {
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "vibedeck.db"), "data that must survive", "utf8");

    // Node's ESM build of `node:fs` refuses `vi.spyOn` on a named export
    // ("Module namespace is not configurable in ESM") — `resolveDataDir`'s
    // injectable `rename` parameter (see its own doc comment) is how this
    // codebase already solves that same problem for `exists` in
    // runtime-config.ts's `resolveStaticDir`.
    const failingRename = vi.fn(() => {
      throw new Error("EACCES: permission denied");
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    let result: string | undefined;
    expect(() => {
      result = resolveDataDir({
        vibespaceDataDir: undefined,
        vibedeckDataDir: undefined,
        target,
        legacy,
        rename: failingRename,
      });
    }).not.toThrow();

    expect(result).toBe(legacy);
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(join(legacy, "vibedeck.db"))).toBe(true); // data untouched
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0][0]).toContain(legacy);
    expect(stderrSpy.mock.calls[0][0]).toContain(target);
  });

  it("keeps target as the result, and warns but doesn't throw, when the directory rename succeeds but the db-file rename fails", () => {
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "vibedeck.db"), "data", "utf8");

    // Let the directory-level rename (legacy -> target) succeed for real,
    // but fail the second call (the .db file rename inside target) — same
    // injectable-`rename` approach as the test above.
    const partiallyFailingRename = vi.fn((from: string, to: string) => {
      if (from.endsWith("vibedeck.db")) {
        throw new Error("EPERM: operation not permitted");
      }
      renameSync(from, to);
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = resolveDataDir({
      vibespaceDataDir: undefined,
      vibedeckDataDir: undefined,
      target,
      legacy,
      rename: partiallyFailingRename,
    });

    expect(result).toBe(target); // directory migration DID succeed
    expect(existsSync(join(target, "vibedeck.db"))).toBe(true); // old name survives
    expect(existsSync(join(target, "vibespace.db"))).toBe(false);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });
});

describe("resolveDbFilename", () => {
  it("prefers vibespace.db when it exists", () => {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "vibespace.db"), "new", "utf8");

    expect(resolveDbFilename(target)).toBe("vibespace.db");
  });

  it("falls back to vibedeck.db when vibespace.db is absent but vibedeck.db is present", () => {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "vibedeck.db"), "old", "utf8");

    expect(resolveDbFilename(target)).toBe("vibedeck.db");
  });

  it("defaults to vibespace.db when neither file exists yet (brand-new database)", () => {
    mkdirSync(target, { recursive: true });

    expect(resolveDbFilename(target)).toBe("vibespace.db");
  });

  it("prefers vibespace.db when both files exist", () => {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "vibespace.db"), "new", "utf8");
    writeFileSync(join(target, "vibedeck.db"), "old", "utf8");

    expect(resolveDbFilename(target)).toBe("vibespace.db");
  });
});
