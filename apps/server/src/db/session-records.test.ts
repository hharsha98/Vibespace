/**
 * CRUD + lifecycle tests for SessionRecordsStore, run against a real SQLite
 * file — but always inside a fresh `mkdtempSync` temp directory, never the
 * developer's real `~/.vibespace`. Same pattern as `workspaces.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRecordsStore } from "./session-records.js";

let dataDir: string;
let store: SessionRecordsStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibespace-session-records-test-"));
  process.env.VIBESPACE_DATA_DIR = dataDir;
  store = new SessionRecordsStore();
});

afterEach(() => {
  store.close();
  delete process.env.VIBESPACE_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("SessionRecordsStore", () => {
  it("starts empty", () => {
    expect(store.list()).toEqual([]);
  });

  it("create() records at spawn time with status 'running' and no end info", () => {
    const record = store.create({
      workspaceId: "ws-1",
      paneId: "pane-1",
      sessionId: "session-1",
      agent: "shell",
      sshProfileId: null,
      agentSessionRef: null,
      cwd: "/tmp/project",
      title: "shell",
    });

    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.workspaceId).toBe("ws-1");
    expect(record.paneId).toBe("pane-1");
    expect(record.sessionId).toBe("session-1");
    expect(record.agent).toBe("shell");
    expect(record.status).toBe("running");
    expect(record.endedAt).toBeNull();
    expect(record.endedReason).toBeNull();
    expect(record.exitCode).toBeNull();
    expect(Number.isNaN(new Date(record.startedAt).getTime())).toBe(false);
    expect(record.createdAt).toBe(record.updatedAt);
  });

  it("get() returns undefined for an unknown id", () => {
    expect(store.get("does-not-exist")).toBeUndefined();
  });

  it("list() returns every record, most-recently-updated first", async () => {
    const a = store.create({
      workspaceId: "ws-1",
      paneId: "pane-a",
      sessionId: "session-a",
      agent: "shell",
      sshProfileId: null,
      agentSessionRef: null,
      cwd: "/tmp/a",
      title: "shell",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = store.create({
      workspaceId: "ws-1",
      paneId: "pane-b",
      sessionId: "session-b",
      agent: "shell",
      sshProfileId: null,
      agentSessionRef: null,
      cwd: "/tmp/b",
      title: "shell",
    });

    expect(store.list().map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it("list(workspaceId) scopes to just that workspace", () => {
    store.create({
      workspaceId: "ws-1",
      paneId: "pane-1",
      sessionId: "session-1",
      agent: "shell",
      sshProfileId: null,
      agentSessionRef: null,
      cwd: "/tmp/a",
      title: "shell",
    });
    const other = store.create({
      workspaceId: "ws-2",
      paneId: "pane-2",
      sessionId: "session-2",
      agent: "shell",
      sshProfileId: null,
      agentSessionRef: null,
      cwd: "/tmp/b",
      title: "shell",
    });

    const scoped = store.list("ws-2");
    expect(scoped).toHaveLength(1);
    expect(scoped[0].id).toBe(other.id);
  });

  it("markExited() transitions to 'recoverable', clears session_id, and records exit info", () => {
    const record = store.create({
      workspaceId: "ws-1",
      paneId: "pane-1",
      sessionId: "session-1",
      agent: "shell",
      sshProfileId: null,
      agentSessionRef: null,
      cwd: "/tmp/a",
      title: "shell",
    });

    const updated = store.markExited(record.id, 1, "exited");
    expect(updated?.status).toBe("recoverable");
    expect(updated?.sessionId).toBeNull();
    expect(updated?.exitCode).toBe(1);
    expect(updated?.endedReason).toBe("exited");
    expect(updated?.endedAt).not.toBeNull();
  });

  it("markResumed() transitions back to 'running', points at the NEW session id, and clears end info", () => {
    const record = store.create({
      workspaceId: "ws-1",
      paneId: "pane-1",
      sessionId: "session-1",
      agent: "shell",
      sshProfileId: null,
      agentSessionRef: null,
      cwd: "/tmp/a",
      title: "shell",
    });
    store.markExited(record.id, 0, "exited");

    const resumed = store.markResumed(record.id, "session-2");
    expect(resumed?.status).toBe("running");
    expect(resumed?.sessionId).toBe("session-2");
    expect(resumed?.endedAt).toBeNull();
    expect(resumed?.endedReason).toBeNull();
    expect(resumed?.exitCode).toBeNull();
  });

  it("markDiscarded() transitions to 'discarded'", () => {
    const record = store.create({
      workspaceId: "ws-1",
      paneId: "pane-1",
      sessionId: "session-1",
      agent: "shell",
      sshProfileId: null,
      agentSessionRef: null,
      cwd: "/tmp/a",
      title: "shell",
    });
    store.markExited(record.id, 0, "exited");

    const discarded = store.markDiscarded(record.id);
    expect(discarded?.status).toBe("discarded");
  });

  it("listRecoverable() returns only 'recoverable' records for one workspace, oldest-started first", async () => {
    const running = store.create({
      workspaceId: "ws-1",
      paneId: "pane-running",
      sessionId: "session-running",
      agent: "shell",
      sshProfileId: null,
      agentSessionRef: null,
      cwd: "/tmp/a",
      title: "shell",
    });
    const recoverable1 = store.create({
      workspaceId: "ws-1",
      paneId: "pane-1",
      sessionId: "session-1",
      agent: "shell",
      sshProfileId: null,
      agentSessionRef: null,
      cwd: "/tmp/b",
      title: "shell",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const recoverable2 = store.create({
      workspaceId: "ws-1",
      paneId: "pane-2",
      sessionId: "session-2",
      agent: "shell",
      sshProfileId: null,
      agentSessionRef: null,
      cwd: "/tmp/c",
      title: "shell",
    });
    const otherWorkspace = store.create({
      workspaceId: "ws-2",
      paneId: "pane-3",
      sessionId: "session-3",
      agent: "shell",
      sshProfileId: null,
      agentSessionRef: null,
      cwd: "/tmp/d",
      title: "shell",
    });

    store.markExited(recoverable1.id, 0, "exited");
    store.markExited(recoverable2.id, 0, "exited");
    store.markExited(otherWorkspace.id, 0, "exited");
    // `running` deliberately left in 'running' status.

    const recoverable = store.listRecoverable("ws-1");
    expect(recoverable.map((r) => r.id)).toEqual([recoverable1.id, recoverable2.id]);
    expect(recoverable.every((r) => r.status === "recoverable")).toBe(true);
    expect(recoverable.map((r) => r.id)).not.toContain(running.id);
  });

  it("markServerRestartOrphans() bulk-transitions every 'running' record to 'recoverable' with reason 'server_restart', and returns the count touched", () => {
    const a = store.create({
      workspaceId: "ws-1",
      paneId: "pane-a",
      sessionId: "session-a",
      agent: "shell",
      sshProfileId: null,
      agentSessionRef: null,
      cwd: "/tmp/a",
      title: "shell",
    });
    const b = store.create({
      workspaceId: "ws-1",
      paneId: "pane-b",
      sessionId: "session-b",
      agent: "claude",
      sshProfileId: null,
      agentSessionRef: "claude-uuid",
      cwd: "/tmp/b",
      title: "claude",
    });
    // A record already discarded should NOT be resurrected by a restart.
    const c = store.create({
      workspaceId: "ws-1",
      paneId: "pane-c",
      sessionId: "session-c",
      agent: "shell",
      sshProfileId: null,
      agentSessionRef: null,
      cwd: "/tmp/c",
      title: "shell",
    });
    store.markDiscarded(c.id);

    const touched = store.markServerRestartOrphans();
    expect(touched).toBe(2);

    const afterRestart = new Map(store.list().map((r) => [r.id, r]));
    expect(afterRestart.get(a.id)?.status).toBe("recoverable");
    expect(afterRestart.get(a.id)?.endedReason).toBe("server_restart");
    expect(afterRestart.get(a.id)?.sessionId).toBeNull();
    expect(afterRestart.get(b.id)?.status).toBe("recoverable");
    expect(afterRestart.get(b.id)?.endedReason).toBe("server_restart");
    // agentSessionRef survives a restart untouched — it's what lets a
    // subsequent resume still target the right claude conversation.
    expect(afterRestart.get(b.id)?.agentSessionRef).toBe("claude-uuid");
    expect(afterRestart.get(c.id)?.status).toBe("discarded");
  });

  it("claim() transitions 'recoverable' -> 'running' and returns true", () => {
    const record = store.create({
      workspaceId: "ws-1",
      paneId: "pane-1",
      sessionId: "session-1",
      agent: "shell",
      sshProfileId: null,
      agentSessionRef: null,
      cwd: "/tmp/a",
      title: "shell",
    });
    store.markExited(record.id, 0, "exited");

    expect(store.claim(record.id)).toBe(true);
    expect(store.get(record.id)?.status).toBe("running");
  });

  it("claim() returns false (and does nothing) for a record that ISN'T recoverable", () => {
    const record = store.create({
      workspaceId: "ws-1",
      paneId: "pane-1",
      sessionId: "session-1",
      agent: "shell",
      sshProfileId: null,
      agentSessionRef: null,
      cwd: "/tmp/a",
      title: "shell",
    });
    // Still 'running' — never marked exited.
    expect(store.claim(record.id)).toBe(false);
    expect(store.get(record.id)?.status).toBe("running");
  });

  it("claim() is exclusive: a SECOND claim on an already-claimed record returns false", () => {
    const record = store.create({
      workspaceId: "ws-1",
      paneId: "pane-1",
      sessionId: "session-1",
      agent: "shell",
      sshProfileId: null,
      agentSessionRef: null,
      cwd: "/tmp/a",
      title: "shell",
    });
    store.markExited(record.id, 0, "exited");

    expect(store.claim(record.id)).toBe(true); // first caller wins
    expect(store.claim(record.id)).toBe(false); // second caller loses — already 'running'
  });

  it("markServerRestartOrphans() is a no-op (returns 0) when nothing is 'running'", () => {
    const record = store.create({
      workspaceId: "ws-1",
      paneId: "pane-1",
      sessionId: "session-1",
      agent: "shell",
      sshProfileId: null,
      agentSessionRef: null,
      cwd: "/tmp/a",
      title: "shell",
    });
    store.markExited(record.id, 0, "exited");

    expect(store.markServerRestartOrphans()).toBe(0);
  });
});
