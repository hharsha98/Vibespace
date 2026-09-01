# What BridgeMind publishes, and how to use it

Vibespace is built to match BridgeSpace. This file records everything BridgeMind
actually publishes, so design decisions draw on their documented behaviour
rather than on guesswork — and so we know, in advance, which questions their
docs can answer and which they can't.

Read 2026-08-12: `docs.bridgemind.ai` (BridgeSpace, BridgeMCP, BridgeAgent
pages) and the BridgeSpace / BridgeSwarm product pages.

---

## 1. The map: what exists, and what is documented

| Surface | Documented? | Relevance to us |
|---|---|---|
| BridgeSpace | **Yes**, in detail | The product we match. See `PARITY.md`. |
| BridgeMCP | **Yes**, full tool reference | High — it defines how their agents talk to the platform |
| BridgeAgent | Yes | Low — a separate autonomous agent product, not a workroom |
| BridgeVoice / BridgeShot | Yes | Out of scope — different applications |
| **BridgeSwarm** | **No docs page at all** | The orchestration layer is described only in marketing copy and called "proprietary" |

**The single most useful fact here:** feature *behaviour* is documented; feature
*implementation* generally is not. Their MCP tool contract is fully specified.
Their swarm coordination algorithm is not published anywhere.

## 2. BridgeMCP — their agent contract, in full

This is the most valuable thing they publish, because it is the exact surface
their agents program against. Fourteen tools:

**Projects:** `list_projects`, `create_project`
**Tasks:** `list_tasks`, `get_task`, `create_task`, `update_task`
**Agents:** `list_agents`, `get_agent`, `create_agent`, `update_agent`, `delete_agent`
**Plus** a built-in MCP *prompt*, `bridgemind_developer_guide`, that onboards an
agent into the whole workflow.

Details worth copying:

- **Task lifecycle:** `todo → in-progress → in-review → complete`, plus
  `cancelled`. Five states, not four.
- **`taskKnowledge`** — a field *separate from* the instructions, up to 50,000
  characters, carrying architecture decisions, file paths, API specs and links.
  The agent receives it when it reads the task. Instructions are capped far
  lower (5,000). Splitting "what to do" from "what you need to know" is a real
  design idea, not padding.
- **Agents are records, not just a picked CLI:** `{name, systemPrompt}` scoped
  to a project, with a 100,000-character system prompt, full CRUD.
- **Transport:** hosted service, streamable HTTP preferred, SSE as legacy
  fallback, API-key auth.

**Their stated philosophy:** *"You act as the Technical Director"* — the human
creates the task, the agent builds and moves it to in-review, **the human
approves**. Note this contradicts BridgeSwarm's "a Reviewer gates every merge".
Two different products, two different review models; don't assume one implies
the other.

## 3. BridgeSwarm — what is claimed, and what is missing

Claimed on the product page:

> "Each task exclusively owns the files it touches, so concurrent agents never
> collide. **Shared dependencies get sequenced automatically.**"
> "…any terminal-based coding agent **that can follow** structured ownership and review."

What we can take from this:

- **The design shape is copyable and good.** Ownership is declared *per task*,
  and overlapping tasks are *sequenced* rather than allowed to race. That is a
  scheduler, not a lock, and it is better than a lock because the collision
  never happens rather than being reported after the fact.
- **The mechanism is not published.** No docs page, no schema, no algorithm.
  There is nothing to copy at implementation level and no point searching for it.
- **They cannot enforce it either.** "Agents *that can follow* structured
  ownership" is the tell. They drive the same third-party CLIs we do; nothing
  stops `claude` writing a file it never claimed. "Never collide" is marketing,
  not a guarantee.

Our implementation therefore keeps their shape and adds what they don't claim:
sequencing (prevent planned collisions) → database-arbitrated claims (catch
collisions the plan got wrong) → filesystem watcher (detect what neither
stops). See `docs/SWARM.md`.

## 4. Skills — there is an open standard

BridgeAgent's docs: the agent "creates new skills on the fly and shares them via
the **open `agentskills.io` standard**", with a public Skills Hub.

This matters for Phase 10. Skills are the one place where an interoperable
public format exists — so Vibespace should **implement that standard** rather
than invent a private one. Read `agentskills.io` before starting Phase 10.

## 5. Gaps this research uncovered

Not visible from the BridgeSpace page alone; now added to `PARITY.md`:

| Gap | Where it came from |
|---|---|
| `cancelled` task state (5 states, we have 4) | MCP task lifecycle |
| `taskKnowledge` — long-form context separate from instructions | MCP `create_task` |
| Board/tasks exposed **over MCP**, not just HTTP | MCP task tools |
| Agent records with stored system prompts, project-scoped, full CRUD | MCP agent tools |
| An MCP prompt that onboards an agent to the workflow | `bridgemind_developer_guide` |
| Skills should follow the `agentskills.io` standard | BridgeAgent docs |

We had already exposed *memory* over MCP in Phase 8; exposing the *board* over
the same server is the natural next step and is what their agents actually use.

## 6. Deliberate divergences

| Them | Us | Why |
|---|---|---|
| Account, API key, hosted MCP at `mcp.bridgemind.ai` | Local-first, no account, stdio MCP | Vibespace runs entirely on your machine |
| Pro tier gates workspace tabs, kanban, agent config, prompts library | Everything free | No licensing model |
| Their theme set and brand | Community palettes, our own mark | Matching a design language is fair; copying a brand is not |

## 7. How to handle the next question like this

The file-collision question is a template. When a design problem arises:

1. **Check whether they document the behaviour.** The BridgeSpace and BridgeMCP
   pages are specific and worth reading first.
2. **Expect the mechanism to be absent.** They publish contracts and lifecycles,
   not algorithms. If a page says "proprietary", stop looking.
3. **Take the shape, not the claim.** Their marketing states outcomes
   ("never collide"). Extract the underlying model — here, per-task ownership
   plus sequencing — and treat the guarantee as unproven.
4. **Look for an open standard first.** `agentskills.io` and MCP itself are
   public; where one exists, implement it rather than a private equivalent.
5. **Add the layer they don't mention.** Their claims assume cooperating
   agents. Ours should degrade honestly when that assumption breaks, and the
   docs should say which layer guarantees what.
6. **Record the finding here** so the next decision starts from it.
