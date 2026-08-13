/**
 * Phase 9.5b (PARITY #27) REST endpoints: CRUD for the saved-prompts
 * library. Structured the same way `board/routes.ts`/`agents/routes.ts`
 * are: one module, request validation + wiring only, all persistence in
 * `./store.ts`.
 *
 * Unlike `board/routes.ts` and `agents/routes.ts`, `workspaceId` here is
 * OPTIONAL, not required — see `SavedPromptStore.list`'s doc comment: a
 * request with no `workspaceId` still gets every global prompt back, and
 * one WITH a `workspaceId` gets globals plus that workspace's own. There is
 * therefore no `requireWorkspace`-style 400/404 gate on the list route; an
 * unknown `workspaceId` on GET degrades to "just the globals" rather than
 * erroring, since a global-only view is a completely valid request. `POST`,
 * however, DOES validate a given (non-null) `workspaceId` against real
 * workspaces — creating a prompt scoped to a workspace that doesn't exist
 * would be a silently-orphaned row no UI could ever surface.
 */
import type { FastifyInstance } from "fastify";
import type { WorkspaceStore } from "../db/workspaces.js";
import type { SavedPromptStore, UpdateSavedPromptOptions } from "./store.js";

export interface PromptRoutesDeps {
  workspaceStore: WorkspaceStore;
  savedPromptStore: SavedPromptStore;
}

export function registerPromptRoutes(app: FastifyInstance, deps: PromptRoutesDeps): void {
  const { workspaceStore, savedPromptStore } = deps;

  app.get("/api/prompts", async (request) => {
    const query = request.query as { workspaceId?: unknown };
    const workspaceId =
      typeof query.workspaceId === "string" && query.workspaceId.length > 0 ? query.workspaceId : undefined;
    return { prompts: savedPromptStore.list(workspaceId) };
  });

  app.get("/api/prompts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const prompt = savedPromptStore.get(id);
    if (!prompt) {
      return reply.status(404).send({ error: `No prompt with id "${id}"` });
    }
    return prompt;
  });

  app.post("/api/prompts", async (request, reply) => {
    const body = (request.body ?? {}) as { workspaceId?: unknown; title?: unknown; body?: unknown };

    if (
      body.workspaceId !== undefined &&
      body.workspaceId !== null &&
      typeof body.workspaceId !== "string"
    ) {
      return reply.status(400).send({ error: '"workspaceId" must be a string or null' });
    }
    // A non-null workspaceId must name a real workspace — see this file's
    // top comment for why a null/omitted one (global) skips this check
    // entirely rather than 400ing.
    if (typeof body.workspaceId === "string" && body.workspaceId.length > 0) {
      if (!workspaceStore.get(body.workspaceId)) {
        return reply.status(404).send({ error: `No workspace with id "${body.workspaceId}"` });
      }
    }
    if (typeof body.title !== "string" || body.title.trim().length === 0) {
      return reply.status(400).send({ error: '"title" must be a non-empty string' });
    }
    if (typeof body.body !== "string" || body.body.trim().length === 0) {
      return reply.status(400).send({ error: '"body" must be a non-empty string' });
    }

    const prompt = savedPromptStore.create({
      workspaceId: (body.workspaceId as string | null | undefined) ?? null,
      title: body.title.trim(),
      body: body.body,
    });
    return reply.status(201).send(prompt);
  });

  app.patch("/api/prompts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!savedPromptStore.get(id)) {
      return reply.status(404).send({ error: `No prompt with id "${id}"` });
    }

    const body = (request.body ?? {}) as { title?: unknown; body?: unknown };
    const patch: UpdateSavedPromptOptions = {};

    if ("title" in body) {
      if (typeof body.title !== "string" || body.title.trim().length === 0) {
        return reply.status(400).send({ error: '"title" must be a non-empty string' });
      }
      patch.title = body.title.trim();
    }
    if ("body" in body) {
      if (typeof body.body !== "string" || body.body.trim().length === 0) {
        return reply.status(400).send({ error: '"body" must be a non-empty string' });
      }
      patch.body = body.body;
    }

    // Existence was already confirmed above and better-sqlite3 is
    // synchronous — this is always defined.
    return savedPromptStore.update(id, patch)!;
  });

  app.delete("/api/prompts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!savedPromptStore.remove(id)) {
      return reply.status(404).send({ error: `No prompt with id "${id}"` });
    }
    return reply.status(204).send();
  });
}
