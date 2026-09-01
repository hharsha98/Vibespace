---
name: vibespace-parity-audit
description: Use this skill when asked to check whether a vibespace feature actually matches its docs/PARITY.md entry, before marking a PARITY row done, or when a PARITY status feels stale. Verifies the ✅/🟡/⛔ status against the real codebase rather than trusting the table.
license: MIT
compatibility: Works in any vibespace workspace checkout; assumes read access to the repo.
metadata:
  category: project-maintenance
  author: vibespace
---
# Auditing a feature against docs/PARITY.md

`docs/PARITY.md` is vibespace's feature-parity checklist against BridgeSpace
— the source of truth for "is this actually done". Its whole value depends
on the status column being *true*, not aspirational. This skill is a
repeatable procedure for checking one row honestly, instead of trusting
whatever it currently says (including if you're the one who wrote it).

## When to use this

- Before changing a PARITY row's status (⛔ → 🟡, 🟡 → ✅, or the reverse).
- When a feature "sounds" done but you haven't actually verified it.
- Periodically, on rows marked ✅, to catch drift — a feature can regress
  (a refactor silently breaks it) without anyone updating the table.

## Procedure

1. **Find the row.** Open `docs/PARITY.md` and locate the numbered entry
   for the feature (e.g. `#37`). Read its Notes column — it should name a
   specific file, doc, or both. If it doesn't name anything concrete,
   that's already a smell: an unverifiable claim.

2. **Read the status glyph honestly.**
   - `✅` claims the feature is fully done, matching BridgeSpace's
     capability.
   - `🟡` claims partial parity — the Notes column MUST explain the gap
     (what's missing, usually "server done, no web UI" or a deliberate
     design difference).
   - `⛔` claims not started.

3. **Verify against the actual code, not the Notes prose.** For each file
   the Notes column names:
   - Does the file exist? Does it do what the Notes claim?
   - If the Notes cite a test file, do those tests exist AND pass? Run
     them — don't just confirm the file is present. A test file with
     `.skip()`'d tests is not verification.
   - If the Notes cite a REST endpoint or MCP tool, confirm it's actually
     registered (grep for the route/tool name in `index.ts` /
     `build-server.ts`) — a written-but-unwired handler is a common way a
     feature looks done in isolation but isn't reachable.

4. **Check for a web UI gap.** Several `🟡` rows in this repo are
   "server done, no web UI yet" — that's a legitimate, common shape here
   (see PARITY.md's own entries for #26, #27, #37 as of this writing). If
   you're verifying a row and the server-side code is solid but nothing in
   `apps/web/` surfaces it, the status should be `🟡`, not `✅`, and the
   Notes column should say so explicitly — don't let a technically-correct
   backend imply full parity it doesn't have.

5. **Cross-check the "Remaining work" section at the bottom of PARITY.md.**
   If you're closing out a row, make sure that section (and any phase list
   in `README.md`'s Roadmap) doesn't still describe the same work as
   outstanding — these are two places that can drift out of sync with the
   table itself.

6. **Update honestly.** If the row's status changes, write Notes that
   would let a skeptical reviewer verify your claim the same way you just
   did — name the file, the test, the doc. If you found the row was
   actually WRONG (overclaiming), fix it down, not just up; an inflated
   ✅ is worse than an honest 🟡, because it hides a gap from whoever reads
   the table next.

## What "done" looks like for this skill

You've either confirmed the row's current status is accurate (and can say
why, concretely), or you've corrected it with Notes specific enough that
the next person doesn't have to redo this whole procedure from scratch.
