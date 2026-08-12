/**
 * TasksStore: CRUD for `mission_tasks`, plus the two gates this phase's
 * spec calls for:
 *
 *  1. **Wave readiness.** A task can only move to 'running' once every task
 *     in an earlier wave (per `schedule.ts`'s `planSchedule`, computed over
 *     the mission's CURRENT tasks) is 'complete'. This is what "only
 *     dispatch a wave when the previous wave is complete" means in
 *     practice: enforced reactively at the moment something tries to start
 *     a task, not via a background poller — there is no scheduler process
 *     ticking in the background; a task simply can't be started early.
 *
 *  2. **Reviewer gate.** A task can only reach 'complete' through
 *     `review()` approving it. There is deliberately no other code path in
 *     this file that sets status to 'complete' — `updateTask` explicitly
 *     refuses a direct PATCH to 'complete' — so "reviewed and approved" is
 *     the only way in, by construction, not by convention.
 */
import type { Database } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { MissionTask, MissionTaskStatus } from "@vibedeck/shared";
import { openDatabase } from "../db/schema.js";
import { planSchedule } from "./schedule.js";

interface MissionTaskRow {
  id: string;
  mission_id: string;
  title: string;
  prompt: string;
  declared_paths: string;
  status: string;
  assigned_agent_id: string | null;
  review_approved: number | null;
  review_notes: string | null;
  reviewed_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: MissionTaskRow): MissionTask {
  return {
    id: row.id,
    missionId: row.mission_id,
    title: row.title,
    prompt: row.prompt,
    declaredPaths: JSON.parse(row.declared_paths) as string[],
    status: row.status as MissionTaskStatus,
    assignedAgentId: row.assigned_agent_id,
    reviewApproved: row.review_approved === null ? null : row.review_approved === 1,
    reviewNotes: row.review_notes,
    reviewedByAgentId: row.reviewed_by_agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateTaskOptions {
  missionId: string;
  title: string;
  prompt: string;
  /** Defaults to []. An empty list is valid — see schedule.ts, a task with
   * no declared paths never blocks or is blocked by anything. */
  declaredPaths?: string[];
}

export interface UpdateTaskOptions {
  /** 'complete' is REJECTED here — see this file's top comment. Use
   * `review()` to reach 'complete'. */
  status?: Exclude<MissionTaskStatus, "complete">;
  assignedAgentId?: string | null;
}

export type TaskMutationResult =
  | { ok: true; task: MissionTask }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "complete-requires-review" }
  | { ok: false; reason: "wave-not-ready"; blockedBy: string[] };

export class TasksStore {
  private db: Database;

  constructor(db: Database = openDatabase()) {
    this.db = db;
  }

  list(missionId: string): MissionTask[] {
    const rows = this.db
      .prepare(`SELECT * FROM mission_tasks WHERE mission_id = ? ORDER BY created_at ASC`)
      .all(missionId) as MissionTaskRow[];
    return rows.map(rowToTask);
  }

  get(id: string): MissionTask | undefined {
    const row = this.db.prepare(`SELECT * FROM mission_tasks WHERE id = ?`).get(id) as
      | MissionTaskRow
      | undefined;
    return row ? rowToTask(row) : undefined;
  }

  create(options: CreateTaskOptions): MissionTask {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO mission_tasks
           (id, mission_id, title, prompt, declared_paths, status, assigned_agent_id, review_approved, review_notes, reviewed_by_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, ?, ?)`
      )
      .run(id, options.missionId, options.title, options.prompt, JSON.stringify(options.declaredPaths ?? []), now, now);
    return this.get(id)!;
  }

  /**
   * The waves a mission's CURRENT tasks fall into, per `planSchedule`.
   * Recomputed fresh on every call (not cached) — tasks can be added at
   * any time, and a stale cached schedule would be actively dangerous here
   * (it's the thing wave-readiness gating relies on).
   */
  getSchedule(missionId: string): string[][] {
    const tasks = this.list(missionId);
    return planSchedule(tasks.map((task) => ({ id: task.id, declaredPaths: task.declaredPaths })));
  }

  /** Every task id in a wave strictly before `taskId`'s own wave that is
   * NOT yet 'complete'. Empty means `taskId` is clear to start. */
  private blockingTasks(taskId: string): string[] {
    const task = this.get(taskId);
    if (!task) return [];
    const allTasks = this.list(task.missionId);
    const waves = this.getSchedule(task.missionId);
    const ownWaveIndex = waves.findIndex((wave) => wave.includes(taskId));
    if (ownWaveIndex <= 0) return []; // wave 0 (the first wave) has nothing before it

    const blockers: string[] = [];
    for (let i = 0; i < ownWaveIndex; i++) {
      for (const otherId of waves[i]) {
        const other = allTasks.find((t) => t.id === otherId);
        if (other && other.status !== "complete") blockers.push(otherId);
      }
    }
    return blockers;
  }

  /**
   * Updates a task's status/assignment. Rejects a direct transition to
   * 'complete' (reason: "complete-requires-review" — use `review()`
   * instead), and rejects moving to 'running' while an earlier wave still
   * has incomplete tasks (reason: "wave-not-ready", naming exactly which
   * task ids are blocking it).
   */
  update(id: string, patch: UpdateTaskOptions): TaskMutationResult {
    const existing = this.get(id);
    if (!existing) return { ok: false, reason: "not-found" };

    if ((patch.status as MissionTaskStatus | undefined) === "complete") {
      return { ok: false, reason: "complete-requires-review" };
    }

    if (patch.status === "running" && existing.status !== "running") {
      const blockedBy = this.blockingTasks(id);
      if (blockedBy.length > 0) {
        return { ok: false, reason: "wave-not-ready", blockedBy };
      }
    }

    const status = patch.status ?? existing.status;
    const assignedAgentId =
      "assignedAgentId" in patch ? (patch.assignedAgentId ?? null) : existing.assignedAgentId;
    const now = new Date().toISOString();

    this.db
      .prepare(`UPDATE mission_tasks SET status = ?, assigned_agent_id = ?, updated_at = ? WHERE id = ?`)
      .run(status, assignedAgentId, now, id);
    return { ok: true, task: this.get(id)! };
  }

  /**
   * The one and only way a task reaches 'complete'. `approved: true` moves
   * it to 'complete'; `approved: false` moves it to 'blocked' (needs
   * rework) — either way the review is recorded (who reviewed it, their
   * notes) so the builder knows why.
   */
  review(
    id: string,
    approved: boolean,
    notes: string | null,
    reviewerAgentId: string | null
  ): TaskMutationResult {
    const existing = this.get(id);
    if (!existing) return { ok: false, reason: "not-found" };

    const status: MissionTaskStatus = approved ? "complete" : "blocked";
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE mission_tasks
         SET status = ?, review_approved = ?, review_notes = ?, reviewed_by_agent_id = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(status, approved ? 1 : 0, notes, reviewerAgentId, now, id);
    return { ok: true, task: this.get(id)! };
  }

  /** Closes the underlying database handle. Call on server shutdown. */
  close(): void {
    this.db.close();
  }
}
