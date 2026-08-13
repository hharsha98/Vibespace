/**
 * Tests `buildVibedeckMcpServer` two ways:
 *
 * 1. The same "builds without throwing" smoke check `memory/mcp.test.ts`
 *    does for `createMemoryMcpServer` — including for a workspace root
 *    that ISN'T registered yet, since board/agent/prompt tools must still
 *    REGISTER even when they can't resolve a workspace id (per
 *    `./workspace-resolver.ts`'s "fail per-call, not at startup" design).
 * 2. A real end-to-end round trip over the MCP SDK's `InMemoryTransport` —
 *    connect a real `Client`, `listTools()`, `callTool()`, and
 *    `getPrompt()` against the actual server object, no stdio process
 *    involved. This is the automated equivalent of the manual subprocess
 *    smoke test docs/MEMORY.md's "Does it actually work?" section
 *    describes for the memory tools — same idea, applied here in CI
 *    instead of as a one-off manual check, and without the flakiness/cost
 *    of spawning a real `tsx` child process for the same coverage.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkspaceStore } from "../db/workspaces.js";
import { buildVibedeckMcpServer, type VibedeckMcpServer } from "./build-server.js";
import { DEVELOPER_GUIDE_PROMPT_NAME } from "./developer-guide.js";

let dataDir: string;
let workspaceRoot: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-build-server-test-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;
  workspaceRoot = mkdtempSync(join(tmpdir(), "vibedeck-build-server-workspace-"));
});

afterEach(() => {
  delete process.env.VIBEDECK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("buildVibedeckMcpServer", () => {
  it("builds without throwing for a registered workspace root", () => {
    const workspaceStore = new WorkspaceStore();
    workspaceStore.create({ name: "test", rootPath: workspaceRoot });
    workspaceStore.close();

    let built: VibedeckMcpServer | undefined;
    expect(() => {
      built = buildVibedeckMcpServer(workspaceRoot);
    }).not.toThrow();
    expect(built!.server).toBeInstanceOf(McpServer);
    built!.close();
  });

  it("builds without throwing even for an UNREGISTERED workspace root", () => {
    // Every tool must still register — resolution failure is a per-call
    // concern (see ./workspace-resolver.ts), not a build-time one.
    let built: VibedeckMcpServer | undefined;
    expect(() => {
      built = buildVibedeckMcpServer(workspaceRoot);
    }).not.toThrow();
    built!.close();
  });
});

describe("buildVibedeckMcpServer end-to-end (InMemoryTransport)", () => {
  let built: VibedeckMcpServer;
  let client: Client;

  beforeEach(async () => {
    const workspaceStore = new WorkspaceStore();
    workspaceStore.create({ name: "test", rootPath: workspaceRoot });
    workspaceStore.close();

    built = buildVibedeckMcpServer(workspaceRoot);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), built.server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await client.close();
    built.close();
  });

  it("lists every memory AND board/agent/prompt tool", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual(
      [
        "memory_list",
        "memory_read",
        "memory_write",
        "memory_search",
        "list_tasks",
        "get_task",
        "create_task",
        "update_task",
        "list_agents",
        "get_agent",
        "create_agent",
        "update_agent",
        "delete_agent",
        "list_prompts",
      ].sort()
    );
  });

  it("creates a task, lists it, then reads it back with taskKnowledge intact", async () => {
    const created = await client.callTool({
      name: "create_task",
      arguments: { title: "Fix login", taskKnowledge: "Auth lives in src/auth/*.ts." },
    });
    expect(created.isError).toBeFalsy();
    const createdContent = created.content as Array<{ type: string; text: string }>;
    const createdTask = JSON.parse(createdContent[0].text) as { id: string; taskKnowledge: string };
    expect(createdTask.taskKnowledge).toBe("Auth lives in src/auth/*.ts.");

    const listed = await client.callTool({ name: "list_tasks", arguments: {} });
    const listedContent = listed.content as Array<{ type: string; text: string }>;
    const listedTasks = JSON.parse(listedContent[0].text) as { tasks: Array<{ id: string }> };
    expect(listedTasks.tasks.map((t) => t.id)).toContain(createdTask.id);

    const fetched = await client.callTool({ name: "get_task", arguments: { taskId: createdTask.id } });
    const fetchedContent = fetched.content as Array<{ type: string; text: string }>;
    const fetchedTask = JSON.parse(fetchedContent[0].text) as { taskKnowledge: string };
    expect(fetchedTask.taskKnowledge).toBe("Auth lives in src/auth/*.ts.");
  });

  it("creates an agent profile and lists it", async () => {
    const created = await client.callTool({
      name: "create_agent",
      arguments: { name: "Reviewer Bot", systemPrompt: "Review carefully.", baseAgent: "claude" },
    });
    expect(created.isError).toBeFalsy();

    const listed = await client.callTool({ name: "list_agents", arguments: {} });
    const listedContent = listed.content as Array<{ type: string; text: string }>;
    const listedAgents = JSON.parse(listedContent[0].text) as { agents: Array<{ name: string }> };
    expect(listedAgents.agents.map((a) => a.name)).toContain("Reviewer Bot");
  });

  it("lists prompts (empty, since none were saved)", async () => {
    const result = await client.callTool({ name: "list_prompts", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0].text)).toEqual({ prompts: [] });
  });

  it("serves the vibedeck_developer_guide prompt, mentioning taskKnowledge and swarm claims", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain(DEVELOPER_GUIDE_PROMPT_NAME);

    const result = await client.getPrompt({ name: DEVELOPER_GUIDE_PROMPT_NAME });
    expect(result.messages).toHaveLength(1);
    const content = result.messages[0].content as { type: string; text: string };
    expect(content.text).toContain("taskKnowledge");
    expect(content.text).toContain("claim");
    expect(content.text).toContain("cancelled");
  });
});

describe("buildVibedeckMcpServer end-to-end against an UNREGISTERED workspace", () => {
  it("board/agent tools return a clear error result; memory and list_prompts still work", async () => {
    // Deliberately do NOT register workspaceRoot as a workspace.
    const built = buildVibedeckMcpServer(workspaceRoot);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), built.server.connect(serverTransport)]);

    const listTasks = await client.callTool({ name: "list_tasks", arguments: {} });
    expect(listTasks.isError).toBe(true);
    const listTasksContent = listTasks.content as Array<{ type: string; text: string }>;
    expect(listTasksContent[0].text.toLowerCase()).toContain("workspace");

    // Memory tools are unaffected — they never needed a workspace id.
    const memoryList = await client.callTool({ name: "memory_list", arguments: {} });
    expect(memoryList.isError).toBeFalsy();

    // list_prompts degrades to global-only rather than erroring.
    const listPrompts = await client.callTool({ name: "list_prompts", arguments: {} });
    expect(listPrompts.isError).toBeFalsy();

    await client.close();
    built.close();
  });
});
