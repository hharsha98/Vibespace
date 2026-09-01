# Vibespace design language

The target look is the class of agentic development environments that
BridgeSpace popularised: a dark, dense, three-column workroom where terminals,
tasks and context sit side by side.

This document describes **our** implementation of that design language. It is a
functional style guide, not a copy of anyone's assets. We do not use another
product's name, logo, wordmark, or brand colours, and Vibespace never presents
itself as that product.

Observed reference: bridgemind.ai/products/bridgespace product screenshots,
reviewed 2026-08-11.

---

## 1. Structure — three columns

```
┌────────────────────────────────────────────────────────────────────┐
│  ▮ Vibespace        workspace › project                    ⚙ ? ◑    │  top bar (36px)
├──────────┬──────────────────────────────────────┬──────────────────┤
│WORKSPACES│                                      │  right dock      │
│      + ⌄ │                                      │                  │
│          │          terminal grid               │  Skills /        │
│ ● dev  6 │                                      │  Board /         │
│ ● api  2 │                                      │  Memory          │
│ ● web    │                                      │  (tabbed)        │
│          │                                      │                  │
│  220px   │              flexible                │   320px          │
└──────────┴──────────────────────────────────────┴──────────────────┘
```

- **Left rail (220px)** — workspaces as a *vertical list*, not horizontal tabs.
  Collapsible to a 48px icon strip.
- **Centre** — the pane grid. Always the widest column.
- **Right dock (320px)** — tabbed panel. Hidden until it has content; Phases
  7/8/10 fill it with Board, Memory and Skills. Collapsible.
- **Top bar (36px)** — mark, breadcrumb (`workspace › directory`), the
  centre-column view switcher, right-aligned icon buttons. Deliberately
  short: vertical space belongs to terminals. The view switcher's ten tabs
  are grouped into four logical clusters, separated by hairline dividers —
  workspace views (Terminals/Editor/Preview), planning & orchestration
  (Board/Graph/Swarm), the library (Agents/Prompts/Skills), and Settings on
  its own — each tab carries a small icon (`shell/viewIcons.tsx`), and the
  active tab is a solid accent pill with a soft shadow, not a flat
  rectangle.

## 2. Colour

Near-black canvas, layered surfaces, one accent per theme. Themes override
these tokens; the structure never changes.

| Token | Role | Dark default |
|---|---|---|
| `--bg` | app canvas | `#0a0a0b` |
| `--surface` | panels, rails, docks | `#111114` |
| `--surface-raised` | cards, menus, popovers | `#17171c` |
| `--border` | hairlines | `#232329` |
| `--border-strong` | focused pane outline | `--accent` |
| `--text` | primary | `#e8e8ea` |
| `--text-muted` | secondary | `#8a8a94` |
| `--text-faint` | tertiary, hints | `#5a5a63` |
| `--accent` | selection, focus, primary action | theme-specific |

**Status colours** are semantic and consistent everywhere — dots, pills, nodes:

| Meaning | Token | Dark default |
|---|---|---|
| running / healthy | `--ok` | `#4ade80` |
| working / attention | `--warn` | `#fbbf24` |
| error / critical / stop | `--danger` | `#f87171` |
| idle / exited | `--idle` | `#5a5a63` |
| info | `--info` | `#60a5fa` |

**Role colours** (used by the swarm view in Phase 9, and agent badges):
coordinator = `--warn`, builder = `--ok`, scout = `--info`,
reviewer = `#c084fc`.

## 3. Type

- UI: system stack, **12px** base, 11px for meta, 13px for headings, 15px
  for the one real headline surface (the empty-pane state's title) — dense
  on purpose everywhere else; this is a control surface, not a reading
  surface. The full named scale (`label`/`meta`/`body`/`title`/`heading`)
  lives as `FONT` in `apps/web/src/shell/tokens.ts`.
- Terminals: monospace stack, 13px, line-height 1.2.
- Labels like `WORKSPACES`, `TO DO`: 10px, `letter-spacing: .08em`, uppercase,
  `--text-faint`.
- Hierarchy is deliberate, not just size: a pane's title bar shows a running
  session's name at full `--text` contrast + medium weight, while an empty
  pane's label stays `--text-muted` — the same "earn contrast" rule applies
  to list rows (an active row's label is medium weight, a resting row's is
  regular).

## 4. Shape and spacing

- Radius: 6px panes and cards, 4px pills and small controls, 10px overlays,
  14px for the larger empty-pane agent cards (§5).
- Borders are 1px hairlines. Depth comes from surface layering FIRST — every
  raised surface also carries a subtle neutral shadow (plain black at low
  alpha, so it reads the same "closer to the viewer" cue on every theme,
  including the one light theme) as a secondary reinforcement: panes rest on
  a faint shadow off the black canvas, an active list row and a hovered
  empty-pane card lift further. Floating overlays (command palette, menus,
  popovers) still get the strongest shadow of the three.
- Spacing scale: 4 / 8 / 12 / 16 / 24px. The top of that scale (24px) is for
  page-level breathing room (the empty-pane state); dense chrome controls
  stay on the 4-12px end.
- Every one of the above (radius/spacing/shadow steps, plus the type scale
  in §3) is a named constant in `apps/web/src/shell/tokens.ts`
  (`RADIUS`/`SPACE`/`SHADOW`/`FONT`) — components import the named step
  instead of writing a bare number, so the scale stays a single decision
  made once, not re-decided ad hoc at each call site.

### Agent identity (empty-pane picker)

Each `AgentId` gets a hand-drawn glyph (`apps/web/src/grid/agentVisuals.tsx`)
plus an accent drawn from the theme's EXISTING palette — never a new hex
value — via `agentAccentVar`: `claude` → `--vd-accent`, `cursor-agent` →
`--vd-info`, `codex` → `--vd-ok`, `shell` → `--vd-idle`. Distinctness comes
from pairing that colour with a genuinely different glyph shape per agent,
not from inventing new brand hues, which would violate rule 2 below. An
unavailable agent's card uses a dashed border, a muted glyph, and (when the
server has one) shows its install command in a small monospace line.

## 5. Components

### Pane
Rounded 6px, 1px `--border`, resting on a faint elevation shadow (§4) that
lifts it off the black canvas. **Focused pane gets a 1px `--accent`
border** — that is the only focus AFFORDANCE; no glow. (The shadow is not a
focus cue — every pane gets it, focused or not.)

Title bar (30px), on `--surface` (one layer up from the pane body itself, so
the header itself reads as a distinct strip, not a continuation of empty
black): status dot · session name (full `--text` contrast + medium weight
once a session exists; `--text-muted` while empty) · workspace chip · git
branch chip · flexible gap · icon row (split-vertical, split-horizontal,
maximise, close). The workspace/branch chips are small `--surface-raised`
pills, not bare text — this is real information (which project, which
branch), not a caption. Icons are 14px, `--text-faint`, going `--text` on
hover. They appear on hover or focus, not permanently — 16 panes of
always-on icons is visual noise.

### Status dot
6px circle in a status colour. The single most repeated element in the UI:
workspaces, panes, board cards, swarm nodes all use it.

### Pill / badge
Uppercase 10px, `padding: 1px 6px`, radius 4px, tinted background at ~15%
opacity over the status colour with the status colour as text.
Used for counts, priorities (`CRITICAL` / `HIGH` / `MEDIUM` / `LOW`) and tags.

### List row (workspaces, skills, sessions)
32px tall, 8px horizontal padding. Status dot, label, right-aligned count
badge. Active row: `--surface-raised` background **and** a 2px `--accent` left
edge. Hover: `--surface-raised` only.

### Board card (Phase 7)
`--surface-raised`, radius 6px, 8px padding. Title clamped to 2 lines,
optional muted description clamped to 2 lines, priority pill bottom-left.
Destructive controls only on hover.

### Column header (Phase 7)
Icon · uppercase label · count badge. Column tint comes from the status colour
of its meaning, never a random palette.

### Canvas (Phase 9)
Dotted grid over `--bg`. Nodes are rounded pills — role icon, label, status dot
— joined by **curved** connectors coloured by the source node's role. Zoom
control cluster bottom-left, a directive input bottom-centre.

## 6. Rules that keep it coherent

1. **Density over comfort.** This is a cockpit. Prefer 4px to 8px, 12px type to 14px.
2. **Colour means status, never decoration.** If a colour is not carrying
   meaning, it should be a grey.
3. **Chrome recedes.** Terminal content is the subject; the shell is background.
   Chrome never uses the accent except for focus and the primary action.
4. **One accent at a time.** A screen shows exactly one accent colour, from the
   active theme.
5. **No native dialogs.** `window.alert` / `confirm` / `prompt` are banned —
   they break the aesthetic and freeze browser automation. Use inline banners
   and overlay panels.
6. **Every theme must restyle chrome and terminals together.** A theme that
   recolours the terminal but leaves the shell dark-grey looks broken.
