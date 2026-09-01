/**
 * The memory Graph — Phase 8's centre view (Terminals | Editor | Preview |
 * Board | Graph), per docs/DESIGN.md §5 "Canvas": a dotted grid over
 * `--bg`, nodes as rounded pills joined by curved connectors, a zoom
 * cluster bottom-left. Rendered on a single `<canvas>` with `d3-force`
 * driving the physics — not a heavyweight graph library, per this phase's
 * own instruction, and not SVG-per-node (200 DOM nodes' worth of React
 * reconciliation on every simulation tick would be the actual performance
 * problem at this note count, not the physics itself).
 *
 * Clicking a real note's pill fires `onOpenNote(slug)`, which App.tsx wires
 * to switch the right dock to the Memory tab and show that note (see
 * RightDock.tsx/MemoryPanel.tsx). A dangling node (a `[[link]]` with no
 * note written yet) has nothing to open, so it's visually distinct
 * (dashed, `--text-faint`) and not clickable here — the Memory tab's
 * reader is where a dangling link's own "create this note" affordance
 * lives (NoteBody in MemoryPanel.tsx), not the graph.
 *
 * Performance note (honest, not assumed): tested by hand up to ~150 notes
 * during this phase's own verification — force-directed layout on canvas
 * stays smooth there. Well beyond a few hundred nodes, `d3-force`'s O(n
 * log n) per-tick cost and a single un-batched canvas redraw would start
 * to show — this file doesn't attempt any culling/quadtree-viewport
 * optimization beyond what `d3-force` already does internally, so treat
 * "usable to ~200 notes" as a real ceiling, not a formality.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type Simulation } from "d3-force";
import type { MemoryGraphEdge, MemoryGraphNode } from "@vibespace/shared";
import { EmptyState, IconButton } from "../shell/ui.js";
import { RADIUS, SHADOW_VAR, SPACE } from "../shell/tokens.js";

export interface GraphProps {
  workspaceId: string | null;
  onOpenNote: (slug: string) => void;
  /**
   * Whether the graph is the visible centre view.
   *
   * This matters because centre views are never unmounted — they're hidden
   * with `display: none` so terminals don't churn through a reconnect every
   * time you look at a file. The side effect is that this component mounts
   * exactly once, at app start, when the workspace usually has zero notes.
   * Without re-fetching when it becomes visible, the graph would show that
   * first empty result forever, no matter how many notes you wrote.
   */
  visible: boolean;
}

/** A graph node augmented with the fields d3-force reads/writes (`x`/`y`/
 * `vx`/`vy`) plus a pre-computed pill size so hit-testing and drawing don't
 * need to re-measure text on every frame. */
interface SimNode extends MemoryGraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx?: number | null;
  fy?: number | null;
  width: number;
  height: number;
}

interface SimLink {
  source: SimNode | string;
  target: SimNode | string;
  dangling: boolean;
}

const NODE_HEIGHT = 24;
const CHAR_WIDTH = 6.2; // rough monospace-ish estimate at 11px, good enough for pill sizing
const MIN_NODE_WIDTH = 56;
const MAX_NODE_WIDTH = 170;

function pillWidthFor(title: string): number {
  const estimated = title.length * CHAR_WIDTH + 24;
  return Math.max(MIN_NODE_WIDTH, Math.min(MAX_NODE_WIDTH, estimated));
}

/** Quadratic-bezier control point for a curved connector between two
 * points — offset perpendicular to the line by a fraction of its length,
 * so the curve reads as deliberate at any distance rather than a fixed
 * pixel bow that looks flat on long edges and exaggerated on short ones. */
function curveControlPoint(x1: number, y1: number, x2: number, y2: number): { cx: number; cy: number } {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const curveAmount = 0.15;
  return { cx: mx - dy * curveAmount, cy: my + dx * curveAmount };
}

export default function Graph({ workspaceId, onOpenNote, visible }: GraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simulationRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const draggingNodeRef = useRef<SimNode | null>(null);
  const panRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [, forceRerender] = useState(0); // only used to re-trigger the draw effect after a fresh load

  // --- Load the graph whenever the workspace changes, or we become visible --
  // `visible` is in the deps deliberately: notes get created while this view
  // is hidden, so switching TO the graph has to re-ask the server rather than
  // redrawing whatever it happened to see when it first mounted.
  useEffect(() => {
    if (!visible) return;
    if (!workspaceId) {
      setLoadState("loaded");
      nodesRef.current = [];
      linksRef.current = [];
      return;
    }
    setLoadState("loading");
    setLoadError(null);
    fetch(`/api/memory/graph?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Server responded with ${res.status}`);
        }
        return (await res.json()) as { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] };
      })
      .then(({ nodes, edges }) => {
        const container = containerRef.current;
        const w = container?.clientWidth ?? 800;
        const h = container?.clientHeight ?? 600;

        // Reuse an existing node's position if it already had one (e.g. a
        // reload after creating a note) so the whole layout doesn't jump —
        // only brand-new nodes start from a random position near centre.
        const previous = new Map(nodesRef.current.map((n) => [n.slug, n]));
        const simNodes: SimNode[] = nodes.map((n) => {
          const prev = previous.get(n.slug);
          return {
            ...n,
            x: prev?.x ?? w / 2 + (Math.random() - 0.5) * 100,
            y: prev?.y ?? h / 2 + (Math.random() - 0.5) * 100,
            vx: 0,
            vy: 0,
            width: pillWidthFor(n.title),
            height: NODE_HEIGHT,
          };
        });
        const simLinks: SimLink[] = edges.map((e) => ({ source: e.source, target: e.target, dangling: e.dangling }));

        nodesRef.current = simNodes;
        linksRef.current = simLinks;
        setLoadState("loaded");
        forceRerender((n) => n + 1);
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : "Failed to load the memory graph");
        setLoadState("error");
      });
  }, [workspaceId, visible]);

  // --- Simulation + draw loop -----------------------------------------------
  useEffect(() => {
    if (loadState !== "loaded") return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    };
    resize();

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const simulation = forceSimulation<SimNode>(nodesRef.current)
      .force(
        "link",
        forceLink<SimNode, SimLink>(linksRef.current)
          .id((d) => d.slug)
          .distance(90)
          .strength(0.4)
      )
      .force("charge", forceManyBody().strength(-220))
      .force("center", forceCenter(container.clientWidth / 2, container.clientHeight / 2))
      .force("collide", forceCollide<SimNode>((d) => Math.max(d.width, d.height) / 2 + 8));
    simulationRef.current = simulation;

    const draw = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      // --bg dotted grid, per docs/DESIGN.md §5.
      const styles = getComputedStyle(container);
      const bg = styles.getPropertyValue("--vd-bg").trim() || "#0a0a0b";
      const border = styles.getPropertyValue("--vd-border").trim() || "#232329";
      const text = styles.getPropertyValue("--vd-text").trim() || "#e8e8ea";
      const textFaint = styles.getPropertyValue("--vd-text-faint").trim() || "#5a5a63";
      const accent = styles.getPropertyValue("--vd-accent").trim() || "#60a5fa";
      const info = styles.getPropertyValue("--vd-info").trim() || "#60a5fa";
      const surfaceRaised = styles.getPropertyValue("--vd-surface-raised").trim() || "#17171c";

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      const { x: tx, y: ty, k } = transformRef.current;
      const gridSpacing = 24 * k;
      ctx.fillStyle = border;
      const offsetX = tx % gridSpacing;
      const offsetY = ty % gridSpacing;
      for (let gx = offsetX; gx < w; gx += gridSpacing) {
        for (let gy = offsetY; gy < h; gy += gridSpacing) {
          ctx.beginPath();
          ctx.arc(gx, gy, 1, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.save();
      ctx.translate(tx, ty);
      ctx.scale(k, k);

      // Curved connectors, coloured by dangling status.
      for (const link of linksRef.current) {
        const source = typeof link.source === "string" ? null : link.source;
        const target = typeof link.target === "string" ? null : link.target;
        if (!source || !target) continue;
        const { cx, cy } = curveControlPoint(source.x, source.y, target.x, target.y);
        ctx.beginPath();
        ctx.moveTo(source.x, source.y);
        ctx.quadraticCurveTo(cx, cy, target.x, target.y);
        ctx.strokeStyle = link.dangling ? textFaint : info;
        ctx.globalAlpha = link.dangling ? 0.45 : 0.7;
        ctx.lineWidth = 1.2;
        if (link.dangling) ctx.setLineDash([3, 3]);
        else ctx.setLineDash([]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      // Nodes as rounded pills.
      for (const node of nodesRef.current) {
        const x = node.x - node.width / 2;
        const y = node.y - node.height / 2;
        const radius = node.height / 2;

        ctx.beginPath();
        roundedRectPath(ctx, x, y, node.width, node.height, radius);
        ctx.fillStyle = node.dangling ? "transparent" : surfaceRaised;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = node.dangling ? textFaint : accent;
        if (node.dangling) ctx.setLineDash([3, 3]);
        else ctx.setLineDash([]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Status dot.
        const dotX = x + 10;
        const dotY = node.y;
        ctx.beginPath();
        ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
        ctx.fillStyle = node.dangling ? textFaint : accent;
        ctx.fill();

        // Label.
        ctx.fillStyle = node.dangling ? textFaint : text;
        ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const maxTextWidth = node.width - 24;
        let label = node.title;
        while (ctx.measureText(label).width > maxTextWidth && label.length > 1) {
          label = label.slice(0, -1);
        }
        if (label !== node.title) label = `${label.slice(0, -1)}…`;
        ctx.fillText(label, x + 18, node.y);
      }

      ctx.restore();
      ctx.restore();
    };

    simulation.on("tick", draw);
    draw();

    const onResize = () => {
      resize();
      simulation.force("center", forceCenter(container.clientWidth / 2, container.clientHeight / 2));
      draw();
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      simulation.stop();
      simulationRef.current = null;
    };
  }, [loadState]);

  // --- Pointer interaction: drag a node, pan empty space, click to open ----
  const toGraphSpace = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const { x: tx, y: ty, k } = transformRef.current;
    return {
      x: (clientX - rect.left - tx) / k,
      y: (clientY - rect.top - ty) / k,
    };
  }, []);

  const nodeAt = useCallback((gx: number, gy: number): SimNode | null => {
    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const n = nodesRef.current[i];
      if (
        gx >= n.x - n.width / 2 &&
        gx <= n.x + n.width / 2 &&
        gy >= n.y - n.height / 2 &&
        gy <= n.y + n.height / 2
      ) {
        return n;
      }
    }
    return null;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const { x, y } = toGraphSpace(e.clientX, e.clientY);
      const hit = nodeAt(x, y);
      if (hit) {
        draggingNodeRef.current = hit;
        hit.fx = hit.x;
        hit.fy = hit.y;
        simulationRef.current?.alphaTarget(0.3).restart();
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
    [toGraphSpace, nodeAt]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (draggingNodeRef.current) {
        const { x, y } = toGraphSpace(e.clientX, e.clientY);
        draggingNodeRef.current.fx = x;
        draggingNodeRef.current.fy = y;
      } else if (panRef.current) {
        const dx = e.clientX - panRef.current.startX;
        const dy = e.clientY - panRef.current.startY;
        transformRef.current = { ...transformRef.current, x: panRef.current.origX + dx, y: panRef.current.origY + dy };
      } else {
        // Stage B: same hover-cursor feedback the mission canvas gained —
        // a real (non-dangling) node under the pointer switches to
        // "pointer" (clicking opens it) instead of leaving every pixel of
        // the canvas looking identically "grab"-able.
        const { x, y } = toGraphSpace(e.clientX, e.clientY);
        const hit = nodeAt(x, y);
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = hit && !hit.dangling ? "pointer" : "grab";
      }
    },
    [toGraphSpace, nodeAt]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (draggingNodeRef.current) {
        const node = draggingNodeRef.current;
        node.fx = null;
        node.fy = null;
        draggingNodeRef.current = null;
        simulationRef.current?.alphaTarget(0);
        if (!node.dangling) {
          // Distinguish a real drag from a click by comparing pointer travel.
          const { x, y } = toGraphSpace(e.clientX, e.clientY);
          const dist = Math.hypot(x - node.x, y - node.y);
          if (dist < 4) onOpenNote(node.slug);
        }
      }
      panRef.current = null;
    },
    [toGraphSpace, onOpenNote]
  );

  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const { x, y, k } = transformRef.current;
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    const nextK = Math.max(0.2, Math.min(3, k * zoomFactor));
    // Zoom toward the cursor: keep the graph-space point under the cursor fixed.
    const nextX = mouseX - ((mouseX - x) / k) * nextK;
    const nextY = mouseY - ((mouseY - y) / k) * nextK;
    transformRef.current = { x: nextX, y: nextY, k: nextK };
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const container = containerRef.current;
    const w = container?.clientWidth ?? 800;
    const h = container?.clientHeight ?? 600;
    const { x, y, k } = transformRef.current;
    const nextK = Math.max(0.2, Math.min(3, k * factor));
    const nextX = w / 2 - ((w / 2 - x) / k) * nextK;
    const nextY = h / 2 - ((h / 2 - y) / k) * nextK;
    transformRef.current = { x: nextX, y: nextY, k: nextK };
  }, []);

  const resetView = useCallback(() => {
    transformRef.current = { x: 0, y: 0, k: 1 };
  }, []);

  const noteCount = useMemo(() => nodesRef.current.filter((n) => !n.dangling).length, [loadState]);

  if (!workspaceId) {
    return (
      <div style={emptyStateStyle}>
        <EmptyState icon={<GraphGlyph />} title="No workspace open" description="Open a workspace to see its memory graph." />
      </div>
    );
  }
  if (loadState === "error") {
    return (
      <div style={emptyStateStyle}>
        <EmptyState
          icon={<GraphGlyph tint="var(--vd-danger)" />}
          title="Couldn't load the graph"
          description={loadError ?? "Failed to load the memory graph."}
        />
      </div>
    );
  }
  if (loadState === "loaded" && nodesRef.current.length === 0) {
    return (
      <div style={emptyStateStyle}>
        <EmptyState
          icon={<GraphGlyph />}
          title="No memory notes yet"
          description="Notes you write show up here as connected nodes — add one from the Memory tab and [[link]] it to another to see an edge."
        />
      </div>
    );
  }

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
      {loadState === "loading" && <div style={loadingOverlayStyle}>Loading graph…</div>}

      <div style={zoomClusterStyle}>
        <IconButton title="Zoom in" onClick={() => zoomBy(1.2)}>
          <span style={{ fontSize: 13 }}>+</span>
        </IconButton>
        <IconButton title="Zoom out" onClick={() => zoomBy(0.8)}>
          <span style={{ fontSize: 13 }}>−</span>
        </IconButton>
        <IconButton title="Reset view" onClick={resetView}>
          <span style={{ fontSize: 10 }}>⟲</span>
        </IconButton>
      </div>

      <div style={legendStyle}>
        {noteCount} note{noteCount === 1 ? "" : "s"} · drag to pan, scroll to zoom, click a note to open it
      </div>
    </div>
  );
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

/** A small graph glyph — three linked nodes — for the graph's own empty
 * states, matching the "small plain SVG, no icon library" convention every
 * other glyph in the app follows (see board/Column.tsx's `ColumnIcon`).
 * `tint` defaults to the accent. */
function GraphGlyph({ tint = "var(--vd-accent)" }: { tint?: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden style={{ color: tint }}>
      <path d="M6 6.5L14 4.5M6 6.5L10 14.5M14 4.5L10 14.5" stroke="currentColor" strokeWidth="1.2" opacity="0.6" />
      <circle cx="6" cy="6.5" r="2.2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="14" cy="4.5" r="2.2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="10" cy="14.5" r="2.2" fill="currentColor" />
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

const zoomClusterStyle: React.CSSProperties = {
  position: "absolute",
  left: SPACE.sm,
  bottom: SPACE.sm,
  display: "flex",
  gap: 2,
  padding: 2,
  background: "var(--vd-surface)",
  border: "1px solid var(--vd-border)",
  borderRadius: RADIUS.sm,
  boxShadow: SHADOW_VAR.sm,
};

const legendStyle: React.CSSProperties = {
  position: "absolute",
  right: SPACE.sm,
  bottom: SPACE.sm,
  fontSize: 10,
  color: "var(--vd-text-faint)",
  background: "var(--vd-surface)",
  border: "1px solid var(--vd-border)",
  borderRadius: RADIUS.sm,
  padding: "3px 8px",
  pointerEvents: "none",
  boxShadow: SHADOW_VAR.sm,
};

const loadingOverlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--vd-text-muted)",
  fontSize: 12,
  pointerEvents: "none",
};

const emptyStateStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  color: "var(--vd-text-muted)",
  fontSize: 12,
  background: "var(--vd-bg)",
};
