/**
 * CRUD + path-safety tests for the memory store, run against a real temp
 * directory standing in for a workspace's `rootPath` — same `mkdtempSync`
 * pattern as `db/workspaces.test.ts`, except here the "database" IS the
 * filesystem, so there's no `VIBEDECK_DATA_DIR` to redirect.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as memory from "./store.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vibedeck-memory-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("list", () => {
  it("starts empty for a fresh workspace", () => {
    expect(memory.list(root)).toEqual([]);
  });

  it("lists every created note, alphabetically by title", () => {
    memory.create(root, { title: "Zebra note" });
    memory.create(root, { title: "Apple note" });
    const listed = memory.list(root);
    expect(listed.map((n) => n.title)).toEqual(["Apple note", "Zebra note"]);
  });
});

describe("create", () => {
  it("creates a note with a slug derived from the title", () => {
    const note = memory.create(root, { title: "Why the parser is recursive" });
    expect(note.slug).toBe("why-the-parser-is-recursive");
    expect(note.title).toBe("Why the parser is recursive");
    expect(note.tags).toEqual([]);
    expect(note.body).toBe("");
    expect(note.createdAt).toBe(note.updatedAt);
    expect(Number.isNaN(new Date(note.createdAt).getTime())).toBe(false);
  });

  it("accepts a body and tags", () => {
    const note = memory.create(root, { title: "With extras", body: "Some body text.", tags: ["a", "b"] });
    expect(note.body).toBe("Some body text.");
    expect(note.tags).toEqual(["a", "b"]);
  });

  it("lowercases and collapses non-alphanumerics into the slug", () => {
    const note = memory.create(root, { title: "  Weird!! Title__With   Spaces  " });
    expect(note.slug).toBe("weird-title-with-spaces");
  });

  it("falls back to a generic slug for a title with no alphanumeric characters", () => {
    const note = memory.create(root, { title: "???" });
    expect(note.slug).toBe("note");
  });

  it("guarantees slug uniqueness by suffixing -2, -3 on collision", () => {
    const first = memory.create(root, { title: "Duplicate title" });
    const second = memory.create(root, { title: "Duplicate title" });
    const third = memory.create(root, { title: "Duplicate title" });

    expect(first.slug).toBe("duplicate-title");
    expect(second.slug).toBe("duplicate-title-2");
    expect(third.slug).toBe("duplicate-title-3");
  });

  it("writes a real .md file under <root>/.vibedeck/memory/", () => {
    const note = memory.create(root, { title: "On disk", body: "Hello.", tags: ["x"] });
    const path = join(root, ".vibedeck", "memory", `${note.slug}.md`);
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("title: On disk");
    expect(raw).toContain("tags: [x]");
    expect(raw).toContain("Hello.");
  });
});

describe("get", () => {
  it("returns null for an unknown slug", () => {
    expect(memory.get(root, "does-not-exist")).toBeNull();
  });

  it("returns the note for a known slug", () => {
    const created = memory.create(root, { title: "Found me" });
    expect(memory.get(root, created.slug)).toEqual(created);
  });
});

describe("update", () => {
  it("returns null for an unknown slug", () => {
    expect(memory.update(root, "does-not-exist", { title: "x" })).toBeNull();
  });

  it("updates title/body/tags and bumps updatedAt, keeping the slug and createdAt", async () => {
    const created = memory.create(root, { title: "Old title" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = memory.update(root, created.slug, { title: "New title", body: "New body.", tags: ["z"] });

    expect(updated).not.toBeNull();
    expect(updated!.slug).toBe(created.slug); // slug is immutable — links stay valid
    expect(updated!.title).toBe("New title");
    expect(updated!.body).toBe("New body.");
    expect(updated!.tags).toEqual(["z"]);
    expect(updated!.createdAt).toBe(created.createdAt);
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThan(new Date(created.createdAt).getTime());
  });

  it("omitting a field leaves it untouched", () => {
    const created = memory.create(root, { title: "Partial update", body: "Original body.", tags: ["keep"] });
    const updated = memory.update(root, created.slug, { title: "Renamed only" });
    expect(updated!.body).toBe("Original body.");
    expect(updated!.tags).toEqual(["keep"]);
  });
});

describe("remove", () => {
  it("returns false for an unknown slug", () => {
    expect(memory.remove(root, "does-not-exist")).toBe(false);
  });

  it("deletes a note and returns true", () => {
    const created = memory.create(root, { title: "To delete" });
    expect(memory.remove(root, created.slug)).toBe(true);
    expect(memory.get(root, created.slug)).toBeNull();
    expect(memory.list(root)).toEqual([]);
  });
});

describe("malformed frontmatter on disk", () => {
  it("treats a file with no frontmatter block as body-only, deriving the title from the filename", () => {
    const dir = join(root, ".vibedeck", "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hand-written.md"), "Just plain text, no frontmatter at all.", "utf8");

    const note = memory.get(root, "hand-written");
    expect(note).not.toBeNull();
    expect(note!.title).toBe("hand-written"); // derived from the filename/slug, not thrown
    expect(note!.body).toBe("Just plain text, no frontmatter at all.");
    expect(note!.tags).toEqual([]);
  });

  it("does not throw when reading a malformed frontmatter block", () => {
    const dir = join(root, ".vibedeck", "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.md"), "---\ntitle: Unclosed block\nno closing delimiter here", "utf8");

    expect(() => memory.get(root, "broken")).not.toThrow();
  });
});

describe("path traversal via a crafted slug", () => {
  it("get() refuses to read outside .vibedeck/memory for a traversal slug", () => {
    expect(memory.get(root, "../../../etc/passwd")).toBeNull();
  });

  it("get() refuses an absolute-path slug", () => {
    expect(memory.get(root, "/etc/passwd")).toBeNull();
  });

  it("update() refuses a traversal slug (returns null, does not write outside the memory dir)", () => {
    const result = memory.update(root, "../../outside", { title: "pwned" });
    expect(result).toBeNull();
  });

  it("remove() refuses a traversal slug (returns false, does not touch anything outside)", () => {
    expect(memory.remove(root, "../../../outside")).toBe(false);
  });

  it("a traversal slug never actually creates a file outside .vibedeck/memory", () => {
    memory.get(root, "../../escaped");
    // Nothing should have been created one level above `root` either.
    expect(existsSync(join(root, "..", "escaped.md"))).toBe(false);
    expect(existsSync(join(root, "..", "escaped"))).toBe(false);
  });
});
