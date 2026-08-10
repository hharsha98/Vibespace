/**
 * Pure split-tree logic for the pane grid.
 *
 * This file deliberately has ZERO React and ZERO DOM in it: every function
 * here is a plain data transform (tree in, tree out) that never mutates its
 * input. That's what lets `tree.test.ts` exercise all the tricky tree-surgery
 * cases (splitting, closing, collapsing) with plain `expect()` calls and no
 * rendering, and it's what lets React's state updates ("setRoot(newTree)")
 * work correctly — React compares the *old* tree object to the *new* one to
 * decide what changed, which only works if we never mutate the old one.
 *
 * The tree shape: a `GridNode` is either a `leaf` (one pane, holding at most
 * one terminal session) or a `split` (two children divided either
 * side-by-side ("row") or stacked ("column")). Nesting these two node kinds
 * is enough to represent any arrangement of resizable panes.
 */

/** Opaque id for a single pane (a `leaf` node). Just a UUID string. */
export type PaneId = string;

/** "row" = children sit side by side (a vertical divider). "column" = children stack (a horizontal divider). */
export type Direction = "row" | "column";

export type GridNode =
  | { kind: "leaf"; id: PaneId; sessionId: string | null }
  | { kind: "split"; id: string; direction: Direction; children: [GridNode, GridNode] };

/** The `leaf` branch of `GridNode` on its own — handy when a function (like
 * `createLeaf`) always returns a leaf and callers shouldn't have to narrow
 * the union themselves to reach `.sessionId`. */
export type LeafNode = Extract<GridNode, { kind: "leaf" }>;

/** Every pane count the template picker supports. Anything else is rejected. */
const SUPPORTED_TEMPLATE_SIZES = [1, 2, 4, 6, 8, 10, 12, 14, 16];

/** Generate a fresh id for a new node. `crypto.randomUUID()` is a Web/Node
 * standard API available globally in both the browser (where this UI runs)
 * and in Node 19+ (where the vitest tests run) — no import needed. */
export function nextPaneId(): string {
  return crypto.randomUUID();
}

/** A brand-new empty pane, optionally already attached to a session. */
export function createLeaf(sessionId: string | null = null): LeafNode {
  return { kind: "leaf", id: nextPaneId(), sessionId };
}

/**
 * Walks the tree and, for the leaf whose id matches `targetPaneId`, replaces
 * it with whatever `transform` returns. Every node on the path from the root
 * down to that leaf is rebuilt (new object); every node NOT on that path is
 * returned as the exact same reference it was passed in as. That's what
 * makes this "immutable": the original tree you passed in is never touched,
 * and unrelated branches don't even get new object identities (helpful if
 * anything upstream ever does a reference-equality check to skip re-render).
 */
function mapLeaf(
  node: GridNode,
  targetPaneId: PaneId,
  transform: (leaf: GridNode) => GridNode
): GridNode {
  if (node.kind === "leaf") {
    return node.id === targetPaneId ? transform(node) : node;
  }
  const newLeft = mapLeaf(node.children[0], targetPaneId, transform);
  const newRight = mapLeaf(node.children[1], targetPaneId, transform);
  if (newLeft === node.children[0] && newRight === node.children[1]) {
    return node; // Target wasn't in this subtree at all — hand back the same object.
  }
  return { ...node, children: [newLeft, newRight] };
}

/**
 * Splits one pane into two: the leaf at `targetPaneId` is replaced by a new
 * `split` node whose first child is the *original* leaf (so its running
 * session, if any, stays put) and whose second child is a brand-new empty
 * leaf ready for the user to start something in.
 */
export function splitPane(root: GridNode, targetPaneId: PaneId, direction: Direction): GridNode {
  return mapLeaf(root, targetPaneId, (leaf) => ({
    kind: "split",
    id: nextPaneId(),
    direction,
    children: [leaf, createLeaf(null)],
  }));
}

/**
 * Points the leaf at `targetPaneId` at a session. Used both when a
 * `POST /api/sessions` call resolves for a pane the user just started an
 * agent in, and when the app boots up and needs to fold sessions that were
 * already running on the server (e.g. before a page refresh) back into the
 * tree it builds fresh on load.
 */
export function attachSession(root: GridNode, targetPaneId: PaneId, sessionId: string): GridNode {
  return mapLeaf(root, targetPaneId, (leaf) => ({ ...leaf, sessionId }));
}

/**
 * Removes the leaf at `targetPaneId`. The subtle part: when a leaf is
 * removed, its *sibling* (the other child of its parent `split`) moves up to
 * take the parent split's own place in the tree — the split node itself
 * disappears. This is what makes closing a pane in a 2x2 grid collapse that
 * quadrant's divider away cleanly instead of leaving a dangling empty split.
 *
 * Returns `null` if `targetPaneId` was the very last pane (the whole tree),
 * signalling "there is no grid left" to the caller.
 */
export function closePane(root: GridNode, targetPaneId: PaneId): GridNode | null {
  return closeWithin(root, targetPaneId);
}

function closeWithin(node: GridNode, targetPaneId: PaneId): GridNode | null {
  if (node.kind === "leaf") {
    return node.id === targetPaneId ? null : node;
  }

  const [left, right] = node.children;

  const newLeft = closeWithin(left, targetPaneId);
  if (newLeft !== left) {
    // The target lived somewhere in the left subtree. If it collapsed all
    // the way to nothing (newLeft === null), `right` takes this split's
    // place — that's the "sibling moves up" collapse. Otherwise the left
    // subtree just changed shape internally; keep this split, with the
    // updated left child.
    return newLeft === null ? right : { ...node, children: [newLeft, right] };
  }

  const newRight = closeWithin(right, targetPaneId);
  if (newRight !== right) {
    return newRight === null ? left : { ...node, children: [left, newRight] };
  }

  return node; // Target isn't anywhere under this node.
}

/** Finds the node (leaf or split) with the given id, or null if it's not in the tree. */
export function findPane(root: GridNode, paneId: PaneId): GridNode | null {
  if (root.id === paneId) return root;
  if (root.kind === "leaf") return null;
  return findPane(root.children[0], paneId) ?? findPane(root.children[1], paneId);
}

/** Every leaf pane, left-to-right (i.e. in the order they'd read on screen). */
export function listPanes(root: GridNode): Array<{ id: PaneId; sessionId: string | null }> {
  if (root.kind === "leaf") return [{ id: root.id, sessionId: root.sessionId }];
  return [...listPanes(root.children[0]), ...listPanes(root.children[1])];
}

/** How many leaf panes are currently in the tree. */
export function countPanes(root: GridNode): number {
  return listPanes(root).length;
}

/**
 * Builds a balanced tree of exactly `n` empty leaves, for the template
 * picker ("start me a fresh 2x4 grid"). Splits roughly in half at each
 * level and alternates row/column direction as it recurses, which is what
 * turns a lopsided "staircase" of splits into something that actually reads
 * as a grid on screen (e.g. for n=4: one row split at the top, then each
 * half split again as a column).
 */
export function buildTemplate(n: number): GridNode {
  if (!SUPPORTED_TEMPLATE_SIZES.includes(n)) {
    throw new Error(
      `buildTemplate: unsupported pane count ${n}. Supported sizes: ${SUPPORTED_TEMPLATE_SIZES.join(", ")}`
    );
  }
  return buildBalanced(n, "row");
}

function buildBalanced(n: number, direction: Direction): GridNode {
  if (n === 1) return createLeaf(null);

  const leftCount = Math.ceil(n / 2);
  const rightCount = n - leftCount;
  // Flip direction each level: a "row" split's children get split as
  // "column"s and vice versa, so a 4-pane template looks like a 2x2 grid
  // instead of four panes stacked/side-by-side in a single line.
  const childDirection: Direction = direction === "row" ? "column" : "row";

  return {
    kind: "split",
    id: nextPaneId(),
    direction,
    children: [buildBalanced(leftCount, childDirection), buildBalanced(rightCount, childDirection)],
  };
}
