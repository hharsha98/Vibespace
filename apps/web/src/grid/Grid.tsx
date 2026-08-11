import { Allotment } from "allotment";
import "allotment/dist/style.css";
import type { AgentId, SessionInfo } from "@vibedeck/shared";
import PaneView, { type AgentOption } from "./PaneView.js";
import type { Theme } from "../themes/themes.js";
import { findPane, type Direction, type GridNode, type PaneId } from "./tree.js";

interface GridProps {
  root: GridNode;
  sessions: SessionInfo[];
  agents: AgentOption[];
  defaultAgent: AgentId | "";
  workspaceId: string | null;
  /** The active theme, threaded down to every pane's `<Terminal>`. */
  theme: Theme;
  focusedPaneId: PaneId | null;
  onFocus: (paneId: PaneId) => void;
  onSessionStarted: (paneId: PaneId, session: SessionInfo) => void;
  onSplit: (paneId: PaneId, direction: Direction) => void;
  onClosePane: (paneId: PaneId) => void;
  /** The pane currently filling the whole grid (docs/DESIGN.md §5
   * "maximise"), or null if none is. When set, Grid renders ONLY that one
   * leaf — see the top-level comment below for why that's safe. */
  maximizedPaneId: PaneId | null;
  onToggleMaximize: (paneId: PaneId) => void;
}

/**
 * Renders a `GridNode` tree. A `leaf` becomes a `PaneView`; a `split`
 * becomes an `<Allotment>` (a resizable two-pane split from the `allotment`
 * library) containing the two recursively-rendered children. `allotment`
 * gives us draggable resize dividers for free — we don't implement any
 * resize logic ourselves here.
 *
 * --- Maximize ---
 * When `maximizedPaneId` is set, Grid skips the tree/Allotment entirely and
 * renders just that one pane, full size. That DOES unmount every other
 * pane's `<Terminal>` (and therefore drops its xterm.js scrollback + closes
 * its WebSocket) — deliberately: the pty itself keeps running server-side
 * regardless (see Terminal.tsx's own top comment), and reattaching replays
 * the scrollback from the server's ring buffer, so nothing is actually
 * lost. This is the exact same trick App.tsx already uses for workspace
 * switches and template swaps (bumping `gridEpoch` to force a remount) —
 * maximize just does it for one pane instead of the whole grid, and
 * without needing a second live copy of the same session's terminal (which
 * would mean two competing WebSocket connections to one pty).
 */
export default function Grid(props: GridProps) {
  const { root, maximizedPaneId } = props;
  if (maximizedPaneId) {
    const leaf = findPane(root, maximizedPaneId);
    if (leaf && leaf.kind === "leaf") {
      return <GridNodeView node={leaf} {...props} />;
    }
    // The maximized pane no longer exists (e.g. it was closed some other
    // way) — fall through to the normal tree rather than showing nothing.
  }
  return <GridNodeView node={props.root} {...props} />;
}

function GridNodeView({ node, ...rest }: GridProps & { node: GridNode }) {
  const {
    sessions,
    agents,
    defaultAgent,
    workspaceId,
    theme,
    focusedPaneId,
    onFocus,
    onSessionStarted,
    onSplit,
    onClosePane,
    maximizedPaneId,
    onToggleMaximize,
  } = rest;

  if (node.kind === "leaf") {
    const session = node.sessionId ? (sessions.find((s) => s.id === node.sessionId) ?? null) : null;
    return (
      <PaneView
        paneId={node.id}
        sessionId={node.sessionId}
        session={session}
        agents={agents}
        defaultAgent={defaultAgent}
        workspaceId={workspaceId}
        theme={theme}
        isFocused={focusedPaneId === node.id}
        onFocus={() => onFocus(node.id)}
        onSessionStarted={onSessionStarted}
        onSplit={onSplit}
        onClosePane={onClosePane}
        isMaximized={maximizedPaneId === node.id}
        onToggleMaximize={onToggleMaximize}
      />
    );
  }

  return (
    <Allotment vertical={node.direction === "column"}>
      <GridNodeView node={node.children[0]} {...rest} />
      <GridNodeView node={node.children[1]} {...rest} />
    </Allotment>
  );
}
