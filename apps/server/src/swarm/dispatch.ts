/**
 * Mission spawn/dispatch wiring: turning "create this mission agent" into
 * an agent that's actually running AND has been told its role. Mirrors
 * `board/dispatch.ts`'s split of concerns exactly — `MissionsStore` (like
 * `BoardStore`) only tracks bookkeeping rows, `SessionManager` only knows
 * how to spawn/write to ptys, and this file is the glue between them, reusing
 * `writePromptWhenReady` for the same "don't type into a pty before it's
 * ready to receive input" reason `board/dispatch.ts`'s top comment explains.
 */
import type { AgentId, Mission, MissionAgent, MissionRole } from "@vibespace/shared";
import type { SessionManager } from "../pty/session-manager.js";
import { writePromptWhenReady } from "../board/dispatch.js";
import type { MissionsStore } from "./missions.js";
import { buildRolePreamble } from "./roles.js";

/** Human-facing label capitalisation for each role — "Builder 2", not
 * "builder 2". Purely cosmetic (shown in the mission detail response /
 * future canvas), never parsed back out of. */
const ROLE_LABELS: Record<MissionRole, string> = {
  coordinator: "Coordinator",
  builder: "Builder",
  scout: "Scout",
  reviewer: "Reviewer",
};

/**
 * Creates a `mission_agents` row, spawns its pty, records the resulting
 * session, and types the role preamble in once the session looks ready.
 *
 * `ordinal` numbers this agent among others of the same role in the same
 * mission (1-based) — e.g. the second builder spawned gets "Builder 2".
 * The caller (routes.ts) tracks that counter across the whole
 * `agents:[{role, agent, count}]` request, since only it knows how many of
 * each role have been spawned so far.
 */
export function spawnMissionAgent(
  missionsStore: MissionsStore,
  sessionManager: SessionManager,
  mission: Mission,
  workspaceRootPath: string,
  role: MissionRole,
  agentId: AgentId,
  ordinal: number,
  serverPort: number
): MissionAgent {
  const label = `${ROLE_LABELS[role]} ${ordinal}`;
  const created = missionsStore.createAgent({ missionId: mission.id, role, label, agent: agentId });

  const session = sessionManager.create({ agent: agentId, cwd: workspaceRootPath });

  // Record the session immediately — even before the preamble has actually
  // been typed in (writePromptWhenReady is fire-and-forget, same as
  // board/dispatch.ts) — so a client that lists mission agents right after
  // this call sees a real sessionId, not a still-null one.
  const updated = missionsStore.updateAgent(created.id, { sessionId: session.id, status: "working" })!;

  const preamble = buildRolePreamble(updated, mission.prompt, serverPort);
  writePromptWhenReady(sessionManager, session.id, preamble);

  return updated;
}
