/**
 * CRUD + ordering tests for BoardStore, run against a real SQLite file —
 * always inside a fresh `mkdtempSync` temp directory, same pattern as
 * `workspaces.test.ts`. `VIBESPACE_DATA_DIR` is what `schema.ts`'s
 * `getDataDir()` reads, so setting it before each `new BoardStore()` is
 * what redirects every test here away from a developer's real `~/.vibespace`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./board.js";

let dataDir: string;
let store: BoardStore;

const WORKSPACE_A = "workspace-a";
const WORKSPACE_B = "workspace-b";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vibespace-board-test-"));
  process.env.VIBESPACE_DATA_DIR = dataDir;
  store = new BoardStore();
});

afterEach(() => {
  store.close();
  delete process.env.VIBESPACE_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("BoardStore CRUD", () => {
  it("starts empty for any workspace", () => {
    expect(store.list(WORKSPACE_A)).toEqual([]);
  });

  it("creates a card with defaults (todo column, medium priority), a generated id, and matching timestamps", () => {
    const card = store.create({ workspaceId: WORKSPACE_A, title: "Fix the thing" });

    expect(card.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(card.title).toBe("Fix the thing");
    expect(card.description).toBeNull();
    expect(card.priority).toBe("medium");
    expect(card.columnId).toBe("todo");
    expect(card.sessionId).toBeNull();
    expect(card.agent).toBeNull();
    expect(card.createdAt).toBe(card.updatedAt);
    expect(Number.isNaN(new Date(card.createdAt).getTime())).toBe(false);
  });

  it("creates a card with explicit description, priority, and column", () => {
    const card = store.create({
      workspaceId: WORKSPACE_A,
      title: "Ship it",
      description: "Get this into prod",
      priority: "critical",
      columnId: "in_review",
    });

    expect(card.description).toBe("Get this into prod");
    expect(card.priority).toBe("critical");
    expect(card.columnId).toBe("in_review");
  });

  it("creates a card with taskKnowledge, defaulting to null when omitted", () => {
    const withKnowledge = store.create({
      workspaceId: WORKSPACE_A,
      title: "Has context",
      taskKnowledge: "The parser lives in src/parser.ts; see ADR-3 for why it's recursive.",
    });
    expect(withKnowledge.taskKnowledge).toBe(
      "The parser lives in src/parser.ts; see ADR-3 for why it's recursive."
    );

    const withoutKnowledge = store.create({ workspaceId: WORKSPACE_A, title: "No context yet" });
    expect(withoutKnowledge.taskKnowledge).toBeNull();
  });

  it("get() returns undefined for an unknown id", () => {
    expect(store.get("does-not-exist")).toBeUndefined();
  });

  it("get() returns the card for a known id", () => {
    const created = store.create({ workspaceId: WORKSPACE_A, title: "Findable" });
    expect(store.get(created.id)).toEqual(created);
  });

  it("update() changes fields and bumps updatedAt, leaves createdAt alone", async () => {
    const created = store.create({ workspaceId: WORKSPACE_A, title: "Old title" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = store.update(created.id, { title: "New title", priority: "high" });

    expect(updated?.title).toBe("New title");
    expect(updated?.priority).toBe("high");
    expect(updated?.createdAt).toBe(created.createdAt);
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThan(new Date(created.createdAt).getTime());
  });

  it("update() can explicitly clear description back to null", () => {
    const created = store.create({ workspaceId: WORKSPACE_A, title: "Has a description", description: "hi" });
    const cleared = store.update(created.id, { description: null });
    expect(cleared?.description).toBeNull();
  });

  it("update() can set and explicitly clear taskKnowledge, independently of description", () => {
    const created = store.create({ workspaceId: WORKSPACE_A, title: "Learn me" });
    expect(created.taskKnowledge).toBeNull();

    const withKnowledge = store.update(created.id, { taskKnowledge: "Auth lives in src/auth/*.ts." });
    expect(withKnowledge?.taskKnowledge).toBe("Auth lives in src/auth/*.ts.");
    expect(withKnowledge?.description).toBeNull(); // untouched by the taskKnowledge-only patch

    const cleared = store.update(created.id, { taskKnowledge: null });
    expect(cleared?.taskKnowledge).toBeNull();
  });

  it("update() omitting a field entirely leaves it untouched", () => {
    const created = store.create({ workspaceId: WORKSPACE_A, title: "Untouched", description: "keep me" });
    const updated = store.update(created.id, { priority: "low" });
    expect(updated?.description).toBe("keep me");
    expect(updated?.title).toBe("Untouched");
  });

  it("update() can set sessionId and agent (dispatch bookkeeping)", () => {
    const created = store.create({ workspaceId: WORKSPACE_A, title: "Dispatch me" });
    const updated = store.update(created.id, { sessionId: "session-123", agent: "shell" });
    expect(updated?.sessionId).toBe("session-123");
    expect(updated?.agent).toBe("shell");
  });

  it("update() returns undefined for an unknown id", () => {
    expect(store.update("does-not-exist", { title: "nope" })).toBeUndefined();
  });

  it("remove() deletes a card and returns true", () => {
    const created = store.create({ workspaceId: WORKSPACE_A, title: "To delete" });
    expect(store.remove(created.id)).toBe(true);
    expect(store.get(created.id)).toBeUndefined();
  });

  it("remove() returns false for an unknown id", () => {
    expect(store.remove("does-not-exist")).toBe(false);
  });
});

describe("BoardStore ordering", () => {
  it("orders cards within a column by creation order (ascending position)", () => {
    const a = store.create({ workspaceId: WORKSPACE_A, title: "First" });
    const b = store.create({ workspaceId: WORKSPACE_A, title: "Second" });
    const c = store.create({ workspaceId: WORKSPACE_A, title: "Third" });

    const todo = store.list(WORKSPACE_A).filter((card) => card.columnId === "todo");
    expect(todo.map((card) => card.id)).toEqual([a.id, b.id, c.id]);
    expect(todo[0].position).toBeLessThan(todo[1].position);
    expect(todo[1].position).toBeLessThan(todo[2].position);
  });

  it("move() to a different column changes columnId and places the card where the given position puts it", () => {
    const inProgressCard = store.create({ workspaceId: WORKSPACE_A, title: "Already in progress", columnId: "in_progress" });
    const card = store.create({ workspaceId: WORKSPACE_A, title: "Move me", columnId: "todo" });

    const moved = store.move(card.id, "in_progress", inProgressCard.position + 1000);
    expect(moved?.columnId).toBe("in_progress");

    const inProgress = store.list(WORKSPACE_A).filter((c) => c.columnId === "in_progress");
    expect(inProgress.map((c) => c.id)).toEqual([inProgressCard.id, card.id]);
  });

  it("update() moving columns without an explicit position appends to the end of the new column", () => {
    const first = store.create({ workspaceId: WORKSPACE_A, title: "First in review", columnId: "in_review" });
    const card = store.create({ workspaceId: WORKSPACE_A, title: "Todo card", columnId: "todo" });

    const updated = store.update(card.id, { columnId: "in_review" });
    expect(updated?.columnId).toBe("in_review");
    expect(updated!.position).toBeGreaterThan(first.position);

    const review = store.list(WORKSPACE_A).filter((c) => c.columnId === "in_review");
    expect(review.map((c) => c.id)).toEqual([first.id, card.id]);
  });

  it("fractional insert: a card dropped between two neighbours lands between them in list order", () => {
    const a = store.create({ workspaceId: WORKSPACE_A, title: "A" }); // position 1000
    const b = store.create({ workspaceId: WORKSPACE_A, title: "B" }); // position 2000
    const c = store.create({ workspaceId: WORKSPACE_A, title: "C" }); // position 3000, will be moved

    const midpoint = (a.position + b.position) / 2;
    store.move(c.id, "todo", midpoint);

    const todo = store.list(WORKSPACE_A).filter((card) => card.columnId === "todo");
    expect(todo.map((card) => card.id)).toEqual([a.id, c.id, b.id]);
  });

  it("renormalises a column when a gap collapses below the minimum, preserving order", () => {
    const a = store.create({ workspaceId: WORKSPACE_A, title: "A" });
    const b = store.create({ workspaceId: WORKSPACE_A, title: "B" });

    // Force B's position to collide-adjacent with A's — closer than the
    // store's MIN_GAP (1e-6) — simulating many repeated bisections into the
    // same gap without actually looping 30+ times in this test.
    store.update(b.id, { position: a.position + 1e-9 });

    const afterTinyGapWrite = store.list(WORKSPACE_A).filter((c) => c.columnId === "todo");
    // The tiny-gap write itself triggers the renormalize guard (update()
    // checks after any position change), so by now the column should
    // already be back to widely-spaced positions.
    const gap = afterTinyGapWrite[1].position - afterTinyGapWrite[0].position;
    expect(gap).toBeGreaterThan(1); // no longer 1e-9 — renormalized back out
    expect(afterTinyGapWrite.map((c) => c.id)).toEqual([a.id, b.id]); // order preserved

    // A fresh insert between them should still bisect cleanly afterwards.
    const c = store.create({ workspaceId: WORKSPACE_A, title: "C" });
    const midpoint = (afterTinyGapWrite[0].position + afterTinyGapWrite[1].position) / 2;
    store.move(c.id, "todo", midpoint);
    const after = store.list(WORKSPACE_A).filter((card) => card.columnId === "todo");
    expect(after.map((card) => card.id)).toEqual([a.id, c.id, b.id]);
  });
});

describe("BoardStore workspace scoping", () => {
  it("list() never returns another workspace's cards", () => {
    store.create({ workspaceId: WORKSPACE_A, title: "Belongs to A" });
    store.create({ workspaceId: WORKSPACE_B, title: "Belongs to B" });

    const a = store.list(WORKSPACE_A);
    const b = store.list(WORKSPACE_B);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].title).toBe("Belongs to A");
    expect(b[0].title).toBe("Belongs to B");
  });

  it("cards in different workspaces get independent position sequences", () => {
    const a1 = store.create({ workspaceId: WORKSPACE_A, title: "A1" });
    const b1 = store.create({ workspaceId: WORKSPACE_B, title: "B1" });
    // Both are the first card in their own workspace's todo column, so both
    // should get the same starting position — proving the MAX(position)
    // lookup is scoped by workspace, not global.
    expect(a1.position).toBe(b1.position);
  });
});
