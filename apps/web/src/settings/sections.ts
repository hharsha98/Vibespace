/**
 * The Settings rail's section list, plus persistence for which one was last
 * selected — split out from Settings.tsx itself so both the component and
 * `sections.test.ts` can import the same plain data/functions without
 * needing a DOM (this repo's web package has no jsdom/testing-library
 * dependency at all — see this file's test for why that shapes how it's
 * checked).
 *
 * The list mirrors BridgeSpace v3.2.1's nine-section Settings sidebar
 * (Appearance · Terminal · Shortcuts · Agents · Accounts · API Keys ·
 * Billing · Notifications · About), with one addition: `history`. Session
 * recovery has no BridgeSpace equivalent slot, but it's a real vibedeck
 * feature that already lived inside Settings.tsx before this rail existed
 * (see History.tsx's own top comment) — dropping it to make the count line
 * up with BridgeSpace's nine would remove working functionality for the
 * sake of parity theatre, so it stays, placed next to Agents (its existing
 * neighbour on the old single-scroll page).
 */

export type SettingsSectionId =
  | "appearance"
  | "terminal"
  | "shortcuts"
  | "agents"
  | "history"
  | "accounts"
  | "api-keys"
  | "billing"
  | "notifications"
  | "about";

export interface SettingsSectionMeta {
  id: SettingsSectionId;
  /** Shown in the rail and used as the section heading. */
  label: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "agents", label: "Agents" },
  { id: "history", label: "History" },
  { id: "accounts", label: "Accounts" },
  { id: "api-keys", label: "API Keys" },
  { id: "billing", label: "Billing" },
  { id: "notifications", label: "Notifications" },
  { id: "about", label: "About" },
];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "appearance";

const SETTINGS_SECTION_IDS = new Set<string>(SETTINGS_SECTIONS.map((s) => s.id));

function isSettingsSectionId(value: string | null): value is SettingsSectionId {
  return value !== null && SETTINGS_SECTION_IDS.has(value);
}

// Same "vibedeck.<owner>.<thing>" dotted-key convention as
// RAIL_COLLAPSED_KEY ("vibedeck.rail.collapsed") / DOCK_COLLAPSED_KEY
// ("vibedeck.dock.collapsed") in App.tsx, and the same try/catch-around-
// localStorage shape every persisted preference in this app already uses
// (themes.ts's loadStoredThemeId/saveThemeId is the canonical one) —
// private-browsing Safari throws on ANY localStorage access, not just
// writes, so both directions need a guard.
const SETTINGS_SECTION_KEY = "vibedeck.settings.section";

/** The last section the user had open, or the default if nothing's stored
 * (first visit) or the stored value doesn't name a section this build still
 * has (e.g. left over from a renamed/removed one). */
export function loadSettingsSection(): SettingsSectionId {
  if (typeof window === "undefined") return DEFAULT_SETTINGS_SECTION;
  try {
    const raw = window.localStorage.getItem(SETTINGS_SECTION_KEY);
    return isSettingsSectionId(raw) ? raw : DEFAULT_SETTINGS_SECTION;
  } catch {
    return DEFAULT_SETTINGS_SECTION; // Private-browsing Safari throws on access, not just on write.
  }
}

/** Persists the selected section so reopening Settings (or reloading the
 * page) returns to where the user left off, instead of always resetting to
 * Appearance. */
export function saveSettingsSection(id: SettingsSectionId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SETTINGS_SECTION_KEY, id);
  } catch {
    // Storage full or disabled — the selection still applies for this
    // session, it just won't be remembered next time. Not worth surfacing.
  }
}

/**
 * Roving-focus arithmetic for the rail's `role="tablist"` keyboard handling
 * (WAI-ARIA APG's "only the active tab is tabbable, arrow keys move
 * between them" pattern — see Settings.tsx's `onKeyDown` on the tablist).
 * Pure and DOM-free on purpose: `sections.test.ts` can exercise every key
 * without a browser, the same reason `keymap.ts`'s `matchShortcut` takes a
 * plain `KeyEventLike` instead of a real `KeyboardEvent`.
 *
 * Returns the new index to focus/select, or `null` if `key` isn't one this
 * rail handles (the caller should fall through to default browser
 * behaviour in that case).
 */
export function nextRailIndex(current: number, key: string, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
