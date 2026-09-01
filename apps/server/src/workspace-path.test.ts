import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRootPath } from "./workspace-path.js";

describe("resolveRootPath", () => {
  it("rejects a non-string input", () => {
    const result = resolveRootPath(undefined);
    expect(result.ok).toBe(false);
  });

  it("rejects an empty or whitespace-only string", () => {
    expect(resolveRootPath("").ok).toBe(false);
    expect(resolveRootPath("   ").ok).toBe(false);
  });

  it("rejects a path that doesn't exist", () => {
    const result = resolveRootPath("/definitely/does/not/exist/vibespace-test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("does not exist");
    }
  });

  it("rejects a path that exists but is a file, not a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "vibespace-path-test-"));
    const filePath = join(dir, "not-a-directory.txt");
    writeFileSync(filePath, "hello");

    const result = resolveRootPath(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not a directory");
    }
  });

  it("accepts an existing absolute directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "vibespace-path-test-"));
    const result = resolveRootPath(dir);
    expect(result).toEqual({ ok: true, path: dir });
  });

  it("expands a leading ~ to the home directory", () => {
    const result = resolveRootPath("~");
    expect(result).toEqual({ ok: true, path: homedir() });
  });

  it("trims surrounding whitespace before resolving", () => {
    const dir = mkdtempSync(join(tmpdir(), "vibespace-path-test-"));
    const result = resolveRootPath(`  ${dir}  `);
    expect(result).toEqual({ ok: true, path: dir });
  });
});
