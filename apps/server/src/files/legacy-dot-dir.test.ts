/**
 * Tests for `migrateLegacyWorkspaceDotDir` — the lazy, per-workspace
 * `.vibedeck` -> `.vibespace` migration. Same `mkdtempSync` temp-directory
 * pattern as `memory/store.test.ts`, standing in for a workspace's
 * `rootPath`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyWorkspaceDotDir } from "./legacy-dot-dir.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vibespace-dotdir-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("migrateLegacyWorkspaceDotDir", () => {
  it("renames .vibedeck to .vibespace, carrying its contents across", () => {
    const legacyDir = join(root, ".vibedeck");
    mkdirSync(join(legacyDir, "memory"), { recursive: true });
    writeFileSync(join(legacyDir, "memory", "my-note.md"), "---\ntitle: My Note\n---\nBody.", "utf8");
    mkdirSync(join(legacyDir, "pastes"), { recursive: true });
    writeFileSync(join(legacyDir, "pastes", "paste-1.png"), "fake-image-bytes", "utf8");

    migrateLegacyWorkspaceDotDir(root);

    expect(existsSync(legacyDir)).toBe(false);
    const newDir = join(root, ".vibespace");
    expect(existsSync(join(newDir, "memory", "my-note.md"))).toBe(true);
    expect(readFileSync(join(newDir, "memory", "my-note.md"), "utf8")).toContain("My Note");
    expect(existsSync(join(newDir, "pastes", "paste-1.png"))).toBe(true);
  });

  it("no-ops when .vibespace already exists, even if .vibedeck also does", () => {
    const newDir = join(root, ".vibespace");
    const legacyDir = join(root, ".vibedeck");
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, "sentinel.txt"), "current", "utf8");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "old.txt"), "stale", "utf8");

    migrateLegacyWorkspaceDotDir(root);

    // Both directories untouched — .vibespace already won, so nothing
    // should be renamed or merged.
    expect(existsSync(join(newDir, "sentinel.txt"))).toBe(true);
    expect(existsSync(legacyDir)).toBe(true);
    expect(existsSync(join(legacyDir, "old.txt"))).toBe(true);
  });

  it("no-ops when neither directory exists", () => {
    expect(() => migrateLegacyWorkspaceDotDir(root)).not.toThrow();
    expect(existsSync(join(root, ".vibespace"))).toBe(false);
    expect(existsSync(join(root, ".vibedeck"))).toBe(false);
  });

  it("warns but never throws when the rename fails, leaving the legacy dir in place", async () => {
    const legacyDir = join(root, ".vibedeck");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "note.md"), "data that must survive", "utf8");

    // Node's ESM build of `node:fs` refuses `vi.spyOn` on a named export
    // directly ("Module namespace is not configurable in ESM") — same
    // constraint `db/data-dir-migration.test.ts` hits, which it works
    // around with an injectable `rename` parameter. This module's
    // signature is fixed by the phase spec (`(root: string): void`, no
    // extra parameter), so this one test instead mocks the whole `node:fs`
    // module via `vi.doMock` + a scoped dynamic re-import, undone
    // immediately after.
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        renameSync: () => {
          throw new Error("EACCES: permission denied");
        },
      };
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { migrateLegacyWorkspaceDotDir: migrateWithFailingRename } = await import("./legacy-dot-dir.js");

    expect(() => migrateWithFailingRename(root)).not.toThrow();
    expect(existsSync(legacyDir)).toBe(true);
    expect(existsSync(join(legacyDir, "note.md"))).toBe(true); // data untouched
    expect(existsSync(join(root, ".vibespace"))).toBe(false);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0][0]).toContain(legacyDir);

    vi.doUnmock("node:fs");
    vi.resetModules();
  });
});
