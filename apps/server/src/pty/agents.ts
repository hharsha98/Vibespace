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
import { AGENT_IDS, AGENT_SPECS, type AgentId } from "@vibespace/shared";

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
 *
 * Exported (not just used internally by `detectAgent` below) so
 * `../ssh/routes.ts` can reuse the exact same PATH-search logic to check
 * whether the `ssh` binary itself is installed before spawning a remote
 * pane — SSH profiles aren't an `AgentId` (see `SshProfile`'s doc comment
 * in `packages/shared/src/protocol.ts`), so they can't go through
 * `detectAgent`/`detectAllAgents` below, but the "is this executable on
 * PATH" question underneath is identical.
 */
export async function commandExists(command: string): Promise<boolean> {
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

/**
 * How a user would install a given agent's CLI if it's missing. `null` for
 * agents that need no separate install (the "shell" agent is always
 * available) — surfaced by `GET /api/agents` and in the 409 body of both
 * `POST /api/sessions` and `POST /api/board/cards/:id/dispatch`, so the UI
 * can show something more useful than "not installed". Lives here (not in
 * `index.ts`, where it originated) so `board/routes.ts` can import it
 * without an `index.ts` <-> `board/routes.ts` import cycle.
 *
 * Research notes (BridgeSpace-parity expansion from 4 to 10 agents) — every
 * binary name in `@vibespace/shared`'s `AGENT_SPECS` and every install hint
 * below was checked against a real source before being written down, not
 * guessed blind. Confidence varies a lot per agent, so it's recorded here
 * explicitly rather than presented as uniform certainty:
 *
 *  - droid (Factory): HIGH confidence. docs.factory.ai's own CLI quickstart
 *    page documents `npm install -g droid` and the `droid` command.
 *  - gemini (Google): HIGH confidence. The official google-gemini/gemini-cli
 *    GitHub repo and the `@google/gemini-cli` npm package both document
 *    `npm install -g @google/gemini-cli` and the `gemini` command.
 *  - opencode (sst): MEDIUM-HIGH confidence. `opencode-ai` is a real,
 *    actively-published npm package; secondary sources agree its binary is
 *    `opencode`, but the npm package page itself has no README to confirm
 *    firsthand.
 *  - grok (xAI "Grok Build"): MEDIUM confidence. x.ai's own announcement
 *    page (x.ai/news/grok-build-cli) shows `grok-build` as the prompt in
 *    its terminal screenshots and documents `curl -fsSL
 *    https://x.ai/cli/install.sh | bash` as the install method — no npm
 *    package is published by xAI itself. An unofficial `@xai-official/grok`
 *    npm package with a `grok` binary also turned up in search, but isn't
 *    xAI's own, so it wasn't used here.
 *  - deepseek ("DeepSeek Harness" in the picker label, per BridgeSpace's
 *    photo): LOW confidence. No product literally named "DeepSeek Harness"
 *    could be confirmed against an authoritative source — search results
 *    for it (dsh, @deepseek-ai/dsh, a "DSH Plugin Store") read like
 *    low-quality/SEO content, not documentation. DeepSeek's OWN docs
 *    (api-docs.deepseek.com) instead document a real, differently-named
 *    tool, "Deep Code": `npm install -g @vegamo/deepcode-cli`, binary
 *    `deepcode`. That's used here as the best available stand-in, but it is
 *    a genuine guess about what BridgeSpace's "DeepSeek Harness" entry
 *    actually launches, not a confirmed match.
 *  - antigravity (Google): LOW confidence. Google's own antigravity.google
 *    marketing page confirms an "Antigravity CLI" product exists ("the
 *    lightweight, fast, terminal-first surface to work with Antigravity
 *    agents") but the fetched page carries no code snippets — no concrete
 *    binary name or install command could be confirmed from it. `null`
 *    below (no install hint) reflects that; the `antigravity` command name
 *    in AGENT_SPECS is a guess following the same "binary == short product
 *    name" pattern the confirmed entries above all follow.
 */
export const INSTALL_HINTS: Record<AgentId, string | null> = {
  claude: null,
  "cursor-agent": null,
  codex: "npm install -g @openai/codex",
  droid: "npm install -g droid",
  deepseek: "npm install -g @vegamo/deepcode-cli",
  antigravity: null,
  gemini: "npm install -g @google/gemini-cli",
  opencode: "npm install -g opencode-ai",
  grok: "curl -fsSL https://x.ai/cli/install.sh | bash",
  shell: null,
};

/** True if `value` is one of the known AgentId strings. Shared by every
 * route that accepts an agent id in a request body (`POST /api/sessions`,
 * `POST /api/board/cards/:id/dispatch`) — lives here rather than in one of
 * those route files so neither has to duplicate it or import from the
 * other. */
export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value);
}
