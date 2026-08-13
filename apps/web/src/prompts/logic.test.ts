import { describe, expect, it } from "vitest";
import type { SavedPrompt } from "@vibedeck/shared";
import { groupPromptsByScope } from "./logic.js";

function prompt(overrides: Partial<SavedPrompt> & Pick<SavedPrompt, "id" | "workspaceId">): SavedPrompt {
  return {
    title: "Untitled",
    body: "body",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("groupPromptsByScope", () => {
  it("puts workspaceId: null prompts in the global bucket", () => {
    const prompts = [prompt({ id: "p1", workspaceId: null, title: "Write tests" })];
    const { global, workspace } = groupPromptsByScope(prompts);
    expect(global).toHaveLength(1);
    expect(global[0].id).toBe("p1");
    expect(workspace).toHaveLength(0);
  });

  it("puts a non-null workspaceId in the workspace bucket", () => {
    const prompts = [prompt({ id: "p2", workspaceId: "ws-1", title: "Fix the login bug" })];
    const { global, workspace } = groupPromptsByScope(prompts);
    expect(workspace).toHaveLength(1);
    expect(workspace[0].id).toBe("p2");
    expect(global).toHaveLength(0);
  });

  it("splits a mixed list into both buckets, preserving relative order within each", () => {
    const prompts = [
      prompt({ id: "g1", workspaceId: null }),
      prompt({ id: "w1", workspaceId: "ws-1" }),
      prompt({ id: "g2", workspaceId: null }),
      prompt({ id: "w2", workspaceId: "ws-1" }),
    ];
    const { global, workspace } = groupPromptsByScope(prompts);
    expect(global.map((p) => p.id)).toEqual(["g1", "g2"]);
    expect(workspace.map((p) => p.id)).toEqual(["w1", "w2"]);
  });

  it("returns two empty arrays for an empty list", () => {
    expect(groupPromptsByScope([])).toEqual({ global: [], workspace: [] });
  });
});
