/**
 * CRUD tests for WorkspaceStore, run against a real SQLite file — but always
 * inside a fresh `mkdtempSync` temp directory, never the developer's real
 * `~/.vibedeck`. `VIBEDECK_DATA_DIR` is what `schema.ts`'s `getDataDir()`
 * reads, so setting it before each `new WorkspaceStore()` is what redirects
 * every test here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "./workspaces.js";

let dataDir: string;
let store: WorkspaceStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-test-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;
  store = new WorkspaceStore();
});

afterEach(() => {
  store.close();
  delete process.env.VIBEDECK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("WorkspaceStore", () => {
  it("starts empty", () => {
    expect(store.list()).toEqual([]);
  });

  it("creates a workspace with a generated id, ISO timestamps, and no layout", () => {
    const workspace = store.create({ name: "vibedeck", rootPath: "/tmp/vibedeck" });

    expect(workspace.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(workspace.name).toBe("vibedeck");
    expect(workspace.rootPath).toBe("/tmp/vibedeck");
    expect(workspace.layout).toBeNull();
    // ISO 8601 UTC strings round-trip through Date without throwing/NaN.
    expect(Number.isNaN(new Date(workspace.createdAt).getTime())).toBe(false);
    expect(workspace.createdAt).toBe(workspace.updatedAt);
  });

  it("lists every created workspace, oldest first", () => {
    const a = store.create({ name: "a", rootPath: "/tmp/a" });
    const b = store.create({ name: "b", rootPath: "/tmp/b" });

    const listed = store.list();
    expect(listed.map((w) => w.id)).toEqual([a.id, b.id]);
  });

  it("get() returns undefined for an unknown id", () => {
    expect(store.get("does-not-exist")).toBeUndefined();
  });

  it("get() returns the workspace for a known id", () => {
    const created = store.create({ name: "found-me", rootPath: "/tmp/found-me" });
    expect(store.get(created.id)).toEqual(created);
  });

  it("update() changes name and rootPath, bumps updatedAt, leaves createdAt alone", async () => {
    const created = store.create({ name: "old-name", rootPath: "/tmp/old-path" });

    // Force a real (if tiny) time gap so updatedAt is provably later than
    // createdAt rather than just coincidentally identical millisecond
    // values on a very fast machine.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = store.update(created.id, { name: "new-name", rootPath: "/tmp/new-path" });

    expect(updated).toBeDefined();
    expect(updated?.name).toBe("new-name");
    expect(updated?.rootPath).toBe("/tmp/new-path");
    expect(updated?.createdAt).toBe(created.createdAt);
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThan(
      new Date(created.createdAt).getTime()
    );
  });

  it("update() round-trips a JSON-serialised layout", () => {
    const created = store.create({ name: "with-layout", rootPath: "/tmp/with-layout" });
    const layout = JSON.stringify({ kind: "leaf", id: "leaf-1", sessionId: null });

    const updated = store.update(created.id, { layout });

    expect(updated?.layout).toBe(layout);
    expect(store.get(created.id)?.layout).toBe(layout);
  });

  it("update() can explicitly clear a layout back to null", () => {
    const created = store.create({ name: "clearable", rootPath: "/tmp/clearable" });
    store.update(created.id, { layout: JSON.stringify({ kind: "leaf", id: "x", sessionId: null }) });

    const cleared = store.update(created.id, { layout: null });
    expect(cleared?.layout).toBeNull();
  });

  it("update() omitting layout entirely leaves the existing layout untouched", () => {
    const created = store.create({ name: "untouched-layout", rootPath: "/tmp/untouched" });
    const layout = JSON.stringify({ kind: "leaf", id: "leaf-1", sessionId: null });
    store.update(created.id, { layout });

    const updated = store.update(created.id, { name: "renamed-only" });
    expect(updated?.layout).toBe(layout);
    expect(updated?.name).toBe("renamed-only");
  });

  it("update() returns undefined for an unknown id", () => {
    expect(store.update("does-not-exist", { name: "nope" })).toBeUndefined();
  });

  it("remove() deletes a workspace and returns true", () => {
    const created = store.create({ name: "to-delete", rootPath: "/tmp/to-delete" });
    expect(store.remove(created.id)).toBe(true);
    expect(store.get(created.id)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("remove() returns false for an unknown id", () => {
    expect(store.remove("does-not-exist")).toBe(false);
  });

  it("persists across a fresh WorkspaceStore against the same data dir (survives a restart)", () => {
    const created = store.create({ name: "survives-restart", rootPath: "/tmp/survives-restart" });
    store.update(created.id, { layout: JSON.stringify({ kind: "leaf", id: "x", sessionId: null }) });
    store.close();

    // A brand-new store, same VIBEDECK_DATA_DIR — simulates the server
    // process restarting and re-opening the same on-disk database file.
    const reopened = new WorkspaceStore();
    const found = reopened.get(created.id);
    expect(found?.name).toBe("survives-restart");
    expect(found?.layout).toBe(JSON.stringify({ kind: "leaf", id: "x", sessionId: null }));
    reopened.close();

    // Re-create `store` so the shared afterEach's `store.close()` doesn't
    // throw on an already-closed handle.
    store = new WorkspaceStore();
  });
});
