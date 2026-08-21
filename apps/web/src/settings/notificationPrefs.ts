/**
 * The "notify me when an agent finishes" preference, plus the actual
 * delivery mechanism. Two genuinely separate concerns, both here:
 *
 *  - The PREFERENCE (`loadNotifyOnAgentIdle`/`saveNotifyOnAgentIdle`) is
 *    just another localStorage boolean, same try/catch-around-storage shape
 *    as App.tsx's `loadBoolPref`/`saveBoolPref`.
 *  - DELIVERY uses the browser's real `Notification` API. Per this
 *    project's own hard rule (and the browser's own: an unprompted
 *    permission request outside a user gesture is silently ignored, or
 *    worse, treated as an abuse signal by some browsers), permission is
 *    ONLY ever requested from `requestNotificationPermission` below, and
 *    that function is only ever called from Settings.tsx's button
 *    `onClick` — never from an effect, never on mount. `notifyAgentIdle`
 *    (Terminal.tsx's one call site) never requests permission itself; if
 *    it was never granted, it just no-ops.
 *
 * What "finishes" means here is exactly the same busy -> idle transition
 * Terminal.tsx already computes for the per-pane prompt bar (see
 * promptQueue.ts's top comment): EXACT, from OSC 133, for shell panes;
 * a HEURISTIC (output-quiet-for-750ms) for agent TUI panes (claude/
 * cursor-agent/codex/...), which will sometimes fire early (an agent
 * "thinking" with no stdout reads as idle) or notify for "went quiet
 * waiting on you to type" rather than "fully done" — both of which this
 * file is honest about wanting to cover: the Settings copy for this
 * preference says "finishes or goes idle (waiting for input)", not just
 * "finishes", precisely because the heuristic can't tell those apart.
 */

const NOTIFY_KEY = "vibedeck.notifyOnAgentIdle";

/** Whether the "notify when an agent finishes" preference is turned on.
 * Defaults to off — this is a new preference, and opting a returning user
 * into desktop notifications without them ever having touched Settings
 * would be a surprise, not a convenience. */
export function loadNotifyOnAgentIdle(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(NOTIFY_KEY) === "true";
  } catch {
    return false; // Private-browsing Safari throws on access, not just on write.
  }
}

export function saveNotifyOnAgentIdle(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NOTIFY_KEY, String(value));
  } catch {
    // Storage full or disabled — same reasoning as saveThemeId in themes.ts.
  }
}

/** What the `Notification` API reports right now — `"unsupported"` covers
 * both "no `Notification` global at all" (some browsers/embedded webviews)
 * and, implicitly, SSR/Node. Read fresh on every call rather than cached:
 * the user can revoke a granted permission from the browser's own UI at any
 * time, completely outside this app's control. */
export function getNotificationPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/**
 * Settings.tsx's "Enable browser notifications" button `onClick` — and the
 * ONLY place in this file that ever calls the real
 * `Notification.requestPermission()`. Must only ever be reached from a real
 * click handler; calling it from a `useEffect` (even one that only runs
 * once on mount) is exactly the "requested permission on page load" mistake
 * this file's own top comment rules out.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.requestPermission();
}

/**
 * Terminal.tsx's one call site — fired every time a pane's busy/idle
 * tracking transitions working -> idle (see this file's top comment for
 * exactly what that does and doesn't mean). A no-op unless ALL of: the
 * preference is on, permission was already granted (never requested here),
 * and the browser tab itself isn't the foreground one right now — so this
 * never nags someone who's actively watching the pane finish, only someone
 * who's switched away.
 */
export function notifyAgentIdle(agentLabel: string): void {
  if (!loadNotifyOnAgentIdle()) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && !document.hidden) return;
  try {
    new Notification("vibedeck", { body: `${agentLabel} is idle — finished, or waiting for input.` });
  } catch {
    // Some platforms throw synchronously from the constructor itself rather
    // than just not supporting it — never worth crashing a pane's status
    // transition over a notification.
  }
}
