/**
 * The Phase 9b mission canvas (docs/DESIGN.md §5 "Canvas") — a dotted grid
 * over `--bg`, agent nodes as rounded pills (role icon, label, status dot),
 * joined by curved connectors coloured by the source node's role, with the
 * coordinator at the centre and its team radiating out. A zoom cluster sits
 * bottom-left; dragging empty canvas pans, scrolling zooms, clicking a node
 * inspects it.
 *
 * Deliberately reuses `memory/Graph.tsx`'s canvas plumbing (dotted grid,
 * curved-connector math, pan/zoom transform, single `<canvas>` render loop)
 * rather than a second from-scratch implementation — see that file's own
 * top comment for why a single canvas beats one DOM node per pill at this
 * scale. It does NOT reuse `Graph.tsx`'s `d3-force` simulation, though:
 * this canvas's whole point is a legible, deterministic "coordinator in the
 * middle, team radiating out" shape (`layoutMissionNodes` in `logic.ts`), so
 * physics that could drift a node away from its ring position would
 * actively fight the design instead of serving it. Nodes also don't drag
 * individually here (unlike Graph's notes) — the spec only calls for
 * pan/zoom/click, not repositioning agents.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MissionAgent } from "@vibespace/shared";
import { EmptyState, IconButton } from "../shell/ui.js";
import { RADIUS, SHADOW_VAR, SPACE } from "../shell/tokens.js";
import { agentStatusKind, fitTransform, layoutMissionNodes, roleColorVar, roleGlyph, type ViewTransform } from "./logic.js";

export interface MissionCanvasProps {
  agents: MissionAgent[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
}

/** A laid-out node with everything the draw loop needs precomputed once per
 * `agents` change, so drawing/hit-testing never re-measures text mid-frame. */
interface CanvasNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  agent: MissionAgent;
}

const NODE_HEIGHT = 26;
const CHAR_WIDTH = 6.2;
const MIN_NODE_WIDTH = 70;
const MAX_NODE_WIDTH = 180;
/** Half-extent used by "fit" to keep a node's own footprint inside the
 * viewport, not just its centre point — matches the widest a pill can get. */
const NODE_HALF_EXTENT = MAX_NODE_WIDTH / 2 + 20;

function pillWidthFor(label: string): number {
  // Room for the role glyph + status dot on the left, label text, padding.
  const estimated = label.length * CHAR_WIDTH + 40;
  return Math.max(MIN_NODE_WIDTH, Math.min(MAX_NODE_WIDTH, estimated));
}

/** Same quadratic-bezier control point Graph.tsx uses for its connectors —
 * offset perpendicular to the line by a fraction of its length, so curves
 * read as deliberate at any distance. */
function curveControlPoint(x1: number, y1: number, x2: number, y2: number): { cx: number; cy: number } {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const curveAmount = 0.18;
  return { cx: mx - dy * curveAmount, cy: my + dx * curveAmount };
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

/** Resolves a role's CSS-var colour string (e.g. `"var(--vd-warn)"`) to its
 * actual computed value, because canvas's `strokeStyle`/`fillStyle` can't
 * take `var(...)` directly the way DOM/CSS can. */
function resolveVar(container: HTMLElement, cssVarExpr: string): string {
  const match = /var\((--[a-z0-9-]+)\)/i.exec(cssVarExpr);
  if (!match) return cssVarExpr;
  const value = getComputedStyle(container).getPropertyValue(match[1]).trim();
  return value || "#888888";
}

/** Maps a `StatusKind` to its CSS var expression — small local table so the
 * draw loop can go straight from an agent's live status to a resolvable
 * colour without importing shell/ui.tsx's private map. */
const STATUS_KIND_VAR: Record<string, string> = {
  ok: "var(--vd-ok)",
  warn: "var(--vd-warn)",
  danger: "var(--vd-danger)",
  idle: "var(--vd-idle)",
  info: "var(--vd-info)",
};

export default function MissionCanvas({ agents, selectedAgentId, onSelectAgent }: MissionCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const transformRef = useRef<ViewTransform>({ x: 0, y: 0, k: 1 });
  const panRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const pendingClickRef = useRef<{ node: CanvasNode; startX: number; startY: number } | null>(null);
  const zoomPercentRef = useRef(100);
  const [zoomPercent, setZoomPercent] = useState(100);

  const nodes: CanvasNode[] = useMemo(() => {
    const layout = layoutMissionNodes(agents.map((a) => ({ id: a.id, role: a.role })));
    const byId = new Map(layout.map((n) => [n.id, n]));
    return agents.map((agent) => {
      const pos = byId.get(agent.id) ?? { x: 0, y: 0 };
      return {
        id: agent.id,
        x: pos.x,
        y: pos.y,
        width: pillWidthFor(agent.label),
        height: NODE_HEIGHT,
        agent,
      };
    });
  }, [agents]);

  // Every edge is drawn FROM the (first) coordinator TO everyone else, per
  // docs/DESIGN.md §5's "coordinator at the centre with its team radiating
  // out". A mission with no coordinator yet (agents still spawning) simply
  // has nothing to draw edges from.
  const coordinatorId = useMemo(() => nodes.find((n) => n.agent.role === "coordinator")?.id ?? null, [nodes]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !container || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    ctx.save();
    ctx.scale(dpr, dpr);

    const bg = resolveVar(container, "var(--vd-bg)");
    const border = resolveVar(container, "var(--vd-border)");
    const text = resolveVar(container, "var(--vd-text)");
    const surfaceRaised = resolveVar(container, "var(--vd-surface-raised)");
    const accent = resolveVar(container, "var(--vd-accent)");

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const { x: tx, y: ty, k } = transformRef.current;
    const originX = w / 2 + tx;
    const originY = h / 2 + ty;

    // Dotted grid, per docs/DESIGN.md §5.
    const gridSpacing = 24 * k;
    if (gridSpacing > 4) {
      ctx.fillStyle = border;
      const offsetX = originX % gridSpacing;
      const offsetY = originY % gridSpacing;
      for (let gx = offsetX; gx < w; gx += gridSpacing) {
        for (let gy = offsetY; gy < h; gy += gridSpacing) {
          ctx.beginPath();
          ctx.arc(gx, gy, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    ctx.save();
    ctx.translate(originX, originY);
    ctx.scale(k, k);

    // Curved connectors: coordinator -> every other agent, coloured by the
    // SOURCE node's role (always the coordinator's colour, since every edge
    // originates there).
    if (coordinatorId) {
      const source = nodes.find((n) => n.id === coordinatorId);
      if (source) {
        const edgeColor = resolveVar(container, roleColorVar("coordinator"));
        for (const target of nodes) {
          if (target.id === source.id) continue;
          const { cx, cy } = curveControlPoint(source.x, source.y, target.x, target.y);
          ctx.beginPath();
          ctx.moveTo(source.x, source.y);
          ctx.quadraticCurveTo(cx, cy, target.x, target.y);
          ctx.strokeStyle = edgeColor;
          ctx.globalAlpha = 0.55;
          ctx.lineWidth = 1.4;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }

    // Nodes as rounded pills.
    for (const node of nodes) {
      const x = node.x - node.width / 2;
      const y = node.y - node.height / 2;
      const radius = node.height / 2;
      const roleColor = resolveVar(container, roleColorVar(node.agent.role));
      const isSelected = node.id === selectedAgentId;

      ctx.beginPath();
      roundedRectPath(ctx, x, y, node.width, node.height, radius);
      ctx.fillStyle = surfaceRaised;
      ctx.fill();
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.strokeStyle = isSelected ? accent : roleColor;
      ctx.stroke();

      // Role glyph.
      ctx.fillStyle = roleColor;
      ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(roleGlyph(node.agent.role), x + 8, node.y);

      // Status dot — reflects the agent's LIVE status (idle/working/
      // blocked/done/failed), separate from its role colour.
      const statusVarExpr = STATUS_KIND_VAR[agentStatusKind(node.agent.status)];
      const dotX = x + node.width - 12;
      const dotY = node.y;
      ctx.beginPath();
      ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
      ctx.fillStyle = resolveVar(container, statusVarExpr);
      ctx.fill();

      // Label.
      ctx.fillStyle = text;
      const maxTextWidth = node.width - 44;
      let label = node.agent.label;
      while (ctx.measureText(label).width > maxTextWidth && label.length > 1) {
        label = label.slice(0, -1);
      }
      if (label !== node.agent.label) label = `${label.slice(0, -1)}…`;
      ctx.fillText(label, x + 22, node.y);
    }

    ctx.restore();
    ctx.restore();
  }, [nodes, coordinatorId, selectedAgentId]);

  useEffect(() => {
    draw();
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  const nodeAt = useCallback(
    (lx: number, ly: number): CanvasNode | null => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (lx >= n.x - n.width / 2 && lx <= n.x + n.width / 2 && ly >= n.y - n.height / 2 && ly <= n.y + n.height / 2) {
          return n;
        }
      }
      return null;
    },
    [nodes]
  );

  const toLayoutSpace = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const w = container.clientWidth;
    const h = container.clientHeight;
    const { x: tx, y: ty, k } = transformRef.current;
    return {
      x: (clientX - rect.left - w / 2 - tx) / k,
      y: (clientY - rect.top - h / 2 - ty) / k,
    };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const { x, y } = toLayoutSpace(e.clientX, e.clientY);
      const hit = nodeAt(x, y);
      if (hit) {
        pendingClickRef.current = { node: hit, startX: e.clientX, startY: e.clientY };
      } else {
        panRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          origX: transformRef.current.x,
          origY: transformRef.current.y,
        };
      }
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    },
    [toLayoutSpace, nodeAt]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (panRef.current) {
        const dx = e.clientX - panRef.current.startX;
        const dy = e.clientY - panRef.current.startY;
        transformRef.current = { ...transformRef.current, x: panRef.current.origX + dx, y: panRef.current.origY + dy };
        draw();
        return;
      }
      // Stage B: hover feedback for a canvas that previously gave zero
      // response to a pointer sitting over a node — the cursor itself is
      // the only affordance canvas content can offer without a DOM overlay
      // per node, so it switches from "grab" (pan) to "pointer" (this is
      // clickable) the moment the pointer is over a node's hit box. Skipped
      // entirely while actually panning/dragging above.
      if (!pendingClickRef.current) {
        const { x, y } = toLayoutSpace(e.clientX, e.clientY);
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = nodeAt(x, y) ? "pointer" : "grab";
      }
    },
    [draw, toLayoutSpace, nodeAt]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const pending = pendingClickRef.current;
      if (pending) {
        const dist = Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY);
        if (dist < 4) onSelectAgent(pending.node.id);
      }
      pendingClickRef.current = null;
      panRef.current = null;
    },
    [onSelectAgent]
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const { x, y, k } = transformRef.current;
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      const nextK = Math.max(0.2, Math.min(3, k * zoomFactor));
      const nextX = mouseX - ((mouseX - x) / k) * nextK;
      const nextY = mouseY - ((mouseY - y) / k) * nextK;
      transformRef.current = { x: nextX, y: nextY, k: nextK };
      zoomPercentRef.current = Math.round(nextK * 100);
      setZoomPercent(zoomPercentRef.current);
      draw();
    },
    [draw]
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const container = containerRef.current;
      const w = container?.clientWidth ?? 800;
      const h = container?.clientHeight ?? 600;
      const { x, y, k } = transformRef.current;
      const nextK = Math.max(0.2, Math.min(3, k * factor));
      const nextX = w / 2 - ((w / 2 - x) / k) * nextK;
      const nextY = h / 2 - ((h / 2 - y) / k) * nextK;
      transformRef.current = { x: nextX, y: nextY, k: nextK };
      zoomPercentRef.current = Math.round(nextK * 100);
      setZoomPercent(zoomPercentRef.current);
      draw();
    },
    [draw]
  );

  const fitView = useCallback(() => {
    const container = containerRef.current;
    const w = container?.clientWidth ?? 800;
    const h = container?.clientHeight ?? 600;
    const fitted = fitTransform(nodes, w, h, NODE_HALF_EXTENT);
    transformRef.current = fitted;
    zoomPercentRef.current = Math.round(fitted.k * 100);
    setZoomPercent(zoomPercentRef.current);
    draw();
  }, [nodes, draw]);

  // Re-fit once whenever the agent roster's SIZE changes (a fresh mission
  // load, or agents being added) — not on every draw, so a user's manual
  // pan/zoom during a running mission isn't yanked back on the next poll.
  const agentCountRef = useRef(-1);
  useEffect(() => {
    if (agentCountRef.current !== nodes.length) {
      agentCountRef.current = nodes.length;
      fitView();
    } else {
      draw();
    }
  }, [nodes, draw]);

  return (
    <div ref={containerRef} style={containerStyle}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        style={{ display: "block", width: "100%", height: "100%", cursor: "grab" }}
      />

      {/* Stage B: agents "still spawning" (a fresh mission, before the
          coordinator's first agents come up) previously rendered as plain
          grey text drawn INSIDE the canvas — invisible to anything but a
          human eye, no real hierarchy. A DOM EmptyState reads as a designed
          state instead of an empty void, matching every other empty
          surface in the app. Real agents fully replace this the moment
          `agents` is non-empty; it never overlaps the node graph. */}
      {nodes.length === 0 && (
        <div style={canvasEmptyStyle}>
          <EmptyState
            icon={<SwarmingGlyph />}
            title="Agents are spawning…"
            description="The coordinator and its team will appear here as their sessions come up."
          />
        </div>
      )}

      <div style={zoomClusterStyle}>
        <IconButton title="Zoom out" onClick={() => zoomBy(0.8)}>
          <span style={{ fontSize: 13 }}>−</span>
        </IconButton>
        <span style={zoomPercentStyle}>{zoomPercent}%</span>
        <IconButton title="Zoom in" onClick={() => zoomBy(1.2)}>
          <span style={{ fontSize: 13 }}>+</span>
        </IconButton>
        <IconButton title="Fit to view" onClick={fitView}>
          <span style={{ fontSize: 10 }}>⛶</span>
        </IconButton>
      </div>
    </div>
  );
}

/** A small "in progress" glyph — three faint dots orbiting a centre one,
 * distinct from CreateMissionForm's solid `MissionGlyph` so "the swarm is
 * still assembling" reads differently at a glance from "here's your fully
 * formed mission". Inline SVG, no icon library. */
function SwarmingGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden style={{ color: "var(--vd-text-faint)" }}>
      <circle cx="10" cy="10" r="2.2" fill="currentColor" />
      <circle cx="10" cy="3.5" r="1.4" fill="currentColor" opacity="0.6" />
      <circle cx="15.8" cy="13.2" r="1.4" fill="currentColor" opacity="0.4" />
      <circle cx="4.2" cy="13.2" r="1.4" fill="currentColor" opacity="0.2" />
    </svg>
  );
}

const containerStyle: React.CSSProperties = {
  position: "relative",
  height: "100%",
  width: "100%",
  overflow: "hidden",
  background: "var(--vd-bg)",
};

/** Centres the zero-agents EmptyState over the canvas without blocking
 * pointer events meant for panning/zooming underneath it — this overlay is
 * purely informational, there is nothing to click while agents are still
 * spawning. */
const canvasEmptyStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
};

const zoomClusterStyle: React.CSSProperties = {
  position: "absolute",
  left: SPACE.sm,
  bottom: SPACE.sm,
  display: "flex",
  alignItems: "center",
  gap: 2,
  padding: 2,
  background: "var(--vd-surface)",
  border: "1px solid var(--vd-border)",
  borderRadius: RADIUS.sm,
  boxShadow: SHADOW_VAR.sm,
};

const zoomPercentStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--vd-text-faint)",
  minWidth: 32,
  textAlign: "center",
};
