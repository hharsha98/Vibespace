/**
 * The async orchestration half of session recovery: actually spawning a
 * resume attempt (`attemptResume`, shared by the single-record "Resume"
 * button and the bulk cold-start path), and running a whole workspace's
 * cold-start restore under the bounded budget + circuit breaker from
 * `restore-budget.ts` (`restoreWorkspaceSessions`).
 *
 * Deliberately separate from `resume.ts` (pure "what flags does this agent
 * resume with" decisions) and `restore-budget.ts` (pure budget/breaker
 * maths) — this file is the only one of the three that touches
 * `SessionManager`/the stores/`node-pty`, so those two stay trivially
 * unit-testable and this one is where the actual spawning risk lives.
 */
import type { DeferredPane, RestoredPane, SessionInfo, SessionRecord } from "@vibespace/shared";
import type { SessionManager } from "./session-manager.js";
import type { SessionRecordsStore } from "../db/session-records.js";
import type { SshProfileStore } from "../ssh/store.js";
import { commandExists, detectAllAgents } from "./agents.js";
import { planResume } from "./resume.js";
import { trackSessionForRecovery } from "./session-lifecycle.js";
import { EAGER_RESTORE_BUDGET, RestoreCircuitBreaker, planRestore } from "./restore-budget.js";

export type AttemptResumeResult =
  | { ok: true; session: SessionInfo; record: SessionRecord; note: string }
  | { ok: false; error: string; installHint?: string | null };

/**
 * Attempts to resume ONE record's session. On success, spawns the fresh
 * pty, transitions the record to 'running' via `SessionRecordsStore.
 * markResumed`, and wires `trackSessionForRecovery` so a fast-failing
 * resume still lands the record back at 'recoverable' (see
 * `session-lifecycle.ts`). On failure — missing binary, missing SSH
 * profile, `ssh` itself not installed — the record is left EXACTLY as it
 * was (still 'recoverable'): this function never marks a record as
 * anything but 'running' on success, so there is nothing to "revert" on
 * failure, satisfying "a failed resume must return the session to
 * recoverable" by construction rather than by an extra rollback step.
 *
 * Shared by both `index.ts`'s single-record `POST
 * /api/session-records/:id/resume` route and `restoreWorkspaceSessions`
 * below, so the two paths can never diverge on what "resuming this record"
 * actually does.
 */
export async function attemptResume(
  sessionManager: SessionManager,
  recordsStore: SessionRecordsStore,
  sshProfileStore: SshProfileStore,
  record: SessionRecord,
  cols: number,
  rows: number
): Promise<AttemptResumeResult> {
  if (record.sshProfileId) {
    const profile = sshProfileStore.get(record.sshProfileId);
    if (!profile) {
      return { ok: false, error: "The SSH profile this session used no longer exists." };
    }
    if (!(await commandExists("ssh"))) {
      return {
        ok: false,
        error: `The "ssh" command isn't installed on this machine. Install an SSH client, then try again.`,
        installHint:
          "Install an OpenSSH client — e.g. 'xcode-select --install' on macOS, or your distro's openssh-client package on Linux.",
      };
    }

    // Atomic claim (see SessionRecordsStore.claim's own doc comment): stops
    // TWO concurrent resume attempts for the same record from both
    // spawning a real pty — only the caller that actually flips
    // 'recoverable' -> 'running' may proceed. Checked AFTER the cheap
    // pre-flight checks above (no point claiming something we already know
    // would fail), but BEFORE the real, side-effectful spawn below.
    if (!recordsStore.claim(record.id)) {
      return { ok: false, error: "This session was already resumed or discarded elsewhere." };
    }
    try {
      const session = sessionManager.create({
        agent: "shell",
        cwd: record.cwd,
        cols,
        rows,
        ssh: {
          profileId: profile.id,
          profileName: profile.name,
          host: profile.host,
          user: profile.user,
          port: profile.port,
          defaultDirectory: profile.defaultDirectory,
          startupCommand: profile.startupCommand,
        },
      });
      const updatedRecord = recordsStore.markResumed(record.id, session.id)!;
      trackSessionForRecovery(sessionManager, recordsStore, session.id, record.id, true);
      return {
        ok: true,
        session,
        record: updatedRecord,
        note: "Reconnected over SSH (fresh connection, same profile).",
      };
    } catch (err) {
      // The claim succeeded but the spawn itself blew up (e.g. a race
      // where `ssh` vanished between the check above and now) — release
      // the claim back to 'recoverable' rather than leaving the record
      // stuck 'running' with nothing actually running.
      recordsStore.markExited(record.id, null, "resume_failed");
      return { ok: false, error: err instanceof Error ? err.message : "Failed to spawn the resumed session." };
    }
  }

  const availability = await detectAllAgents();
  if (!availability[record.agent]) {
    return {
      ok: false,
      error: `The "${record.agent}" agent isn't installed on this machine anymore.`,
    };
  }

  if (!recordsStore.claim(record.id)) {
    return { ok: false, error: "This session was already resumed or discarded elsewhere." };
  }
  try {
    const plan = planResume(record);
    const session = sessionManager.create({
      agent: record.agent,
      cwd: record.cwd,
      cols,
      rows,
      extraArgs: plan.args,
    });
    const updatedRecord = recordsStore.markResumed(record.id, session.id)!;
    trackSessionForRecovery(sessionManager, recordsStore, session.id, record.id, true);
    return { ok: true, session, record: updatedRecord, note: plan.note };
  } catch (err) {
    recordsStore.markExited(record.id, null, "resume_failed");
    return { ok: false, error: err instanceof Error ? err.message : "Failed to spawn the resumed session." };
  }
}

export interface WorkspaceRestoreResult {
  restored: RestoredPane[];
  deferred: DeferredPane[];
  /** True if the circuit breaker tripped partway through this batch. */
  circuitBreakerTripped: boolean;
}

function toDeferredPane(record: SessionRecord): DeferredPane {
  return {
    // Only ever called for records already filtered to `paneId !== null`
    // (see `restoreWorkspaceSessions` below) — the `?? record.id` fallback
    // only exists to satisfy the type checker, never actually taken.
    paneId: record.paneId ?? record.id,
    recordId: record.id,
    agent: record.agent,
    cwd: record.cwd,
    title: record.title,
    sshProfileId: record.sshProfileId,
  };
}

/**
 * The bounded, circuit-breaker-guarded cold-start restore for one
 * workspace's recoverable sessions — see `restore-budget.ts` for the two
 * knobs this composes. Only considers records with a `paneId` (a record
 * with none — e.g. one dispatched by the board/swarm rather than clicked
 * from an empty pane — has nowhere in the grid to reattach into; it still
 * shows up in the plain History list, just never here).
 *
 * Called when a workspace becomes active (see `index.ts`'s `POST
 * /api/workspaces/:id/restore-sessions`) — NOT once for every workspace at
 * server boot, so a person with ten workspaces never pays this cost for the
 * nine they aren't currently looking at.
 */
export async function restoreWorkspaceSessions(
  sessionManager: SessionManager,
  recordsStore: SessionRecordsStore,
  sshProfileStore: SshProfileStore,
  workspaceId: string,
  budget: number = EAGER_RESTORE_BUDGET,
  cols = 80,
  rows = 24
): Promise<WorkspaceRestoreResult> {
  const recoverable = recordsStore.listRecoverable(workspaceId).filter((r) => r.paneId !== null);
  const { eager, deferred: budgetDeferred } = planRestore(recoverable, budget);

  const restored: RestoredPane[] = [];
  const deferred: DeferredPane[] = budgetDeferred.map(toDeferredPane);
  const breaker = new RestoreCircuitBreaker();
  let circuitBreakerTripped = false;

  for (const record of eager) {
    if (breaker.tripped) {
      circuitBreakerTripped = true;
      deferred.push(toDeferredPane(record));
      continue;
    }

    const result = await attemptResume(sessionManager, recordsStore, sshProfileStore, record, cols, rows);
    if (!result.ok) {
      breaker.recordFailure();
      deferred.push(toDeferredPane(record));
      continue;
    }

    breaker.recordSuccess();
    restored.push({
      paneId: record.paneId!, // filtered to non-null above
      recordId: record.id,
      session: result.session,
      note: result.note,
    });
  }

  return { restored, deferred, circuitBreakerTripped };
}
