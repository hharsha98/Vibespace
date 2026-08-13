/**
 * Route tests for `GET /api/git/branch`, exercised via `app.inject()` —
 * same pattern as `agents/routes.test.ts`. `VIBEDECK_DATA_DIR` points at a
 * fresh temp directory per test, same reasoning as every other
 * SQLite-backed test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitBranchResponse } from "@vibedeck/shared";
import { buildApp } from "../index.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-git-routes-test-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.VIBEDECK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

async function createWorkspace(app: ReturnType<typeof buildApp>, rootPath: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    payload: { name: "git-test", rootPath },
  });
  return response.json() as { id: string; rootPath: string };
}

describe("GET /api/git/branch", () => {
  it("400s when workspaceId is missing", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/git/branch" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("404s for an unknown workspace", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/git/branch?workspaceId=nope" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns a clean isRepo:false for a workspace directory that isn't a git repo", async () => {
    const app = buildApp();
    const projectDir = mkdtempSync(join(tmpdir(), "vibedeck-git-notrepo-"));
    const workspace = await createWorkspace(app, projectDir);

    const response = await app.inject({
      method: "GET",
      url: `/api/git/branch?workspaceId=${workspace.id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json() as GitBranchResponse).toEqual({ isRepo: false, branch: null });

    rmSync(projectDir, { recursive: true, force: true });
    await app.close();
  });

  it("returns the current branch for a workspace that IS a git repo", async () => {
    const app = buildApp();
    const projectDir = mkdtempSync(join(tmpdir(), "vibedeck-git-isrepo-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: projectDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: projectDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: projectDir });
    writeFileSync(join(projectDir, "a.txt"), "hello");
    execFileSync("git", ["add", "a.txt"], { cwd: projectDir });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: projectDir });

    const workspace = await createWorkspace(app, projectDir);
    const response = await app.inject({
      method: "GET",
      url: `/api/git/branch?workspaceId=${workspace.id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json() as GitBranchResponse).toEqual({ isRepo: true, branch: "main" });

    rmSync(projectDir, { recursive: true, force: true });
    await app.close();
  });

  it("403s a path that escapes the workspace root, same as files/tree", async () => {
    const app = buildApp();
    const projectDir = mkdtempSync(join(tmpdir(), "vibedeck-git-escape-"));
    const workspace = await createWorkspace(app, projectDir);

    const response = await app.inject({
      method: "GET",
      url: `/api/git/branch?workspaceId=${workspace.id}&path=${encodeURIComponent("../../etc")}`,
    });
    expect(response.statusCode).toBe(403);

    rmSync(projectDir, { recursive: true, force: true });
    await app.close();
  });
});
