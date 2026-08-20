import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_IDS, AGENT_SPECS, WORKSPACE_COLORS, isWorkspaceColor, type ClientMessage } from "@vibedeck/shared";
import { resolveServerPort, resolveStaticDir, formatReadyLine } from "./runtime-config.js";
import { detectAllAgents, INSTALL_HINTS, isAgentId } from "./pty/agents.js";
import { SessionManager } from "./pty/session-manager.js";
import { WorkspaceStore } from "./db/workspaces.js";
import { BoardStore } from "./db/board.js";
import { resolveRootPath } from "./workspace-path.js";
import { registerFileRoutes } from "./files/routes.js";
import { registerBoardRoutes } from "./board/routes.js";
import { registerMemoryRoutes } from "./memory/routes.js";
import { MissionsStore } from "./swarm/missions.js";
import { ClaimsStore } from "./swarm/claims.js";
import { MailboxStore } from "./swarm/mailbox.js";
import { TasksStore } from "./swarm/tasks.js";
import { registerSwarmRoutes } from "./swarm/routes.js";
import { AgentProfileStore } from "./agents/store.js";
import { registerAgentRoutes } from "./agents/routes.js";
import { SavedPromptStore } from "./prompts/store.js";
import { registerPromptRoutes } from "./prompts/routes.js";
import { registerGitRoutes } from "./git/routes.js";
import { registerSkillRoutes } from "./skills/routes.js";
import { CommandHistoryStore } from "./db/command-history.js";
import { registerHistoryRoutes } from "./history/routes.js";

const VERSION = "0.0.0";
// Phase 11a (PARITY #50): resolveServerPort defaults to 4317 — identical to
// the old hardcoded literal — unless VIBEDECK_PORT is set, which only the
// desktop app's sidecar wrapper does (see runtime-config.ts's doc comment
// for why 4317 itself is unsafe for the desktop app to reuse).
const PORT = resolveServerPort(process.env);

export interface BuildAppOptions {
  /** Inject a SessionManager (mainly for tests). Defaults to a fresh one. */
  sessionManager?: SessionManager;
  /** Inject a WorkspaceStore (mainly for tests). Defaults to a fresh one. */
  workspaceStore?: WorkspaceStore;
  /** Inject a BoardStore (mainly for tests). Defaults to a fresh one. */
  boardStore?: BoardStore;
  /** Inject a MissionsStore (mainly for tests). Defaults to a fresh one. */
  missionsStore?: MissionsStore;
  /** Inject a ClaimsStore (mainly for tests). Defaults to a fresh one. */
  claimsStore?: ClaimsStore;
  /** Inject a MailboxStore (mainly for tests). Defaults to a fresh one. */
  mailboxStore?: MailboxStore;
  /** Inject a TasksStore (mainly for tests). Defaults to a fresh one. */
  tasksStore?: TasksStore;
  /** Inject an AgentProfileStore (mainly for tests). Defaults to a fresh one. */
  agentProfileStore?: AgentProfileStore;
  /** Inject a SavedPromptStore (mainly for tests). Defaults to a fresh one. */
  savedPromptStore?: SavedPromptStore;
  /** Inject a CommandHistoryStore (mainly for tests). Defaults to a fresh one. */
  commandHistoryStore?: CommandHistoryStore;
  /**
   * Phase 11a (PARITY #50): absolute path to a built `apps/web/dist` to
   * serve as static files, turning this server into the single origin for
   * the whole app (no Vite, no /api proxy) — what the packaged desktop app
   * and a plain `node dist/index.js` deployment both need. `undefined`/`null`
   * (the default, and what every existing test passes) means "don't serve
   * static files at all" — the exact pre-Phase-11a behaviour. Deliberately
   * an explicit opt-in field on `buildApp` rather than something this
   * function auto-detects itself: the auto-detection (env var or on-disk
   * `apps/web/dist`) lives in the startup block at the bottom of this file,
   * so `buildApp()` in tests never has to think about whatever might
   * happen to exist on the machine running them.
   */
  staticDir?: string | null;
}

/**
 * Builds the Fastify app without starting a listener. Kept separate from
 * the `listen()` call below so tests can exercise the app in-process (via
 * `app.inject()`) without binding a real network port.
 */
export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: false,
    // Fastify's default bodyLimit is 1MiB, comfortably enough for every
    // route in this file except one: POST /api/files/paste-image (BridgeSpace
    // parity item 2) sends a pasted screenshot as a base64 JSON string,
    // which runs ~33% bigger than the raw image bytes it encodes. That
    // route enforces its own 20MB (raw, decoded) cap — see
    // `files/routes.ts`'s `MAX_PASTE_IMAGE_BYTES` — so this just needs to
    // be comfortably above 20MB's base64 size (~27MB) plus JSON overhead,
    // not itself the real limit.
    bodyLimit: 30 * 1024 * 1024, // 30MB
  });
  const sessionManager = options.sessionManager ?? new SessionManager();
  const workspaceStore = options.workspaceStore ?? new WorkspaceStore();
  const boardStore = options.boardStore ?? new BoardStore();
  const missionsStore = options.missionsStore ?? new MissionsStore();
  const claimsStore = options.claimsStore ?? new ClaimsStore();
  const mailboxStore = options.mailboxStore ?? new MailboxStore();
  const tasksStore = options.tasksStore ?? new TasksStore();
  const agentProfileStore = options.agentProfileStore ?? new AgentProfileStore();
  const savedPromptStore = options.savedPromptStore ?? new SavedPromptStore();
  const commandHistoryStore = options.commandHistoryStore ?? new CommandHistoryStore();

  // Make the manager/store reachable from outside (tests call
  // app.sessionManager/app.workspaceStore/app.boardStore/etc directly to
  // assert on state, and to tear down in test teardown).
  app.decorate("sessionManager", sessionManager);
  app.decorate("workspaceStore", workspaceStore);
  app.decorate("boardStore", boardStore);
  app.decorate("missionsStore", missionsStore);
  app.decorate("tasksStore", tasksStore);
  app.decorate("claimsStore", claimsStore);
  app.decorate("mailboxStore", mailboxStore);
  app.decorate("agentProfileStore", agentProfileStore);
  app.decorate("savedPromptStore", savedPromptStore);
  app.decorate("commandHistoryStore", commandHistoryStore);

  // Kill every pty and close the database when the Fastify instance closes,
  // so `app.close()` in tests (and a real process shutdown) doesn't leave
  // shell/agent processes running, or the SQLite file handle open, in the
  // background.
  app.addHook("onClose", (_instance, done) => {
    sessionManager.disposeAll();
    workspaceStore.close();
    boardStore.close();
    missionsStore.close();
    claimsStore.close();
    mailboxStore.close();
    tasksStore.close();
    agentProfileStore.close();
    savedPromptStore.close();
    commandHistoryStore.close();
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

  // Phase 8: shared agent memory — CRUD for markdown notes plus the link
  // graph. See memory/routes.ts's top comment.
  registerMemoryRoutes(app, { workspaceStore });

  // Phase 9a: swarm core — missions, mailbox, file claims, conflicts, and
  // quality gates. See swarm/routes.ts's top comment.
  registerSwarmRoutes(app, {
    workspaceStore,
    missionsStore,
    claimsStore,
    mailboxStore,
    tasksStore,
    sessionManager,
    serverPort: PORT,
  });

  // Phase 9.5b: agent profiles (stored {name, systemPrompt} personas,
  // PARITY #26) and the saved-prompts library (PARITY #27). See
  // agents/routes.ts's top comment for why agent profiles are registered
  // under /api/agent-profiles rather than /api/agents — the latter is
  // already the "which CLIs are installed" endpoint below.
  registerAgentRoutes(app, { workspaceStore, agentProfileStore });
  registerPromptRoutes(app, { workspaceStore, savedPromptStore });

  // Phase 9.5c: the pane header's git-branch chip (PARITY #13b). See
  // git/routes.ts's top comment.
  registerGitRoutes(app, { workspaceStore });

  // Phase 10: Skills (PARITY #37) — the agentskills.io standard. See
  // skills/routes.ts's top comment and docs/SKILLS.md.
  registerSkillRoutes(app, { workspaceStore, sessionManager });

  // BridgeSpace parity item 4: per-workspace command history backing the
  // prompt bar's autocomplete. See history/routes.ts's top comment.
  registerHistoryRoutes(app, { workspaceStore, commandHistoryStore });

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

    const body = (request.body ?? {}) as {
      name?: unknown;
      rootPath?: unknown;
      layout?: unknown;
      color?: unknown;
    };
    const changes: { name?: string; rootPath?: string; layout?: string | null; color?: string | null } = {};

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

    // Phase 9.5c (PARITY #41): null explicitly clears a previously-chosen
    // colour (falls back to the neutral look); anything else must be one of
    // the fixed palette — no free-text hex values, so the rail/pane-header
    // rendering never has to cope with an arbitrary, possibly-illegible
    // colour a client made up.
    if ("color" in body) {
      if (body.color !== null && !isWorkspaceColor(body.color)) {
        return reply
          .status(400)
          .send({ error: `"color" must be null or one of: ${WORKSPACE_COLORS.join(", ")}` });
      }
      changes.color = body.color as string | null;
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

  // Phase 11a (PARITY #50): serve the built web app as static files when a
  // directory was given, turning this server + the browser bundle into one
  // origin (what the desktop app's webview loads — no Vite, no /api proxy).
  // Registered LAST, after every API route above: @fastify/static's
  // `wildcard: true` adds a catch-all GET route, but Fastify's router
  // matches the most specific registered path first regardless of
  // registration order, so this can never shadow `/api/*` — verified by
  // the "existing API routes still work" static-serving test in
  // index.test.ts, not just assumed from how the router is documented to
  // work. `index: true` (the plugin default) serves `index.html` at `/`;
  // there is no client-side router in the web app (see main.tsx), so no
  // further SPA-style fallback is needed for deep links.
  if (options.staticDir) {
    app.register(fastifyStatic, {
      root: options.staticDir,
      wildcard: true,
    });
  }

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    sessionManager: SessionManager;
    workspaceStore: WorkspaceStore;
    boardStore: BoardStore;
    missionsStore: MissionsStore;
    claimsStore: ClaimsStore;
    mailboxStore: MailboxStore;
    tasksStore: TasksStore;
    agentProfileStore: AgentProfileStore;
    savedPromptStore: SavedPromptStore;
    commandHistoryStore: CommandHistoryStore;
  }
}

// Only start listening when this file is run directly (e.g. via `tsx
// watch src/index.ts`), not when it's imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  // Phase 11a (PARITY #50): resolve whether to serve a built web app here,
  // at the real entrypoint — not inside buildApp() itself — so tests never
  // have to reason about VIBEDECK_STATIC_DIR or a possibly-stale on-disk
  // apps/web/dist. See resolveStaticDir's doc comment in runtime-config.ts.
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const staticDir = resolveStaticDir({ env: process.env, moduleDir });

  const app = buildApp({ staticDir });
  app
    .listen({ port: PORT, host: "0.0.0.0" })
    .then(() => {
      console.log(`vibedeck server listening on http://localhost:${PORT}`);
      if (staticDir) {
        console.log(`serving built web app from ${staticDir}`);
      }
      // Desktop sidecar readiness signal (see runtime-config.ts's doc
      // comment on formatReadyLine) — a no-op line when nothing is reading
      // this process's stdout for it, which is every case except the
      // Tauri wrapper in apps/desktop.
      console.log(formatReadyLine(PORT));
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
