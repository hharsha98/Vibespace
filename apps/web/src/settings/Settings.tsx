/**
 * The Settings screen (Phase 9.5c, PARITY #45): a real centre view for
 * preferences that were previously scattered across the top bar, following
 * the same "fetch/own nothing beyond what's passed in, render it" shape as
 * Agents.tsx/Prompts.tsx (see App.tsx's `CenterView`). Unlike those two,
 * Settings has no server-backed data of its own to fetch — every preference
 * here already lives in App.tsx's state (theme, default agent) or is
 * derived from static data (KEYMAP) — so this component is pure rendering
 * plus the callbacks App.tsx already exposes for changing them.
 *
 * --- What's here, and why nothing more ---
 * Per this phase's own instruction ("gather what already exists rather than
 * inventing new preferences"), this mirrors — doesn't move — the nav bar's
 * theme swatch button (still there, still Cmd+Shift+T) and default-agent
 * `<select>`: both keep working exactly as before, and Settings is simply a
 * second, more spacious place to reach the same controls. The keyboard
 * shortcut table is DERIVED from `KEYMAP` (never hand-typed), the same rule
 * `KeyboardCheatSheet.tsx` already follows, so the two can never drift from
 * the real bindings independently of each other.
 *
 * --- Persistence ---
 * Every preference rendered here is already persisted the same way: theme
 * via `themes.ts`'s `saveThemeId`/localStorage, default agent via
 * `App.tsx`'s `saveDefaultAgent`/localStorage (added alongside this
 * screen — it existed before but was NEVER actually saved, see App.tsx's
 * own comment on `DEFAULT_AGENT_KEY`). localStorage is this project's one
 * established settings-persistence mechanism (there is no server-side
 * "preferences" table), so this screen doesn't invent a second one.
 */
import type { CSSProperties } from "react";
import type { AgentId } from "@vibedeck/shared";
import { KEYMAP, formatShortcut, isMacPlatform } from "../keys/keymap.js";
import { THEMES } from "../themes/themes.js";
import { ThemeSection } from "../themes/ThemePicker.js";
import type { AgentOption } from "../grid/PaneView.js";
import { FONT, RADIUS, SPACE } from "../shell/tokens.js";

export interface SettingsProps {
  themeId: string;
  onThemeChange: (id: string) => void;
  defaultAgent: AgentId | "";
  onDefaultAgentChange: (id: AgentId) => void;
  agents: AgentOption[];
}

export default function Settings({ themeId, onThemeChange, defaultAgent, onDefaultAgentChange, agents }: SettingsProps) {
  const isMac = isMacPlatform();
  const darkThemes = THEMES.filter((t) => t.isDark);
  const lightThemes = THEMES.filter((t) => !t.isDark);

  return (
    <div style={pageStyle}>
      <div style={innerStyle}>
        <h2 style={pageTitleStyle}>Settings</h2>

        <Section title="Appearance">
          <p style={sectionHintStyle}>
            Same picker as the nav bar's theme button (or {formatShortcut(
              KEYMAP.find((s) => s.id === "theme-picker")!,
              isMac
            )}) — pick a theme here, or there; both stay in sync.
          </p>
          <ThemeSection label="Dark" themes={darkThemes} currentThemeId={themeId} onSelect={onThemeChange} />
          <ThemeSection label="Light" themes={lightThemes} currentThemeId={themeId} onSelect={onThemeChange} />
        </Section>

        <Section title="Agents">
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
            Highlighted by default whenever an empty pane's agent picker opens, and used automatically
            when a board card is dropped into In Progress before it's ever been dispatched.
          </p>
        </Section>

        <Section title="Keyboard shortcuts">
          <p style={sectionHintStyle}>
            Derived straight from the app's own shortcut table — this list can never drift from what
            actually works. Press {isMac ? "⌘K" : "Ctrl+K"} any time to open the command palette instead.
          </p>
          <table style={tableStyle}>
            <tbody>
              {/* Same collapsing rule KeyboardCheatSheet.tsx uses: the nine
                  "focus pane N" shortcuts (paneIndex 0..8) render as one row,
                  not nine, since they're one mnemonic pattern (Cmd+1..Cmd+9)
                  rather than nine unrelated bindings. */}
              {KEYMAP.filter((s) => s.paneIndex === undefined || s.paneIndex === 0).map((shortcut) => (
                <tr key={shortcut.id} style={rowStyle}>
                  <td style={cellLabelStyle}>
                    {shortcut.paneIndex === 0 ? "Focus pane 1–9" : shortcut.label}
                  </td>
                  <td style={cellKeyStyle}>
                    {shortcut.paneIndex === 0
                      ? isMac
                        ? "⌘1 … ⌘9"
                        : "Ctrl+1 … Ctrl+9"
                      : formatShortcut(shortcut, isMac)}
                  </td>
                </tr>
              ))}
              {/* Not in KEYMAP: terminal search is handled directly inside
                  Terminal.tsx's own keydown listener (Cmd/Ctrl+F opens its
                  in-terminal search box), not through the matchShortcut/
                  KEYMAP system every other binding here goes through — see
                  Terminal.tsx's search effect. Listed here by hand for the
                  same reason KeyboardCheatSheet.tsx also hand-adds it: the
                  table would otherwise silently omit a real, working
                  shortcut just because of where its handler happens to
                  live. */}
              <tr style={rowStyle}>
                <td style={cellLabelStyle}>Search in terminal</td>
                <td style={cellKeyStyle}>{isMac ? "⌘F" : "Ctrl+F"}</td>
              </tr>
            </tbody>
          </table>
        </Section>
      </div>
    </div>
  );
}

/**
 * Stage B: each settings group is now a real card — `--vd-surface`
 * background, 1px border, radius — instead of a bare `<h3>` plus bottom
 * margin. Before this, "Appearance" / "Agents" / "Keyboard shortcuts" read
 * as one long unbroken scroll with faint uppercase labels as the only
 * separator; a card boundary gives each group its own visual weight, the
 * same layering (`--vd-bg` canvas, `--vd-surface` content) every other
 * grouped surface in the app already uses (board columns, panes).
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={sectionStyle}>
      <h3 style={sectionTitleStyle}>{title}</h3>
      {children}
    </section>
  );
}

const pageStyle: CSSProperties = {
  height: "100%",
  overflowY: "auto",
  background: "var(--vd-bg)",
};

const innerStyle: CSSProperties = {
  maxWidth: 640,
  margin: "0 auto",
  padding: `${SPACE.xl}px 20px 48px`,
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

const sectionStyle: CSSProperties = {
  marginBottom: SPACE.lg,
  padding: SPACE.lg,
  background: "var(--vd-surface)",
  border: "1px solid var(--vd-border)",
  borderRadius: RADIUS.md,
};

const sectionTitleStyle: CSSProperties = {
  margin: `0 0 ${SPACE.sm}px`,
  fontSize: FONT.meta,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--vd-text-faint)",
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
  marginBottom: SPACE.sm,
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
