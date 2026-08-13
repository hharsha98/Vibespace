/**
 * SavedPromptStore: the only place in the server that speaks SQL for
 * `saved_prompts` (Phase 9.5b, PARITY #27 — the "Prompts library"). Same
 * "routes get back plain `SavedPrompt` objects, no row shapes leak past
 * this file" rule as `BoardStore`/`AgentProfileStore`.
 *
 * `workspaceId` is nullable throughout this store, on purpose: a `null`
 * means the prompt is GLOBAL (available in every workspace), not "not yet
 * assigned" — see `SavedPrompt`'s doc comment in
 * `packages/shared/src/protocol.ts` for the full reasoning. Nothing here
 * ever treats a null `workspaceId` as an error or backfills it.
 */
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { SavedPrompt } from "@vibedeck/shared";
import { openDatabase } from "../db/schema.js";

/** The raw shape a row comes back as from better-sqlite3 (snake_case, as SQLite gave it to us). */
interface SavedPromptRow {
  id: string;
  workspace_id: string | null;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

function rowToPrompt(row: SavedPromptRow): SavedPrompt {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateSavedPromptOptions {
  /** Omit or pass `null` for a global prompt, available in every workspace. */
  workspaceId?: string | null;
  title: string;
  body: string;
}

export interface UpdateSavedPromptOptions {
  title?: string;
  body?: string;
}

export class SavedPromptStore {
  private db: Database;

  /** Defaults to a fresh `openDatabase()` call; tests/callers may inject
   * their own handle (e.g. one shared with other stores in the same
   * process — see `mcp/build-server.ts`) if needed. */
  constructor(db: Database = openDatabase()) {
    this.db = db;
  }

  /**
   * Every GLOBAL prompt (`workspace_id IS NULL`), plus — when
   * `workspaceId` is given — every prompt scoped to that one workspace
   * too. This is the "global + this workspace's" merge the REST/MCP
   * surfaces both document: a caller with no workspace in hand still sees
   * every reusable global prompt; a caller inside a workspace sees those
   * PLUS whatever that workspace saved for itself.
   */
  list(workspaceId?: string): SavedPrompt[] {
    const rows = workspaceId
      ? (this.db
          .prepare(
            `SELECT * FROM saved_prompts WHERE workspace_id IS NULL OR workspace_id = ?
             ORDER BY workspace_id IS NULL DESC, title ASC`
          )
          .all(workspaceId) as SavedPromptRow[])
      : (this.db
          .prepare(`SELECT * FROM saved_prompts WHERE workspace_id IS NULL ORDER BY title ASC`)
          .all() as SavedPromptRow[]);
    return rows.map(rowToPrompt);
  }

  get(id: string): SavedPrompt | undefined {
    const row = this.db.prepare("SELECT * FROM saved_prompts WHERE id = ?").get(id) as
      | SavedPromptRow
      | undefined;
    return row ? rowToPrompt(row) : undefined;
  }

  create(options: CreateSavedPromptOptions): SavedPrompt {
    const id = randomUUID();
    const now = new Date().toISOString();
    const workspaceId = options.workspaceId ?? null;

    this.db
      .prepare(
        `INSERT INTO saved_prompts (id, workspace_id, title, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, workspaceId, options.title, options.body, now, now);

    // Re-read rather than constructing the object by hand, same reasoning
    // as every other store in this codebase.
    return this.get(id)!;
  }

  /** Returns the updated prompt, or undefined if `id` doesn't exist.
   * `workspaceId` is deliberately NOT patchable here — a prompt's
   * global-vs-workspace scope is a creation-time decision, not something a
   * quick edit should silently change. */
  update(id: string, patch: UpdateSavedPromptOptions): SavedPrompt | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    const title = patch.title ?? existing.title;
    const body = patch.body ?? existing.body;
    const now = new Date().toISOString();

    this.db
      .prepare(`UPDATE saved_prompts SET title = ?, body = ?, updated_at = ? WHERE id = ?`)
      .run(title, body, now, id);

    return this.get(id);
  }

  /** True if a prompt with this id existed and was removed. */
  remove(id: string): boolean {
    const result = this.db.prepare("DELETE FROM saved_prompts WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** Closes the underlying database handle. Call on server shutdown. */
  close(): void {
    this.db.close();
  }
}
