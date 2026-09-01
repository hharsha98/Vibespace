/**
 * Shared back-compat helper for the vibedeck -> vibespace localStorage key
 * rename. Every persisted preference in this app moved from a
 * `vibedeck.*` key to a `vibespace.*` one alongside the project's rename
 * (theme, terminal prefs, settings section, rail/dock collapsed state,
 * default agent, notification preference, dismissed updater version — see
 * this function's call sites in themes.ts, terminalPrefs.ts, sections.ts,
 * App.tsx, notificationPrefs.ts, and updater.ts). Without this helper, a
 * returning user's browser still has every value sitting under the OLD
 * key, and a plain `localStorage.getItem(newKey)` would come back `null`
 * — every preference silently resetting to its default on first load
 * after an upgrade, even though the data is right there.
 *
 * Same localStorage discipline every persisted preference in this app
 * already follows (`themes.ts`'s `loadStoredThemeId` is the canonical
 * example): guarded by `typeof window === "undefined"` for SSR/Node, and
 * wrapped in try/catch because private-browsing Safari throws on ANY
 * localStorage access, not just writes. A failure anywhere in this
 * function — reading either key, or writing the migrated value back —
 * degrades to "behave as if nothing was stored" (return `null`) rather
 * than throwing; losing a preference for one session is fine, crashing the
 * app over it is not.
 */

/**
 * Reads `key`; if it has a value, returns it (the common case, once a
 * browser has already been migrated). Otherwise falls back to `legacyKey`
 * — if THAT has a value, migrates it forward: writes it to `key`, removes
 * `legacyKey`, and returns it, so every read after the first one goes
 * straight to `key` again without ever consulting `legacyKey`. Returns
 * `null` if neither key has a value, or if localStorage isn't available at
 * all.
 *
 * Returns the raw stored string, same contract as `localStorage.getItem`
 * itself — every call site still owns turning that into whatever type/
 * default it actually needs (a boolean string, a JSON blob, a bare id).
 */
export function readWithLegacyFallback(key: string, legacyKey: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const current = window.localStorage.getItem(key);
    if (current !== null) return current;

    const legacy = window.localStorage.getItem(legacyKey);
    if (legacy === null) return null;

    // Migrate forward. Wrapped separately from the reads above so that if
    // storage is full/disabled for WRITES specifically, the value already
    // read from the legacy key is still returned for this load — it just
    // won't have been migrated yet, so the same fallback simply runs again
    // next time. Not worth surfacing to the user either way.
    try {
      window.localStorage.setItem(key, legacy);
      window.localStorage.removeItem(legacyKey);
    } catch {
      // Storage full or disabled — see comment above.
    }
    return legacy;
  } catch {
    return null; // Private-browsing Safari throws on ANY access, not just writes.
  }
}
