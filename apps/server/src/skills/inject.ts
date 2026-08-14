/**
 * Turns a discovered skill into pty input — this is Phase 10's actual point
 * (PARITY #37: "drag a skill onto a running pane"). Shares two hard rules
 * with `../board/dispatch.ts`'s `buildDispatchPrompt`, which solved this
 * exact problem for board cards first, and this file reuses that solution
 * rather than re-implementing it:
 *
 *  (a) a bare newline in a TUI agent's pty is "submit" — a multi-line skill
 *      body written raw would submit itself in ragged fragments instead of
 *      landing as one message. Every character actually written is folded
 *      through dispatch.ts's own `toSingleLine` (imported, not copied) and
 *      ends in exactly ONE trailing newline — the deliberate submit.
 *  (b) a `shell` pane is not an agent. It cannot act on an English
 *      instruction like a skill body — it would just try to *execute* it as
 *      a command and spew errors, the same reasoning `dispatch.ts`'s top
 *      comment gives for withholding taskKnowledge/preambles from shell
 *      panes. Unlike a board card (whose body a human wrote AS the command
 *      when targeting shell), a skill body has no sensible "command"
 *      reading at all — so injection into a shell pane is refused outright
 *      with a clear error rather than guessing at one.
 */
import type { AgentId } from "@vibedeck/shared";
import { toSingleLine } from "../board/dispatch.js";
import type { ParsedSkill } from "./parse.js";

/**
 * Cap on how much of a skill's description + body is actually typed into a
 * pty. `SKILL.md` bodies are meant to be concise instructions per the spec
 * — bulk reference material belongs in `references/`, which injection never
 * reads at all, only `SKILL.md`'s own body reaches the pane — so this is a
 * safety net against an outlier file, not a limit real skills should hit.
 * A body over the cap is TRUNCATED with a trailing marker rather than the
 * whole injection being rejected: a partial skill is still useful context,
 * whereas refusing outright over a length technicality is not.
 */
export const SKILL_INJECT_MAX_LENGTH = 20_000;

export type PrepareSkillInjectionResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; error: string };

/** Builds the exact text a pty receives for `skill`: a short `[vibedeck]`
 * label naming the skill, then its full body, folded through
 * `toSingleLine` and capped per `SKILL_INJECT_MAX_LENGTH`. Exported
 * separately from `prepareSkillInjection` so injection.test.ts can assert
 * on the text shape (newline-folding, truncation) without also exercising
 * the shell/agent branch below. */
export function buildSkillInjectionText(skill: ParsedSkill): { text: string; truncated: boolean } {
  const raw = `[vibedeck] Skill "${skill.name}": ${skill.description}\n\n${skill.body}`;
  const folded = toSingleLine(raw);
  if (folded.length <= SKILL_INJECT_MAX_LENGTH) {
    return { text: `${folded}\n`, truncated: false };
  }
  return { text: `${folded.slice(0, SKILL_INJECT_MAX_LENGTH)} …[truncated]\n`, truncated: true };
}

/**
 * Decides whether `agent` may receive `skill` at all, and if so, returns
 * the exact text to write. Does NOT itself call `sessionManager.write` —
 * the caller (routes.ts) does that once it also knows the session actually
 * exists, the same "build the text, then the caller writes it" split
 * `board/dispatch.ts`'s `buildDispatchPrompt`/`writePromptWhenReady` use.
 */
export function prepareSkillInjection(agent: AgentId, skill: ParsedSkill): PrepareSkillInjectionResult {
  if (agent === "shell") {
    return {
      ok: false,
      error:
        'The "shell" pane cannot receive a skill — a shell executes commands, it cannot act on an ' +
        "English instruction. Inject into an agent pane (claude, cursor-agent, or codex) instead.",
    };
  }
  const { text, truncated } = buildSkillInjectionText(skill);
  return { ok: true, text, truncated };
}
