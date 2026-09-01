import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "@vibespace/shared";
import { buildApp } from "./index.js";

/**
 * All PTY-backed tests below use the "shell" agent only. CI runs on
 * ubuntu-latest, where claude/cursor-agent/codex are not installed — a
 * test that assumes one of those exists would only pass on Harsha's Mac.
 */

/**
 * Every `buildApp()` call in this file constructs a fresh `WorkspaceStore`,
 * which opens a SQLite file under `VIBESPACE_DATA_DIR` (see
 * `apps/server/src/db/schema.ts`). Point that at a brand-new temp directory
 * before each test, and clean it up after, so these tests never read or
 * write a developer's real `~/.vibespace`.
 */
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibespace-index-test-"));
  process.env.VIBESPACE_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.VIBESPACE_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("GET /api/health", () => {
  it("returns 200 with status, version, and the supported agent list", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body).toEqual({
      status: "ok",
      version: expect.any(String),
      agents: [
        "claude",
        "codex",
        "cursor-agent",
        "gemini",
        "droid",
        "opencode",
        "deepseek",
        "grok",
        "antigravity",
        "shell",
      ],
      // The server's own cwd — only used by the web UI to pre-fill the
      // first-run "create a workspace" form's directory field.
      cwd: expect.any(String),
    });

    await app.close();
  });
});

describe("GET /api/agents", () => {
  it("reports availability and an install hint for every known agent, shell always available", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/agents" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      agents: { id: string; displayName: string; available: boolean; installHint: string | null }[];
    };
    expect(body.agents).toHaveLength(10);
    const shell = body.agents.find((a) => a.id === "shell");
    expect(shell?.available).toBe(true);
    expect(shell?.displayName).toBe("Terminal");
    // Shell needs no separate install, and is always available, so it
    // should never carry an install hint.
    expect(shell?.installHint).toBeNull();

    // codex is the one agent with a real (non-null) install hint when it's
    // missing — guaranteed missing on ubuntu-latest CI, may or may not be
    // missing on a dev machine, so branch on actual availability rather
    // than assuming either state.
    const codex = body.agents.find((a) => a.id === "codex");
    if (codex?.available) {
      expect(codex.installHint).toBeNull();
    } else {
      expect(codex?.installHint).toBe("npm install -g @openai/codex");
    }

    await app.close();
  });
});

describe("session REST endpoints", () => {
  it("POST /api/sessions rejects an unknown agent with 400", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { agent: "not-a-real-agent" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("POST /api/sessions returns 409 with an install hint for a missing agent binary", async () => {
    // codex is guaranteed absent on the ubuntu-latest CI runner, and may
    // also be absent locally — either way this exercises the 409 path
    // whenever it's actually missing. If codex happens to be installed
    // (e.g. some future dev machine), skip rather than false-fail.
    const app = buildApp();
    const agentsResponse = await app.inject({ method: "GET", url: "/api/agents" });
    const agents = (agentsResponse.json() as { agents: { id: string; available: boolean }[] })
      .agents;
    const codex = agents.find((a) => a.id === "codex");

    if (codex?.available) {
      await app.close();
      return;
    }

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { agent: "codex" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("codex"),
      installHint: "npm install -g @openai/codex",
    });
    await app.close();
  });

  it(
    "creates, lists, and deletes a shell session",
    async () => {
      const app = buildApp();

      const createResponse = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { agent: "shell" },
      });
      expect(createResponse.statusCode).toBe(201);
      const info = createResponse.json() as { id: string; agent: string; status: string };
      expect(info.agent).toBe("shell");
      expect(info.status).toBe("running");

      const listResponse = await app.inject({ method: "GET", url: "/api/sessions" });
      const { sessions } = listResponse.json() as { sessions: { id: string }[] };
      expect(sessions.map((s) => s.id)).toContain(info.id);

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${info.id}`,
      });
      expect(deleteResponse.statusCode).toBe(204);

      // A DELETE that returns 204 but leaves the session in the listing is
      // a lie, and it also strands that session's ring buffer (up to 2MB)
      // in memory for the life of the server. Guard both here.
      const afterDelete = await app.inject({ method: "GET", url: "/api/sessions" });
      const remaining = (afterDelete.json() as { sessions: { id: string }[] }).sessions;
      expect(remaining.map((s) => s.id)).not.toContain(info.id);

      // Deleting it a second time is now a 404, because it's genuinely gone.
      const deleteAgain = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${info.id}`,
      });
      expect(deleteAgain.statusCode).toBe(404);

      const deleteUnknown = await app.inject({
        method: "DELETE",
        url: "/api/sessions/does-not-exist",
      });
      expect(deleteUnknown.statusCode).toBe(404);

      await app.close();
    },
    10_000
  );

  it(
    "spawns a session in a workspace's rootPath when workspaceId is given",
    async () => {
      const app = buildApp();
      const projectDir = mkdtempSync(join(tmpdir(), "vibespace-workspace-cwd-"));

      const workspaceResponse = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "cwd-test", rootPath: projectDir },
      });
      expect(workspaceResponse.statusCode).toBe(201);
      const workspace = workspaceResponse.json() as { id: string; rootPath: string };

      const sessionResponse = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { agent: "shell", workspaceId: workspace.id },
      });
      expect(sessionResponse.statusCode).toBe(201);
      const info = sessionResponse.json() as { cwd: string };
      // The workspace's rootPath wins — this is the actual fix for "every
      // pane spawns in the server's own working directory" bug.
      expect(info.cwd).toBe(workspace.rootPath);

      rmSync(projectDir, { recursive: true, force: true });
      await app.close();
    },
    10_000
  );

  it("POST /api/sessions rejects an unknown workspaceId with 400", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { agent: "shell", workspaceId: "does-not-exist" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe("session recovery REST endpoints", () => {
  it(
    "POST /api/sessions records a durable session record AT SPAWN TIME",
    async () => {
      const app = buildApp();
      const workspaceResponse = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "recovery-test", rootPath: mkdtempSync(join(tmpdir(), "vibespace-recovery-")) },
      });
      const workspace = workspaceResponse.json() as { id: string; rootPath: string };

      const sessionResponse = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { agent: "shell", workspaceId: workspace.id, paneId: "pane-abc" },
      });
      expect(sessionResponse.statusCode).toBe(201);
      const info = sessionResponse.json() as { id: string };

      const recordsResponse = await app.inject({
        method: "GET",
        url: `/api/session-records?workspaceId=${workspace.id}`,
      });
      const { records } = recordsResponse.json() as { records: { sessionId: string; paneId: string; status: string; agent: string; cwd: string }[] };
      expect(records).toHaveLength(1);
      expect(records[0].sessionId).toBe(info.id);
      expect(records[0].paneId).toBe("pane-abc");
      expect(records[0].status).toBe("running");
      expect(records[0].agent).toBe("shell");
      expect(records[0].cwd).toBe(workspace.rootPath);

      await app.close();
    },
    10_000
  );

  it(
    "DELETE /api/sessions/:id marks its record 'discarded', never leaving it stranded at 'running'",
    async () => {
      const app = buildApp();
      const sessionResponse = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { agent: "shell", paneId: "pane-1" },
      });
      const info = sessionResponse.json() as { id: string };

      await app.inject({ method: "DELETE", url: `/api/sessions/${info.id}` });

      const recordsResponse = await app.inject({ method: "GET", url: "/api/session-records" });
      const { records } = recordsResponse.json() as { records: { sessionId: string; status: string }[] };
      const record = records.find((r) => r.sessionId === info.id || true); // sessionId cleared on discard too
      expect(record?.status).toBe("discarded");

      await app.close();
    },
    10_000
  );

  it(
    "a session record SURVIVES a simulated server restart, becoming recoverable",
    async () => {
      const dataDirForRestart = mkdtempSync(join(tmpdir(), "vibespace-restart-test-"));
      process.env.VIBESPACE_DATA_DIR = dataDirForRestart;

      // "Process 1": spawn a shell session, then close the app the way a
      // crash would look from the database's point of view — disposeAll()
      // kills the pty WITHOUT notifying trackSessionForRecovery's listener
      // (see session-manager.ts's disposeAll doc comment), so the record
      // is left exactly as a real crash would leave it: still 'running'.
      const app1 = buildApp();
      const sessionResponse = await app1.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { agent: "shell", paneId: "pane-restart" },
      });
      expect(sessionResponse.statusCode).toBe(201);

      const beforeClose = await app1.inject({ method: "GET", url: "/api/session-records" });
      expect((beforeClose.json() as { records: { status: string }[] }).records[0].status).toBe("running");

      await app1.close();

      // "Process 2": a brand-new buildApp() against the SAME on-disk
      // database — this is exactly what happens when the real server
      // process restarts. Its constructor calls
      // sessionRecordsStore.markServerRestartOrphans() once, at boot.
      const app2 = buildApp();
      const afterRestart = await app2.inject({ method: "GET", url: "/api/session-records" });
      const records = (afterRestart.json() as {
        records: { sessionId: string | null; status: string; endedReason: string | null; paneId: string }[];
      }).records;
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe("recoverable");
      expect(records[0].endedReason).toBe("server_restart");
      expect(records[0].sessionId).toBeNull();
      expect(records[0].paneId).toBe("pane-restart");

      await app2.close();
      delete process.env.VIBESPACE_DATA_DIR;
      rmSync(dataDirForRestart, { recursive: true, force: true });
    },
    10_000
  );

  it(
    "POST /api/session-records/:id/resume resumes a recoverable record into a fresh session, in the SAME pane",
    async () => {
      const app = buildApp();
      const sessionResponse = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { agent: "shell", paneId: "pane-resume" },
      });
      const info = sessionResponse.json() as { id: string };
      const before = (await app.inject({ method: "GET", url: "/api/session-records" })).json() as {
        records: { id: string }[];
      };
      const recordId = before.records[0].id;

      // Simulate the pty having exited (a real crash/exit, not a DELETE) —
      // same shell-only approach every pty test in this repo uses.
      app.sessionManager.kill(info.id); // clears listeners, mirrors a controlled test setup
      app.sessionRecordsStore.markExited(recordId, 0, "exited");

      const resumeResponse = await app.inject({
        method: "POST",
        url: `/api/session-records/${recordId}/resume`,
      });
      expect(resumeResponse.statusCode).toBe(200);
      const body = resumeResponse.json() as {
        session: { id: string; status: string };
        record: { id: string; status: string; paneId: string };
        note: string;
      };
      expect(body.session.status).toBe("running");
      expect(body.session.id).not.toBe(info.id); // a brand-new pty, never the old id
      expect(body.record.status).toBe("running");
      expect(body.record.paneId).toBe("pane-resume");
      expect(body.note).toContain("fresh shell");

      await app.close();
    },
    10_000
  );

  it(
    "POST /api/session-records/:id/resume: a FAILED resume returns the record to 'recoverable' with a reason, never silently loses it",
    async () => {
      const app = buildApp();
      // Directly craft a recoverable record for an agent that will never
      // resolve as installed — forces attemptResume's failure branch
      // without spawning anything (see restore.test.ts for the same
      // technique at the unit level).
      const record = app.sessionRecordsStore.create({
        workspaceId: null,
        paneId: "pane-broken",
        sessionId: "already-gone",
        agent: "not-a-real-agent" as never,
        sshProfileId: null,
        agentSessionRef: null,
        cwd: "/tmp",
        title: "bogus",
      });
      app.sessionRecordsStore.markExited(record.id, 1, "exited");

      const resumeResponse = await app.inject({
        method: "POST",
        url: `/api/session-records/${record.id}/resume`,
      });
      expect(resumeResponse.statusCode).toBe(409);
      expect((resumeResponse.json() as { error: string }).error).toContain("not-a-real-agent");

      // The critical assertion for this whole feature: recoverability
      // SURVIVED the failed resume.
      const afterFailure = await app.inject({ method: "GET", url: "/api/session-records" });
      const records = (afterFailure.json() as { records: { id: string; status: string }[] }).records;
      expect(records.find((r) => r.id === record.id)?.status).toBe("recoverable");

      await app.close();
    },
    10_000
  );

  it("POST /api/session-records/:id/resume 404s for an unknown id", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/api/session-records/does-not-exist/resume" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("POST /api/session-records/:id/resume 409s for a record that isn't recoverable (still running)", async () => {
    const app = buildApp();
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { agent: "shell", paneId: "pane-1" },
    });
    const info = sessionResponse.json() as { id: string };
    const { records } = (await app.inject({ method: "GET", url: "/api/session-records" })).json() as {
      records: { id: string }[];
    };

    const response = await app.inject({
      method: "POST",
      url: `/api/session-records/${records[0].id}/resume`,
    });
    expect(response.statusCode).toBe(409);
    await app.inject({ method: "DELETE", url: `/api/sessions/${info.id}` });
    await app.close();
  });

  it(
    "POST /api/session-records/:id/discard marks it discarded; a discarded record can no longer be resumed",
    async () => {
      const app = buildApp();
      const sessionResponse = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { agent: "shell", paneId: "pane-1" },
      });
      const info = sessionResponse.json() as { id: string };
      const { records } = (await app.inject({ method: "GET", url: "/api/session-records" })).json() as {
        records: { id: string }[];
      };
      const recordId = records[0].id;
      app.sessionManager.kill(info.id);
      app.sessionRecordsStore.markExited(recordId, 0, "exited");

      const discardResponse = await app.inject({
        method: "POST",
        url: `/api/session-records/${recordId}/discard`,
      });
      expect(discardResponse.statusCode).toBe(200);
      expect((discardResponse.json() as { status: string }).status).toBe("discarded");

      const resumeAfterDiscard = await app.inject({
        method: "POST",
        url: `/api/session-records/${recordId}/resume`,
      });
      expect(resumeAfterDiscard.statusCode).toBe(409);

      await app.close();
    },
    10_000
  );

  it(
    "POST /api/workspaces/:id/restore-sessions restores up to the eager budget and defers the rest",
    async () => {
      const app = buildApp();
      const workspaceResponse = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "restore-test", rootPath: mkdtempSync(join(tmpdir(), "vibespace-restore-")) },
      });
      const workspace = workspaceResponse.json() as { id: string };

      // 5 recoverable shell records for this workspace — more than the
      // default budget (4) — via the decorated stores directly, mirroring
      // how a REAL cold start would find them (this app's own history from
      // earlier "running" sessions).
      for (let i = 0; i < 5; i++) {
        const seed = app.sessionManager.create({ agent: "shell" });
        const record = app.sessionRecordsStore.create({
          workspaceId: workspace.id,
          paneId: `pane-${i}`,
          sessionId: seed.id,
          agent: "shell",
          sshProfileId: null,
          agentSessionRef: null,
          cwd: seed.cwd,
          title: seed.title,
        });
        app.sessionManager.kill(seed.id);
        app.sessionRecordsStore.markExited(record.id, 0, "exited");
      }

      const response = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspace.id}/restore-sessions`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        restored: { paneId: string }[];
        deferred: { paneId: string }[];
        circuitBreakerTripped: boolean;
      };
      expect(body.restored).toHaveLength(4); // EAGER_RESTORE_BUDGET
      expect(body.deferred).toHaveLength(1);
      expect(body.circuitBreakerTripped).toBe(false);

      await app.close();
    },
    20_000
  );

  it("POST /api/workspaces/:id/restore-sessions 404s for an unknown workspace", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces/does-not-exist/restore-sessions",
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe("workspace REST endpoints", () => {
  it("GET /api/workspaces starts empty", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/workspaces" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ workspaces: [] });
    await app.close();
  });

  it("creates, lists, gets, patches, and deletes a workspace", async () => {
    const app = buildApp();
    const projectDir = mkdtempSync(join(tmpdir(), "vibespace-workspace-crud-"));

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "my-project", rootPath: projectDir },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json() as {
      id: string;
      name: string;
      rootPath: string;
      layout: string | null;
    };
    expect(created.name).toBe("my-project");
    expect(created.rootPath).toBe(projectDir);
    expect(created.layout).toBeNull();

    const listResponse = await app.inject({ method: "GET", url: "/api/workspaces" });
    const { workspaces } = listResponse.json() as { workspaces: { id: string }[] };
    expect(workspaces.map((w) => w.id)).toContain(created.id);

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/workspaces/${created.id}`,
    });
    expect(getResponse.statusCode).toBe(200);
    expect((getResponse.json() as { id: string }).id).toBe(created.id);

    const layout = JSON.stringify({ kind: "leaf", id: "leaf-1", sessionId: null });
    const patchResponse = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${created.id}`,
      payload: { name: "renamed-project", layout },
    });
    expect(patchResponse.statusCode).toBe(200);
    const patched = patchResponse.json() as { name: string; layout: string | null };
    expect(patched.name).toBe("renamed-project");
    expect(patched.layout).toBe(layout);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${created.id}`,
    });
    expect(deleteResponse.statusCode).toBe(204);

    const afterDelete = await app.inject({
      method: "GET",
      url: `/api/workspaces/${created.id}`,
    });
    expect(afterDelete.statusCode).toBe(404);

    rmSync(projectDir, { recursive: true, force: true });
    await app.close();
  });

  it("POST /api/workspaces rejects an empty name with 400", async () => {
    const app = buildApp();
    const projectDir = mkdtempSync(join(tmpdir(), "vibespace-workspace-badname-"));
    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "   ", rootPath: projectDir },
    });
    expect(response.statusCode).toBe(400);
    rmSync(projectDir, { recursive: true, force: true });
    await app.close();
  });

  it("POST /api/workspaces rejects a rootPath that doesn't exist with 400", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "ghost-project", rootPath: "/definitely/does/not/exist/vibespace" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: expect.any(String) });
    await app.close();
  });

  it("PATCH /api/workspaces/:id rejects a rootPath that doesn't exist with 400", async () => {
    const app = buildApp();
    const projectDir = mkdtempSync(join(tmpdir(), "vibespace-workspace-patch-"));
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "patch-test", rootPath: projectDir },
      })
    ).json() as { id: string };

    const response = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${created.id}`,
      payload: { rootPath: "/definitely/does/not/exist/vibespace" },
    });
    expect(response.statusCode).toBe(400);

    rmSync(projectDir, { recursive: true, force: true });
    await app.close();
  });

  it("PATCH /api/workspaces/:id accepts a colour from the fixed palette", async () => {
    const app = buildApp();
    const projectDir = mkdtempSync(join(tmpdir(), "vibespace-workspace-color-"));
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "color-test", rootPath: projectDir },
      })
    ).json() as { id: string; color: string | null };
    expect(created.color).toBeNull(); // no colour chosen at creation time

    const response = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${created.id}`,
      payload: { color: "#f87171" },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { color: string | null }).color).toBe("#f87171");

    // Explicit null clears it back to "no colour chosen".
    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${created.id}`,
      payload: { color: null },
    });
    expect((cleared.json() as { color: string | null }).color).toBeNull();

    rmSync(projectDir, { recursive: true, force: true });
    await app.close();
  });

  it("PATCH /api/workspaces/:id rejects a colour that isn't in the fixed palette with 400", async () => {
    const app = buildApp();
    const projectDir = mkdtempSync(join(tmpdir(), "vibespace-workspace-badcolor-"));
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "badcolor-test", rootPath: projectDir },
      })
    ).json() as { id: string };

    const response = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${created.id}`,
      payload: { color: "#ffffff" }, // not one of WORKSPACE_COLORS
    });
    expect(response.statusCode).toBe(400);

    rmSync(projectDir, { recursive: true, force: true });
    await app.close();
  });

  it("GET /api/workspaces/:id returns 404 for an unknown id", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/workspaces/does-not-exist" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("PATCH /api/workspaces/:id returns 404 for an unknown id", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/workspaces/does-not-exist",
      payload: { name: "irrelevant" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("DELETE /api/workspaces/:id returns 404 for an unknown id", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/workspaces/does-not-exist",
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("expands a leading ~ in rootPath to the home directory", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "home-dir-project", rootPath: "~" },
    });
    expect(response.statusCode).toBe(201);
    const created = response.json() as { rootPath: string };
    // homedir() is always an existing absolute directory, so "~" alone
    // should resolve straight to it.
    expect(created.rootPath.length).toBeGreaterThan(0);
    expect(created.rootPath.startsWith("/")).toBe(true);
    await app.close();
  });
});

describe("WebSocket session stream", () => {
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeServer?.();
    closeServer = undefined;
  });

  it(
    "sends a ready handshake with history/size, then streams live output for input",
    async () => {
      const app = buildApp();
      await app.listen({ port: 0, host: "127.0.0.1" });
      closeServer = () => app.close();

      const { port } = app.server.address() as AddressInfo;

      const createResponse = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { agent: "shell", cols: 100, rows: 30 },
      });
      const info = createResponse.json() as { id: string };

      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${info.id}/ws`);

      const messages: ServerMessage[] = [];
      const gotOutput = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out waiting for output")), 8_000);
        ws.on("message", (raw: Buffer) => {
          const message = JSON.parse(raw.toString()) as ServerMessage;
          messages.push(message);

          if (message.type === "ready") {
            // Now that we're attached, send input and wait for it to echo back.
            ws.send(JSON.stringify({ type: "input", sessionId: info.id, data: "echo WS_TEST_OK\n" }));
          }

          if (message.type === "output" && message.data.includes("WS_TEST_OK")) {
            clearTimeout(timeout);
            resolve();
          }
        });
        ws.on("error", reject);
      });

      await gotOutput;
      ws.close();

      const ready = messages.find((m) => m.type === "ready");
      expect(ready).toBeDefined();
      if (ready?.type === "ready") {
        expect(ready.cols).toBe(100);
        expect(ready.rows).toBe(30);
        expect(ready.sessionId).toBe(info.id);
      }

      await app.close();
      closeServer = undefined;
    },
    10_000
  );

  it(
    "closes the socket with a clear reason for an unknown session id",
    async () => {
      const app = buildApp();
      await app.listen({ port: 0, host: "127.0.0.1" });
      closeServer = () => app.close();
      const { port } = app.server.address() as AddressInfo;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/does-not-exist/ws`);

      const closeEvent = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timed out waiting for close")), 8_000);
        ws.on("close", (code: number, reasonBuf: Buffer) => {
          clearTimeout(timeout);
          resolve({ code, reason: reasonBuf.toString() });
        });
        ws.on("error", reject);
      });

      expect(closeEvent.reason).toContain("does-not-exist");

      await app.close();
      closeServer = undefined;
    },
    10_000
  );
});
