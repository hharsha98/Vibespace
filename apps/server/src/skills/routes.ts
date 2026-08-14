/**
 * Phase 10's REST surface for Skills (PARITY #37) — the open `agentskills.io`
 * standard (see `docs/SKILLS.md`), NOT a private format. `./discover.ts`
 * does all the real work of finding and parsing skills; this file is just
 * request validation + shaping the response, structured close to
 * `../memory/routes.ts` (same `requireWorkspace` shape, same "list is
 * metadata-only, read is full body" progressive-disclosure split).
 */
import type { FastifyInstance } from "fastify";
import type { WorkspaceStore } from "../db/workspaces.js";
import type { SessionManager } from "../pty/session-manager.js";
import { catalogEntry, discoverSkills, fullSkill } from "./discover.js";
import { prepareSkillInjection } from "./inject.js";

export interface SkillRoutesDeps {
  workspaceStore: WorkspaceStore;
  sessionManager: SessionManager;
}

/** Looks up a workspace by id, or replies 400/404 and returns null if it's
 * missing/unknown — mirrors `memory/routes.ts`'s `requireWorkspace` (down
 * to the 400-for-missing-id, 404-for-unknown-id split), duplicated here
 * rather than imported since neither existing copy (`memory/routes.ts`,
 * inlined in `board/routes.ts`) is exported for reuse. */
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

export function registerSkillRoutes(app: FastifyInstance, deps: SkillRoutesDeps): void {
  const { workspaceStore, sessionManager } = deps;

  // The CATALOG: name/description/scope/location + diagnostics, never the
  // full body — per progressive disclosure, an agent (or the future web
  // UI) should be able to decide which skill is relevant from this alone.
  app.get("/api/skills", async (request, reply) => {
    const query = request.query as { workspaceId?: unknown };
    const workspace = requireWorkspace(workspaceStore, query.workspaceId, reply);
    if (!workspace) return;

    const { skills, diagnostics } = discoverSkills(workspace.rootPath);
    return { skills: skills.map(catalogEntry), diagnostics };
  });

  // One skill, in full — frontmatter + complete body.
  app.get("/api/skills/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const query = request.query as { workspaceId?: unknown };
    const workspace = requireWorkspace(workspaceStore, query.workspaceId, reply);
    if (!workspace) return;

    const { skills } = discoverSkills(workspace.rootPath);
    const found = skills.find((s) => s.skill.name === name);
    if (!found) {
      return reply.status(404).send({ error: `No skill named "${name}"` });
    }
    return fullSkill(found);
  });

  // PARITY #37's actual point: type a skill's body into a running pane.
  // See ./inject.ts for the newline-folding and shell-pane rules this
  // delegates to — this handler is just "find the skill, find the
  // session, apply those rules, write".
  app.post("/api/skills/:name/inject", async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = (request.body ?? {}) as { workspaceId?: unknown; sessionId?: unknown };

    const workspace = requireWorkspace(workspaceStore, body.workspaceId, reply);
    if (!workspace) return;

    if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
      return reply.status(400).send({ error: '"sessionId" must be a string' });
    }

    const { skills } = discoverSkills(workspace.rootPath);
    const found = skills.find((s) => s.skill.name === name);
    if (!found) {
      return reply.status(404).send({ error: `No skill named "${name}"` });
    }

    const session = sessionManager.get(body.sessionId);
    if (!session) {
      return reply.status(404).send({ error: `No session with id "${body.sessionId}"` });
    }

    const prepared = prepareSkillInjection(session.agent, found.skill);
    if (!prepared.ok) {
      return reply.status(400).send({ error: prepared.error });
    }

    sessionManager.write(body.sessionId, prepared.text);
    return reply.status(200).send({ injected: true, truncated: prepared.truncated });
  });
}
