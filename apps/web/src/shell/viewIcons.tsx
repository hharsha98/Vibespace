/**
 * One small hand-drawn icon per top-bar view tab (docs/DESIGN.md §1's
 * "centre column view switcher"). Before this file the switcher was ten
 * plain text labels in a row with no grouping and no icon — this is the
 * "give each an icon" half of that fix; App.tsx's `ViewTabButton` handles
 * the other half (grouping, active-state treatment).
 *
 * Same conventions as every other icon already in this codebase (see
 * PaneView.tsx's SplitVerticalIcon, WorkspaceRail.tsx's ChevronIcon): 14x14
 * viewBox, `currentColor` strokes/fills so each icon inherits its button's
 * own text colour (muted at rest, full `--vd-text`/`--vd-accent-text` when
 * active) automatically — no per-icon colour prop needed, no icon library.
 */
import type { CenterView } from "../viewTypes.js";

const ICONS: Record<CenterView, () => React.JSX.Element> = {
  terminals: TerminalsIcon,
  editor: EditorIcon,
  preview: PreviewIcon,
  board: BoardIcon,
  graph: GraphIcon,
  swarm: SwarmIcon,
  agents: AgentsIcon,
  prompts: PromptsIcon,
  skills: SkillsIcon,
  settings: SettingsIcon,
};

export function ViewIcon({ view }: { view: CenterView }) {
  const Icon = ICONS[view];
  return <Icon />;
}

function TerminalsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1.5" y="2" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
      <path d="M3.7 5L6 7L3.7 9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 9H9.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function EditorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M4.2 3L1.7 7L4.2 11" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.8 3L12.3 7L9.8 11" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 2.3L6 11.7" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function PreviewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M1.2 7C2.4 4.3 4.6 3 7 3C9.4 3 11.6 4.3 12.8 7C11.6 9.7 9.4 11 7 11C4.6 11 2.4 9.7 1.2 7Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <circle cx="7" cy="7" r="1.8" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function BoardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1.5" y="2" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
      <path d="M4.8 4V10" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M9.2 4V7.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function GraphIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M3.3 3.3L7 7L10.7 4.2M7 7L10.7 10.4M7 7L3.3 10.7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <circle cx="3.3" cy="3.3" r="1.5" fill="currentColor" />
      <circle cx="10.7" cy="4.2" r="1.5" fill="currentColor" />
      <circle cx="7" cy="7" r="1.5" fill="currentColor" />
      <circle cx="10.7" cy="10.4" r="1.5" fill="currentColor" />
      <circle cx="3.3" cy="10.7" r="1.5" fill="currentColor" />
    </svg>
  );
}

function SwarmIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="1.6" fill="currentColor" />
      <circle cx="2.3" cy="4" r="1.3" stroke="currentColor" strokeWidth="1" />
      <circle cx="11.7" cy="4" r="1.3" stroke="currentColor" strokeWidth="1" />
      <circle cx="2.3" cy="10.5" r="1.3" stroke="currentColor" strokeWidth="1" />
      <circle cx="11.7" cy="10.5" r="1.3" stroke="currentColor" strokeWidth="1" />
      <path d="M4 5L6 6.3M10 5L8 6.3M4 9.5L6 7.7M10 9.5L8 7.7" stroke="currentColor" strokeWidth="0.9" />
    </svg>
  );
}

function AgentsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="2.5" y="3.5" width="9" height="7" rx="2" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="5.3" cy="7" r="0.9" fill="currentColor" />
      <circle cx="8.7" cy="7" r="0.9" fill="currentColor" />
      <path d="M7 3.5V1.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <circle cx="7" cy="1.4" r="0.6" fill="currentColor" />
    </svg>
  );
}

function PromptsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M2 3.5A1.3 1.3 0 0 1 3.3 2.2H10.7A1.3 1.3 0 0 1 12 3.5V7.7A1.3 1.3 0 0 1 10.7 9H6.5L4 11.2V9H3.3A1.3 1.3 0 0 1 2 7.7V3.5Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SkillsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M7.6 1.5L3 7.6H6.4L5.4 12.5L11 6H7.7L7.6 1.5Z"
        fill="currentColor"
        fillOpacity="0.15"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="2.1" stroke="currentColor" strokeWidth="1.1" />
      <path
        d="M7 1.8V3M7 11V12.2M12.2 7H11M3 7H1.8M10.5 3.5L9.6 4.4M4.4 9.6L3.5 10.5M10.5 10.5L9.6 9.6M4.4 4.4L3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}
