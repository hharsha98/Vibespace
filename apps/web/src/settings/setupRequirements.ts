/**
 * The Setup section's copy, pulled out as plain data rather than left inline
 * in Settings.tsx's JSX — same reasoning as billingContent.ts's own top
 * comment: this repo's web package has no jsdom/testing-library, so a plain
 * exported array is the only DOM-free way to unit-test what actually reaches
 * the screen (see this file's own test).
 *
 * Why this section exists at all: a person who clones this repo from GitHub
 * and just runs the installer hits four real first-run snags that, before
 * this section existed, were only written down in README.md — a file
 * they've already left behind once the app is open. Grepping
 * apps/web/src and apps/desktop/loading for "Gatekeeper" or "Node 22" turned
 * up nothing; this is that gap, closed inside the app itself instead of only
 * in a doc a new user may never scroll back to.
 *
 * Each entry is written for someone new to coding (see this repo's own
 * target audience) — plain English first, a technical term only where there
 * genuinely isn't a plain-English substitute, and even then explained
 * inline in parentheses rather than assumed.
 */

export interface SetupRequirement {
  id: string;
  /** Shown as the item's short heading. */
  title: string;
  /** Plain-English explanation of why this matters and what to do about it. */
  body: string;
  /** Optional "read more" link shown after the body — e.g. where to download Node. */
  href?: string;
  /** Label for `href`. Required when `href` is set, ignored otherwise. */
  linkLabel?: string;
}

export const SETUP_REQUIREMENTS: readonly SetupRequirement[] = [
  {
    id: "node",
    title: "Node.js 22 or newer must be installed",
    body: "Vibespace runs real terminals and a real database through Node (the JavaScript runtime its server is built on) — and the installer does not bundle a Node runtime of its own. If Node isn't already on your machine, or your copy is older than version 22, install it first.",
    href: "https://nodejs.org",
    linkLabel: "Download Node.js",
  },
  {
    id: "gatekeeper",
    title: "macOS first launch: right-click the app → Open → Open",
    body: 'The app isn’t signed with a paid Apple developer certificate, so Gatekeeper (macOS’s built-in "is this app safe?" check) blocks a plain double-click the first time you open it. Right-click (or Control-click) the app, choose Open, then click Open again in the dialog that appears. This is expected behaviour, not a sign that anything is wrong or broken.',
  },
  {
    id: "agent-clis",
    title: "Agent CLIs are not bundled — bring your own",
    body: "Claude Code, Cursor Agent, Codex, and the other agent CLIs are separate programs you install and log into yourself, entirely outside Vibespace. Vibespace just launches whichever ones it finds already on your PATH (the list of folders your shell searches when you type a command). Check Settings → Agents to see which ones it found.",
  },
  {
    id: "platform",
    title: "macOS is the verified platform",
    body: "The Windows and Linux packages build successfully in CI (continuous integration — automated builds that run on every change), but nobody has actually installed and launched them yet. If you try one, expect rough edges.",
  },
];
