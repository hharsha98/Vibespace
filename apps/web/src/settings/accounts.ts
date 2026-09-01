/**
 * Per-agent login guidance for the Accounts section — data, not JSX, for
 * the same "testable without a DOM" reason billingContent.ts and
 * shortcutRows.ts are also split out (see billingContent.ts's top comment).
 *
 * The core fact this section exists to communicate: vibespace itself has no
 * user accounts and no login system of its own. Every agent CLI (claude,
 * codex, cursor-agent, gemini, droid, opencode, deepseek, grok, antigravity)
 * manages its OWN authentication, entirely outside vibespace — vibespace just
 * spawns that CLI's binary in a real pty (the exact same "we don't sit in
 * the middle of your credentials" posture docs/SSH.md documents for SSH
 * auth). Signing in happens INSIDE that CLI, the same way it would if you'd
 * launched it from a plain terminal without vibespace at all.
 *
 * `KNOWN_LOGIN_NOTES` below is deliberately conservative: it names a
 * concrete command only for the one CLI whose auth flow is well-established
 * and documented (Claude Code — `claude` triggers a browser-based login on
 * first run if `ANTHROPIC_API_KEY` isn't already set in the environment).
 * For every other agent, this file does NOT guess a `<cli> login` command —
 * per this feature's own instruction, inventing an unverified command would
 * be worse than the honest fallback (`GENERIC_LOGIN_NOTE`): a wrong command
 * sends someone typing something that doesn't exist, where "run the CLI and
 * follow its own prompts" always works.
 */
import type { AgentId } from "@vibespace/shared";

/** The one agent this file makes a specific claim about, and why: Claude
 * Code's first-run browser login (or reading `ANTHROPIC_API_KEY` from the
 * environment if already set) is standard, current, documented behaviour —
 * not a guess. */
const KNOWN_LOGIN_NOTES: Partial<Record<AgentId, string>> = {
  claude: "Run `claude` — on first use it opens a browser to sign in, or reads ANTHROPIC_API_KEY if you've already set it.",
};

/** The honest fallback for every agent whose exact login command this file
 * doesn't claim to know. */
export const GENERIC_LOGIN_NOTE = "Manages its own sign-in — run its CLI directly and follow its own login prompt.";

/** The login note to show for `agentId` — a known, verified command if this
 * file has one, otherwise the honest generic fallback above. */
export function loginNoteFor(agentId: AgentId): string {
  return KNOWN_LOGIN_NOTES[agentId] ?? GENERIC_LOGIN_NOTE;
}
