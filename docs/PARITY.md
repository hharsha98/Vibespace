# Feature parity audit

The target: everything BridgeSpace does, Vibespace should do. This file is the
checklist that decides when that is true, so "are we there yet" is an
auditable question rather than an opinion.

Sources, read 2026-08-12: `docs.bridgemind.ai/docs/bridgespace` (their own
documentation) and the BridgeSpace / BridgeSwarm product pages.

## Re-sync against BridgeSpace v3.4.18 (their changelog, read 2026-08-21)

Their latest desktop release is **v3.4.18, 4 August 2026**. Every entry from
v3.2.1 through v3.4.18 was read and checked against this codebase. What that
found, honestly:

**Already shipped here, no work needed.** Their v3.4.17 "drag-highlights
inside mouse-tracking TUIs are copyable" is our parity item 3, shipped —
`macOptionClickForcesSelection` plus a Cmd/Ctrl+C handler (see
`term/copyShortcut.ts`). Their v3.4.17 "terminal renderer addons are
disposed before the terminal core" is a bug we independently hit and fixed.
Their v3.4.13 deferred panes, bounded cold-start restore budget and circuit
breaker are all in our session-recovery work.

**Deliberately not ours.** Most of v3.2.2, v3.4.15 and much of v3.4.17 is
account, subscription, billing and multi-account-profile machinery —
"paid sessions stay verified", "the right plan follows the right account",
OAuth account confirmation. Vibespace has no accounts and nothing to bill,
so none of it applies. Notably they *removed* their own AI account-profiles
experiment in v3.4.17. Their v3.4.17 "Bridge" orchestration workspace is
built around a voice orb and their voice product, which the scope note
below already excludes.

**Real, but unverifiable from here.** Three items are Windows- or
Linux-specific: the v3.4.18 Windows clipboard-image paste fix, the v3.4.13
Windows shell fallback for blocked WindowsApps aliases, and the v3.4.17
Linux Ctrl+V image hand-off. This project is developed on macOS and those
paths cannot be exercised here, so implementing them would mean writing
code nobody can test. Left undone deliberately rather than shipped blind.

Worth noting on the first of those: our clipboard-image handling always
saves the image and types its path (`files/paste-image.ts`). That is
exactly the behaviour BridgeSpace settled on for Windows in v3.4.18, after
their v3.4.17 attempt at agent-native paste regressed it. We do it on every
platform — simpler, and the failure mode they hit is unreachable for us.

**Refinement we cannot observe.** Their v3.4.17 aligned the Codex context
pill with Codex's own `/status` math. Ours relays Codex's printed footer
verbatim and has never been seen rendering on this machine (Codex hangs on
its own MCP servers here), so there is no measurable gap to close yet.

Scope note: this tracks **BridgeSpace**, the workroom. Their separate
products — an autonomous server-resident agent, a voice dictation tool, a
screenshot utility — are not in scope; they are different applications that
happen to share a vendor.

Two deliberate differences, neither a gap:

- **No account or sign-in.** BridgeSpace requires an account and gates
  features behind a paid tier. Vibespace is local-first and unlicensed;
  everything is available to everyone.
- **Our own themes and mark.** We ship an equivalent *number* of themes drawn
  from long-established community palettes, not their proprietary named set,
  and Vibespace uses its own logo. Matching a design language is fair;
  copying a brand is not.

Legend: ✅ done · 🟡 partial · ⛔ not started · 🚫 not possible as specified

---

## Terminals

| # | Capability | Status | Notes |
|---|---|---|---|
| 1 | 1–16 panes in one workspace | ✅ | Phase 2 |
| 2 | Split any pane horizontally / vertically | ✅ | Phase 2 |
| 3 | Resize panes by dragging | ✅ | Phase 2 |
| 4 | GPU-accelerated rendering | ✅ | Phase 1; capped at 8 WebGL contexts, rest fall back |
| 5 | Command block: command text, output, exit code, timestamp | ✅ | Phase 5, via OSC 133 |
| 6 | Command blocks **collapsible** | ✅ | Phase 9.5a. Solved by a second renderer rather than fighting xterm: a per-pane Blocks view that reads each block's line range out of the buffer and renders it as collapsible HTML, where "collapsed" is just a CSS class. Successes auto-collapse, failures auto-expand, per-block copy, first/last-500-line cap. Design in `COLLAPSIBLE-BLOCKS.md`. |
| 7 | Search terminal output (⌘F) | ✅ | Phase 1 |
| 8 | Context menu: copy / paste / clear | ✅ | Phase 1 |
| 9 | Context menu: **split** entry | ✅ | Phase 9.5c — "Split right" / "Split down" call the same handlers the header icons do, not a second copy of the logic |
| 10 | Drag a file in to paste its path | ✅ | Phase 1 |
| 11 | **Inline image preview** (terminal image protocols) | ✅ | Phase 9.5c, `@xterm/addon-image`. Sixel output confirmed rendering as real pixels in a browser, not just confirmed to compile. |
| 12 | **Scroll-to-bottom floating indicator** | ✅ | Phase 9.5c — Live view only; hidden when already at the bottom |
| 13 | Sessions survive closing the window | ✅ | Better than parity — server-owned sessions |
| 13a | **Per-pane prompt bar that queues while the agent works** | ✅ | Phase 9.5a. Busy detection is **exact** for shell panes (an open OSC 133 block) but a **heuristic** for agent TUIs (output seen within 750ms), which will sometimes be wrong — an agent thinking silently reads as idle. Documented in `promptQueue.ts` rather than hidden. Queued prompts live in the tab only; a reload loses them. |
| 13b | **Git branch chip in the pane header** | ✅ | Phase 9.5c. Polled every 15s rather than watching `.git`, so the chip can be up to 15s stale after a checkout. Detached HEAD shows a short hash; a non-repo directory shows no chip at all. |
| 13c | **Pane header names the workspace as well as the agent** | ✅ | Phase 9.5c — carries the workspace's colour dot too |

## Editor and files

| # | Capability | Status | Notes |
|---|---|---|---|
| 14 | Syntax highlighting, many languages | ✅ | Phase 6, CodeMirror 6 |
| 15 | Language detection by extension | ✅ | Phase 6 |
| 16 | File watching — external edits reflected | ✅ | Phase 6; also protects unsaved edits with a conflict bar |
| 17 | Quick Open (⌘P) | ✅ | Phase 6 |
| 18 | Open files in tabs | ✅ | Phase 6 |
| 19 | File tree with expand/collapse and icons | ✅ | Phase 6 |
| 20 | **Drag and drop in the file sidebar** | ✅ | Phase 9.5c. `POST /api/files/move` resolves both ends through `safeResolve`; `../` escapes, absolute paths outside the root, and symlinks pointing out of the workspace are all refused, as is overwriting a file or moving a directory into its own descendant. Verified adversarially against the running server with a canary file outside the root. |
| 21 | Embedded browser for localhost | ✅ | Phase 6 |

## Agent workflows

| # | Capability | Status | Notes |
|---|---|---|---|
| 22 | Kanban: Todo / In Progress / In Review / Complete | ✅ | Phase 7 |
| 23 | Dispatch a task to an agent from the board | ✅ | Phase 7 |
| 24 | Wait for the shell prompt before sending | ✅ | Phase 7, settle delay after first output |
| 25 | Agents read and move their own cards | ✅ | Phase 7, `docs/AGENT-API.md` |
| 26 | **Agents page — per-agent custom system prompts** | ✅ | Phase 9.5b. `{name, systemPrompt}` scoped to a workspace, full CRUD over REST (`/api/agent-profiles` — that path, not `/api/agents`, which already lists installed CLIs) and MCP. Agents page with a live 100,000-char counter; a duplicate name surfaces the server's 409 as a readable sentence. |
| 27 | **Prompts library — save and reuse prompts** | ✅ | Phase 9.5b. Global or workspace-scoped, full CRUD over REST, read-only `list_prompts` over MCP, and a library page that separates global from workspace prompts with copy-to-clipboard. |
| 27a | **`cancelled` task state** | ✅ | Phase 9.5b — a fifth `ColumnId`, modelled as a real column (see `packages/shared/src/protocol.ts`'s `ColumnId` doc comment for why). Data and drag-and-drop worked automatically since the board iterates `COLUMNS`; Phase 9.5c added the missing icon case, which had been rendering blank. |
| 27b | **`taskKnowledge` — long context separate from instructions** | ✅ | Phase 9.5b — up to 50,000 chars (`description` capped at 5,000, matching their `instructions`), threaded through the store, REST, dispatch prompt (agent panes only, clearly delimited — never shell panes), and MCP. The card editor has the field with live counters, and a card carrying task knowledge shows a glyph on the board. |
| 27c | **Board exposed over MCP, not only HTTP** | ✅ | Phase 9.5b — `list_tasks`/`get_task`/`create_task`/`update_task` plus the agent/prompt tools above, all on the same MCP server memory already used. See `apps/server/src/mcp/build-server.ts` for the architecture decision (opens the shared SQLite database directly rather than calling the HTTP API). |
| 27d | **An MCP prompt that onboards an agent** | ✅ | Phase 9.5b — `vibespace_developer_guide`, `apps/server/src/mcp/developer-guide.ts`. |
| 28 | Shared agent memory | ✅ | Phase 8 |
| 29 | Memory shared with every agent over MCP | ✅ | Phase 8 |
| 30 | Memory as a linked graph with backlinks | ✅ | Phase 8 |
| 31 | **Swarm: roles (coordinator/builder/scout/reviewer)** | ✅ | Phase 9a, server-side; `docs/SWARM.md` |
| 32 | **Swarm: shared mailbox between agents** | ✅ | Phase 9a |
| 33 | **Swarm: file ownership, no two agents on one file** | ✅ | Phase 9a — three layers (task sequencing, DB-arbitrated claims, conflict-detection watcher), all **cooperative**, not OS-enforced; see `docs/SWARM.md`'s honesty table for exactly what each layer can and can't guarantee |
| 34 | **Swarm: quality gates** | ✅ | Phase 9a |
| 35 | **Swarm: live mission tree canvas** | ✅ | Phase 9b — `apps/web/src/swarm/MissionCanvas.tsx` |
| 36 | **Swarm: @-target one agent, or all, from one bar** | ✅ | Phase 9b — `apps/web/src/swarm/CommandBar.tsx` |
| 37 | **Skills: drag a skill onto a running pane** | ✅ | Phase 10. Full implementation of the open `agentskills.io` standard rather than a private format: discovery across six scopes (user + project × `.agents`/`.vibespace`/`.claude`), a hand-rolled spec parser, REST + MCP (`list_skills`/`get_skill`), a Skills view, and sending a skill into a running pane. Verified against this machine's 68 skills authored for another tool — all parse cleanly. It **is** now a real drag: skills also appear in the right dock (`apps/web/src/shell/RightDock.tsx`), which is on screen at the same time as the pane grid — unlike the centre Skills view, which is `display: none` while inactive and so had no pane to drop onto. Native HTML5 drag-and-drop under a private MIME type (`application/x-vibespace-skill`), so text dragged in from another application can never be mistaken for a skill. Only panes that can genuinely receive one light up: `canPaneAcceptSkill` refuses empty panes, exited sessions **and** shell panes, matching the server's own 400 rather than a looser guess — the highlight never promises something the server would then reject. The centre view and its keyboard-reachable "send to pane" buttons remain, because drag is mouse-only and this app is keyboard-first. **One honest caveat remains:** "sent" can only ever mean *typed into the pane*, never *the agent accepted it* — Vibespace writes to the pty and cannot observe what the agent does next. Verified end-to-end in a browser: dropping a skill on a running Claude Code pane put its body into Claude's composer, unsubmitted (injection deliberately writes no carriage return). See `docs/SKILLS.md`. |

## Workspaces

| # | Capability | Status | Notes |
|---|---|---|---|
| 38 | Multiple workspaces, each with its own layout | ✅ | Phase 3 — a rail rather than tabs; same capability |
| 39 | Layout persists across restart | ✅ | Phase 3 |
| 40 | Panes open in the workspace's directory | ✅ | Phase 3 |
| 41 | **Colour-code a workspace** | ✅ | Phase 9.5c, migration 5. Eight-colour palette; null means no colour chosen, so existing workspaces keep the neutral look. Active row gets the thick accent edge; the colour also reaches the pane header. |
| 41a | **Workspaces are top-bar tabs; the sidebar is the file browser** | ✅ | Was 🟡 on the strength of an early screenshot that showed workspaces, BridgeBoard and BridgeSwarm as sibling rail rows. Their *documentation* is unambiguous and is what we followed: "Create multiple workspace tabs, each with its own pane layout. Color-code tabs for quick identification", plus `Cmd+T` new tab and `Cmd+1-9` switch tab in their shortcut table, while the sidebar is described only as "Navigate project files directly in the sidebar". Ours now matches: tabs in the top bar (colour dot, running count, close, `+`, double-click to rename, click the dot for colour), sidebar files-only. Phase 4.5 had moved workspaces into a vertical rail — its own commit says it adopted "the dense, dark, three-column workroom that agentic development environments have converged on", a general instinct applied without checking this product. Board/Graph/Swarm remain in the top-bar view switcher; whether theirs still sit in a rail could not be re-verified from current documentation, so that half is left alone rather than churned on a stale observation. |
| 41b | **Workspace badge counts panes** | 🟡 | Theirs appears to count panes; ours counts running *sessions*. The badge now rides on the workspace tab rather than a rail row — it was very nearly lost in that move, along with rename and colour, all three of which had no home outside the old list. |
| 42 | Templates: 1/2/4/6/8/10/12/14/16 | ✅ | Phase 2 |

## Shell

| # | Capability | Status | Notes |
|---|---|---|---|
| 43 | 25+ themes, dark-first | ✅ | 26, Phase 4 |
| 44 | Theme picker in the nav bar | ✅ | Phase 4 |
| 45 | **Settings screen** | ✅ | Phase 9.5c — themes, default agent (now actually persisted; the picker never remembered anything before), and a shortcut table derived from `KEYMAP` so it cannot drift |
| 46 | Keyboard-first operation | ✅ | Phase 4 |
| 47 | ⌘P quick open · ⌘F search · ⌘D split | ✅ | Exact parity |
| 48 | ⌘T new tab · ⌘W close tab · ⌘1–9 switch tab | ✅ | Browser build: Chrome reserves ⌘T/⌘W/⌘N, so we use ⌘⇧ variants there, and ⌘1–9 focuses panes. **Desktop build (Phase 11a): plain ⌘N/⌘W/⌘T now work too** — `matchShortcut`'s `isDesktop` flag accepts both forms, so muscle memory from either build keeps working. See `apps/web/src/keys/keymap.ts`. |
| 49 | Command palette | ✅ | Better than parity — BridgeSpace has no palette |

## Remote access

| # | Capability | Status | Notes |
|---|---|---|---|
| 53 | **SSH connection profiles** — panes that run on a remote machine, with a per-profile default directory/startup command applied after connect, plus one-click Duplicate | ✅ | Was a real gap (no remote support at all), not polish. Spawns the real `ssh` binary in a pty — no SSH implemented ourselves, no credentials stored; auth is the user's own ssh-agent/keys. Deliberate difference from BridgeSpace: they keychain-store passwords, we don't — a host that only accepts password auth prompts inside the pane like any terminal. See `docs/SSH.md`. |

## Packaging

| # | Capability | Status | Notes |
|---|---|---|---|
| 50 | Native desktop app (macOS / Windows / Linux) | 🟡 | Phase 11a, relocatability fixed by Phase 11b. A Tauri 2 shell that spawns the Node server as a sidecar and loads it — Node is required because `node-pty` and `better-sqlite3` are native addons that cannot become Rust. Still needs system Node 22+ (not bundled — a real, honest, unfixed limit). **Fixed by Phase 11b:** a packaged build is no longer tied to the repo checkout it was built from — verified by hand, launching a copy of the built `.app` relocated entirely outside the repo, which served the real API and web app. macOS build verified end-to-end; Windows/Linux builds are wired into `.github/workflows/release.yml` but that workflow has never actually run (no CI runner available while building this phase). See `docs/DESKTOP.md`. |
| 51 | Auto-updates | ✅ | Phase 11b. `tauri-plugin-updater` + `@tauri-apps/plugin-updater`, endpoint pointing at this repo's GitHub Releases `latest.json`. **UX, deliberately not silent:** checks in the background on startup and every 4 hours, shows a dismissible banner only once an update is actually found, and only downloads/installs/restarts after an explicit "Update & Restart" click — this app hosts long-lived terminal sessions with real running work, so an unasked-for restart would destroy it. Pure decision logic (`shouldShowUpdateBanner`, the download-progress reducer) is unit-tested in `apps/web/src/shell/updater.test.ts`. The signing keypair lives outside the repo (`~/.vibespace/updater.key`, mode 600, no password) and as a GitHub Actions secret; the public key is committed (safe — verify-only). Local build-and-sign verified by hand against the real keypair, producing a real `.sig` file Tauri accepted. See `docs/DESKTOP.md`'s "Auto-updates" and "Releasing" sections. |
| 52 | Installers: DMG / Windows / DEB, RPM, AppImage | 🟡 | Phase 11a built an unsigned macOS DMG only. Phase 11b adds `.github/workflows/release.yml` (macOS/Windows/Linux runners, triggered on a `v*` tag or manually, publishing DMG + NSIS/MSI + DEB/RPM/AppImage to one GitHub Release) and fixes the bigger problem: Phase 11a's installer only worked on the machine that built it. That relocatability fix is verified end-to-end on macOS (see #50); the release workflow itself is unexecuted — no GitHub Actions runner was available while building this phase, so the Windows/Linux legs and the workflow's own GitHub Release / `latest.json` plumbing are reviewed carefully but not proven. Sizes grew accordingly: a signed macOS `.app` is now ~135MB (DMG ~30MB), up from 9.5MB/2.7MB unsigned — mostly `node-pty`'s per-platform prebuilt binaries, the honest cost of genuine relocatability. Still unsigned in the platform code-signing sense (no Apple/Microsoft certificate, no notarization) — Gatekeeper/SmartScreen warn on first launch, a deliberate, documented choice, not an oversight. |

---

## Remaining work, in order

Phases 1–9.5 are done. Everything below is what is genuinely left.

**Phase 10 — Skills** (#37). Server done — see `docs/SKILLS.md`. What's
left is the web UI: browsing the skill catalog and dragging one onto a
running pane (the REST/MCP surface it would call already exists).

**Phase 11 — Desktop** (#50–52). Tauri 2 (11a), relocatable installers and
auto-updates (11b) — see `docs/DESKTOP.md`. Also closes #48, because a
desktop window can claim ⌘T/⌘W/⌘N that a browser tab never sees.
**What's genuinely left**: the release workflow itself has never run
against a real GitHub Actions runner (no runner was available while
building 11b) — the Windows and Linux legs, and the workflow's own
GitHub Release / `latest.json` publishing, are reviewed carefully but
unproven until a real tagged release actually goes through it. Also still
open: real platform code-signing (Apple notarization, a Windows
Authenticode certificate) was never in scope — Gatekeeper/SmartScreen
warnings on first launch are a standing, deliberate trade-off, not a bug.

Two open judgement calls, neither a missing feature:

- **#41a, navigation.** Their left rail lists workspaces *and* the board
  *and* the swarm as sibling rows. We put those in the top-bar view
  switcher. Same capability, different model; matching them exactly is a
  restructure, not a gap.
- **#41b, the workspace badge.** Theirs appears to count panes; ours counts
  running sessions.

Known limitations we chose rather than missed, all documented where they
live rather than only here:

- The prompt bar's "is the agent busy" signal is **exact** for shell panes
  (an open OSC 133 block) and a **heuristic** for agent TUIs — output seen
  within 750ms. An agent thinking silently reads as idle. None of the three
  CLIs emit a real "done" signal, so there is no general fix.
- Queued prompts live in the browser tab. A reload loses any not yet sent.
- The git branch chip polls every 15s, so it can be that stale after a
  checkout.
- Swarm file ownership is **cooperative** across all three layers, not
  OS-enforced. `docs/SWARM.md`'s honesty table says exactly what each layer
  can and cannot guarantee.

## Where we will still differ when this is finished

Only where you asked us to:

- **No account, no paid tier.** They gate workspace tabs, the kanban board,
  agent configuration and the prompts library behind Pro. Ours are all free.
- **Our own name, logo and theme set.** Community palettes rather than their
  proprietary named list, and Vibespace's own mark.

Everything functional on this list is reachable. Two items that were
previously written off are now designed rather than abandoned:

- **#6, collapsible blocks** — `COLLAPSIBLE-BLOCKS.md`. Not possible *inside*
  xterm; entirely possible in a second renderer built from the block model.
- **#31–36, the swarm** — `SWARM-MECHANISM.md`. Their mechanism is
  unpublished, so we specified our own: wave scheduling, database-arbitrated
  claims, conflict detection, quality gates, reviewer approval, stall
  detection and failure escalation.

This file is the record of whether we got there.
