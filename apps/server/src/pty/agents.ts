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
 *  - opencode (sst): HIGH confidence (was MEDIUM-HIGH). Rather than trust
 *    the secondary sources the earlier note relied on, npm's registry
 *    metadata for `opencode-ai` was read directly: it declares exactly one
 *    bin, `{"opencode": ...}`. That is the name npm links onto PATH, which
 *    is exactly what detection below looks for.
 *  - grok (xAI "Grok Build"): HIGH confidence, and the command was WRONG
 *    until now. The earlier note read `grok-build` off the interactive
 *    prompt in x.ai's announcement screenshots — but a TUI's prompt string
 *    is not its binary name, and here the two differ. xai-org/grok-build's
 *    own README titles itself "Grok Build (`grok`)", verifies installs with
 *    `grok --version`, and says plainly: "the binary artifact is named
 *    `xai-grok-pager`; official installs ship it as `grok`". The install
 *    hint (the x.ai curl script) was right and is unchanged.
 *  - deepseek: HIGH confidence (was LOW), and the command was right all
 *    along. DeepSeek's OWN API docs (api-docs.deepseek.com) carry a "Deep
 *    Code" integration page documenting `npm install -g
 *    @vegamo/deepcode-cli`, verification via `deepcode --version`, and
 *    launching with `deepcode`; npm's registry metadata agrees, declaring
 *    `{"deepcode": "cli.js"}`. What was actually wrong was the DISPLAY
 *    name: "DeepSeek Harness" was copied from BridgeSpace's photographed
 *    picker and names no real product. AGENT_SPECS now says "Deep Code".
 *  - antigravity (Google): HIGH confidence, and the command was WRONG
 *    until now. The earlier note could find no binary name and guessed
 *    `antigravity` from the "binary == short product name" pattern.
 *    Google's CLI docs (antigravity.google/docs/cli/getting-started) give
 *    the real answer: the installer registers `agy` (at `~/.local/bin/agy`
 *    on macOS/Linux) and the TUI launches with `agy`.
 *
 * Worth stating plainly, because it is the reason this note was rewritten
 * rather than merely softened: a wrong `command` is not a cosmetic
 * documentation problem. Detection works by looking for that exact name on
 * PATH, so `grok` and `antigravity` could never report `available: true` —
 * not even for a user who had installed the real CLI and was looking right
 * at it. Two of the ten lanes were silently dead rather than simply
 * unverified, and no amount of hedging in a comment would have found that;
 * checking the vendors' own docs did.
 */
export const INSTALL_HINTS: Record<AgentId, string | null> = {
  // These two were `null` for a long time, which looked harmless only
  // because the machine this was developed on happened to have both
  // installed — so they always rendered as "available" and the missing
  // hint never showed. On a fresh Mac they are `available: false` like any
  // other uninstalled CLI, and the picker then offers "Not installed" with
  // no way forward, which is the single least helpful thing it could say.
  // Both verified: npm's registry metadata for `@anthropic-ai/claude-code`
  // declares bin {"claude": ...}, and Cursor's own CLI installation docs
  // (cursor.com/docs/cli/installation) publish the curl script below.
  claude: "npm install -g @anthropic-ai/claude-code",
  "cursor-agent": "curl https://cursor.com/install -fsSL | bash",
  codex: "npm install -g @openai/codex",
  droid: "npm install -g droid",
  deepseek: "npm install -g @vegamo/deepcode-cli",
  antigravity: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
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
