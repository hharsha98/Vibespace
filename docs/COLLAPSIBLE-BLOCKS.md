# Collapsible command blocks

BridgeSpace describes each command as a "distinct, collapsible section".
Phase 5 shipped everything except the collapsing, because xterm.js cannot hide
buffer lines — there is no fold API, and line 51 will not move up when you hide
lines 10–50.

This document is how we get real collapsing anyway.

## The idea

Stop assuming one renderer must do both jobs.

Phase 5's `BlockTracker` already knows, for every command, its **absolute
buffer line range**, its command text, exit code and duration. That is enough
to read those lines back out of xterm's buffer and render them **ourselves as
HTML** — where collapsing is trivial, because it is just DOM.

So a pane has two view modes:

| Mode | Renderer | For |
|---|---|---|
| **Live** (default) | xterm.js, exactly as today | Interactive work, and full-screen agent TUIs where folding is meaningless |
| **Blocks** | Our HTML renderer, built from the block model | Reading back a session: real collapse, per-block copy, jump-to |

This is not a workaround dressed up as a feature. Collapsing only ever matters
for *historical* output, and historical output is exactly what the block model
already describes.

## How Blocks view is built

1. `BlockTracker` gives `{ id, command, startLine, endLine, exitCode, durationMs, state }`.
2. For each block, walk xterm's buffer over `startLine…endLine`:
   `terminal.buffer.active.getLine(y)` → `line.getCell(x)` → character plus its
   foreground, background, bold/italic/underline/inverse flags.
3. Coalesce runs of cells sharing the same style into `<span>`s, so a 200-column
   line becomes a handful of spans rather than 200.
4. Render each block as a card:
   - **Header:** status dot · command text · exit-code pill on failure · duration · copy button · chevron
   - **Body:** the rendered lines, shown or hidden by CSS
5. Collapse is a CSS class. Nothing is faked.

Use the cell-walking approach rather than `@xterm/addon-serialize` — serialize
emits ANSI for the whole buffer and does not cleanly address a line range, so
we would end up re-parsing ANSI we already have structured.

## Behaviour worth getting right

- **Auto-collapse successes, keep failures open.** The reason to collapse is to
  make the failure findable. A block exiting non-zero starts expanded; a
  successful one starts collapsed with a one-line summary.
- **The running block streams.** The in-flight block has no end line yet.
  Render it expanded and re-render on output, debounced, or leave it to Live
  view — but never show it as a finished block.
- **Cap enormous blocks.** A build log can be 50,000 lines; that many DOM nodes
  will kill the tab. Render the first and last 500 lines with a "show all N
  lines" control between them.
- **Be honest when scrollback is gone.** xterm evicts old lines once past the
  10,000-line limit. A block whose lines have been evicted must say "output no
  longer in scrollback" rather than rendering blank. Do not silently show an
  empty block.
- **Build lazily and memoise.** Only construct HTML for the visible view, cache
  per block id, and invalidate a block only when its own lines change.
- **Per-block copy.** Copying one command's output without selecting it by hand
  is half the value of Warp-style blocks.

## What this does not change

Live view is untouched, so nothing about agent TUIs, WebGL rendering, the
WebGL cap, search, or the OSC 133 pipeline changes. Blocks view is additive
and only ever reads the buffer.

## Honest limits

- **Shell panes only.** Blocks exist because a shell emits OSC 133 markers.
  An agent TUI emits none, so its Blocks view is empty and should say so —
  the same degradation Phase 5 already ships.
- **Styling fidelity is good, not perfect.** We reproduce colour, bold, italic,
  underline and inverse. Exotica — sixel graphics, inline images, custom
  underline styles — stays in Live view. Say so in the UI rather than rendering
  it wrong.
