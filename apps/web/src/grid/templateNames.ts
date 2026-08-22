/**
 * BridgeSpace names its layout templates instead of showing bare pane
 * counts — "Single", "Split", "Quad", "Six", and so on up to 16. This is the
 * one place that naming lives: a plain lookup table plus a `templateLabel`
 * formatter, kept separate from `grid/tree.ts`'s `buildTemplate` (which
 * only cares about the NUMBER of panes, never a display name) and from
 * App.tsx's command-palette entries (which call `templateLabel` instead of
 * hand-formatting "Layout: N panes" the way it used to).
 *
 * No DOM, no React — plain data in, data out, so it's unit-testable under
 * plain Node/vitest, same "logic in its own pure module" split
 * `term/fitIfVisible.ts` and `settings/sections.ts` already use.
 */

/** Every pane count `grid/tree.ts`'s `buildTemplate` supports, named. Must
 * stay in sync with that file's own `SUPPORTED_TEMPLATE_SIZES` — there is
 * no shared import between the two (tree.ts's list is private) because this
 * is purely a display concern, never a structural one; `templateLabel`'s
 * fallback below covers any size that's supported but not named here. */
const TEMPLATE_NAMES: Readonly<Record<number, string>> = {
  1: "Single",
  2: "Split",
  4: "Quad",
  6: "Six",
  8: "Eight",
  10: "Ten",
  12: "Twelve",
  14: "Fourteen",
  16: "Sixteen",
};

/**
 * The display label for an `n`-pane template — e.g. `templateLabel(4)` ->
 * `"Quad (4)"`. The number always stays visible alongside the name (per
 * this feature's own instruction: naming the templates shouldn't make the
 * actual pane count any harder to see at a glance). Falls back to a bare
 * `"N panes"` for a supported-but-unnamed size, so a future template size
 * added to `tree.ts` without also being named here still renders something
 * sensible instead of `"undefined (N)"`.
 */
export function templateLabel(n: number): string {
  const name = TEMPLATE_NAMES[n];
  return name ? `${name} (${n})` : `${n} pane${n === 1 ? "" : "s"}`;
}
