/**
 * `getGitBranch` tests, run against real temp-directory git repos (real
 * `git` subprocess calls, not mocked) — the only way to actually prove the
 * execFile plumbing and argument parsing work, matching this repo's general
 * "exercise the real thing" testing style (e.g. `pty/session-manager.test.ts`
 * spawns real ptys).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGitBranch } from "./branch.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vibedeck-git-branch-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: dir });
}

describe("getGitBranch", () => {
  it("reports isRepo: false, branch: null for a plain, non-git directory — a clean answer, not an error", async () => {
    const result = await getGitBranch(dir);
    expect(result).toEqual({ isRepo: false, branch: null });
  });

  it("reports the current branch for a repo with at least one commit", async () => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(dir, "a.txt"), "hello");
    git("add", "a.txt");
    git("commit", "-q", "-m", "initial");

    const result = await getGitBranch(dir);
    expect(result).toEqual({ isRepo: true, branch: "main" });
  });

  it("follows a checkout to a different branch — the whole point of the pane header chip", async () => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(dir, "a.txt"), "hello");
    git("add", "a.txt");
    git("commit", "-q", "-m", "initial");
    git("checkout", "-q", "-b", "feature/branch-chip");

    const result = await getGitBranch(dir);
    expect(result).toEqual({ isRepo: true, branch: "feature/branch-chip" });
  });

  it("reports isRepo: true with a short commit hash for a detached HEAD", async () => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(dir, "a.txt"), "hello");
    git("add", "a.txt");
    git("commit", "-q", "-m", "initial");
    const hash = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir }).toString().trim();
    git("checkout", "-q", hash);

    const result = await getGitBranch(dir);
    expect(result).toEqual({ isRepo: true, branch: hash });
  });

  it("reports the branch name for a repo with zero commits yet (an unborn branch)", async () => {
    // `git symbolic-ref` resolves HEAD's symbolic target ("refs/heads/main")
    // regardless of whether that ref has ever been committed to — so a
    // freshly `git init`'d repo correctly reports its branch name here,
    // same as one with real history. Confirmed against real `git` (not
    // assumed): this is the actual, correct behaviour, not a limitation.
    git("init", "-q", "-b", "main");

    const result = await getGitBranch(dir);
    expect(result).toEqual({ isRepo: true, branch: "main" });
  });
});
