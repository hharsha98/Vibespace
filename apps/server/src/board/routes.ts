/**
 * Phase 7 (the board) REST endpoints: CRUD for board cards, plus the
 * "dispatch to an agent" action that's this phase's signature feature. Kept
 * in its own module, not inlined into index.ts, for the same reason
 * files/routes.ts is separate — index.ts was already large before this
 * phase, and every route here shares the same validation helpers, which
 * are easier to keep straight together than interleaved with session/
 * workspace routes.
 */
import type { FastifyInstance } from "fastify";
import {
  AGENT_IDS,
  CARD_DESCRIPTION_MAX_LENGTH,
  CARD_PRIORITIES,
  CARD_TASK_KNOWLEDGE_MAX_LENGTH,
  COLUMN_IDS,
  type AgentId,
  type CardPriority,
  type ColumnId,
} from "@vibedeck/shared";
import type { WorkspaceStore } from "../db/workspaces.js";
import type { BoardStore, UpdateCardOptions } from "../db/board.js";
import type { SessionManager } from "../pty/session-manager.js";
import { detectAllAgents, INSTALL_HINTS, isAgentId } from "../pty/agents.js";
import { buildDispatchPrompt, writePromptWhenReady } from "./dispatch.js";

function isCardPriority(value: unknown): value is CardPriority {
  return typeof value === "string" && (CARD_PRIORITIES as readonly string[]).includes(value);
}

function isColumnId(value: unknown): value is ColumnId {
  return typeof value === "string" && (COLUMN_IDS as readonly string[]).includes(value);
}

export interface BoardRoutesDeps {
  workspaceStore: WorkspaceStore;
  boardStore: BoardStore;
  sessionManager: SessionManager;
  /** The port the server itself is listening on — baked into the dispatch
   * preamble's `curl` example (see dispatch.ts's `buildDispatchPrompt`).
   * Passed in rather than imported from index.ts, which would create an
   * index.ts <-> board/routes.ts import cycle (index.ts registers these
   * routes). */
  serverPort: number;
}

export function registerBoardRoutes(app: FastifyInstance, deps: BoardRoutesDeps): void {
  const { workspaceStore, boardStore, sessionManager, serverPort } = deps;

  app.get("/api/board/cards", async (request, reply) => {
    const query = request.query as { workspaceId?: unknown };
    if (typeof query.workspaceId !== "string" || query.workspaceId.length === 0) {
      return reply.status(400).send({ error: '"workspaceId" must be a string' });
    }
    if (!workspaceStore.get(query.workspaceId)) {
      return reply.status(404).send({ error: `No workspace with id "${query.workspaceId}"` });
    }
    // BoardStore.list already sorts column-then-position, i.e. exactly the
    // order a caller wants to group cards into columns and render.
    return { cards: boardStore.list(query.workspaceId) };
  });

  app.post("/api/board/cards", async (request, reply) => {
    const body = (request.body ?? {}) as {
      workspaceId?: unknown;
      title?: unknown;
      description?: unknown;
      taskKnowledge?: unknown;
      priority?: unknown;
      columnId?: unknown;
    };

    if (typeof body.workspaceId !== "string" || body.workspaceId.length === 0) {
      return reply.status(400).send({ error: '"workspaceId" must be a string' });
    }
    if (!workspaceStore.get(body.workspaceId)) {
      return reply.status(404).send({ error: `No workspace with id "${body.workspaceId}"` });
    }
    if (typeof body.title !== "string" || body.title.trim().length === 0) {
      return reply.status(400).send({ error: '"title" must be a non-empty string' });
    }
    if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
      return reply.status(400).send({ error: '"description" must be a string or null' });
    }
    if (typeof body.description === "string" && body.description.length > CARD_DESCRIPTION_MAX_LENGTH) {
      return reply
        .status(400)
        .send({ error: `"description" must be at most ${CARD_DESCRIPTION_MAX_LENGTH} characters` });
    }
    if (
      body.taskKnowledge !== undefined &&
      body.taskKnowledge !== null &&
      typeof body.taskKnowledge !== "string"
    ) {
      return reply.status(400).send({ error: '"taskKnowledge" must be a string or null' });
    }
    if (typeof body.taskKnowledge === "string" && body.taskKnowledge.length > CARD_TASK_KNOWLEDGE_MAX_LENGTH) {
      return reply
        .status(400)
        .send({ error: `"taskKnowledge" must be at most ${CARD_TASK_KNOWLEDGE_MAX_LENGTH} characters` });
    }
    if (body.priority !== undefined && !isCardPriority(body.priority)) {
      return reply.status(400).send({ error: `"priority" must be one of: ${CARD_PRIORITIES.join(", ")}` });
    }
    if (body.columnId !== undefined && !isColumnId(body.columnId)) {
      return reply.status(400).send({ error: `"columnId" must be one of: ${COLUMN_IDS.join(", ")}` });
    }

    const card = boardStore.create({
      workspaceId: body.workspaceId,
      title: body.title.trim(),
      description: (body.description as string | null | undefined) ?? null,
      taskKnowledge: (body.taskKnowledge as string | null | undefined) ?? null,
      priority: body.priority as CardPriority | undefined,
      columnId: body.columnId as ColumnId | undefined,
    });
    return reply.status(201).send(card);
  });

  app.patch("/api/board/cards/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!boardStore.get(id)) {
      return reply.status(404).send({ error: `No board card with id "${id}"` });
    }

    const body = (request.body ?? {}) as {
      title?: unknown;
      description?: unknown;
      taskKnowledge?: unknown;
      priority?: unknown;
      columnId?: unknown;
      position?: unknown;
    };
    const patch: UpdateCardOptions = {};

    if ("title" in body) {
      if (typeof body.title !== "string" || body.title.trim().length === 0) {
        return reply.status(400).send({ error: '"title" must be a non-empty string' });
      }
      patch.title = body.title.trim();
    }
    if ("description" in body) {
      if (body.description !== null && typeof body.description !== "string") {
        return reply.status(400).send({ error: '"description" must be a string or null' });
      }
      if (typeof body.description === "string" && body.description.length > CARD_DESCRIPTION_MAX_LENGTH) {
        return reply
          .status(400)
          .send({ error: `"description" must be at most ${CARD_DESCRIPTION_MAX_LENGTH} characters` });
      }
      patch.description = body.description as string | null;
    }
    if ("taskKnowledge" in body) {
      if (body.taskKnowledge !== null && typeof body.taskKnowledge !== "string") {
        return reply.status(400).send({ error: '"taskKnowledge" must be a string or null' });
      }
      if (
        typeof body.taskKnowledge === "string" &&
        body.taskKnowledge.length > CARD_TASK_KNOWLEDGE_MAX_LENGTH
      ) {
        return reply
          .status(400)
          .send({ error: `"taskKnowledge" must be at most ${CARD_TASK_KNOWLEDGE_MAX_LENGTH} characters` });
      }
      patch.taskKnowledge = body.taskKnowledge as string | null;
    }
    if ("priority" in body) {
      if (!isCardPriority(body.priority)) {
        return reply.status(400).send({ error: `"priority" must be one of: ${CARD_PRIORITIES.join(", ")}` });
      }
      patch.priority = body.priority;
    }
    if ("columnId" in body) {
      if (!isColumnId(body.columnId)) {
        return reply.status(400).send({ error: `"columnId" must be one of: ${COLUMN_IDS.join(", ")}` });
      }
      patch.columnId = body.columnId;
    }
    if ("position" in body) {
      if (typeof body.position !== "number" || !Number.isFinite(body.position)) {
        return reply.status(400).send({ error: '"position" must be a finite number' });
      }
      patch.position = body.position;
    }

    // Existence was already confirmed above, and better-sqlite3 is
    // synchronous (no `await` in between), so this is always defined.
    return boardStore.update(id, patch)!;
  });

  app.delete("/api/board/cards/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!boardStore.remove(id)) {
      return reply.status(404).send({ error: `No board card with id "${id}"` });
    }
    return reply.status(204).send();
  });

  // --- Phase 7 §5: dispatch a card to an agent ------------------------------
  // Spawns a session (same underlying call POST /api/sessions makes),
  // records it on the card, moves the card to In Progress, and — once the
  // session looks ready — types the card's prompt into it. See dispatch.ts
  // for the settle-delay race this has to work around.
  app.post("/api/board/cards/:id/dispatch", async (request, reply) => {
    const { id } = request.params as { id: string };
    const card = boardStore.get(id);
    if (!card) {
      return reply.status(404).send({ error: `No board card with id "${id}"` });
    }

    const body = (request.body ?? {}) as { agent?: unknown };
    let agent: AgentId;
    if (body.agent !== undefined) {
      if (!isAgentId(body.agent)) {
        return reply.status(400).send({ error: `"agent" must be one of: ${AGENT_IDS.join(", ")}` });
      }
      agent = body.agent;
    } else if (card.agent) {
      // Re-dispatching a card that already names an agent (e.g. retrying)
      // reuses that agent unless the caller explicitly overrides it.
      agent = card.agent;
    } else {
      return reply.status(400).send({ error: '"agent" is required (this card has no agent set yet)' });
    }

    const workspace = workspaceStore.get(card.workspaceId);
    if (!workspace) {
      return reply.status(404).send({ error: `No workspace with id "${card.workspaceId}"` });
    }

    const availability = await detectAllAgents();
    if (!availability[agent]) {
      return reply.status(409).send({
        error: `The "${agent}" agent isn't installed on this machine. Install it first, then try again.`,
        installHint: INSTALL_HINTS[agent],
      });
    }

    const session = sessionManager.create({ agent, cwd: workspace.rootPath });

    // Dispatching always means "this card is now being worked on" — move it
    // to In Progress (a no-op position-wise if it's already there) in the
    // SAME update as recording the session/agent, so the two can never
    // observably disagree (e.g. a card showing a live session but still
    // sitting in To Do).
    const updated = boardStore.update(id, {
      columnId: "in_progress",
      sessionId: session.id,
      agent,
    })!;

    const prompt = buildDispatchPrompt(updated, serverPort, agent);
    writePromptWhenReady(sessionManager, session.id, prompt);

    return reply.status(200).send(updated);
  });
}
