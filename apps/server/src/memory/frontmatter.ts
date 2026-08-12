/**
 * A tiny, hand-rolled parser/serializer for the YAML-ish frontmatter block
 * at the top of a memory note (see store.ts's top comment for the file
 * format). Deliberately NOT a real YAML parser — a `js-yaml` dependency
 * would be massive overkill for four flat fields (`title`, `tags`,
 * `created`, `updated`) that vibedeck itself always writes in exactly the
 * same shape, and pulling one in was explicitly ruled out by this phase's
 * spec. This file is the whole of that decision: a well-tested regex split
 * plus a few line parsers, nothing more.
 *
 * Frontmatter block shape (see frontmatter.test.ts for exact examples):
 *
 *   ---
 *   title: Why the parser is recursive
 *   tags: [parser, design]
 *   created: 2026-01-01T00:00:00.000Z
 *   updated: 2026-01-01T00:00:00.000Z
 *   ---
 *   Body text with [[other-note]] links.
 */

/** What `parseFrontmatter` returns. Every field is `null` (or `[]` for
 * `tags`) when the block is missing/malformed — callers (store.ts) decide
 * what to fall back to (e.g. deriving a title from the filename), this
 * module never throws and never invents a value it didn't actually read. */
export interface ParsedFrontmatter {
  title: string | null;
  tags: string[];
  created: string | null;
  updated: string | null;
  /** Everything after the closing `---` line, verbatim — or, if there was
   * no valid frontmatter block at all, the ENTIRE input (see the top
   * comment: malformed frontmatter degrades to "whole file is the body",
   * never a thrown error). */
  body: string;
}

// Matches a frontmatter block at the very start of the file: a line that is
// exactly "---", one or more lines of key: value pairs, a closing line that
// is exactly "---", then everything else is the body. `[\s\S]*?` (not `.*`)
// so the block can span multiple lines while still matching lazily (stops
// at the FIRST closing "---" line, not the last one anywhere in the body).
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parses a `tags:` value into a string array. Supports the bracketed form
 * vibedeck itself writes (`[parser, design]`, or `[]` for no tags) and,
 * defensively, a single bare word with no brackets — anything else parses
 * to an empty list rather than throwing, per this module's "never throw on
 * malformed input" contract. */
function parseTagsValue(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return inner
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
  }
  return trimmed.length > 0 ? [trimmed] : [];
}

/**
 * Parses `raw` (a whole `.md` file's contents) into its frontmatter fields
 * plus body. If the file doesn't start with a well-formed `---`-delimited
 * block, the whole input is treated as the body and every field comes back
 * null/empty — this is the "malformed frontmatter never throws" contract
 * store.ts's `get()` relies on.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { title: null, tags: [], created: null, updated: null, body: raw };
  }

  const [, block, body] = match;
  const fields: Record<string, string> = {};
  let tags: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue; // Not a "key: value" line — ignore rather than throw.
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key === "tags") {
      tags = parseTagsValue(value);
    } else if (key.length > 0) {
      fields[key] = value;
    }
  }

  return {
    title: fields.title ?? null,
    tags,
    created: fields.created ?? null,
    updated: fields.updated ?? null,
    body,
  };
}

/** The frontmatter fields `serializeFrontmatter` needs — always fully
 * populated (unlike `ParsedFrontmatter`, whose fields are optional to
 * account for a malformed read) since this is only ever called with a note
 * store.ts has already filled in every field of. */
export interface FrontmatterFields {
  title: string;
  tags: string[];
  created: string;
  updated: string;
}

/**
 * Renders `fields` + `body` back into the on-disk file format. Round-trips
 * with `parseFrontmatter`: `parseFrontmatter(serializeFrontmatter(f, b))`
 * always reproduces `f`/`b` exactly (see frontmatter.test.ts).
 */
export function serializeFrontmatter(fields: FrontmatterFields, body: string): string {
  const lines = [
    "---",
    `title: ${fields.title}`,
    `tags: [${fields.tags.join(", ")}]`,
    `created: ${fields.created}`,
    `updated: ${fields.updated}`,
    "---",
  ];
  return `${lines.join("\n")}\n${body}`;
}
