/**
 * CRUD + global/workspace-scoping tests for SavedPromptStore, run against a
 * real SQLite file inside a fresh `mkdtempSync` temp directory — same
 * pattern as `db/board.test.ts` and `agents/store.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SavedPromptStore } from "./store.js";

let dataDir: string;
let store: SavedPromptStore;

const WORKSPACE_A = "workspace-a";
const WORKSPACE_B = "workspace-b";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-prompts-store-test-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;
  store = new SavedPromptStore();
});

afterEach(() => {
  store.close();
  delete process.env.VIBEDECK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("SavedPromptStore CRUD", () => {
  it("starts empty", () => {
    expect(store.list()).toEqual([]);
  });

  it("creates a global prompt when workspaceId is omitted", () => {
    const prompt = store.create({ title: "Write tests", body: "Write tests for the function above." });
    expect(prompt.workspaceId).toBeNull();
    expect(prompt.title).toBe("Write tests");
    expect(prompt.body).toBe("Write tests for the function above.");
    expect(prompt.createdAt).toBe(prompt.updatedAt);
  });

  it("creates a workspace-scoped prompt when workspaceId is given", () => {
    const prompt = store.create({ workspaceId: WORKSPACE_A, title: "Scoped", body: "x" });
    expect(prompt.workspaceId).toBe(WORKSPACE_A);
  });

  it("get() returns undefined for an unknown id", () => {
    expect(store.get("does-not-exist")).toBeUndefined();
  });

  it("update() changes title/body and bumps updatedAt, leaves createdAt alone", async () => {
    const created = store.create({ title: "Old", body: "old body" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = store.update(created.id, { title: "New", body: "new body" });
    expect(updated?.title).toBe("New");
    expect(updated?.body).toBe("new body");
    expect(updated?.createdAt).toBe(created.createdAt);
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThan(new Date(created.createdAt).getTime());
  });

  it("update() omitting a field leaves it untouched, and cannot change workspaceId", () => {
    const created = store.create({ workspaceId: WORKSPACE_A, title: "Keep scope", body: "keep me" });
    const updated = store.update(created.id, { title: "Renamed" });
    expect(updated?.body).toBe("keep me");
    expect(updated?.workspaceId).toBe(WORKSPACE_A); // UpdateSavedPromptOptions has no workspaceId field at all
  });

  it("update() returns undefined for an unknown id", () => {
    expect(store.update("does-not-exist", { title: "nope" })).toBeUndefined();
  });

  it("remove() deletes a prompt and returns true", () => {
    const created = store.create({ title: "To delete", body: "x" });
    expect(store.remove(created.id)).toBe(true);
    expect(store.get(created.id)).toBeUndefined();
  });

  it("remove() returns false for an unknown id", () => {
    expect(store.remove("does-not-exist")).toBe(false);
  });
});

describe("SavedPromptStore global vs workspace scoping", () => {
  it("list() with no workspaceId returns only global prompts", () => {
    store.create({ title: "Global one", body: "x" });
    store.create({ workspaceId: WORKSPACE_A, title: "Scoped to A", body: "x" });

    const result = store.list();
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Global one");
  });

  it("list(workspaceId) returns globals PLUS that workspace's own, but not another workspace's", () => {
    store.create({ title: "Global", body: "x" });
    store.create({ workspaceId: WORKSPACE_A, title: "A's own", body: "x" });
    store.create({ workspaceId: WORKSPACE_B, title: "B's own", body: "x" });

    const forA = store.list(WORKSPACE_A);
    expect(forA.map((p) => p.title).sort()).toEqual(["A's own", "Global"]);

    const forB = store.list(WORKSPACE_B);
    expect(forB.map((p) => p.title).sort()).toEqual(["B's own", "Global"]);
  });
});
