/**
 * The WebSocket message protocol shared between the vibedeck server and web
 * client. Both sides import these types so their messages can never drift
 * apart — if one side changes the shape of a message, TypeScript will fail
 * to compile the other side until it's updated too.
 */

/** The set of coding agents vibedeck knows how to run in a terminal session. */
export type AgentId = "claude" | "cursor-agent" | "codex" | "shell";

/**
 * Runtime array of every `AgentId`, kept in sync with the type above by
 * hand. Useful anywhere we need to iterate over or validate agent ids at
 * runtime (types alone don't exist after compilation).
 */
export const AGENT_IDS: readonly AgentId[] = ["claude", "cursor-agent", "codex", "shell"];

/** A message sent from the browser client to the server. */
export type ClientMessage =
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number };

/** A message sent from the server to the browser client. */
export type ServerMessage =
  | { type: "output"; sessionId: string; data: string }
  | { type: "exit"; sessionId: string; code: number }
  // "ready" now carries everything the client needs to redraw a terminal it
  // is (re)attaching to: the replayed scrollback text and the size the pty
  // is currently running at. This is what makes "close the tab, reopen it,
  // see your session exactly as you left it" work.
  | { type: "ready"; sessionId: string; history: string; cols: number; rows: number };

/**
 * A session as seen over the REST API (`GET /api/sessions`, etc). This is
 * the "directory listing" shape — it does not include the pty's live
 * output, just enough to render a session list and know whether a process
 * is still running.
 */
export interface SessionInfo {
  id: string;
  agent: AgentId;
  cwd: string;
  title: string;
  status: "running" | "exited";
  /** null while running; set to the process's exit code once it exits. */
  exitCode: number | null;
  /** ISO 8601 UTC timestamp string, e.g. "2026-08-10T12:34:56.000Z". */
  createdAt: string;
}

/**
 * Static metadata about how to launch a given agent: what binary to run
 * and what arguments to pass it. This is the "menu" the UI shows when a
 * user picks which agent to start a session with.
 */
export interface AgentSpec {
  id: AgentId;
  displayName: string;
  command: string;
  args: string[];
}

/**
 * Metadata for every known agent, keyed by id.
 *
 * Important: `packages/shared` is imported by the browser bundle, so this
 * file must never read Node-only APIs like `process.env` at module scope
 * (or at all) — doing so would either crash the browser build or silently
 * bake in whatever value happened to be present when the bundle was built.
 *
 * The "shell" entry's `command` below is therefore just a static fallback
 * for display/metadata purposes (e.g. showing "Shell" in a dropdown). The
 * *real* shell binary is resolved server-side, at request time, from
 * `process.env.SHELL` — see `resolveAgent()` in
 * `apps/server/src/pty/agents.ts`. That function is the actual source of
 * truth for what command gets spawned; this object is not.
 */
export const AGENT_SPECS: Record<AgentId, AgentSpec> = {
  claude: { id: "claude", displayName: "Claude Code", command: "claude", args: [] },
  "cursor-agent": {
    id: "cursor-agent",
    displayName: "Cursor Agent",
    command: "cursor-agent",
    args: [],
  },
  codex: { id: "codex", displayName: "Codex", command: "codex", args: [] },
  shell: { id: "shell", displayName: "Shell", command: "/bin/zsh", args: ["-l"] },
};

/**
 * A workspace is "a name + a project directory + a saved layout" — Phase 3's
 * fix for every pane spawning in the *server's* working directory instead of
 * a project the user actually cares about. Switching workspaces swaps which
 * project directory new panes spawn in, and remembers the pane grid's shape
 * (via `layout`) so it survives a page refresh or server restart.
 *
 * Important: `layout` only ever preserves the *shape* of the grid (which
 * panes exist, how they're split), never live sessions — pty processes do
 * not survive a server restart, so a restored workspace's panes always come
 * back empty. See `apps/web/src/grid/tree.ts` for the GridNode shape that
 * gets JSON-serialised into this field.
 */
export interface Workspace {
  id: string;
  name: string;
  /** Absolute path on the server's filesystem; new sessions spawn here. */
  rootPath: string;
  /** JSON-serialised GridNode tree, or null if this workspace has never had a layout saved. */
  layout: string | null;
  /** ISO 8601 UTC timestamp string, e.g. "2026-08-10T12:34:56.000Z". */
  createdAt: string;
  /** ISO 8601 UTC timestamp string, updated on every create/update. */
  updatedAt: string;
}

/**
 * Phase 6 (file tree / editor / preview) types. Every one of these describes
 * a file *inside a workspace's rootPath*, referenced by a workspace-relative
 * path — never an absolute filesystem path. The server is the only side that
 * ever turns one of these relative paths into a real, absolute path (see
 * `apps/server/src/files/safe-path.ts`'s `safeResolve`), and it always
 * re-validates that translation against the workspace root, no matter how
 * trustworthy the caller seems — this file itself carries no Node APIs (it's
 * imported by the browser bundle), so it can't do that validation; it only
 * describes the wire shapes both sides agree on.
 */

/** One entry in a directory listing — `GET /api/files/tree`. */
export interface FileEntry {
  /** Just the entry's own name, e.g. "index.ts" (not a path). */
  name: string;
  /** Workspace-relative path, e.g. "src/index.ts". Uses forward slashes. */
  path: string;
  kind: "file" | "dir";
}

/** Response body for `GET /api/files/tree` — one directory level, sorted
 * directories-first then alphabetically (case-insensitive) within each. */
export interface FileTreeResponse {
  entries: FileEntry[];
}

/** Response body for `GET /api/files/content`. `truncated` is always false
 * today — the server refuses (413) anything over 2MB rather than silently
 * truncating it, but the field is reserved in case that policy ever
 * changes to "truncate and say so" instead of "refuse". */
export interface FileContentResponse {
  path: string;
  content: string;
  truncated: boolean;
}

/**
 * One live filesystem change, streamed over `GET /api/files/watch`
 * (WebSocket) while a workspace's file tree is open. `path` is always
 * workspace-relative, debounced ~100ms per path so a burst of writes to the
 * same file (e.g. a formatter running) collapses into a single event.
 */
export type FileWatchEvent =
  | { type: "add"; path: string }
  | { type: "change"; path: string }
  | { type: "unlink"; path: string };
