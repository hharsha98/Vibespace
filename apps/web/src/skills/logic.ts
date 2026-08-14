/**
 * Pure logic behind the Skills view (Phase 10, PARITY #37) — no DOM, no
 * `fetch`, unit-testable under plain Node/vitest, same reasoning as every
 * other pure-logic module in this app (see `keys/keymap.ts`'s top comment,
 * or `prompts/logic.ts`, whose `groupPromptsByScope` this file's
 * `groupSkillsByScope` is deliberately modelled on).
 *
 * The server side of Phase 10 (`apps/server/src/skills/*`) has no matching
 * types in `@vibedeck/shared` — skills are the one REST surface in this
 * app that never grew a shared-package type, presumably because they're
 * addressed by filesystem root rather than a SQLite-backed resource (see
 * `docs/SKILLS.md`'s "Unlike the board/agent/prompt tools..." note). So
 * `SkillCatalogEntry`/`SkillDetail`/`SkillDiagnostic` below are this web
 * app's own copy of the JSON shapes `apps/server/src/skills/discover.ts`'s
 * `catalogEntry`/`fullSkill` and `apps/server/src/skills/parse.ts`'s
 * `SkillDiagnostic` actually produce — kept in sync by hand, same as every
 * other REST response this codebase types on the client side without a
 * shared package (e.g. `HealthResponse` in App.tsx).
 */
import type { AgentId, SessionInfo } from "@vibedeck/shared";

export type SkillScopeKind = "user" | "project";

export interface SkillScope {
  kind: SkillScopeKind;
  /** Which of the three conventional subdirectories this came from, e.g.
   * ".claude/skills" — see `docs/SKILLS.md`'s scope table. */
  dirLabel: string;
  /** Absolute path to the scope ROOT (not this skill's own directory). */
  rootDir: string;
}

/** The catalog shape `GET /api/skills` returns per skill — name/description
 * plus enough metadata to decide whether to read further, deliberately
 * WITHOUT the body (progressive disclosure; see docs/SKILLS.md). */
export interface SkillCatalogEntry {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  scope: SkillScope;
  /** Absolute path to this skill's own directory. */
  dir: string;
}

/** The full shape `GET /api/skills/:name` returns — everything the catalog
 * has, plus `body`/`metadata`/`allowedTools`. */
export interface SkillDetail extends SkillCatalogEntry {
  metadata: Record<string, string>;
  allowedTools: string | null;
  body: string;
}

export interface SkillDiagnostic {
  level: "warning" | "error";
  message: string;
}

/**
 * Case-insensitive substring match over name + description — the search
 * box this view needs per its own spec ("this machine has ~68 real skills
 * installed... make it usable at that size"). Empty/whitespace-only query
 * returns every skill, same "no query = no filtering" convention as
 * `files/QuickOpen.js`'s fuzzy matcher falling through on an empty string.
 */
export function filterSkills(skills: readonly SkillCatalogEntry[], query: string): SkillCatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...skills];
  return skills.filter(
    (skill) => skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q)
  );
}

export interface GroupedSkills {
  /** Scoped to the repository being worked on — see docs/SKILLS.md's
   * "trust boundary" section: this is content a `git clone` brought in,
   * not necessarily reviewed by the person running vibedeck. */
  project: SkillCatalogEntry[];
  /** Scoped to the user's own machine (`~/.agents`, `~/.vibedeck`,
   * `~/.claude`) — not tied to whichever repo happens to be open. */
  user: SkillCatalogEntry[];
}

/**
 * Splits the catalog into project-scoped vs. user-scoped groups, each
 * alphabetised by name — the server's own order is scan order (user scopes
 * 1-3, then project scopes 4-6; see `discover.ts`'s `buildScopeList`), not
 * alphabetical, which stops mattering the moment there are more than a
 * handful of skills. Pure and independent per group, same shape
 * `prompts/logic.ts`'s `groupPromptsByScope` uses for global/workspace.
 */
export function groupSkillsByScope(skills: readonly SkillCatalogEntry[]): GroupedSkills {
  const project: SkillCatalogEntry[] = [];
  const user: SkillCatalogEntry[] = [];
  for (const skill of skills) {
    (skill.scope.kind === "project" ? project : user).push(skill);
  }
  const byName = (a: SkillCatalogEntry, b: SkillCatalogEntry) => a.name.localeCompare(b.name);
  project.sort(byName);
  user.sort(byName);
  return { project, user };
}

/** One pane currently on screen with a live session attached — the input
 * shape App.tsx builds from `listPanes(root)` + the live `sessions` array,
 * scoped to just the active workspace's own grid (not every session on the
 * server — a pane in some OTHER workspace isn't a sensible injection
 * target for a skill browsed in this one). */
export interface PaneRef {
  paneId: string;
  /** 0-based position in `listPanes()`'s left-to-right order — same index
   * the "focus pane N" shortcuts use, so "Pane 3" here means the same pane
   * Cmd+3 would focus. */
  index: number;
  session: SessionInfo;
}

/**
 * A pane the "Send to pane…" control can target, decorated with whether it
 * actually CAN receive a skill. `shell` panes are always listed rather
 * than silently omitted — PARITY #37's spec is explicit that a
 * non-droppable target should be indicated, not just absent, so a user
 * with only a shell pane open isn't left wondering why the list is empty.
 */
export interface PaneInjectionTarget {
  paneId: string;
  sessionId: string;
  agent: AgentId;
  /** e.g. "Pane 2 — claude". */
  label: string;
  /** False for a `shell` pane — mirrors `apps/server/src/skills/inject.ts`'s
   * `prepareSkillInjection`, which refuses shell panes with a 400. This
   * flag lets the UI grey the row out BEFORE a request is ever made; the
   * server's own refusal (and its exact wording) is still surfaced if a
   * request somehow reaches it anyway (e.g. a stale pane list). */
  eligible: boolean;
}

export function paneInjectionTargets(panes: readonly PaneRef[]): PaneInjectionTarget[] {
  return panes.map(({ paneId, index, session }) => ({
    paneId,
    sessionId: session.id,
    agent: session.agent,
    label: `Pane ${index + 1} — ${session.agent}`,
    eligible: session.agent !== "shell",
  }));
}
