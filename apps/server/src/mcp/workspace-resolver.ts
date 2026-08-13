/**
 * Resolves the MCP server's own workspace ROOT (an absolute filesystem
 * path, the one CLI argument `memory/mcp-server.ts` has always taken) into
 * a vibedeck workspace ID — the thing `BoardStore`/`AgentProfileStore`/
 * `SavedPromptStore` actually key their rows on.
 *
 * --- Why this lookup has to exist at all ---
 * Memory tools never needed this: `memory/store.ts` reads/writes markdown
 * files directly under `<root>/.vibedeck/memory/`, so a bare filesystem
 * path is the whole address. The board/agents/prompts tables, by contrast,
 * are keyed by `workspace_id` — a UUID assigned when a workspace is
 * created through the app (`POST /api/workspaces`), not derivable from the
 * root path alone. So before any board/agent/prompt MCP tool can do
 * anything, it needs to find the `workspaces` row whose `rootPath` equals
 * this MCP process's root.
 *
 * --- Why this resolves fresh on every tool call, not once at startup ---
 * An MCP stdio server is long-running — a coding agent's CLI can hold the
 * connection open for an entire session. The workspace it's rooted at may
 * not exist in vibedeck's database YET when the agent connects (e.g. a
 * user opens their coding agent before ever opening this directory in
 * vibedeck itself), or may be created moments later. Caching the
 * resolution (or its failure) at server-build time would mean a
 * permanently-broken board/agent/prompt surface for the rest of that
 * process's life even after the user fixes the underlying problem —
 * strictly worse than a cheap `SELECT` on every call. Memory tools
 * (unaffected by any of this — see `../memory/mcp.ts`) keep working
 * regardless, since they never needed a workspace id in the first place.
 */
import type { WorkspaceStore } from "../db/workspaces.js";

export type WorkspaceResolution = { ok: true; workspaceId: string } | { ok: false; error: string };

export function resolveWorkspaceId(workspaceStore: WorkspaceStore, root: string): WorkspaceResolution {
  const workspace = workspaceStore.list().find((w) => w.rootPath === root);
  if (!workspace) {
    return {
      ok: false,
      error:
        `"${root}" is not a registered vibedeck workspace yet. Open this directory as a workspace in ` +
        `the vibedeck app first (Add Workspace), then retry — the board/agents/prompts tools need a ` +
        `workspace id to look up. Memory tools are unaffected and work regardless.`,
    };
  }
  return { ok: true, workspaceId: workspace.id };
}
