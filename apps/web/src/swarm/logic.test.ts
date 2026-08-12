import { describe, expect, it } from "vitest";
import {
  agentStatusKind,
  computeProgress,
  fitTransform,
  formatElapsed,
  layoutMissionNodes,
  mentionQueryAt,
  missionStatusKind,
  parseMention,
  roleColorVar,
  roleGlyph,
} from "./logic.js";

describe("layoutMissionNodes", () => {
  it("puts a single coordinator at the origin", () => {
    const layout = layoutMissionNodes([{ id: "c1", role: "coordinator" }]);
    expect(layout).toEqual([{ id: "c1", x: 0, y: 0 }]);
  });

  it("spreads two agents 180deg apart on the team ring, starting at 12 o'clock", () => {
    const layout = layoutMissionNodes([
      { id: "c1", role: "coordinator" },
      { id: "b1", role: "builder" },
      { id: "b2", role: "builder" },
    ]);
    const coordinator = layout.find((n) => n.id === "c1")!;
    const b1 = layout.find((n) => n.id === "b1")!;
    const b2 = layout.find((n) => n.id === "b2")!;

    expect(coordinator.x).toBeCloseTo(0);
    expect(coordinator.y).toBeCloseTo(0);

    // b1 starts at 12 o'clock: (0, -radius).
    expect(b1.x).toBeCloseTo(0);
    expect(b1.y).toBeCloseTo(-150);
    // b2 is 180deg further round: (0, +radius).
    expect(b2.x).toBeCloseTo(0);
    expect(b2.y).toBeCloseTo(150);

    // Both are equidistant from the coordinator.
    expect(Math.hypot(b1.x, b1.y)).toBeCloseTo(150);
    expect(Math.hypot(b2.x, b2.y)).toBeCloseTo(150);
  });

  it("handles no agents at all without NaN/crash", () => {
    expect(layoutMissionNodes([])).toEqual([]);
  });

  it("handles a coordinator with no team", () => {
    const layout = layoutMissionNodes([{ id: "c1", role: "coordinator" }]);
    expect(layout).toHaveLength(1);
  });

  it("spreads multiple coordinators on their own small inner ring, not stacked", () => {
    const layout = layoutMissionNodes([
      { id: "c1", role: "coordinator" },
      { id: "c2", role: "coordinator" },
    ]);
    const c1 = layout.find((n) => n.id === "c1")!;
    const c2 = layout.find((n) => n.id === "c2")!;
    expect(c1).not.toEqual(c2);
    expect(Math.hypot(c1.x, c1.y)).toBeCloseTo(36);
    expect(Math.hypot(c2.x, c2.y)).toBeCloseTo(36);
  });

  it("returns one entry per agent, in no particular order requirement, ids all present", () => {
    const agents = [
      { id: "c1", role: "coordinator" as const },
      { id: "s1", role: "scout" as const },
      { id: "r1", role: "reviewer" as const },
      { id: "b1", role: "builder" as const },
    ];
    const layout = layoutMissionNodes(agents);
    expect(layout.map((n) => n.id).sort()).toEqual(["b1", "c1", "r1", "s1"]);
  });
});

describe("roleColorVar", () => {
  it("maps coordinator/builder/scout to their status-token doubles, per DESIGN.md §2", () => {
    expect(roleColorVar("coordinator")).toBe("var(--vd-warn)");
    expect(roleColorVar("builder")).toBe("var(--vd-ok)");
    expect(roleColorVar("scout")).toBe("var(--vd-info)");
  });

  it("maps reviewer to the dedicated role token, not a hard-coded hex", () => {
    const color = roleColorVar("reviewer");
    expect(color).toBe("var(--vd-role-reviewer)");
    expect(color).not.toMatch(/#/);
  });
});

describe("roleGlyph", () => {
  it("returns a distinct single-character glyph for each of the four roles", () => {
    const roles = ["coordinator", "builder", "scout", "reviewer"] as const;
    const glyphs = roles.map(roleGlyph);
    expect(new Set(glyphs).size).toBe(4);
    for (const g of glyphs) expect(g.length).toBe(1);
  });
});

describe("agentStatusKind", () => {
  it("maps every MissionAgentStatus to its semantic StatusKind", () => {
    expect(agentStatusKind("idle")).toBe("idle");
    expect(agentStatusKind("working")).toBe("warn");
    expect(agentStatusKind("blocked")).toBe("danger");
    expect(agentStatusKind("done")).toBe("ok");
    expect(agentStatusKind("failed")).toBe("danger");
  });
});

describe("missionStatusKind", () => {
  it("maps every MissionStatus to its semantic StatusKind", () => {
    expect(missionStatusKind("running")).toBe("ok");
    expect(missionStatusKind("paused")).toBe("warn");
    expect(missionStatusKind("complete")).toBe("idle");
    expect(missionStatusKind("stopped")).toBe("danger");
  });
});

describe("computeProgress", () => {
  it("counts complete tasks over the total", () => {
    const tasks = [{ status: "complete" as const }, { status: "running" as const }, { status: "pending" as const }];
    expect(computeProgress(tasks)).toEqual({ completed: 1, total: 3, ratio: 1 / 3 });
  });

  it("reports 0 ratio (not NaN) for an empty task list", () => {
    expect(computeProgress([])).toEqual({ completed: 0, total: 0, ratio: 0 });
  });

  it("reports ratio 1 when every task is complete", () => {
    const tasks = [{ status: "complete" as const }, { status: "complete" as const }];
    expect(computeProgress(tasks)).toEqual({ completed: 2, total: 2, ratio: 1 });
  });
});

describe("formatElapsed", () => {
  it("formats under an hour as mm:ss", () => {
    const start = "2026-01-01T00:00:00.000Z";
    const now = new Date("2026-01-01T00:02:05.000Z").getTime();
    expect(formatElapsed(start, now)).toBe("02:05");
  });

  it("formats past an hour as h:mm:ss", () => {
    const start = "2026-01-01T00:00:00.000Z";
    const now = new Date("2026-01-01T01:02:03.000Z").getTime();
    expect(formatElapsed(start, now)).toBe("1:02:03");
  });

  it("never goes negative even if now is somehow before start", () => {
    const start = "2026-01-01T00:00:10.000Z";
    const now = new Date("2026-01-01T00:00:00.000Z").getTime();
    expect(formatElapsed(start, now)).toBe("00:00");
  });
});

describe("parseMention", () => {
  const agents = [
    { id: "a-builder-1", label: "Builder 1" },
    { id: "a-builder-2", label: "Builder 2" },
    { id: "a-coord", label: "Coordinator" },
  ];

  it("targets the matching agent and strips the mention from the body", () => {
    expect(parseMention("@Builder 2 fix the login bug", agents)).toEqual({
      targetAgentId: "a-builder-2",
      body: "fix the login bug",
    });
  });

  it("is case-insensitive", () => {
    expect(parseMention("@builder 1 look at this", agents)).toEqual({
      targetAgentId: "a-builder-1",
      body: "look at this",
    });
  });

  it("treats plain text with no @ as a broadcast, body untouched (trimmed)", () => {
    expect(parseMention("  status update for everyone  ", agents)).toEqual({
      targetAgentId: null,
      body: "status update for everyone",
    });
  });

  it("treats an @ that matches no known agent as a broadcast", () => {
    expect(parseMention("@nobody is home", agents)).toEqual({
      targetAgentId: null,
      body: "@nobody is home",
    });
  });

  it("handles a mention with no trailing message body", () => {
    expect(parseMention("@Builder 1", agents)).toEqual({ targetAgentId: "a-builder-1", body: "" });
  });
});

describe("fitTransform", () => {
  it("returns the identity transform for an empty node list", () => {
    expect(fitTransform([], 800, 600)).toEqual({ x: 0, y: 0, k: 1 });
  });

  it("keeps pan at the origin — layout is always centred on the coordinator", () => {
    const nodes = [
      { x: 0, y: 0 },
      { x: 150, y: 0 },
      { x: -150, y: 0 },
    ];
    const result = fitTransform(nodes, 1000, 1000);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });

  it("shrinks to fit a wide layout into a small container", () => {
    const nodes = [
      { x: -150, y: 0 },
      { x: 150, y: 0 },
    ];
    const result = fitTransform(nodes, 200, 200, 90, 20);
    // Bounding box is 480px wide (300 span + 90 half-extent each side);
    // available width is 200 - 40 = 160, so k must shrink well under 1.
    expect(result.k).toBeLessThan(1);
    expect(result.k).toBeGreaterThanOrEqual(0.2);
  });

  it("clamps to the max zoom for a single tiny node in a huge container", () => {
    const result = fitTransform([{ x: 0, y: 0 }], 4000, 4000);
    expect(result.k).toBe(3);
  });
});

describe("mentionQueryAt", () => {
  it("returns the partial word typed after the most recent @", () => {
    expect(mentionQueryAt("hey @Buil", 9)).toBe("Buil");
  });

  it("returns empty string right after typing a bare @", () => {
    expect(mentionQueryAt("@", 1)).toBe("");
  });

  it("returns null once the mention word is closed by whitespace", () => {
    expect(mentionQueryAt("@Builder 2 fix it", 11)).toBeNull();
  });

  it("returns null when there is no @ at all", () => {
    expect(mentionQueryAt("just a broadcast", 5)).toBeNull();
  });

  it("only looks at text up to the cursor, ignoring an @ later in the string", () => {
    expect(mentionQueryAt("no mention yet @later", 5)).toBeNull();
  });
});
