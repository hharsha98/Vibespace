/**
 * Pure decision logic for `POST /api/files/paste-image` (see
 * `routes.ts`) — BridgeSpace parity item 2: pasting a screenshot into an
 * agent pane. Agent CLIs (claude, cursor-agent, codex) read an image by its
 * file PATH, not a clipboard bitmap, so the server side of this feature is
 * "write the bytes somewhere inside the workspace, then hand back a
 * relative path" — this module is only the "somewhere" decision (which
 * extension, which relative path), kept pure and separate from the actual
 * `fs` write so it's testable without touching disk.
 *
 * `now`/`id` are ALWAYS passed in, never read here (`Date.now()`,
 * `randomUUID()`) — same "no clock/randomness inside pure logic" rule
 * `session-manager.ts`'s `buildSpawnEnv` and `blocks.ts` already follow in
 * this codebase, for the same reason: it's what lets `paste-image.test.ts`
 * assert an exact output string instead of a regex.
 */

/** Workspace-relative directory pasted images land in — the SAME
 * `.vibespace` dot-directory the workspace already owns for tool-generated,
 * workspace-scoped state that isn't meant to be hand-edited (see
 * `memory/store.ts`'s `MEMORY_DIR_NAME`, `.vibespace/memory`, for the
 * existing precedent this follows). Keeping pasted images here — not the
 * workspace root itself — means they don't clutter a file-tree browse, sit
 * next to the memory notes that already live under the same dot-dir, and
 * are easy for a project to `.gitignore` as one group if it wants to. */
export const PASTE_IMAGE_DIR_NAME = ".vibespace/pastes";

/** Small, deliberate allowlist — an image MIME type not in this map is
 * refused outright (see `pickPasteImagePath` below) rather than written
 * with a guessed or missing extension. Covers every format a screenshot
 * tool or "copy image" browser action is realistically going to produce. */
const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export type PickPasteImagePathResult = { ok: true; relPath: string } | { ok: false; error: string };

/**
 * Picks the workspace-relative path a pasted image should be written to,
 * given its MIME type. Returns an error (not a guessed path) for any MIME
 * type outside `EXTENSION_BY_MIME_TYPE` — e.g. a pasted PDF or SVG
 * mis-tagged as an image should be refused, not silently written with the
 * wrong extension (or none at all).
 */
export function pickPasteImagePath(mimeType: string, now: number, id: string): PickPasteImagePathResult {
  const ext = EXTENSION_BY_MIME_TYPE[mimeType];
  if (!ext) {
    return { ok: false, error: `Unsupported image type: "${mimeType}"` };
  }
  return { ok: true, relPath: `${PASTE_IMAGE_DIR_NAME}/paste-${now}-${id}${ext}` };
}
