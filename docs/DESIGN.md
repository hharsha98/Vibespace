# vibedeck design language

The target look is the class of agentic development environments that
BridgeSpace popularised: a dark, dense, three-column workroom where terminals,
tasks and context sit side by side.

This document describes **our** implementation of that design language. It is a
functional style guide, not a copy of anyone's assets. We do not use another
product's name, logo, wordmark, or brand colours, and vibedeck never presents
itself as that product.

Observed reference: bridgemind.ai/products/bridgespace product screenshots,
reviewed 2026-08-11.

---

## 1. Structure — three columns

```
┌────────────────────────────────────────────────────────────────────┐
│  ▮ vibedeck        workspace › project                    ⚙ ? ◑    │  top bar (36px)
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
- **Top bar (36px)** — mark, breadcrumb (`workspace › directory`), right-aligned
  icon buttons. Deliberately short: vertical space belongs to terminals.

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

- UI: system stack, **12px** base, 11px for meta, 13px for headings. Dense on
  purpose — this is a control surface, not a reading surface.
- Terminals: monospace stack, 13px, line-height 1.2.
- Labels like `WORKSPACES`, `TO DO`: 10px, `letter-spacing: .08em`, uppercase,
  `--text-faint`.

## 4. Shape and spacing

- Radius: 6px panes and cards, 4px pills and small controls, 10px overlays.
- Borders are 1px hairlines. Depth comes from surface layering, not shadows.
  Only floating overlays (command palette, menus) get a shadow.
- Spacing scale: 4 / 8 / 12 / 16px. Nothing larger inside chrome.

## 5. Components

### Pane
Rounded 6px, 1px `--border`. **Focused pane gets a 1px `--accent` border** —
that is the only focus affordance; no glow.

Title bar (26px): status dot · agent name · flexible gap · icon row
(split-vertical, split-horizontal, maximise, close). Icons are 14px,
`--text-faint`, going `--text` on hover. They appear on hover or focus,
not permanently — 16 panes of always-on icons is visual noise.

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
