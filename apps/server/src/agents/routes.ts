/**
 * Phase 9.5b (PARITY #26) REST endpoints: CRUD for agent profiles — stored
 * `{name, systemPrompt}` personas scoped to a workspace, per BridgeMCP
 * (docs/RESEARCH.md §2). Structured the same way `board/routes.ts` is: one
 * module, request validation + wiring only, all persistence in
 * `./store.ts`.
 *
 * PATH NOTE (a deliberate deviation worth flagging): the natural REST path
 * for this resource would be `/api/agents`, but `index.ts` already
 * registers `GET /api/agents` for something unrelated — "which coding-agent
 * CLIs (claude/cursor-agent/codex/shell) are installed on this machine",
 * static availability info with no workspace and no database row at all.
 * Fastify allows exactly one handler per (method, path) pair; a second
 * `app.get("/api/agents", ...)` here would throw at startup. Rather than
 * overload that one existing handler with two structurally different
 * response shapes depending on whether `?workspaceId=` is present (a
 * genuine surprise for any caller who doesn't already know that trick),
 * agent PROFILE CRUD is registered under `/api/agent-profiles` instead —
 * `GET/POST /api/agent-profiles` and `GET/PATCH/DELETE
 * /api/agent-profiles/:id`. The two concerns ("what's installed" vs "what
 * personas has the user saved") stay separate, readable endpoints instead
 * of one endpoint doing two jobs.
 */
import type { FastifyInstance } from "fastify";
import { AGENT_IDS, AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH, type AgentId } from "@vibespace/shared";
import type { WorkspaceStore } from "../db/workspaces.js";
import type { AgentProfileStore, UpdateAgentProfileOptions } from "./store.js";
import { isAgentId } from "../pty/agents.js";

export interface AgentRoutesDeps {
  workspaceStore: WorkspaceStore;
  agentProfileStore: AgentProfileStore;
}

/** Looks up a workspace by id, or replies 400/404 and returns null if it's
 * missing/unknown. Mirrors `memory/routes.ts`'s `requireWorkspace` exactly. */
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

/** Names the conflict, per the phase spec ("409 ... naming the conflict") —
 * matches `swarm/routes.ts`'s claims-409 shape (`error` names exactly what
 * collided), not a bare "conflict" string. */
function duplicateNameError(name: string) {
  return { error: `An agent named "${name}" already exists in this workspace` };
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRoutesDeps): void {
  const { workspaceStore, agentProfileStore } = deps;

  app.get("/api/agent-profiles", async (request, reply) => {
    const query = request.query as { workspaceId?: unknown };
    const workspace = requireWorkspace(workspaceStore, query.workspaceId, reply);
    if (!workspace) return;
    return { agents: agentProfileStore.list(workspace.id) };
  });

  app.get("/api/agent-profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = agentProfileStore.get(id);
    if (!agent) {
      return reply.status(404).send({ error: `No agent profile with id "${id}"` });
    }
    return agent;
  });

  app.post("/api/agent-profiles", async (request, reply) => {
    const body = (request.body ?? {}) as {
      workspaceId?: unknown;
      name?: unknown;
      systemPrompt?: unknown;
      baseAgent?: unknown;
    };

    const workspace = requireWorkspace(workspaceStore, body.workspaceId, reply);
    if (!workspace) return;

    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return reply.status(400).send({ error: '"name" must be a non-empty string' });
    }
    if (typeof body.systemPrompt !== "string" || body.systemPrompt.trim().length === 0) {
      return reply.status(400).send({ error: '"systemPrompt" must be a non-empty string' });
    }
    if (body.systemPrompt.length > AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH) {
      return reply.status(400).send({
        error: `"systemPrompt" must be at most ${AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH} characters`,
      });
    }
    if (!isAgentId(body.baseAgent)) {
      return reply.status(400).send({ error: `"baseAgent" must be one of: ${AGENT_IDS.join(", ")}` });
    }

    const name = body.name.trim();
    const result = agentProfileStore.create({
      workspaceId: workspace.id,
      name,
      systemPrompt: body.systemPrompt,
      baseAgent: body.baseAgent,
    });
    if (!result.ok) {
      // The only failure create() can report is a duplicate name — see
      // ./store.ts's top comment for why this is a UNIQUE-constraint
      // rejection, not a pre-check, and therefore race-safe.
      return reply.status(409).send(duplicateNameError(name));
    }
    return reply.status(201).send(result.agent);
  });

  app.patch("/api/agent-profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = agentProfileStore.get(id);
    if (!existing) {
      return reply.status(404).send({ error: `No agent profile with id "${id}"` });
    }

    const body = (request.body ?? {}) as { name?: unknown; systemPrompt?: unknown; baseAgent?: unknown };
    const patch: UpdateAgentProfileOptions = {};

    if ("name" in body) {
      if (typeof body.name !== "string" || body.name.trim().length === 0) {
        return reply.status(400).send({ error: '"name" must be a non-empty string' });
      }
      patch.name = body.name.trim();
    }
    if ("systemPrompt" in body) {
      if (typeof body.systemPrompt !== "string" || body.systemPrompt.trim().length === 0) {
        return reply.status(400).send({ error: '"systemPrompt" must be a non-empty string' });
      }
      if (body.systemPrompt.length > AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH) {
        return reply.status(400).send({
          error: `"systemPrompt" must be at most ${AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH} characters`,
        });
      }
      patch.systemPrompt = body.systemPrompt;
    }
    if ("baseAgent" in body) {
      if (!isAgentId(body.baseAgent)) {
        return reply.status(400).send({ error: `"baseAgent" must be one of: ${AGENT_IDS.join(", ")}` });
      }
      patch.baseAgent = body.baseAgent as AgentId;
    }

    const result = agentProfileStore.update(id, patch);
    if (!result.ok) {
      if (result.reason === "not-found") {
        // Existence was already confirmed above; better-sqlite3 is
        // synchronous, so nothing could have deleted it in between — this
        // branch is unreachable in practice but kept because the store's
        // return type carries it honestly.
        return reply.status(404).send({ error: `No agent profile with id "${id}"` });
      }
      return reply.status(409).send(duplicateNameError(patch.name ?? existing.name));
    }
    return result.agent;
  });

  app.delete("/api/agent-profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!agentProfileStore.remove(id)) {
      return reply.status(404).send({ error: `No agent profile with id "${id}"` });
    }
    return reply.status(204).send();
  });
}
