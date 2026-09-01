/**
 * The Settings screen (Phase 9.5c, PARITY #45; two-column rail added for
 * BridgeSpace v3.2.1 parity): a real centre view for preferences that were
 * previously scattered across the top bar, following the same "fetch/own
 * nothing beyond what's passed in, render it" shape as Agents.tsx/
 * Prompts.tsx (see App.tsx's `CenterView`).
 *
 * --- The rail ---
 * BridgeSpace presents Settings as a left rail of section names plus the
 * selected section's content on the right, rather than one long scroll —
 * this file now matches that shape. `sections.ts` owns the section list,
 * the "which one is selected" persistence, and the keyboard-navigation
 * arithmetic, all as plain DOM-free functions (see that file's own top
 * comment for why: this repo's web package has no jsdom/testing-library
 * dependency, so anything meant to be unit-tested has to be testable
 * without a browser). The rail itself is a real `role="tablist"` of
 * `<button>` elements — not clickable `<div>`s — with roving-tabindex
 * arrow-key navigation (`nextRailIndex`), the same accessible pattern
 * App.tsx's own top-bar view switcher (`ViewTabButton`, `role="tab"` +
 * `aria-selected`) already established; this rail follows it rather than
 * inventing a second convention.
 *
 * --- What's here, and why nothing more ---
 * Per this feature's own repeated instruction ("gather what already exists
 * rather than inventing new preferences"), this mirrors — doesn't move —
 * the nav bar's theme swatch button (still there, still Cmd+Shift+T) and
 * default-agent `<select>`: both keep working exactly as before, and
 * Settings is simply a second, more spacious place to reach the same
 * controls. The keyboard shortcut table is DERIVED from `KEYMAP` (never
 * hand-typed — see shortcutRows.ts), the same rule KeyboardCheatSheet.tsx
 * already follows.
 *
 * BridgeSpace's nine sections (Appearance · Terminal · Shortcuts · Agents ·
 * Accounts · API Keys · Billing · Notifications · About) are all here, plus
 * one addition — History (session recovery) — which has no BridgeSpace
 * equivalent slot but is a real vibespace feature that isn't getting dropped
 * for the sake of matching a competitor's section count; see sections.ts's
 * own comment.
 *
 * --- Persistence ---
 * Every preference rendered here is persisted the same way: theme via
 * themes.ts's saveThemeId/localStorage, default agent via App.tsx's
 * saveDefaultAgent, the selected rail section via sections.ts's
 * saveSettingsSection, terminal display prefs via terminalPrefs.ts, and the
 * notification preference via notificationPrefs.ts — all localStorage,
 * all the same try/catch shape. localStorage is this project's one
 * established settings-persistence mechanism (there is no server-side
 * "preferences" table), so nothing added by this pass invents a second one.
 */
import { useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { AgentId, SessionInfo, Workspace } from "@vibespace/shared";
import { KEYMAP, formatShortcut, isMacPlatform, isTauriApp } from "../keys/keymap.js";
import { THEMES } from "../themes/themes.js";
import { ThemeSection } from "../themes/ThemePicker.js";
import type { AgentOption } from "../grid/PaneView.js";
import { AgentGlyph } from "../grid/agentVisuals.js";
import { Button, Pill } from "../shell/ui.js";
import { FONT, RADIUS, SPACE } from "../shell/tokens.js";
import HistorySection from "./History.js";
import {
  SETTINGS_SECTIONS,
  loadSettingsSection,
  nextRailIndex,
  saveSettingsSection,
  type SettingsSectionId,
} from "./sections.js";
import { getShortcutRows } from "./shortcutRows.js";
import {
  clampFontSize,
  clampScrollback,
  loadTerminalPrefs,
  saveTerminalPrefs,
  type CursorStyle,
  type TerminalPrefs,
} from "./terminalPrefs.js";
import {
  getNotificationPermission,
  loadNotifyOnAgentIdle,
  requestNotificationPermission,
  saveNotifyOnAgentIdle,
} from "./notificationPrefs.js";
import { loginNoteFor } from "./accounts.js";
import { BILLING_PARAGRAPHS } from "./billingContent.js";

export interface SettingsProps {
  themeId: string;
  onThemeChange: (id: string) => void;
  defaultAgent: AgentId | "";
  onDefaultAgentChange: (id: AgentId) => void;
  agents: AgentOption[];
  /** Session recovery: every known workspace, so History can resolve a
   * record's `workspaceId` to a human-readable name. */
  workspaces: Workspace[];
  /** Session recovery: fired once a History "Resume" action succeeds — see
   * History.tsx's own top comment for why App.tsx (not History itself)
   * decides where the resumed session lands. */
  onSessionResumed: (session: SessionInfo) => void;
}

export default function Settings({
  themeId,
  onThemeChange,
  defaultAgent,
  onDefaultAgentChange,
  agents,
  workspaces,
  onSessionResumed,
}: SettingsProps) {
  const [activeSection, setActiveSectionState] = useState<SettingsSectionId>(() => loadSettingsSection());
  const railButtonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const setActiveSection = (id: SettingsSectionId) => {
    setActiveSectionState(id);
    saveSettingsSection(id);
  };

  const handleRailKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = SETTINGS_SECTIONS.findIndex((s) => s.id === activeSection);
    const nextIndex = nextRailIndex(currentIndex, event.key, SETTINGS_SECTIONS.length);
    if (nextIndex === null) return;
    event.preventDefault();
    const next = SETTINGS_SECTIONS[nextIndex];
    setActiveSection(next.id);
    railButtonRefs.current[nextIndex]?.focus();
  };

  const activeMeta = SETTINGS_SECTIONS.find((s) => s.id === activeSection) ?? SETTINGS_SECTIONS[0];

  return (
    <div style={pageStyle}>
      <div
        role="tablist"
        aria-label="Settings sections"
        aria-orientation="vertical"
        onKeyDown={handleRailKeyDown}
        style={railStyle}
      >
        <div style={railHeaderStyle}>Settings</div>
        {SETTINGS_SECTIONS.map((section, index) => {
          const active = section.id === activeSection;
          return (
            <button
              key={section.id}
              ref={(el) => {
                railButtonRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => setActiveSection(section.id)}
              style={railItemStyle(active)}
            >
              {section.label}
            </button>
          );
        })}
      </div>

      <div style={contentPaneStyle}>
        <div style={innerStyle}>
          <h2 style={pageTitleStyle}>{activeMeta.label}</h2>

          {activeSection === "appearance" && (
            <AppearanceSection themeId={themeId} onThemeChange={onThemeChange} />
          )}
          {activeSection === "terminal" && <TerminalSection />}
          {activeSection === "shortcuts" && <ShortcutsSection />}
          {activeSection === "agents" && (
            <AgentsSection agents={agents} defaultAgent={defaultAgent} onDefaultAgentChange={onDefaultAgentChange} />
          )}
          {activeSection === "history" && (
            <HistorySection workspaces={workspaces} onSessionResumed={onSessionResumed} />
          )}
          {activeSection === "accounts" && <AccountsSection agents={agents} />}
          {activeSection === "api-keys" && <ApiKeysSection />}
          {activeSection === "billing" && <BillingSection />}
          {activeSection === "notifications" && <NotificationsSection />}
          {activeSection === "about" && <AboutSection />}
        </div>
      </div>
    </div>
  );
}

// --- Appearance (unchanged content, moved from the old single-scroll page) -

function AppearanceSection({ themeId, onThemeChange }: { themeId: string; onThemeChange: (id: string) => void }) {
  const isMac = isMacPlatform();
  const darkThemes = THEMES.filter((t) => t.isDark);
  const lightThemes = THEMES.filter((t) => !t.isDark);
  return (
    <>
      <p style={sectionHintStyle}>
        Same picker as the nav bar's theme button (or{" "}
        {formatShortcut(KEYMAP.find((s) => s.id === "theme-picker")!, isMac)}) — pick a theme here, or there; both
        stay in sync.
      </p>
      <ThemeSection label="Dark" themes={darkThemes} currentThemeId={themeId} onSelect={onThemeChange} />
      <ThemeSection label="Light" themes={lightThemes} currentThemeId={themeId} onSelect={onThemeChange} />
    </>
  );
}

// --- Terminal (new, real preferences — see terminalPrefs.ts) --------------

function TerminalSection() {
  const [prefs, setPrefs] = useState<TerminalPrefs>(() => loadTerminalPrefs());

  const update = (patch: Partial<TerminalPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    saveTerminalPrefs(next);
  };

  return (
    <>
      <p style={sectionHintStyle}>
        Applies live to every open terminal pane, not just ones opened after you change it — xterm re-reads these
        options immediately, the same way switching themes already recolours a terminal that's mid-session.
      </p>

      <label style={labelStyle}>
        <span style={labelTextStyle}>Font size ({prefs.fontSize}px)</span>
        <ClampedNumberInput
          min={9}
          max={24}
          step={1}
          value={prefs.fontSize}
          clamp={clampFontSize}
          onCommit={(fontSize) => update({ fontSize })}
        />
      </label>

      <label style={labelStyle}>
        <span style={labelTextStyle}>Cursor style</span>
        <select
          value={prefs.cursorStyle}
          onChange={(e) => update({ cursorStyle: e.target.value as CursorStyle })}
          style={selectStyle}
        >
          <option value="block">Block</option>
          <option value="underline">Underline</option>
          <option value="bar">Bar</option>
        </select>
      </label>

      <label style={checkboxRowStyle}>
        <input type="checkbox" checked={prefs.cursorBlink} onChange={(e) => update({ cursorBlink: e.target.checked })} />
        <span style={labelTextStyle}>Cursor blink</span>
      </label>

      <label style={labelStyle}>
        <span style={labelTextStyle}>Scrollback ({prefs.scrollback.toLocaleString()} lines)</span>
        <ClampedNumberInput
          min={500}
          max={100000}
          step={500}
          value={prefs.scrollback}
          clamp={clampScrollback}
          onCommit={(scrollback) => update({ scrollback })}
        />
      </label>
    </>
  );
}

/**
 * A number input whose value is only clamped when the user is FINISHED
 * typing — on blur, or on Enter — rather than on every keystroke.
 *
 * Clamping per-keystroke looks correct and is subtly unusable. With
 * `value={prefs.fontSize}` and an onChange that clamped immediately, typing
 * "13" into a field showing 24 went: "1" -> clamped up to the 9 minimum ->
 * "93" -> clamped down to the 24 maximum. The field could not be typed
 * into at all; only the spinner arrows worked. Every intermediate state a
 * person passes through while typing ("1" on the way to "13", or the empty
 * string on the way to anything) is out of range, so a clamp that runs
 * during typing destroys the input before it can be finished. Verified by
 * hand in a browser against a real terminal pane, which is also the only
 * way this could have been caught — `clampFontSize` itself is correct and
 * its unit tests pass; the bug was in WHEN it ran, not what it computed.
 *
 * So: `draft` holds exactly what the user typed, unvalidated, and the
 * clamp runs once at commit. A draft that isn't a number at all (empty,
 * "-", "abc") reverts to the last good value rather than silently becoming
 * a default the user never asked for.
 */
function ClampedNumberInput({
  value,
  min,
  max,
  step,
  clamp,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  clamp: (n: number) => number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  // `null` means "not being edited" — render the real value, so a change
  // made anywhere else (another tab, a reset) still shows up here.
  const shown = draft ?? String(value);

  const commit = () => {
    const parsed = Number(draft);
    // Number("") is 0, which would clamp to the minimum and silently
    // change a value the user only meant to clear — so treat blank (and
    // any non-numeric draft) as "abandon the edit" instead.
    if (draft !== null && draft.trim() !== "" && Number.isFinite(parsed)) {
      onCommit(clamp(parsed));
    }
    setDraft(null);
  };

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={shown}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
      style={numberInputStyle}
    />
  );
}

// --- Shortcuts (DERIVED from KEYMAP — see shortcutRows.ts) ----------------

function ShortcutsSection() {
  const isMac = isMacPlatform();
  const rows = getShortcutRows(KEYMAP, isMac);
  return (
    <>
      <p style={sectionHintStyle}>
        Derived straight from the app's own shortcut table — this list can never drift from what actually works.
        Press {isMac ? "⌘K" : "Ctrl+K"} any time to open the command palette instead.
      </p>
      <table style={tableStyle}>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} style={rowStyle}>
              <td style={cellLabelStyle}>{row.label}</td>
              <td style={cellKeyStyle}>{row.keyDisplay}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// --- Agents (unchanged content, moved) -------------------------------------

function AgentsSection({
  agents,
  defaultAgent,
  onDefaultAgentChange,
}: {
  agents: AgentOption[];
  defaultAgent: AgentId | "";
  onDefaultAgentChange: (id: AgentId) => void;
}) {
  return (
    <>
      <label style={labelStyle}>
        <span style={labelTextStyle}>Default agent for new panes</span>
        <select
          value={defaultAgent}
          onChange={(e) => onDefaultAgentChange(e.target.value as AgentId)}
          style={selectStyle}
        >
          <option value="" disabled>
            Default agent…
          </option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id} disabled={!agent.available}>
              {agent.displayName}
              {!agent.available ? " (not installed)" : ""}
            </option>
          ))}
        </select>
      </label>
      <p style={sectionHintStyle}>
        Highlighted by default whenever an empty pane's agent picker opens, and used automatically when a board card
        is dropped into In Progress before it's ever been dispatched.
      </p>
    </>
  );
}

// --- Accounts (new: each CLI manages its own login — see accounts.ts) -----

function AccountsSection({ agents }: { agents: AgentOption[] }) {
  const loginAgents = agents.filter((a) => a.id !== "shell");
  return (
    <>
      <p style={sectionHintStyle}>
        vibespace has no login of its own. Each agent CLI below manages its own authentication, completely outside
        vibespace — signing in happens INSIDE that CLI, exactly as it would if you'd launched it from a plain terminal
        without vibespace at all.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: SPACE.xs }}>
        {loginAgents.map((agent) => (
          <div key={agent.id} style={accountRowStyle}>
            <span
              aria-hidden
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 26,
                height: 26,
                borderRadius: "50%",
                flexShrink: 0,
                background: "var(--vd-surface)",
              }}
            >
              <AgentGlyph id={agent.id} size={14} color="var(--vd-text-faint)" />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: SPACE.xs, flexWrap: "wrap" }}>
                <span style={{ fontSize: FONT.body, color: "var(--vd-text)", fontWeight: 500 }}>
                  {agent.displayName}
                </span>
                <Pill status={agent.available ? "ok" : "idle"}>{agent.available ? "Installed" : "Not installed"}</Pill>
              </div>
              <div style={{ fontSize: FONT.meta, color: "var(--vd-text-faint)", marginTop: 2 }}>
                {loginNoteFor(agent.id)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// --- API Keys (explains env vars — deliberately no input, no localStorage) -

const KNOWN_ENV_VARS: readonly { agent: string; envVar: string }[] = [
  { agent: "Claude Code", envVar: "ANTHROPIC_API_KEY" },
  { agent: "Codex", envVar: "OPENAI_API_KEY" },
];

function ApiKeysSection() {
  return (
    <>
      <p style={sectionHintStyle}>
        Agent CLIs read API keys from environment variables — vibespace spawns each CLI as a real child process and
        passes your shell's environment straight through to it, the same environment that CLI would see if you'd run
        it directly in a terminal. vibespace itself never asks for, stores, or transmits an API key: there is
        deliberately no field on this page to type one into.
      </p>
      <ul style={envVarListStyle}>
        {KNOWN_ENV_VARS.map((row) => (
          <li key={row.envVar} style={envVarItemStyle}>
            <code style={codeStyle}>{row.envVar}</code> — {row.agent}
          </li>
        ))}
      </ul>
      <p style={sectionHintStyle}>
        Every other agent CLI reads its own provider's standard environment variable the same way — check that CLI's
        own documentation for its exact name. Set the variable in your shell (e.g. your <code style={codeStyle}>~/.zshrc</code>)
        before launching vibespace, the same way you'd set it up for using that CLI on its own.
      </p>
    </>
  );
}

// --- Billing (free & open source — see billingContent.ts) -----------------

function BillingSection() {
  return (
    <>
      {BILLING_PARAGRAPHS.map((paragraph, i) => (
        <p key={i} style={sectionHintStyle}>
          {paragraph}
        </p>
      ))}
    </>
  );
}

// --- Notifications (real preference; delivery is real but conditional —
// see notificationPrefs.ts's top comment for exactly what "finishes" means)

function NotificationsSection() {
  const [enabled, setEnabled] = useState(() => loadNotifyOnAgentIdle());
  const [permission, setPermission] = useState(() => getNotificationPermission());

  const handleToggle = (checked: boolean) => {
    setEnabled(checked);
    saveNotifyOnAgentIdle(checked);
  };

  const handleRequestPermission = () => {
    // Only ever called from this onClick — see notificationPrefs.ts's top
    // comment for why a permission request must never happen from an
    // effect/on load.
    void requestNotificationPermission().then((result) => setPermission(result));
  };

  return (
    <>
      <label style={checkboxRowStyle}>
        <input type="checkbox" checked={enabled} onChange={(e) => handleToggle(e.target.checked)} />
        <span style={labelTextStyle}>Notify when an agent finishes or goes idle (waiting for input)</span>
      </label>
      <p style={sectionHintStyle}>
        Uses the same busy/idle signal the per-pane prompt bar already relies on — exact, from shell integration, for
        plain terminal panes; a best-effort HEURISTIC (quiet output for a moment) for full-screen agent TUIs like
        Claude Code, Cursor Agent, and Codex, which will occasionally fire early or late. Only fires while this
        browser tab isn't the one you're currently looking at.
      </p>
      {permission === "unsupported" ? (
        <p style={sectionHintStyle}>This browser doesn't support notifications — the preference above still saves, it just can't deliver anything here.</p>
      ) : permission === "granted" ? (
        <p style={sectionHintStyle}>Browser notifications are enabled.</p>
      ) : (
        <>
          <Button variant="secondary" onClick={handleRequestPermission}>
            Enable browser notifications
          </Button>
          {permission === "denied" && (
            <p style={sectionHintStyle}>
              Notifications are blocked for this site — the preference above still saves, but you'll need to allow
              notifications from your browser's own site settings before anything will actually show up.
            </p>
          )}
        </>
      )}
    </>
  );
}

// --- About -------------------------------------------------------------

function AboutSection() {
  const desktop = isTauriApp();
  return (
    <>
      <p style={sectionHintStyle}>
        <a href="https://github.com/hharsha98/Vibespace" target="_blank" rel="noreferrer" style={linkStyle}>
          github.com/hharsha98/Vibespace
        </a>{" "}
        — MIT licensed, free and open source. See the repo's releases page for the current version and changelog.
      </p>
      <p style={sectionHintStyle}>
        {desktop
          ? "This is the desktop build — it checks for updates silently in the background and shows a banner when one's ready to install (see docs/DESKTOP.md)."
          : "Automatic update checking is a desktop-app feature only (see docs/DESKTOP.md) — this browser build has no update mechanism of its own. Check the repo's releases page above for the latest version."}
      </p>
    </>
  );
}

// --- Styles -----------------------------------------------------------

const pageStyle: CSSProperties = {
  height: "100%",
  display: "flex",
  background: "var(--vd-bg)",
  overflow: "hidden",
};

const railStyle: CSSProperties = {
  width: 200,
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: SPACE.sm,
  borderRight: "1px solid var(--vd-border)",
  overflowY: "auto",
};

const railHeaderStyle: CSSProperties = {
  padding: `${SPACE.sm}px ${SPACE.sm}px ${SPACE.xs}px`,
  fontSize: FONT.label,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--vd-text-faint)",
};

function railItemStyle(active: boolean): CSSProperties {
  return {
    textAlign: "left",
    padding: "7px 10px",
    borderRadius: RADIUS.sm,
    border: "none",
    fontSize: FONT.body,
    fontWeight: active ? 600 : 500,
    background: active ? "var(--vd-accent)" : "transparent",
    color: active ? "var(--vd-accent-text)" : "var(--vd-text-muted)",
    cursor: "pointer",
  };
}

const contentPaneStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflowY: "auto",
};

const innerStyle: CSSProperties = {
  maxWidth: 640,
  padding: `${SPACE.xl}px 24px 48px`,
};

// One step above FONT.heading (15px, "the one real headline" per
// docs/DESIGN.md §3) — a page title sits a level above even an empty
// state's own headline in this page's hierarchy, so it keeps its
// pre-existing 16px rather than reusing that same size for a different job.
const pageTitleStyle: CSSProperties = {
  margin: `0 0 ${SPACE.lg}px`,
  fontSize: 16,
  fontWeight: 600,
  color: "var(--vd-text)",
};

const sectionHintStyle: CSSProperties = {
  fontSize: FONT.meta,
  color: "var(--vd-text-muted)",
  margin: `0 0 ${SPACE.md}px`,
  lineHeight: 1.5,
};

const labelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: FONT.body,
  color: "var(--vd-text-muted)",
  marginBottom: SPACE.md,
};

const checkboxRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: SPACE.xs,
  marginBottom: SPACE.md,
};

const labelTextStyle: CSSProperties = {
  fontSize: FONT.meta,
  letterSpacing: "0.04em",
  color: "var(--vd-text-muted)",
};

const selectStyle: CSSProperties = {
  background: "var(--vd-bg)",
  color: "var(--vd-text)",
  border: "1px solid var(--vd-border)",
  borderRadius: RADIUS.sm,
  padding: "6px 8px",
  fontSize: FONT.body,
  maxWidth: 280,
};

const numberInputStyle: CSSProperties = {
  background: "var(--vd-bg)",
  color: "var(--vd-text)",
  border: "1px solid var(--vd-border)",
  borderRadius: RADIUS.sm,
  padding: "6px 8px",
  fontSize: FONT.body,
  maxWidth: 120,
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
};

const rowStyle: CSSProperties = {
  borderBottom: "1px solid var(--vd-border)",
};

const cellLabelStyle: CSSProperties = {
  padding: "6px 4px",
  fontSize: FONT.body,
  color: "var(--vd-text)",
};

const cellKeyStyle: CSSProperties = {
  padding: "6px 4px",
  fontSize: FONT.body,
  fontFamily: "monospace",
  color: "var(--vd-text-muted)",
  textAlign: "right",
  whiteSpace: "nowrap",
};

const accountRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: SPACE.sm,
  padding: SPACE.sm,
  background: "var(--vd-surface-raised)",
  border: "1px solid var(--vd-border)",
  borderRadius: RADIUS.sm,
};

const envVarListStyle: CSSProperties = {
  margin: `0 0 ${SPACE.md}px`,
  paddingLeft: 18,
  fontSize: FONT.body,
  color: "var(--vd-text)",
  lineHeight: 1.8,
};

const envVarItemStyle: CSSProperties = {
  fontSize: FONT.body,
};

const codeStyle: CSSProperties = {
  fontFamily: "monospace",
  background: "var(--vd-surface)",
  border: "1px solid var(--vd-border)",
  borderRadius: RADIUS.sm,
  padding: "1px 5px",
  fontSize: FONT.meta,
};

const linkStyle: CSSProperties = {
  color: "var(--vd-accent)",
};
