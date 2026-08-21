/**
 * SessionRecordsStore: the only place in the server that speaks SQL for
 * `session_records` (see `migrations.ts`'s migration 8 for the full schema
 * rationale). Same "routes/other server code get back plain typed objects,
 * no row shapes leak past this file" rule as `WorkspaceStore`/`SshProfileStore`.
 *
 * This store owns the DURABLE half of session recovery. The other half —
 * deciding WHAT resume even means for a given agent (`pty/resume.ts`), and
 * orchestrating a bounded/circuit-breaker-guarded batch of resumes
 * (`pty/restore.ts`, `pty/restore-budget.ts`) — deliberately lives outside
 * this file, so this stays a plain CRUD-plus-lifecycle-transitions store,
 * the same shape every other `*Store` class in `apps/server/src/db/` and
 * `apps/server/src/ssh/store.ts` already has.
 */
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  AgentId,
  SessionRecord,
  SessionRecordEndedReason,
  SessionRecordStatus,
} from "@vibedeck/shared";
import { openDatabase } from "./schema.js";

/** The raw shape a row comes back as from better-sqlite3 (snake_case). */
interface SessionRecordRow {
  id: string;
  workspace_id: string | null;
  pane_id: string | null;
  session_id: string | null;
  agent: string;
  ssh_profile_id: string | null;
  agent_session_ref: string | null;
  cwd: string;
  title: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  ended_reason: string | null;
  exit_code: number | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: SessionRecordRow): SessionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    paneId: row.pane_id,
    sessionId: row.session_id,
    agent: row.agent as AgentId,
    sshProfileId: row.ssh_profile_id,
    agentSessionRef: row.agent_session_ref,
    cwd: row.cwd,
    title: row.title,
    status: row.status as SessionRecordStatus,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endedReason: row.ended_reason as SessionRecordEndedReason,
    exitCode: row.exit_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateSessionRecordOptions {
  workspaceId: string | null;
  paneId: string | null;
  /** The live SessionManager session id this record was just created for. */
  sessionId: string;
  agent: AgentId;
  sshProfileId: string | null;
  agentSessionRef: string | null;
  cwd: string;
  title: string;
}

export class SessionRecordsStore {
  private db: Database;

  /** Defaults to a fresh `openDatabase()` call; tests/callers may inject
   * their own handle (e.g. one opened against a temp-dir db) if needed. */
  constructor(db: Database = openDatabase()) {
    this.db = db;
  }

  /**
   * Recorded at SPAWN time (see `index.ts`'s `POST /api/sessions` handler,
   * which calls this immediately after `sessionManager.create()` returns,
   * with no `await` in between) — never deferred until first output. That
   * ordering is what fixes the exact bug BridgeSpace's v3.2.2 note calls
   * out: "an agent closed before its first reply is still offered for
   * resume".
   */
  create(options: CreateSessionRecordOptions): SessionRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO session_records
           (id, workspace_id, pane_id, session_id, agent, ssh_profile_id, agent_session_ref, cwd, title, status, started_at, ended_at, ended_reason, exit_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, NULL, NULL, NULL, ?, ?)`
      )
      .run(
        id,
        options.workspaceId,
        options.paneId,
        options.sessionId,
        options.agent,
        options.sshProfileId,
        options.agentSessionRef,
        options.cwd,
        options.title,
        now,
        now,
        now
      );
    // Re-read rather than constructing by hand — always reflects exactly
    // what SQLite stored, same reasoning as every other store's create().
    return this.get(id)!;
  }

  get(id: string): SessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM session_records WHERE id = ?").get(id) as
      | SessionRecordRow
      | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /**
   * The 'running' record currently pointing at a live `sessionId`, or
   * undefined if none does. Used by `index.ts`'s `DELETE /api/sessions/:id`
   * — an EXPLICIT close (the pane's own "X" button) is a deliberate end,
   * not a crash or a restart, so it should mark the record 'discarded'
   * (never offered for resume) rather than leaving it stranded at
   * 'running' forever. It would otherwise stay 'running' forever: `kill()`
   * (unlike a session that exits on its own) deliberately clears its
   * listeners BEFORE the process's exit event fires — see
   * `SessionManager.kill`'s own doc comment — so `trackSessionForRecovery`
   * never gets a chance to transition it itself.
   */
  findByLiveSessionId(sessionId: string): SessionRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM session_records WHERE session_id = ? AND status = 'running'`)
      .get(sessionId) as SessionRecordRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** Every record, most-recently-updated first — the History screen's raw
   * feed. Optionally scoped to one workspace. */
  list(workspaceId?: string): SessionRecord[] {
    const rows = workspaceId
      ? (this.db
          .prepare("SELECT * FROM session_records WHERE workspace_id = ? ORDER BY updated_at DESC")
          .all(workspaceId) as SessionRecordRow[])
      : (this.db
          .prepare("SELECT * FROM session_records ORDER BY updated_at DESC")
          .all() as SessionRecordRow[]);
    return rows.map(rowToRecord);
  }

  /** Recoverable records for one workspace, OLDEST-started first — the
   * order `restore-budget.ts`'s bounded eager restore applies to, so
   * reopening a workspace restores panes in a stable, predictable order run
   * to run rather than whatever order SQLite happens to return them in. */
  listRecoverable(workspaceId: string): SessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM session_records WHERE workspace_id = ? AND status = 'recoverable' ORDER BY started_at ASC`
      )
      .all(workspaceId) as SessionRecordRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Atomically claims `id` for a resume attempt: transitions it to
   * 'running' ONLY IF it is currently 'recoverable', and reports whether
   * that actually happened. This is the guard against a real race
   * `restore.ts`'s `attemptResume` would otherwise have: two concurrent
   * resume attempts for the SAME record (two rapid clicks, a cold-start
   * restore racing a manual History resume, or — observed directly during
   * this feature's own browser verification — React's development-mode
   * double-effect firing the workspace restore call twice) both reading
   * `status: 'recoverable'` before either write commits, and BOTH going on
   * to spawn a real pty. A single `UPDATE ... WHERE status = 'recoverable'`
   * is atomic in SQLite (single-writer, single statement) — only the FIRST
   * caller's claim can ever see `changes > 0`; every other concurrent
   * caller sees `changes === 0` and must not spawn anything. Deliberately
   * separate from `markResumed` below: `claim` runs BEFORE the (possibly
   * slow, definitely side-effectful) `pty.spawn`, so the exclusive claim
   * happens as early as possible; `markResumed` runs AFTER a successful
   * spawn, to attach the real session id once one exists.
   */
  claim(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`UPDATE session_records SET status = 'running', updated_at = ? WHERE id = ? AND status = 'recoverable'`)
      .run(now, id);
    return result.changes > 0;
  }

  /**
   * A session's pty is gone — either it exited on its own, or (via
   * `markServerRestartOrphans` below) the server that owned it is gone.
   * Always transitions to 'recoverable', never a dead-end distinct 'exited'
   * status — see migration 8's doc comment for why the two are the same
   * actionable state from a user's point of view. `session_id` is cleared:
   * whatever pty backed this record is gone for good.
   */
  markExited(
    id: string,
    exitCode: number | null,
    reason: SessionRecordEndedReason
  ): SessionRecord | undefined {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE session_records
           SET status = 'recoverable', session_id = NULL, ended_at = ?, ended_reason = ?, exit_code = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(now, reason, exitCode, now, id);
    return this.get(id);
  }

  /**
   * A resume attempt just spawned a fresh pty for this record — back to
   * 'running', pointing at the NEW session id (the old OS process is gone
   * for good; see `session_id`'s own doc comment on `SessionRecord`).
   * Clears the previous `ended_at`/`ended_reason`/`exit_code`, since those
   * described the PREVIOUS life, not this one — a record that's resumed
   * twice shouldn't still show the reason its FIRST life ended.
   */
  markResumed(id: string, newSessionId: string): SessionRecord | undefined {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE session_records
           SET status = 'running', session_id = ?, ended_at = NULL, ended_reason = NULL, exit_code = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(newSessionId, now, id);
    return this.get(id);
  }

  /** Explicitly dismissed from History — a terminal state; nothing resumes
   * a discarded record. */
  markDiscarded(id: string): SessionRecord | undefined {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE session_records SET status = 'discarded', updated_at = ? WHERE id = ?`)
      .run(now, id);
    return this.get(id);
  }

  /**
   * Called once at server boot (see `index.ts`'s `buildApp`): every record
   * still marked 'running' from a PREVIOUS process is lying — pty processes
   * never survive a server restart, and this fresh process's
   * `SessionManager` starts with an empty session map, so there is nothing
   * left to check any of them against. Bulk-transitions all of them to
   * 'recoverable' with `ended_reason = 'server_restart'` in one statement —
   * this single call is what turns "sessions die on restart" into
   * "sessions are offered for resume after a restart". Returns how many
   * rows it touched, mainly so a test can assert something actually
   * happened (or didn't, on a clean boot with nothing orphaned).
   */
  markServerRestartOrphans(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE session_records
           SET status = 'recoverable', session_id = NULL, ended_at = ?, ended_reason = 'server_restart', updated_at = ?
         WHERE status = 'running'`
      )
      .run(now, now);
    return result.changes;
  }

  /** Closes the underlying database handle. Call on server shutdown. */
  close(): void {
    this.db.close();
  }
}
