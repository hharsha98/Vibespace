/**
 * The shared spacing/radius/elevation scales behind the Phase "premium
 * re-skin" pass (see docs/DESIGN.md §4). Before this file, every component
 * scattered its own magic numbers (`padding: 6`, `padding: 8`, `borderRadius:
 * 4` vs `6` vs `8`...) with no shared reasoning for which value applied
 * where — which is exactly how a UI ends up looking inconsistent even
 * though no single number is "wrong". Pulling them out into one small,
 * dependency-free module means every component reads `SPACE.md` instead of
 * a bare `12`, so the *scale itself* stays a design decision made once here,
 * not re-decided ad hoc at each call site.
 *
 * Deliberately plain numbers/strings, not CSS custom properties — unlike
 * the *colour* tokens in themes.ts, spacing/radius/shadow never vary by
 * theme (docs/DESIGN.md's spacing/shape rules apply identically to all 26
 * themes), so there's no per-theme value to swap at runtime. A CSS variable
 * would add indirection for zero benefit here.
 *
 * No DOM, no React import — safe to import from a plain vitest/Node test
 * (see tokens.test.ts), same reasoning as themes.ts's own top comment.
 */

/**
 * The 4px spacing scale docs/DESIGN.md §4 already named informally
 * (`4 / 8 / 12 / 16px`), now with an `xl` step for the more generous
 * breathing room a card grid (the empty-pane agent picker) or a page-level
 * section needs — chrome controls stay on the tight end of the scale,
 * content surfaces get to use the looser end.
 */
export const SPACE = {
  /** 4px — the tightest gap: icon-to-label, a pill's own padding. */
  xs: 4,
  /** 8px — the rail/dock's standard internal padding and row gap. */
  sm: 8,
  /** 12px — gaps between grouped controls, card internal padding. */
  md: 12,
  /** 16px — a card's outer padding, page-level section gaps. */
  lg: 16,
  /** 24px — generous breathing room: the empty-pane state, a page header. */
  xl: 24,
} as const;

/**
 * Corner radii. docs/DESIGN.md §4 named three ad hoc ("6px panes and cards,
 * 4px pills and small controls, 10px overlays"); `md`/`sm`/`lg` below are
 * exactly those three, plus `xl` for the new, more generous empty-pane
 * agent cards, which sit further from the rest of the dense chrome and can
 * afford to look a little softer.
 */
export const RADIUS = {
  /** 4px — pills, small buttons, list rows. */
  sm: 4,
  /** 6px — panes, standard cards, popovers. */
  md: 6,
  /** 10px — command palette, big overlays. */
  lg: 10,
  /** 14px — the empty-pane agent cards; large surfaces the eye lingers on. */
  xl: 14,
} as const;

/**
 * Elevation shadows. docs/DESIGN.md §4 originally said "depth comes from
 * surface layering, not shadows. Only floating overlays get a shadow" — the
 * premium-pass instruction ("introduce a proper elevation system... soft
 * shadows") extends that rule rather than replacing it: layering is still
 * the PRIMARY depth cue (surface -> surfaceRaised), shadows are now a
 * secondary, subtle reinforcement for surfaces that sit further forward
 * (a pane lifted off the canvas, a hovered card, a popover). They stay soft
 * and neutral (plain black at low alpha) rather than tinted, so they read
 * the same "this is closer to me" cue on every one of the 26 themes,
 * including the one light theme — a black shadow under a raised surface is
 * legible on a light canvas too, it just naturally reads as lighter contrast
 * than on a dark one, which is the correct behaviour, not a bug to special-
 * case away. This mirrors the one hard-coded shadow that already existed
 * pre-this-phase (WorkspaceRail's colour-picker popover).
 */
export const SHADOW = {
  /** Barely-there lift — a pane resting off the black canvas. */
  sm: "0 1px 2px rgba(0, 0, 0, 0.28)",
  /** A hovered/raised card — the empty-pane agent cards, a lifted list row. */
  md: "0 6px 16px rgba(0, 0, 0, 0.32)",
  /** Floating overlays — popovers, the command palette, menus. */
  lg: "0 12px 32px rgba(0, 0, 0, 0.4)",
} as const;

/**
 * Type scale. docs/DESIGN.md §3 named the base sizes (12px body, 11px meta,
 * 13px headings) but Phase 4.5 never named a step ABOVE 13px, which is
 * exactly what "everything is one size" complaints traced back to — there
 * was no bigger step for a real headline (e.g. the empty-pane state's
 * title) to use. `heading` is that missing step; everything else here is
 * the existing scale given names so call sites read `FONT.body` instead of
 * a bare `12` indistinguishable from every other bare number in the file.
 */
export const FONT = {
  /** 10px — uppercase section labels (WORKSPACES, FILES), badges. */
  label: 10,
  /** 11px — meta text: hints, timestamps, secondary chip text. */
  meta: 11,
  /** 12px — body text, the base size for dense chrome. */
  body: 12,
  /** 13px — headings: pane titles worth emphasising, dialog titles. */
  title: 13,
  /** 15px — a real headline: the empty-pane state's "Start an agent". */
  heading: 15,
} as const;
