import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { AGENT_IDS, AGENT_SPECS, WORKSPACE_COLORS, isWorkspaceColor, type ClientMessage } from "@vibedeck/shared";
import { resolveServerPort, resolveStaticDir, formatReadyLine } from "./runtime-config.js";
import { commandExists, detectAllAgents, INSTALL_HINTS, isAgentId } from "./pty/agents.js";
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
import { SshProfileStore } from "./ssh/store.js";
import { registerSshRoutes } from "./ssh/routes.js";
import { SessionRecordsStore } from "./db/session-records.js";
import { spawnExtrasFor } from "./pty/resume.js";
import { trackSessionForRecovery } from "./pty/session-lifecycle.js";
import { attemptResume, restoreWorkspaceSessions } from "./pty/restore.js";
import { EAGER_RESTORE_BUDGET } from "./pty/restore-budget.js";

/**
 * Read out of `package.json` rather than written here, because a version
 * literal in source is a version literal that goes stale: this said
 * "0.0.0" while the shipped v0.1.1 desktop app reported exactly that over
 * `/api/health` — caught by probing a real downloaded DMG, not by any test.
 *
 * `../package.json` resolves in all three layouts this file runs under:
 * `src/index.ts` under tsx in development, `dist/index.js` in a normal
 * build, and `dist/index.js` inside the desktop app's relocated server
 * bundle — all three keep `package.json` exactly one directory up.
 *
 * Falls back rather than throwing. A version string is cosmetic; refusing
 * to start the server over one would not be.
 */
function readVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

const VERSION = readVersion();
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
  /** Inject an SshProfileStore (mainly for tests). Defaults to a fresh one. */
  sshProfileStore?: SshProfileStore;
  /** Inject a SessionRecordsStore (mainly for tests). Defaults to a fresh one. */
  sessionRecordsStore?: SessionRecordsStore;
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

  /**
   * Put the REAL reason in `error`, where this app's clients actually look.
   *
   * Fastify's default body for an uncaught throw is
   * `{statusCode, error: "Internal Server Error", message: "<the reason>"}`.
   * Every caller in the web app reads `body.error` — so a genuine failure
   * arrived as the string "Internal Server Error" and the one useful part,
   * `message`, was dropped on the floor.
   *
   * That gap has real teeth on the spawn path. Asking for an agent that
   * isn't installed is caught up front and answered with a 409 and an
   * install hint, but `pty.spawn` can still throw for things no
   * availability check can see: a binary that exists and won't execute, a
   * missing `spawn-helper`, an unusable cwd. A packaged build once lost
   * `spawn-helper`'s executable bit and every terminal died with
   * `posix_spawnp failed` — a message that is only worth anything if it
   * reaches the person looking at the screen.
   *
   * `err.statusCode` is preserved so Fastify's own 4xx (malformed JSON,
   * body too large) keep their status instead of all becoming 500s.
   */
  app.setErrorHandler((err: unknown, _request, reply) => {
    const fastifyErr = err as { statusCode?: number; message?: string };
    const status = fastifyErr.statusCode ?? 500;
    if (status >= 500) console.error("vibedeck: request failed", err);
    return reply.status(status).send({ error: fastifyErr.message ?? "Request failed" });
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
  const sshProfileStore = options.sshProfileStore ?? new SshProfileStore();
  const sessionRecordsStore = options.sessionRecordsStore ?? new SessionRecordsStore();

  // Session recovery: every record still marked 'running' belongs to a
  // PREVIOUS process — this one's `sessionManager` starts with an empty
  // session map, so nothing is left to check any of them against. Doing
  // this once, right here at boot (not lazily, not per-workspace), is what
  // turns "sessions die if the server restarts" into "sessions are offered
  // for resume after a restart" — see `SessionRecordsStore.
  // markServerRestartOrphans`'s own doc comment.
  sessionRecordsStore.markServerRestartOrphans();

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
  app.decorate("sshProfileStore", sshProfileStore);
  app.decorate("sessionRecordsStore", sessionRecordsStore);

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
    sshProfileStore.close();
    sessionRecordsStore.close();
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

  // SSH connection profiles (BridgeSpace v3.2.1 parity): CRUD + Duplicate
  // for stored `{host, user, port, defaultDirectory, startupCommand}`
  // records. See ssh/routes.ts's top comment and ssh/spawn.ts for how a
  // profile becomes a real `ssh` pty session (wired into POST
  // /api/sessions below, via the `sshProfileId` body field).
  registerSshRoutes(app, { sshProfileStore });

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
      // SSH connection profiles: an alternative to `agent` — spawns an
      // `ssh` pty against a stored SshProfile instead of a local CLI. See
      // ssh/spawn.ts for how the profile becomes an argv, and
      // SessionInfo.sshProfileId's doc comment (packages/shared/src/
      // protocol.ts) for why this doesn't reuse the `agent` field itself.
      sshProfileId?: unknown;
      // Session recovery: the web app's own GridNode leaf id this session
      // is being started in (see grid/tree.ts). Optional — a session
      // started outside any pane (board/swarm dispatch) simply omits it —
      // but every pane-originated spawn sends it, since it's what lets a
      // later resume land back in the SAME pane instead of "any empty
      // one". Stored verbatim on the SessionRecord below; never validated
      // against the live grid (the server has no notion of "panes", only
      // the client does).
      paneId?: unknown;
    };
    const paneId = typeof body.paneId === "string" ? body.paneId : null;
    const workspaceIdForRecord = typeof body.workspaceId === "string" ? body.workspaceId : null;

    if (body.sshProfileId !== undefined && body.agent !== undefined) {
      return reply.status(400).send({ error: 'Provide either "agent" or "sshProfileId", not both' });
    }

    // A workspaceId, if given, is the source of truth for where this pane
    // spawns — this is the actual fix for the "every pane opens in the
    // server's own cwd" bug: we look up the workspace's rootPath and use
    // that, ignoring any `cwd` the caller also sent, so a stale/incorrect
    // client-supplied cwd can never silently override the workspace. Shared
    // by both the local-agent and SSH paths below — for an SSH session this
    // is only where the LOCAL `ssh` client process itself starts, never the
    // remote directory (that's `defaultDirectory`, applied server-side by
    // ssh/spawn.ts's remote command, not by `cwd`).
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

    if (body.sshProfileId !== undefined) {
      if (typeof body.sshProfileId !== "string") {
        return reply.status(400).send({ error: '"sshProfileId" must be a string' });
      }
      const profile = sshProfileStore.get(body.sshProfileId);
      if (!profile) {
        return reply.status(400).send({ error: `No SSH profile with id "${body.sshProfileId}"` });
      }

      // Honest failure #1: `ssh` itself isn't installed. Checked BEFORE
      // spawning (same "pre-check availability, 409 with an install hint"
      // shape the local-agent path already uses below) rather than letting
      // node-pty's spawn fail with a raw ENOENT the pane would have no
      // clean way to explain.
      if (!(await commandExists("ssh"))) {
        return reply.status(409).send({
          error: `The "ssh" command isn't installed on this machine. Install an SSH client, then try again.`,
          installHint:
            "Install an OpenSSH client — e.g. 'xcode-select --install' on macOS, or your distro's openssh-client package on Linux.",
        });
      }

      // Honest failure #2 and #3 (host unreachable, auth rejected) are NOT
      // checked here — they can only be discovered by actually connecting,
      // which is exactly what the spawned `ssh` process does next. Its own
      // stderr (connection refused, "Permission denied (publickey)", etc)
      // streams straight into the pane's pty output like any other command
      // would — see session-manager.ts, which never swallows pty output —
      // so the failure is visible in the terminal itself, plus the pane's
      // "exited" status/exit code once ssh gives up (Terminal.tsx already
      // renders "(exited N)" in the header for any session that exits).
      const info = sessionManager.create({
        agent: "shell",
        cwd,
        cols,
        rows,
        ssh: {
          profileId: profile.id,
          profileName: profile.name,
          host: profile.host,
          user: profile.user,
          port: profile.port,
          defaultDirectory: profile.defaultDirectory,
          startupCommand: profile.startupCommand,
        },
      });
      // Session recovery: recorded immediately, with no `await` in
      // between — see SessionRecordsStore.create's own doc comment for why
      // that ordering (SPAWN time, not first output) matters.
      const record = sessionRecordsStore.create({
        workspaceId: workspaceIdForRecord,
        paneId,
        sessionId: info.id,
        agent: info.agent,
        sshProfileId: info.sshProfileId ?? null,
        agentSessionRef: null,
        cwd: info.cwd,
        title: info.title,
      });
      trackSessionForRecovery(sessionManager, sessionRecordsStore, info.id, record.id, false);
      return reply.status(201).send(info);
    }

    if (!isAgentId(body.agent)) {
      return reply.status(400).send({
        error: `"agent" must be one of: ${AGENT_IDS.join(", ")}, or send "sshProfileId" instead for a remote pane`,
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

    // Session recovery: decides whether this agent gets a stable
    // per-CLI session ref captured up front (today: only `claude`'s
    // `--session-id <uuid>`) — see pty/resume.ts's research notes.
    const spawnExtras = spawnExtrasFor(body.agent);
    const info = sessionManager.create({
      agent: body.agent,
      cwd,
      cols,
      rows,
      extraArgs: spawnExtras.args,
    });
    const record = sessionRecordsStore.create({
      workspaceId: workspaceIdForRecord,
      paneId,
      sessionId: info.id,
      agent: info.agent,
      sshProfileId: null,
      agentSessionRef: spawnExtras.agentSessionRef,
      cwd: info.cwd,
      title: info.title,
    });
    trackSessionForRecovery(sessionManager, sessionRecordsStore, info.id, record.id, false);
    return reply.status(201).send(info);
  });

  app.delete("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionManager.get(id)) {
      return reply.status(404).send({ error: `No session with id "${id}"` });
    }
    sessionManager.kill(id);
    // Session recovery: an explicit close is a deliberate end, not a
    // crash/restart — mark the associated record 'discarded' rather than
    // leaving it stranded at 'running' forever (see
    // SessionRecordsStore.findByLiveSessionId's own doc comment for why
    // the ordinary exit-tracking listener never catches this case).
    const record = sessionRecordsStore.findByLiveSessionId(id);
    if (record) sessionRecordsStore.markDiscarded(record.id);
    return reply.status(204).send();
  });

  // --- Session recovery (BridgeSpace v3.2.2 + v3.4.13 parity) -------------
  // See db/session-records.ts, pty/resume.ts, and pty/restore.ts's top
  // comments for the full design. `GET /api/session-records` is the raw
  // feed a History screen renders from; the two POST routes below are its
  // two actions (Resume / Discard); the workspace route is what a
  // newly-activated workspace calls to auto-restore up to
  // EAGER_RESTORE_BUDGET panes and learn which ones it should render as
  // "deferred" instead.

  app.get("/api/session-records", async (request) => {
    const { workspaceId } = request.query as { workspaceId?: string };
    return { records: sessionRecordsStore.list(workspaceId) };
  });

  app.post("/api/session-records/:id/discard", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = sessionRecordsStore.get(id);
    if (!record) {
      return reply.status(404).send({ error: `No session record with id "${id}"` });
    }
    if (record.status !== "recoverable") {
      return reply
        .status(409)
        .send({ error: `Session record is not recoverable (status: "${record.status}")` });
    }
    return sessionRecordsStore.markDiscarded(id)!;
  });

  app.post("/api/session-records/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = sessionRecordsStore.get(id);
    if (!record) {
      return reply.status(404).send({ error: `No session record with id "${id}"` });
    }
    if (record.status !== "recoverable") {
      return reply
        .status(409)
        .send({ error: `Session record is not recoverable (status: "${record.status}")` });
    }

    const body = (request.body ?? {}) as { cols?: unknown; rows?: unknown };
    const cols = typeof body.cols === "number" ? body.cols : 80;
    const rows = typeof body.rows === "number" ? body.rows : 24;

    const result = await attemptResume(sessionManager, sessionRecordsStore, sshProfileStore, record, cols, rows);
    if (!result.ok) {
      // Failure never mutated the store — the record is still exactly
      // 'recoverable' (see attemptResume's own doc comment). Nothing to
      // revert; there is simply nothing new to report except why.
      return reply.status(409).send({ error: result.error, installHint: result.installHint ?? null });
    }
    return { session: result.session, record: result.record, note: result.note };
  });

  app.post("/api/workspaces/:id/restore-sessions", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!workspaceStore.get(id)) {
      return reply.status(404).send({ error: `No workspace with id "${id}"` });
    }
    const body = (request.body ?? {}) as { cols?: unknown; rows?: unknown };
    const cols = typeof body.cols === "number" ? body.cols : 80;
    const rows = typeof body.rows === "number" ? body.rows : 24;

    return restoreWorkspaceSessions(
      sessionManager,
      sessionRecordsStore,
      sshProfileStore,
      id,
      EAGER_RESTORE_BUDGET,
      cols,
      rows
    );
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
    sshProfileStore: SshProfileStore;
    sessionRecordsStore: SessionRecordsStore;
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
