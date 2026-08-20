/**
 * Route tests for the BridgeSpace parity item 4 command-history endpoints,
 * exercised via `app.inject()` — same pattern as `prompts/routes.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../index.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-history-routes-test-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.VIBEDECK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

async function createWorkspace(app: ReturnType<typeof buildApp>) {
  const projectDir = mkdtempSync(join(tmpdir(), "vibedeck-history-workspace-"));
  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    payload: { name: "history-test", rootPath: projectDir },
  });
  return (response.json() as { id: string }).id;
}

describe("GET /api/command-history", () => {
  it("requires workspaceId", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/command-history" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("404s for an unknown workspaceId", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/command-history?workspaceId=nope" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns an empty list for a workspace with no recorded history", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    const response = await app.inject({ method: "GET", url: `/api/command-history?workspaceId=${workspaceId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ commands: [] });
    await app.close();
  });

  it("returns recorded commands, newest first", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);

    await app.inject({ method: "POST", url: "/api/command-history", payload: { workspaceId, command: "git status" } });
    await app.inject({ method: "POST", url: "/api/command-history", payload: { workspaceId, command: "pnpm test" } });

    const response = await app.inject({ method: "GET", url: `/api/command-history?workspaceId=${workspaceId}` });
    expect(response.json()).toEqual({ commands: ["pnpm test", "git status"] });
    await app.close();
  });

  it("keeps two workspaces' history separate", async () => {
    const app = buildApp();
    const workspaceA = await createWorkspace(app);
    const workspaceB = await createWorkspace(app);

    await app.inject({ method: "POST", url: "/api/command-history", payload: { workspaceId: workspaceA, command: "only in A" } });

    const responseA = await app.inject({ method: "GET", url: `/api/command-history?workspaceId=${workspaceA}` });
    const responseB = await app.inject({ method: "GET", url: `/api/command-history?workspaceId=${workspaceB}` });
    expect(responseA.json()).toEqual({ commands: ["only in A"] });
    expect(responseB.json()).toEqual({ commands: [] });
    await app.close();
  });
});

describe("POST /api/command-history", () => {
  it("records a command and 204s", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/command-history",
      payload: { workspaceId, command: "ls -la" },
    });
    expect(response.statusCode).toBe(204);
    await app.close();
  });

  it("400s on a missing workspaceId", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/command-history",
      payload: { command: "ls" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("404s on an unknown workspaceId", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/command-history",
      payload: { workspaceId: "no-such-workspace", command: "ls" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("400s on an empty/blank command", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/command-history",
      payload: { workspaceId, command: "   " },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("400s on a command containing a newline", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/command-history",
      payload: { workspaceId, command: "line one\nline two" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("trims surrounding whitespace before storing", async () => {
    const app = buildApp();
    const workspaceId = await createWorkspace(app);

    await app.inject({
      method: "POST",
      url: "/api/command-history",
      payload: { workspaceId, command: "  git status  " },
    });

    const response = await app.inject({ method: "GET", url: `/api/command-history?workspaceId=${workspaceId}` });
    expect(response.json()).toEqual({ commands: ["git status"] });
    await app.close();
  });
});
