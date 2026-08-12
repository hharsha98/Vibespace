/**
 * MemoryStore: Phase 8's memory is deliberately NOT a database — it's plain
 * markdown files on disk at `<workspace>/.vibedeck/memory/<slug>.md`, so
 * notes live next to the code, are readable without vibedeck at all (any
 * editor, `cat`, `grep`), and can be committed to git along with the
 * project. This module is the only place that reads/writes those files;
 * routes.ts and mcp.ts both go through it rather than touching `fs`
 * directly, same "one place owns the shape" rule as `WorkspaceStore`/
 * `BoardStore` in `../db/`.
 *
 * Every function takes `root` — a workspace's `rootPath` (already resolved
 * and trusted, exactly like `files/routes.ts`'s `workspace.rootPath`) — as
 * its first argument, and resolves slugs against `<root>/.vibedeck/memory`
 * via `safeResolve` (see `../files/safe-path.ts`). Slugs are ALWAYS
 * client-supplied (a URL param, an MCP tool argument) — resolving against
 * the memory directory itself, not the workspace root, means a crafted
 * slug like `"../../../etc/passwd"` can escape at most as far as somewhere
 * inside `.vibedeck/memory`, and `safeResolve`'s own containment check
 * rejects even that. See store.test.ts's "path traversal" tests.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryNote } from "@vibedeck/shared";
import { safeResolve } from "../files/safe-path.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";

/** Workspace-relative directory every memory note lives under. */
export const MEMORY_DIR_NAME = ".vibedeck/memory";

/**
 * Ensures `<root>/.vibedeck/memory` exists and returns its absolute path.
 * `safeResolve` requires an existing, real (symlink-resolvable) directory
 * to realpath against (see safe-path.ts's top comment) — creating it
 * up-front, on every call, means a brand-new workspace that has never had a
 * note written to it still works for `list()` (empty) without a separate
 * "has this workspace's memory dir been initialized yet?" check anywhere.
 */
function ensureMemoryDir(root: string): string {
  const dir = join(root, MEMORY_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Lowercases, collapses runs of non-alphanumeric characters to a single
 * "-", and trims leading/trailing "-". A title that's ALL non-alphanumeric
 * (e.g. "???", or an empty string) falls back to "note" rather than
 * producing an empty slug. */
function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "note";
}

/** Every slug that already has a `.md` file in `memoryDir` — just the
 * filenames, minus the extension. Used both to pick a collision-free slug
 * on create and (by routes.ts/mcp.ts, via `list`) to build the link graph. */
function listSlugs(memoryDir: string): string[] {
  if (!existsSync(memoryDir)) return [];
  return readdirSync(memoryDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -".md".length));
}

/** `slugify(title)`, suffixed with `-2`, `-3`, ... until it doesn't collide
 * with an existing note. The base slug itself (no suffix) is used if it's
 * free — most titles, most of the time. */
function uniqueSlug(memoryDir: string, title: string): string {
  const base = slugify(title);
  const existing = new Set(listSlugs(memoryDir));
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Reads and parses one note by slug, or `null` if the slug resolves outside
 * `.vibedeck/memory` (a path-traversal attempt) or the file doesn't exist.
 * A malformed/missing frontmatter block never throws — `parseFrontmatter`
 * degrades to "whole file is the body", and this function falls back to
 * the slug itself as the title (the "derived from the filename" the phase
 * spec calls for — the slug already IS the filename, minus `.md`).
 */
function readNote(memoryDir: string, slug: string): MemoryNote | null {
  const resolved = safeResolve(memoryDir, `${slug}.md`);
  if (!resolved.ok) return null;
  if (!existsSync(resolved.path)) return null;

  const raw = readFileSync(resolved.path, "utf8");
  const parsed = parseFrontmatter(raw);
  // A file with no valid `created`/`updated` frontmatter (e.g. one dropped
  // in by hand, or a malformed block) still needs SOME timestamp rather
  // than `null` — MemoryNote's contract is that these are always real ISO
  // strings. Falling back to the epoch is an honest "we don't actually
  // know" value rather than inventing "now" for a file that may be years
  // old.
  const fallback = new Date(0).toISOString();
  return {
    slug,
    title: parsed.title ?? slug,
    tags: parsed.tags,
    body: parsed.body,
    createdAt: parsed.created ?? fallback,
    updatedAt: parsed.updated ?? parsed.created ?? fallback,
  };
}

/** Writes `note` to `<memoryDir>/<note.slug>.md`. Throws only if `slug`
 * itself can't be resolved safely — which should never happen for a slug
 * this module generated itself (`create`) or already validated (`update`),
 * since both paths only ever call this with a slug that already round-
 * tripped through `safeResolve` via `readNote`/`uniqueSlug`. */
function writeNoteFile(memoryDir: string, note: MemoryNote): void {
  const resolved = safeResolve(memoryDir, `${note.slug}.md`);
  if (!resolved.ok) {
    throw new Error(`Refusing to write note "${note.slug}": ${resolved.error}`);
  }
  const content = serializeFrontmatter(
    { title: note.title, tags: note.tags, created: note.createdAt, updated: note.updatedAt },
    note.body
  );
  writeFileSync(resolved.path, content, "utf8");
}

/** Every note in the workspace, sorted alphabetically by title (a stable,
 * predictable order for the Memory tab's list — see docs/DESIGN.md's list
 * row spec). */
export function list(root: string): MemoryNote[] {
  const dir = ensureMemoryDir(root);
  return listSlugs(dir)
    .map((slug) => readNote(dir, slug))
    .filter((note): note is MemoryNote => note !== null)
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** One note by slug, or `null` if it doesn't exist (including a crafted
 * slug that would escape `.vibedeck/memory` — see the top comment). */
export function get(root: string, slug: string): MemoryNote | null {
  const dir = ensureMemoryDir(root);
  return readNote(dir, slug);
}

export interface CreateNoteOptions {
  title: string;
  body?: string;
  tags?: string[];
}

/** Creates a new note, deriving a unique slug from `title` (see
 * `uniqueSlug`). Always succeeds — there is no "slug already taken" error
 * path a caller needs to handle, unlike e.g. a database unique-constraint
 * violation. */
export function create(root: string, options: CreateNoteOptions): MemoryNote {
  const dir = ensureMemoryDir(root);
  const slug = uniqueSlug(dir, options.title);
  const now = new Date().toISOString();
  const note: MemoryNote = {
    slug,
    title: options.title,
    tags: options.tags ?? [],
    body: options.body ?? "",
    createdAt: now,
    updatedAt: now,
  };
  writeNoteFile(dir, note);
  return note;
}

export interface UpdateNoteOptions {
  title?: string;
  body?: string;
  tags?: string[];
}

/**
 * Updates a note's title/body/tags, bumping `updatedAt`. Returns `null` if
 * `slug` doesn't exist. The slug itself never changes on update, even if
 * `title` does — slugs are what `[[wikilinks]]` and backlinks are keyed on
 * (see MemoryNote's doc comment in protocol.ts), so renaming a note's title
 * must never silently break every link pointing at it.
 */
export function update(root: string, slug: string, patch: UpdateNoteOptions): MemoryNote | null {
  const dir = ensureMemoryDir(root);
  const existing = readNote(dir, slug);
  if (!existing) return null;

  const updated: MemoryNote = {
    ...existing,
    title: patch.title ?? existing.title,
    body: patch.body ?? existing.body,
    tags: patch.tags ?? existing.tags,
    updatedAt: new Date().toISOString(),
  };
  writeNoteFile(dir, updated);
  return updated;
}

/** True if a note with this slug existed and was deleted. A crafted slug
 * that would resolve outside `.vibedeck/memory` returns `false`, same as
 * "doesn't exist" — it never gets close enough to `unlinkSync` to matter. */
export function remove(root: string, slug: string): boolean {
  const dir = ensureMemoryDir(root);
  const resolved = safeResolve(dir, `${slug}.md`);
  if (!resolved.ok || !existsSync(resolved.path)) return false;
  unlinkSync(resolved.path);
  return true;
}
