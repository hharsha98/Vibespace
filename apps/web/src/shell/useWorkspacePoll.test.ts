import { describe, expect, it } from "vitest";
import type { Workspace } from "@vibespace/shared";
import { mergeWorkspaces } from "./useWorkspacePoll.js";

// `useWorkspacePoll` itself is a React hook (useEffect/useState) and this
// package has no jsdom/testing-library (see tree.test.ts's neighbouring
// files for the same convention) — there is no way to render it here. Only
// `mergeWorkspaces`, the pure reconciliation function it's paired with, is
// exercised directly, the same way `sections.test.ts` only ever tests the
// plain functions `sections.ts` exports rather than anything React-shaped.

function makeWorkspace(overrides: Partial<Workspace>): Workspace {
  return {
    id: "ws-1",
    name: "Workspace",
    rootPath: "/tmp/project",
    layout: null,
    color: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("mergeWorkspaces", () => {
  it("keeps the local layout for the active workspace, even though the server sent a different one", () => {
    const local = [makeWorkspace({ id: "ws-1", layout: '{"kind":"leaf","id":"local-leaf","content":null}' })];
    const server = [makeWorkspace({ id: "ws-1", layout: '{"kind":"leaf","id":"stale-server-leaf","content":null}' })];

    const result = mergeWorkspaces(local, server, "ws-1");

    expect(result).toHaveLength(1);
    expect(result[0].layout).toBe(local[0].layout);
  });

  it("takes the server's name/color for the active workspace — only layout stays local", () => {
    const local = [makeWorkspace({ id: "ws-1", name: "Old name", color: null, layout: "local-layout" })];
    const server = [makeWorkspace({ id: "ws-1", name: "Renamed elsewhere", color: "blue", layout: "server-layout" })];

    const result = mergeWorkspaces(local, server, "ws-1");

    expect(result[0].name).toBe("Renamed elsewhere");
    expect(result[0].color).toBe("blue");
    expect(result[0].layout).toBe("local-layout");
  });

  it("takes the server's layout wholesale for a non-active workspace", () => {
    const local = [makeWorkspace({ id: "ws-2", layout: "local-layout" })];
    const server = [makeWorkspace({ id: "ws-2", layout: "server-layout" })];

    // activeWorkspaceId is some OTHER workspace, not ws-2.
    const result = mergeWorkspaces(local, server, "ws-1");

    expect(result[0].layout).toBe("server-layout");
  });

  it("adds a workspace that exists on the server but not locally", () => {
    const local: Workspace[] = [];
    const server = [makeWorkspace({ id: "new-from-api" })];

    const result = mergeWorkspaces(local, server, null);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("new-from-api");
  });

  it("removes a workspace that no longer exists on the server", () => {
    const local = [makeWorkspace({ id: "ws-1" }), makeWorkspace({ id: "deleted-elsewhere" })];
    const server = [makeWorkspace({ id: "ws-1" })];

    const result = mergeWorkspaces(local, server, "ws-1");

    expect(result.map((w) => w.id)).toEqual(["ws-1"]);
  });

  it("preserves the server's ordering", () => {
    const local = [makeWorkspace({ id: "a" }), makeWorkspace({ id: "b" })];
    const server = [makeWorkspace({ id: "b" }), makeWorkspace({ id: "a" }), makeWorkspace({ id: "c" })];

    const result = mergeWorkspaces(local, server, null);

    expect(result.map((w) => w.id)).toEqual(["b", "a", "c"]);
  });
});
