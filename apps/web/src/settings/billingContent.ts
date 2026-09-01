/**
 * The Billing section's copy, pulled out as plain data rather than left
 * inline in Settings.tsx's JSX, so `billingContent.test.ts` can scan the
 * exact text the UI renders for the one thing this section must never
 * contain: a price, a plan tier, or an upgrade/subscribe control. (This
 * repo's web package has no jsdom/testing-library — see that test file's
 * own comment — so checking the rendered DOM directly isn't an option;
 * checking the source-of-truth data the component renders verbatim is the
 * closest DOM-free equivalent, and catches the exact regression the
 * honesty requirement cares about: someone later "helpfully" adding a
 * price or an upgrade button to this section.)
 *
 * The honest story, stated once here instead of re-derived per call site:
 * vibespace is MIT-licensed and free. There is no vibespace subscription, no
 * tier, nothing to upgrade. Any real cost is the user's OWN Anthropic /
 * OpenAI / Cursor / etc. account — vibespace spawns their CLI in a pty and
 * never sees, stores, or proxies a request to any of those providers'
 * billing systems (see docs/SSH.md's "we don't sit in the middle of your
 * credentials" reasoning for the same posture applied to SSH auth).
 */

export const BILLING_PARAGRAPHS: readonly string[] = [
  "vibespace is free and open source (MIT licensed). There is nothing to pay for here, and nothing on this page to sign up for.",
  "Any real cost comes from your own Anthropic, OpenAI, Cursor, Google, or other provider account — whichever CLI you're running (Claude Code, Codex, Cursor Agent, Gemini CLI, ...). vibespace spawns that CLI directly in a real terminal session; it never sits between you and what you owe that provider, and never sees or forwards your usage to anyone.",
  "If a CLI is metering your usage, that CLI's own account dashboard — not vibespace — is the source of truth for what you're spending.",
];
