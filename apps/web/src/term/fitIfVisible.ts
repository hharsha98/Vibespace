/**
 * Guard for xterm's FitAddon: only fit a terminal that is actually on
 * screen.
 *
 * FitAddon derives cols/rows by dividing the container's measured pixel box
 * by one character cell. A HIDDEN container measures zero, so that division
 * yields a degenerate grid — which xterm then reports through `onResize`,
 * which `Terminal.tsx` forwards to the SERVER as a real pty resize. The pty
 * genuinely becomes that size, and it stays broken after the pane is
 * visible again, because nothing ever tells the pty to go back.
 *
 * That is not hypothetical. It was found by hand, in a browser: changing
 * any terminal preference (font size, cursor style, scrollback) left the
 * shell stuck at ~11 columns with its prompt wrapped in half and typing no
 * longer echoing. The trigger is unavoidable by design — those preferences
 * live in the SETTINGS view, so at the instant they change, the terminal is
 * always the hidden view.
 *
 * `offsetWidth`/`offsetHeight` are 0 both for a `display: none` subtree and
 * for a genuinely zero-sized box, which is exactly the set of cases where
 * fitting is meaningless. Nothing is lost by skipping them: becoming
 * visible is itself a size change, so the ResizeObserver fires and fits
 * with real numbers.
 *
 * Split out of `Terminal.tsx` purely so it can be tested. This package has
 * no jsdom (see `settings/Settings.sourceChecks.test.ts`), so `Terminal.tsx`
 * itself cannot be imported in a test — it pulls in React and xterm, which
 * need a DOM. The parameters are therefore structural rather than
 * `HTMLElement`/`FitAddon`: the real types satisfy them, and a test can
 * pass plain objects.
 */

/** Just the part of an element this needs — an `HTMLElement` satisfies it. */
export interface MeasurableElement {
  offsetWidth: number;
  offsetHeight: number;
}

/** Just the part of FitAddon this needs — the real addon satisfies it. */
export interface Fittable {
  fit: () => void;
}

/**
 * Calls `fitAddon.fit()` only if `container` currently occupies a non-zero
 * box. Returns true if it fitted, false if it declined — the boolean is
 * what makes this observable to a test.
 */
export function fitIfVisible(container: MeasurableElement, fitAddon: Fittable): boolean {
  if (container.offsetWidth === 0 || container.offsetHeight === 0) return false;
  fitAddon.fit();
  return true;
}
