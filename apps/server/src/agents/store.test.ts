/**
 * CRUD + duplicate-name tests for AgentProfileStore, run against a real
 * SQLite file inside a fresh `mkdtempSync` temp directory — same pattern as
 * `db/board.test.ts` and `db/workspaces.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProfileStore } from "./store.js";

let dataDir: string;
let store: AgentProfileStore;

const WORKSPACE_A = "workspace-a";
const WORKSPACE_B = "workspace-b";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-agents-store-test-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;
  store = new AgentProfileStore();
});

afterEach(() => {
  store.close();
  delete process.env.VIBEDECK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("AgentProfileStore CRUD", () => {
  it("starts empty for any workspace", () => {
    expect(store.list(WORKSPACE_A)).toEqual([]);
  });

  it("creates a profile with a generated id and matching timestamps", () => {
    const result = store.create({
      workspaceId: WORKSPACE_A,
      name: "Reviewer Bot",
      systemPrompt: "You are a careful code reviewer.",
      baseAgent: "claude",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.agent.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(result.agent.name).toBe("Reviewer Bot");
    expect(result.agent.systemPrompt).toBe("You are a careful code reviewer.");
    expect(result.agent.baseAgent).toBe("claude");
    expect(result.agent.workspaceId).toBe(WORKSPACE_A);
    expect(result.agent.createdAt).toBe(result.agent.updatedAt);
  });

  it("get() returns undefined for an unknown id", () => {
    expect(store.get("does-not-exist")).toBeUndefined();
  });

  it("get() returns the profile for a known id", () => {
    const created = store.create({
      workspaceId: WORKSPACE_A,
      name: "Findable",
      systemPrompt: "x",
      baseAgent: "shell",
    });
    if (!created.ok) throw new Error("setup failed");
    expect(store.get(created.agent.id)).toEqual(created.agent);
  });

  it("list() orders by name and never returns another workspace's profiles", () => {
    store.create({ workspaceId: WORKSPACE_A, name: "Zeta", systemPrompt: "x", baseAgent: "shell" });
    store.create({ workspaceId: WORKSPACE_A, name: "Alpha", systemPrompt: "x", baseAgent: "shell" });
    store.create({ workspaceId: WORKSPACE_B, name: "Belongs to B", systemPrompt: "x", baseAgent: "shell" });

    const a = store.list(WORKSPACE_A);
    expect(a.map((p) => p.name)).toEqual(["Alpha", "Zeta"]);

    const b = store.list(WORKSPACE_B);
    expect(b).toHaveLength(1);
    expect(b[0].name).toBe("Belongs to B");
  });

  it("update() changes fields and bumps updatedAt, leaves createdAt alone", async () => {
    const created = store.create({
      workspaceId: WORKSPACE_A,
      name: "Old name",
      systemPrompt: "old prompt",
      baseAgent: "shell",
    });
    if (!created.ok) throw new Error("setup failed");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = store.update(created.agent.id, { name: "New name", systemPrompt: "new prompt" });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;

    expect(updated.agent.name).toBe("New name");
    expect(updated.agent.systemPrompt).toBe("new prompt");
    expect(updated.agent.createdAt).toBe(created.agent.createdAt);
    expect(new Date(updated.agent.updatedAt).getTime()).toBeGreaterThan(
      new Date(created.agent.createdAt).getTime()
    );
  });

  it("update() omitting a field entirely leaves it untouched", () => {
    const created = store.create({
      workspaceId: WORKSPACE_A,
      name: "Untouched",
      systemPrompt: "keep me",
      baseAgent: "claude",
    });
    if (!created.ok) throw new Error("setup failed");

    const updated = store.update(created.agent.id, { baseAgent: "codex" });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.agent.systemPrompt).toBe("keep me");
    expect(updated.agent.name).toBe("Untouched");
    expect(updated.agent.baseAgent).toBe("codex");
  });

  it("update() returns not-found for an unknown id", () => {
    const result = store.update("does-not-exist", { name: "nope" });
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("remove() deletes a profile and returns true", () => {
    const created = store.create({ workspaceId: WORKSPACE_A, name: "To delete", systemPrompt: "x", baseAgent: "shell" });
    if (!created.ok) throw new Error("setup failed");
    expect(store.remove(created.agent.id)).toBe(true);
    expect(store.get(created.agent.id)).toBeUndefined();
  });

  it("remove() returns false for an unknown id", () => {
    expect(store.remove("does-not-exist")).toBe(false);
  });
});

describe("AgentProfileStore duplicate names (UNIQUE-constraint arbitration)", () => {
  it("create() rejects a second profile with the same name in the same workspace", () => {
    const first = store.create({ workspaceId: WORKSPACE_A, name: "Dup", systemPrompt: "x", baseAgent: "shell" });
    expect(first.ok).toBe(true);

    const second = store.create({ workspaceId: WORKSPACE_A, name: "Dup", systemPrompt: "y", baseAgent: "claude" });
    expect(second).toEqual({ ok: false, reason: "duplicate-name" });
  });

  it("allows the SAME name in two DIFFERENT workspaces — the uniqueness is per-workspace", () => {
    const a = store.create({ workspaceId: WORKSPACE_A, name: "Shared name", systemPrompt: "x", baseAgent: "shell" });
    const b = store.create({ workspaceId: WORKSPACE_B, name: "Shared name", systemPrompt: "x", baseAgent: "shell" });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("update() rejects renaming a profile to a name already taken in its workspace", () => {
    store.create({ workspaceId: WORKSPACE_A, name: "Taken", systemPrompt: "x", baseAgent: "shell" });
    const other = store.create({ workspaceId: WORKSPACE_A, name: "Renamable", systemPrompt: "x", baseAgent: "shell" });
    if (!other.ok) throw new Error("setup failed");

    const result = store.update(other.agent.id, { name: "Taken" });
    expect(result).toEqual({ ok: false, reason: "duplicate-name" });

    // The rejected rename must not have partially applied.
    expect(store.get(other.agent.id)?.name).toBe("Renamable");
  });
});
