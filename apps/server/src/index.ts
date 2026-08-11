import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { AGENT_IDS, AGENT_SPECS, type ClientMessage } from "@vibedeck/shared";
import { detectAllAgents, INSTALL_HINTS, isAgentId } from "./pty/agents.js";
import { SessionManager } from "./pty/session-manager.js";
import { WorkspaceStore } from "./db/workspaces.js";
import { BoardStore } from "./db/board.js";
import { resolveRootPath } from "./workspace-path.js";
import { registerFileRoutes } from "./files/routes.js";
import { registerBoardRoutes } from "./board/routes.js";

const VERSION = "0.0.0";
const PORT = 4317;

export interface BuildAppOptions {
  /** Inject a SessionManager (mainly for tests). Defaults to a fresh one. */
  sessionManager?: SessionManager;
  /** Inject a WorkspaceStore (mainly for tests). Defaults to a fresh one. */
  workspaceStore?: WorkspaceStore;
  /** Inject a BoardStore (mainly for tests). Defaults to a fresh one. */
  boardStore?: BoardStore;
}

/**
 * Builds the Fastify app without starting a listener. Kept separate from
 * the `listen()` call below so tests can exercise the app in-process (via
 * `app.inject()`) without binding a real network port.
 */
export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: false });
  const sessionManager = options.sessionManager ?? new SessionManager();
  const workspaceStore = options.workspaceStore ?? new WorkspaceStore();
  const boardStore = options.boardStore ?? new BoardStore();

  // Make the manager/store reachable from outside (tests call
  // app.sessionManager/app.workspaceStore/app.boardStore directly to assert
  // on state, and to tear down in test teardown).
  app.decorate("sessionManager", sessionManager);
  app.decorate("workspaceStore", workspaceStore);
  app.decorate("boardStore", boardStore);

  // Kill every pty and close the database when the Fastify instance closes,
  // so `app.close()` in tests (and a real process shutdown) doesn't leave
  // shell/agent processes running, or the SQLite file handle open, in the
  // background.
  app.addHook("onClose", (_instance, done) => {
    sessionManager.disposeAll();
    workspaceStore.close();
    boardStore.close();
    done();
  });

  app.register(fastifyWebsocket);

  // Phase 6: file tree / editor / preview endpoints. Registered as its own
  // module (apps/server/src/files/routes.ts) rather than inlined here —
  // this file was already large before file endpoints existed, and every
  // one of those routes shares the same "resolve + guard" logic that lives
  // in files/safe-path.ts, which is easier to keep straight in a dedicated
  // module than interleaved with session/workspace routes.
  registerFileRoutes(app, workspaceStore);

  // Phase 7: the board — CRUD for cards plus the agent-dispatch action. See
  // board/routes.ts's top comment for why this is its own module too.
  registerBoardRoutes(app, { workspaceStore, boardStore, sessionManager, serverPort: PORT });

  app.get("/api/health", async () => ({
    status: "ok" as const,
    version: VERSION,
    agents: AGENT_IDS,
    // The server's own working directory — used by the web UI only to
    // pre-fill a sensible default path when prompting a first-time user to
    // create their first workspace. Not otherwise load-bearing.
    cwd: process.cwd(),
  }));

  app.get("/api/agents", async () => {
    const availability = await detectAllAgents();
    return {
      agents: AGENT_IDS.map((id) => ({
        id,
        displayName: AGENT_SPECS[id].displayName,
        available: availability[id],
        installHint: availability[id] ? null : INSTALL_HINTS[id],
      })),
    };
  });

  app.get("/api/workspaces", async () => ({
    workspaces: workspaceStore.list(),
  }));

  app.post("/api/workspaces", async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown; rootPath?: unknown };

    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return reply.status(400).send({ error: '"name" must be a non-empty string' });
    }

    const resolved = resolveRootPath(body.rootPath);
    if (!resolved.ok) {
      return reply.status(400).send({ error: resolved.error });
    }

    const workspace = workspaceStore.create({ name: body.name.trim(), rootPath: resolved.path });
    return reply.status(201).send(workspace);
  });

  app.get("/api/workspaces/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspace = workspaceStore.get(id);
    if (!workspace) {
      return reply.status(404).send({ error: `No workspace with id "${id}"` });
    }
    return workspace;
  });

  app.patch("/api/workspaces/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!workspaceStore.get(id)) {
      return reply.status(404).send({ error: `No workspace with id "${id}"` });
    }

    const body = (request.body ?? {}) as { name?: unknown; rootPath?: unknown; layout?: unknown };
    const changes: { name?: string; rootPath?: string; layout?: string | null } = {};

    if ("name" in body) {
      if (typeof body.name !== "string" || body.name.trim().length === 0) {
        return reply.status(400).send({ error: '"name" must be a non-empty string' });
      }
      changes.name = body.name.trim();
    }

    if ("rootPath" in body) {
      const resolved = resolveRootPath(body.rootPath);
      if (!resolved.ok) {
        return reply.status(400).send({ error: resolved.error });
      }
      changes.rootPath = resolved.path;
    }

    if ("layout" in body) {
      if (body.layout !== null && typeof body.layout !== "string") {
        return reply.status(400).send({ error: '"layout" must be a JSON string or null' });
      }
      changes.layout = body.layout;
    }

    // Existence was already confirmed above and better-sqlite3 is
    // synchronous (no `await` between that check and this call, so nothing
    // else could have deleted it in between) — this is always defined.
    return workspaceStore.update(id, changes)!;
  });

  app.delete("/api/workspaces/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!workspaceStore.remove(id)) {
      return reply.status(404).send({ error: `No workspace with id "${id}"` });
    }
    return reply.status(204).send();
  });

  app.get("/api/sessions", async () => ({
    sessions: sessionManager.list(),
  }));

  app.post("/api/sessions", async (request, reply) => {
    const body = (request.body ?? {}) as {
      agent?: unknown;
      cwd?: unknown;
      cols?: unknown;
      rows?: unknown;
      workspaceId?: unknown;
    };

    if (!isAgentId(body.agent)) {
      return reply.status(400).send({
        error: `"agent" must be one of: ${AGENT_IDS.join(", ")}`,
      });
    }

    const availability = await detectAllAgents();
    if (!availability[body.agent]) {
      const spec = AGENT_SPECS[body.agent];
      return reply.status(409).send({
        error:
          `The "${body.agent}" agent isn't installed on this machine ` +
          `(looked for the "${spec.command}" command on PATH). ` +
          `Install it first, then try again.`,
        installHint: INSTALL_HINTS[body.agent],
      });
    }

    // A workspaceId, if given, is the source of truth for where this pane
    // spawns — this is the actual fix for the "every pane opens in the
    // server's own cwd" bug: we look up the workspace's rootPath and use
    // that, ignoring any `cwd` the caller also sent, so a stale/incorrect
    // client-supplied cwd can never silently override the workspace.
    let cwd: string;
    if (body.workspaceId !== undefined) {
      if (typeof body.workspaceId !== "string") {
        return reply.status(400).send({ error: '"workspaceId" must be a string' });
      }
      const workspace = workspaceStore.get(body.workspaceId);
      if (!workspace) {
        return reply.status(400).send({ error: `No workspace with id "${body.workspaceId}"` });
      }
      cwd = workspace.rootPath;
    } else {
      cwd = typeof body.cwd === "string" ? body.cwd : process.cwd();
    }

    const cols = typeof body.cols === "number" ? body.cols : 80;
    const rows = typeof body.rows === "number" ? body.rows : 24;

    const info = sessionManager.create({ agent: body.agent, cwd, cols, rows });
    return reply.status(201).send(info);
  });

  app.delete("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionManager.get(id)) {
      return reply.status(404).send({ error: `No session with id "${id}"` });
    }
    sessionManager.kill(id);
    return reply.status(204).send();
  });

  // @fastify/websocket's `onRoute` hook (which is what upgrades `socket`
  // into a real, usable `ws` WebSocket with a working `.send()`) only
  // reliably applies to routes declared inside a nested `register()`
  // callback — this matches the plugin's own README example. Declaring
  // the websocket route directly on the root `app` instance instead
  // produces a socket object where `.send` is not a function, discovered
  // by testing this against a real client connection.
  app.register(async (scoped) => {
    scoped.get("/api/sessions/:id/ws", { websocket: true }, (socket, request) => {
      const { id } = request.params as { id: string };

      if (!sessionManager.get(id)) {
        // Unknown session id: close the socket immediately with a reason
        // instead of leaving the client hanging.
        socket.close(1008, `No session with id "${id}"`);
        return;
      }

      // Send the "ready" handshake: replayed scrollback + current size, so
      // the client can render exactly what it would have seen had it been
      // attached all along.
      const { cols, rows } = sessionManager.getSize(id);
      socket.send(
        JSON.stringify({
          type: "ready",
          sessionId: id,
          history: sessionManager.getHistory(id),
          cols,
          rows,
        })
      );

      const unsubscribe = sessionManager.attach(id, (event) => {
        if (socket.readyState !== socket.OPEN) return;
        if (event.type === "output") {
          socket.send(JSON.stringify({ type: "output", sessionId: id, data: event.data }));
        } else {
          socket.send(JSON.stringify({ type: "exit", sessionId: id, code: event.code }));
        }
      });

      socket.on("message", (raw: Buffer) => {
        let message: ClientMessage;
        try {
          message = JSON.parse(raw.toString()) as ClientMessage;
        } catch {
          return; // Ignore malformed frames rather than crashing the connection.
        }

        try {
          if (message.type === "input") {
            sessionManager.write(id, message.data);
          } else if (message.type === "resize") {
            sessionManager.resize(id, message.cols, message.rows);
          }
        } catch {
          // Session may have been killed concurrently — ignore.
        }
      });

      // Closing the browser tab / socket must NOT kill the pty — only stop
      // forwarding events to this now-gone listener.
      socket.on("close", () => {
        unsubscribe();
      });
    });
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    sessionManager: SessionManager;
    workspaceStore: WorkspaceStore;
    boardStore: BoardStore;
  }
}

// Only start listening when this file is run directly (e.g. via `tsx
// watch src/index.ts`), not when it's imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildApp();
  app
    .listen({ port: PORT, host: "0.0.0.0" })
    .then(() => {
      console.log(`vibedeck server listening on http://localhost:${PORT}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });

  // Make sure spawned ptys don't outlive the server process on a normal
  // Ctrl+C / kill.
  const shutdown = () => {
    app.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
