import { describe, expect, it } from "vitest";
import {
  attachSession,
  buildTemplate,
  closePane,
  closePaneOrEmpty,
  countPanes,
  createLeaf,
  findPane,
  listPanes,
  pruneDeadSessions,
  splitPane,
  type GridNode,
  type LeafNode,
} from "./tree.js";

describe("createLeaf", () => {
  it("creates an empty leaf with a unique id", () => {
    const a = createLeaf();
    const b = createLeaf();
    expect(a.kind).toBe("leaf");
    expect(a.sessionId).toBeNull();
    expect(a.id).not.toBe(b.id);
  });

  it("can be created already attached to a session", () => {
    const leaf = createLeaf("session-123");
    expect(leaf.sessionId).toBe("session-123");
  });
});

describe("splitPane", () => {
  it("turns one leaf into two panes", () => {
    const root = createLeaf("session-a");
    const split = splitPane(root, root.id, "row");

    expect(countPanes(split)).toBe(2);
    expect(split.kind).toBe("split");
  });

  it("keeps the original leaf (with its session) as the first child, and adds an empty second child", () => {
    const root = createLeaf("session-a");
    const split = splitPane(root, root.id, "row");

    if (split.kind !== "split") throw new Error("expected a split node");
    expect(split.direction).toBe("row");
    expect(split.children[0]).toEqual(root); // original leaf preserved untouched
    const newLeaf = split.children[1];
    if (newLeaf.kind !== "leaf") throw new Error("expected the new second child to be a leaf");
    expect(newLeaf.sessionId).toBeNull();
    expect(newLeaf.id).not.toBe(root.id);
  });

  it("does not mutate the original tree", () => {
    const root = createLeaf("session-a");
    const before = JSON.parse(JSON.stringify(root)) as GridNode;

    splitPane(root, root.id, "column");

    expect(root).toEqual(before);
  });

  it("only replaces the targeted leaf, leaving sibling subtrees referentially untouched", () => {
    const leftLeaf = createLeaf("left-session");
    const rightLeaf = createLeaf("right-session");
    const root: GridNode = {
      kind: "split",
      id: "root",
      direction: "row",
      children: [leftLeaf, rightLeaf],
    };

    const result = splitPane(root, leftLeaf.id, "column");
    if (result.kind !== "split") throw new Error("expected a split node");

    // The untouched branch (right) must be the exact same object reference —
    // proof that mapLeaf doesn't rebuild parts of the tree it didn't change.
    expect(result.children[1]).toBe(rightLeaf);
    // The touched branch must be a brand new split wrapping the old leaf.
    expect(result.children[0].kind).toBe("split");
  });
});

describe("attachSession", () => {
  it("sets sessionId on the targeted empty leaf, leaving other panes untouched", () => {
    const empty1 = createLeaf(null);
    const empty2 = createLeaf(null);
    const root: GridNode = {
      kind: "split",
      id: "root",
      direction: "row",
      children: [empty1, empty2],
    };

    const result = attachSession(root, empty2.id, "session-xyz");
    if (result.kind !== "split") throw new Error("expected a split node");

    expect(result.children[0]).toBe(empty1); // untouched branch keeps its identity
    const attached = result.children[1];
    if (attached.kind !== "leaf") throw new Error("expected the attached child to still be a leaf");
    expect(attached.sessionId).toBe("session-xyz");
    expect(attached.id).toBe(empty2.id); // same pane, just now attached
  });

  it("does not mutate the original tree", () => {
    const leaf = createLeaf(null);
    const before = JSON.parse(JSON.stringify(leaf)) as GridNode;

    attachSession(leaf, leaf.id, "session-xyz");

    expect(leaf).toEqual(before);
  });
});

describe("closePaneOrEmpty", () => {
  // The regression: App.tsx's `root` is null BOTH while the layout is
  // loading and after closePane empties the tree, and it renders "Loading…"
  // for null — so closing your last pane parked the app on a spinner that
  // could never resolve. Only a reload escaped, and a reload lands on one
  // empty pane, which is what this returns.
  it("leaves one fresh EMPTY pane when the last pane is closed, never null", () => {
    const root = createLeaf("only-session");

    const result = closePaneOrEmpty(root, root.id);

    expect(result).not.toBeNull();
    expect(result.kind).toBe("leaf");
    // Empty: the closed pane's session must not be carried onto it.
    expect((result as LeafNode).sessionId).toBeNull();
    expect(result.id).not.toBe(root.id);
  });

  it("behaves exactly like closePane whenever panes remain", () => {
    const left = createLeaf("left-session");
    const right = createLeaf("right-session");
    const root: GridNode = { kind: "split", id: "root", direction: "row", children: [left, right] };

    expect(closePaneOrEmpty(root, left.id)).toEqual(closePane(root, left.id));
    expect(closePaneOrEmpty(root, left.id)).toEqual(right);
  });

  it("returns a tree with exactly one pane after the last close, so the grid can render", () => {
    const root = createLeaf(null);
    expect(countPanes(closePaneOrEmpty(root, root.id))).toBe(1);
  });
});

describe("closePane", () => {
  it("returns null when closing the last remaining pane", () => {
    const root = createLeaf("only-session");
    expect(closePane(root, root.id)).toBeNull();
  });

  it("collapses a simple 2-pane split: closing one leaf leaves just its sibling", () => {
    const left = createLeaf("left-session");
    const right = createLeaf("right-session");
    const root: GridNode = { kind: "split", id: "root", direction: "row", children: [left, right] };

    const result = closePane(root, left.id);

    expect(result).toEqual(right);
  });

  it("collapses the sibling upward at depth >= 2", () => {
    // Tree shape:
    //        root (row)
    //       /          \
    //   splitB (col)   leafC
    //   /      \
    // leafX   leafY
    //
    // Closing leafX should NOT leave an empty/dangling splitB behind — leafY
    // (its sibling) must move up to take splitB's place directly under root,
    // so root ends up as a simple 2-child split of [leafY, leafC].
    const leafX = createLeaf("session-x");
    const leafY = createLeaf("session-y");
    const leafC = createLeaf("session-c");
    const splitB: GridNode = {
      kind: "split",
      id: "splitB",
      direction: "column",
      children: [leafX, leafY],
    };
    const root: GridNode = {
      kind: "split",
      id: "root",
      direction: "row",
      children: [splitB, leafC],
    };

    const result = closePane(root, leafX.id);
    if (result === null || result.kind !== "split") {
      throw new Error("expected the root split to survive with 2 leaves");
    }

    expect(result.children).toHaveLength(2);
    expect(result.children[0]).toEqual(leafY); // leafY collapsed up, replacing splitB entirely
    expect(result.children[1]).toEqual(leafC);
    expect(countPanes(result)).toBe(2);
    expect(findPane(result, "splitB")).toBeNull(); // splitB itself is gone
  });

  it("does not mutate the original tree", () => {
    const left = createLeaf("left-session");
    const right = createLeaf("right-session");
    const root: GridNode = { kind: "split", id: "root", direction: "row", children: [left, right] };
    const before = JSON.parse(JSON.stringify(root)) as GridNode;

    closePane(root, left.id);

    expect(root).toEqual(before);
  });
});

describe("findPane", () => {
  it("finds a leaf by id anywhere in the tree, and finds split nodes by id too", () => {
    const leaf = createLeaf("deep-session");
    const known: GridNode = {
      kind: "split",
      id: "root",
      direction: "row",
      children: [
        { kind: "split", id: "mid", direction: "column", children: [leaf, createLeaf()] },
        createLeaf(),
      ],
    };

    expect(findPane(known, leaf.id)).toEqual(leaf);
    expect(findPane(known, "mid")?.kind).toBe("split");
  });

  it("returns null for an id that isn't in the tree", () => {
    const root = createLeaf();
    expect(findPane(root, "does-not-exist")).toBeNull();
  });
});

describe("listPanes / countPanes", () => {
  it("lists leaves left-to-right", () => {
    const a = createLeaf("a");
    const b = createLeaf("b");
    const c = createLeaf("c");
    const root: GridNode = {
      kind: "split",
      id: "root",
      direction: "row",
      children: [{ kind: "split", id: "mid", direction: "column", children: [a, b] }, c],
    };

    expect(listPanes(root).map((p) => p.sessionId)).toEqual(["a", "b", "c"]);
    expect(countPanes(root)).toBe(3);
  });
});

describe("buildTemplate", () => {
  it("builds exactly 16 leaves for buildTemplate(16)", () => {
    const tree = buildTemplate(16);
    expect(countPanes(tree)).toBe(16);
  });

  it("builds exactly 6 leaves for buildTemplate(6)", () => {
    const tree = buildTemplate(6);
    expect(countPanes(tree)).toBe(6);
  });

  it("builds exactly 1 leaf (a bare leaf, no split) for buildTemplate(1)", () => {
    const tree = buildTemplate(1);
    expect(tree.kind).toBe("leaf");
    expect(countPanes(tree)).toBe(1);
  });

  it("produces every leaf as an empty pane (no sessionId)", () => {
    const tree = buildTemplate(8);
    for (const pane of listPanes(tree)) {
      expect(pane.sessionId).toBeNull();
    }
  });

  it("alternates split direction between levels instead of stair-stepping one way", () => {
    const tree = buildTemplate(4);
    if (tree.kind !== "split") throw new Error("expected a split");
    expect(tree.direction).toBe("row");
    const child = tree.children[0];
    if (child.kind !== "split") throw new Error("expected nested split for n=4");
    expect(child.direction).toBe("column");
  });

  it("throws on an unsupported pane count", () => {
    expect(() => buildTemplate(3)).toThrow();
    expect(() => buildTemplate(0)).toThrow();
    expect(() => buildTemplate(15)).toThrow();
  });

  it("gives every pane a unique id, even across a 16-pane template", () => {
    const tree = buildTemplate(16);
    const ids = listPanes(tree).map((p) => p.id);
    expect(new Set(ids).size).toBe(16);
  });
});

describe("pruneDeadSessions", () => {
  it("clears a leaf's sessionId when it isn't in the live set", () => {
    const leaf = createLeaf("session-gone");
    const pruned = pruneDeadSessions(leaf, new Set());
    if (pruned.kind !== "leaf") throw new Error("expected a leaf");
    expect(pruned.sessionId).toBeNull();
  });

  it("leaves a leaf's sessionId alone when it IS in the live set", () => {
    const leaf = createLeaf("session-alive");
    const pruned = pruneDeadSessions(leaf, new Set(["session-alive"]));
    if (pruned.kind !== "leaf") throw new Error("expected a leaf");
    expect(pruned.sessionId).toBe("session-alive");
  });

  it("leaves empty leaves (no sessionId) untouched", () => {
    const leaf = createLeaf(null);
    const pruned = pruneDeadSessions(leaf, new Set());
    expect(pruned).toBe(leaf); // same reference — nothing needed pruning
  });

  it("prunes dead sessions anywhere in a nested tree, leaving live ones intact", () => {
    let root: GridNode = createLeaf("session-alive");
    root = splitPane(root, root.id, "row");
    const [aliveLeaf, emptyLeaf] = listPanes(root);
    root = attachSession(root, emptyLeaf.id, "session-dead");

    const pruned = pruneDeadSessions(root, new Set(["session-alive"]));
    const panes = listPanes(pruned);
    expect(panes.find((p) => p.id === aliveLeaf.id)?.sessionId).toBe("session-alive");
    expect(panes.find((p) => p.id === emptyLeaf.id)?.sessionId).toBeNull();
  });

  it("returns the exact same tree reference when nothing needed pruning", () => {
    const root = buildTemplate(4); // every leaf already has sessionId: null
    const pruned = pruneDeadSessions(root, new Set());
    expect(pruned).toBe(root);
  });
});
