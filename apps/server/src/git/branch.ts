/**
 * Reports the current git branch for a directory (Phase 9.5c, PARITY #13b —
 * the pane header's `⑂ main` chip). This is the ONE piece of logic in this
 * file: pure, testable, and deliberately free of any Fastify/route concerns
 * (see `./routes.ts` for the endpoint that calls it).
 *
 * Every `git` invocation below uses `execFile` (never `exec`) with the
 * directory and each argument passed as separate array elements — never
 * string-concatenated into a shell command line. `execFile` does not spawn a
 * shell at all, so there is no shell-metacharacter injection surface here
 * regardless of what a workspace's absolute path happens to contain (spaces,
 * `;`, backticks, ...). The *directory itself* is still validated by the
 * caller via `safeResolve` before it ever reaches this function — this file
 * trusts `cwd` completely, the same way `safeResolve`'s own callers trust
 * its output.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitBranchResponse } from "@vibespace/shared";

const execFileAsync = promisify(execFile);

/** Generous but bounded — a hung/misbehaving `git` (e.g. waiting on a
 * credential prompt it will never get) must not hang this request forever. */
const GIT_TIMEOUT_MS = 5000;

async function runGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
    return stdout.trim();
  } catch {
    // Covers every failure mode we care about here: `git` not on PATH, not a
    // repo, no commits yet, detached with no ref, the timeout above firing —
    // all of them mean "we don't have a branch name," never a 500. The
    // caller (getGitBranch below) is responsible for telling "not a repo"
    // apart from "repo, but this particular ref lookup failed."
    return null;
  }
}

/**
 * Resolves `cwd`'s git status. A directory that isn't a git repository (or
 * has no `git` binary available at all) is a normal, successful answer —
 * `{ isRepo: false, branch: null }` — never a thrown error or an HTTP
 * failure status; see `GitBranchResponse`'s own doc comment in
 * `packages/shared/src/protocol.ts` for why that distinction matters to the
 * UI (it must not guess whether a failure means "not a repo" or "something
 * actually broke").
 */
export async function getGitBranch(cwd: string): Promise<GitBranchResponse> {
  const insideWorkTree = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree !== "true") {
    return { isRepo: false, branch: null };
  }

  // The common case: HEAD points at a named branch. `--short` here means
  // "shortest unambiguous ref name" (e.g. "main", not "refs/heads/main"),
  // not to be confused with `rev-parse --short` (a shortened commit hash)
  // used as the fallback below.
  const branch = await runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (branch) {
    return { isRepo: true, branch };
  }

  // `symbolic-ref` fails on a detached HEAD (checked out a commit/tag
  // directly, not a branch) — fall back to a short commit hash so the chip
  // still shows *something* identifying, rather than going blank. Note that
  // a brand-new repo with zero commits yet ("unborn" branch) is NOT this
  // case: `symbolic-ref` resolves HEAD's symbolic target regardless of
  // whether that ref has ever been committed to, so it already returned
  // above with the branch's real name (confirmed against real `git`, see
  // branch.test.ts). This fallback is reached only for a genuinely
  // ref-less HEAD.
  const shortHash = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
  return { isRepo: true, branch: shortHash };
}
