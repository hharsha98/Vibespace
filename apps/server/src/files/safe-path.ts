/**
 * The ONE place in vibedeck that turns a client-supplied, workspace-relative
 * file path into a real, absolute filesystem path safe to hand to `fs`
 * calls. Every file route in `apps/server/src/files/routes.ts` — tree
 * listing, read, write, watch — MUST go through `safeResolve` here rather
 * than rolling its own `path.resolve`. This repo is public, and a file
 * endpoint that reads/writes based on a client-supplied path is a textbook
 * path-traversal surface if it's ever gotten wrong even once.
 *
 * Two escapes are defended against, in order:
 *
 *  1. **Textual traversal** — `../../etc/passwd`, `foo/../../etc/passwd`,
 *     a client sending an absolute path outright. `path.resolve(root, rel)`
 *     collapses every `..` segment the same way it always does, so the
 *     result either lands inside `root` or it doesn't; we just have to
 *     actually check which, which is the part naive code skips.
 *
 *  2. **Symlink escape** — a symlink that LIVES inside the workspace (so it
 *     passes check #1 with a perfectly innocent-looking relative path, e.g.
 *     "escape-hatch/secret.txt") but POINTS somewhere outside it (e.g.
 *     `/etc`, or another user's home directory). `fs.realpathSync` follows
 *     symlinks to their real target; only after doing that can containment
 *     be checked honestly. This needs its own handling because the target
 *     file may not exist yet (a `PUT` creating a brand-new file) — you can't
 *     `realpathSync` something that isn't there — so we realpath the
 *     longest EXISTING ancestor directory and re-append whatever tail
 *     doesn't exist yet (which, not existing, can't itself be a symlink).
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export type SafeResolveResult = { ok: true; path: string } | { ok: false; error: string };

/** True if `candidate` is exactly `root`, or a real descendant of it —
 * i.e. NOT the classic `"/home/alice-evil".startsWith("/home/alice")` bug,
 * which is why this compares against `root + path.sep`, not bare `root`. */
function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Resolves `p` to its real (symlink-free) path by realpath-ing the longest
 * prefix of `p` that actually exists on disk, then re-joining whatever
 * trailing segments don't exist yet. Those trailing segments can't be
 * symlinks (a symlink is a filesystem entry; something that doesn't exist
 * has no entry to be one), so this is safe even for a not-yet-created file.
 */
function realpathOfClosestExisting(p: string): string {
  let current = p;
  const nonExistentTail: string[] = [];

  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      // Walked all the way to the filesystem root ("/") and found nothing —
      // shouldn't happen in practice (the workspace root itself must exist),
      // but bail out rather than loop forever.
      break;
    }
    nonExistentTail.unshift(basename(current));
    current = parent;
  }

  const real = realpathSync(current);
  return nonExistentTail.length > 0 ? join(real, ...nonExistentTail) : real;
}

/**
 * Resolves a client-supplied `relPath` against a workspace's `root`
 * (already an absolute, real path on disk), returning the absolute path IF
 * it's genuinely inside `root` — following symlinks to their real target
 * before making that call — or an error otherwise.
 *
 * `root` itself is trusted (it always comes from `WorkspaceStore`, never
 * directly from the request); only `relPath` is untrusted input.
 */
export function safeResolve(root: string, relPath: unknown): SafeResolveResult {
  if (typeof relPath !== "string" || relPath.length === 0) {
    return { ok: false, error: '"path" must be a non-empty string' };
  }

  // Reject an absolute path outright. `path.resolve(root, relPath)` would
  // actually do the right thing here too (an absolute second argument wins
  // outright, ignoring `root`, which `isInside` below would then reject) —
  // but being explicit means the rejection reason is honest ("absolute
  // paths aren't allowed") rather than the more confusing "path escapes the
  // workspace root", and it fails fast before touching the filesystem.
  if (isAbsolute(relPath)) {
    return { ok: false, error: "Absolute paths are not allowed" };
  }

  // Step 1: textual containment. Collapses any ".." segments, wherever they
  // appear in the path, then checks whether the result is still under root.
  const candidate = resolve(root, relPath);
  if (!isInside(root, candidate)) {
    return { ok: false, error: "Path escapes the workspace root" };
  }

  // Step 2: symlink containment. Even though `candidate` is textually
  // inside `root`, a symlink somewhere along that path (most commonly the
  // final segment itself) could point outside it — realpath both sides and
  // check again.
  const realRoot = realpathSync(root);
  const realCandidate = realpathOfClosestExisting(candidate);
  if (!isInside(realRoot, realCandidate)) {
    return { ok: false, error: "Path escapes the workspace root" };
  }

  // Return the (non-realpath'd) candidate, not realCandidate — callers
  // should keep operating on the path under the workspace's own root as
  // configured (e.g. so a written file lands at the symlink-free path the
  // rest of the app expects), not wherever a symlink might have chased it
  // to. The realpath check above only exists to VALIDATE that no symlink
  // sends us somewhere forbidden, not to change where we actually operate.
  return { ok: true, path: candidate };
}

/** True if `buf`'s first 8KB contain a NUL byte — the standard cheap
 * heuristic for "this is binary content, not text" (git, and most editors,
 * use the same check). Only the first 8KB is scanned, both for speed on
 * large files and because a NUL that early is already conclusive. */
export function isProbablyBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
