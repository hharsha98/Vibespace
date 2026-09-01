/**
 * Builds the FULL vibespace MCP server for one workspace root: memory tools
 * (unchanged, from `../memory/mcp.ts`) PLUS the board/agents/prompts tools
 * and the `vibespace_developer_guide` prompt added in Phase 9.5b (PARITY
 * #27c/#27d). One process, one workspace root — same shape
 * `memory/mcp-server.ts` has always had; this file is what makes that ONE
 * process also speak board/agents/prompts, per docs/RESEARCH.md §5's own
 * conclusion: "exposing the board over the same [memory] server is the
 * natural next step."
 *
 * --- ARCHITECTURE DECISION: how do board/agent/prompt tools reach the data? ---
 * `mcp-server.ts` is a SEPARATE OS process from the Fastify server — an MCP
 * client (Claude Code, cursor-agent, Codex) spawns it directly over stdio;
 * it does not go through `apps/server/src/index.ts` at all. The board,
 * agent profiles, and saved prompts all live in the ONE shared SQLite file
 * at `~/.vibespace/vibespace.db` (or `$VIBESPACE_DATA_DIR` in tests). Two ways
 * to reach that data existed:
 *
 *   (a) Open that SQLite file directly from this MCP process, via the same
 *       `openDatabase()`/`BoardStore`/`AgentProfileStore`/`SavedPromptStore`
 *       classes the Fastify server itself uses.
 *   (b) Have each MCP tool make an HTTP call to the running Fastify server
 *       (`http://localhost:<port>/api/...`), the way `board/dispatch.ts`'s
 *       dispatch preamble already tells a terminal-dispatched agent to do.
 *
 * THIS FILE PICKS (a). Reasoning:
 *   - `memory/mcp.ts` already reads/writes `<root>/.vibespace/memory/*.md`
 *     directly, with no dependency on the Fastify server being up at all —
 *     an agent can use memory tools even if the user hasn't opened vibespace
 *     today. Picking (b) for board/agents/prompts would make THIS process
 *     depend on the server being alive while memory tools in the SAME
 *     process don't — an inconsistent reliability story for one MCP server.
 *   - (b) would require this file to know the server's port (today a
 *     hardcoded constant in `index.ts`, not discoverable from a workspace
 *     root alone) and produce a clear, fail-fast error when the server
 *     isn't running — solvable, but strictly more moving parts than (a).
 *   - Opening the SAME SQLite file from two processes (the Fastify server,
 *     and however many MCP processes are connected) is what SQLite's WAL
 *     (write-ahead log) mode exists for. I checked rather than assumed:
 *     `../db/schema.ts`'s `openDatabase()` already runs
 *     `db.pragma("journal_mode = WAL")` on every open, unconditionally — so
 *     this file doesn't need to (and doesn't) set WAL mode itself; it's
 *     already the default for every database this codebase touches.
 *
 * The trade-off accepted: this file (and `../mcp/workspace-resolver.ts`)
 * has to resolve a filesystem root into a `workspace_id` by querying the
 * `workspaces` table itself, since MCP tools operate on a root path but the
 * board/agent/prompt tables key on workspace id. `workspace-resolver.ts`'s
 * top comment explains why that resolution happens fresh on every tool
 * call rather than once at startup. Memory tools are entirely unaffected
 * by any of this, by construction.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AGENT_IDS, CARD_PRIORITIES, COLUMN_IDS } from "@vibespace/shared";
import { createMemoryMcpServer } from "../memory/mcp.js";
import { openDatabase } from "../db/schema.js";
import { WorkspaceStore } from "../db/workspaces.js";
import { BoardStore } from "../db/board.js";
import { AgentProfileStore } from "../agents/store.js";
import { SavedPromptStore } from "../prompts/store.js";
import { handleListTasks, handleGetTask, handleCreateTask, handleUpdateTask } from "../board/mcp.js";
import {
  handleListAgents,
  handleGetAgent,
  handleCreateAgent,
  handleUpdateAgent,
  handleDeleteAgent,
} from "../agents/mcp.js";
import { handleListPrompts } from "../prompts/mcp.js";
import { handleListSkills, handleGetSkill } from "../skills/mcp.js";
import { resolveWorkspaceId } from "./workspace-resolver.js";
import { errorResult } from "./result.js";
import { DEVELOPER_GUIDE_PROMPT_NAME, developerGuideText } from "./developer-guide.js";

export interface VibespaceMcpServer {
  server: McpServer;
  /** Closes the shared SQLite handle this file opened. Memory tools have
   * no handle of their own to close (they're pure filesystem I/O), so this
   * is the only cleanup needed. */
  close(): void;
}

/**
 * Builds the composed server for `root` (an absolute workspace directory —
 * the same argument `memory/mcp-server.ts` has always taken). Synchronous,
 * same as `createMemoryMcpServer` itself: `openDatabase()` and every store
 * constructor here are synchronous (better-sqlite3 is a synchronous
 * binding), so there is no async work to await before the server is ready
 * to register tools against.
 */
export function buildVibespaceMcpServer(root: string): VibespaceMcpServer {
  // Memory tools first — this IS the server instance every other tool
  // below gets registered onto, per this file's top-comment decision to
  // keep everything on one MCP connection rather than spinning up a
  // second server/process.
  const server = createMemoryMcpServer(root);

  // One shared `Database` handle for every store in THIS process, rather
  // than four separate `openDatabase()` calls — no functional difference
  // (WAL mode makes concurrent handles to the same file safe regardless),
  // just one fewer file descriptor held open per MCP connection.
  const db = openDatabase();
  const workspaceStore = new WorkspaceStore(db);
  const boardStore = new BoardStore(db);
  const agentProfileStore = new AgentProfileStore(db);
  const savedPromptStore = new SavedPromptStore(db);

  /** Resolves `root` to a workspace id fresh on every call (see
   * `./workspace-resolver.ts`'s top comment for why), returning an
   * `errorResult` in the exact shape a tool callback can return directly
   * when resolution fails. */
  function withWorkspaceId(fn: (workspaceId: string) => Promise<ReturnType<typeof errorResult>>) {
    const resolved = resolveWorkspaceId(workspaceStore, root);
    if (!resolved.ok) return Promise.resolve(errorResult(resolved.error));
    return fn(resolved.workspaceId);
  }

  // --- Board tools (PARITY #27c) -------------------------------------------

  server.registerTool(
    "list_tasks",
    {
      title: "List board tasks",
      description: "List every task on this workspace's board (id, title, priority, columnId, agent, updatedAt).",
      inputSchema: {},
    },
    () => withWorkspaceId((workspaceId) => handleListTasks(boardStore, workspaceId))
  );

  server.registerTool(
    "get_task",
    {
      title: "Get a board task",
      description:
        "Read one task by id, including its full description and taskKnowledge (long-form context separate from the instructions).",
      inputSchema: { taskId: z.string().min(1).describe("The task's id, as returned by list_tasks.") },
    },
    ({ taskId }) => handleGetTask(boardStore, taskId)
  );

  server.registerTool(
    "create_task",
    {
      title: "Create a board task",
      description:
        "Create a new task on this workspace's board. description is short instructions (max 5000 chars); taskKnowledge is long-form reference context (max 50000 chars) — architecture decisions, file paths, API specs, links.",
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional().describe("What to do. Max 5000 characters."),
        taskKnowledge: z
          .string()
          .optional()
          .describe("What you need to know: architecture notes, file paths, API specs, links. Max 50000 characters."),
        priority: z.enum(CARD_PRIORITIES as unknown as [string, ...string[]]).optional(),
        columnId: z.enum(COLUMN_IDS as unknown as [string, ...string[]]).optional(),
      },
    },
    (args) => withWorkspaceId((workspaceId) => handleCreateTask(boardStore, workspaceId, args))
  );

  server.registerTool(
    "update_task",
    {
      title: "Update a board task",
      description:
        "Update a task's fields, including moving it through its lifecycle via columnId: todo -> in_progress -> in_review -> complete, or cancelled.",
      inputSchema: {
        taskId: z.string().min(1),
        title: z.string().optional(),
        description: z.string().nullable().optional(),
        taskKnowledge: z.string().nullable().optional(),
        priority: z.enum(CARD_PRIORITIES as unknown as [string, ...string[]]).optional(),
        columnId: z.enum(COLUMN_IDS as unknown as [string, ...string[]]).optional(),
      },
    },
    ({ taskId, ...args }) => handleUpdateTask(boardStore, taskId, args)
  );

  // --- Agent tools (PARITY #27c) --------------------------------------------

  server.registerTool(
    "list_agents",
    {
      title: "List agent profiles",
      description: "List every stored agent profile ({name, systemPrompt, baseAgent}) in this workspace.",
      inputSchema: {},
    },
    () => withWorkspaceId((workspaceId) => handleListAgents(agentProfileStore, workspaceId))
  );

  server.registerTool(
    "get_agent",
    {
      title: "Get an agent profile",
      description: "Read one agent profile by id, including its full systemPrompt.",
      inputSchema: { agentId: z.string().min(1).describe("The profile's id, as returned by list_agents.") },
    },
    ({ agentId }) => handleGetAgent(agentProfileStore, agentId)
  );

  server.registerTool(
    "create_agent",
    {
      title: "Create an agent profile",
      description:
        "Create a stored {name, systemPrompt} persona scoped to this workspace. systemPrompt is capped at 100000 characters; name must be unique within the workspace.",
      inputSchema: {
        name: z.string().min(1),
        systemPrompt: z.string().min(1),
        baseAgent: z.enum(AGENT_IDS as unknown as [string, ...string[]]).describe("Which CLI this profile runs as."),
      },
    },
    (args) => withWorkspaceId((workspaceId) => handleCreateAgent(agentProfileStore, workspaceId, args))
  );

  server.registerTool(
    "update_agent",
    {
      title: "Update an agent profile",
      description: "Update an agent profile's name, systemPrompt, and/or baseAgent.",
      inputSchema: {
        agentId: z.string().min(1),
        name: z.string().optional(),
        systemPrompt: z.string().optional(),
        baseAgent: z.enum(AGENT_IDS as unknown as [string, ...string[]]).optional(),
      },
    },
    ({ agentId, ...args }) => handleUpdateAgent(agentProfileStore, agentId, args)
  );

  server.registerTool(
    "delete_agent",
    {
      title: "Delete an agent profile",
      description: "Delete an agent profile by id.",
      inputSchema: { agentId: z.string().min(1) },
    },
    ({ agentId }) => handleDeleteAgent(agentProfileStore, agentId)
  );

  // --- Prompts tool (PARITY #27c) -------------------------------------------

  server.registerTool(
    "list_prompts",
    {
      title: "List saved prompts",
      description:
        "List saved, reusable prompts: every global prompt, plus this workspace's own if the workspace is registered.",
      inputSchema: {},
    },
    // Deliberately NOT `withWorkspaceId`: an unregistered workspace root
    // still has a perfectly good answer here (the global prompts), unlike
    // list_tasks/list_agents which have nothing meaningful to return
    // without a real workspace id. See SavedPromptStore.list's own
    // "workspaceId is optional" doc comment.
    () => {
      const resolved = resolveWorkspaceId(workspaceStore, root);
      return handleListPrompts(savedPromptStore, resolved.ok ? resolved.workspaceId : undefined);
    }
  );

  // --- Skills tools (Phase 10, PARITY #37) ----------------------------------
  // Same shape as memory tools, not board/agents/prompts: skills are
  // addressed by `root` alone (`discoverSkills`, ../skills/discover.ts),
  // no `workspace_id` lookup needed — see ../skills/mcp.ts's top comment.

  server.registerTool(
    "list_skills",
    {
      title: "List skills",
      description:
        "List every skill visible to this workspace (name, description, scope, source directory — not the full body), " +
        "per the open agentskills.io standard. A skill scoped \"project\" came from the repository itself, which may be " +
        "untrusted (see docs/SKILLS.md). Use get_skill to read one's full body.",
      inputSchema: {},
    },
    () => handleListSkills(root)
  );

  server.registerTool(
    "get_skill",
    {
      title: "Get a skill",
      description: "Read one skill by name, including its full body and metadata, as returned by list_skills.",
      inputSchema: { name: z.string().min(1).describe("The skill's name, as returned by list_skills.") },
    },
    ({ name }) => handleGetSkill(root, name)
  );

  // --- Onboarding prompt (PARITY #27d) --------------------------------------

  server.registerPrompt(
    DEVELOPER_GUIDE_PROMPT_NAME,
    {
      title: "vibespace developer guide",
      description:
        "Onboards a connected agent into vibespace's workflow: reading tasks, taskKnowledge vs description, the board lifecycle, memory, agent profiles, and swarm file-claim rules.",
    },
    () => ({
      messages: [{ role: "user", content: { type: "text", text: developerGuideText() } }],
    })
  );

  return {
    server,
    close: () => db.close(),
  };
}
