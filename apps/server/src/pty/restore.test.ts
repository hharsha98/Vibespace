/**
 * Integration-ish tests for `attemptResume`/`restoreWorkspaceSessions` —
 * real `SessionManager` + real (temp-dir) `SessionRecordsStore`/
 * `SshProfileStore`, "shell" agent only (never a real claude/codex/
 * cursor-agent CLI — CI has none installed). Circuit-breaker/failure paths
 * are exercised with a deliberately-bogus `AgentId` value that
 * `detectAllAgents()` will correctly report as unavailable — this fails
 * `attemptResume` WITHOUT ever calling `pty.spawn`, so "repeated spawn
 * failures" can be simulated deterministically without a flaky real binary.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "@vibedeck/shared";
import { SessionManager } from "./session-manager.js";
import { SessionRecordsStore } from "../db/session-records.js";
import { SshProfileStore } from "../ssh/store.js";
import { attemptResume, restoreWorkspaceSessions } from "./restore.js";

let dataDir: string;
let manager: SessionManager;
let recordsStore: SessionRecordsStore;
let sshStore: SshProfileStore;

function setup() {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-restore-test-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;
  manager = new SessionManager();
  recordsStore = new SessionRecordsStore();
  sshStore = new SshProfileStore();
}

afterEach(() => {
  manager?.disposeAll();
  recordsStore?.close();
  sshStore?.close();
  delete process.env.VIBEDECK_DATA_DIR;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

function makeRecoverableShellRecord(workspaceId: string, paneId: string) {
  const seed = manager.create({ agent: "shell" });
  const record = recordsStore.create({
    workspaceId,
    paneId,
    sessionId: seed.id,
    agent: "shell",
    sshProfileId: null,
    agentSessionRef: null,
    cwd: seed.cwd,
    title: seed.title,
  });
  manager.kill(seed.id);
  return recordsStore.markExited(record.id, 0, "exited")!;
}

function makeRecoverableBogusAgentRecord(workspaceId: string, paneId: string) {
  // A record for an agent id that will never resolve as "installed" — used
  // to force attemptResume's failure branch WITHOUT spawning anything.
  const record = recordsStore.create({
    workspaceId,
    paneId,
    sessionId: "already-gone",
    agent: "not-a-real-agent" as AgentId,
    sshProfileId: null,
    agentSessionRef: null,
    cwd: "/tmp/bogus",
    title: "bogus",
  });
  return recordsStore.markExited(record.id, 1, "exited")!;
}

describe("attemptResume", () => {
  it(
    "resumes a recoverable shell record: spawns fresh, marks 'running' with the new session id",
    async () => {
      setup();
      const record = makeRecoverableShellRecord("ws-1", "pane-1");

      const result = await attemptResume(manager, recordsStore, sshStore, record, 80, 24);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.session.id).not.toBe(record.sessionId);
      expect(result.session.status).toBe("running");
      expect(result.record.status).toBe("running");
      expect(result.record.sessionId).toBe(result.session.id);
      expect(result.note).toContain("fresh shell");
    },
    10_000
  );

  it(
    "a missing agent leaves the record UNCHANGED (still 'recoverable') and returns an error",
    async () => {
      setup();
      const record = makeRecoverableBogusAgentRecord("ws-1", "pane-1");

      const result = await attemptResume(manager, recordsStore, sshStore, record, 80, 24);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("not-a-real-agent");

      // Recoverability SURVIVED the failed resume attempt — the record was
      // never mutated.
      const stillRecoverable = recordsStore.get(record.id);
      expect(stillRecoverable?.status).toBe("recoverable");
    },
    10_000
  );

  it(
    "TWO CONCURRENT resume attempts on the same record: exactly one wins, the other fails cleanly with no leaked pty (regression test for a race found during manual verification)",
    async () => {
      setup();
      const record = makeRecoverableShellRecord("ws-1", "pane-1");

      const [first, second] = await Promise.all([
        attemptResume(manager, recordsStore, sshStore, record, 80, 24),
        attemptResume(manager, recordsStore, sshStore, record, 80, 24),
      ]);

      const results = [first, second];
      const wins = results.filter((r) => r.ok);
      const losses = results.filter((r) => !r.ok);
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);
      if (!losses[0].ok) {
        expect(losses[0].error).toContain("already resumed or discarded");
      }

      // Exactly ONE new pty should have been spawned — not two. manager
      // only ever tracks live sessions, so its list length is the ground
      // truth for "how many real processes exist right now".
      expect(manager.list()).toHaveLength(1);

      // The record itself ends up 'running', pointing at the ONE winning
      // session — never left in limbo.
      const final = recordsStore.get(record.id);
      expect(final?.status).toBe("running");
      if (wins[0].ok) {
        expect(final?.sessionId).toBe(wins[0].session.id);
      }
    },
    10_000
  );

  it(
    "a record referencing a deleted SSH profile fails cleanly, record stays recoverable",
    async () => {
      setup();
      const record = recordsStore.create({
        workspaceId: "ws-1",
        paneId: "pane-1",
        sessionId: "gone",
        agent: "shell",
        sshProfileId: "does-not-exist",
        agentSessionRef: null,
        cwd: "/tmp/remote",
        title: "some-profile",
      });
      recordsStore.markExited(record.id, 0, "exited");
      const recoverable = recordsStore.get(record.id)!;

      const result = await attemptResume(manager, recordsStore, sshStore, recoverable, 80, 24);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("SSH profile");
      expect(recordsStore.get(record.id)?.status).toBe("recoverable");
    },
    10_000
  );
});

describe("restoreWorkspaceSessions (bounded budget + circuit breaker, end to end)", () => {
  it(
    "restores up to `budget` recoverable panes eagerly and defers the rest",
    async () => {
      setup();
      const records = [
        makeRecoverableShellRecord("ws-1", "pane-1"),
        makeRecoverableShellRecord("ws-1", "pane-2"),
        makeRecoverableShellRecord("ws-1", "pane-3"),
      ];

      const result = await restoreWorkspaceSessions(manager, recordsStore, sshStore, "ws-1", 2);

      expect(result.restored).toHaveLength(2);
      expect(result.deferred).toHaveLength(1);
      expect(result.circuitBreakerTripped).toBe(false);

      const restoredPaneIds = result.restored.map((r) => r.paneId).sort();
      const deferredPaneIds = result.deferred.map((r) => r.paneId).sort();
      expect([...restoredPaneIds, ...deferredPaneIds].sort()).toEqual(
        records.map((r) => r.paneId).sort()
      );

      // Every restored pane's record actually flipped to 'running'.
      for (const restored of result.restored) {
        expect(recordsStore.get(restored.recordId)?.status).toBe("running");
      }
      // Every deferred pane's record is UNTOUCHED — still 'recoverable',
      // no pty spawned for it.
      for (const deferred of result.deferred) {
        expect(recordsStore.get(deferred.recordId)?.status).toBe("recoverable");
      }
    },
    15_000
  );

  it(
    "records with no paneId are never eagerly restored (nothing to attach into) — they simply don't appear",
    async () => {
      setup();
      const withPane = makeRecoverableShellRecord("ws-1", "pane-1");
      const paneless = recordsStore.create({
        workspaceId: "ws-1",
        paneId: null,
        sessionId: "gone",
        agent: "shell",
        sshProfileId: null,
        agentSessionRef: null,
        cwd: "/tmp/paneless",
        title: "shell",
      });
      recordsStore.markExited(paneless.id, 0, "exited");

      const result = await restoreWorkspaceSessions(manager, recordsStore, sshStore, "ws-1", 4);

      expect(result.restored.map((r) => r.recordId)).toEqual([withPane.id]);
      expect(result.deferred.map((r) => r.recordId)).not.toContain(paneless.id);
      // The paneless record is left alone entirely — still recoverable,
      // still visible in the plain History list.
      expect(recordsStore.get(paneless.id)?.status).toBe("recoverable");
    },
    10_000
  );

  it(
    "the circuit breaker trips after repeated failures and defers the rest of the batch WITHOUT attempting them",
    async () => {
      setup();
      // 5 bogus-agent records: the first 3 failures trip the breaker
      // (RESTORE_CIRCUIT_BREAKER_THRESHOLD=3), the last 2 are deferred by
      // the breaker itself, never even attempted.
      const records = [
        makeRecoverableBogusAgentRecord("ws-1", "pane-1"),
        makeRecoverableBogusAgentRecord("ws-1", "pane-2"),
        makeRecoverableBogusAgentRecord("ws-1", "pane-3"),
        makeRecoverableBogusAgentRecord("ws-1", "pane-4"),
        makeRecoverableBogusAgentRecord("ws-1", "pane-5"),
      ];

      const result = await restoreWorkspaceSessions(manager, recordsStore, sshStore, "ws-1", 10);

      expect(result.restored).toHaveLength(0);
      expect(result.circuitBreakerTripped).toBe(true);
      expect(result.deferred.map((d) => d.recordId).sort()).toEqual(records.map((r) => r.id).sort());

      // Every record is still 'recoverable' — a tripped breaker must never
      // leave anything half-mutated.
      for (const record of records) {
        expect(recordsStore.get(record.id)?.status).toBe("recoverable");
      }
    },
    15_000
  );

  it(
    "a healthy batch under the failure threshold never trips the breaker",
    async () => {
      setup();
      makeRecoverableShellRecord("ws-1", "pane-1");
      makeRecoverableShellRecord("ws-1", "pane-2");

      const result = await restoreWorkspaceSessions(manager, recordsStore, sshStore, "ws-1", 4);
      expect(result.circuitBreakerTripped).toBe(false);
      expect(result.restored).toHaveLength(2);
    },
    15_000
  );
});
