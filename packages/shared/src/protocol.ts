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

/**
 * Phase 7 (the board) types. A `BoardCard` is a task that lives in one of
 * four columns and can be dispatched to a coding agent — see
 * `apps/server/src/db/board.ts` for the store and `docs/AGENT-API.md` for
 * how a dispatched agent updates its own card over HTTP.
 */

/** How urgent a card is. Drives the priority `Pill`'s colour (docs/DESIGN.md
 * §5): critical -> `--danger`, high -> `--warn`, medium -> `--info`,
 * low -> `--idle`. */
export type CardPriority = "critical" | "high" | "medium" | "low";

/** Runtime array of every `CardPriority`, for validating request bodies and
 * populating a picker — same "type + runtime array kept in sync by hand"
 * pattern as `AGENT_IDS` above. */
export const CARD_PRIORITIES: readonly CardPriority[] = ["critical", "high", "medium", "low"];

/** Which of the board's four columns a card is in. */
export type ColumnId = "todo" | "in_progress" | "in_review" | "complete";

/**
 * Every board column, in display order, with the semantic status colour
 * (docs/DESIGN.md §2) its header is tinted with. Both the server (for
 * validating a `columnId` in a request body) and the client (for rendering
 * the four columns in order) import this single array so they can never
 * disagree about what columns exist or what order they render in.
 */
export const COLUMNS: readonly { id: ColumnId; label: string; meaning: "idle" | "warn" | "info" | "ok" }[] = [
  { id: "todo", label: "To do", meaning: "idle" },
  { id: "in_progress", label: "In progress", meaning: "warn" },
  { id: "in_review", label: "In review", meaning: "info" },
  { id: "complete", label: "Complete", meaning: "ok" },
];

/** Runtime array of every `ColumnId`, derived from `COLUMNS` so the two can
 * never drift apart. */
export const COLUMN_IDS: readonly ColumnId[] = COLUMNS.map((c) => c.id);

/**
 * A task on the board, as seen over the REST API. `sessionId`/`agent` are
 * both null until the card has been dispatched to an agent (Phase 7 §5) —
 * once set, the board card shows a live `StatusDot` + agent name, and
 * clicking it switches to the Terminals view and focuses that pane.
 */
export interface BoardCard {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  priority: CardPriority;
  columnId: ColumnId;
  /** Fractional ordering position within its column — see board.ts's top
   * comment. Not meaningful across columns, only for sorting within one. */
  position: number;
  /** Set once this card has been dispatched to a running agent session. */
  sessionId: string | null;
  /** Which agent `sessionId` is running, e.g. "shell" or "claude". */
  agent: AgentId | null;
  /** ISO 8601 UTC timestamp string. */
  createdAt: string;
  /** ISO 8601 UTC timestamp string, updated on every create/update/move. */
  updatedAt: string;
}

/**
 * Phase 8 (shared agent memory) types. A `MemoryNote` is a markdown file on
 * disk at `<workspace>/.vibedeck/memory/<slug>.md` — see
 * `apps/server/src/memory/store.ts` for the store and `docs/MEMORY.md` for
 * the wikilink convention and MCP server that expose these same notes to
 * coding agents. Every field here is what's stored in the file's
 * frontmatter (or, for `body`, what comes after it) — there is no database
 * row behind this, unlike `Workspace`/`BoardCard` above.
 */
export interface MemoryNote {
  /** Derived from the title (lowercase, non-alphanumerics collapsed to
   * "-"), unique within a workspace, and immutable once created — links
   * (`[[slug]]`) and backlinks are keyed on this, not on `title`, so
   * renaming a note's title never breaks a link pointing at it. */
  slug: string;
  title: string;
  tags: string[];
  /** Markdown body, may contain `[[other-slug]]` wikilinks. */
  body: string;
  /** ISO 8601 UTC timestamp string. */
  createdAt: string;
  /** ISO 8601 UTC timestamp string, updated on every create/update. */
  updatedAt: string;
}

/** `GET /api/memory/notes/:slug` response — a note plus the slugs of every
 * OTHER note that links to it (computed from the whole workspace's link
 * graph at request time, not stored on the note itself). */
export interface MemoryNoteWithBacklinks extends MemoryNote {
  backlinks: string[];
}

/** `GET /api/memory/notes` response. */
export interface MemoryNotesResponse {
  notes: MemoryNote[];
}

/** One node in the memory graph (`GET /api/memory/graph`) — either a real
 * note, or a "dangling" target: a `[[slug]]` link that exists in some
 * note's body but has no note written for it yet. `dangling` is what lets
 * the Graph view (docs/DESIGN.md §5) render the two differently and offer
 * a "create this note" affordance for the latter. */
export interface MemoryGraphNode {
  slug: string;
  /** For a dangling node, this is just the slug — there's no note to read
   * a real title from. */
  title: string;
  dangling: boolean;
}

/** One edge in the memory graph: `source` note links to `target` (a slug).
 * `dangling` mirrors the target node's own `dangling` flag, duplicated here
 * so an edge-drawing loop doesn't need to cross-reference the node list. */
export interface MemoryGraphEdge {
  source: string;
  target: string;
  dangling: boolean;
}

/** `GET /api/memory/graph` response. */
export interface MemoryGraphResponse {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}
