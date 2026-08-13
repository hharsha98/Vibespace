/**
 * Tiny MCP `CallToolResult` builders shared by every domain's MCP tool
 * handlers (board, agents, prompts). Identical in spirit to the private
 * `jsonResult`/`errorResult` helpers at the top of `memory/mcp.ts` — pulled
 * out into their own file here specifically so the NEW tool modules added
 * in Phase 9.5b (`board/mcp.ts`, `agents/mcp.ts`, `prompts/mcp.ts`) can
 * share one copy instead of three. `memory/mcp.ts`'s own private copies are
 * left untouched rather than migrated to import from here — that file
 * already has its own passing test suite and no reason to change.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Every tool result is plain JSON-in-text content — the simplest,
 * broadest-compatible shape, parseable by a model without needing
 * `outputSchema`/structured-content support from every client. */
export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
