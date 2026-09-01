/**
 * CRUD tests for WorkspaceStore, run against a real SQLite file — but always
 * inside a fresh `mkdtempSync` temp directory, never the developer's real
 * `~/.vibespace`. `VIBESPACE_DATA_DIR` is what `schema.ts`'s `getDataDir()`
 * reads, so setting it before each `new WorkspaceStore()` is what redirects
 * every test here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./schema.js";
import { WORKSPACE_SCOPED_TABLES, WorkspaceStore } from "./workspaces.js";

let dataDir: string;
let store: WorkspaceStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibespace-test-"));
  process.env.VIBESPACE_DATA_DIR = dataDir;
  store = new WorkspaceStore();
});

afterEach(() => {
  store.close();
  delete process.env.VIBESPACE_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("WorkspaceStore", () => {
  it("starts empty", () => {
    expect(store.list()).toEqual([]);
  });

  it("creates a workspace with a generated id, ISO timestamps, and no layout", () => {
    const workspace = store.create({ name: "vibespace", rootPath: "/tmp/vibespace" });

    expect(workspace.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(workspace.name).toBe("vibespace");
    expect(workspace.rootPath).toBe("/tmp/vibespace");
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

  it("creates a workspace with color: null (no colour chosen yet)", () => {
    const created = store.create({ name: "no-color", rootPath: "/tmp/no-color" });
    expect(created.color).toBeNull();
  });

  it("update() sets a workspace's colour", () => {
    const created = store.create({ name: "colorable", rootPath: "/tmp/colorable" });
    const updated = store.update(created.id, { color: "#f87171" });
    expect(updated?.color).toBe("#f87171");
    expect(store.get(created.id)?.color).toBe("#f87171");
  });

  it("update() can explicitly clear a colour back to null", () => {
    const created = store.create({ name: "clearable-color", rootPath: "/tmp/clearable-color" });
    store.update(created.id, { color: "#60a5fa" });

    const cleared = store.update(created.id, { color: null });
    expect(cleared?.color).toBeNull();
  });

  it("update() omitting color entirely leaves the existing colour untouched", () => {
    const created = store.create({ name: "untouched-color", rootPath: "/tmp/untouched-color" });
    store.update(created.id, { color: "#4ade80" });

    const updated = store.update(created.id, { name: "renamed-only-2" });
    expect(updated?.color).toBe("#4ade80");
    expect(updated?.name).toBe("renamed-only-2");
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

    // A brand-new store, same VIBESPACE_DATA_DIR — simulates the server
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

/**
 * The guard test: this is the whole reason `remove()` uses a hand-maintained
 * list of tables (`WORKSPACE_SCOPED_TABLES`) instead of `FOREIGN KEY ...
 * ON DELETE CASCADE` (see that constant's and `remove()`'s own doc comments
 * in `workspaces.ts`). Without something like this, a future table that
 * grows a `workspace_id` column and is never wired into `remove()` would
 * fail completely silently — its rows would just start piling up as orphans
 * again, exactly like the bug this whole file exists to fix, and nothing
 * would ever tell anyone. This test is what makes that failure loud
 * instead: it reads the LIVE schema, not a copy of the table list, so it
 * breaks the moment the two drift apart.
 */
describe("WORKSPACE_SCOPED_TABLES stays in sync with the live schema", () => {
  it("every table with a workspace_id column is in WORKSPACE_SCOPED_TABLES, and vice versa", () => {
    const db = openDatabase();
    try {
      const tables = (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
          .all() as { name: string }[]
      ).map((t) => t.name);

      const tablesWithWorkspaceId = tables.filter((table) =>
        (db.pragma(`table_info(${table})`) as { name: string }[]).some(
          (column) => column.name === "workspace_id"
        )
      );

      const handled = new Set<string>(WORKSPACE_SCOPED_TABLES);

      // Direction 1: a live table has workspace_id but remove() doesn't
      // handle it — the exact scenario that would silently orphan rows.
      const unhandled = tablesWithWorkspaceId.filter((table) => !handled.has(table));
      if (unhandled.length > 0) {
        throw new Error(
          unhandled
            .map(
              (table) =>
                `table \`${table}\` has a workspace_id column but is not in ` +
                `WORKSPACE_SCOPED_TABLES; add it there or its rows will be orphaned ` +
                `when a workspace is deleted.`
            )
            .join("\n")
        );
      }

      // Direction 2: WORKSPACE_SCOPED_TABLES claims a table that no longer
      // actually has a workspace_id column (e.g. renamed/dropped) — a stale
      // entry that would make remove() run a DELETE against a column that
      // doesn't exist.
      const stale = [...WORKSPACE_SCOPED_TABLES].filter((table) => !tablesWithWorkspaceId.includes(table));
      if (stale.length > 0) {
        throw new Error(
          stale
            .map(
              (table) =>
                `\`${table}\` is listed in WORKSPACE_SCOPED_TABLES but no longer has a ` +
                `workspace_id column in the live schema; remove it from the list (or fix the table).`
            )
            .join("\n")
        );
      }
    } finally {
      db.close();
    }
  });
});

/**
 * Behavioral tests for the cascade itself. These insert rows directly via a
 * second raw handle on the SAME on-disk file `store` already opened (see
 * `remove()`'s own doc comment for why that's safe — every `*Store` points
 * at one file) rather than going through every other domain's store class,
 * since the point here is purely "does remove() clean up every table it
 * promises to," not re-testing those other stores' own CRUD behavior.
 */
describe("WorkspaceStore.remove() cascade", () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase();
  });

  afterEach(() => {
    db.close();
  });

  const NOW = "2026-01-01T00:00:00.000Z";

  function insertBoardCard(id: string, workspaceId: string) {
    db.prepare(
      `INSERT INTO board_cards (id, workspace_id, title, priority, column_id, position, created_at, updated_at)
       VALUES (?, ?, 'a card', 'normal', 'todo', 1.0, ?, ?)`
    ).run(id, workspaceId, NOW, NOW);
  }

  function insertMission(id: string, workspaceId: string) {
    db.prepare(
      `INSERT INTO missions (id, workspace_id, prompt, status, created_at, updated_at)
       VALUES (?, ?, 'do it', 'running', ?, ?)`
    ).run(id, workspaceId, NOW, NOW);
  }

  function insertAgentProfile(id: string, workspaceId: string) {
    db.prepare(
      `INSERT INTO agent_profiles (id, workspace_id, name, system_prompt, base_agent, created_at, updated_at)
       VALUES (?, ?, 'profile', 'be helpful', 'claude', ?, ?)`
    ).run(id, workspaceId, NOW, NOW);
  }

  function insertSavedPrompt(id: string, workspaceId: string | null) {
    db.prepare(
      `INSERT INTO saved_prompts (id, workspace_id, title, body, created_at, updated_at)
       VALUES (?, ?, 'title', 'body', ?, ?)`
    ).run(id, workspaceId, NOW, NOW);
  }

  function insertCommandHistory(id: string, workspaceId: string) {
    db.prepare(
      `INSERT INTO command_history (id, workspace_id, command, created_at) VALUES (?, ?, 'ls', ?)`
    ).run(id, workspaceId, NOW);
  }

  function insertSessionRecord(id: string, workspaceId: string | null) {
    db.prepare(
      `INSERT INTO session_records (id, workspace_id, agent, cwd, title, status, started_at, created_at, updated_at)
       VALUES (?, ?, 'claude', '/tmp', 'title', 'recoverable', ?, ?, ?)`
    ).run(id, workspaceId, NOW, NOW, NOW);
  }

  function insertMissionChildren(missionId: string, suffix: string) {
    db.prepare(
      `INSERT INTO mission_agents (id, mission_id, role, label, agent, status, created_at, updated_at)
       VALUES (?, ?, 'builder', 'Builder 1', 'claude', 'idle', ?, ?)`
    ).run(`magent-${suffix}`, missionId, NOW, NOW);
    db.prepare(
      `INSERT INTO mission_messages (id, mission_id, body, created_at) VALUES (?, ?, 'hi', ?)`
    ).run(`mmsg-${suffix}`, missionId, NOW);
    db.prepare(
      `INSERT INTO file_claims (id, mission_id, path, agent_id, claimed_at, last_heartbeat_at)
       VALUES (?, ?, 'src/a.ts', 'agent-1', ?, ?)`
    ).run(`claim-${suffix}`, missionId, NOW, NOW);
    db.prepare(
      `INSERT INTO claim_conflicts (id, mission_id, path, holder_agent_id, detected_at)
       VALUES (?, ?, 'src/a.ts', 'agent-1', ?)`
    ).run(`conflict-${suffix}`, missionId, NOW);
    db.prepare(
      `INSERT INTO mission_tasks (id, mission_id, title, prompt, declared_paths, status, created_at, updated_at)
       VALUES (?, ?, 'task', 'prompt', '[]', 'pending', ?, ?)`
    ).run(`task-${suffix}`, missionId, NOW, NOW);
  }

  function countWhere(table: string, column: string, value: string): number {
    return (
      db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE ${column} = ?`).get(value) as {
        c: number;
      }
    ).c;
  }

  it("removes board_cards, missions, agent_profiles, saved_prompts, command_history and session_records scoped to the deleted workspace", () => {
    const ws = store.create({ name: "to-delete", rootPath: "/tmp/to-delete" });
    insertBoardCard("card-1", ws.id);
    insertMission("mission-1", ws.id);
    insertAgentProfile("profile-1", ws.id);
    insertSavedPrompt("prompt-1", ws.id);
    insertCommandHistory("cmd-1", ws.id);
    insertSessionRecord("session-1", ws.id);

    expect(store.remove(ws.id)).toBe(true);

    // Named explicitly rather than looped over `WORKSPACE_SCOPED_TABLES`:
    // iterating the implementation's own constant would make this test
    // blind in exactly the direction that matters — drop a table from that
    // list and the cascade stops deleting it AND this test stops checking
    // it, in lockstep, still green. (The guard test below catches that
    // particular drift, but a test should not depend on another test to
    // mean what its name says.) Verified by hand: removing
    // "command_history" from the constant leaves this assertion failing.
    for (const table of [
      "board_cards",
      "missions",
      "agent_profiles",
      "saved_prompts",
      "command_history",
      "session_records",
    ]) {
      expect(countWhere(table, "workspace_id", ws.id)).toBe(0);
    }
    expect(store.get(ws.id)).toBeUndefined();
  });

  it("removes mission children (mission_agents, mission_messages, file_claims, claim_conflicts, mission_tasks) belonging to the workspace's missions", () => {
    const ws = store.create({ name: "with-mission", rootPath: "/tmp/with-mission" });
    insertMission("mission-1", ws.id);
    insertMissionChildren("mission-1", "m1");

    expect(store.remove(ws.id)).toBe(true);

    for (const table of [
      "mission_agents",
      "mission_messages",
      "file_claims",
      "claim_conflicts",
      "mission_tasks",
    ]) {
      expect(countWhere(table, "mission_id", "mission-1")).toBe(0);
    }
  });

  it("deleting workspace A leaves workspace B's rows completely untouched", () => {
    const a = store.create({ name: "a", rootPath: "/tmp/a" });
    const b = store.create({ name: "b", rootPath: "/tmp/b" });

    insertBoardCard("card-a", a.id);
    insertBoardCard("card-b", b.id);
    insertMission("mission-a", a.id);
    insertMission("mission-b", b.id);
    insertMissionChildren("mission-a", "a");
    insertMissionChildren("mission-b", "b");
    insertAgentProfile("profile-a", a.id);
    insertAgentProfile("profile-b", b.id);
    insertSavedPrompt("prompt-a", a.id);
    insertSavedPrompt("prompt-b", b.id);
    insertCommandHistory("cmd-a", a.id);
    insertCommandHistory("cmd-b", b.id);
    insertSessionRecord("session-a", a.id);
    insertSessionRecord("session-b", b.id);

    expect(store.remove(a.id)).toBe(true);

    // A's workspace and every A-scoped row are gone.
    expect(store.get(a.id)).toBeUndefined();
    for (const table of WORKSPACE_SCOPED_TABLES) {
      expect(countWhere(table, "workspace_id", a.id)).toBe(0);
    }
    for (const table of [
      "mission_agents",
      "mission_messages",
      "file_claims",
      "claim_conflicts",
      "mission_tasks",
    ]) {
      expect(countWhere(table, "mission_id", "mission-a")).toBe(0);
    }

    // B's workspace and every B-scoped row survive, completely untouched.
    expect(store.get(b.id)).toEqual(b);
    for (const table of WORKSPACE_SCOPED_TABLES) {
      expect(countWhere(table, "workspace_id", b.id)).toBe(1);
    }
    for (const table of [
      "mission_agents",
      "mission_messages",
      "file_claims",
      "claim_conflicts",
      "mission_tasks",
    ]) {
      expect(countWhere(table, "mission_id", "mission-b")).toBe(1);
    }
  });

  it("rows with a NULL workspace_id (global saved_prompts / session_records) survive a workspace deletion", () => {
    // agent_profiles.workspace_id is NOT NULL in the live schema (migration
    // 4 in migrations.ts, confirmed against the real ~/.vibespace/vibespace.db
    // via PRAGMA table_info) — there is no "global agent profile" case to
    // test, unlike its two siblings below, which ARE genuinely nullable.
    const ws = store.create({ name: "with-globals", rootPath: "/tmp/with-globals" });
    insertSavedPrompt("prompt-global", null);
    insertSessionRecord("session-global", null);
    insertSavedPrompt("prompt-scoped", ws.id);
    insertSessionRecord("session-scoped", ws.id);

    expect(store.remove(ws.id)).toBe(true);

    const globalPrompt = db.prepare(`SELECT id FROM saved_prompts WHERE id = ?`).get("prompt-global");
    const globalSession = db
      .prepare(`SELECT id FROM session_records WHERE id = ?`)
      .get("session-global");
    expect(globalPrompt).toBeDefined();
    expect(globalSession).toBeDefined();

    // The workspace-scoped siblings, meanwhile, are gone.
    expect(db.prepare(`SELECT id FROM saved_prompts WHERE id = ?`).get("prompt-scoped")).toBeUndefined();
    expect(
      db.prepare(`SELECT id FROM session_records WHERE id = ?`).get("session-scoped")
    ).toBeUndefined();
  });

  it("remove() on an unknown id returns false and deletes nothing anywhere", () => {
    const ws = store.create({ name: "untouched", rootPath: "/tmp/untouched" });
    insertBoardCard("card-1", ws.id);
    insertMission("mission-1", ws.id);
    insertMissionChildren("mission-1", "m1");
    insertAgentProfile("profile-1", ws.id);
    insertSavedPrompt("prompt-1", ws.id);
    insertSavedPrompt("prompt-global", null);
    insertCommandHistory("cmd-1", ws.id);
    insertSessionRecord("session-1", ws.id);

    const before = [...WORKSPACE_SCOPED_TABLES].map((table) => countWhere(table, "workspace_id", ws.id));

    expect(store.remove("does-not-exist")).toBe(false);

    expect(store.get(ws.id)).toEqual(ws);
    const after = [...WORKSPACE_SCOPED_TABLES].map((table) => countWhere(table, "workspace_id", ws.id));
    expect(after).toEqual(before);
    for (const table of [
      "mission_agents",
      "mission_messages",
      "file_claims",
      "claim_conflicts",
      "mission_tasks",
    ]) {
      expect(countWhere(table, "mission_id", "mission-1")).toBe(1);
    }
    expect(db.prepare(`SELECT id FROM saved_prompts WHERE id = ?`).get("prompt-global")).toBeDefined();
  });
});
