/**
 * Role preambles: the first thing typed into a freshly-dispatched mission
 * agent's pty, telling it what part it plays in the swarm and how to use
 * the swarm HTTP API (claims, mailbox) it needs for that role.
 *
 * Every preamble MUST render to a single line — writing a newline into a
 * pty is the same as the user pressing Enter, i.e. "submit" (see
 * `board/dispatch.ts`'s `toSingleLine` comment for the full story: Phase 7
 * hit this bug for real). `buildRolePreamble` reuses that same exported
 * `toSingleLine` rather than re-solving the same problem here.
 *
 * Unlike `board/dispatch.ts`'s `buildDispatchPrompt`, this does NOT
 * special-case the "shell" agent to skip the English preamble. Board cards
 * special-cased it because a shell card's body IS meant to be a literal
 * command. A mission's role preamble is never meant to be a command for any
 * agent — it's the same "who are you, what are the rules" text regardless
 * of which CLI is spawned. Dispatching a mission to `shell` (as this
 * repo's tests do, since CI has no AI CLIs installed) just means that text
 * gets typed into a plain shell prompt, which will error trying to
 * "execute" it — harmless, and exactly what you'd expect from asking a
 * shell to be a coordinator.
 */
import type { MissionAgent, MissionRole } from "@vibespace/shared";
import { toSingleLine } from "../board/dispatch.js";

/** What each role means, and — for builder — the one rule that matters
 * most: claim before you edit. Scout/reviewer are explicitly told they
 * never edit, so there's no ambiguity about whether they need to claim
 * anything. */
const ROLE_DESCRIPTIONS: Record<MissionRole, string> = {
  coordinator:
    "the COORDINATOR. Split the mission prompt into concrete tasks, assign them to the other agents over the mailbox, and synthesise their results when they report back. You do not edit files yourself.",
  builder:
    "a BUILDER. You write code. Before editing ANY file, claim it first with POST /api/swarm/missions/<missionId>/claims and body {\"agentId\":\"<your agent id>\",\"path\":\"<file>\"} — a 409 response means someone else holds it, so don't edit it; pick different work or ask over the mailbox instead. Release a claim with DELETE on the same URL once you're done with that file.",
  scout:
    "a SCOUT. Explore the codebase and report findings over the mailbox. You never edit files, so you never need to claim one.",
  reviewer:
    "a REVIEWER. Review other agents' work and report findings over the mailbox. You never edit files, so you never need to claim one.",
};

/**
 * Builds the preamble typed into `agent`'s pty when it's first spawned.
 * `serverPort` is baked into the mailbox URL the same way
 * `buildDispatchPrompt` bakes it into its `curl` example — see that
 * function's comment on why (avoids an index.ts <-> swarm/* import cycle).
 */
export function buildRolePreamble(agent: MissionAgent, missionPrompt: string, serverPort: number): string {
  const roleText = ROLE_DESCRIPTIONS[agent.role];
  const base = `http://localhost:${serverPort}/api/swarm/missions/${agent.missionId}`;
  const mailboxHint =
    `Read the mailbox with GET ${base}/messages, and send with POST ${base}/messages and body ` +
    `{"fromAgentId":"${agent.id}","toAgentId":"<another agent id, or omit to broadcast>","body":"..."}.`;
  const preamble =
    `[vibespace swarm] You are "${agent.label}" (agent id "${agent.id}"), ${roleText} ${mailboxHint} ` +
    `The mission: ${missionPrompt}`;
  return `${toSingleLine(preamble)}\n`;
}
