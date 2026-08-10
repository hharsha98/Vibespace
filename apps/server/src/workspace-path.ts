/**
 * Validates and normalises a user-supplied `rootPath` before it's allowed
 * anywhere near `pty.spawn`'s `cwd` option. This is the one piece of
 * "untrusted input becomes a filesystem path" handling in the whole
 * workspaces feature, so it lives in its own small, easily-testable file
 * rather than being inlined into the route handlers in index.ts.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type ResolveRootPathResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Expands a leading `~` to the user's home directory (users will type
 * `~/projects/foo`, which no shell-less `fs` call understands on its own),
 * resolves the result to an absolute path, and verifies it names an
 * existing directory.
 */
export function resolveRootPath(input: unknown): ResolveRootPathResult {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, error: '"rootPath" must be a non-empty string' };
  }

  const trimmed = input.trim();
  const expanded =
    trimmed === "~"
      ? homedir()
      : trimmed.startsWith("~/")
        ? join(homedir(), trimmed.slice(2))
        : trimmed;

  const absolute = isAbsolute(expanded) ? expanded : resolve(expanded);

  if (!existsSync(absolute)) {
    return { ok: false, error: `Directory "${absolute}" does not exist` };
  }

  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    return { ok: false, error: `Could not read "${absolute}"` };
  }

  if (!stat.isDirectory()) {
    return { ok: false, error: `"${absolute}" exists but is not a directory` };
  }

  return { ok: true, path: absolute };
}
