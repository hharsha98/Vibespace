/**
 * Phase 9.5c (PARITY #13b) REST endpoint: `GET /api/git/branch`, the pane
 * header's `⑂ main` chip. Structured the same way `agents/routes.ts` is —
 * one module, request validation + wiring only, the actual git call lives
 * in `./branch.ts`.
 */
import type { FastifyInstance } from "fastify";
import type { WorkspaceStore } from "../db/workspaces.js";
import { safeResolve } from "../files/safe-path.js";
import { getGitBranch } from "./branch.js";

export interface GitRoutesDeps {
  workspaceStore: WorkspaceStore;
}

/** Looks up a workspace by id, or replies 400/404 and returns null if it's
 * missing/unknown. Mirrors `files/routes.ts`'s `requireWorkspace` exactly —
 * duplicated rather than imported, same "each route module is self-
 * contained" convention `agents/routes.ts`'s own copy of this helper
 * follows. */
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

export function registerGitRoutes(app: FastifyInstance, deps: GitRoutesDeps): void {
  const { workspaceStore } = deps;

  app.get("/api/git/branch", async (request, reply) => {
    const query = request.query as { workspaceId?: unknown; path?: unknown };
    const workspace = requireWorkspace(workspaceStore, query.workspaceId, reply);
    if (!workspace) return;

    // `path` is optional and workspace-relative, defaulting to the
    // workspace root — every pane currently spawns its session's cwd
    // exactly there (see index.ts's `POST /api/sessions`), so today this is
    // always ".". It exists as a parameter (not hard-coded to the root) so
    // a future per-pane cwd that differs from the workspace root can still
    // ask "what's the branch AT THIS SPECIFIC DIRECTORY" — and, just like
    // `files/tree`'s own `path` query param, it MUST go through
    // `safeResolve` rather than being trusted outright: a client-supplied
    // relative path is exactly the kind of input that could otherwise walk
    // this endpoint (and therefore the `git` process it spawns) outside the
    // workspace root.
    const relPath = typeof query.path === "string" && query.path.length > 0 ? query.path : ".";
    const resolved = safeResolve(workspace.rootPath, relPath);
    if (!resolved.ok) {
      return reply.status(403).send({ error: resolved.error });
    }

    return getGitBranch(resolved.path);
  });
}
