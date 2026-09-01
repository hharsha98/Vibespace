# Swarm core (Phase 9a)

A **mission** splits one prompt across several dispatched agent sessions —
each playing a **role** (coordinator, builder, scout, reviewer) — that
coordinate over a shared **mailbox** and share a workspace's files. This
file is the server-side reference: the REST API, the data model, and —
most importantly — an honest account of how file ownership actually works
and what it can and can't guarantee. Phase 9b (not built yet) adds a visual
mission canvas in the web UI; everything here works over plain HTTP today.

The server listens on `http://localhost:4317` by default.

## The three layers of file ownership, and what each one is honestly for

A swarm's whole risk is two agents corrupting the same file. Vibespace
addresses that with **three separate, complementary mechanisms** — not one
mechanism with three names. Understand which one you're relying on:

| Layer | What it does | What it can't do |
|---|---|---|
| **1. Sequencing** (`mission_tasks` + `planSchedule`) | Groups tasks with no declared-path overlap into "waves" that can run concurrently; a task can't start until every task in an earlier wave is complete. Prevents **planned** collisions before any agent is even spawned. | Only as good as what a task *declares* it will touch. A task that touches an undeclared file isn't sequenced against it. |
| **2. Claims** (`file_claims`, this doc's main section) | An agent reserves a path before editing it. A second claim on the same path is refused (409) and told exactly who holds it — no queueing, no blocking. Catches **unplanned** collisions between cooperating agents at claim-time. | Advisory. An agent that never calls the claims API (or ignores a 409) is not physically stopped from writing the file anyway. |
| **3. Conflict detection** (`claim_conflicts`, a chokidar watcher) | Watches the workspace while a mission runs; if a claimed path changes on disk, it records a conflict row naming the current holder. Catches what layers 1 and 2 couldn't prevent. | Detection, not prevention — by the time a conflict is recorded, the write already happened. It also can't tell WHO wrote it (a filesystem watcher has no process attribution), only that the path changed while someone held the claim — including the holder's own legitimate edit. |

**Do not read this as "agents never collide."** They can, if an agent is
uncooperative or a task's declared paths are wrong. What these three layers
actually guarantee is: a **cooperating** swarm — one where builders declare
their paths and call the claims API before editing — cannot silently
corrupt each other's work, and if something outside that contract still
goes wrong, there's a record of it.

## Roles

| Role | What it does |
|---|---|
| `coordinator` | Splits the mission prompt into tasks, assigns them over the mailbox, synthesises results. Does not edit files. |
| `builder` | Writes code. **Must claim a path before editing it.** |
| `scout` | Explores the codebase, reports findings over the mailbox. Never edits. |
| `reviewer` | Reviews other agents' work. Never edits. The only role that can approve a task to `complete` (see Tasks below). |

Each role gets a short, single-line preamble typed into its pty when
spawned — see `apps/server/src/swarm/roles.ts`. It names the agent's own
id, its role's rules, and the mailbox URLs it needs, followed by the
mission prompt.

## Missions

```
POST /api/swarm/missions
{ "workspaceId": "<id>", "prompt": "Build the login flow", "agents": [
  { "role": "coordinator", "agent": "claude" },
  { "role": "builder", "agent": "claude", "count": 2 },
  { "role": "reviewer", "agent": "claude" }
]}
```

Spawns one pty session per requested agent (labelled "Builder 1", "Builder
2", ... per role) and types each its role preamble. Returns `201` with the
full mission detail (see below). `409` if any requested `agent` CLI isn't
installed, naming which one.

```
GET /api/swarm/missions?workspaceId=<id>       -> { missions: [...] }
GET /api/swarm/missions/:id                     -> mission + agents + messages + claims + conflicts + tasks
PATCH /api/swarm/missions/:id  { "status": "paused" | "running" | "stopped" | "complete" }
```

`status: "stopped"` is the one transition with real side effects: it kills
every agent's pty session AND releases every claim the mission holds —
claims must never outlive their holder, and a stopped mission has no
holders left. Pausing/completing stop the conflict watcher but leave
sessions and claims alone (they're meant to be resumable).

## Mailbox

```
POST /api/swarm/missions/:id/messages
{ "fromAgentId": "<agent id or omit for human>", "toAgentId": "<agent id or omit to broadcast>", "body": "..." }

GET /api/swarm/missions/:id/messages?since=<ISO timestamp>
```

A message with `toAgentId` set is delivered into that agent's live pty (if
it has one); omitting it broadcasts into every agent's pty. `fromAgentId`
omitted/null means the message is from a human. `since` is for polling —
pass the last message's `createdAt` back in to fetch only what's new.

## Tasks and scheduling (layer 1)

A `mission_task` is a unit of work with **declared paths** — what it
expects to touch, known before any agent starts. `GET
.../tasks/schedule` groups a mission's current tasks into **waves**:
batches with no overlapping declared path, safe to run concurrently.

```
POST /api/swarm/missions/:id/tasks
{ "title": "Add login form", "prompt": "...", "declaredPaths": ["src/login.tsx"] }

GET /api/swarm/missions/:id/tasks
GET /api/swarm/missions/:id/tasks/schedule      -> { "waves": [["taskIdA","taskIdC"], ["taskIdB"]] }
PATCH /api/swarm/missions/:id/tasks/:taskId  { "status": "pending"|"running"|"in_review"|"blocked", "assignedAgentId": "..." }
```

Two tasks that declare the same path always land in different waves — one
must finish before the other starts. A task with no declared paths never
blocks anything and is never blocked. Moving a task to `"running"` is
**refused (409)** if any task in an earlier wave isn't `complete` yet,
naming exactly which task ids are blocking it — this is what "only
dispatch a wave once the previous wave is complete" means in practice: it
is enforced at the moment something tries to start early, not by a
background scheduler process.

### The reviewer gate

A task can reach `complete` **only** through review approval — there is no
other request that sets a task's status to `complete`; a direct `PATCH
{"status":"complete"}` is rejected with a `400` pointing at this endpoint.

```
POST /api/swarm/missions/:id/tasks/:taskId/review
{ "reviewerAgentId": "<an agent actually playing the reviewer role in this mission>", "approved": true, "notes": "Looks good" }
```

`approved: true` moves the task to `complete`. `approved: false` moves it
to `blocked` (needs rework) and records the notes so the builder knows
why. The server checks that `reviewerAgentId` names a real agent in this
mission with `role: "reviewer"` — a builder or scout trying to approve its
own work gets `403`. This is what makes "a task cannot reach complete
without a reviewer-role approval" an enforced rule, not a convention.

## Claims (layer 2)

```
POST /api/swarm/missions/:id/claims          { "agentId": "...", "path": "src/foo.ts" }   -> 201, or 409 naming the holder
POST /api/swarm/missions/:id/claims/heartbeat { "agentId": "..." }                          -> refreshes every claim that agent holds
DELETE /api/swarm/missions/:id/claims         { "agentId": "...", "path": "src/foo.ts" }    -> releases one path (omit "path" to release everything the agent holds)
```

Claims **never block**. A claim either succeeds immediately or fails and
names the current holder — there is no queue, so two agents can never
deadlock waiting on each other. Paths are normalised before storage
(`./src/a.ts`, `src/a.ts`, and `src//a.ts` are the same claim) and must
resolve inside the workspace root — an escaping path is rejected the same
way a file-route request would be.

A claim without a heartbeat for **10 minutes** is stale and reclaimable by
a different agent (its holder likely crashed or stopped checking in); a
fresh claim is not. This is arbitrated by the database itself — SQLite's
`UNIQUE(mission_id, path)` constraint decides who wins a simultaneous claim
race, not a check-then-write in application code, which is the only way to
close the race window entirely.

## Conflicts (layer 3)

```
GET /api/swarm/missions/:id/conflicts   -> { conflicts: [{ path, holderAgentId, detectedAt }, ...] }
```

While a mission is `running`, Vibespace watches its workspace (the same
chokidar mechanism the file tree's live-update feature uses). If a claimed
path changes on disk, a conflict row is recorded naming the path and
whoever currently holds the claim on it. Read this as a trip-wire for a
human/coordinator to glance at, not a proof of wrongdoing — see the table
at the top of this doc.

## Quality gates

```
POST /api/swarm/missions/:id/gates   { "command": "pnpm test" }
-> { "passed": true, "exitCode": 0, "output": "..." }
```

Runs `command` via the shell inside the mission's workspace. Output is
captured stdout+stderr, capped at 64KB (a runaway build log stops growing
the response rather than the process). The command is force-killed if it
runs longer than 2 minutes, so a hung gate can't wedge the server.

## Error responses

Same conventions as the board/memory endpoints (`docs/AGENT-API.md`): `400`
for a missing/invalid field, `404` for an unknown mission/task/workspace
id, `409` for a lost claim race or an unready wave, `403` for a
non-reviewer trying to approve a task. The body is always `{ "error": "..." }`
(claim conflicts additionally include `holder`; wave-not-ready additionally
includes `blockedBy`).
