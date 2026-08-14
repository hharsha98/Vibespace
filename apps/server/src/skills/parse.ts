/**
 * Hand-rolled parser for a `SKILL.md` file's frontmatter + body, per the
 * open `agentskills.io` specification (see `docs/SKILLS.md` and
 * `docs/RESEARCH.md` §4 for why this phase implements THAT standard rather
 * than inventing a private one). Deliberately NOT a real YAML parser, same
 * decision `../memory/frontmatter.ts` made and for the same reason: a
 * `js-yaml` dependency is overkill for a shape this small — flat scalars
 * (`name`, `description`, `license`, `compatibility`, `allowed-tools`) plus
 * exactly ONE nested string->string map (`metadata`). This file follows
 * `frontmatter.ts`'s block-splitting approach almost line for line; read
 * that file's top comment first if this one is unclear.
 *
 * --- Lenient validation, per the spec's own client guide ---
 * A `SKILL.md` in the wild was very possibly authored for a DIFFERENT
 * client (Claude Code, some other agentskills.io-compatible tool), so this
 * parser never throws and is deliberately forgiving about anything that
 * doesn't actually break the ONE thing that matters — being able to show a
 * skill's name/description so an agent can decide whether to read further
 * ("progressive disclosure"). Two different failure classes:
 *
 *   SKIP (skill not loaded, `skill: null`, an "error" diagnostic):
 *     - frontmatter block missing or unparseable
 *     - `description` missing or empty (it's *the* field progressive
 *       disclosure depends on — a skill with no description is not
 *       discoverable, so there is nothing useful to load)
 *
 *   WARN (skill loads anyway, a "warning" diagnostic explains what's odd):
 *     - `name` doesn't match its parent directory
 *     - `name` is empty (falls back to the directory name), too long, or
 *       uses characters outside `a-z0-9-`
 *     - `description`/`compatibility` exceed the spec's length ceilings
 *
 * --- The malformed-YAML fallback ---
 * The single most common real-world breakage: an unquoted value containing
 * its own colon, e.g. `description: Use this skill when: the user asks
 * about PDFs`. Splitting each line at its FIRST `:` (not last, not "parse
 * real YAML scalars") means that value comes through whole rather than
 * getting truncated at the inner colon — exactly `frontmatter.ts`'s own
 * `line.indexOf(":")` approach, carried over unchanged. See parse.test.ts's
 * "unquoted colon in description" case.
 */

export type SkillDiagnosticLevel = "warning" | "error";

export interface SkillDiagnostic {
  level: SkillDiagnosticLevel;
  message: string;
}

/** A successfully-loaded skill's frontmatter + body. Every optional spec
 * field that was absent comes back `null` (never an empty string) so
 * callers can tell "not provided" from "provided but empty" — same
 * convention `ParsedFrontmatter` uses in `../memory/frontmatter.ts`. */
export interface ParsedSkill {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  /** The `metadata:` nested map, flattened to string->string. Empty object
   * (never null) when the field was absent — a map has no meaningful
   * "missing" state distinct from "empty" the way a scalar field does. */
  metadata: Record<string, string>;
  /** The raw `allowed-tools` value verbatim (a space-separated string, per
   * the spec) — this parser does not split it into an array; that's a
   * presentation decision left to callers, since the spec itself calls the
   * field "experimental" and doesn't pin its exact consumption shape. */
  allowedTools: string | null;
  /** Everything after the closing `---` line, verbatim. */
  body: string;
}

export interface SkillParseResult {
  /** `null` when the skill was SKIPPED — see this file's top comment for
   * exactly which failures skip vs. warn. `diagnostics` explains why. */
  skill: ParsedSkill | null;
  diagnostics: SkillDiagnostic[];
}

// Same shape as memory/frontmatter.ts's FRONTMATTER_RE: a line that is
// exactly "---", the block (lazily, so it stops at the FIRST closing "---"
// rather than the last one anywhere in the body), a closing "---" line,
// then everything else is the body.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// Lowercase a-z/0-9 segments joined by single hyphens: rejects an empty
// name, uppercase, underscores, leading/trailing hyphens, AND consecutive
// hyphens all in one regex — "a--b" fails to match because the segment
// between the two hyphens is empty, and `+` requires at least one character
// per segment.
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const NAME_MAX_LENGTH = 64;
const DESCRIPTION_MAX_LENGTH = 1024;
const COMPATIBILITY_MAX_LENGTH = 500;

/** Strips one layer of matching `"..."` or `'...'` quotes, if present.
 * Real YAML would need this for values authors quote to escape leading
 * whitespace, a literal `#`, etc — cheap to support, and does no harm on
 * the (far more common) unquoted case. */
function stripMatchingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Splits one line at its FIRST `:` into a trimmed key/value pair — the
 * malformed-YAML fallback this file's top comment describes. Returns null
 * for a line with no colon at all (ignored by the caller, same as
 * `frontmatter.ts`'s `colonIndex === -1` case) or an empty key. */
function splitKeyValue(line: string): { key: string; value: string } | null {
  const idx = line.indexOf(":");
  if (idx === -1) return null;
  const key = line.slice(0, idx).trim();
  if (key.length === 0) return null;
  return { key, value: stripMatchingQuotes(line.slice(idx + 1).trim()) };
}

function leadingWhitespaceLength(line: string): number {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].length : 0;
}

/**
 * Parses the raw frontmatter block into its flat fields plus the one
 * nested `metadata` map. A top-level line (no leading whitespace) is a
 * `key: value` pair UNLESS `key` is `metadata`, in which case every
 * following indented line (until indentation returns to zero, or the block
 * ends) is consumed as one metadata entry instead. An indented line
 * encountered with no preceding `metadata:` key to belong to is orphaned
 * input — ignored rather than thrown on, per this module's whole "never
 * throw on malformed input" contract.
 */
function parseBlock(block: string): { fields: Record<string, string>; metadata: Record<string, string> } {
  const fields: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  const lines = block.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().length === 0) {
      i++;
      continue;
    }
    if (leadingWhitespaceLength(line) > 0) {
      // Orphaned indented line — ignore.
      i++;
      continue;
    }

    const kv = splitKeyValue(line);
    if (!kv) {
      i++;
      continue;
    }

    if (kv.key === "metadata") {
      i++;
      while (i < lines.length && (lines[i].trim().length === 0 || leadingWhitespaceLength(lines[i]) > 0)) {
        const nested = lines[i].trim().length > 0 ? splitKeyValue(lines[i].trim()) : null;
        if (nested) metadata[nested.key] = nested.value;
        i++;
      }
      continue;
    }

    fields[kv.key] = kv.value;
    i++;
  }

  return { fields, metadata };
}

/**
 * Parses one `SKILL.md` file's raw contents. `dirName` is the name of the
 * directory the file lives in — needed both to check "does `name` match
 * its parent directory" and as the fallback value when `name` is missing
 * entirely (an empty/absent name is still recoverable: the directory name
 * IS the intended identity, per the spec's own "should match" convention).
 * Never throws.
 */
export function parseSkill(raw: string, dirName: string): SkillParseResult {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return {
      skill: null,
      diagnostics: [{ level: "error", message: "No valid --- frontmatter block found; skipping." }],
    };
  }

  const [, block, body] = match;
  const { fields, metadata } = parseBlock(block);
  const diagnostics: SkillDiagnostic[] = [];

  // description: required, non-empty — the one field progressive
  // disclosure depends on, so a missing/empty one skips the whole skill
  // rather than warning and loading it anyway.
  const description = fields.description ?? "";
  if (description.trim().length === 0) {
    return {
      skill: null,
      diagnostics: [
        { level: "error", message: '"description" is missing or empty; skipping (it is required for disclosure).' },
      ],
    };
  }
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    diagnostics.push({
      level: "warning",
      message: `"description" is ${description.length} characters, over the spec's ${DESCRIPTION_MAX_LENGTH}-character limit; loading it anyway.`,
    });
  }

  // name: required by the spec, but recoverable when absent (falls back to
  // the directory name) — everything else about it only ever warns.
  let name = (fields.name ?? "").trim();
  if (name.length === 0) {
    diagnostics.push({
      level: "warning",
      message: `"name" is missing; using the directory name "${dirName}" instead.`,
    });
    name = dirName;
  } else {
    if (name !== dirName) {
      diagnostics.push({
        level: "warning",
        message: `"name" ("${name}") does not match its parent directory ("${dirName}"); loading it anyway.`,
      });
    }
    if (name.length > NAME_MAX_LENGTH) {
      diagnostics.push({
        level: "warning",
        message: `"name" is ${name.length} characters, over the spec's ${NAME_MAX_LENGTH}-character limit; loading it anyway.`,
      });
    }
    if (!NAME_RE.test(name)) {
      diagnostics.push({
        level: "warning",
        message: `"name" ("${name}") must be lowercase a-z, 0-9, and single hyphens only (no leading/trailing or double hyphens); loading it anyway.`,
      });
    }
  }

  const compatibility = fields.compatibility && fields.compatibility.trim().length > 0 ? fields.compatibility : null;
  if (compatibility && compatibility.length > COMPATIBILITY_MAX_LENGTH) {
    diagnostics.push({
      level: "warning",
      message: `"compatibility" is ${compatibility.length} characters, over the spec's ${COMPATIBILITY_MAX_LENGTH}-character limit; loading it anyway.`,
    });
  }

  const skill: ParsedSkill = {
    name,
    description,
    license: fields.license && fields.license.trim().length > 0 ? fields.license : null,
    compatibility,
    metadata,
    allowedTools: fields["allowed-tools"] && fields["allowed-tools"].trim().length > 0 ? fields["allowed-tools"] : null,
    body,
  };

  return { skill, diagnostics };
}
