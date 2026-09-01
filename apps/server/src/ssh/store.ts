/**
 * SshProfileStore: the only place in the server that speaks SQL for
 * `ssh_profiles` — same "routes call these methods and get back plain
 * `SshProfile` objects, no row shapes leak past this file" rule as
 * `AgentProfileStore`/`WorkspaceStore`/`BoardStore`.
 *
 * See `packages/shared/src/protocol.ts`'s `SshProfile` doc comment for why
 * profiles are GLOBAL (no `workspaceId`) — a profile names a machine, not a
 * project.
 *
 * --- Duplicate names are arbitrated by the database, not by this code ---
 * Same reasoning as `AgentProfileStore` (see that file's top comment, and
 * `swarm/claims.ts`'s for the full "why a UNIQUE constraint, not a
 * check-then-insert" argument): `ssh_profiles` has `UNIQUE(name)` (see
 * `../db/migrations.ts`'s migration 7), and `create()`/`update()` below
 * attempt the write unconditionally, letting SQLite itself reject a
 * colliding name with a UNIQUE constraint violation. `duplicate()` below is
 * the one place this matters most: BridgeSpace's one-click Duplicate must
 * produce a NEW, distinctly-named profile (never silently overwrite or
 * collide with the original), so it retries `create()` with successively
 * different candidate names on a `"duplicate-name"` result rather than
 * pre-checking what's free.
 */
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { SshProfile } from "@vibespace/shared";
import { openDatabase } from "../db/schema.js";

/** The raw shape a row comes back as from better-sqlite3 (snake_case, as SQLite gave it to us). */
interface SshProfileRow {
  id: string;
  name: string;
  host: string;
  user: string | null;
  port: number | null;
  default_directory: string | null;
  startup_command: string | null;
  created_at: string;
  updated_at: string;
}

function rowToSshProfile(row: SshProfileRow): SshProfile {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    user: row.user,
    port: row.port,
    defaultDirectory: row.default_directory,
    startupCommand: row.startup_command,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateSshProfileOptions {
  name: string;
  host: string;
  user: string | null;
  port: number | null;
  defaultDirectory: string | null;
  startupCommand: string | null;
}

export interface UpdateSshProfileOptions {
  name?: string;
  host?: string;
  user?: string | null;
  port?: number | null;
  defaultDirectory?: string | null;
  startupCommand?: string | null;
}

/** True if `err` is better-sqlite3's error for a UNIQUE constraint
 * violation. Duplicated from the identical check in `agents/store.ts`
 * (and `swarm/claims.ts`) rather than imported — it's two lines, and none
 * of these modules have any other reason to depend on each other. */
function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

/** Result of `create()`/`update()`/`duplicate()` — a discriminated union so
 * `./routes.ts` can tell "worked", "no such profile", and "name taken"
 * apart without parsing an error string. Mirrors `AgentProfileMutationResult`. */
export type SshProfileMutationResult =
  | { ok: true; profile: SshProfile }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "duplicate-name" };

/** How many candidate names `duplicate()` will try before giving up — see
 * that method's own comment. A generous bound; in practice the very first
 * or second candidate is free almost always. */
const MAX_DUPLICATE_NAME_ATTEMPTS = 100;

export class SshProfileStore {
  private db: Database;

  /** Defaults to a fresh `openDatabase()` call; tests/callers may inject
   * their own handle (e.g. one opened against a temp-dir db) if needed. */
  constructor(db: Database = openDatabase()) {
    this.db = db;
  }

  list(): SshProfile[] {
    const rows = this.db.prepare(`SELECT * FROM ssh_profiles ORDER BY name ASC`).all() as SshProfileRow[];
    return rows.map(rowToSshProfile);
  }

  get(id: string): SshProfile | undefined {
    const row = this.db.prepare("SELECT * FROM ssh_profiles WHERE id = ?").get(id) as
      | SshProfileRow
      | undefined;
    return row ? rowToSshProfile(row) : undefined;
  }

  /** See this file's top comment: the INSERT is attempted unconditionally,
   * and a UNIQUE violation (not a prior SELECT) is what reports the name as
   * taken. */
  create(options: CreateSshProfileOptions): SshProfileMutationResult {
    const id = randomUUID();
    const now = new Date().toISOString();

    try {
      this.db
        .prepare(
          `INSERT INTO ssh_profiles
             (id, name, host, user, port, default_directory, startup_command, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          options.name,
          options.host,
          options.user,
          options.port,
          options.defaultDirectory,
          options.startupCommand,
          now,
          now
        );
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return { ok: false, reason: "duplicate-name" };
      }
      throw err;
    }

    // Re-read rather than constructing the object by hand — always reflects
    // exactly what SQLite stored, same reasoning as AgentProfileStore.create.
    return { ok: true, profile: this.get(id)! };
  }

  /** Returns `{ok:false, reason:"not-found"}` for an unknown id, or
   * `{ok:false, reason:"duplicate-name"}` if the patch renames the profile
   * to a name another profile already holds — same UNIQUE-constraint
   * arbitration as `create()`, not a check-then-write. */
  update(id: string, patch: UpdateSshProfileOptions): SshProfileMutationResult {
    const existing = this.get(id);
    if (!existing) return { ok: false, reason: "not-found" };

    const name = patch.name ?? existing.name;
    const host = patch.host ?? existing.host;
    const user = "user" in patch ? patch.user! : existing.user;
    const port = "port" in patch ? patch.port! : existing.port;
    const defaultDirectory =
      "defaultDirectory" in patch ? patch.defaultDirectory! : existing.defaultDirectory;
    const startupCommand =
      "startupCommand" in patch ? patch.startupCommand! : existing.startupCommand;
    const now = new Date().toISOString();

    try {
      this.db
        .prepare(
          `UPDATE ssh_profiles
             SET name = ?, host = ?, user = ?, port = ?, default_directory = ?, startup_command = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(name, host, user, port, defaultDirectory, startupCommand, now, id);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return { ok: false, reason: "duplicate-name" };
      }
      throw err;
    }

    return { ok: true, profile: this.get(id)! };
  }

  /**
   * One-click Duplicate (BridgeSpace v3.2.1 parity): copies every field of
   * `id` into a brand-new profile with a fresh id, under a name derived from
   * the original ("X copy", then "X copy 2", "X copy 3", ...). Each
   * candidate is tried via a real `create()` call — never a pre-check SELECT
   * — so the SAME race-free UNIQUE-constraint arbitration this file's top
   * comment describes still holds even here: two concurrent duplicate
   * requests can never both succeed with the same name, they'll simply end
   * up trying different candidates until each finds one that's free.
   */
  duplicate(id: string): SshProfileMutationResult {
    const existing = this.get(id);
    if (!existing) return { ok: false, reason: "not-found" };

    let candidateName = `${existing.name} copy`;
    for (let attempt = 0; attempt < MAX_DUPLICATE_NAME_ATTEMPTS; attempt++) {
      const result = this.create({
        name: candidateName,
        host: existing.host,
        user: existing.user,
        port: existing.port,
        defaultDirectory: existing.defaultDirectory,
        startupCommand: existing.startupCommand,
      });
      if (result.ok || result.reason !== "duplicate-name") return result;
      candidateName = `${existing.name} copy ${attempt + 2}`;
    }
    return { ok: false, reason: "duplicate-name" };
  }

  /** True if a profile with this id existed and was removed. */
  remove(id: string): boolean {
    const result = this.db.prepare("DELETE FROM ssh_profiles WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** Closes the underlying database handle. Call on server shutdown. */
  close(): void {
    this.db.close();
  }
}
