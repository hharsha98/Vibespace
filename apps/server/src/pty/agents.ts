/**
 * Server-side agent resolution: turning an `AgentId` into an actual command
 * to spawn, and checking whether that command is actually installed.
 *
 * This file is deliberately separate from `packages/shared`'s
 * `AGENT_SPECS`. `AGENT_SPECS` is static metadata safe to ship to the
 * browser (display names, default args). This file does the parts that
 * only make sense on the server: reading `process.env.SHELL` and touching
 * the filesystem/PATH to see what's actually installed on *this* machine.
 */
import { access, constants } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { AGENT_IDS, AGENT_SPECS, type AgentId } from "@vibedeck/shared";

/**
 * Resolve an AgentId to the command + args node-pty should spawn.
 *
 * Every agent except "shell" just uses the static metadata from
 * AGENT_SPECS. "shell" is special-cased: we want the user's actual login
 * shell (e.g. zsh, bash, fish — whatever `$SHELL` says), not a hardcoded
 * guess, so we read `process.env.SHELL` here, at call time, falling back
 * to `/bin/zsh` if it's unset.
 */
export function resolveAgent(id: AgentId): { command: string; args: string[] } {
  if (id === "shell") {
    return { command: process.env.SHELL ?? "/bin/zsh", args: ["-l"] };
  }
  const spec = AGENT_SPECS[id];
  return { command: spec.command, args: spec.args };
}

/**
 * Check whether a command name/path can actually be executed.
 *
 * - If `command` is an absolute path (e.g. the resolved shell path), we
 *   just check that path is executable.
 * - Otherwise, we search `$PATH` ourselves for an executable file with
 *   that name — this is what `which`/`command -v` do under the hood, but
 *   without spawning a subprocess.
 *
 * Never throws: any filesystem error (missing file, permission denied,
 * etc.) just means "not available", which we report as `false`.
 */
async function commandExists(command: string): Promise<boolean> {
  try {
    if (isAbsolute(command)) {
      await access(command, constants.X_OK);
      return true;
    }

    const pathEntries = (process.env.PATH ?? "").split(":").filter(Boolean);
    for (const dir of pathEntries) {
      try {
        await access(join(dir, command), constants.X_OK);
        return true;
      } catch {
        // Not in this PATH entry — keep looking.
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Whether the binary for a given agent is installed and runnable. */
export async function detectAgent(id: AgentId): Promise<boolean> {
  const { command } = resolveAgent(id);
  return commandExists(command);
}

/** Availability of every known agent, keyed by id. */
export async function detectAllAgents(): Promise<Record<AgentId, boolean>> {
  const entries = await Promise.all(
    AGENT_IDS.map(async (id) => [id, await detectAgent(id)] as const)
  );
  return Object.fromEntries(entries) as Record<AgentId, boolean>;
}
