/**
 * ClaimsStore: the file-ownership registry a swarm mission arbitrates
 * through. This is the part of Phase 9a that has to be correct, so read
 * this whole comment before touching `claim()`.
 *
 * --- The DB arbitrates, not this code ---
 * The "obvious" way to write a claim is: SELECT to see if the path is free,
 * then INSERT if it is. That is WRONG under concurrency — two agents can
 * both run the SELECT, both see "free", and both INSERT. There is no safe
 * gap to check in between; by the time you've read the answer, it may
 * already be stale.
 *
 * Instead, `file_claims` has `UNIQUE(mission_id, path)` (see
 * `../db/schema.ts`), and `claim()` below attempts the INSERT
 * unconditionally. If another row already holds `(mission_id, path)`,
 * SQLite itself rejects the second INSERT with a UNIQUE constraint
 * violation (better-sqlite3 throws an error with `code ===
 * "SQLITE_CONSTRAINT_UNIQUE"`) — the INSERT *is* the check, so there is no
 * window between "is it free" and "take it" for a second agent to land in.
 * The loser then just reads the row back to report who holds it.
 *
 * Reclaiming a STALE claim (see below) follows the identical philosophy:
 * rather than "read the row, check if it's stale, then UPDATE it" (which
 * has exactly the same race as check-then-write), the reclaim is a single
 * `UPDATE ... WHERE mission_id = ? AND path = ? AND last_heartbeat_at < ?`
 * — the staleness condition lives IN the write, not before it. If two
 * agents race to reclaim the same stale claim, at most one UPDATE actually
 * matches a row (the first one to run re-stamps `last_heartbeat_at`, so the
 * second one's `< ?` condition is no longer true) — `result.changes` tells
 * each caller which one it was.
 *
 * DO NOT "simplify" this back to check-then-write. It looks redundant right
 * up until two agents claim the same file at the same moment.
 *
 * --- Claims never block ---
 * `claim()` always returns immediately: either the claim succeeded, or it
 * failed and names the current holder. There is no queueing, no waiting for
 * a lock to free up. This is deliberate — a queue is how you get a
 * deadlock (two agents each waiting on a file the other holds); a claim
 * that just says "no, X has it" lets the loser go do something else
 * instead of hanging.
 *
 * --- This is advisory, not enforcement ---
 * Nothing in this file stops an agent that never calls `claim()` (or
 * ignores a 409) from just writing to a file with `echo > file`. The
 * registry only coordinates COOPERATING agents. Detecting the
 * uncooperative case is a different mechanism — see `watch.ts`, which
 * records a `claim_conflicts` row when a file changes on disk while a
 * DIFFERENT agent than the one editing holds the claim.
 */
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { relative, sep } from "node:path";
import type { FileClaim, ClaimConflict } from "@vibespace/shared";
import { openDatabase } from "../db/schema.js";
import { safeResolve } from "../files/safe-path.js";

/**
 * How long a claim can go without a heartbeat before it's considered
 * abandoned (its holder likely crashed, was killed, or otherwise stopped
 * checking in) and becomes reclaimable by a different agent. Exported and
 * named, per the spec, rather than a bare magic number — tests reach in and
 * construct heartbeats older/younger than this to prove the boundary.
 */
export const CLAIM_STALE_TTL_MS = 10 * 60 * 1000; // 10 minutes

type NormalizeResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Turns a client-supplied, possibly-messy path (`./src/a.ts`, `src/a.ts`,
 * `src//a.ts`) into the ONE canonical, workspace-relative, POSIX-separated
 * form every claim on that file is stored and looked up under — so those
 * three all collide as the same claim instead of three different rows.
 *
 * Reuses `safeResolve` (the one place in this repo allowed to turn a
 * client-supplied relative path into a real filesystem path) rather than
 * re-implementing containment checking here — a path that would escape the
 * workspace root is rejected exactly the same way a file-route request
 * escaping it would be.
 */
export function normalizeClaimPath(workspaceRoot: string, rawPath: unknown): NormalizeResult {
  const resolved = safeResolve(workspaceRoot, rawPath);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }
  // safeResolve returns an OS-native absolute path; relative() + splitting
  // on the OS separator and rejoining with "/" is what makes the stored
  // path POSIX-separated even on a hypothetical Windows host, matching the
  // convention `FileWatchEvent.path` already uses (files/routes.ts).
  const rel = relative(workspaceRoot, resolved.path).split(sep).join("/");
  return { ok: true, path: rel };
}

/** The raw shape a row comes back as from better-sqlite3. */
interface FileClaimRow {
  id: string;
  mission_id: string;
  path: string;
  agent_id: string;
  claimed_at: string;
  last_heartbeat_at: string;
}

function rowToClaim(row: FileClaimRow): FileClaim {
  return {
    id: row.id,
    missionId: row.mission_id,
    path: row.path,
    agentId: row.agent_id,
    claimedAt: row.claimed_at,
    lastHeartbeatAt: row.last_heartbeat_at,
  };
}

interface ClaimConflictRow {
  id: string;
  mission_id: string;
  path: string;
  holder_agent_id: string;
  detected_at: string;
}

function rowToConflict(row: ClaimConflictRow): ClaimConflict {
  return {
    id: row.id,
    missionId: row.mission_id,
    path: row.path,
    holderAgentId: row.holder_agent_id,
    detectedAt: row.detected_at,
  };
}

/** Result of `claim()` — a discriminated union so callers (the route layer)
 * can tell a validation failure (bad path) apart from a lost race (someone
 * else holds it) without parsing an error string. */
export type ClaimResult =
  | { ok: true; claim: FileClaim }
  | { ok: false; reason: "invalid-path"; error: string }
  | { ok: false; reason: "held"; holder: FileClaim };

/** True if `err` is better-sqlite3's error for a UNIQUE constraint
 * violation — the only kind of thrown error `claim()`'s INSERT is expected
 * to see (any other error is a real bug and should propagate). */
function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

export class ClaimsStore {
  private db: Database;

  constructor(db: Database = openDatabase()) {
    this.db = db;
  }

  /**
   * Attempt to claim `rawPath` for `agentId` within `missionId`. See this
   * file's top comment for the INSERT-first, catch-the-constraint strategy
   * this implements — there is no separate "is it free" read before this.
   */
  claim(missionId: string, agentId: string, workspaceRoot: string, rawPath: unknown): ClaimResult {
    const normalized = normalizeClaimPath(workspaceRoot, rawPath);
    if (!normalized.ok) {
      return { ok: false, reason: "invalid-path", error: normalized.error };
    }
    const path = normalized.path;
    const now = new Date().toISOString();

    try {
      this.db
        .prepare(
          `INSERT INTO file_claims (id, mission_id, path, agent_id, claimed_at, last_heartbeat_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(randomUUID(), missionId, path, agentId, now, now);
      return { ok: true, claim: this.getByPath(missionId, path)! };
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      // Someone already holds (missionId, path). Don't just report them as
      // the winner yet — they might be stale. Attempt to reclaim atomically
      // (see top comment): the staleness check lives in the UPDATE's WHERE
      // clause, not as a separate read beforehand.
      const staleThreshold = new Date(Date.now() - CLAIM_STALE_TTL_MS).toISOString();
      const reclaimed = this.db
        .prepare(
          `UPDATE file_claims SET agent_id = ?, claimed_at = ?, last_heartbeat_at = ?
           WHERE mission_id = ? AND path = ? AND last_heartbeat_at < ?`
        )
        .run(agentId, now, now, missionId, path, staleThreshold);

      if (reclaimed.changes > 0) {
        return { ok: true, claim: this.getByPath(missionId, path)! };
      }
      // Not stale (or lost the reclaim race to someone else) — report the
      // current holder, whoever that now is.
      const holder = this.getByPath(missionId, path)!;
      return { ok: false, reason: "held", holder };
    }
  }

  /** The claim on `path` within `missionId`, if any. `path` must already be
   * normalized (this does no path resolution itself). */
  getByPath(missionId: string, path: string): FileClaim | undefined {
    const row = this.db
      .prepare(`SELECT * FROM file_claims WHERE mission_id = ? AND path = ?`)
      .get(missionId, path) as FileClaimRow | undefined;
    return row ? rowToClaim(row) : undefined;
  }

  /** Every claim currently held within a mission. */
  list(missionId: string): FileClaim[] {
    const rows = this.db
      .prepare(`SELECT * FROM file_claims WHERE mission_id = ? ORDER BY claimed_at ASC`)
      .all(missionId) as FileClaimRow[];
    return rows.map(rowToClaim);
  }

  /** Refresh `last_heartbeat_at` on every claim `agentId` holds in
   * `missionId`. Returns how many claims were refreshed. */
  heartbeat(missionId: string, agentId: string): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`UPDATE file_claims SET last_heartbeat_at = ? WHERE mission_id = ? AND agent_id = ?`)
      .run(now, missionId, agentId);
    return result.changes;
  }

  /**
   * Release one path (if `rawPath` is given) or every claim `agentId` holds
   * in `missionId` (if omitted) — "release-all-for-agent", used when an
   * agent finishes or a mission stops. Only releases claims actually held
   * by `agentId`; releasing a path you don't hold is a no-op (returns 0),
   * not an error — the caller can distinguish "nothing to release" from a
   * real failure by that count.
   */
  release(
    missionId: string,
    agentId: string,
    workspaceRoot?: string,
    rawPath?: unknown
  ): NormalizeResult | { ok: true; released: number } {
    if (rawPath === undefined) {
      const result = this.db
        .prepare(`DELETE FROM file_claims WHERE mission_id = ? AND agent_id = ?`)
        .run(missionId, agentId);
      return { ok: true, released: result.changes };
    }
    if (!workspaceRoot) {
      return { ok: false, error: "workspaceRoot is required to release a specific path" };
    }
    const normalized = normalizeClaimPath(workspaceRoot, rawPath);
    if (!normalized.ok) return normalized;

    const result = this.db
      .prepare(`DELETE FROM file_claims WHERE mission_id = ? AND agent_id = ? AND path = ?`)
      .run(missionId, agentId, normalized.path);
    return { ok: true, released: result.changes };
  }

  /** Release EVERY claim in a mission, regardless of holder — used when a
   * mission is stopped (Phase 9a spec: "stop kills its agents' sessions AND
   * releases every claim"). Unlike `release()`, this is not scoped to one
   * agent, since stopping the whole mission means no agent should keep
   * holding anything. */
  releaseAllForMission(missionId: string): number {
    const result = this.db.prepare(`DELETE FROM file_claims WHERE mission_id = ?`).run(missionId);
    return result.changes;
  }

  /** True if `claim` has gone longer than `CLAIM_STALE_TTL_MS` without a
   * heartbeat. Exposed mainly for tests/callers that want to reason about
   * staleness without duplicating the threshold math; `claim()` itself does
   * this check inline (in SQL, atomically) rather than calling this. */
  isStale(claim: FileClaim, now: number = Date.now()): boolean {
    return now - new Date(claim.lastHeartbeatAt).getTime() > CLAIM_STALE_TTL_MS;
  }

  // --- Conflict detection (recording side; watch.ts does the detecting) ---

  /** Record a detected conflict: `path` changed on disk while `holderAgentId`
   * held the claim on it. See this file's top comment — this is evidence of
   * an uncooperative/misbehaving agent, not something the registry
   * prevented. */
  recordConflict(missionId: string, path: string, holderAgentId: string): ClaimConflict {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO claim_conflicts (id, mission_id, path, holder_agent_id, detected_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, missionId, path, holderAgentId, now);
    const row = this.db.prepare(`SELECT * FROM claim_conflicts WHERE id = ?`).get(id) as ClaimConflictRow;
    return rowToConflict(row);
  }

  /** Every conflict ever detected in a mission, oldest first. */
  listConflicts(missionId: string): ClaimConflict[] {
    const rows = this.db
      .prepare(`SELECT * FROM claim_conflicts WHERE mission_id = ? ORDER BY detected_at ASC`)
      .all(missionId) as ClaimConflictRow[];
    return rows.map(rowToConflict);
  }

  /** Closes the underlying database handle. Call on server shutdown. */
  close(): void {
    this.db.close();
  }
}
