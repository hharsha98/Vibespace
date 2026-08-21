/**
 * Pure logic behind dragging a skill onto a running pane — PARITY #37's
 * actual "drag" half (see docs/PARITY.md row 37 and docs/SKILLS.md's
 * "Injecting a skill into a running pane" section for the server side this
 * ultimately calls into).
 *
 * The reason this drag lives in `shell/RightDock.tsx` and not
 * `skills/Skills.tsx` is architectural, not a preference: every centre view
 * (Terminals, Editor, Board, ... Skills) is mounted with CSS `display: none`
 * while some OTHER centre view is active (see App.tsx's `CenterView` top
 * comment), so a pane never has a layout box to drop ONTO while the Skills
 * tab is the one showing — see Skills.tsx's own top comment, which explains
 * exactly this and is why that view still only offers a click-based
 * "Send to pane…" control. The right dock has no such problem: it's a
 * persistent side panel, rendered alongside the pane grid no matter which
 * centre view is active, so a skill row living there can genuinely be
 * dragged onto a pane that's on screen at the same time.
 *
 * Everything DOM-touching (the actual `draggable`/`onDragStart` JSX in
 * RightDock.tsx, the `onDragOver`/`onDrop` JSX in grid/PaneView.tsx) lives
 * in those two components; this module is just the serialise/parse/
 * predicate triangle the two need to agree on, kept pure and plain-Node
 * testable — same "logic file" convention as term/pendingCommand.ts or
 * this very directory's own logic.ts.
 */
import type { SessionInfo } from "@vibedeck/shared";

/**
 * A dedicated MIME type for the drag payload — deliberately NOT
 * `text/plain`. Browsers populate `text/plain` for all sorts of unrelated
 * drags (a URL bar selection, a word dragged out of another app's window, a
 * Finder file's name, ...); if a pane's `drop` handler read `text/plain`
 * and treated whatever text landed there as a skill name, dragging any
 * innocuous piece of text from somewhere else on the OS onto a running pane
 * would silently attempt to type it in as if it were a chosen skill.
 * Scoping the payload to a type only vibedeck itself ever writes means a
 * pane's drop handler can trust that if this type is present in
 * `dataTransfer`, the drag genuinely originated from the skills dock —
 * anything else is ignored outright, never guessed at from its text
 * content.
 */
export const SKILL_DRAG_MIME_TYPE = "application/x-vibedeck-skill";

/**
 * The shape carried in `dataTransfer` under `SKILL_DRAG_MIME_TYPE` —
 * deliberately just the skill's `name`. `POST /api/skills/:name/inject`
 * (see skills/sendToPane.ts) addresses a skill by name alone; there's no
 * reason to serialise a `SkillCatalogEntry`'s description or scope into the
 * drag payload just because the object happens to carry them.
 */
export interface SkillDragPayload {
  name: string;
}

/** Turns a skill into the exact string a `dragstart` handler writes to
 * `dataTransfer.setData(SKILL_DRAG_MIME_TYPE, ...)`. */
export function serializeSkillDragPayload(skill: { name: string }): string {
  return JSON.stringify({ name: skill.name } satisfies SkillDragPayload);
}

/**
 * The inverse of `serializeSkillDragPayload`, called from a pane's `drop`
 * handler against whatever `dataTransfer.getData(SKILL_DRAG_MIME_TYPE)`
 * returns. Returns `null` — never throws — for anything that isn't
 * recognisably a skill payload: no data at all, invalid JSON, or valid JSON
 * that isn't shaped like `{ name: string }`.
 *
 * That "null means nothing to do" contract is what makes it safe for a
 * pane's drop handler to call this unconditionally on every drop rather
 * than pre-validating `dataTransfer.types` first: a drop of unrelated
 * content (a browser tab, a bookmark, a file dragged in from Finder) simply
 * never carries `SKILL_DRAG_MIME_TYPE` at all, so `getData` for it returns
 * `""`, which fails the same way deliberately malformed input would — the
 * caller doesn't need a separate code path for "wrong type" vs "garbage of
 * the right type".
 */
export function parseSkillDragPayload(raw: string | null | undefined): SkillDragPayload | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const name = (parsed as { name?: unknown }).name;
  if (typeof name !== "string" || name.length === 0) return null;
  return { name };
}

/**
 * Can this pane receive a dropped skill? `session` should be whatever
 * grid/PaneView.tsx's own `session` prop currently is — `null` for both an
 * ordinary empty pane AND a pane sitting on a deferred/not-yet-restored
 * record (PaneView never populates `session` for a `deferred` pane; see
 * that component's own `sessionId`/`deferred`/`session` props), so this
 * function doesn't need to tell the two apart — "no live session attached"
 * is the only fact that matters for whether a drop can land anywhere at
 * all.
 *
 * A session that has already exited (`status !== "running"`) is refused for
 * the same underlying reason an empty pane is: its pty is dead, there is
 * nowhere for injected keystrokes to go, even though the pane still shows
 * old scrollback and `sessionId` is technically non-null.
 *
 * A `shell` agent is refused too, mirroring `skills/logic.ts`'s own
 * `paneInjectionTargets` — and, one level further down, the server's
 * `prepareSkillInjection` (`apps/server/src/skills/inject.ts`), which
 * returns a 400 for exactly this case: a shell pane isn't an agent, it
 * would just try to *execute* a skill's body as a command, so it's no more
 * an honest drop target than an empty pane is. Keeping this predicate in
 * sync with that eligibility rule (rather than re-deriving a looser one) is
 * what stops the drop-highlight from ever lighting up for a pane the server
 * would refuse anyway.
 */
export function canPaneAcceptSkill(session: SessionInfo | null): boolean {
  return session !== null && session.status === "running" && session.agent !== "shell";
}
