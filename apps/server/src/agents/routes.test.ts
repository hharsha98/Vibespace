/**
 * Route tests for the Phase 9.5b agent-profile endpoints, exercised via
 * `app.inject()` (in-process, no real network port) — same pattern as
 * `board/routes.test.ts`. `VIBESPACE_DATA_DIR` is pointed at a fresh temp
 * directory per test, same reasoning as every other SQLite-backed test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProfile } from "@vibespace/shared";
import { buildApp } from "../index.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibespace-agents-routes-test-"));
  process.env.VIBESPACE_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.VIBESPACE_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

/** Creates a throwaway workspace (via the real REST route) for tests that
 * need a valid workspaceId. */
async function createWorkspace(app: ReturnType<typeof buildApp>) {
  const projectDir = mkdtempSync(join(tmpdir(), "vibespace-agents-workspace-"));
  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    payload: { name: "agents-test", rootPath: projectDir },
  });
  return response.json() as { id: string; rootPath: string };
}

describe("GET /api/agent-profiles", () => {
  it("400s when workspaceId is missing", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/agent-profiles" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("404s for an unknown workspace", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/agent-profiles?workspaceId=nope" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns an empty list for a fresh workspace", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({ method: "GET", url: `/api/agent-profiles?workspaceId=${workspace.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ agents: [] });
    await app.close();
  });
});

describe("POST /api/agent-profiles", () => {
  it("creates a profile and returns 201", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: {
        workspaceId: workspace.id,
        name: "Reviewer Bot",
        systemPrompt: "You are a careful, thorough code reviewer.",
        baseAgent: "claude",
      },
    });
    expect(response.statusCode).toBe(201);
    const agent = response.json() as AgentProfile;
    expect(agent.name).toBe("Reviewer Bot");
    expect(agent.baseAgent).toBe("claude");
    expect(agent.workspaceId).toBe(workspace.id);

    const listed = await app.inject({ method: "GET", url: `/api/agent-profiles?workspaceId=${workspace.id}` });
    expect((listed.json() as { agents: AgentProfile[] }).agents.map((a) => a.id)).toEqual([agent.id]);

    await app.close();
  });

  it("400s for a missing/empty name", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: { workspaceId: workspace.id, name: "  ", systemPrompt: "x", baseAgent: "shell" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("400s for a missing/empty systemPrompt", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: { workspaceId: workspace.id, name: "x", systemPrompt: "", baseAgent: "shell" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("400s when systemPrompt exceeds 100,000 characters", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: { workspaceId: workspace.id, name: "x", systemPrompt: "a".repeat(100_001), baseAgent: "shell" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("400s for an invalid baseAgent", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: { workspaceId: workspace.id, name: "x", systemPrompt: "x", baseAgent: "not-a-real-agent" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("404s for an unknown workspace", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: { workspaceId: "nope", name: "x", systemPrompt: "x", baseAgent: "shell" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("409s on a duplicate name within the same workspace, naming the conflict", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);

    await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: { workspaceId: workspace.id, name: "Dup", systemPrompt: "x", baseAgent: "shell" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: { workspaceId: workspace.id, name: "Dup", systemPrompt: "y", baseAgent: "claude" },
    });

    expect(second.statusCode).toBe(409);
    const body = second.json() as { error: string };
    expect(body.error).toContain("Dup");

    await app.close();
  });

  it("allows the same name across different workspaces", async () => {
    const app = buildApp();
    const workspaceA = await createWorkspace(app);
    const workspaceB = await createWorkspace(app);

    const a = await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: { workspaceId: workspaceA.id, name: "Shared", systemPrompt: "x", baseAgent: "shell" },
    });
    const b = await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: { workspaceId: workspaceB.id, name: "Shared", systemPrompt: "x", baseAgent: "shell" },
    });

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);

    await app.close();
  });
});

describe("GET /api/agent-profiles/:id", () => {
  it("404s for an unknown id", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/agent-profiles/does-not-exist" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns the profile for a known id", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/agent-profiles",
        payload: { workspaceId: workspace.id, name: "Findable", systemPrompt: "x", baseAgent: "shell" },
      })
    ).json() as AgentProfile;

    const response = await app.inject({ method: "GET", url: `/api/agent-profiles/${created.id}` });
    expect(response.statusCode).toBe(200);
    expect((response.json() as AgentProfile).id).toBe(created.id);
    await app.close();
  });
});

describe("PATCH /api/agent-profiles/:id", () => {
  it("updates fields and returns the updated profile", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/agent-profiles",
        payload: { workspaceId: workspace.id, name: "Original", systemPrompt: "x", baseAgent: "shell" },
      })
    ).json() as AgentProfile;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/agent-profiles/${created.id}`,
      payload: { name: "Renamed", systemPrompt: "new prompt", baseAgent: "codex" },
    });
    expect(response.statusCode).toBe(200);
    const updated = response.json() as AgentProfile;
    expect(updated.name).toBe("Renamed");
    expect(updated.systemPrompt).toBe("new prompt");
    expect(updated.baseAgent).toBe("codex");

    await app.close();
  });

  it("400s for an invalid baseAgent or an oversized systemPrompt", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/agent-profiles",
        payload: { workspaceId: workspace.id, name: "x", systemPrompt: "x", baseAgent: "shell" },
      })
    ).json() as AgentProfile;

    const badAgent = await app.inject({
      method: "PATCH",
      url: `/api/agent-profiles/${created.id}`,
      payload: { baseAgent: "nope" },
    });
    expect(badAgent.statusCode).toBe(400);

    const tooLong = await app.inject({
      method: "PATCH",
      url: `/api/agent-profiles/${created.id}`,
      payload: { systemPrompt: "a".repeat(100_001) },
    });
    expect(tooLong.statusCode).toBe(400);

    await app.close();
  });

  it("404s for an unknown id", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/agent-profiles/does-not-exist",
      payload: { name: "x" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("409s when renaming to a name already taken in the same workspace, naming the conflict", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: { workspaceId: workspace.id, name: "Taken", systemPrompt: "x", baseAgent: "shell" },
    });
    const other = (
      await app.inject({
        method: "POST",
        url: "/api/agent-profiles",
        payload: { workspaceId: workspace.id, name: "Renamable", systemPrompt: "x", baseAgent: "shell" },
      })
    ).json() as AgentProfile;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/agent-profiles/${other.id}`,
      payload: { name: "Taken" },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: string };
    expect(body.error).toContain("Taken");

    await app.close();
  });
});

describe("DELETE /api/agent-profiles/:id", () => {
  it("deletes a profile and returns 204, then 404s on a second delete", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/agent-profiles",
        payload: { workspaceId: workspace.id, name: "Delete me", systemPrompt: "x", baseAgent: "shell" },
      })
    ).json() as AgentProfile;

    const response = await app.inject({ method: "DELETE", url: `/api/agent-profiles/${created.id}` });
    expect(response.statusCode).toBe(204);

    const again = await app.inject({ method: "DELETE", url: `/api/agent-profiles/${created.id}` });
    expect(again.statusCode).toBe(404);

    await app.close();
  });

  it("404s for an unknown id", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "DELETE", url: "/api/agent-profiles/does-not-exist" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
