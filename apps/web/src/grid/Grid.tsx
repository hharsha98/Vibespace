import { Allotment } from "allotment";
import "allotment/dist/style.css";
import type { AgentId, SessionInfo } from "@vibedeck/shared";
import PaneView, { type AgentOption } from "./PaneView.js";
import type { Direction, GridNode, PaneId } from "./tree.js";

interface GridProps {
  root: GridNode;
  sessions: SessionInfo[];
  agents: AgentOption[];
  defaultAgent: AgentId | "";
  focusedPaneId: PaneId | null;
  onFocus: (paneId: PaneId) => void;
  onSessionStarted: (paneId: PaneId, session: SessionInfo) => void;
  onSplit: (paneId: PaneId, direction: Direction) => void;
  onClosePane: (paneId: PaneId) => void;
}

/**
 * Renders a `GridNode` tree. A `leaf` becomes a `PaneView`; a `split`
 * becomes an `<Allotment>` (a resizable two-pane split from the `allotment`
 * library) containing the two recursively-rendered children. `allotment`
 * gives us draggable resize dividers for free — we don't implement any
 * resize logic ourselves here.
 */
export default function Grid(props: GridProps) {
  return <GridNodeView node={props.root} {...props} />;
}

function GridNodeView({ node, ...rest }: GridProps & { node: GridNode }) {
  const { sessions, agents, defaultAgent, focusedPaneId, onFocus, onSessionStarted, onSplit, onClosePane } =
    rest;

  if (node.kind === "leaf") {
    const session = node.sessionId ? (sessions.find((s) => s.id === node.sessionId) ?? null) : null;
    return (
      <PaneView
        paneId={node.id}
        sessionId={node.sessionId}
        session={session}
        agents={agents}
        defaultAgent={defaultAgent}
        isFocused={focusedPaneId === node.id}
        onFocus={() => onFocus(node.id)}
        onSessionStarted={onSessionStarted}
        onSplit={onSplit}
        onClosePane={onClosePane}
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
