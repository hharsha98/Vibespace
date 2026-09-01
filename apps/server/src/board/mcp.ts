/**
 * MCP tool handlers for driving the board without HTTP (Phase 9.5b, PARITY
 * #27c) — the same `BoardStore` the REST routes (`./routes.ts`) use, so
 * there's one source of truth for "what a task is" across HTTP and MCP,
 * same principle `memory/mcp.ts` established for notes.
 *
 * Every handler here takes an already-resolved `workspaceId`, never a raw
 * `root` path — resolving root -> workspaceId is
 * `../mcp/workspace-resolver.ts`'s job, called once per tool invocation by
 * `../mcp/build-server.ts`. That keeps this file (and its tests) focused on
 * "given a workspace id, what does this tool do", testable the same way
 * `memory/mcp.test.ts` tests memory's handlers directly, without needing a
 * real on-disk workspace registered.
 *
 * Tool naming mirrors BridgeMCP where it makes sense (docs/RESEARCH.md
 * §2): `list_tasks`, `get_task`, `create_task`, `update_task` — "task", not
 * "card", because that's the vocabulary a dispatched agent already reads
 * in `docs/AGENT-API.md` and the dispatch preamble itself
 * (`board/dispatch.ts`'s `buildDispatchPrompt`).
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CARD_DESCRIPTION_MAX_LENGTH,
  CARD_PRIORITIES,
  CARD_TASK_KNOWLEDGE_MAX_LENGTH,
  COLUMN_IDS,
  type CardPriority,
  type ColumnId,
} from "@vibespace/shared";
import type { BoardStore, UpdateCardOptions } from "../db/board.js";
import { jsonResult, errorResult } from "../mcp/result.js";

function isCardPriority(value: unknown): value is CardPriority {
  return typeof value === "string" && (CARD_PRIORITIES as readonly string[]).includes(value);
}

function isColumnId(value: unknown): value is ColumnId {
  return typeof value === "string" && (COLUMN_IDS as readonly string[]).includes(value);
}

export async function handleListTasks(boardStore: BoardStore, workspaceId: string): Promise<CallToolResult> {
  return jsonResult({ tasks: boardStore.list(workspaceId) });
}

export async function handleGetTask(boardStore: BoardStore, taskId: string): Promise<CallToolResult> {
  const card = boardStore.get(taskId);
  if (!card) {
    return errorResult(`No task with id "${taskId}". Use list_tasks to find one.`);
  }
  return jsonResult(card);
}

export interface CreateTaskArgs {
  title?: string;
  description?: string;
  taskKnowledge?: string;
  priority?: string;
  columnId?: string;
}

export async function handleCreateTask(
  boardStore: BoardStore,
  workspaceId: string,
  args: CreateTaskArgs
): Promise<CallToolResult> {
  if (!args.title || args.title.trim().length === 0) {
    return errorResult('"title" must be a non-empty string.');
  }
  if (args.description !== undefined && args.description.length > CARD_DESCRIPTION_MAX_LENGTH) {
    return errorResult(`"description" must be at most ${CARD_DESCRIPTION_MAX_LENGTH} characters.`);
  }
  if (args.taskKnowledge !== undefined && args.taskKnowledge.length > CARD_TASK_KNOWLEDGE_MAX_LENGTH) {
    return errorResult(`"taskKnowledge" must be at most ${CARD_TASK_KNOWLEDGE_MAX_LENGTH} characters.`);
  }
  if (args.priority !== undefined && !isCardPriority(args.priority)) {
    return errorResult(`"priority" must be one of: ${CARD_PRIORITIES.join(", ")}.`);
  }
  if (args.columnId !== undefined && !isColumnId(args.columnId)) {
    return errorResult(`"columnId" must be one of: ${COLUMN_IDS.join(", ")}.`);
  }

  const card = boardStore.create({
    workspaceId,
    title: args.title.trim(),
    description: args.description ?? null,
    taskKnowledge: args.taskKnowledge ?? null,
    priority: args.priority as CardPriority | undefined,
    columnId: args.columnId as ColumnId | undefined,
  });
  return jsonResult(card);
}

export interface UpdateTaskArgs {
  title?: string;
  description?: string | null;
  taskKnowledge?: string | null;
  priority?: string;
  columnId?: string;
}

/** Covers moving a task through its lifecycle — including to `cancelled`
 * (Phase 9.5b, PARITY #27a) — via the same `columnId` field `update_task`
 * uses for everything else; there's no separate "cancel_task" tool because
 * cancelling is just another column transition (see `ColumnId`'s doc
 * comment in `packages/shared/src/protocol.ts` for why it's modelled as a
 * real column). */
export async function handleUpdateTask(
  boardStore: BoardStore,
  taskId: string,
  args: UpdateTaskArgs
): Promise<CallToolResult> {
  if (!boardStore.get(taskId)) {
    return errorResult(`No task with id "${taskId}". Use list_tasks to find one.`);
  }
  if (args.title !== undefined && args.title.trim().length === 0) {
    return errorResult('"title" must be a non-empty string.');
  }
  if (typeof args.description === "string" && args.description.length > CARD_DESCRIPTION_MAX_LENGTH) {
    return errorResult(`"description" must be at most ${CARD_DESCRIPTION_MAX_LENGTH} characters.`);
  }
  if (typeof args.taskKnowledge === "string" && args.taskKnowledge.length > CARD_TASK_KNOWLEDGE_MAX_LENGTH) {
    return errorResult(`"taskKnowledge" must be at most ${CARD_TASK_KNOWLEDGE_MAX_LENGTH} characters.`);
  }
  if (args.priority !== undefined && !isCardPriority(args.priority)) {
    return errorResult(`"priority" must be one of: ${CARD_PRIORITIES.join(", ")}.`);
  }
  if (args.columnId !== undefined && !isColumnId(args.columnId)) {
    return errorResult(`"columnId" must be one of: ${COLUMN_IDS.join(", ")}.`);
  }

  const patch: UpdateCardOptions = {};
  if (args.title !== undefined) patch.title = args.title.trim();
  if ("description" in args) patch.description = args.description ?? null;
  if ("taskKnowledge" in args) patch.taskKnowledge = args.taskKnowledge ?? null;
  if (args.priority !== undefined) patch.priority = args.priority as CardPriority;
  if (args.columnId !== undefined) patch.columnId = args.columnId as ColumnId;

  const updated = boardStore.update(taskId, patch);
  return jsonResult(updated);
}
