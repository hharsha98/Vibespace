/**
 * AgentProfileStore: the only place in the server that speaks SQL for
 * `agent_profiles` (Phase 9.5b, PARITY #26). Same "routes call these
 * methods and get back plain `AgentProfile` objects, no row shapes leak
 * past this file" rule as `BoardStore`/`WorkspaceStore`.
 *
 * An `AgentProfile` is a stored `{name, systemPrompt}` persona, scoped to a
 * workspace, that names which underlying CLI (`baseAgent`) it runs as when
 * dispatched — the BridgeMCP shape documented in docs/RESEARCH.md §2.
 *
 * --- Duplicate names are arbitrated by the database, not by this code ---
 * The "obvious" way to enforce "name unique per workspace" is: SELECT to
 * check no other profile in this workspace already has this name, then
 * INSERT if it's free. That is WRONG under concurrency for exactly the
 * reason `swarm/claims.ts`'s top comment explains for file claims: two
 * concurrent creates can both run the SELECT, both see "free", and both
 * INSERT — there is no safe gap to check in between.
 *
 * Instead, `agent_profiles` has `UNIQUE(workspace_id, name)` (see
 * `../db/migrations.ts`'s migration 4), and `create()`/`update()` below
 * attempt the write unconditionally. If another row already holds that
 * `(workspace_id, name)` pair, SQLite itself rejects the write with a
 * UNIQUE constraint violation (better-sqlite3 throws an error with `code
 * === "SQLITE_CONSTRAINT_UNIQUE"`) — the write *is* the check, so there is
 * no window for a second concurrent request to land in. The route layer
 * (`./routes.ts`) turns that into a 409 naming the conflict.
 */
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { AgentId, AgentProfile } from "@vibedeck/shared";
import { openDatabase } from "../db/schema.js";

/** The raw shape a row comes back as from better-sqlite3 (snake_case, as SQLite gave it to us). */
interface AgentProfileRow {
  id: string;
  workspace_id: string;
  name: string;
  system_prompt: string;
  base_agent: string;
  created_at: string;
  updated_at: string;
}

function rowToAgentProfile(row: AgentProfileRow): AgentProfile {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    systemPrompt: row.system_prompt,
    baseAgent: row.base_agent as AgentId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateAgentProfileOptions {
  workspaceId: string;
  name: string;
  systemPrompt: string;
  baseAgent: AgentId;
}

export interface UpdateAgentProfileOptions {
  name?: string;
  systemPrompt?: string;
  baseAgent?: AgentId;
}

/** True if `err` is better-sqlite3's error for a UNIQUE constraint
 * violation — the only kind of thrown error `create()`/`update()`'s writes
 * are expected to see (any other error is a real bug and should
 * propagate). Same check `swarm/claims.ts`'s `isUniqueConstraintError`
 * uses; duplicated here rather than imported since it's two lines and the
 * two modules have no other reason to depend on each other. */
function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

/** Result of `create()`/`update()` — a discriminated union so `./routes.ts`
 * can tell "worked", "no such profile", and "name taken" apart without
 * parsing an error string. */
export type AgentProfileMutationResult =
  | { ok: true; agent: AgentProfile }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "duplicate-name" };

export class AgentProfileStore {
  private db: Database;

  /** Defaults to a fresh `openDatabase()` call; tests/callers may inject
   * their own handle (e.g. one opened against a temp-dir db, or one shared
   * with other stores in the same process — see `mcp/build-server.ts`) if
   * needed. */
  constructor(db: Database = openDatabase()) {
    this.db = db;
  }

  list(workspaceId: string): AgentProfile[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_profiles WHERE workspace_id = ? ORDER BY name ASC`)
      .all(workspaceId) as AgentProfileRow[];
    return rows.map(rowToAgentProfile);
  }

  get(id: string): AgentProfile | undefined {
    const row = this.db.prepare("SELECT * FROM agent_profiles WHERE id = ?").get(id) as
      | AgentProfileRow
      | undefined;
    return row ? rowToAgentProfile(row) : undefined;
  }

  /** See this file's top comment: the INSERT is attempted unconditionally,
   * and a UNIQUE violation (not a prior SELECT) is what reports the name as
   * taken. */
  create(options: CreateAgentProfileOptions): AgentProfileMutationResult {
    const id = randomUUID();
    const now = new Date().toISOString();

    try {
      this.db
        .prepare(
          `INSERT INTO agent_profiles (id, workspace_id, name, system_prompt, base_agent, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, options.workspaceId, options.name, options.systemPrompt, options.baseAgent, now, now);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return { ok: false, reason: "duplicate-name" };
      }
      throw err;
    }

    // Re-read rather than constructing the object by hand, same reasoning
    // as WorkspaceStore.create — always reflects exactly what SQLite stored.
    return { ok: true, agent: this.get(id)! };
  }

  /** Returns `{ok:false, reason:"not-found"}` for an unknown id, or
   * `{ok:false, reason:"duplicate-name"}` if the patch renames the profile
   * to a name another profile in the SAME workspace already holds — same
   * UNIQUE-constraint arbitration as `create()`, not a check-then-write. */
  update(id: string, patch: UpdateAgentProfileOptions): AgentProfileMutationResult {
    const existing = this.get(id);
    if (!existing) return { ok: false, reason: "not-found" };

    const name = patch.name ?? existing.name;
    const systemPrompt = patch.systemPrompt ?? existing.systemPrompt;
    const baseAgent = patch.baseAgent ?? existing.baseAgent;
    const now = new Date().toISOString();

    try {
      this.db
        .prepare(
          `UPDATE agent_profiles SET name = ?, system_prompt = ?, base_agent = ?, updated_at = ? WHERE id = ?`
        )
        .run(name, systemPrompt, baseAgent, now, id);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return { ok: false, reason: "duplicate-name" };
      }
      throw err;
    }

    return { ok: true, agent: this.get(id)! };
  }

  /** True if a profile with this id existed and was removed. */
  remove(id: string): boolean {
    const result = this.db.prepare("DELETE FROM agent_profiles WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** Closes the underlying database handle. Call on server shutdown. */
  close(): void {
    this.db.close();
  }
}
