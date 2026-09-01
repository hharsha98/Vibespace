/**
 * The most important test file in Phase 6. `safeResolve` is the ONLY thing
 * standing between a client-supplied file path and the real filesystem —
 * every case here corresponds to a real published path-traversal technique.
 * All temp dirs are created fresh per test (via `mkdtempSync`) and removed
 * afterward; nothing here ever touches a developer's real home directory.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { isProbablyBinary, safeResolve } from "./safe-path.js";

const cleanupDirs: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "vibespace-safe-path-"));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("safeResolve — legitimate paths", () => {
  it("allows a simple file at the root", () => {
    const root = makeRoot();
    writeFileSync(join(root, "README.md"), "hello");
    const result = safeResolve(root, "README.md");
    expect(result).toEqual({ ok: true, path: join(root, "README.md") });
  });

  it("allows a legitimate nested path that exists", () => {
    const root = makeRoot();
    mkdirSync(join(root, "src", "components"), { recursive: true });
    writeFileSync(join(root, "src", "components", "App.tsx"), "export {}");
    const result = safeResolve(root, "src/components/App.tsx");
    expect(result).toEqual({ ok: true, path: join(root, "src", "components", "App.tsx") });
  });

  it("allows a legitimate nested path that does NOT exist yet (e.g. a new file being created via PUT)", () => {
    const root = makeRoot();
    mkdirSync(join(root, "src"));
    const result = safeResolve(root, "src/new-file.ts");
    expect(result).toEqual({ ok: true, path: join(root, "src", "new-file.ts") });
  });

  it("allows the root itself (empty-ish relative path resolving to '.')", () => {
    const root = makeRoot();
    const result = safeResolve(root, ".");
    expect(result).toEqual({ ok: true, path: root });
  });
});

describe("safeResolve — textual traversal", () => {
  it("rejects ../../etc/passwd", () => {
    const root = makeRoot();
    const result = safeResolve(root, "../../etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("escapes the workspace root");
  });

  it("rejects a path with embedded .. in the middle that still nets outside root", () => {
    const root = makeRoot();
    mkdirSync(join(root, "foo"));
    // "foo/../../etc/passwd" collapses to one level ABOVE root, then into
    // /etc/passwd — must be rejected even though it starts inside root.
    const result = safeResolve(root, "foo/../../etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("escapes the workspace root");
  });

  it("rejects a URL-decoded traversal string (the literal decoded form of ..%2F..%2Fetc)", () => {
    // By the time a query-string value reaches our handler, the framework
    // has already URI-decoded it — "..%2F..%2Fetc%2Fpasswd" becomes exactly
    // this literal string. safeResolve must reject it the same way it
    // rejects the un-encoded form above.
    const root = makeRoot();
    const decoded = decodeURIComponent("..%2F..%2Fetc%2Fpasswd");
    const result = safeResolve(root, decoded);
    expect(result.ok).toBe(false);
  });

  it("rejects a bare '..' one level up", () => {
    const root = makeRoot();
    const result = safeResolve(root, "..");
    expect(result.ok).toBe(false);
  });

  it("rejects a sibling directory that merely shares root's name as a prefix (the startsWith trap)", () => {
    // Regression guard for the classic bug: naively checking
    // candidate.startsWith(root) (without the trailing separator) would let
    // "/tmp/vibespace-safe-path-XXXX-evil" pass as "inside"
    // "/tmp/vibespace-safe-path-XXXX". Build exactly that sibling and make
    // sure a traversal into it is still rejected.
    const root = makeRoot();
    const evilSibling = `${root}-evil`;
    mkdirSync(evilSibling);
    cleanupDirs.push(evilSibling);
    writeFileSync(join(evilSibling, "secret.txt"), "nope");

    // Relative path that walks up out of root and into the sibling by name.
    const rootBase = root.split(sep).pop()!;
    const relPath = `../${rootBase}-evil/secret.txt`;
    const result = safeResolve(root, relPath);
    expect(result.ok).toBe(false);
  });
});

describe("safeResolve — absolute paths", () => {
  it("rejects an absolute path outright, even one that happens to point inside root", () => {
    const root = makeRoot();
    writeFileSync(join(root, "inside.txt"), "hi");
    const result = safeResolve(root, join(root, "inside.txt"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Absolute paths");
  });

  it("rejects /etc/passwd", () => {
    const root = makeRoot();
    const result = safeResolve(root, "/etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Absolute paths");
  });
});

describe("safeResolve — symlink escapes", () => {
  it("rejects a symlink that lives inside the workspace but points outside it", () => {
    const root = makeRoot();
    const outside = makeRoot(); // a second, unrelated temp dir — the "secret" target
    writeFileSync(join(outside, "secret.txt"), "top secret");

    const linkPath = join(root, "escape-hatch");
    symlinkSync(outside, linkPath, "dir");

    // Textually, "escape-hatch/secret.txt" resolves to somewhere under
    // root — it's only once the symlink is followed that it turns out to
    // point at `outside`. This is exactly the case check #1 alone would miss.
    const result = safeResolve(root, "escape-hatch/secret.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("escapes the workspace root");
  });

  it("rejects a symlinked FILE (not just a directory) pointing outside the workspace", () => {
    const root = makeRoot();
    const outside = makeRoot();
    writeFileSync(join(outside, "target.txt"), "outside content");

    const linkPath = join(root, "link.txt");
    symlinkSync(join(outside, "target.txt"), linkPath, "file");

    const result = safeResolve(root, "link.txt");
    expect(result.ok).toBe(false);
  });

  it("still allows a symlink that points to a legitimate location INSIDE the workspace", () => {
    const root = makeRoot();
    mkdirSync(join(root, "real-dir"));
    writeFileSync(join(root, "real-dir", "file.txt"), "fine");
    symlinkSync(join(root, "real-dir"), join(root, "alias"), "dir");

    const result = safeResolve(root, "alias/file.txt");
    expect(result.ok).toBe(true);
  });
});

describe("safeResolve — malformed input", () => {
  it("rejects a non-string path", () => {
    const root = makeRoot();
    expect(safeResolve(root, undefined).ok).toBe(false);
    expect(safeResolve(root, 42).ok).toBe(false);
    expect(safeResolve(root, null).ok).toBe(false);
  });

  it("rejects an empty string", () => {
    const root = makeRoot();
    expect(safeResolve(root, "").ok).toBe(false);
  });
});

describe("isProbablyBinary", () => {
  it("returns false for plain text", () => {
    expect(isProbablyBinary(Buffer.from("hello, world\nsecond line\n", "utf8"))).toBe(false);
  });

  it("returns true when a NUL byte appears in the first 8KB", () => {
    const buf = Buffer.concat([Buffer.from("PNG"), Buffer.from([0x00, 0x01, 0x02])]);
    expect(isProbablyBinary(buf)).toBe(true);
  });

  it("ignores a NUL byte past the first 8KB", () => {
    const text = Buffer.from("a".repeat(8192), "utf8");
    const withLateNul = Buffer.concat([text, Buffer.from([0x00])]);
    expect(isProbablyBinary(withLateNul)).toBe(false);
  });

  it("returns false for an empty buffer", () => {
    expect(isProbablyBinary(Buffer.alloc(0))).toBe(false);
  });
});
