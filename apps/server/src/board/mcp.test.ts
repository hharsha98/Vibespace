/**
 * Tests the board MCP tool handlers directly (see this module's top
 * comment for why they're extracted as plain exported functions) against a
 * real temp-dir SQLite database — same `mkdtempSync` + `VIBEDECK_DATA_DIR`
 * pattern as `db/board.test.ts`. No stdio transport, no MCP client, no
 * protocol framing: this exercises exactly the logic a real MCP client's
 * `tools/call` would trigger, just called directly, same philosophy
 * `memory/mcp.test.ts` uses for the memory tools.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../db/board.js";
import { handleListTasks, handleGetTask, handleCreateTask, handleUpdateTask } from "./mcp.js";

let dataDir: string;
let boardStore: BoardStore;

const WORKSPACE_A = "workspace-a";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-board-mcp-test-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;
  boardStore = new BoardStore();
});

afterEach(() => {
  boardStore.close();
  delete process.env.VIBEDECK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

/** Every tool result is `{ content: [{ type: "text", text }] }` — pulls out
 * and JSON-parses that text, same helper shape as `memory/mcp.test.ts`'s
 * `parseResult`. */
function parseResult(result: Awaited<ReturnType<typeof handleListTasks>>): unknown {
  const first = result.content[0];
  if (first.type !== "text") throw new Error("expected a text content block");
  return JSON.parse(first.text);
}

describe("handleListTasks", () => {
  it("returns an empty list for a fresh workspace", async () => {
    const result = await handleListTasks(boardStore, WORKSPACE_A);
    expect(parseResult(result)).toEqual({ tasks: [] });
  });

  it("lists created tasks", async () => {
    boardStore.create({ workspaceId: WORKSPACE_A, title: "First task" });
    const result = await handleListTasks(boardStore, WORKSPACE_A);
    const parsed = parseResult(result) as { tasks: Array<{ title: string }> };
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].title).toBe("First task");
  });
});

describe("handleGetTask", () => {
  it("returns an error result for an unknown id", async () => {
    const result = await handleGetTask(boardStore, "nope");
    expect(result.isError).toBe(true);
  });

  it("returns the full task, including taskKnowledge", async () => {
    const created = boardStore.create({
      workspaceId: WORKSPACE_A,
      title: "Has knowledge",
      taskKnowledge: "Auth lives in src/auth/*.ts.",
    });
    const result = await handleGetTask(boardStore, created.id);
    const parsed = parseResult(result) as { id: string; taskKnowledge: string };
    expect(parsed.id).toBe(created.id);
    expect(parsed.taskKnowledge).toBe("Auth lives in src/auth/*.ts.");
  });
});

describe("handleCreateTask", () => {
  it("creates a task with title only", async () => {
    const result = await handleCreateTask(boardStore, WORKSPACE_A, { title: "New task" });
    const parsed = parseResult(result) as { title: string; columnId: string };
    expect(parsed.title).toBe("New task");
    expect(parsed.columnId).toBe("todo");
  });

  it("creates a task with description and taskKnowledge separately", async () => {
    const result = await handleCreateTask(boardStore, WORKSPACE_A, {
      title: "Fix login",
      description: "Users can't log in with SSO.",
      taskKnowledge: "SSO handler is in src/auth/sso.ts; see ADR-7.",
    });
    const parsed = parseResult(result) as { description: string; taskKnowledge: string };
    expect(parsed.description).toBe("Users can't log in with SSO.");
    expect(parsed.taskKnowledge).toBe("SSO handler is in src/auth/sso.ts; see ADR-7.");
  });

  it("errors on an empty title", async () => {
    const result = await handleCreateTask(boardStore, WORKSPACE_A, { title: "  " });
    expect(result.isError).toBe(true);
  });

  it("errors when taskKnowledge exceeds the length cap", async () => {
    const result = await handleCreateTask(boardStore, WORKSPACE_A, {
      title: "x",
      taskKnowledge: "a".repeat(50_001),
    });
    expect(result.isError).toBe(true);
  });

  it("errors on an invalid priority or columnId", async () => {
    const badPriority = await handleCreateTask(boardStore, WORKSPACE_A, { title: "x", priority: "urgent" });
    expect(badPriority.isError).toBe(true);

    const badColumn = await handleCreateTask(boardStore, WORKSPACE_A, { title: "x", columnId: "done" });
    expect(badColumn.isError).toBe(true);
  });

  it("accepts columnId: cancelled", async () => {
    const result = await handleCreateTask(boardStore, WORKSPACE_A, { title: "x", columnId: "cancelled" });
    const parsed = parseResult(result) as { columnId: string };
    expect(parsed.columnId).toBe("cancelled");
  });
});

describe("handleUpdateTask", () => {
  it("errors for an unknown task id", async () => {
    const result = await handleUpdateTask(boardStore, "nope", { title: "x" });
    expect(result.isError).toBe(true);
  });

  it("updates taskKnowledge independently of description", async () => {
    const created = boardStore.create({ workspaceId: WORKSPACE_A, title: "Learn me" });
    const result = await handleUpdateTask(boardStore, created.id, {
      taskKnowledge: "New context here.",
    });
    const parsed = parseResult(result) as { taskKnowledge: string; description: string | null };
    expect(parsed.taskKnowledge).toBe("New context here.");
    expect(parsed.description).toBeNull();
  });

  it("moves a task to in_review, then to cancelled", async () => {
    const created = boardStore.create({ workspaceId: WORKSPACE_A, title: "Move me" });

    const inReview = await handleUpdateTask(boardStore, created.id, { columnId: "in_review" });
    expect((parseResult(inReview) as { columnId: string }).columnId).toBe("in_review");

    const cancelled = await handleUpdateTask(boardStore, created.id, { columnId: "cancelled" });
    expect((parseResult(cancelled) as { columnId: string }).columnId).toBe("cancelled");
  });

  it("errors when the updated taskKnowledge exceeds the length cap", async () => {
    const created = boardStore.create({ workspaceId: WORKSPACE_A, title: "x" });
    const result = await handleUpdateTask(boardStore, created.id, { taskKnowledge: "a".repeat(50_001) });
    expect(result.isError).toBe(true);
  });
});
