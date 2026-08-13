/**
 * MCP tool handlers for agent-profile CRUD (Phase 9.5b, PARITY #27c) — the
 * same `AgentProfileStore` `./routes.ts` uses. See `board/mcp.ts`'s top
 * comment for the shared "takes an already-resolved workspaceId, testable
 * without a real workspace" design this follows.
 *
 * Tool names mirror BridgeMCP exactly (docs/RESEARCH.md §2): `list_agents`,
 * `get_agent`, `create_agent`, `update_agent`, `delete_agent`.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AGENT_IDS, AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH, type AgentId } from "@vibedeck/shared";
import type { AgentProfileStore, UpdateAgentProfileOptions } from "./store.js";
import { jsonResult, errorResult } from "../mcp/result.js";

function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value);
}

export async function handleListAgents(
  agentProfileStore: AgentProfileStore,
  workspaceId: string
): Promise<CallToolResult> {
  return jsonResult({ agents: agentProfileStore.list(workspaceId) });
}

export async function handleGetAgent(agentProfileStore: AgentProfileStore, agentId: string): Promise<CallToolResult> {
  const agent = agentProfileStore.get(agentId);
  if (!agent) {
    return errorResult(`No agent profile with id "${agentId}". Use list_agents to find one.`);
  }
  return jsonResult(agent);
}

export interface CreateAgentArgs {
  name?: string;
  systemPrompt?: string;
  baseAgent?: string;
}

export async function handleCreateAgent(
  agentProfileStore: AgentProfileStore,
  workspaceId: string,
  args: CreateAgentArgs
): Promise<CallToolResult> {
  if (!args.name || args.name.trim().length === 0) {
    return errorResult('"name" must be a non-empty string.');
  }
  if (!args.systemPrompt || args.systemPrompt.trim().length === 0) {
    return errorResult('"systemPrompt" must be a non-empty string.');
  }
  if (args.systemPrompt.length > AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH) {
    return errorResult(`"systemPrompt" must be at most ${AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH} characters.`);
  }
  if (!isAgentId(args.baseAgent)) {
    return errorResult(`"baseAgent" must be one of: ${AGENT_IDS.join(", ")}.`);
  }

  const name = args.name.trim();
  const result = agentProfileStore.create({
    workspaceId,
    name,
    systemPrompt: args.systemPrompt,
    baseAgent: args.baseAgent,
  });
  if (!result.ok) {
    return errorResult(`An agent named "${name}" already exists in this workspace.`);
  }
  return jsonResult(result.agent);
}

export interface UpdateAgentArgs {
  name?: string;
  systemPrompt?: string;
  baseAgent?: string;
}

export async function handleUpdateAgent(
  agentProfileStore: AgentProfileStore,
  agentId: string,
  args: UpdateAgentArgs
): Promise<CallToolResult> {
  if (args.name !== undefined && args.name.trim().length === 0) {
    return errorResult('"name" must be a non-empty string.');
  }
  if (args.systemPrompt !== undefined) {
    if (args.systemPrompt.trim().length === 0) {
      return errorResult('"systemPrompt" must be a non-empty string.');
    }
    if (args.systemPrompt.length > AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH) {
      return errorResult(`"systemPrompt" must be at most ${AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH} characters.`);
    }
  }
  if (args.baseAgent !== undefined && !isAgentId(args.baseAgent)) {
    return errorResult(`"baseAgent" must be one of: ${AGENT_IDS.join(", ")}.`);
  }

  const patch: UpdateAgentProfileOptions = {};
  if (args.name !== undefined) patch.name = args.name.trim();
  if (args.systemPrompt !== undefined) patch.systemPrompt = args.systemPrompt;
  if (args.baseAgent !== undefined) patch.baseAgent = args.baseAgent as AgentId;

  const result = agentProfileStore.update(agentId, patch);
  if (!result.ok) {
    if (result.reason === "not-found") {
      return errorResult(`No agent profile with id "${agentId}". Use list_agents to find one.`);
    }
    return errorResult(`An agent named "${patch.name}" already exists in this workspace.`);
  }
  return jsonResult(result.agent);
}

export async function handleDeleteAgent(
  agentProfileStore: AgentProfileStore,
  agentId: string
): Promise<CallToolResult> {
  if (!agentProfileStore.remove(agentId)) {
    return errorResult(`No agent profile with id "${agentId}". Use list_agents to find one.`);
  }
  return jsonResult({ deleted: true, id: agentId });
}
