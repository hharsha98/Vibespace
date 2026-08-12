#!/usr/bin/env node
/**
 * The runnable MCP entry point: `node dist/memory/mcp-server.js <workspace-root>`
 * (after `pnpm build`), or `pnpm --filter @vibedeck/server exec tsx
 * src/memory/mcp-server.ts <workspace-root>` for local development without
 * building first. This is the exact command docs/MEMORY.md tells users to
 * paste into Claude Code / Cursor / Codex's MCP config — one server process
 * per workspace, talking stdio, reading/writing that workspace's
 * `.vibedeck/memory/` directory via `./mcp.ts`'s tools.
 *
 * Deliberately a THIN wrapper: all the actual tool logic lives in
 * `./mcp.ts` (unit-testable without a real stdio process); this file's only
 * job is CLI-argument handling and wiring `StdioServerTransport`.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMemoryMcpServer } from "./mcp.js";

async function main(): Promise<void> {
  const rawRoot = process.argv[2];
  if (!rawRoot) {
    // MCP clients read stderr for a failed launch, not stdout (stdout is
    // reserved for the JSON-RPC protocol stream itself) — writing the usage
    // message anywhere else would corrupt that stream for a client that
    // did manage to connect.
    console.error("Usage: vibedeck-memory-mcp <workspace-root>");
    console.error("  <workspace-root> is the absolute path to a vibedeck workspace's project directory.");
    process.exitCode = 1;
    return;
  }

  const root = resolve(rawRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`vibedeck-memory-mcp: "${root}" is not a directory.`);
    process.exitCode = 1;
    return;
  }

  const server = createMemoryMcpServer(root);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error("vibedeck-memory-mcp: fatal error", err);
  process.exitCode = 1;
});
