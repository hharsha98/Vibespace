/**
 * MCP tool handler for the saved-prompts library (Phase 9.5b, PARITY
 * #27c). The spec calls for exactly one tool here — `list_prompts` — not
 * full CRUD: prompts are authored by a human through the (future) web UI
 * or the REST API (`./routes.ts`), and an agent's job is to READ them for
 * reuse, not manage the library. See `board/mcp.ts`'s top comment for the
 * shared "resolved workspaceId, testable without a real workspace" design.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SavedPromptStore } from "./store.js";
import { jsonResult } from "../mcp/result.js";

/** `workspaceId` is OPTIONAL here, same as `SavedPromptStore.list` and
 * `GET /api/prompts` — omitted, this returns only global prompts; given,
 * it returns globals plus that workspace's own. */
export async function handleListPrompts(
  savedPromptStore: SavedPromptStore,
  workspaceId?: string
): Promise<CallToolResult> {
  return jsonResult({ prompts: savedPromptStore.list(workspaceId) });
}
