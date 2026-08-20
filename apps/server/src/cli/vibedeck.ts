/**
 * The `vibedeck [path]` CLI — BridgeSpace's `bridgespace .` equivalent
 * (see docs/PARITY.md). Run it from any project directory and that
 * directory opens as a vibedeck workspace, starting the server first if one
 * isn't already up. This file holds the pure, injectable-dependency core
 * (`runVibedeckCli`) so `vibedeck.test.ts` can exercise every branch —
 * "path doesn't exist", "server already running", "server needs starting
 * and never comes up", "workspace already registered", "workspace needs
 * creating" — with fake deps and no real network call, no real child
 * process, no real browser launch. `bin.ts` is the thin runnable entry that
 * wires real deps (fetch, child_process.spawn, a platform "open URL"
 * command) onto this — same split `memory/mcp.ts` (testable handlers) vs
 * `memory/mcp-server.ts` (thin stdio entry) already uses in this codebase.
 *
 * --- What "opens it" means here, and why ---
 * A vibedeck workspace only exists inside a running server (workspaces are
 * rows in `~/.vibedeck/vibedeck.db`, resolved through the server's REST API
 * — see `../db/workspaces.ts` and `../workspace-path.ts`). There is no
 * direct-to-desktop-app deep link today: `apps/desktop/src-tauri/src/main.rs`
 * takes no CLI arguments and registers no custom URL scheme — its `main()`
 * only ever spawns its own sidecar server on a fixed port
 * (`DESKTOP_SIDECAR_PORT`, see `../runtime-config.ts`) and points its own
 * webview at that sidecar's root. Handing it a workspace id from here would
 * have nothing to land on. So "open the desktop app" isn't a real option to
 * build today without ALSO adding deep-link support to the Tauri side,
 * which is out of scope for this CLI.
 *
 * What this CLI does instead, in order:
 *   1. Check whether a server is ALREADY running — on the normal dev/prod
 *      port (`resolveServerPort`'s result, `deps.candidatePorts[0]`) or on
 *      the desktop app's sidecar port (`deps.candidatePorts[1]`, if the
 *      user already has the desktop app open). Reusing whichever is found
 *      avoids spawning a redundant second Fastify process — see
 *      `runtime-config.ts`'s `DESKTOP_SIDECAR_PORT` doc comment for why
 *      that's safe (same shared SQLite database either way).
 *   2. If neither is up, start one — `deps.startServer` spawns the same
 *      `node dist/index.js` a plain deployment would run, detached, so it
 *      keeps running after this CLI process exits (see bin.ts).
 *   3. Ensure a workspace is registered for the resolved path, reusing an
 *      existing one by exact `rootPath` match rather than creating a
 *      duplicate every time `vibedeck .` is run in the same directory.
 *   4. Open the system's default browser at that server's origin, with a
 *      `?workspace=<id>` query param the web app (`apps/web/src/App.tsx`)
 *      reads on load to auto-select that workspace instead of whichever one
 *      happens to be first — see that file's `tryInitRoot` for the read
 *      side of this contract.
 */
import { basename } from "node:path";
import type { ResolveRootPathResult } from "../workspace-path.js";

/** How long `runVibedeckCli` waits for a freshly-started server to answer
 * `/api/health` before giving up and reporting a failure. 15s is generous
 * for `node dist/index.js` (no compilation, just process startup +
 * `better-sqlite3`'s native binding load + Fastify's `.listen()`) while
 * still bounded — this CLI should never hang forever. */
export const CLI_SERVER_START_TIMEOUT_MS = 15_000;

export interface EnsureWorkspaceResult {
  id: string;
  name: string;
  /** True if an existing workspace's `rootPath` already matched (reused,
   * not created) — purely for the log line `runVibedeckCli` prints; callers
   * that don't care can ignore it. */
  reused: boolean;
}

export type EnsureWorkspaceOutcome = EnsureWorkspaceResult | { error: string };

/**
 * Every side effect `runVibedeckCli` needs, as injectable functions — the
 * same "pure core, inject the I/O" shape `resolveStaticDir` uses in
 * `runtime-config.ts`. `bin.ts` supplies real implementations;
 * `vibedeck.test.ts` supplies fakes.
 */
export interface VibedeckCliDeps {
  /** Resolves and validates the user-supplied path. Real impl is
   * `resolveRootPath` from `../workspace-path.ts` — reused rather than
   * reimplemented so the CLI accepts/rejects paths by EXACTLY the same
   * rule `POST /api/workspaces` does server-side (tilde expansion,
   * existence, "must be a directory"), and so the resolved string matches
   * character-for-character what a workspace created through the app would
   * have stored, which is what makes the `rootPath` equality check in
   * `ensureWorkspace` below actually work. */
  resolvePath: (input: string) => ResolveRootPathResult;
  /** Ports to check, in priority order, for an already-running server. */
  candidatePorts: number[];
  /** Port to start a new server on if none of `candidatePorts` answered. */
  defaultPort: number;
  isServerUp: (port: number) => Promise<boolean>;
  /** Spawns a new server process, detached, and returns immediately — does
   * NOT wait for it to be ready (that's `waitForServerUp`'s job). May throw
   * (e.g. the built `dist/index.js` doesn't exist yet). */
  startServer: (port: number) => void;
  /** Polls `isServerUp` until it returns true or `timeoutMs` elapses. */
  waitForServerUp: (port: number, timeoutMs: number) => Promise<boolean>;
  /** Finds-or-creates a workspace for `rootPath` against the server on
   * `port`, over its REST API — never touches SQLite directly, so this
   * works identically whether the server was already running or was just
   * started by this same invocation. */
  ensureWorkspace: (port: number, rootPath: string) => Promise<EnsureWorkspaceOutcome>;
  openUrl: (url: string) => Promise<void>;
  log: (message: string) => void;
  logError: (message: string) => void;
}

/**
 * Runs the whole `vibedeck [path]` flow and returns a process exit code (0
 * success, 1 failure) — `bin.ts` is the only caller that actually calls
 * `process.exit` with this; tests just assert on the returned number plus
 * what got logged.
 */
export async function runVibedeckCli(argv: string[], deps: VibedeckCliDeps): Promise<number> {
  const inputPath = argv[0] ?? ".";
  const resolved = deps.resolvePath(inputPath);
  if (!resolved.ok) {
    deps.logError(`vibedeck: ${resolved.error}`);
    return 1;
  }
  const rootPath = resolved.path;

  let port: number | null = null;
  for (const candidate of deps.candidatePorts) {
    if (await deps.isServerUp(candidate)) {
      port = candidate;
      break;
    }
  }

  if (port === null) {
    port = deps.defaultPort;
    deps.log(
      `No vibedeck server found on port ${deps.candidatePorts.join(" or ")} — starting one on ${port}...`
    );
    try {
      deps.startServer(port);
    } catch (err) {
      deps.logError(
        `vibedeck: could not start the server — ${err instanceof Error ? err.message : String(err)}`
      );
      return 1;
    }
    const up = await deps.waitForServerUp(port, CLI_SERVER_START_TIMEOUT_MS);
    if (!up) {
      deps.logError(
        `vibedeck: server did not come up on port ${port} within ${
          CLI_SERVER_START_TIMEOUT_MS / 1000
        }s. Check whether another process is already using that port, or run ` +
          `"pnpm --filter @vibedeck/server start" yourself in another terminal to see the actual error.`
      );
      return 1;
    }
  }

  const workspace = await deps.ensureWorkspace(port, rootPath);
  if ("error" in workspace) {
    deps.logError(`vibedeck: ${workspace.error}`);
    return 1;
  }

  deps.log(
    workspace.reused
      ? `Reusing workspace "${workspace.name}" for ${rootPath}`
      : `Created workspace "${workspace.name}" for ${rootPath}`
  );

  const url = `http://localhost:${port}/?workspace=${workspace.id}`;
  deps.log(`Opening ${url}`);
  await deps.openUrl(url);
  return 0;
}

/** Shape of `GET /api/workspaces`'s response — just the fields
 * `ensureWorkspace` actually reads, not the full `Workspace` type, so this
 * module doesn't need to import `@vibedeck/shared` for one helper. */
interface WorkspaceListItem {
  id: string;
  name: string;
  rootPath: string;
}

/**
 * The real `ensureWorkspace` implementation: `GET /api/workspaces`, look
 * for an exact `rootPath` match, `POST /api/workspaces` if none exists.
 * Exported (not just used inline in `bin.ts`) so `vibedeck.test.ts` can
 * exercise it directly against a real, in-process `buildApp()` server
 * (listening on an ephemeral port) rather than faking `fetch` itself —
 * proving the query actually round-trips against the real API shape, not
 * just against a hand-written mock of it.
 */
export async function ensureWorkspace(port: number, rootPath: string): Promise<EnsureWorkspaceOutcome> {
  const base = `http://localhost:${port}`;

  let listRes: Response;
  try {
    listRes = await fetch(`${base}/api/workspaces`);
  } catch (err) {
    return { error: `Could not reach the server at ${base}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!listRes.ok) {
    return { error: `Could not list workspaces (HTTP ${listRes.status})` };
  }
  const listBody = (await listRes.json()) as { workspaces: WorkspaceListItem[] };
  const existing = listBody.workspaces.find((w) => w.rootPath === rootPath);
  if (existing) {
    return { id: existing.id, name: existing.name, reused: true };
  }

  // `basename` of the resolved path as the default name — the same
  // "derive a sensible name from the path" a human would type into the
  // app's "Add Workspace" dialog. Falls back to the path itself for the
  // pathological root-directory case (`basename("/") === ""`).
  const name = basename(rootPath) || rootPath;
  let createRes: Response;
  try {
    createRes = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, rootPath }),
    });
  } catch (err) {
    return { error: `Could not reach the server at ${base}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!createRes.ok) {
    const errBody = (await createRes.json().catch(() => ({}))) as { error?: string };
    return { error: errBody.error ?? `Could not create workspace (HTTP ${createRes.status})` };
  }
  const created = (await createRes.json()) as { id: string; name: string };
  return { id: created.id, name: created.name, reused: false };
}
