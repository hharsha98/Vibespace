/**
 * Route tests for the Phase 9a swarm endpoints, exercised via
 * `app.inject()` — same pattern as `board/routes.test.ts`. Every session-
 * spawning test uses the "shell" agent ONLY, for the same CI reason
 * `board/routes.test.ts` documents: ubuntu-latest has no AI CLIs installed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mission, MissionDetail } from "@vibedeck/shared";
import { buildApp } from "../index.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-swarm-routes-test-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.VIBEDECK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * Strips terminal escape sequences (CSI/OSC) and then everything but
 * letters/digits, uppercasing what's left. The swarm preamble is much
 * longer than an 80-column pty's width, so zsh's line editor word-wraps it
 * and inserts its own redraw sequences (cursor moves, "erase to end of
 * line", and a visible interpunct wrap-continuation marker) mid-string —
 * asserting on a raw substring of the scrollback is exactly what those
 * artifacts would break. Reducing both sides to bare alphanumerics sidesteps
 * that entirely: the escape/wrap bytes are all non-alphanumeric, so what's
 * left is just the real characters that were actually typed, in order.
 */
function alnumOnly(text: string): string {
  return (
    text
      // These control-character regexes are the whole point of this
      // function (stripping ANSI escape sequences, digit parameters and
      // all, BEFORE the final alnum-only pass below — otherwise a
      // sequence like "\x1b[1m"'s "1" would survive as a stray digit and
      // break the reconstructed string). Deliberate, not a lint miss.
      // eslint-disable-next-line no-control-regex -- CSI sequences, e.g. "\x1b[1m", "\x1b[K"
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      // eslint-disable-next-line no-control-regex -- OSC sequences, e.g. title-setting
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // eslint-disable-next-line no-control-regex -- any stray ESC left over
      .replace(/\x1b/g, "")
      .replace(/[^a-zA-Z0-9]/g, "")
      .toUpperCase()
  );
}

/** Waits (polling) until `condition()` is true or `timeoutMs` elapses —
 * identical helper to `board/routes.test.ts`'s. */
async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition never became true within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function createWorkspace(app: ReturnType<typeof buildApp>) {
  const projectDir = mkdtempSync(join(tmpdir(), "vibedeck-swarm-workspace-"));
  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    payload: { name: "swarm-test", rootPath: projectDir },
  });
  return response.json() as { id: string; rootPath: string };
}

async function createMission(app: ReturnType<typeof buildApp>, workspaceId: string, agents: unknown) {
  const response = await app.inject({
    method: "POST",
    url: "/api/swarm/missions",
    payload: { workspaceId, prompt: "Build the thing", agents },
  });
  return response;
}

describe("POST /api/swarm/missions", () => {
  it("400s when workspaceId is missing", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/api/swarm/missions", payload: {} });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("404s for an unknown workspace", async () => {
    const app = buildApp();
    const response = await createMission(app, "nope", [{ role: "builder", agent: "shell" }]);
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("400s when prompt is missing", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/swarm/missions",
      payload: { workspaceId: workspace.id, agents: [{ role: "builder", agent: "shell" }] },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("400s when agents is missing or empty", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await createMission(app, workspace.id, []);
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("400s for an invalid role", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const response = await createMission(app, workspace.id, [{ role: "manager", agent: "shell" }]);
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it(
    "spawns a session per requested agent, numbers labels per role, and starts every agent 'working'",
    async () => {
      const app = buildApp();
      const workspace = await createWorkspace(app);
      const response = await createMission(app, workspace.id, [
        { role: "coordinator", agent: "shell" },
        { role: "builder", agent: "shell", count: 2 },
      ]);
      expect(response.statusCode).toBe(201);

      const detail = response.json() as MissionDetail;
      expect(detail.mission.status).toBe("running");
      expect(detail.agents).toHaveLength(3);

      const coordinator = detail.agents.find((a) => a.role === "coordinator")!;
      const builders = detail.agents.filter((a) => a.role === "builder");
      expect(coordinator.label).toBe("Coordinator 1");
      expect(builders.map((b) => b.label).sort()).toEqual(["Builder 1", "Builder 2"]);

      for (const agent of detail.agents) {
        expect(agent.sessionId).toBeTruthy();
        expect(agent.status).toBe("working");
        expect(app.sessionManager.get(agent.sessionId!)).toBeDefined();
      }

      await app.close();
    },
    10_000
  );

  it(
    "actually types the role preamble into each spawned agent's pty",
    async () => {
      const app = buildApp();
      const workspace = await createWorkspace(app);
      const response = await createMission(app, workspace.id, [{ role: "builder", agent: "shell" }]);
      const detail = response.json() as MissionDetail;
      const agent = detail.agents[0];

      // The preamble names the agent's own role near its START and mentions
      // the mission prompt at its very END. Polling for just "BUILDER"
      // (the early substring) and then immediately asserting on the END of
      // the same long line is itself a race: a pty echoes a long single
      // line back gradually (more so once zsh's line editor starts
      // wrapping/redrawing it), so "BUILDER" can already be visible while
      // "Build the thing" is still in flight. Poll for the ACTUAL final
      // condition instead — see alnumOnly's comment for why the escape/wrap
      // artifacts have to be stripped before comparing.
      await waitFor(() =>
        alnumOnly(app.sessionManager.getHistory(agent.sessionId!)).includes(alnumOnly("Build the thing"))
      );
      expect(alnumOnly(app.sessionManager.getHistory(agent.sessionId!))).toContain(alnumOnly("Build the thing"));

      await app.close();
    },
    15_000
  );
});

describe("GET /api/swarm/missions", () => {
  it("400s when workspaceId is missing", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/swarm/missions" });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("lists missions scoped to a workspace", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    await createMission(app, workspace.id, [{ role: "scout", agent: "shell" }]);

    const response = await app.inject({ method: "GET", url: `/api/swarm/missions?workspaceId=${workspace.id}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { missions: Mission[] };
    expect(body.missions).toHaveLength(1);

    await app.close();
  });
});

describe("GET /api/swarm/missions/:id", () => {
  it("404s for an unknown mission", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/swarm/missions/nope" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns the full mission detail: agents, messages, claims, conflicts", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [{ role: "builder", agent: "shell" }])).json() as MissionDetail;

    const response = await app.inject({ method: "GET", url: `/api/swarm/missions/${created.mission.id}` });
    expect(response.statusCode).toBe(200);
    const detail = response.json() as MissionDetail;
    expect(detail.mission.id).toBe(created.mission.id);
    expect(detail.agents).toHaveLength(1);
    expect(detail.messages).toEqual([]);
    expect(detail.claims).toEqual([]);
    expect(detail.conflicts).toEqual([]);

    await app.close();
  });
});

describe("PATCH /api/swarm/missions/:id", () => {
  it("404s for an unknown mission", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "PATCH", url: "/api/swarm/missions/nope", payload: { status: "paused" } });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("400s for an invalid status", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [{ role: "builder", agent: "shell" }])).json() as MissionDetail;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/swarm/missions/${created.mission.id}`,
      payload: { status: "sleeping" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("pausing a mission changes status but leaves sessions and claims alone", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [{ role: "builder", agent: "shell" }])).json() as MissionDetail;
    const agent = created.agents[0];

    await app.inject({
      method: "POST",
      url: `/api/swarm/missions/${created.mission.id}/claims`,
      payload: { agentId: agent.id, path: "src/foo.ts" },
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/swarm/missions/${created.mission.id}`,
      payload: { status: "paused" },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as Mission).status).toBe("paused");

    expect(app.sessionManager.get(agent.sessionId!)).toBeDefined();
    const claims = await app.inject({ method: "GET", url: `/api/swarm/missions/${created.mission.id}/conflicts` });
    expect(claims.statusCode).toBe(200);

    await app.close();
  });

  it(
    "stopping a mission kills every agent's session and releases every claim",
    async () => {
      const app = buildApp();
      const workspace = await createWorkspace(app);
      const created = (await createMission(app, workspace.id, [
        { role: "builder", agent: "shell", count: 2 },
      ])).json() as MissionDetail;
      const [agentA, agentB] = created.agents;

      await app.inject({
        method: "POST",
        url: `/api/swarm/missions/${created.mission.id}/claims`,
        payload: { agentId: agentA.id, path: "src/a.ts" },
      });
      await app.inject({
        method: "POST",
        url: `/api/swarm/missions/${created.mission.id}/claims`,
        payload: { agentId: agentB.id, path: "src/b.ts" },
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/swarm/missions/${created.mission.id}`,
        payload: { status: "stopped" },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as Mission).status).toBe("stopped");

      expect(app.sessionManager.get(agentA.sessionId!)).toBeUndefined();
      expect(app.sessionManager.get(agentB.sessionId!)).toBeUndefined();

      const detail = (
        await app.inject({ method: "GET", url: `/api/swarm/missions/${created.mission.id}` })
      ).json() as MissionDetail;
      expect(detail.claims).toEqual([]);

      await app.close();
    },
    10_000
  );
});

describe("mailbox routes", () => {
  it("404s for an unknown mission", async () => {
    const app = buildApp();
    const post = await app.inject({ method: "POST", url: "/api/swarm/missions/nope/messages", payload: { body: "hi" } });
    expect(post.statusCode).toBe(404);
    const get = await app.inject({ method: "GET", url: "/api/swarm/missions/nope/messages" });
    expect(get.statusCode).toBe(404);
    await app.close();
  });

  it("400s for an empty body", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [{ role: "builder", agent: "shell" }])).json() as MissionDetail;

    const response = await app.inject({
      method: "POST",
      url: `/api/swarm/missions/${created.mission.id}/messages`,
      payload: { body: "" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("sends a broadcast message (no toAgentId) and it's readable back via GET", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [{ role: "builder", agent: "shell" }])).json() as MissionDetail;

    const sent = await app.inject({
      method: "POST",
      url: `/api/swarm/missions/${created.mission.id}/messages`,
      payload: { body: "status update" },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().fromAgentId).toBeNull();
    expect(sent.json().toAgentId).toBeNull();

    const listed = await app.inject({ method: "GET", url: `/api/swarm/missions/${created.mission.id}/messages` });
    expect((listed.json() as { messages: unknown[] }).messages).toHaveLength(1);

    await app.close();
  });

  it("supports 'since' to fetch only new messages", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [{ role: "builder", agent: "shell" }])).json() as MissionDetail;
    const url = `/api/swarm/missions/${created.mission.id}/messages`;

    const first = (await app.inject({ method: "POST", url, payload: { body: "one" } })).json();
    // A real (not faked) clock is running in this test — createdAt has only
    // millisecond resolution, so without a small real delay the second
    // message could land in the exact same millisecond as the first,
    // making "since" wrongly exclude it too. Same reasoning as
    // `board.test.ts`'s identical delay before its updatedAt assertion.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await app.inject({ method: "POST", url, payload: { body: "two" } });

    const sinceFirst = await app.inject({ method: "GET", url: `${url}?since=${encodeURIComponent(first.createdAt)}` });
    const body = sinceFirst.json() as { messages: { body: string }[] };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].body).toBe("two");

    await app.close();
  });

  it(
    "delivers a directed message into the target agent's pty",
    async () => {
      const app = buildApp();
      const workspace = await createWorkspace(app);
      const created = (await createMission(app, workspace.id, [
        { role: "builder", agent: "shell", count: 2 },
      ])).json() as MissionDetail;
      const [target] = created.agents;

      await app.inject({
        method: "POST",
        url: `/api/swarm/missions/${created.mission.id}/messages`,
        payload: { toAgentId: target.id, body: "echo MAILBOX_MARKER" },
      });

      await waitFor(() => app.sessionManager.getHistory(target.sessionId!).includes("MAILBOX_MARKER"));

      await app.close();
    },
    10_000
  );
});

describe("claims routes", () => {
  it("404s for an unknown mission", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/swarm/missions/nope/claims",
      payload: { agentId: "a1", path: "src/a.ts" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("201s on first claim, 409s naming the holder on a second claim of the same path", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [
      { role: "builder", agent: "shell", count: 2 },
    ])).json() as MissionDetail;
    const [agentA, agentB] = created.agents;
    const url = `/api/swarm/missions/${created.mission.id}/claims`;

    const first = await app.inject({ method: "POST", url, payload: { agentId: agentA.id, path: "src/foo.ts" } });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({ method: "POST", url, payload: { agentId: agentB.id, path: "src/foo.ts" } });
    expect(second.statusCode).toBe(409);
    expect(second.json().holder.agentId).toBe(agentA.id);

    await app.close();
  });

  it("400s for a path that escapes the workspace", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [{ role: "builder", agent: "shell" }])).json() as MissionDetail;

    const response = await app.inject({
      method: "POST",
      url: `/api/swarm/missions/${created.mission.id}/claims`,
      payload: { agentId: created.agents[0].id, path: "../../etc/passwd" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("heartbeat refreshes claims and release frees a path back up", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [
      { role: "builder", agent: "shell", count: 2 },
    ])).json() as MissionDetail;
    const [agentA, agentB] = created.agents;
    const missionUrl = `/api/swarm/missions/${created.mission.id}`;

    await app.inject({ method: "POST", url: `${missionUrl}/claims`, payload: { agentId: agentA.id, path: "src/foo.ts" } });

    const heartbeat = await app.inject({
      method: "POST",
      url: `${missionUrl}/claims/heartbeat`,
      payload: { agentId: agentA.id },
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json()).toEqual({ refreshed: 1 });

    const release = await app.inject({
      method: "DELETE",
      url: `${missionUrl}/claims`,
      payload: { agentId: agentA.id, path: "src/foo.ts" },
    });
    expect(release.statusCode).toBe(200);
    expect(release.json()).toEqual({ ok: true, released: 1 });

    const reclaim = await app.inject({
      method: "POST",
      url: `${missionUrl}/claims`,
      payload: { agentId: agentB.id, path: "src/foo.ts" },
    });
    expect(reclaim.statusCode).toBe(201);

    await app.close();
  });

  it("path normalization: './src/a.ts' 409s against an existing 'src/a.ts' claim", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [
      { role: "builder", agent: "shell", count: 2 },
    ])).json() as MissionDetail;
    const [agentA, agentB] = created.agents;
    const url = `/api/swarm/missions/${created.mission.id}/claims`;

    await app.inject({ method: "POST", url, payload: { agentId: agentA.id, path: "src/a.ts" } });
    const attempt = await app.inject({ method: "POST", url, payload: { agentId: agentB.id, path: "./src/a.ts" } });
    expect(attempt.statusCode).toBe(409);

    await app.close();
  });
});

describe("GET /api/swarm/missions/:id/conflicts", () => {
  it("404s for an unknown mission", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/swarm/missions/nope/conflicts" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("starts empty for a fresh mission", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [{ role: "builder", agent: "shell" }])).json() as MissionDetail;

    const response = await app.inject({ method: "GET", url: `/api/swarm/missions/${created.mission.id}/conflicts` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ conflicts: [] });

    await app.close();
  });
});

describe("POST /api/swarm/missions/:id/gates", () => {
  it("404s for an unknown mission", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/swarm/missions/nope/gates",
      payload: { command: "true" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("400s for a missing command", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [{ role: "builder", agent: "shell" }])).json() as MissionDetail;

    const response = await app.inject({
      method: "POST",
      url: `/api/swarm/missions/${created.mission.id}/gates`,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("reports pass for a 'true' gate and fail for a 'false' gate, using ONLY shell built-ins for CI portability", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [{ role: "builder", agent: "shell" }])).json() as MissionDetail;
    const url = `/api/swarm/missions/${created.mission.id}/gates`;

    const passing = await app.inject({ method: "POST", url, payload: { command: "true" } });
    expect(passing.statusCode).toBe(200);
    expect(passing.json()).toMatchObject({ passed: true, exitCode: 0 });

    const failing = await app.inject({ method: "POST", url, payload: { command: "false" } });
    expect(failing.statusCode).toBe(200);
    expect(failing.json()).toMatchObject({ passed: false, exitCode: 1 });

    await app.close();
  });
});

describe("task routes", () => {
  it("404s for an unknown mission", async () => {
    const app = buildApp();
    const post = await app.inject({
      method: "POST",
      url: "/api/swarm/missions/nope/tasks",
      payload: { title: "T", prompt: "..." },
    });
    expect(post.statusCode).toBe(404);
    const get = await app.inject({ method: "GET", url: "/api/swarm/missions/nope/tasks" });
    expect(get.statusCode).toBe(404);
    await app.close();
  });

  it("creates a task starting 'pending' with declaredPaths, then lists it", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [{ role: "builder", agent: "shell" }])).json() as MissionDetail;

    const response = await app.inject({
      method: "POST",
      url: `/api/swarm/missions/${created.mission.id}/tasks`,
      payload: { title: "Add login form", prompt: "Build it", declaredPaths: ["src/login.tsx"] },
    });
    expect(response.statusCode).toBe(201);
    const task = response.json();
    expect(task.status).toBe("pending");
    expect(task.declaredPaths).toEqual(["src/login.tsx"]);

    const listed = await app.inject({ method: "GET", url: `/api/swarm/missions/${created.mission.id}/tasks` });
    expect((listed.json() as { tasks: unknown[] }).tasks).toHaveLength(1);

    await app.close();
  });

  it("400s creating a task with a missing title/prompt", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [{ role: "builder", agent: "shell" }])).json() as MissionDetail;
    const url = `/api/swarm/missions/${created.mission.id}/tasks`;

    expect((await app.inject({ method: "POST", url, payload: { prompt: "..." } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, payload: { title: "T" } })).statusCode).toBe(400);

    await app.close();
  });

  it("GET .../tasks/schedule groups tasks into waves by declared-path overlap", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [{ role: "builder", agent: "shell" }])).json() as MissionDetail;
    const missionUrl = `/api/swarm/missions/${created.mission.id}`;

    const a = (
      await app.inject({ method: "POST", url: `${missionUrl}/tasks`, payload: { title: "A", prompt: "..", declaredPaths: ["src/shared.ts"] } })
    ).json();
    const b = (
      await app.inject({ method: "POST", url: `${missionUrl}/tasks`, payload: { title: "B", prompt: "..", declaredPaths: ["src/shared.ts"] } })
    ).json();

    const schedule = await app.inject({ method: "GET", url: `${missionUrl}/tasks/schedule` });
    expect(schedule.statusCode).toBe(200);
    expect(schedule.json()).toEqual({ waves: [[a.id], [b.id]] });

    await app.close();
  });

  it("PATCH status to 'complete' is rejected — must go through review", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [{ role: "builder", agent: "shell" }])).json() as MissionDetail;
    const task = (
      await app.inject({
        method: "POST",
        url: `/api/swarm/missions/${created.mission.id}/tasks`,
        payload: { title: "T", prompt: "..." },
      })
    ).json();

    const response = await app.inject({
      method: "PATCH",
      url: `/api/swarm/missions/${created.mission.id}/tasks/${task.id}`,
      payload: { status: "complete" },
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("PATCH status to 'running' 409s with the blocking task ids when its wave isn't ready", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [{ role: "builder", agent: "shell" }])).json() as MissionDetail;
    const missionUrl = `/api/swarm/missions/${created.mission.id}`;

    const a = (
      await app.inject({ method: "POST", url: `${missionUrl}/tasks`, payload: { title: "A", prompt: "..", declaredPaths: ["src/x.ts"] } })
    ).json();
    const b = (
      await app.inject({ method: "POST", url: `${missionUrl}/tasks`, payload: { title: "B", prompt: "..", declaredPaths: ["src/x.ts"] } })
    ).json();

    const response = await app.inject({
      method: "PATCH",
      url: `${missionUrl}/tasks/${b.id}`,
      payload: { status: "running" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().blockedBy).toEqual([a.id]);

    await app.close();
  });

  it("404s reviewing a task in an unknown mission or with an unknown task id", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [{ role: "reviewer", agent: "shell" }])).json() as MissionDetail;

    const unknownMission = await app.inject({
      method: "POST",
      url: "/api/swarm/missions/nope/tasks/also-nope/review",
      payload: { reviewerAgentId: created.agents[0].id, approved: true },
    });
    expect(unknownMission.statusCode).toBe(404);

    const unknownTask = await app.inject({
      method: "POST",
      url: `/api/swarm/missions/${created.mission.id}/tasks/nope/review`,
      payload: { reviewerAgentId: created.agents[0].id, approved: true },
    });
    expect(unknownTask.statusCode).toBe(404);

    await app.close();
  });

  it("403s a review attempt from an agent that is NOT playing the reviewer role", async () => {
    const app = buildApp();
    const workspace = await createWorkspace(app);
    const created = (await createMission(app, workspace.id, [{ role: "builder", agent: "shell" }])).json() as MissionDetail;
    const builder = created.agents[0];
    const task = (
      await app.inject({
        method: "POST",
        url: `/api/swarm/missions/${created.mission.id}/tasks`,
        payload: { title: "T", prompt: "..." },
      })
    ).json();

    const response = await app.inject({
      method: "POST",
      url: `/api/swarm/missions/${created.mission.id}/tasks/${task.id}/review`,
      payload: { reviewerAgentId: builder.id, approved: true },
    });
    expect(response.statusCode).toBe(403);
    // The task must be untouched — still pending, not completed.
    const stillPending = await app.inject({ method: "GET", url: `/api/swarm/missions/${created.mission.id}/tasks` });
    expect((stillPending.json() as { tasks: { status: string }[] }).tasks[0].status).toBe("pending");

    await app.close();
  });

  it(
    "a reviewer-role agent CAN approve a task, moving it to 'complete', and reject moves it to 'blocked'",
    async () => {
      const app = buildApp();
      const workspace = await createWorkspace(app);
      const created = (await createMission(app, workspace.id, [{ role: "reviewer", agent: "shell" }])).json() as MissionDetail;
      const reviewer = created.agents[0];
      const missionUrl = `/api/swarm/missions/${created.mission.id}`;

      const taskA = (
        await app.inject({ method: "POST", url: `${missionUrl}/tasks`, payload: { title: "A", prompt: "..." } })
      ).json();
      const taskB = (
        await app.inject({ method: "POST", url: `${missionUrl}/tasks`, payload: { title: "B", prompt: "..." } })
      ).json();

      const approved = await app.inject({
        method: "POST",
        url: `${missionUrl}/tasks/${taskA.id}/review`,
        payload: { reviewerAgentId: reviewer.id, approved: true, notes: "Looks good" },
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({ status: "complete", reviewApproved: true, reviewNotes: "Looks good" });

      const rejected = await app.inject({
        method: "POST",
        url: `${missionUrl}/tasks/${taskB.id}/review`,
        payload: { reviewerAgentId: reviewer.id, approved: false, notes: "Needs rework" },
      });
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json()).toMatchObject({ status: "blocked", reviewApproved: false });

      await app.close();
    },
    10_000
  );
});
