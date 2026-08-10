#!/usr/bin/env node
/**
 * Some environments' tarball extraction (observed with this pnpm store on
 * this machine) does not preserve the executable bit on prebuilt native
 * binaries it unpacks. node-pty ships a small helper binary called
 * "spawn-helper" (used on macOS/Linux to fork the pty) that MUST be
 * executable, or every `node-pty.spawn(...)` call fails immediately with
 * "posix_spawnp failed."
 *
 * This script runs as the root workspace's `postinstall` hook (see
 * package.json) so a fresh `pnpm install` self-heals instead of silently
 * producing a broken node-pty. It's a no-op (finds nothing) on platforms
 * where node-pty builds from source instead of using a prebuild — e.g. CI
 * on ubuntu-latest, where there's no darwin/win32 prebuild to fix.
 */
import { readdir, chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import console from "node:console";

// Explicit imports for `console` and `URL` instead of relying on them as
// ambient globals — this file isn't covered by any workspace package's
// @types/node-backed tsconfig, so ESLint's `no-undef` rule (which the base
// JS config enables) wouldn't otherwise know these exist.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function findSpawnHelpers(dir, results = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results; // Directory vanished or unreadable — not our problem here.
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // node_modules can be deep; skip .git for speed/safety, otherwise recurse.
      if (entry.name === ".git") continue;
      await findSpawnHelpers(full, results);
    } else if (entry.name === "spawn-helper") {
      results.push(full);
    }
  }
  return results;
}

const nodeModulesDir = join(ROOT, "node_modules");
const helpers = await findSpawnHelpers(nodeModulesDir);

for (const helperPath of helpers) {
  const before = await stat(helperPath);
  const isExecutable = (before.mode & 0o111) !== 0;
  if (!isExecutable) {
    await chmod(helperPath, 0o755);
    console.log(`[fix-native-perms] made executable: ${helperPath}`);
  }
}
