/**
 * MailboxStore: CRUD-minus-U for `mission_messages` — the shared mailbox
 * agents (and the human) use to talk to each other within a mission.
 * Messages are append-only (no update/delete): a mailbox is a log, not a
 * mutable document, so "editing history" isn't a thing this store offers.
 *
 * `fromAgentId`/`toAgentId` follow the schema's NULL convention: NULL
 * `fromAgentId` means the human sent it; NULL `toAgentId` means it's a
 * broadcast to every agent in the mission, not aimed at one.
 */
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { MissionMessage } from "@vibespace/shared";
import { openDatabase } from "../db/schema.js";

interface MissionMessageRow {
  id: string;
  mission_id: string;
  from_agent_id: string | null;
  to_agent_id: string | null;
  body: string;
  created_at: string;
}

function rowToMessage(row: MissionMessageRow): MissionMessage {
  return {
    id: row.id,
    missionId: row.mission_id,
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    body: row.body,
    createdAt: row.created_at,
  };
}

export interface SendMessageOptions {
  missionId: string;
  /** null/omitted = from the human. */
  fromAgentId?: string | null;
  /** null/omitted = broadcast to every agent in the mission. */
  toAgentId?: string | null;
  body: string;
}

export class MailboxStore {
  private db: Database;

  constructor(db: Database = openDatabase()) {
    this.db = db;
  }

  send(options: SendMessageOptions): MissionMessage {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO mission_messages (id, mission_id, from_agent_id, to_agent_id, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, options.missionId, options.fromAgentId ?? null, options.toAgentId ?? null, options.body, now);
    return this.get(id)!;
  }

  get(id: string): MissionMessage | undefined {
    const row = this.db.prepare(`SELECT * FROM mission_messages WHERE id = ?`).get(id) as
      | MissionMessageRow
      | undefined;
    return row ? rowToMessage(row) : undefined;
  }

  /**
   * Every message in a mission, oldest first. `sinceIso`, if given, returns
   * only messages strictly after that ISO 8601 timestamp — the polling
   * pattern a client uses to fetch just what it hasn't seen yet (pass the
   * last message's `createdAt` back in as `since` on the next call).
   */
  list(missionId: string, sinceIso?: string): MissionMessage[] {
    const rows = sinceIso
      ? (this.db
          .prepare(
            `SELECT * FROM mission_messages WHERE mission_id = ? AND created_at > ? ORDER BY created_at ASC`
          )
          .all(missionId, sinceIso) as MissionMessageRow[])
      : (this.db
          .prepare(`SELECT * FROM mission_messages WHERE mission_id = ? ORDER BY created_at ASC`)
          .all(missionId) as MissionMessageRow[]);
    return rows.map(rowToMessage);
  }

  /** Closes the underlying database handle. Call on server shutdown. */
  close(): void {
    this.db.close();
  }
}
