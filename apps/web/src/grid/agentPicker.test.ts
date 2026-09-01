import { describe, expect, it } from "vitest";
import type { AgentId } from "@vibespace/shared";
import {
  canLaunchMultiple,
  MAX_MULTI_LAUNCH,
  panesNeededForLaunch,
  splitByAvailability,
  toggleMultiLaunchSelection,
} from "./agentPicker.js";

describe("splitByAvailability", () => {
  it("separates available from unavailable agents", () => {
    const agents = [
      { id: "claude" as const, available: true },
      { id: "codex" as const, available: false },
      { id: "gemini" as const, available: true },
      { id: "grok" as const, available: false },
    ];
    const { available, unavailable } = splitByAvailability(agents);
    expect(available.map((a) => a.id)).toEqual(["claude", "gemini"]);
    expect(unavailable.map((a) => a.id)).toEqual(["codex", "grok"]);
  });

  it("preserves input order within each group", () => {
    const agents = [
      { id: "codex" as const, available: false },
      { id: "claude" as const, available: true },
      { id: "grok" as const, available: false },
      { id: "gemini" as const, available: true },
    ];
    const { available, unavailable } = splitByAvailability(agents);
    expect(available.map((a) => a.id)).toEqual(["claude", "gemini"]);
    expect(unavailable.map((a) => a.id)).toEqual(["codex", "grok"]);
  });

  it("returns an empty unavailable list when every agent is available", () => {
    const agents = [
      { id: "claude" as const, available: true },
      { id: "codex" as const, available: true },
    ];
    const { available, unavailable } = splitByAvailability(agents);
    expect(available).toHaveLength(2);
    expect(unavailable).toHaveLength(0);
  });

  it("returns an empty available list when nothing is installed", () => {
    const agents = [
      { id: "claude" as const, available: false },
      { id: "codex" as const, available: false },
    ];
    const { available, unavailable } = splitByAvailability(agents);
    expect(available).toHaveLength(0);
    expect(unavailable).toHaveLength(2);
  });

  it("handles an empty input list", () => {
    expect(splitByAvailability([])).toEqual({ available: [], unavailable: [] });
  });
});

describe("MAX_MULTI_LAUNCH", () => {
  it("is 2 — the smallest honest version of multi-launch (a single split)", () => {
    expect(MAX_MULTI_LAUNCH).toBe(2);
  });
});

describe("toggleMultiLaunchSelection", () => {
  it("adds an agent to an empty selection", () => {
    expect(toggleMultiLaunchSelection([], "claude")).toEqual(["claude"]);
  });

  it("appends a second, different agent", () => {
    expect(toggleMultiLaunchSelection(["claude"], "codex")).toEqual(["claude", "codex"]);
  });

  it("removes an agent that's already selected (toggle off)", () => {
    expect(toggleMultiLaunchSelection(["claude", "codex"], "claude")).toEqual(["codex"]);
  });

  it("is a no-op when the selection is already at MAX_MULTI_LAUNCH and a NEW agent is clicked", () => {
    const atCap: AgentId[] = ["claude", "codex"];
    expect(toggleMultiLaunchSelection(atCap, "gemini")).toEqual(atCap);
  });

  it("still allows deselecting when at the cap (toggling an already-selected agent off)", () => {
    const atCap: AgentId[] = ["claude", "codex"];
    expect(toggleMultiLaunchSelection(atCap, "codex")).toEqual(["claude"]);
  });

  it("never mutates the input array", () => {
    const original: AgentId[] = ["claude"];
    const copy = [...original];
    toggleMultiLaunchSelection(original, "codex");
    expect(original).toEqual(copy);
  });
});

describe("panesNeededForLaunch", () => {
  it("needs zero panes for an empty selection", () => {
    expect(panesNeededForLaunch([])).toBe(0);
  });

  it("needs one pane per selected agent", () => {
    expect(panesNeededForLaunch(["claude"])).toBe(1);
    expect(panesNeededForLaunch(["claude", "codex"])).toBe(2);
  });
});

describe("canLaunchMultiple", () => {
  it("is false with zero or one agent selected (that's just the normal single-agent picker)", () => {
    expect(canLaunchMultiple([])).toBe(false);
    expect(canLaunchMultiple(["claude"])).toBe(false);
  });

  it("is true at exactly two agents selected", () => {
    expect(canLaunchMultiple(["claude", "codex"])).toBe(true);
  });

  it("is false beyond MAX_MULTI_LAUNCH", () => {
    expect(canLaunchMultiple(["claude", "codex", "gemini"])).toBe(false);
  });
});
