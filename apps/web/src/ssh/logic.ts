/**
 * Pure display logic for SSH connection profiles — zero React, zero DOM,
 * same "plain data-in/data-out functions, testable under plain vitest"
 * split this codebase already uses for `grid/agentPicker.ts` and
 * `grid/agentVisuals.tsx`'s `agentAccentVar`. `SshProfiles.tsx` (the
 * management page) and `grid/PaneView.tsx` (the empty-pane picker's SSH
 * group) both call straight into this rather than re-implementing it.
 */

/** The minimal shape `formatSshDestination` needs — a structural subset of
 * `SshProfile` so callers can pass either a real profile or a form's
 * in-progress draft state without a type mismatch. */
export interface SshDestinationLike {
  host: string;
  user: string | null;
  port: number | null;
}

/**
 * Renders a profile's connection target the way a person would type it at
 * a terminal: `user@host` (or just `host` with no user set), plus `:port`
 * ONLY when a non-default port is configured. This is what a list row's
 * subtitle and the empty-pane picker's row both show underneath a
 * profile's name, so at a glance you know WHERE a profile connects without
 * opening it.
 */
export function formatSshDestination(profile: SshDestinationLike): string {
  const target = profile.user ? `${profile.user}@${profile.host}` : profile.host;
  return profile.port !== null ? `${target}:${profile.port}` : target;
}

/**
 * One-line summary of what happens after connecting, for a profile's list
 * row / picker row — e.g. `"cd's to /srv/app, then runs a startup command"`,
 * or `null` if the profile sets neither (the plainest possible connection).
 * Mirrors the SAME "what does this actually do" framing
 * `apps/server/src/ssh/spawn.ts`'s `buildRemoteCommand` implements
 * server-side — this is the read-only, English description of that.
 */
export function describeSshWorkspace(profile: {
  defaultDirectory: string | null;
  startupCommand: string | null;
}): string | null {
  const hasDir = Boolean(profile.defaultDirectory?.trim());
  const hasCmd = Boolean(profile.startupCommand?.trim());
  if (hasDir && hasCmd) return `cd's to ${profile.defaultDirectory}, then runs a startup command`;
  if (hasDir) return `cd's to ${profile.defaultDirectory}`;
  if (hasCmd) return "runs a startup command on connect";
  return null;
}

/** Sorts profiles by name, case-insensitively — the same order the server's
 * `GET /api/ssh-profiles` already returns them in (see
 * `apps/server/src/ssh/store.ts`'s `list()`), duplicated here purely so the
 * picker/list UI has one obvious place to re-sort if it ever needs to
 * render a locally-mutated copy (e.g. right after a create/duplicate,
 * before the next full refetch) without waiting on a round-trip. */
export function sortSshProfilesByName<T extends { name: string }>(profiles: readonly T[]): T[] {
  return [...profiles].sort((a, b) => a.name.localeCompare(b.name));
}

/** True if `name` (already trimmed) is a valid SSH profile name — mirrors
 * the server's own "non-empty string" check (`apps/server/src/ssh/
 * routes.ts`'s `validateRequiredField`) so the form can show an inline
 * error before ever submitting, instead of only learning about it from a
 * 400 response. */
export function isValidSshProfileName(name: string): boolean {
  return name.trim().length > 0;
}

/** Same non-empty check for `host` — a profile with no name/host is
 * meaningless (there's nothing to connect to), unlike every other field
 * (`user`/`port`/`defaultDirectory`/`startupCommand`), which are optional
 * by design (see `SshProfile`'s doc comment in
 * `packages/shared/src/protocol.ts`). */
export function isValidSshProfileHost(host: string): boolean {
  return host.trim().length > 0;
}

/** Parses a form's raw port input (a text field's string value) into the
 * shape the API expects: `null` for an empty field ("use ssh's own
 * default"), a valid integer 1-65535, or `undefined` to signal "not a
 * valid port" so the caller can show an inline error instead of silently
 * sending garbage. Kept out of the component itself so the parsing rule is
 * independently testable, same "don't just trust the client widget"
 * discipline `agents/Agents.tsx`'s own length-cap re-check follows. */
export function parseSshPortInput(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > 65535) return undefined;
  return value;
}
