// Phase 11b (PARITY #51): pure logic behind the desktop build's update
// banner (UpdateBanner.tsx). Split out from that component specifically so
// the decision logic — "should the banner show", "how far along is the
// download" — is unit-testable without a Tauri runtime, the same reasoning
// keymap.ts's own top comment gives for `matchShortcut` taking a plain
// boolean instead of touching the DOM.
//
// # The UX decision this file exists to support, and why
//
// vibespace's desktop app hosts long-lived terminal sessions — real agent
// work that can run for hours. An update that silently restarts the app
// would kill every one of those sessions' underlying processes without
// warning (see docs/DESKTOP.md's "Shutdown" section: closing the window
// already tears down every pty). That is unacceptable for a background
// check the user never asked to run right now. So the desktop build:
//
//  1. Checks for updates on startup, then periodically (`CHECK_INTERVAL_MS`)
//     — silently. A failed check (offline, GitHub unreachable, whatever)
//     is swallowed with nothing shown to the user; see UpdateBanner.tsx's
//     `runCheck` for where that happens. A background check must never
//     block startup or look like an error.
//  2. If (and only if) an update IS found, shows a small, dismissible
//     banner — never a modal, never anything that blocks the rest of the
//     app. `shouldShowUpdateBanner` below is what decides "have we already
//     shown this exact version and been told to go away".
//  3. Only downloads/installs/restarts when the user clicks "Update &
//     Restart" — an explicit, one-click action, never automatic. There is
//     no code path in this app that restarts it without that click.
import { readWithLegacyFallback } from "../settings/legacyStorage.js";

/** How often to re-check for updates while the app stays open — long
 * enough not to hammer GitHub Releases on every launch of a session that
 * runs for days, short enough that "an update has been out for a week and
 * nobody's seen the banner" doesn't happen either. */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

const DISMISSED_VERSION_KEY = "vibespace.updater.dismissedVersion";
// The pre-rename key this project shipped under as vibedeck — see
// `legacyStorage.ts`'s top comment for why every persisted preference in
// this app reads a legacy key as a fallback.
const LEGACY_DISMISSED_VERSION_KEY = "vibedeck.updater.dismissedVersion";

/** Same try/catch-around-localStorage pattern as themes.ts's
 * `loadStoredThemeId`/`saveThemeId` and App.tsx's `loadBoolPref`/
 * `saveBoolPref` — private-browsing Safari throws on ANY localStorage
 * access, not just writes. Not that private browsing applies to the
 * desktop build's webview specifically, but there's no reason to invent a
 * second pattern for the one localStorage read/write this file needs. */
export function loadDismissedVersion(): string | null {
  return readWithLegacyFallback(DISMISSED_VERSION_KEY, LEGACY_DISMISSED_VERSION_KEY);
}

export function saveDismissedVersion(version: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISMISSED_VERSION_KEY, version);
  } catch {
    // Storage full or disabled — the dismissal still applies for this
    // session (component state already hid the banner); it just won't be
    // remembered next launch. Not worth surfacing to the user.
  }
}

/** Whether the update banner should be visible right now. Pure so it's
 * trivially testable: an update is "available" only when `latestVersion`
 * is non-null (mirrors `check()`'s own `Update | null` return — Tauri's
 * updater already does the semver comparison against the running app's
 * version server-side, this never re-does that), AND the user hasn't
 * already dismissed THIS SPECIFIC version. Dismissing v1.2.0 doesn't
 * suppress a later v1.3.0 — each new version gets to ask once. */
export function shouldShowUpdateBanner(
  latestVersion: string | null,
  dismissedVersion: string | null
): boolean {
  return latestVersion !== null && latestVersion !== dismissedVersion;
}

/** Mirrors `@tauri-apps/plugin-updater`'s `DownloadEvent` union shape,
 * duplicated here (rather than importing the real type) so this module —
 * and its tests — never need the actual plugin package to exist as a
 * runtime dependency, only as a structural shape. */
export type DownloadEventLike =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export interface DownloadProgressState {
  downloadedBytes: number;
  /** `null` until a `Started` event reports it (or if the server never
   * sent a Content-Length) — `formatDownloadProgress` falls back to a
   * plain byte count instead of a percentage when this is null. */
  totalBytes: number | null;
}

export const INITIAL_DOWNLOAD_PROGRESS: DownloadProgressState = {
  downloadedBytes: 0,
  totalBytes: null,
};

/** Pure reducer over the download event stream `Update.downloadAndInstall`
 * hands its progress callback — kept separate from that callback itself so
 * the accumulation logic (chunks summing into a running total, "Finished"
 * snapping to 100% even if the summed chunks didn't land exactly on
 * `totalBytes`) is testable without actually downloading anything. */
export function reduceDownloadProgress(
  state: DownloadProgressState,
  event: DownloadEventLike
): DownloadProgressState {
  switch (event.event) {
    case "Started":
      return { downloadedBytes: 0, totalBytes: event.data.contentLength ?? null };
    case "Progress":
      return { ...state, downloadedBytes: state.downloadedBytes + event.data.chunkLength };
    case "Finished":
      // Chunk sizes summing to slightly under/over the reported
      // Content-Length is normal (chunked transfer, compression) — snap to
      // 100% rather than show e.g. "97%" once the download is actually done.
      return state.totalBytes !== null ? { ...state, downloadedBytes: state.totalBytes } : state;
    default:
      return state;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Human-readable label for the current download state — a percentage
 * when the server reported a Content-Length, a running byte count when it
 * didn't (some proxies/CDNs strip it). */
export function formatDownloadProgress(state: DownloadProgressState): string {
  if (state.totalBytes === null || state.totalBytes === 0) {
    return `${formatBytes(state.downloadedBytes)} downloaded`;
  }
  const pct = Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100));
  return `${pct}%`;
}
