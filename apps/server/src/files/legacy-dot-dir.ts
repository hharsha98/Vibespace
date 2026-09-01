/**
 * Shared migration for the workspace-local `.vibespace/` dot-directory —
 * every project folder a user has ever opened may have one, holding memory
 * notes (`memory/store.ts`'s `MEMORY_DIR_NAME`), pasted images
 * (`files/paste-image.ts`'s `PASTE_IMAGE_DIR_NAME`), and skills
 * (`skills/discover.ts`) all together under one directory. Unlike the
 * global data directory (`db/schema.ts`'s `resolveDataDir`), there is no
 * list of every workspace a user has ever opened for the app to walk at
 * startup — so instead of a one-time startup migration, each workspace
 * migrates itself LAZILY, the first time something is about to WRITE into
 * it (see this function's callers: `ensureMemoryDir` in memory/store.ts,
 * and the paste-image write site in files/routes.ts).
 *
 * `discover.ts` (skills) is deliberately NOT a caller here — that module
 * is read-only by design (see its own top comment on the project-scope
 * trust boundary: it must never mutate a user's repo just because someone
 * opened the Skills tab). It instead scans the legacy `.vibedeck/skills`
 * location directly, alongside `.vibespace/skills`, without ever renaming
 * anything — see that file's own scope list.
 */
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

const NEW_DOT_DIR = ".vibespace";
const LEGACY_DOT_DIR = ".vibedeck";

/**
 * Renames `<root>/.vibedeck` to `<root>/.vibespace` in place — one move
 * carries memory notes, pastes, and skills across together, since they all
 * live under the same dot-directory. No-ops (cheap: just an `existsSync`
 * call) once `<root>/.vibespace` already exists, which is the common case
 * on every call after the first successful migration; also no-ops if
 * neither directory exists (a workspace that's never written any of this
 * state yet).
 *
 * Same failure handling as `db/schema.ts`'s `resolveDataDir`: `renameSync`
 * can throw (EXDEV for a symlinked/cross-device workspace, EACCES/EPERM
 * for a permissions problem, ENOTEMPTY in some odd edge case), and none of
 * that is this user's fault or worth crashing a request over. On failure
 * this logs a one-line warning to stderr and simply returns — it never
 * throws. The legacy directory is left exactly as it was, and every caller
 * of this function unconditionally proceeds to its own `mkdirSync` right
 * afterward regardless of whether the migration succeeded, so a failed
 * migration never blocks the write that triggered this call; it just means
 * `.vibedeck` and a freshly created, initially-empty `.vibespace` end up
 * sitting side by side until whatever blocked the rename gets fixed.
 */
export function migrateLegacyWorkspaceDotDir(root: string): void {
  const target = join(root, NEW_DOT_DIR);
  if (existsSync(target)) return; // already migrated — the common case, and cheap to check

  const legacy = join(root, LEGACY_DOT_DIR);
  if (!existsSync(legacy)) return; // nothing to migrate

  try {
    renameSync(legacy, target);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `vibespace: could not migrate workspace directory "${legacy}" to "${target}" (${reason}); ` +
        `leaving "${legacy}" in place.\n`
    );
  }
}
