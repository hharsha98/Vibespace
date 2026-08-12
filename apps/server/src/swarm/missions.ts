/**
 * MissionsStore: CRUD for `missions` and their `mission_agents`. Same "only
 * place that speaks SQL for these tables" rule as `BoardStore`/
 * `WorkspaceStore` — routes call these methods and get back plain `Mission`/
 * `MissionAgent` objects (the shared protocol types), never a raw row.
 *
 * A mission is deliberately dumb here: this file has no idea what a "role
 * preamble" is or how to spawn a pty — that's `dispatch.ts`'s job. This
 * file only tracks the bookkeeping rows (what agents exist, what state
 * they're in), which is what lets `dispatch.ts`, `routes.ts`, and tests all
 * agree on the same shape without duplicating persistence logic.
 */
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  AgentId,
  Mission,
  MissionAgent,
  MissionAgentStatus,
  MissionRole,
  MissionStatus,
} from "@vibedeck/shared";
import { openDatabase } from "../db/schema.js";

interface MissionRow {
  id: string;
  workspace_id: string;
  prompt: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToMission(row: MissionRow): Mission {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    prompt: row.prompt,
    status: row.status as MissionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface MissionAgentRow {
  id: string;
  mission_id: string;
  role: string;
  label: string;
  agent: string;
  session_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToMissionAgent(row: MissionAgentRow): MissionAgent {
  return {
    id: row.id,
    missionId: row.mission_id,
    role: row.role as MissionRole,
    label: row.label,
    agent: row.agent as AgentId,
    sessionId: row.session_id,
    status: row.status as MissionAgentStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateMissionOptions {
  workspaceId: string;
  prompt: string;
}

export interface CreateMissionAgentOptions {
  missionId: string;
  role: MissionRole;
  label: string;
  agent: AgentId;
}

export interface UpdateMissionAgentOptions {
  sessionId?: string | null;
  status?: MissionAgentStatus;
}

export class MissionsStore {
  private db: Database;

  constructor(db: Database = openDatabase()) {
    this.db = db;
  }

  // --- missions -----------------------------------------------------------

  listMissions(workspaceId: string): Mission[] {
    const rows = this.db
      .prepare(`SELECT * FROM missions WHERE workspace_id = ? ORDER BY created_at ASC`)
      .all(workspaceId) as MissionRow[];
    return rows.map(rowToMission);
  }

  getMission(id: string): Mission | undefined {
    const row = this.db.prepare(`SELECT * FROM missions WHERE id = ?`).get(id) as MissionRow | undefined;
    return row ? rowToMission(row) : undefined;
  }

  /** A freshly-created mission always starts "running" — there's no reason
   * to create one paused/stopped, and "complete" only makes sense once
   * there's been work to complete. */
  createMission(options: CreateMissionOptions): Mission {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO missions (id, workspace_id, prompt, status, created_at, updated_at)
         VALUES (?, ?, ?, 'running', ?, ?)`
      )
      .run(id, options.workspaceId, options.prompt, now, now);
    return this.getMission(id)!;
  }

  /** Returns the updated mission, or undefined if `id` doesn't exist. */
  updateMissionStatus(id: string, status: MissionStatus): Mission | undefined {
    if (!this.getMission(id)) return undefined;
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE missions SET status = ?, updated_at = ? WHERE id = ?`).run(status, now, id);
    return this.getMission(id);
  }

  // --- mission agents -------------------------------------------------------

  listAgents(missionId: string): MissionAgent[] {
    const rows = this.db
      .prepare(`SELECT * FROM mission_agents WHERE mission_id = ? ORDER BY created_at ASC`)
      .all(missionId) as MissionAgentRow[];
    return rows.map(rowToMissionAgent);
  }

  getAgent(id: string): MissionAgent | undefined {
    const row = this.db.prepare(`SELECT * FROM mission_agents WHERE id = ?`).get(id) as
      | MissionAgentRow
      | undefined;
    return row ? rowToMissionAgent(row) : undefined;
  }

  /** A freshly-created agent has no session yet ("idle") — `dispatch.ts`
   * spawns the pty afterwards and calls `updateAgent` to record its
   * `sessionId` once it exists. Splitting creation from spawning this way
   * means a DB row always exists to report progress against even if the
   * spawn itself is still settling. */
  createAgent(options: CreateMissionAgentOptions): MissionAgent {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO mission_agents (id, mission_id, role, label, agent, session_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, 'idle', ?, ?)`
      )
      .run(id, options.missionId, options.role, options.label, options.agent, now, now);
    return this.getAgent(id)!;
  }

  /** Returns the updated agent, or undefined if `id` doesn't exist. */
  updateAgent(id: string, patch: UpdateMissionAgentOptions): MissionAgent | undefined {
    const existing = this.getAgent(id);
    if (!existing) return undefined;

    const sessionId = "sessionId" in patch ? (patch.sessionId ?? null) : existing.sessionId;
    const status = patch.status ?? existing.status;
    const now = new Date().toISOString();

    this.db
      .prepare(`UPDATE mission_agents SET session_id = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(sessionId, status, now, id);
    return this.getAgent(id);
  }

  /** Closes the underlying database handle. Call on server shutdown. */
  close(): void {
    this.db.close();
  }
}
