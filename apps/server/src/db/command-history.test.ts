/**
 * CRUD + dedupe/prune tests for CommandHistoryStore, run against a real
 * SQLite file — always inside a fresh `mkdtempSync` temp directory, same
 * pattern as `board.test.ts`/`workspaces.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandHistoryStore, MAX_ENTRIES_PER_WORKSPACE } from "./command-history.js";

let dataDir: string;
let store: CommandHistoryStore;

const WORKSPACE_A = "workspace-a";
const WORKSPACE_B = "workspace-b";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibedeck-command-history-test-"));
  process.env.VIBEDECK_DATA_DIR = dataDir;
  store = new CommandHistoryStore();
});

afterEach(() => {
  store.close();
  delete process.env.VIBEDECK_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("CommandHistoryStore", () => {
  it("starts empty for any workspace", () => {
    expect(store.list(WORKSPACE_A)).toEqual([]);
  });

  it("records a command and lists it back", () => {
    store.record(WORKSPACE_A, "git status");
    expect(store.list(WORKSPACE_A)).toEqual(["git status"]);
  });

  it("lists newest-first", () => {
    store.record(WORKSPACE_A, "first");
    store.record(WORKSPACE_A, "second");
    store.record(WORKSPACE_A, "third");
    expect(store.list(WORKSPACE_A)).toEqual(["third", "second", "first"]);
  });

  it("recording the same command again dedupes instead of appending a duplicate, and moves it to the front", () => {
    store.record(WORKSPACE_A, "git status");
    store.record(WORKSPACE_A, "ls");
    store.record(WORKSPACE_A, "git status"); // re-run the first command

    const history = store.list(WORKSPACE_A);
    expect(history).toHaveLength(2);
    expect(history).toEqual(["git status", "ls"]);
  });

  it("keeps each workspace's history independent", () => {
    store.record(WORKSPACE_A, "only in A");
    store.record(WORKSPACE_B, "only in B");

    expect(store.list(WORKSPACE_A)).toEqual(["only in A"]);
    expect(store.list(WORKSPACE_B)).toEqual(["only in B"]);
  });

  it("ignores an empty command", () => {
    store.record(WORKSPACE_A, "");
    expect(store.list(WORKSPACE_A)).toEqual([]);
  });

  it("prunes down to MAX_ENTRIES_PER_WORKSPACE, dropping the OLDEST entries first", () => {
    const overflow = 5;
    for (let i = 0; i < MAX_ENTRIES_PER_WORKSPACE + overflow; i++) {
      store.record(WORKSPACE_A, `command-${i}`);
    }

    const history = store.list(WORKSPACE_A);
    expect(history).toHaveLength(MAX_ENTRIES_PER_WORKSPACE);
    // The newest entry recorded is still present...
    expect(history[0]).toBe(`command-${MAX_ENTRIES_PER_WORKSPACE + overflow - 1}`);
    // ...and the very first ones recorded (now the oldest) were pruned away.
    expect(history).not.toContain("command-0");
    expect(history).not.toContain(`command-${overflow - 1}`);
  });

  it("pruning one workspace never touches another workspace's history", () => {
    for (let i = 0; i < MAX_ENTRIES_PER_WORKSPACE + 5; i++) {
      store.record(WORKSPACE_A, `command-${i}`);
    }
    store.record(WORKSPACE_B, "unrelated");

    expect(store.list(WORKSPACE_B)).toEqual(["unrelated"]);
  });
});
