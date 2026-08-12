/**
 * MissionsStore tests — CRUD for missions and mission_agents, run against a
 * real SQLite file inside a fresh temp dir. Same pattern as
 * `db/board.test.ts` / `swarm/claims.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionsStore } from "./missions.js";

let dataDir: string;
let store: MissionsStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-missions-test-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;
  store = new MissionsStore();
});

afterEach(() => {
  store.close();
  delete process.env.VIBEDECK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("MissionsStore missions", () => {
  it("creates a mission that starts 'running', with a generated id and matching timestamps", () => {
    const mission = store.createMission({ workspaceId: "ws-1", prompt: "Build the thing" });

    expect(mission.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(mission.workspaceId).toBe("ws-1");
    expect(mission.prompt).toBe("Build the thing");
    expect(mission.status).toBe("running");
    expect(mission.createdAt).toBe(mission.updatedAt);
  });

  it("getMission returns undefined for an unknown id", () => {
    expect(store.getMission("nope")).toBeUndefined();
  });

  it("listMissions scopes to a workspace and orders by creation", () => {
    const a = store.createMission({ workspaceId: "ws-1", prompt: "First" });
    const b = store.createMission({ workspaceId: "ws-1", prompt: "Second" });
    store.createMission({ workspaceId: "ws-2", prompt: "Other workspace" });

    const listed = store.listMissions("ws-1");
    expect(listed.map((m) => m.id)).toEqual([a.id, b.id]);
  });

  it("updateMissionStatus changes status and bumps updatedAt", async () => {
    const mission = store.createMission({ workspaceId: "ws-1", prompt: "Task" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = store.updateMissionStatus(mission.id, "stopped");
    expect(updated?.status).toBe("stopped");
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThan(new Date(mission.createdAt).getTime());
  });

  it("updateMissionStatus returns undefined for an unknown id", () => {
    expect(store.updateMissionStatus("nope", "paused")).toBeUndefined();
  });
});

describe("MissionsStore mission agents", () => {
  it("creates an agent that starts 'idle' with no session", () => {
    const mission = store.createMission({ workspaceId: "ws-1", prompt: "Task" });
    const agent = store.createAgent({ missionId: mission.id, role: "builder", label: "Builder 1", agent: "shell" });

    expect(agent.missionId).toBe(mission.id);
    expect(agent.role).toBe("builder");
    expect(agent.label).toBe("Builder 1");
    expect(agent.agent).toBe("shell");
    expect(agent.sessionId).toBeNull();
    expect(agent.status).toBe("idle");
  });

  it("listAgents scopes to a mission and orders by creation", () => {
    const missionA = store.createMission({ workspaceId: "ws-1", prompt: "A" });
    const missionB = store.createMission({ workspaceId: "ws-1", prompt: "B" });

    const a1 = store.createAgent({ missionId: missionA.id, role: "coordinator", label: "Coord", agent: "shell" });
    const a2 = store.createAgent({ missionId: missionA.id, role: "builder", label: "Builder 1", agent: "shell" });
    store.createAgent({ missionId: missionB.id, role: "scout", label: "Scout 1", agent: "shell" });

    const listed = store.listAgents(missionA.id);
    expect(listed.map((a) => a.id)).toEqual([a1.id, a2.id]);
  });

  it("updateAgent sets sessionId and status once a pty is spawned", () => {
    const mission = store.createMission({ workspaceId: "ws-1", prompt: "Task" });
    const agent = store.createAgent({ missionId: mission.id, role: "builder", label: "Builder 1", agent: "shell" });

    const updated = store.updateAgent(agent.id, { sessionId: "session-abc", status: "working" });
    expect(updated?.sessionId).toBe("session-abc");
    expect(updated?.status).toBe("working");
  });

  it("updateAgent can leave a field untouched when omitted", () => {
    const mission = store.createMission({ workspaceId: "ws-1", prompt: "Task" });
    const agent = store.createAgent({ missionId: mission.id, role: "builder", label: "Builder 1", agent: "shell" });
    store.updateAgent(agent.id, { sessionId: "session-abc" });

    const updated = store.updateAgent(agent.id, { status: "blocked" });
    expect(updated?.sessionId).toBe("session-abc");
    expect(updated?.status).toBe("blocked");
  });

  it("updateAgent returns undefined for an unknown id", () => {
    expect(store.updateAgent("nope", { status: "done" })).toBeUndefined();
  });

  it("getAgent returns undefined for an unknown id", () => {
    expect(store.getAgent("nope")).toBeUndefined();
  });
});
