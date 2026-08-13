/**
 * Tests the `list_prompts` MCP tool handler directly against a real
 * temp-dir SQLite database — same pattern as `agents/mcp.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SavedPromptStore } from "./store.js";
import { handleListPrompts } from "./mcp.js";

let dataDir: string;
let store: SavedPromptStore;

const WORKSPACE_A = "workspace-a";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-prompts-mcp-test-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;
  store = new SavedPromptStore();
});

afterEach(() => {
  store.close();
  delete process.env.VIBEDECK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function parseResult(result: Awaited<ReturnType<typeof handleListPrompts>>): unknown {
  const first = result.content[0];
  if (first.type !== "text") throw new Error("expected a text content block");
  return JSON.parse(first.text);
}

describe("handleListPrompts", () => {
  it("returns an empty list with nothing saved", async () => {
    const result = await handleListPrompts(store);
    expect(parseResult(result)).toEqual({ prompts: [] });
  });

  it("returns only globals when workspaceId is omitted", async () => {
    store.create({ title: "Global", body: "x" });
    store.create({ workspaceId: WORKSPACE_A, title: "Scoped", body: "x" });

    const result = await handleListPrompts(store);
    const parsed = parseResult(result) as { prompts: Array<{ title: string }> };
    expect(parsed.prompts.map((p) => p.title)).toEqual(["Global"]);
  });

  it("returns globals plus this workspace's own when workspaceId is given", async () => {
    store.create({ title: "Global", body: "x" });
    store.create({ workspaceId: WORKSPACE_A, title: "Scoped", body: "x" });

    const result = await handleListPrompts(store, WORKSPACE_A);
    const parsed = parseResult(result) as { prompts: Array<{ title: string }> };
    expect(parsed.prompts.map((p) => p.title).sort()).toEqual(["Global", "Scoped"]);
  });
});
