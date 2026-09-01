import { describe, expect, it } from "vitest";
import type { Workspace } from "@vibespace/shared";
import { deriveWorkspaceTabs, nextTabIndex, workspaceIdForTabIndex } from "./workspaceTabs.js";

function ws(overrides: Partial<Workspace> & { id: string }): Workspace {
  return {
    name: overrides.id,
    rootPath: `/tmp/${overrides.id}`,
    layout: null,
    color: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("deriveWorkspaceTabs", () => {
  it("preserves the workspace list's own order — no re-sorting", () => {
    const workspaces = [ws({ id: "c" }), ws({ id: "a" }), ws({ id: "b" })];
    const tabs = deriveWorkspaceTabs(workspaces);
    expect(tabs.map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("carries a null colour through untouched, instead of substituting a default", () => {
    const workspaces = [ws({ id: "w1", color: null }), ws({ id: "w2", color: "#4ade80" })];
    const tabs = deriveWorkspaceTabs(workspaces);
    expect(tabs[0].color).toBeNull();
    expect(tabs[1].color).toBe("#4ade80");
  });

  it("projects only id/name/color — an empty list derives an empty tab list", () => {
    expect(deriveWorkspaceTabs([])).toEqual([]);
  });
});

describe("workspaceIdForTabIndex", () => {
  const workspaces = [ws({ id: "w1" }), ws({ id: "w2" }), ws({ id: "w3" })];

  it("maps 1-based n to the workspace at that position", () => {
    expect(workspaceIdForTabIndex(workspaces, 1)).toBe("w1");
    expect(workspaceIdForTabIndex(workspaces, 2)).toBe("w2");
    expect(workspaceIdForTabIndex(workspaces, 3)).toBe("w3");
  });

  it("returns null (not a crash) for n past the end of the list — Cmd+7 with only 3 workspaces", () => {
    expect(workspaceIdForTabIndex(workspaces, 7)).toBeNull();
    expect(workspaceIdForTabIndex(workspaces, 4)).toBeNull();
  });

  it("returns null for n <= 0 and for non-integer n", () => {
    expect(workspaceIdForTabIndex(workspaces, 0)).toBeNull();
    expect(workspaceIdForTabIndex(workspaces, -1)).toBeNull();
    expect(workspaceIdForTabIndex(workspaces, 1.5)).toBeNull();
  });

  it("returns null for every n when there are no workspaces at all", () => {
    expect(workspaceIdForTabIndex([], 1)).toBeNull();
  });
});

describe("nextTabIndex", () => {
  it("wraps forward on ArrowRight and backward on ArrowLeft", () => {
    expect(nextTabIndex(0, "ArrowRight", 3)).toBe(1);
    expect(nextTabIndex(2, "ArrowRight", 3)).toBe(0); // wraps past the end
    expect(nextTabIndex(0, "ArrowLeft", 3)).toBe(2); // wraps past the start
    expect(nextTabIndex(1, "ArrowLeft", 3)).toBe(0);
  });

  it("Home/End jump to the first/last tab", () => {
    expect(nextTabIndex(1, "Home", 5)).toBe(0);
    expect(nextTabIndex(1, "End", 5)).toBe(4);
  });

  it("returns null for a key this tablist doesn't handle", () => {
    expect(nextTabIndex(0, "ArrowDown", 3)).toBeNull();
    expect(nextTabIndex(0, "a", 3)).toBeNull();
  });

  it("returns null when there are no tabs at all, regardless of key", () => {
    expect(nextTabIndex(0, "ArrowRight", 0)).toBeNull();
  });
});
