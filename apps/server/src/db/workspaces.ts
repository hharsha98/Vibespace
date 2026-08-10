/**
 * WorkspaceStore: the only place in the server that speaks SQL. Routes call
 * these methods and get back plain `Workspace` objects (the shared protocol
 * type) — no `Database` handle, no row shapes, leak past this file.
 */
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Workspace } from "@vibedeck/shared";
import { openDatabase } from "./schema.js";

/** The raw shape a row comes back as from better-sqlite3 (snake_case, as SQLite gave it to us). */
interface WorkspaceRow {
  id: string;
  name: string;
  root_path: string;
  layout: string | null;
  created_at: string;
  updated_at: string;
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    layout: row.layout,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateWorkspaceOptions {
  name: string;
  rootPath: string;
}

export interface UpdateWorkspaceOptions {
  name?: string;
  rootPath?: string;
  layout?: string | null;
}

export class WorkspaceStore {
  private db: Database;

  /** Defaults to a fresh `openDatabase()` call; tests/callers may inject
   * their own handle (e.g. one opened against a temp-dir db) if needed. */
  constructor(db: Database = openDatabase()) {
    this.db = db;
  }

  list(): Workspace[] {
    const rows = this.db
      .prepare("SELECT * FROM workspaces ORDER BY created_at ASC")
      .all() as WorkspaceRow[];
    return rows.map(rowToWorkspace);
  }

  get(id: string): Workspace | undefined {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
      | WorkspaceRow
      | undefined;
    return row ? rowToWorkspace(row) : undefined;
  }

  create({ name, rootPath }: CreateWorkspaceOptions): Workspace {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, root_path, layout, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?)`
      )
      .run(id, name, rootPath, now, now);
    // Re-read rather than constructing the object by hand, so this always
    // reflects exactly what SQLite actually stored (e.g. if a future column
    // gets a DB-side default).
    return this.get(id)!;
  }

  /** Returns the updated workspace, or undefined if `id` doesn't exist. */
  update(id: string, changes: UpdateWorkspaceOptions): Workspace | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    const name = changes.name ?? existing.name;
    const rootPath = changes.rootPath ?? existing.rootPath;
    // `layout` is allowed to be explicitly set to null (clearing it), so we
    // can't use `??` here the way we do above — only fall back to the
    // existing value when the caller didn't mention `layout` at all.
    const layout = "layout" in changes ? (changes.layout ?? null) : existing.layout;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE workspaces SET name = ?, root_path = ?, layout = ?, updated_at = ? WHERE id = ?`
      )
      .run(name, rootPath, layout, now, id);

    return this.get(id);
  }

  /** True if a workspace with this id existed and was removed. */
  remove(id: string): boolean {
    const result = this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** Closes the underlying database handle. Call on server shutdown. */
  close(): void {
    this.db.close();
  }
}
