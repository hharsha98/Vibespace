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
 * one piece of `PaneContent` — see that type's own doc comment) or a `split`
 * (two children divided either side-by-side ("row") or stacked ("column")).
 * Nesting these two node kinds is enough to represent any arrangement of
 * resizable panes.
 *
 * --- Deferred panes (session recovery, cold-start restore) ---
 * A leaf's `deferred` field is the client-side half of
 * `apps/server/src/pty/restore.ts`'s bounded-budget cold-start restore: a
 * pane whose OLD session is recoverable, but which the server's eager
 * budget (or circuit breaker) chose NOT to auto-resume right now. It keeps
 * its split position, its intended cwd/agent, and a `recordId` to act on —
 * `PaneView.tsx` renders this as a "this pane was running X — restore it?"
 * affordance instead of either the ordinary empty-pane picker or silently
 * vanishing. `attachSession`/`attachBrowser`/`clearDeferredPane` all clear
 * it once it's no longer relevant (a real session or browser attached, or
 * the record was discarded).
 */
import type { DeferredPane } from "@vibespace/shared";

/** Opaque id for a single pane (a `leaf` node). Just a UUID string. */
export type PaneId = string;

/** "row" = children sit side by side (a vertical divider). "column" = children stack (a horizontal divider). */
export type Direction = "row" | "column";

/**
 * What a single pane is showing. Originally a pane could only ever be a
 * terminal session (or nothing) — this union is what makes room for other
 * kinds without every existing "is this pane running something" check
 * having to learn a THIRD, unrelated shape. `browser` is the first addition
 * (see `apps/web/src/browser/BrowserPane.tsx`): a pane that shows a web
 * page in an `<iframe>` instead of a pty, for the "dev server open beside
 * the agent building it" workflow.
 *
 * Deliberately lives HERE, not in `packages/shared/src/protocol.ts`: a
 * workspace's saved `layout` (`Workspace.layout`) is an opaque JSON string
 * as far as the server is concerned — it never parses it, only stores and
 * returns it — so `PaneContent` is purely client-side layout state, same as
 * `GridNode`/`Direction` above. See `upgradeLegacyLayout` below for how an
 * OLDER build's saved layout (whose leaves never had a `content` field at
 * all, just a bare `sessionId`) gets read by a build that ships this type.
 */
export type PaneContent = { kind: "session"; sessionId: string } | { kind: "browser"; url: string };

export type GridNode =
  | { kind: "leaf"; id: PaneId; content: PaneContent | null; deferred?: DeferredPane | null }
  | { kind: "split"; id: string; direction: Direction; children: [GridNode, GridNode] };

/** The `leaf` branch of `GridNode` on its own — handy when a function (like
 * `createLeaf`) always returns a leaf and callers shouldn't have to narrow
 * the union themselves to reach `.content`. */
export type LeafNode = Extract<GridNode, { kind: "leaf" }>;

/**
 * The session id a leaf is showing, or `null` if it's empty, showing a
 * browser, or (defensively) anything else `PaneContent` might grow into
 * later. This is the one place the vast majority of call sites that only
 * ever cared about "which session (if any) is in this pane" — closing a
 * session, finding an empty pane to attach one to, the skill-injection
 * target list, ... — go, instead of every one of them re-deriving the same
 * `leaf.content?.kind === "session" ? leaf.content.sessionId : null` union
 * narrowing by hand. Anything that genuinely needs to tell "empty" apart
 * from "showing a browser" (both read `sessionId: null` here) should read
 * `leaf.content` directly instead — see e.g. App.tsx's
 * `startAgentInFocusedPane`, which must not silently overwrite a browser
 * pane just because it has no session.
 */
export function paneSessionId(leaf: LeafNode): string | null {
  return leaf.content?.kind === "session" ? leaf.content.sessionId : null;
}

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
  return { kind: "leaf", id: nextPaneId(), content: sessionId ? { kind: "session", sessionId } : null };
}

/**
 * Marks the leaf at `targetPaneId` as DEFERRED — cold-start restore's
 * bounded budget (or circuit breaker; see `apps/server/src/pty/
 * restore-budget.ts`) chose not to eagerly restore it. The pane keeps its
 * shape and position in the tree exactly as-is; only its `deferred` field
 * changes, which `PaneView.tsx` reads to show a "restore this pane"
 * affordance instead of the ordinary empty-pane agent picker.
 */
export function markPaneDeferred(root: GridNode, targetPaneId: PaneId, deferred: DeferredPane): GridNode {
  return mapLeaf(root, targetPaneId, (leaf) => ({ ...leaf, deferred }));
}

/**
 * Clears a pane's deferred marker WITHOUT touching its `sessionId` — used
 * when a deferred pane's underlying record is explicitly discarded (never
 * actually restored, so the pane goes back to a plain empty state). A
 * successful restore doesn't need this separately: `attachSession` below
 * already clears `deferred` itself the moment a real session lands.
 */
export function clearDeferredPane(root: GridNode, targetPaneId: PaneId): GridNode {
  return mapLeaf(root, targetPaneId, (leaf) => ({ ...leaf, deferred: null }));
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
 *
 * Also clears `deferred` (see that field's own doc comment above) — once a
 * real session is attached, whether from the ordinary picker or from
 * resuming a deferred pane's record, there's nothing left to "restore".
 */
export function attachSession(root: GridNode, targetPaneId: PaneId, sessionId: string): GridNode {
  return mapLeaf(root, targetPaneId, (leaf) => ({
    ...leaf,
    content: { kind: "session", sessionId },
    deferred: null,
  }));
}

/**
 * The browser-pane counterpart to `attachSession` above: points the leaf at
 * `targetPaneId` at a web page instead of a terminal session. `url` may be
 * `""` — that's what the empty-pane picker's "Open a browser" button
 * attaches immediately, before anyone has typed a URL; `BrowserPane.tsx`
 * reads an empty `url` as "show my own empty state, not an iframe" (see
 * that component's own top comment). A real navigation later calls this
 * again with the real, validated URL (`browser/url.ts`'s
 * `normalizeAndValidateUrl`) to update it in place.
 *
 * Also clears `deferred`, same reasoning as `attachSession`: whichever kind
 * of content just filled this pane, there's nothing left to offer restoring.
 */
export function attachBrowser(root: GridNode, targetPaneId: PaneId, url: string): GridNode {
  return mapLeaf(root, targetPaneId, (leaf) => ({
    ...leaf,
    content: { kind: "browser", url },
    deferred: null,
  }));
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

/**
 * `closePane`, but never returns null — closing the last pane leaves one
 * fresh empty pane instead of an empty tree.
 *
 * This exists because "no grid left" and "no grid YET" are the same value
 * (`null`) in `App.tsx`, whose `root` state starts null while the layout
 * loads and renders "Loading…" for it. Closing your last pane fed a
 * legitimate null into that state and parked the entire app on a spinner
 * that could never resolve, since nothing was actually loading — only a
 * page reload escaped, and a reload lands on exactly this: one empty
 * pane, ready for an agent.
 *
 * `closePane` keeps returning null on purpose: as a pure tree operation,
 * "the tree is now empty" is the truthful answer, and a caller that needs
 * to distinguish that case can still ask. This wrapper is where the UI's
 * policy about it lives, so that policy can be tested — `App.tsx` cannot
 * be, as this package has no jsdom.
 */
export function closePaneOrEmpty(root: GridNode, targetPaneId: PaneId): GridNode {
  return closeWithin(root, targetPaneId) ?? createLeaf();
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

/**
 * Every leaf pane, left-to-right (i.e. in the order they'd read on screen).
 *
 * Returns both `sessionId` (via `paneSessionId` above) AND the raw
 * `content` for each pane, rather than picking just one: nearly every
 * existing caller (App.tsx's block-navigation, skill-injection targets,
 * "does this workspace have anything running to warn about discarding",
 * ...) only ever cared about sessions, so keeping `sessionId` here is what
 * lets all of THOSE call sites stay exactly as they were — no destructuring
 * a union at every site that never needed to know about browsers at all.
 * But a couple of callers (App.tsx's `handleSessionDispatched` /
 * `focusSessionInGrid`, both of which need to find a genuinely EMPTY pane
 * to attach a new session to) would otherwise misread a browser pane as
 * "empty" — `sessionId` is `null` for a browser pane too, same as a truly
 * empty one — and silently clobber it. Those two read `content === null`
 * instead, which `listPanes` only needs to expose once, here, rather than
 * having every such caller re-walk the tree with `findPane` itself.
 */
export function listPanes(
  root: GridNode
): Array<{ id: PaneId; sessionId: string | null; content: PaneContent | null }> {
  if (root.kind === "leaf") return [{ id: root.id, sessionId: paneSessionId(root), content: root.content }];
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

/**
 * Walks a tree loaded from a workspace's saved `layout` JSON and nulls out
 * any leaf's `sessionId` that isn't in `liveSessionIds`. This is what makes
 * restoring a workspace honest: a saved layout only ever remembers pane
 * *shape*, never guarantees the pty that used to fill a pane still exists
 * (it doesn't, across a server restart) — so any reference to a session
 * that isn't actually running right now gets cleared back to an empty
 * pane rather than the UI pretending it's still there.
 *
 * If the referenced session IS still running (e.g. switching back to a
 * workspace within the same still-up server, not after a restart), its id
 * is left alone and the pane reattaches normally.
 */
export function pruneDeadSessions(root: GridNode, liveSessionIds: ReadonlySet<string>): GridNode {
  if (root.kind === "leaf") {
    const sessionId = paneSessionId(root);
    if (sessionId && !liveSessionIds.has(sessionId)) {
      return { ...root, content: null };
    }
    return root;
  }
  const newLeft = pruneDeadSessions(root.children[0], liveSessionIds);
  const newRight = pruneDeadSessions(root.children[1], liveSessionIds);
  if (newLeft === root.children[0] && newRight === root.children[1]) {
    return root; // Nothing under this node needed pruning — hand back the same object.
  }
  return { ...root, children: [newLeft, newRight] };
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

/**
 * Upgrades a `GridNode` tree that may have been parsed from a saved layout
 * written by an OLDER build of vibespace — one from before `PaneContent`
 * existed, when a leaf's shape was `{ kind: "leaf", id, sessionId, deferred?
 * }` instead of today's `{ kind: "leaf", id, content, deferred? }`. Every
 * layout already saved on disk (`Workspace.layout`, an opaque JSON string
 * the server never parses — see `PaneContent`'s own doc comment) has the OLD
 * shape, and a person's saved grid is not something a version bump gets to
 * throw away. This is App.tsx's `layoutToTree` (its only caller) doing that
 * upgrade tolerantly, in place, the moment a layout is loaded — the same
 * "read an older build's blob defensively, field by field" posture
 * `settings/terminalPrefs.ts`'s `parseStoredPrefs` already uses for a
 * different persisted blob, applied here to a tree instead of a flat object.
 *
 * Deliberately does NOT touch the database: there is nothing FOR a
 * migration to touch (the column is opaque JSON, not a parsed schema), so
 * "upgrade on read" is not a shortcut around a migration, it is the only
 * place this can honestly happen at all.
 *
 * A leaf already in the new shape (has a `content` field, even if that
 * field is something a FUTURE build added that this one doesn't recognise)
 * passes through with its `content` preserved as-is, not re-derived — this
 * is what makes a mixed tree safe, where some leaves are old-shape and
 * others already new-shape (which can't happen from a single save today,
 * but is the honest, defensive assumption to make about a hand-edited or
 * partially-migrated blob rather than an assumption this code happens to
 * currently get away with).
 *
 * Throws on a node that isn't shaped like a `GridNode` at all (missing
 * `kind`, a split without exactly two children, ...) — `layoutToTree`'s own
 * `try`/`catch` around the whole parse-and-upgrade already treats "this
 * JSON wasn't a valid layout" as "start with one empty pane instead" (the
 * same fallback `pruneDeadSessions` relied on being wrapped in before this
 * function existed), so there is no need for a second copy of that
 * fallback here.
 */
export function upgradeLegacyLayout(node: unknown): GridNode {
  if (node === null || typeof node !== "object") {
    throw new Error("upgradeLegacyLayout: expected an object");
  }
  const candidate = node as Record<string, unknown>;

  if (candidate.kind === "leaf") {
    return upgradeLegacyLeaf(candidate);
  }

  if (candidate.kind === "split") {
    if (typeof candidate.id !== "string") {
      throw new Error("upgradeLegacyLayout: split node missing its id");
    }
    if (candidate.direction !== "row" && candidate.direction !== "column") {
      throw new Error("upgradeLegacyLayout: split node has an invalid direction");
    }
    const children = candidate.children;
    if (!Array.isArray(children) || children.length !== 2) {
      throw new Error("upgradeLegacyLayout: split node must have exactly two children");
    }
    return {
      kind: "split",
      id: candidate.id,
      direction: candidate.direction,
      children: [upgradeLegacyLayout(children[0]), upgradeLegacyLayout(children[1])],
    };
  }

  throw new Error(`upgradeLegacyLayout: unrecognised node kind ${JSON.stringify(candidate.kind)}`);
}

function upgradeLegacyLeaf(candidate: Record<string, unknown>): LeafNode {
  if (typeof candidate.id !== "string") {
    throw new Error("upgradeLegacyLayout: leaf missing its id");
  }
  // `deferred` never changed shape across this migration — carried through
  // as-is either way (it's already optional/nullable on both old and new
  // leaves, so there's nothing to upgrade about it).
  const deferred = (candidate.deferred ?? null) as DeferredPane | null;

  // Already the new shape: pass `content` through untouched (see this
  // function's own top comment for why that's deliberate) rather than
  // re-deriving it from a `sessionId` field a new-shape leaf may not even
  // carry.
  if ("content" in candidate) {
    return {
      kind: "leaf",
      id: candidate.id,
      content: (candidate.content ?? null) as PaneContent | null,
      deferred,
    };
  }

  // Old shape: a bare `sessionId` field, no `content` at all. `sessionId:
  // "abc"` becomes `content: {kind:"session", sessionId:"abc"}`;
  // `sessionId: null` (or missing entirely) becomes `content: null`.
  const sessionId = candidate.sessionId;
  const content: PaneContent | null = typeof sessionId === "string" ? { kind: "session", sessionId } : null;
  return { kind: "leaf", id: candidate.id, content, deferred };
}
