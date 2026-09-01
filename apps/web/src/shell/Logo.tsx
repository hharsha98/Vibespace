/**
 * vibespace's own mark.
 *
 * The logo is the product: a pane grid with one pane filled. That filled
 * pane is the *focused* pane — the same idea the app expresses everywhere
 * else with the accent focus border. One big pane on the left, two stacked
 * on the right, which is the layout you get from a vertical split followed
 * by a horizontal one.
 *
 * Deliberate constraints:
 *  - Four shapes only, so it stays legible at 16px as a favicon.
 *  - Drawn in `currentColor`, so it inherits whatever the active theme's
 *    text colour is instead of fighting 26 different palettes.
 *  - No wordmark inside the SVG — the word "vibespace" is set in live text
 *    beside it, so it stays selectable and themeable.
 */

export interface LogoProps {
  /** Rendered width and height in px. Defaults to 16 to suit the 36px top bar. */
  size?: number;
  /** Colour of the filled "focused" pane. Defaults to the theme accent. */
  accent?: string;
}

export default function Logo({ size = 16, accent = "var(--vd-accent)" }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      // Decorative: the adjacent "vibespace" text already names the app, so
      // announcing it twice to a screen reader would just be noise.
      aria-hidden="true"
      focusable="false"
    >
      {/* The deck: the outer frame every pane lives in. */}
      <rect
        x="2.75"
        y="3.75"
        width="18.5"
        height="16.5"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      {/* Vertical split. */}
      <path d="M10.25 4V20" stroke="currentColor" strokeWidth="1.5" />
      {/* Horizontal split, right half only. */}
      <path d="M10.25 12h11" stroke="currentColor" strokeWidth="1.5" />
      {/* The focused pane. */}
      <rect x="4.75" y="5.75" width="3.5" height="12.5" rx="1.25" fill={accent} />
    </svg>
  );
}
