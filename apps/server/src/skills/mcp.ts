/**
 * MCP tool handlers for Skills (Phase 10, PARITY #37): `list_skills` /
 * `get_skill`. Mirrors `../memory/mcp.ts`'s shape — list is catalog-only,
 * read is full body — rather than `../board/mcp.ts`'s, because skills, like
 * memory notes, are addressed by a filesystem root alone
 * (`discoverSkills(root)`); there is no `workspace_id` to resolve from
 * SQLite the way board/agent/prompt tools need
 * (`../mcp/workspace-resolver.ts`), so this file needs no equivalent.
 *
 * Extracted as plain, exported async functions (not inlined into
 * `registerTool` calls) specifically so `mcp.test.ts` can call them
 * directly with a temp-dir root and assert on the returned
 * `CallToolResult` — no real stdio transport, no MCP client, no protocol
 * framing involved. `../mcp/build-server.ts` is just these two functions
 * wired into `registerTool`'s callback shape.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorResult, jsonResult } from "../mcp/result.js";
import { catalogEntry, discoverSkills, fullSkill } from "./discover.js";

export async function handleListSkills(root: string): Promise<CallToolResult> {
  const { skills, diagnostics } = discoverSkills(root);
  return jsonResult({ skills: skills.map(catalogEntry), diagnostics });
}

export async function handleGetSkill(root: string, name: string): Promise<CallToolResult> {
  const { skills } = discoverSkills(root);
  const found = skills.find((s) => s.skill.name === name);
  if (!found) {
    return errorResult(`No skill named "${name}". Use list_skills to find one.`);
  }
  return jsonResult(fullSkill(found));
}
