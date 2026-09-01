/**
 * Route tests for the Phase 9.5b saved-prompts endpoints, exercised via
 * `app.inject()` — same pattern as `board/routes.test.ts` and
 * `agents/routes.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SavedPrompt } from "@vibespace/shared";
import { buildApp } from "../index.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibespace-prompts-routes-test-"));
  process.env.VIBESPACE_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.VIBESPACE_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

async function createWorkspace(app: ReturnType<typeof buildApp>) {
  const projectDir = mkdtempSync(join(tmpdir(), "vibespace-prompts-workspace-"));
  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    payload: { name: "prompts-test", rootPath: projectDir },
  });
  return response.json() as { id: string; rootPath: string };
}

describe("GET /api/prompts", () => {
  it("returns an empty list with no prompts saved", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/prompts" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ prompts: [] });
    await app.close();
  });

  it("returns only globals when no workspaceId is given", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    await app.inject({ method: "POST", url: "/api/prompts", payload: { title: "Global", body: "x" } });
    await app.inject({
      method: "POST",
      url: "/api/prompts",
      payload: { workspaceId: workspace.id, title: "Scoped", body: "x" },
    });

    const response = await app.inject({ method: "GET", url: "/api/prompts" });
    const body = response.json() as { prompts: SavedPrompt[] };
    expect(body.prompts.map((p) => p.title)).toEqual(["Global"]);
    await app.close();
  });

  it("returns globals plus this workspace's own when workspaceId is given", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    await app.inject({ method: "POST", url: "/api/prompts", payload: { title: "Global", body: "x" } });
    await app.inject({
      method: "POST",
      url: "/api/prompts",
      payload: { workspaceId: workspace.id, title: "Scoped", body: "x" },
    });

    const response = await app.inject({ method: "GET", url: `/api/prompts?workspaceId=${workspace.id}` });
    const body = response.json() as { prompts: SavedPrompt[] };
    expect(body.prompts.map((p) => p.title).sort()).toEqual(["Global", "Scoped"]);
    await app.close();
  });
});

describe("POST /api/prompts", () => {
  it("creates a global prompt when workspaceId is omitted", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/prompts",
      payload: { title: "Write tests", body: "Write tests for the function above." },
    });
    expect(response.statusCode).toBe(201);
    const prompt = response.json() as SavedPrompt;
    expect(prompt.workspaceId).toBeNull();
    expect(prompt.title).toBe("Write tests");
    await app.close();
  });

  it("creates a workspace-scoped prompt", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/prompts",
      payload: { workspaceId: workspace.id, title: "Scoped", body: "x" },
    });
    expect(response.statusCode).toBe(201);
    expect((response.json() as SavedPrompt).workspaceId).toBe(workspace.id);
    await app.close();
  });

  it("404s when workspaceId names an unknown workspace", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/prompts",
      payload: { workspaceId: "nope", title: "x", body: "x" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("400s for a missing/empty title or body", async () => {
    const app = buildApp();
    const missingTitle = await app.inject({ method: "POST", url: "/api/prompts", payload: { body: "x" } });
    expect(missingTitle.statusCode).toBe(400);

    const missingBody = await app.inject({ method: "POST", url: "/api/prompts", payload: { title: "x" } });
    expect(missingBody.statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /api/prompts/:id", () => {
  it("404s for an unknown id", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/prompts/does-not-exist" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns the prompt for a known id", async () => {
    const app = buildApp();
    const created = (
      await app.inject({ method: "POST", url: "/api/prompts", payload: { title: "x", body: "x" } })
    ).json() as SavedPrompt;
    const response = await app.inject({ method: "GET", url: `/api/prompts/${created.id}` });
    expect(response.statusCode).toBe(200);
    expect((response.json() as SavedPrompt).id).toBe(created.id);
    await app.close();
  });
});

describe("PATCH /api/prompts/:id", () => {
  it("updates title/body", async () => {
    const app = buildApp();
    const created = (
      await app.inject({ method: "POST", url: "/api/prompts", payload: { title: "Old", body: "old" } })
    ).json() as SavedPrompt;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/prompts/${created.id}`,
      payload: { title: "New", body: "new" },
    });
    expect(response.statusCode).toBe(200);
    const updated = response.json() as SavedPrompt;
    expect(updated.title).toBe("New");
    expect(updated.body).toBe("new");
    await app.close();
  });

  it("404s for an unknown id", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/prompts/does-not-exist",
      payload: { title: "x" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("400s for an empty title/body", async () => {
    const app = buildApp();
    const created = (
      await app.inject({ method: "POST", url: "/api/prompts", payload: { title: "x", body: "x" } })
    ).json() as SavedPrompt;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/prompts/${created.id}`,
      payload: { title: "  " },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe("DELETE /api/prompts/:id", () => {
  it("deletes a prompt and returns 204, then 404s on a second delete", async () => {
    const app = buildApp();
    const created = (
      await app.inject({ method: "POST", url: "/api/prompts", payload: { title: "x", body: "x" } })
    ).json() as SavedPrompt;

    const response = await app.inject({ method: "DELETE", url: `/api/prompts/${created.id}` });
    expect(response.statusCode).toBe(204);

    const again = await app.inject({ method: "DELETE", url: `/api/prompts/${created.id}` });
    expect(again.statusCode).toBe(404);
    await app.close();
  });

  it("404s for an unknown id", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "DELETE", url: "/api/prompts/does-not-exist" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
