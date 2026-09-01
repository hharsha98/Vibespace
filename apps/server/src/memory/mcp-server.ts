#!/usr/bin/env node
/**
 * The runnable MCP entry point: `node dist/memory/mcp-server.js <workspace-root>`
 * (after `pnpm build`), or `pnpm --filter @vibespace/server exec tsx
 * src/memory/mcp-server.ts <workspace-root>` for local development without
 * building first. This is the exact command docs/MEMORY.md and
 * docs/AGENT-API.md tell users to paste into Claude Code / Cursor / Codex's
 * MCP config — one server process per workspace, talking stdio.
 *
 * Despite living under `memory/` (its original Phase 8 home, kept as-is so
 * existing MCP configs pointing at this exact path keep working), this
 * process exposes the FULL vibespace MCP surface as of Phase 9.5b: memory
 * tools, board tools, agent-profile tools, the saved-prompts tool, and the
 * `vibespace_developer_guide` prompt — see `../mcp/build-server.ts`'s top
 * comment for the composition and the architecture decision behind how the
 * board/agent/prompt tools reach the shared SQLite database from this
 * separate process.
 *
 * Deliberately a THIN wrapper: all the actual tool logic lives in
 * `./mcp.ts` / `../mcp/build-server.ts` (unit-testable without a real stdio
 * process); this file's only job is CLI-argument handling and wiring
 * `StdioServerTransport`.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildVibespaceMcpServer } from "../mcp/build-server.js";

async function main(): Promise<void> {
  const rawRoot = process.argv[2];
  if (!rawRoot) {
    // MCP clients read stderr for a failed launch, not stdout (stdout is
    // reserved for the JSON-RPC protocol stream itself) — writing the usage
    // message anywhere else would corrupt that stream for a client that
    // did manage to connect.
    console.error("Usage: vibespace-memory-mcp <workspace-root>");
    console.error("  <workspace-root> is the absolute path to a vibespace workspace's project directory.");
    process.exitCode = 1;
    return;
  }

  const root = resolve(rawRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`vibespace-memory-mcp: "${root}" is not a directory.`);
    process.exitCode = 1;
    return;
  }

  const { server, close } = buildVibespaceMcpServer(root);

  // Close the shared SQLite handle on a normal shutdown so the process
  // doesn't leave a database file handle open after the client disconnects
  // — same "close what you opened" discipline `index.ts` follows for the
  // Fastify server's own stores.
  const shutdown = () => {
    close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error("vibespace-memory-mcp: fatal error", err);
  process.exitCode = 1;
});
