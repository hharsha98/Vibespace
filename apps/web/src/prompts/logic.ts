/**
 * Pure logic behind the Prompts library (PARITY #27) — no DOM, unit-testable
 * under plain Node/vitest, same reasoning as every other pure-logic module
 * in this app (see keymap.ts's top comment).
 */
import type { SavedPrompt } from "@vibedeck/shared";

export interface GroupedPrompts {
  /** `workspaceId === null` — available in every workspace. */
  global: SavedPrompt[];
  /** Scoped to just the workspace that was queried. */
  workspace: SavedPrompt[];
}

/**
 * Splits the server's already-merged "global + this workspace's" prompt
 * list (see `apps/server/src/prompts/routes.ts`'s `GET /api/prompts`, which
 * does the actual merge in SQL) back into two groups for display — the UI
 * needs to show GLOBAL prompts (available in every workspace) visually
 * separate from prompts scoped to just this one, per this phase's spec.
 * Pure and order-preserving within each group, so it can sit directly on
 * top of whatever order the server already returned (workspace-scoped
 * first, then global, each alphabetised by title — see store.ts's `list`).
 */
export function groupPromptsByScope(prompts: readonly SavedPrompt[]): GroupedPrompts {
  const global: SavedPrompt[] = [];
  const workspace: SavedPrompt[] = [];
  for (const prompt of prompts) {
    (prompt.workspaceId === null ? global : workspace).push(prompt);
  }
  return { global, workspace };
}
