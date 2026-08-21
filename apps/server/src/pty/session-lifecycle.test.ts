/**
 * Tests for `trackSessionForRecovery` — the mechanism that returns a
 * SessionRecord to 'recoverable' when its pty exits, distinguishing an
 * ordinary exit from a fast-failing RESUME attempt (see this file's own
 * top comment for why that distinction matters).
 *
 * Uses the "shell" agent only (never claude/cursor-agent/codex — CI has
 * none of those installed) and a real SessionManager, same convention as
 * `session-manager.test.ts`. A resume "failure" is simulated honestly: the
 * shell is told to `exit 1` immediately, which is exactly what a CLI
 * rejecting a bad flag or crashing on startup looks like from the outside
 * (a pty that exits almost instantly with a non-zero code) — no fake agent
 * binaries needed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";
import { SessionRecordsStore } from "../db/session-records.js";
import { RESUME_FAILURE_WINDOW_MS, trackSessionForRecovery } from "./session-lifecycle.js";

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition never became true within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let dataDir: string;
let manager: SessionManager;
let store: SessionRecordsStore;

function setup() {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-session-lifecycle-test-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;
  manager = new SessionManager();
  store = new SessionRecordsStore();
}

afterEach(() => {
  manager?.disposeAll();
  store?.close();
  delete process.env.VIBEDECK_DATA_DIR;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("trackSessionForRecovery", () => {
  it(
    "an ordinary (non-resume) exit marks the record 'recoverable' with reason 'exited'",
    async () => {
      setup();
      const session = manager.create({ agent: "shell" });
      const record = store.create({
        workspaceId: "ws-1",
        paneId: "pane-1",
        sessionId: session.id,
        agent: "shell",
        sshProfileId: null,
        agentSessionRef: null,
        cwd: session.cwd,
        title: session.title,
      });

      trackSessionForRecovery(manager, store, session.id, record.id, false);

      manager.write(session.id, "exit 0\n");
      await waitFor(() => store.get(record.id)?.status === "recoverable");

      const updated = store.get(record.id);
      expect(updated?.status).toBe("recoverable");
      expect(updated?.endedReason).toBe("exited");
      expect(updated?.exitCode).toBe(0);
      expect(updated?.sessionId).toBeNull();
    },
    10_000
  );

  it(
    "a resume attempt that exits almost immediately is classified 'resume_failed', and the record is recoverable again",
    async () => {
      setup();
      const session = manager.create({ agent: "shell" });
      const record = store.create({
        workspaceId: "ws-1",
        paneId: "pane-1",
        sessionId: session.id,
        agent: "shell",
        sshProfileId: null,
        agentSessionRef: null,
        cwd: session.cwd,
        title: session.title,
      });
      // Simulate "this record was already recoverable, and we just
      // resumed it" — mirrors what attemptResume() does before calling
      // trackSessionForRecovery with isResumeAttempt = true.
      store.markResumed(record.id, session.id);

      trackSessionForRecovery(manager, store, session.id, record.id, true);

      // A CLI rejecting a bad flag / crashing on startup looks, from the
      // outside, exactly like this: exits almost immediately, non-zero.
      manager.write(session.id, "exit 1\n");
      await waitFor(() => store.get(record.id)?.status === "recoverable");

      const updated = store.get(record.id);
      // The critical assertion: recoverability SURVIVED the failed
      // resume — the record is back to 'recoverable', not stuck at
      // 'running' or lost.
      expect(updated?.status).toBe("recoverable");
      expect(updated?.endedReason).toBe("resume_failed");
      expect(updated?.exitCode).toBe(1);
    },
    10_000
  );

  it(
    "a resume that outlives the failure window before exiting is classified as a plain 'exited', not 'resume_failed'",
    async () => {
      setup();
      const session = manager.create({ agent: "shell" });
      const record = store.create({
        workspaceId: "ws-1",
        paneId: "pane-1",
        sessionId: session.id,
        agent: "shell",
        sshProfileId: null,
        agentSessionRef: null,
        cwd: session.cwd,
        title: session.title,
      });
      store.markResumed(record.id, session.id);

      trackSessionForRecovery(manager, store, session.id, record.id, true);

      // Sleep past RESUME_FAILURE_WINDOW_MS (a few hundred ms of margin),
      // THEN exit — the outside-observable shape of "the resumed CLI
      // genuinely ran for a while before ending", not a broken resume.
      manager.write(session.id, `sleep ${(RESUME_FAILURE_WINDOW_MS + 500) / 1000}; exit 0\n`);

      await waitFor(() => store.get(record.id)?.status === "recoverable", RESUME_FAILURE_WINDOW_MS + 5000);

      const updated = store.get(record.id);
      expect(updated?.status).toBe("recoverable");
      expect(updated?.endedReason).toBe("exited");
    },
    RESUME_FAILURE_WINDOW_MS + 10_000
  );

  it(
    "does nothing until the session actually exits — a still-running session's record stays untouched",
    async () => {
      setup();
      const session = manager.create({ agent: "shell" });
      const record = store.create({
        workspaceId: "ws-1",
        paneId: "pane-1",
        sessionId: session.id,
        agent: "shell",
        sshProfileId: null,
        agentSessionRef: null,
        cwd: session.cwd,
        title: session.title,
      });

      trackSessionForRecovery(manager, store, session.id, record.id, false);

      // Give the (still-running) shell a brief moment, then assert nothing
      // changed — no exit event has fired.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(store.get(record.id)?.status).toBe("running");
    },
    10_000
  );
});
