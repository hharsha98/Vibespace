/**
 * BridgeSpace parity item 4 REST endpoints: per-workspace command history
 * backing the per-pane prompt bar's autocomplete. Kept in its own module,
 * same reasoning as `prompts/routes.ts` — request validation + wiring
 * only, all persistence in `../db/command-history.ts`.
 *
 * Deliberately thin: `GET` returns the workspace's whole (deduped,
 * newest-first, capped) history pool, and `PromptBar.tsx`/`commandHistory.ts`
 * do the actual prefix-matching client-side — see that module's top comment
 * for why the matching itself lives there, not here (it's pure, UI-facing
 * logic, easiest to unit test where the UI that uses it lives).
 */
import type { FastifyInstance } from "fastify";
import type { WorkspaceStore } from "../db/workspaces.js";
import type { CommandHistoryStore } from "../db/command-history.js";

export interface HistoryRoutesDeps {
  workspaceStore: WorkspaceStore;
  commandHistoryStore: CommandHistoryStore;
}

export function registerHistoryRoutes(app: FastifyInstance, deps: HistoryRoutesDeps): void {
  const { workspaceStore, commandHistoryStore } = deps;

  app.get("/api/command-history", async (request, reply) => {
    const query = request.query as { workspaceId?: unknown };
    if (typeof query.workspaceId !== "string" || query.workspaceId.length === 0) {
      return reply.status(400).send({ error: '"workspaceId" must be a string' });
    }
    if (!workspaceStore.get(query.workspaceId)) {
      return reply.status(404).send({ error: `No workspace with id "${query.workspaceId}"` });
    }
    return { commands: commandHistoryStore.list(query.workspaceId) };
  });

  app.post("/api/command-history", async (request, reply) => {
    const body = (request.body ?? {}) as { workspaceId?: unknown; command?: unknown };

    if (typeof body.workspaceId !== "string" || body.workspaceId.length === 0) {
      return reply.status(400).send({ error: '"workspaceId" must be a string' });
    }
    if (!workspaceStore.get(body.workspaceId)) {
      return reply.status(404).send({ error: `No workspace with id "${body.workspaceId}"` });
    }
    if (typeof body.command !== "string" || body.command.trim().length === 0) {
      return reply.status(400).send({ error: '"command" must be a non-empty string' });
    }
    // A recorded command is always single-line, same "no embedded
    // newlines" rule Terminal.tsx's own `recordPendingCommand` enforces
    // client-side before ever calling this endpoint — enforced again here
    // since a server route must never trust client input to have actually
    // respected a client-side rule.
    if (body.command.includes("\n") || body.command.includes("\r")) {
      return reply.status(400).send({ error: '"command" must not contain newlines' });
    }

    commandHistoryStore.record(body.workspaceId, body.command.trim());
    return reply.status(204).send();
  });
}
