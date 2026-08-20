/**
 * Pure logic behind the empty-pane agent picker's BridgeSpace-parity
 * layout: which agents show in the main two-column grid vs. collapse
 * behind the "N more not installed" disclosure row, and the "Launch more
 * than one..." multi-select.
 *
 * Zero React, zero DOM — same split this codebase already uses elsewhere
 * (tree.ts's tree surgery, agentVisuals.tsx's `agentAccentVar`): plain
 * data-in/data-out functions so agentPicker.test.ts can exercise every
 * branch under plain vitest, with no browser test infrastructure needed.
 * PaneView.tsx (the JSX) calls straight into these rather than
 * re-implementing any of this logic inline.
 */
import type { AgentId } from "@vibedeck/shared";

/**
 * The minimal shape these functions need from an agent option. Deliberately
 * NOT importing PaneView.tsx's `AgentOption` type here — PaneView.tsx
 * imports FROM this file, so importing back from it would create a cycle.
 * Every real `AgentOption` already satisfies this structurally.
 */
export interface AvailabilityLike {
  id: AgentId;
  available: boolean;
}

/**
 * Splits a list of agents into the ones ready to run now and the ones that
 * aren't (missing binary) — order preserved within each group. This is what
 * decides the picker's main grid (available) vs. the collapsed "N more not
 * installed" disclosure (unavailable), matching BridgeSpace V3's
 * photographed picker instead of showing every agent, greyed out, inline.
 */
export function splitByAvailability<T extends AvailabilityLike>(
  agents: readonly T[]
): { available: T[]; unavailable: T[] } {
  const available: T[] = [];
  const unavailable: T[] = [];
  for (const agent of agents) {
    (agent.available ? available : unavailable).push(agent);
  }
  return { available, unavailable };
}

/**
 * The cap on how many agents "Launch more than one..." can start at once.
 *
 * This is the SMALLEST HONEST VERSION of BridgeSpace's multi-launch: it
 * splits the current pane once (side by side) and starts one agent in each
 * half — see App.tsx's `handleLaunchMultiple`. Generalising to an arbitrary
 * N-way balanced split (the same way tree.ts's `buildTemplate` builds a
 * fresh N-pane grid) would need a new tree.ts primitive to split an
 * EXISTING pane into N (not just build N fresh leaves) plus N concurrent
 * `POST /api/sessions` calls reconciled back into one tree update — a
 * bigger change than the picker redesign itself, and not attempted here.
 * 2 is the most this wiring supports; the picker's own UI disables further
 * selection once this cap is hit rather than silently accepting more.
 */
export const MAX_MULTI_LAUNCH = 2;

/**
 * Pure toggle logic for the multi-select checkboxes: selecting an agent
 * that's already selected deselects it; selecting a new one appends it,
 * UNLESS the selection is already at `MAX_MULTI_LAUNCH`, in which case the
 * click is a no-op. The picker's own UI also disables the unselected
 * checkboxes once the cap is hit, but this function enforces the same rule
 * independently of the UI, so the invariant holds even if a caller forgets.
 */
export function toggleMultiLaunchSelection(selected: readonly AgentId[], id: AgentId): AgentId[] {
  if (selected.includes(id)) {
    return selected.filter((s) => s !== id);
  }
  if (selected.length >= MAX_MULTI_LAUNCH) {
    return [...selected];
  }
  return [...selected, id];
}

/**
 * How many panes a multi-launch of `selected.length` agents needs — always
 * one pane per selected agent (the pane the picker is already in, plus one
 * new sibling per additional agent). Kept as its own function rather than
 * inlining `.length` at call sites so a future generalisation beyond 2-way
 * splitting (see `MAX_MULTI_LAUNCH`'s comment) has one obvious place to
 * change the pane-count contract, and so the invariant is directly
 * testable rather than implied.
 */
export function panesNeededForLaunch(selected: readonly AgentId[]): number {
  return selected.length;
}

/**
 * Whether a multi-launch selection is actually launchable: at least 2
 * agents chosen (selecting just 1 is the ordinary single-agent picker, not
 * a "multi" launch) and no more than `MAX_MULTI_LAUNCH`. Drives the
 * "Launch N" confirm button's disabled state in PaneView.tsx.
 */
export function canLaunchMultiple(selected: readonly AgentId[]): boolean {
  return selected.length >= 2 && selected.length <= MAX_MULTI_LAUNCH;
}
