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

/**
 * Which column a card is in. `cancelled` (Phase 9.5b, PARITY #27a) matches
 * BridgeMCP's published task lifecycle — `todo -> in-progress -> in-review
 * -> complete`, plus `cancelled` as a fifth, terminal state.
 *
 * It's modelled as a full column, not a separate boolean/flag on the card,
 * even though conceptually it's "a task that got abandoned" rather than a
 * step in the main flow. Making it a real `ColumnId` means every existing
 * column-based code path (validation against `COLUMN_IDS`, `BoardStore`'s
 * per-column position sequencing, the REST routes, the MCP tools added in
 * this same phase) handles it automatically, with no "and also check the
 * cancelled flag" special case anywhere. The cost is that it renders as a
 * fifth column in the (unmodified-by-this-phase) web board UI rather than,
 * say, a strikethrough on a card in its original column — an acceptable
 * trade for not forking every column-shaped code path in two.
 *
 * No migration was needed to store this: `board_cards.column_id` is a free
 * TEXT column with no CHECK constraint (verified against `migrations.ts`'s
 * `up001FullSchema`), so a new string value is just... a new string value.
 */
export type ColumnId = "todo" | "in_progress" | "in_review" | "complete" | "cancelled";

/**
 * Every status colour a `Pill`/`StatusDot` can be tinted with (see
 * `apps/web/src/shell/ui.tsx`'s `StatusKind`, which this mirrors exactly —
 * duplicated rather than imported because `packages/shared` must stay
 * Node/React-free, wire-shapes-only). Widened from `"idle" | "warn" |
 * "info" | "ok"` (Phase 7's original four columns) to also include
 * `"danger"` so `cancelled` below gets a colour that actually reads as
 * "stopped", not a warm/cool tint borrowed from another column's meaning.
 * `apps/web/src/board/Column.tsx`'s `meaning` prop is already typed as the
 * full `StatusKind` (not the narrower union this used to be), so this
 * widening is a pure addition from that file's point of view — nothing
 * there needed to change to keep compiling or rendering correctly.
 */
export type ColumnMeaning = "idle" | "warn" | "info" | "ok" | "danger";

/**
 * Every board column, in display order, with the semantic status colour
 * (docs/DESIGN.md §2) its header is tinted with. Both the server (for
 * validating a `columnId` in a request body) and the client (for rendering
 * the columns in order) import this single array so they can never disagree
 * about what columns exist or what order they render in.
 */
export const COLUMNS: readonly { id: ColumnId; label: string; meaning: ColumnMeaning }[] = [
  { id: "todo", label: "To do", meaning: "idle" },
  { id: "in_progress", label: "In progress", meaning: "warn" },
  { id: "in_review", label: "In review", meaning: "info" },
  { id: "complete", label: "Complete", meaning: "ok" },
  { id: "cancelled", label: "Cancelled", meaning: "danger" },
];

/** Runtime array of every `ColumnId`, derived from `COLUMNS` so the two can
 * never drift apart. */
export const COLUMN_IDS: readonly ColumnId[] = COLUMNS.map((c) => c.id);

/**
 * Server-enforced length caps for `BoardCard.description` and
 * `.taskKnowledge` (Phase 9.5b, PARITY #27b). Exported from `packages/shared`
 * — not just declared inline in the server's route validation — specifically
 * so a client (a future settings/board UI) can enforce the same limit in a
 * textarea's `maxLength` and show an honest character counter, instead of
 * letting a user type 40,000 characters only to have the server reject it.
 * The two are different sizes on purpose, mirroring BridgeMCP: `description`
 * (their `instructions`) is "what to do", short by design; `taskKnowledge` is
 * "what you need to know" — architecture notes, file paths, API specs — and
 * is allowed to be far longer.
 */
export const CARD_DESCRIPTION_MAX_LENGTH = 5000;
export const CARD_TASK_KNOWLEDGE_MAX_LENGTH = 50000;

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
  /**
   * Long-form context SEPARATE from `description` (Phase 9.5b, PARITY
   * #27b): architecture decisions, file paths, API specs, links — the
   * "what you need to know" a dispatched agent should read alongside "what
   * to do". Capped at `CARD_TASK_KNOWLEDGE_MAX_LENGTH`, ten times
   * `description`'s cap, by design — see that constant's comment. Included
   * in the dispatch prompt for AGENT panes only (see
   * `apps/server/src/board/dispatch.ts`); a plain `shell` pane never
   * receives it, same as it never receives `description`'s English either.
   */
  taskKnowledge: string | null;
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

/**
 * Phase 9a (swarm core) types. A `Mission` is a prompt split across several
 * dispatched agent sessions (`MissionAgent`s), coordinating over a shared
 * mailbox (`MissionMessage`) and a file-ownership ledger (`FileClaim`). See
 * `apps/server/src/swarm/*.ts` for the stores that own these, and
 * `docs/SWARM.md` for the REST surface. Every field here is Node-free, same
 * "wire shapes only" rule as the rest of this file.
 */

/** Which of the four swarm roles a `MissionAgent` plays. A coordinator
 * splits work and synthesises results; a builder writes code (and MUST hold
 * a `FileClaim` before editing a path — see `apps/server/src/swarm/claims.ts`);
 * a scout explores/reads but never edits; a reviewer reviews but never
 * edits. */
export type MissionRole = "coordinator" | "builder" | "scout" | "reviewer";

/** Runtime array of every `MissionRole`, for validating request bodies —
 * same "type + runtime array kept in sync by hand" pattern as `AGENT_IDS`. */
export const MISSION_ROLES: readonly MissionRole[] = ["coordinator", "builder", "scout", "reviewer"];

export type MissionStatus = "running" | "paused" | "complete" | "stopped";

/** Runtime array of every `MissionStatus`, for validating `PATCH
 * /api/swarm/missions/:id` request bodies — same "type + runtime array
 * kept in sync by hand" pattern as `CARD_PRIORITIES`/`COLUMN_IDS`. */
export const MISSION_STATUSES: readonly MissionStatus[] = ["running", "paused", "complete", "stopped"];

export interface Mission {
  id: string;
  workspaceId: string;
  prompt: string;
  status: MissionStatus;
  createdAt: string;
  updatedAt: string;
}

export type MissionAgentStatus = "idle" | "working" | "blocked" | "done" | "failed";

/** One dispatched agent within a mission — a pty session running with a
 * role-specific preamble typed in (see `apps/server/src/swarm/roles.ts`). */
export interface MissionAgent {
  id: string;
  missionId: string;
  role: MissionRole;
  /** Human-facing label, e.g. "Builder 2". */
  label: string;
  agent: AgentId;
  /** Set once a pty session has actually been spawned for this agent. */
  sessionId: string | null;
  status: MissionAgentStatus;
  createdAt: string;
  updatedAt: string;
}

/** One mailbox message. `fromAgentId`/`toAgentId` null mean "from the
 * human"/"broadcast to every agent", the same NULL-means-unaddressed
 * convention as `mission_messages`'s schema. */
export interface MissionMessage {
  id: string;
  missionId: string;
  fromAgentId: string | null;
  toAgentId: string | null;
  body: string;
  createdAt: string;
}

/**
 * A file-ownership claim: `agentId` holds `path` (workspace-relative,
 * POSIX-separated, normalised — see `swarm/claims.ts`'s `normalizeClaimPath`)
 * within `missionId`. `lastHeartbeatAt` is what staleness is judged
 * against, not `claimedAt` — see schema.ts's comment on the `file_claims`
 * table for why the two are separate columns.
 */
export interface FileClaim {
  id: string;
  missionId: string;
  path: string;
  agentId: string;
  claimedAt: string;
  lastHeartbeatAt: string;
}

/**
 * A DETECTED (not prevented) collision: `path` changed on disk while
 * `holderAgentId` held the claim on it but — implicitly, since a conflict is
 * only ever recorded for a change some OTHER agent made — the write did not
 * come from that holder. This registry can only stop *cooperating* agents;
 * this row is the evidence when one didn't cooperate. See
 * `apps/server/src/swarm/watch.ts`'s top comment.
 */
export interface ClaimConflict {
  id: string;
  missionId: string;
  path: string;
  holderAgentId: string;
  detectedAt: string;
}

/** `GET /api/swarm/missions/:id` response — a mission plus everything
 * hanging off it, so the (future, Phase 9b) mission canvas can render the
 * whole tree from one request. */
export interface MissionDetail {
  mission: Mission;
  agents: MissionAgent[];
  messages: MissionMessage[];
  claims: FileClaim[];
  conflicts: ClaimConflict[];
  tasks: MissionTask[];
}

/** `POST /api/swarm/missions/:id/gates` response. Output is captured
 * combined stdout+stderr, capped at 64KB — see `apps/server/src/swarm/gates.ts`. */
export interface GateResult {
  passed: boolean;
  exitCode: number | null;
  output: string;
}

/**
 * A mission_task: a unit of work with DECLARED paths (what it expects to
 * touch, known up front) — the input to `swarm/schedule.ts`'s
 * `planSchedule`, which groups non-overlapping tasks into waves that can
 * run concurrently. This is a SEQUENCING layer, complementary to (not a
 * replacement for) `FileClaim`: sequencing prevents planned collisions
 * before any agent even starts; claims catch unplanned collisions at
 * claim-time; `ClaimConflict` detects what neither stopped. See
 * docs/SWARM.md for the full three-layer story — none of the three make
 * agents "never collide"; each catches what the one before it couldn't.
 */
export type MissionTaskStatus = "pending" | "running" | "in_review" | "complete" | "blocked";

/** Runtime array of every `MissionTaskStatus` — same "type + runtime
 * array" pattern as `MISSION_STATUSES`. */
export const MISSION_TASK_STATUSES: readonly MissionTaskStatus[] = [
  "pending",
  "running",
  "in_review",
  "complete",
  "blocked",
];

export interface MissionTask {
  id: string;
  missionId: string;
  title: string;
  prompt: string;
  /** Workspace-relative paths this task expects to touch. Used ONLY for
   * scheduling (grouping non-overlapping tasks into the same wave) — it is
   * not itself a claim and does not reserve anything; the assigned agent
   * still has to call the claims API for real ownership. */
  declaredPaths: string[];
  status: MissionTaskStatus;
  assignedAgentId: string | null;
  /** null until a reviewer has weighed in; then true (approved, task moved
   * to 'complete') or false (rejected, task moved back to 'blocked'). The
   * ONLY way this task's status becomes 'complete' is through this field
   * being set true via the review endpoint — see `swarm/tasks.ts`. */
  reviewApproved: boolean | null;
  reviewNotes: string | null;
  reviewedByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/swarm/missions/:id/tasks/schedule` response — the mission's
 * current tasks grouped into waves (`waves[0]` = wave 1, the first batch
 * safe to run concurrently), each wave an array of task ids. */
export interface TaskScheduleResponse {
  waves: string[][];
}

/**
 * Phase 9.5b types: agent records and a saved-prompts library, per
 * BridgeMCP (docs/RESEARCH.md §2, PARITY #26/#27). See
 * `apps/server/src/agents/store.ts` and `apps/server/src/prompts/store.ts`
 * for the SQLite-backed stores, `apps/server/src/agents/routes.ts` /
 * `apps/server/src/prompts/routes.ts` for the REST surface, and
 * `apps/server/src/agents/mcp.ts` / `apps/server/src/prompts/mcp.ts` for the
 * MCP tools that expose the same data to a connected agent CLI.
 */

/** Server-enforced cap on `AgentProfile.systemPrompt` — per BridgeMCP's
 * documented 100,000-character limit (docs/RESEARCH.md §2). Exported here,
 * same reasoning as `CARD_TASK_KNOWLEDGE_MAX_LENGTH` above, so client and
 * server can never drift on what "too long" means. */
export const AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH = 100_000;

/**
 * A stored agent "persona": a name plus a system prompt, scoped to one
 * workspace, that gets typed into `baseAgent`'s pty ahead of a dispatched
 * task — the same idea as `apps/server/src/swarm/roles.ts`'s role
 * preambles, but user-authored and reusable rather than hard-coded per
 * swarm role. `name` is unique within a workspace (enforced by a UNIQUE
 * constraint on `(workspace_id, name)` — see `db/migrations.ts`'s migration
 * 4 and `swarm/claims.ts`'s top comment for why a constraint, not a
 * check-then-insert, is what actually arbitrates the race).
 */
export interface AgentProfile {
  id: string;
  workspaceId: string;
  name: string;
  systemPrompt: string;
  /** Which underlying CLI this profile runs as when dispatched. */
  baseAgent: AgentId;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/agents` (Phase 9.5b's agent-records endpoint — distinct from
 * the existing top-level `GET /api/agents` agent-*availability* check in
 * `index.ts`; this one is registered under `/api/agents` too and returns
 * the STORED profiles for a workspace, not CLI-installation status). See
 * `apps/server/src/agents/routes.ts`'s top comment for how the two
 * "/api/agents"-shaped things coexist without colliding. */
export interface AgentProfilesResponse {
  agents: AgentProfile[];
}

/**
 * A saved, reusable prompt (PARITY #27, "Prompts library"). `workspaceId`
 * is deliberately NULLABLE: a `null` workspaceId means the prompt is
 * GLOBAL — available in every workspace, not just one — which is the
 * deliberate way to save a prompt you reuse across projects (e.g. "write
 * tests for the function above") without re-creating it per workspace. A
 * non-null `workspaceId` scopes the prompt to just that one.
 */
export interface SavedPrompt {
  id: string;
  workspaceId: string | null;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/prompts` response — see `apps/server/src/prompts/routes.ts`
 * for the "global + this workspace's" merge rule. */
export interface SavedPromptsResponse {
  prompts: SavedPrompt[];
}
