# The swarm mechanism

BridgeSwarm publishes what its swarm *achieves* — roles, file ownership,
sequenced dependencies, a reviewer gating every merge — but not how. There is
no BridgeSwarm documentation page and the orchestration layer is described as
proprietary (see `RESEARCH.md` §3).

So this is ours. It keeps their observable model and specifies the parts they
left unstated.

## The problem

Several agents work on one codebase at once. Left alone they will:

- edit the same file and silently overwrite each other,
- duplicate work because neither knows what the other is doing,
- declare themselves finished on work that does not build,
- and stall forever without anyone noticing.

Each of the four needs its own answer.

---

## 1. Mission → tasks → waves

A **mission** is one sentence of intent. A **coordinator** decomposes it into
**tasks**, and every task declares, up front, the file paths it expects to
touch (`declaredPaths`).

Tasks are then grouped into **waves**: within a wave, no two tasks share a
declared path, so every task in a wave can run in parallel safely. A task that
overlaps an earlier one lands in a later wave. A wave dispatches only once the
previous wave completes.

This is the borrowed idea, and it is the right one: **the best way to survive a
collision is for it never to happen.** Contention is resolved at planning time,
when it costs nothing, rather than at write time, when it costs work.

`planSchedule(tasks) → waves` is a pure function and heavily unit-tested. It is
graph colouring; greedy is fine. It must be correct, not optimal.

## 2. Claims — the safety net

Declared paths are a *prediction*, and predictions are wrong. An agent asked to
"fix the login bug" may discover it must also touch a shared helper it never
declared.

So before editing anything, an agent claims the path. Claims are arbitrated by
a **`UNIQUE(mission_id, path)` constraint in the database**: the insert is
attempted unconditionally and the loser catches the constraint violation. There
is deliberately no "check if free, then take it" — two agents racing would both
pass the check. **The write is the check.**

Three supporting rules:

- **Paths are canonicalised first**, so `./src/a.ts` and `src/a.ts` are one claim.
- **Claims never block.** You get it, or you are told who holds it. Refusing
  immediately means two agents can never deadlock waiting on each other.
- **Claims expire.** A 10-minute heartbeat; a crashed agent's files become
  claimable again rather than locked forever.

## 3. Detection — for when neither works

Ownership is **cooperative**. Nothing stops an agent running `echo > file` on
something it never claimed, and no tool driving third-party CLI agents can stop
it — including BridgeSwarm, whose own wording is "any agent *that can follow*
structured ownership".

So the filesystem watcher records a **conflict** whenever a file changes while a
different agent holds its claim. That does not prevent the write, but it means
the collision is visible instead of silent, and you know which agent to
distrust.

**What each layer actually guarantees:**

| Layer | Guarantees |
|---|---|
| Wave scheduling | Two tasks that *declared* the same file never run together |
| Claim registry | Two agents never both *believe* they own a file |
| Watcher | An undeclared, unclaimed write is *noticed* |

Nothing here guarantees an agent cannot write a file. That claim would be false,
so we do not make it.

## 4. Quality gates and review

A task cannot reach `complete` on the agent's own say-so.

- **Gate:** a command (tests, typecheck, lint) must exit zero. Output is capped
  and the run is timed out, so a hung gate cannot wedge the server.
- **Review:** a `reviewer`-role agent must approve. Builders write; reviewers
  and scouts do not edit code.

A task failing its gate repeatedly is not retried forever — after a small
number of attempts it moves to `blocked` and surfaces to you. Loops that never
terminate are worse than visible failure.

## 5. Liveness

Every agent heartbeats. An agent silent past the threshold is marked stalled,
its claims are released, and its task returns to the queue for reassignment.
Without this a single hung agent halts the wave, and therefore the mission,
with nothing on screen explaining why.

## 6. Roles

| Role | Does | Does not |
|---|---|---|
| **Coordinator** | Decomposes the mission, assigns tasks, synthesises results | Write code |
| **Builder** | Writes code; must claim before editing | Approve its own work |
| **Scout** | Explores, researches, reports findings | Edit code |
| **Reviewer** | Reviews builder output, approves or rejects | Edit code |

Roles are enforced by what the API lets each one do, not merely by asking
nicely in a prompt — a reviewer's approval on its own task is rejected.

## 7. Communication

A shared **mailbox**: directed messages to one agent, or broadcast to all.
Messages are delivered into the target agent's terminal when it has a live
session, and are persisted so an agent that starts later can catch up.

The rule borrowed from their model, and worth keeping: **they ship code, not
chat.** The mailbox exists to hand off findings and unblock work, not to hold a
conversation.

---

## Why this is stronger than what they describe

Their claim is that agents "never collide". Ours is narrower and true: planned
collisions are prevented, unplanned ones are caught, and the rest are made
visible. Plus stall detection and failure escalation, which their published
material does not mention and without which a swarm quietly hangs.
