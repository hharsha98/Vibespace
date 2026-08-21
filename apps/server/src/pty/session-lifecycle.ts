/**
 * Wires a live pty session's exit back to its durable `SessionRecord` — the
 * mechanism behind "recoverability must survive a failed resume" (see
 * `restore.ts`'s `attemptResume`, and `index.ts`'s `POST /api/sessions`,
 * both of which call `trackSessionForRecovery` immediately after spawning).
 *
 * Reuses `SessionManager`'s EXISTING `attach()` mechanism — the same one
 * `index.ts`'s WebSocket route already uses to stream output to a browser
 * tab — rather than adding a second, parallel exit-callback path to
 * `SessionManager` itself. One exit-notification mechanism, several
 * independent listeners.
 */
import type { SessionManager } from "./session-manager.js";
import type { SessionRecordsStore } from "../db/session-records.js";

/**
 * How long after a RESUME attempt an exit still counts as "the resume
 * itself failed" (a rejected flag, a CLI that crashes on startup, the
 * binary silently failing to launch, ...) rather than "it ran for a normal
 * while and then genuinely ended". Chosen generously — even a slow machine
 * should get well past a CLI's own startup/flag-parsing within 3 seconds; a
 * session that outlives that window and THEN exits is a real session
 * ending, not a broken resume, and gets the plain `'exited'` reason instead
 * of `'resume_failed'`.
 */
export const RESUME_FAILURE_WINDOW_MS = 3000;

/**
 * Call once, right after a session is spawned (fresh OR resumed), passing
 * the live `sessionId` `SessionManager.create()` just returned and the
 * durable `recordId` it belongs to. When that pty eventually exits — for
 * ANY reason, whether this server process is still alive or that's the
 * very last thing this session ever does — the record is transitioned back
 * to 'recoverable' via `SessionRecordsStore.markExited`.
 *
 * `isResumeAttempt` distinguishes an ordinary end-of-life exit (`reason:
 * 'exited'`) from a resume that failed almost immediately (`reason:
 * 'resume_failed'`) — see `RESUME_FAILURE_WINDOW_MS`'s own comment. This is
 * what makes a failed resume return the record to 'recoverable' WITH an
 * honest reason attached, instead of the session's recoverability being
 * silently consumed by the failed attempt (the exact BridgeSpace v3.4.13
 * bug this whole mechanism exists to avoid).
 */
export function trackSessionForRecovery(
  sessionManager: SessionManager,
  recordsStore: SessionRecordsStore,
  sessionId: string,
  recordId: string,
  isResumeAttempt: boolean
): void {
  const attachedAt = Date.now();
  const unsubscribe = sessionManager.attach(sessionId, (event) => {
    if (event.type !== "exit") return;
    unsubscribe();
    const quickFailure = isResumeAttempt && Date.now() - attachedAt < RESUME_FAILURE_WINDOW_MS;
    recordsStore.markExited(recordId, event.code, quickFailure ? "resume_failed" : "exited");
  });
}
