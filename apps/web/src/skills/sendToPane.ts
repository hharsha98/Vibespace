/**
 * The ONE place `POST /api/skills/:name/inject` is called from the browser.
 * Both of this app's two ways to send a skill into a running pane —
 * skills/Skills.tsx's click-based "Send to pane…" control (the keyboard-
 * accessible original) and shell/RightDock.tsx's drag-and-drop onto
 * grid/PaneView.tsx (PARITY #37's actual "drag", added alongside it, not in
 * place of it) — call this SAME function rather than each keeping its own
 * `fetch`. That's a deliberate requirement, not just tidiness: the two
 * paths must always agree on exactly what "sent" means, and duplicating the
 * fetch would eventually let them drift (one path getting a bugfix, an
 * error-message tweak, or a body-shape change the other misses).
 *
 * Mirrors docs/SKILLS.md's "Injecting a skill into a running pane" section:
 * a resolved promise here means the skill's body was TYPED into the pane's
 * pty, via the exact same keystroke path a human typing would use — it is
 * NEVER a signal that the agent on the other end actually read or acted on
 * it. Every caller's UI copy must preserve that distinction; see
 * Skills.tsx's `PaneSendSection` for the canonical wording ("Typed into the
 * pane — check it acted on it"), which grid/PaneView.tsx's drop handler
 * reuses verbatim rather than inventing its own.
 */

/** What a successful injection tells the caller — `truncated` mirrors the
 * server's own response field (see apps/server/src/skills/inject.ts's
 * `SKILL_INJECT_MAX_LENGTH`): the skill's description+body got typed in,
 * but was cut off because it exceeded the cap. */
export interface SendSkillToPaneResult {
  truncated: boolean;
}

/**
 * Types `skillName`'s body into `sessionId`'s pane. Rejects with an `Error`
 * carrying the server's own explanation on any failure — a 404 (skill or
 * session no longer exists), a 400 (a shell pane, which can't act on a
 * skill), or a network failure — so every caller can show that message
 * as-is instead of re-deriving its own.
 */
export async function sendSkillToPane(
  skillName: string,
  sessionId: string,
  workspaceId: string
): Promise<SendSkillToPaneResult> {
  const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}/inject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, workspaceId }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; truncated?: boolean };
  if (!res.ok) {
    throw new Error(body.error ?? `Server responded with ${res.status}`);
  }
  return { truncated: Boolean(body.truncated) };
}
