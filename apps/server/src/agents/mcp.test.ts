/**
 * Tests the agent-profile MCP tool handlers directly against a real
 * temp-dir SQLite database — same pattern as `board/mcp.test.ts` and
 * `agents/store.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProfileStore } from "./store.js";
import { handleListAgents, handleGetAgent, handleCreateAgent, handleUpdateAgent, handleDeleteAgent } from "./mcp.js";

let dataDir: string;
let store: AgentProfileStore;

const WORKSPACE_A = "workspace-a";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibespace-agents-mcp-test-"));
  process.env.VIBESPACE_DATA_DIR = dataDir;
  store = new AgentProfileStore();
});

afterEach(() => {
  store.close();
  delete process.env.VIBESPACE_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function parseResult(result: Awaited<ReturnType<typeof handleListAgents>>): unknown {
  const first = result.content[0];
  if (first.type !== "text") throw new Error("expected a text content block");
  return JSON.parse(first.text);
}

describe("handleListAgents", () => {
  it("returns an empty list for a fresh workspace", async () => {
    const result = await handleListAgents(store, WORKSPACE_A);
    expect(parseResult(result)).toEqual({ agents: [] });
  });
});

describe("handleGetAgent", () => {
  it("returns an error result for an unknown id", async () => {
    const result = await handleGetAgent(store, "nope");
    expect(result.isError).toBe(true);
  });

  it("returns the full profile, including systemPrompt", async () => {
    const created = store.create({
      workspaceId: WORKSPACE_A,
      name: "Reviewer",
      systemPrompt: "Review carefully.",
      baseAgent: "claude",
    });
    if (!created.ok) throw new Error("setup failed");
    const result = await handleGetAgent(store, created.agent.id);
    const parsed = parseResult(result) as { systemPrompt: string };
    expect(parsed.systemPrompt).toBe("Review carefully.");
  });
});

describe("handleCreateAgent", () => {
  it("creates a profile", async () => {
    const result = await handleCreateAgent(store, WORKSPACE_A, {
      name: "Reviewer Bot",
      systemPrompt: "You review code.",
      baseAgent: "claude",
    });
    const parsed = parseResult(result) as { name: string; baseAgent: string };
    expect(parsed.name).toBe("Reviewer Bot");
    expect(parsed.baseAgent).toBe("claude");
  });

  it("errors on an empty name or systemPrompt", async () => {
    const badName = await handleCreateAgent(store, WORKSPACE_A, {
      name: " ",
      systemPrompt: "x",
      baseAgent: "shell",
    });
    expect(badName.isError).toBe(true);

    const badPrompt = await handleCreateAgent(store, WORKSPACE_A, {
      name: "x",
      systemPrompt: "",
      baseAgent: "shell",
    });
    expect(badPrompt.isError).toBe(true);
  });

  it("errors when systemPrompt exceeds 100,000 characters", async () => {
    const result = await handleCreateAgent(store, WORKSPACE_A, {
      name: "x",
      systemPrompt: "a".repeat(100_001),
      baseAgent: "shell",
    });
    expect(result.isError).toBe(true);
  });

  it("errors on an invalid baseAgent", async () => {
    const result = await handleCreateAgent(store, WORKSPACE_A, {
      name: "x",
      systemPrompt: "x",
      baseAgent: "not-real",
    });
    expect(result.isError).toBe(true);
  });

  it("errors, naming the conflict, on a duplicate name in the same workspace", async () => {
    await handleCreateAgent(store, WORKSPACE_A, { name: "Dup", systemPrompt: "x", baseAgent: "shell" });
    const second = await handleCreateAgent(store, WORKSPACE_A, { name: "Dup", systemPrompt: "y", baseAgent: "claude" });
    expect(second.isError).toBe(true);
    const text = second.content[0];
    if (text.type !== "text") throw new Error("expected text");
    expect(text.text).toContain("Dup");
  });
});

describe("handleUpdateAgent", () => {
  it("errors for an unknown id", async () => {
    const result = await handleUpdateAgent(store, "nope", { name: "x" });
    expect(result.isError).toBe(true);
  });

  it("updates fields", async () => {
    const created = store.create({ workspaceId: WORKSPACE_A, name: "Old", systemPrompt: "old", baseAgent: "shell" });
    if (!created.ok) throw new Error("setup failed");

    const result = await handleUpdateAgent(store, created.agent.id, { name: "New", baseAgent: "codex" });
    const parsed = parseResult(result) as { name: string; baseAgent: string; systemPrompt: string };
    expect(parsed.name).toBe("New");
    expect(parsed.baseAgent).toBe("codex");
    expect(parsed.systemPrompt).toBe("old"); // untouched
  });

  it("errors, naming the conflict, when renaming to a taken name", async () => {
    store.create({ workspaceId: WORKSPACE_A, name: "Taken", systemPrompt: "x", baseAgent: "shell" });
    const other = store.create({ workspaceId: WORKSPACE_A, name: "Renamable", systemPrompt: "x", baseAgent: "shell" });
    if (!other.ok) throw new Error("setup failed");

    const result = await handleUpdateAgent(store, other.agent.id, { name: "Taken" });
    expect(result.isError).toBe(true);
  });
});

describe("handleDeleteAgent", () => {
  it("deletes a profile", async () => {
    const created = store.create({ workspaceId: WORKSPACE_A, name: "x", systemPrompt: "x", baseAgent: "shell" });
    if (!created.ok) throw new Error("setup failed");

    const result = await handleDeleteAgent(store, created.agent.id);
    expect(parseResult(result)).toEqual({ deleted: true, id: created.agent.id });
    expect(store.get(created.agent.id)).toBeUndefined();
  });

  it("errors for an unknown id", async () => {
    const result = await handleDeleteAgent(store, "nope");
    expect(result.isError).toBe(true);
  });
});
