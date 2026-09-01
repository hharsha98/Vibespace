/**
 * Phase 9a (swarm core) REST endpoints: missions, mission agents, the
 * shared mailbox, file claims, conflict reporting, and quality gates.
 * Structured the same way `board/routes.ts` and `memory/routes.ts` are —
 * one module, request validation + wiring only, all persistence in the
 * `swarm/*.ts` stores and all pty/spawn mechanics in `dispatch.ts`.
 */
import type { FastifyInstance } from "fastify";
import {
  AGENT_IDS,
  MISSION_ROLES,
  MISSION_STATUSES,
  MISSION_TASK_STATUSES,
  type AgentId,
  type Mission,
  type MissionDetail,
  type MissionRole,
  type MissionStatus,
  type MissionTaskStatus,
  type TaskScheduleResponse,
} from "@vibespace/shared";
import type { WorkspaceStore } from "../db/workspaces.js";
import type { SessionManager } from "../pty/session-manager.js";
import { detectAllAgents, INSTALL_HINTS, isAgentId } from "../pty/agents.js";
import { toSingleLine } from "../board/dispatch.js";
import type { MissionsStore } from "./missions.js";
import type { ClaimsStore } from "./claims.js";
import type { MailboxStore } from "./mailbox.js";
import type { TasksStore } from "./tasks.js";
import { spawnMissionAgent } from "./dispatch.js";
import { startMissionWatcher } from "./watch.js";
import { runGate } from "./gates.js";

function isMissionRole(value: unknown): value is MissionRole {
  return typeof value === "string" && (MISSION_ROLES as readonly string[]).includes(value);
}

function isMissionStatus(value: unknown): value is MissionStatus {
  return typeof value === "string" && (MISSION_STATUSES as readonly string[]).includes(value);
}

/** Every status a task PATCH is allowed to set directly — everything
 * except 'complete', which is only reachable through the review endpoint
 * (see tasks.ts's top comment). */
const NON_COMPLETE_TASK_STATUSES = MISSION_TASK_STATUSES.filter((status) => status !== "complete");

function isNonCompleteTaskStatus(value: unknown): value is Exclude<MissionTaskStatus, "complete"> {
  return typeof value === "string" && (NON_COMPLETE_TASK_STATUSES as readonly string[]).includes(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export interface SwarmRoutesDeps {
  workspaceStore: WorkspaceStore;
  missionsStore: MissionsStore;
  claimsStore: ClaimsStore;
  mailboxStore: MailboxStore;
  tasksStore: TasksStore;
  sessionManager: SessionManager;
  /** Baked into role preambles' mailbox/claims URLs — see `roles.ts`. Same
   * "passed in, not imported from index.ts" reasoning as
   * `board/routes.ts`'s `serverPort`, to avoid an import cycle. */
  serverPort: number;
}

function requireWorkspace(
  workspaceStore: WorkspaceStore,
  workspaceId: unknown,
  reply: { status: (code: number) => { send: (body: unknown) => void } }
) {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    reply.status(400).send({ error: '"workspaceId" must be a string' });
    return null;
  }
  const workspace = workspaceStore.get(workspaceId);
  if (!workspace) {
    reply.status(404).send({ error: `No workspace with id "${workspaceId}"` });
    return null;
  }
  return workspace;
}

export function registerSwarmRoutes(app: FastifyInstance, deps: SwarmRoutesDeps): void {
  const { workspaceStore, missionsStore, claimsStore, mailboxStore, tasksStore, sessionManager, serverPort } = deps;

  // One chokidar watcher per currently-running mission (see watch.ts's top
  // comment). Scoped to this registerSwarmRoutes call (not module-level) so
  // each `buildApp()` — every test gets its own — owns and cleans up only
  // its own watchers, same pattern as files/routes.ts's `activeWatchers`.
  const missionWatchers = new Map<string, () => void>();

  function startWatcherFor(missionId: string, workspaceRootPath: string): void {
    stopWatcherFor(missionId); // never double-watch the same mission
    missionWatchers.set(missionId, startMissionWatcher(missionId, workspaceRootPath, claimsStore));
  }

  function stopWatcherFor(missionId: string): void {
    const dispose = missionWatchers.get(missionId);
    if (dispose) {
      dispose();
      missionWatchers.delete(missionId);
    }
  }

  app.addHook("onClose", (_instance, done) => {
    for (const dispose of missionWatchers.values()) dispose();
    missionWatchers.clear();
    done();
  });

  function buildMissionDetail(mission: Mission): MissionDetail {
    return {
      mission,
      agents: missionsStore.listAgents(mission.id),
      messages: mailboxStore.list(mission.id),
      claims: claimsStore.list(mission.id),
      conflicts: claimsStore.listConflicts(mission.id),
      tasks: tasksStore.list(mission.id),
    };
  }

  /** Looks up a mission by id, or replies 404 and returns null. Shared by
   * every route below `/api/swarm/missions/:id/...`. */
  function requireMission(
    id: string,
    reply: { status: (code: number) => { send: (body: unknown) => void } }
  ): Mission | null {
    const mission = missionsStore.getMission(id);
    if (!mission) {
      reply.status(404).send({ error: `No mission with id "${id}"` });
      return null;
    }
    return mission;
  }

  /** Looks up a task by id AND confirms it belongs to `mission` — a task
   * id from a different mission must 404 exactly like an unknown one,
   * never leak details about a task that isn't this mission's business. */
  function requireTask(
    mission: Mission,
    taskId: string,
    reply: { status: (code: number) => { send: (body: unknown) => void } }
  ) {
    const task = tasksStore.get(taskId);
    if (!task || task.missionId !== mission.id) {
      reply.status(404).send({ error: `No task with id "${taskId}" in mission "${mission.id}"` });
      return null;
    }
    return task;
  }

  // --- missions -------------------------------------------------------------

  app.get("/api/swarm/missions", async (request, reply) => {
    const query = request.query as { workspaceId?: unknown };
    const workspace = requireWorkspace(workspaceStore, query.workspaceId, reply);
    if (!workspace) return;
    return { missions: missionsStore.listMissions(workspace.id) };
  });

  app.get("/api/swarm/missions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const mission = requireMission(id, reply);
    if (!mission) return;
    return buildMissionDetail(mission);
  });

  app.post("/api/swarm/missions", async (request, reply) => {
    const body = (request.body ?? {}) as {
      workspaceId?: unknown;
      prompt?: unknown;
      agents?: unknown;
    };

    const workspace = requireWorkspace(workspaceStore, body.workspaceId, reply);
    if (!workspace) return;

    if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
      return reply.status(400).send({ error: '"prompt" must be a non-empty string' });
    }

    if (!Array.isArray(body.agents) || body.agents.length === 0) {
      return reply.status(400).send({ error: '"agents" must be a non-empty array' });
    }

    // Validate every spec up front — one bad entry should reject the whole
    // request rather than half-spawning a mission.
    const specs: { role: MissionRole; agent: AgentId; count: number }[] = [];
    for (const raw of body.agents) {
      const entry = raw as { role?: unknown; agent?: unknown; count?: unknown };
      if (!isMissionRole(entry.role)) {
        return reply.status(400).send({ error: `Each agent spec's "role" must be one of: ${MISSION_ROLES.join(", ")}` });
      }
      if (!isAgentId(entry.agent)) {
        return reply.status(400).send({ error: `Each agent spec's "agent" must be one of: ${AGENT_IDS.join(", ")}` });
      }
      const count = entry.count === undefined ? 1 : entry.count;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
        return reply.status(400).send({ error: '"count", if given, must be a positive integer' });
      }
      specs.push({ role: entry.role, agent: entry.agent, count });
    }

    // Check every distinct agent CLI this mission will need BEFORE creating
    // anything — same "don't half-create, then fail" reasoning as the role
    // validation above, and the same 409-with-install-hint shape
    // board/routes.ts's dispatch endpoint uses.
    const availability = await detectAllAgents();
    const missingAgent = specs.find((spec) => !availability[spec.agent]);
    if (missingAgent) {
      return reply.status(409).send({
        error: `The "${missingAgent.agent}" agent isn't installed on this machine. Install it first, then try again.`,
        installHint: INSTALL_HINTS[missingAgent.agent],
      });
    }

    const mission = missionsStore.createMission({ workspaceId: workspace.id, prompt: body.prompt.trim() });

    // Number labels per-role across the WHOLE mission ("Builder 1",
    // "Builder 2", ...) even when two different agent specs share a role
    // (e.g. one "claude" builder and one "shell" builder) — a shared
    // counter, not one per spec, is what makes that numbering continuous.
    const ordinals: Partial<Record<MissionRole, number>> = {};
    for (const spec of specs) {
      for (let i = 0; i < spec.count; i++) {
        const ordinal = (ordinals[spec.role] ?? 0) + 1;
        ordinals[spec.role] = ordinal;
        spawnMissionAgent(missionsStore, sessionManager, mission, workspace.rootPath, spec.role, spec.agent, ordinal, serverPort);
      }
    }

    startWatcherFor(mission.id, workspace.rootPath);

    return reply.status(201).send(buildMissionDetail(mission));
  });

  app.patch("/api/swarm/missions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const mission = requireMission(id, reply);
    if (!mission) return;

    const body = (request.body ?? {}) as { status?: unknown };
    if (!isMissionStatus(body.status)) {
      return reply.status(400).send({ error: `"status" must be one of: ${MISSION_STATUSES.join(", ")}` });
    }

    if (body.status === "stopped") {
      // Stopping a mission is the one transition with real side effects:
      // kill every agent's pty session AND release every claim it holds
      // (Phase 9a spec: claims must not outlive their holder, and a stopped
      // mission has no holders left at all).
      for (const agent of missionsStore.listAgents(mission.id)) {
        if (!agent.sessionId) continue;
        try {
          sessionManager.kill(agent.sessionId);
        } catch {
          // Session may already have exited/been killed independently —
          // nothing more to do.
        }
      }
      claimsStore.releaseAllForMission(mission.id);
      stopWatcherFor(mission.id);
    } else if (body.status !== "running") {
      // Paused/complete: no sessions killed, no claims released (unlike
      // stop, these are meant to be resumable), but the watcher only runs
      // for an actually-RUNNING mission.
      stopWatcherFor(mission.id);
    } else if (body.status === "running" && mission.status !== "running") {
      // Resuming (e.g. from "paused") — restart the watcher.
      const workspace = workspaceStore.get(mission.workspaceId);
      if (workspace) startWatcherFor(mission.id, workspace.rootPath);
    }

    return missionsStore.updateMissionStatus(mission.id, body.status)!;
  });

  // --- mailbox ----------------------------------------------------------

  app.get("/api/swarm/missions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const mission = requireMission(id, reply);
    if (!mission) return;

    const query = request.query as { since?: unknown };
    const since = typeof query.since === "string" && query.since.length > 0 ? query.since : undefined;
    return { messages: mailboxStore.list(mission.id, since) };
  });

  app.post("/api/swarm/missions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const mission = requireMission(id, reply);
    if (!mission) return;

    const body = (request.body ?? {}) as { fromAgentId?: unknown; toAgentId?: unknown; body?: unknown };
    if (typeof body.body !== "string" || body.body.trim().length === 0) {
      return reply.status(400).send({ error: '"body" must be a non-empty string' });
    }
    if (body.fromAgentId !== undefined && body.fromAgentId !== null && typeof body.fromAgentId !== "string") {
      return reply.status(400).send({ error: '"fromAgentId" must be a string or null' });
    }
    if (body.toAgentId !== undefined && body.toAgentId !== null && typeof body.toAgentId !== "string") {
      return reply.status(400).send({ error: '"toAgentId" must be a string or null' });
    }

    const message = mailboxStore.send({
      missionId: mission.id,
      fromAgentId: body.fromAgentId as string | null | undefined,
      toAgentId: body.toAgentId as string | null | undefined,
      body: body.body,
    });

    // Deliver into the target's pty when it has a live session — null
    // toAgentId means broadcast to every agent in the mission that has one.
    const targets = message.toAgentId
      ? missionsStore.listAgents(mission.id).filter((agent) => agent.id === message.toAgentId)
      : missionsStore.listAgents(mission.id);

    const wireLine = `${toSingleLine(message.body)}\n`;
    for (const target of targets) {
      if (!target.sessionId) continue;
      try {
        sessionManager.write(target.sessionId, wireLine);
      } catch {
        // Session may have exited — nothing more to do for this target.
      }
    }

    return reply.status(201).send(message);
  });

  // --- tasks ---------------------------------------------------------------
  // Sequencing layer: a task declares which paths it expects to touch, and
  // `tasksStore.getSchedule`/`update` (see tasks.ts's top comment) group
  // non-overlapping tasks into waves and refuse to start a task whose
  // wave's predecessors aren't complete yet. This is a DIFFERENT
  // mechanism than file_claims below — sequencing prevents PLANNED
  // collisions before any agent is even spawned; claims catch UNPLANNED
  // ones at claim-time. See docs/SWARM.md.

  app.get("/api/swarm/missions/:id/tasks", async (request, reply) => {
    const { id } = request.params as { id: string };
    const mission = requireMission(id, reply);
    if (!mission) return;
    return { tasks: tasksStore.list(mission.id) };
  });

  app.post("/api/swarm/missions/:id/tasks", async (request, reply) => {
    const { id } = request.params as { id: string };
    const mission = requireMission(id, reply);
    if (!mission) return;

    const body = (request.body ?? {}) as { title?: unknown; prompt?: unknown; declaredPaths?: unknown };
    if (typeof body.title !== "string" || body.title.trim().length === 0) {
      return reply.status(400).send({ error: '"title" must be a non-empty string' });
    }
    if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
      return reply.status(400).send({ error: '"prompt" must be a non-empty string' });
    }
    if (body.declaredPaths !== undefined && !isStringArray(body.declaredPaths)) {
      return reply.status(400).send({ error: '"declaredPaths" must be an array of strings' });
    }

    const task = tasksStore.create({
      missionId: mission.id,
      title: body.title.trim(),
      prompt: body.prompt.trim(),
      declaredPaths: body.declaredPaths as string[] | undefined,
    });
    return reply.status(201).send(task);
  });

  // GET the mission's current tasks grouped into waves. Registered BEFORE
  // the "/:taskId" routes below so Fastify's router doesn't try to match
  // the literal segment "schedule" against a ":taskId" param.
  app.get("/api/swarm/missions/:id/tasks/schedule", async (request, reply) => {
    const { id } = request.params as { id: string };
    const mission = requireMission(id, reply);
    if (!mission) return;
    return { waves: tasksStore.getSchedule(mission.id) } satisfies TaskScheduleResponse;
  });

  app.patch("/api/swarm/missions/:id/tasks/:taskId", async (request, reply) => {
    const { id, taskId } = request.params as { id: string; taskId: string };
    const mission = requireMission(id, reply);
    if (!mission) return;
    if (!requireTask(mission, taskId, reply)) return;

    const body = (request.body ?? {}) as { status?: unknown; assignedAgentId?: unknown };
    const patch: { status?: Exclude<MissionTaskStatus, "complete">; assignedAgentId?: string | null } = {};

    if ("status" in body) {
      if (body.status === "complete") {
        return reply.status(400).send({
          error:
            `A task cannot be completed directly — POST ` +
            `/api/swarm/missions/${mission.id}/tasks/${taskId}/review with {"approved":true} instead.`,
        });
      }
      if (!isNonCompleteTaskStatus(body.status)) {
        return reply
          .status(400)
          .send({ error: `"status" must be one of: ${NON_COMPLETE_TASK_STATUSES.join(", ")}, or set via review` });
      }
      patch.status = body.status;
    }
    if ("assignedAgentId" in body) {
      if (body.assignedAgentId !== null && typeof body.assignedAgentId !== "string") {
        return reply.status(400).send({ error: '"assignedAgentId" must be a string or null' });
      }
      patch.assignedAgentId = body.assignedAgentId as string | null;
    }

    const result = tasksStore.update(taskId, patch);
    if (!result.ok) {
      if (result.reason === "not-found") {
        return reply.status(404).send({ error: `No task with id "${taskId}"` });
      }
      if (result.reason === "complete-requires-review") {
        return reply.status(400).send({ error: "A task can only reach 'complete' via the review endpoint." });
      }
      // reason === "wave-not-ready" — "only dispatch a wave once the
      // previous wave is complete", enforced here rather than by a
      // background scheduler.
      return reply.status(409).send({
        error: `This task's wave isn't ready — still waiting on: ${result.blockedBy.join(", ")}`,
        blockedBy: result.blockedBy,
      });
    }
    return result.task;
  });

  app.post("/api/swarm/missions/:id/tasks/:taskId/review", async (request, reply) => {
    const { id, taskId } = request.params as { id: string; taskId: string };
    const mission = requireMission(id, reply);
    if (!mission) return;
    if (!requireTask(mission, taskId, reply)) return;

    const body = (request.body ?? {}) as { reviewerAgentId?: unknown; approved?: unknown; notes?: unknown };
    if (typeof body.reviewerAgentId !== "string" || body.reviewerAgentId.length === 0) {
      return reply.status(400).send({ error: '"reviewerAgentId" must be a non-empty string' });
    }
    if (typeof body.approved !== "boolean") {
      return reply.status(400).send({ error: '"approved" must be a boolean' });
    }
    if (body.notes !== undefined && body.notes !== null && typeof body.notes !== "string") {
      return reply.status(400).send({ error: '"notes" must be a string or null' });
    }

    // THE reviewer gate. tasksStore.review() itself is role-agnostic (it
    // just records whoever called it) — the actual "must be a
    // reviewer-role agent" enforcement lives HERE, where the caller's
    // claimed identity is resolved against this mission's real agents.
    // Without this check, "a task cannot reach complete without a
    // reviewer-role approval" would just be a naming convention, not a
    // rule.
    const reviewer = missionsStore.getAgent(body.reviewerAgentId);
    if (!reviewer || reviewer.missionId !== mission.id) {
      return reply.status(404).send({ error: `No agent with id "${body.reviewerAgentId}" in this mission` });
    }
    if (reviewer.role !== "reviewer") {
      return reply.status(403).send({
        error: `Agent "${body.reviewerAgentId}" is a "${reviewer.role}", not a reviewer — only a reviewer-role agent can approve or reject a task.`,
      });
    }

    const result = tasksStore.review(
      taskId,
      body.approved,
      (body.notes as string | undefined) ?? null,
      body.reviewerAgentId
    );
    if (!result.ok) {
      // requireTask above already confirmed the task exists in this
      // mission, so "not-found" can't actually happen here — but the
      // TaskMutationResult type still carries it, and better-sqlite3 is
      // synchronous, so nothing could have deleted it in between.
      return reply.status(404).send({ error: `No task with id "${taskId}"` });
    }
    return result.task;
  });

  // --- claims -------------------------------------------------------------

  app.post("/api/swarm/missions/:id/claims", async (request, reply) => {
    const { id } = request.params as { id: string };
    const mission = requireMission(id, reply);
    if (!mission) return;

    const body = (request.body ?? {}) as { agentId?: unknown; path?: unknown };
    if (typeof body.agentId !== "string" || body.agentId.length === 0) {
      return reply.status(400).send({ error: '"agentId" must be a non-empty string' });
    }

    const workspace = workspaceStore.get(mission.workspaceId);
    if (!workspace) {
      return reply.status(404).send({ error: `No workspace with id "${mission.workspaceId}"` });
    }

    const result = claimsStore.claim(mission.id, body.agentId, workspace.rootPath, body.path);
    if (result.ok) {
      return reply.status(201).send(result.claim);
    }
    if (result.reason === "invalid-path") {
      return reply.status(400).send({ error: result.error });
    }
    // reason === "held" — the whole point of §1's design: no queueing, just
    // a 409 naming exactly who has it.
    return reply.status(409).send({
      error: `"${result.holder.path}" is already claimed by agent "${result.holder.agentId}"`,
      holder: result.holder,
    });
  });

  app.post("/api/swarm/missions/:id/claims/heartbeat", async (request, reply) => {
    const { id } = request.params as { id: string };
    const mission = requireMission(id, reply);
    if (!mission) return;

    const body = (request.body ?? {}) as { agentId?: unknown };
    if (typeof body.agentId !== "string" || body.agentId.length === 0) {
      return reply.status(400).send({ error: '"agentId" must be a non-empty string' });
    }

    const refreshed = claimsStore.heartbeat(mission.id, body.agentId);
    return { refreshed };
  });

  app.delete("/api/swarm/missions/:id/claims", async (request, reply) => {
    const { id } = request.params as { id: string };
    const mission = requireMission(id, reply);
    if (!mission) return;

    const body = (request.body ?? {}) as { agentId?: unknown; path?: unknown };
    if (typeof body.agentId !== "string" || body.agentId.length === 0) {
      return reply.status(400).send({ error: '"agentId" must be a non-empty string' });
    }

    if (body.path === undefined) {
      const released = claimsStore.release(mission.id, body.agentId);
      return released; // { ok: true, released: n }
    }

    const workspace = workspaceStore.get(mission.workspaceId);
    if (!workspace) {
      return reply.status(404).send({ error: `No workspace with id "${mission.workspaceId}"` });
    }
    const result = claimsStore.release(mission.id, body.agentId, workspace.rootPath, body.path);
    if (!result.ok) {
      return reply.status(400).send({ error: result.error });
    }
    return result;
  });

  app.get("/api/swarm/missions/:id/conflicts", async (request, reply) => {
    const { id } = request.params as { id: string };
    const mission = requireMission(id, reply);
    if (!mission) return;
    return { conflicts: claimsStore.listConflicts(mission.id) };
  });

  // --- quality gates ------------------------------------------------------

  app.post("/api/swarm/missions/:id/gates", async (request, reply) => {
    const { id } = request.params as { id: string };
    const mission = requireMission(id, reply);
    if (!mission) return;

    const body = (request.body ?? {}) as { command?: unknown };
    if (typeof body.command !== "string" || body.command.trim().length === 0) {
      return reply.status(400).send({ error: '"command" must be a non-empty string' });
    }

    const workspace = workspaceStore.get(mission.workspaceId);
    if (!workspace) {
      return reply.status(404).send({ error: `No workspace with id "${mission.workspaceId}"` });
    }

    const result = await runGate(body.command, workspace.rootPath);
    return result;
  });
}
