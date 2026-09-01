/**
 * Tests `resolveWorkspaceId` against a real temp-dir SQLite database — same
 * pattern as every other DB-backed test in this repo.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../db/workspaces.js";
import { resolveWorkspaceId } from "./workspace-resolver.js";

let dataDir: string;
let store: WorkspaceStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibespace-workspace-resolver-test-"));
  process.env.VIBESPACE_DATA_DIR = dataDir;
  store = new WorkspaceStore();
});

afterEach(() => {
  store.close();
  delete process.env.VIBESPACE_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("resolveWorkspaceId", () => {
  it("resolves a root path that matches a registered workspace", () => {
    const workspace = store.create({ name: "my-project", rootPath: "/tmp/my-project" });
    const result = resolveWorkspaceId(store, "/tmp/my-project");
    expect(result).toEqual({ ok: true, workspaceId: workspace.id });
  });

  it("returns a clear error for a root not registered as any workspace", () => {
    const result = resolveWorkspaceId(store, "/tmp/never-opened-in-vibespace");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("/tmp/never-opened-in-vibespace");
    expect(result.error.toLowerCase()).toContain("workspace");
  });

  it("does not match a DIFFERENT workspace's root", () => {
    store.create({ name: "other", rootPath: "/tmp/other-project" });
    const result = resolveWorkspaceId(store, "/tmp/my-project");
    expect(result.ok).toBe(false);
  });
});
