// Phase 11b (PARITY #51): the desktop build's update banner. See
// updater.ts's top comment for the full UX reasoning — the short version:
// check silently in the background, only ever ask before restarting.
//
// This component is a no-op in the browser build. `isTauriApp()` (the same
// `?vibespaceDesktop=1` marker check `matchShortcut`'s `isDesktop` branch
// uses, see keymap.ts) gates BOTH the network-touching effect below AND the
// render — the effect check stops it from ever calling into
// `@tauri-apps/plugin-updater` outside a real Tauri webview (where the
// Rust-side plugin isn't registered and the call would just fail anyway,
// but there's no reason to even try), and the render check keeps this
// component invisible in the browser build even if somehow rendered there.
import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isTauriApp } from "../keys/keymap.js";
import {
  CHECK_INTERVAL_MS,
  INITIAL_DOWNLOAD_PROGRESS,
  formatDownloadProgress,
  loadDismissedVersion,
  reduceDownloadProgress,
  saveDismissedVersion,
  shouldShowUpdateBanner,
  type DownloadProgressState,
} from "./updater.js";

type Phase = "idle" | "downloading" | "error";

export default function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => loadDismissedVersion());
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<DownloadProgressState>(INITIAL_DOWNLOAD_PROGRESS);
  const [error, setError] = useState<string | null>(null);
  // Tracks the currently-held `Update` resource so a later check that finds
  // a DIFFERENT update (or no update at all) can release the previous
  // one's backend handle — `Update` extends Tauri's `Resource` class
  // specifically because it holds onto native state that isn't automatically
  // freed just because a React re-render replaced the JS reference to it.
  const heldUpdateRef = useRef<Update | null>(null);

  useEffect(() => {
    if (!isTauriApp()) return;

    let cancelled = false;

    const runCheck = () => {
      check()
        .then((found) => {
          if (cancelled) return;
          if (heldUpdateRef.current && heldUpdateRef.current !== found) {
            heldUpdateRef.current.close().catch(() => {
              // Best-effort cleanup — a failure here has no user-visible
              // consequence beyond a slightly-delayed resource free.
            });
          }
          heldUpdateRef.current = found;
          setUpdate(found);
        })
        .catch(() => {
          // Deliberately silent. See updater.ts's top comment: offline, a
          // GitHub outage, a corporate proxy blocking the request — none of
          // these are the user's problem to see an error about. The next
          // scheduled check (or the next app launch) just tries again.
        });
    };

    runCheck();
    const intervalId = window.setInterval(runCheck, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      heldUpdateRef.current?.close().catch(() => {});
    };
  }, []);

  const handleDismiss = useCallback(() => {
    if (!update) return;
    saveDismissedVersion(update.version);
    setDismissedVersion(update.version);
  }, [update]);

  const handleUpdate = useCallback(() => {
    if (!update) return;
    setPhase("downloading");
    setError(null);
    setProgress(INITIAL_DOWNLOAD_PROGRESS);
    update
      .downloadAndInstall((event) => {
        setProgress((prev) => reduceDownloadProgress(prev, event));
      })
      // This is the ONLY place in the whole app that restarts the process —
      // and it only runs after `downloadAndInstall` resolves, which only
      // happens after the user has already clicked "Update & Restart"
      // below. No background timer, no silent path, ever calls this.
      .then(() => relaunch())
      .catch((err: unknown) => {
        setPhase("error");
        setError(err instanceof Error ? err.message : "Update failed");
      });
  }, [update]);

  const latestVersion = update?.version ?? null;
  if (!isTauriApp() || !update || !shouldShowUpdateBanner(latestVersion, dismissedVersion)) {
    return null;
  }

  return (
    <div style={bannerStyle} role="status">
      {phase === "downloading" ? (
        <span>
          Downloading vibespace {update.version}… {formatDownloadProgress(progress)}
        </span>
      ) : phase === "error" ? (
        <>
          <span>Update failed{error ? `: ${error}` : ""}.</span>
          <button style={primaryButtonStyle} onClick={handleUpdate}>
            Retry
          </button>
          <button style={secondaryButtonStyle} onClick={handleDismiss}>
            Dismiss
          </button>
        </>
      ) : (
        <>
          <span>Vibespace {update.version} is available.</span>
          <button style={primaryButtonStyle} onClick={handleUpdate}>
            Update &amp; Restart
          </button>
          <button style={secondaryButtonStyle} onClick={handleDismiss}>
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}

// Same visual language as App.tsx's confirmBannerStyle (a full-width strip
// under the header) but keyed off `--vd-accent` instead of `--vd-warn` —
// this isn't a destructive confirmation, it's informational.
const bannerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 12px",
  background: "color-mix(in srgb, var(--vd-accent) 14%, var(--vd-bg))",
  borderBottom: "1px solid var(--vd-accent)",
  fontSize: 12,
  flexWrap: "wrap",
  flexShrink: 0,
};

const primaryButtonStyle: React.CSSProperties = {
  background: "var(--vd-accent)",
  color: "var(--vd-accent-text)",
  border: "none",
  borderRadius: 4,
  padding: "4px 12px",
  fontSize: 12,
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  background: "transparent",
  color: "var(--vd-text-muted)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "4px 12px",
  fontSize: 12,
  cursor: "pointer",
};
