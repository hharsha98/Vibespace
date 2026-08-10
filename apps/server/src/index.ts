import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { AGENT_IDS, AGENT_SPECS, type AgentId, type ClientMessage } from "@vibedeck/shared";
import { detectAllAgents } from "./pty/agents.js";
import { SessionManager } from "./pty/session-manager.js";

const VERSION = "0.0.0";
const PORT = 4317;

/** True if `value` is one of the known AgentId strings. */
function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value);
}

export interface BuildAppOptions {
  /** Inject a SessionManager (mainly for tests). Defaults to a fresh one. */
  sessionManager?: SessionManager;
}

/**
 * Builds the Fastify app without starting a listener. Kept separate from
 * the `listen()` call below so tests can exercise the app in-process (via
 * `app.inject()`) without binding a real network port.
 */
export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: false });
  const sessionManager = options.sessionManager ?? new SessionManager();

  // Make the manager reachable from outside (tests call app.sessionManager
  // directly to assert on state, and to disposeAll() in teardown).
  app.decorate("sessionManager", sessionManager);

  // Kill every pty when the Fastify instance closes, so `app.close()` in
  // tests (and a real process shutdown) doesn't leave shell/agent
  // processes running in the background.
  app.addHook("onClose", (_instance, done) => {
    sessionManager.disposeAll();
    done();
  });

  app.register(fastifyWebsocket);

  app.get("/api/health", async () => ({
    status: "ok" as const,
    version: VERSION,
    agents: AGENT_IDS,
  }));

  app.get("/api/agents", async () => {
    const availability = await detectAllAgents();
    return {
      agents: AGENT_IDS.map((id) => ({
        id,
        displayName: AGENT_SPECS[id].displayName,
        available: availability[id],
      })),
    };
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
      });
    }

    const cwd = typeof body.cwd === "string" ? body.cwd : process.cwd();
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
