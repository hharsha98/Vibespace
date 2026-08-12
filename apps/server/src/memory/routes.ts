/**
 * Phase 8's REST surface: CRUD for memory notes, plus the whole-workspace
 * link graph. Kept in its own module — same reasoning as board/routes.ts
 * and files/routes.ts's top comments — and structured very close to
 * files/routes.ts specifically, since both take a `workspaceId` plus a
 * client-supplied relative identifier (a file path there, a note slug
 * here) that has to be resolved safely before touching disk. All the
 * actual disk work and slug/path safety live in `./store.ts`; this file is
 * just request validation + wiring.
 */
import type { FastifyInstance } from "fastify";
import type { MemoryNoteWithBacklinks } from "@vibedeck/shared";
import type { WorkspaceStore } from "../db/workspaces.js";
import * as memoryStore from "./store.js";
import { buildGraph } from "./links.js";

export interface MemoryRoutesDeps {
  workspaceStore: WorkspaceStore;
}

/** Looks up a workspace by id, or replies 400/404 and returns null if it's
 * missing/unknown. Mirrors files/routes.ts's `requireWorkspace` exactly
 * (down to the 400-for-missing-id, 404-for-unknown-id split) so the two
 * "workspace-scoped resource" route modules behave identically from a
 * client's point of view. */
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

/** True if `value` is an array of plain strings — the shape `tags` must be
 * in a request body, if present at all. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export function registerMemoryRoutes(app: FastifyInstance, deps: MemoryRoutesDeps): void {
  const { workspaceStore } = deps;

  app.get("/api/memory/notes", async (request, reply) => {
    const query = request.query as { workspaceId?: unknown };
    const workspace = requireWorkspace(workspaceStore, query.workspaceId, reply);
    if (!workspace) return;
    return { notes: memoryStore.list(workspace.rootPath) };
  });

  app.get("/api/memory/notes/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const query = request.query as { workspaceId?: unknown };
    const workspace = requireWorkspace(workspaceStore, query.workspaceId, reply);
    if (!workspace) return;

    const note = memoryStore.get(workspace.rootPath, slug);
    if (!note) {
      return reply.status(404).send({ error: `No note with slug "${slug}"` });
    }

    // Backlinks aren't stored on the note itself — they're derived from
    // every OTHER note's body, so computing them means building the whole
    // workspace's graph. Fine at the note-count this phase targets (~200);
    // see docs/MEMORY.md for that ceiling.
    const { backlinks } = buildGraph(memoryStore.list(workspace.rootPath));
    const withBacklinks: MemoryNoteWithBacklinks = { ...note, backlinks: backlinks[slug] ?? [] };
    return withBacklinks;
  });

  app.post("/api/memory/notes", async (request, reply) => {
    const body = (request.body ?? {}) as {
      workspaceId?: unknown;
      title?: unknown;
      body?: unknown;
      tags?: unknown;
    };

    const workspace = requireWorkspace(workspaceStore, body.workspaceId, reply);
    if (!workspace) return;

    if (typeof body.title !== "string" || body.title.trim().length === 0) {
      return reply.status(400).send({ error: '"title" must be a non-empty string' });
    }
    if (body.body !== undefined && typeof body.body !== "string") {
      return reply.status(400).send({ error: '"body" must be a string' });
    }
    if (body.tags !== undefined && !isStringArray(body.tags)) {
      return reply.status(400).send({ error: '"tags" must be an array of strings' });
    }

    const note = memoryStore.create(workspace.rootPath, {
      title: body.title.trim(),
      body: body.body as string | undefined,
      tags: body.tags as string[] | undefined,
    });
    return reply.status(201).send(note);
  });

  app.patch("/api/memory/notes/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const body = (request.body ?? {}) as {
      workspaceId?: unknown;
      title?: unknown;
      body?: unknown;
      tags?: unknown;
    };

    const workspace = requireWorkspace(workspaceStore, body.workspaceId, reply);
    if (!workspace) return;

    const patch: memoryStore.UpdateNoteOptions = {};
    if ("title" in body) {
      if (typeof body.title !== "string" || body.title.trim().length === 0) {
        return reply.status(400).send({ error: '"title" must be a non-empty string' });
      }
      patch.title = body.title.trim();
    }
    if ("body" in body) {
      if (typeof body.body !== "string") {
        return reply.status(400).send({ error: '"body" must be a string' });
      }
      patch.body = body.body;
    }
    if ("tags" in body) {
      if (!isStringArray(body.tags)) {
        return reply.status(400).send({ error: '"tags" must be an array of strings' });
      }
      patch.tags = body.tags;
    }

    const updated = memoryStore.update(workspace.rootPath, slug, patch);
    if (!updated) {
      return reply.status(404).send({ error: `No note with slug "${slug}"` });
    }
    return updated;
  });

  app.delete("/api/memory/notes/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const query = request.query as { workspaceId?: unknown };
    const workspace = requireWorkspace(workspaceStore, query.workspaceId, reply);
    if (!workspace) return;

    if (!memoryStore.remove(workspace.rootPath, slug)) {
      return reply.status(404).send({ error: `No note with slug "${slug}"` });
    }
    return reply.status(204).send();
  });

  app.get("/api/memory/graph", async (request, reply) => {
    const query = request.query as { workspaceId?: unknown };
    const workspace = requireWorkspace(workspaceStore, query.workspaceId, reply);
    if (!workspace) return;

    const { nodes, edges } = buildGraph(memoryStore.list(workspace.rootPath));
    return { nodes, edges };
  });
}
