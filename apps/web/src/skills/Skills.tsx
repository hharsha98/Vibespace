/**
 * The Skills view (Phase 10, PARITY #37) — browse every discovered
 * `agentskills.io` skill (see `docs/SKILLS.md`) and send one into a
 * running pane. Another new centre view (Terminals | Editor | Preview |
 * Board | Graph | Swarm | Agents | Prompts | Skills | Settings, see
 * App.tsx's `CenterView`), same list+detail shape as Agents.tsx/Prompts.tsx:
 * a left column for browsing/searching, a right column for the selected
 * skill's full detail.
 *
 * `GET /api/skills` is the CATALOG (name/description/scope, never the
 * body — progressive disclosure per docs/SKILLS.md) and is fetched once
 * per visit; `GET /api/skills/:name` is fetched only when a row is
 * actually clicked, exactly the two-tier shape the server was built for —
 * fetching all ~68 real bodies up front (this machine's actual skill
 * count, per this phase's own spec) would defeat the point of the catalog
 * endpoint existing at all.
 *
 * --- Why there is no drag-and-drop here, despite `@dnd-kit` already
 *     being a dependency and `files/FileTree.tsx` already using it ---
 * PARITY #37 was written as "drag a skill onto a running pane". But a
 * pane only EXISTS on screen while `centerView === "terminals"` — every
 * other centre view (including this one) is mounted with `display: none`
 * on the Terminals `<div>` the whole time it's not active (see App.tsx's
 * top comment on `CenterView`). A `display: none` element has no layout
 * box at all, so it can never be a real drop target — there is nothing to
 * drop ONTO, because the user cannot see it and dnd-kit cannot compute a
 * hit-test against it. Dragging a skill row therefore cannot reach a pane
 * without either (a) making Terminals and Skills visible at the same
 * time, which the whole app's "one centre view at a time" layout doesn't
 * support anywhere else, or (b) a persistent pane strip visible from every
 * view, which does not exist and would be new UI surface well past this
 * phase's brief. Rather than ship a `useDraggable` row that silently does
 * nothing the moment you switch tabs to actually see a pane to drop it
 * on, this view uses the alternative PARITY #37's own text explicitly
 * allows: a "Send to pane…" control on the selected skill, listing every
 * pane with a live session in the CURRENT workspace's grid (passed down
 * from App.tsx as `panes`), each with its own send button. This reaches
 * the exact same endpoint (`POST /api/skills/:name/inject`) with the
 * exact same outcome, just via a click instead of a drop.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ListRow, Pill } from "../shell/ui.js";
import {
  filterSkills,
  groupSkillsByScope,
  paneInjectionTargets,
  type PaneRef,
  type SkillCatalogEntry,
  type SkillDetail,
  type SkillDiagnostic,
} from "./logic.js";

export interface SkillsProps {
  workspaceId: string | null;
  /** See Agents.tsx's identical prop for why this matters: centre views are
   * hidden with CSS `display`, never unmounted, so a plain mount-effect
   * fetch would show whatever was true the first time this view happened to
   * mount forever. */
  visible: boolean;
  /** Every pane in the ACTIVE workspace's grid that currently has a live
   * session attached — built by App.tsx from `listPanes(root)` + its own
   * `sessions` state. This is exactly the "Send to pane…" control's target
   * list; see this file's top comment for why it's a list of buttons and
   * not a drop zone. */
  panes: PaneRef[];
  /** Jumps the Terminals view to the given session's pane — reuses
   * App.tsx's `focusSessionInGrid`, the same "show me where that landed"
   * callback Board.tsx/Swarm.tsx already wire through `onFocusSession`. */
  onFocusSession: (sessionId: string) => void;
}

type LoadState = "loading" | "loaded" | "error";

async function parseErrorBody(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Server responded with ${res.status}`;
}

/** Outcome of the most recent inject attempt for one (skill, pane) pair —
 * keyed by paneId in the component below, so sending the same skill to two
 * different panes shows two independent results instead of one clobbering
 * the other. */
type InjectOutcome =
  | { kind: "sending" }
  | { kind: "success"; truncated: boolean }
  | { kind: "error"; message: string };

export default function Skills({ workspaceId, visible, panes, onFocusSession }: SkillsProps) {
  const [catalog, setCatalog] = useState<SkillCatalogEntry[]>([]);
  const [diagnostics, setDiagnostics] = useState<SkillDiagnostic[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const [query, setQuery] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("loaded");
  const [detailError, setDetailError] = useState<string | null>(null);

  // Keyed by paneId, not skill name — the panel only ever shows outcomes
  // for the CURRENTLY selected skill (cleared on selection change below),
  // so there's no ambiguity about which skill a given outcome belongs to.
  const [injectOutcomes, setInjectOutcomes] = useState<Record<string, InjectOutcome>>({});

  const reload = useCallback(() => {
    if (!workspaceId) {
      setCatalog([]);
      setDiagnostics([]);
      setLoadState("loaded");
      return;
    }
    setLoadState("loading");
    setLoadError(null);
    fetch(`/api/skills?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await parseErrorBody(res));
        return (await res.json()) as { skills: SkillCatalogEntry[]; diagnostics: SkillDiagnostic[] };
      })
      .then((body) => {
        setCatalog(body.skills);
        setDiagnostics(body.diagnostics);
        setLoadState("loaded");
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : "Failed to load skills");
        setLoadState("error");
      });
  }, [workspaceId]);

  // Re-fetch on mount-while-visible and on becoming visible — same trap
  // Agents.tsx's own `visible` prop doc describes: this component mounts
  // once, long before its tab is ever clicked.
  useEffect(() => {
    if (!visible) return;
    reload();
  }, [visible, reload]);

  // Switching workspaces invalidates whatever was selected and searched —
  // a stale selection could otherwise point at a skill name that exists in
  // the OLD workspace's project scope but not this one.
  useEffect(() => {
    setSelectedName(null);
    setDetail(null);
    setQuery("");
  }, [workspaceId]);

  const selectSkill = useCallback(
    (name: string) => {
      setSelectedName(name);
      setDetail(null);
      setDetailError(null);
      setInjectOutcomes({});
      if (!workspaceId) return;
      setDetailState("loading");
      fetch(`/api/skills/${encodeURIComponent(name)}?workspaceId=${encodeURIComponent(workspaceId)}`)
        .then(async (res) => {
          if (!res.ok) throw new Error(await parseErrorBody(res));
          return (await res.json()) as SkillDetail;
        })
        .then((full) => {
          setDetail(full);
          setDetailState("loaded");
        })
        .catch((err: unknown) => {
          setDetailError(err instanceof Error ? err.message : "Failed to load skill");
          setDetailState("error");
        });
    },
    [workspaceId]
  );

  const sendToPane = useCallback(
    (skillName: string, paneId: string, sessionId: string) => {
      if (!workspaceId) return;
      setInjectOutcomes((prev) => ({ ...prev, [paneId]: { kind: "sending" } }));
      fetch(`/api/skills/${encodeURIComponent(skillName)}/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, workspaceId }),
      })
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as { error?: string; truncated?: boolean };
          if (!res.ok) throw new Error(body.error ?? `Server responded with ${res.status}`);
          return body;
        })
        .then((body) => {
          setInjectOutcomes((prev) => ({
            ...prev,
            [paneId]: { kind: "success", truncated: Boolean(body.truncated) },
          }));
        })
        .catch((err: unknown) => {
          setInjectOutcomes((prev) => ({
            ...prev,
            [paneId]: { kind: "error", message: err instanceof Error ? err.message : "Failed to send skill" },
          }));
        });
    },
    [workspaceId]
  );

  const filtered = useMemo(() => filterSkills(catalog, query), [catalog, query]);
  const { project, user } = useMemo(() => groupSkillsByScope(filtered), [filtered]);
  const targets = useMemo(() => paneInjectionTargets(panes), [panes]);

  const errorDiagnosticCount = diagnostics.filter((d) => d.level === "error").length;

  if (!workspaceId) {
    return <div style={emptyStateStyle}>No workspace open.</div>;
  }
  if (loadState === "loading" && catalog.length === 0) {
    return <div style={emptyStateStyle}>Loading skills…</div>;
  }
  if (loadState === "error") {
    return <div style={emptyStateStyle}>{loadError ?? "Failed to load skills."}</div>;
  }

  return (
    <div style={pageStyle}>
      <div style={listPaneStyle}>
        <div style={listHeaderStyle}>
          <span style={listTitleStyle}>Skills</span>
          <span style={countStyle}>{filtered.length}</span>
        </div>

        <div style={{ padding: "8px 8px 4px" }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or description…"
            style={searchInputStyle}
          />
        </div>

        {diagnostics.length > 0 && (
          <div style={diagnosticsBannerStyle(errorDiagnosticCount > 0)}>
            <button
              type="button"
              onClick={() => setDiagnosticsOpen((prev) => !prev)}
              style={diagnosticsToggleStyle}
            >
              {diagnosticsOpen ? "▾" : "▸"} {diagnostics.length} diagnostic{diagnostics.length === 1 ? "" : "s"}
              {errorDiagnosticCount > 0 ? ` (${errorDiagnosticCount} skipped)` : ""}
            </button>
            {diagnosticsOpen && (
              <ul style={diagnosticsListStyle}>
                {diagnostics.map((d, i) => (
                  <li key={i} style={diagnosticItemStyle}>
                    <Pill status={d.level === "error" ? "danger" : "warn"}>{d.level}</Pill>
                    <span>{d.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto", padding: 4 }}>
          {filtered.length === 0 && catalog.length === 0 && (
            <p style={emptyListStyle}>
              No skills found. Skills live in <code>.agents/skills/</code>, <code>.vibedeck/skills/</code>, or{" "}
              <code>.claude/skills/</code>, under either this workspace or your home directory.
            </p>
          )}
          {filtered.length === 0 && catalog.length > 0 && (
            <p style={emptyListStyle}>No skills match "{query}".</p>
          )}

          {project.length > 0 && (
            <>
              <SectionLabel>This workspace (project)</SectionLabel>
              {/* PARITY #37's honesty requirement, per docs/SKILLS.md's trust-
                  boundary section: a project skill came from the repository
                  itself — content nobody has necessarily reviewed, e.g. right
                  after a fresh `git clone` — not from the person running
                  vibedeck. This is a plain note, not a scare banner: the
                  scope grouping above already makes the distinction visible
                  at a glance; this just names WHY it's worth noticing. */}
              <p style={trustNoteStyle}>
                From this repository — review before trusting, especially in a freshly cloned repo.
              </p>
              {project.map((s) => (
                <SkillRow key={s.name} skill={s} active={selectedName === s.name} onSelect={() => selectSkill(s.name)} />
              ))}
            </>
          )}

          {user.length > 0 && (
            <>
              <SectionLabel>Your skills (user)</SectionLabel>
              {user.map((s) => (
                <SkillRow key={s.name} skill={s} active={selectedName === s.name} onSelect={() => selectSkill(s.name)} />
              ))}
            </>
          )}
        </div>
      </div>

      <div style={detailPaneStyle}>
        {!selectedName && <div style={emptyDetailStyle}>Select a skill to see its full instructions.</div>}

        {selectedName && detailState === "loading" && <div style={emptyDetailStyle}>Loading…</div>}
        {selectedName && detailState === "error" && (
          <div style={emptyDetailStyle}>{detailError ?? "Failed to load skill."}</div>
        )}

        {selectedName && detail && detailState === "loaded" && (
          <div style={detailContentStyle}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <h3 style={detailTitleStyle}>{detail.name}</h3>
              <Pill status={detail.scope.kind === "project" ? "info" : "idle"}>
                {detail.scope.kind === "project" ? "Project" : "User"}
              </Pill>
            </div>
            <p style={detailDirStyle} title={detail.dir}>
              {detail.scope.dirLabel} · {detail.dir}
            </p>

            <p style={detailDescriptionStyle}>{detail.description}</p>

            {(detail.license || detail.compatibility) && (
              <div style={detailMetaRowStyle}>
                {detail.license && <span>License: {detail.license}</span>}
                {detail.compatibility && <span>Compatibility: {detail.compatibility}</span>}
              </div>
            )}

            {detail.allowedTools && (
              <p style={detailMetaRowStyle}>Allowed tools: {detail.allowedTools}</p>
            )}

            <PaneSendSection
              skillName={detail.name}
              targets={targets}
              outcomes={injectOutcomes}
              onSend={sendToPane}
              onFocusSession={onFocusSession}
            />

            <div style={bodyLabelStyle}>Body</div>
            <pre style={bodyStyle}>{detail.body}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={sectionLabelStyle}>{children}</div>;
}

function SkillRow({
  skill,
  active,
  onSelect,
}: {
  skill: SkillCatalogEntry;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <ListRow
      active={active}
      label={
        <span>
          <span style={{ color: "var(--vd-text)" }}>{skill.name}</span>
          <span style={rowDescriptionStyle}> — {skill.description}</span>
        </span>
      }
      title={`${skill.dir}\n${skill.description}`}
      onClick={onSelect}
      trailing={<span style={rowDirLabelStyle}>{skill.scope.dirLabel}</span>}
    />
  );
}

/**
 * The "Send to pane…" control this file's top comment explains in place of
 * drag-and-drop. Lists EVERY pane with a live session in the current
 * workspace's grid, including `shell` ones — greyed out with an explicit
 * reason rather than omitted, per PARITY #37's "indicate non-droppable
 * panes" requirement (this is the button-based equivalent of graying out a
 * drop target during a drag).
 */
function PaneSendSection({
  skillName,
  targets,
  outcomes,
  onSend,
  onFocusSession,
}: {
  skillName: string;
  targets: ReturnType<typeof paneInjectionTargets>;
  outcomes: Record<string, InjectOutcome>;
  onSend: (skillName: string, paneId: string, sessionId: string) => void;
  onFocusSession: (sessionId: string) => void;
}) {
  return (
    <div style={sendSectionStyle}>
      <div style={bodyLabelStyle}>Send to a running pane</div>
      {targets.length === 0 && (
        <p style={sendEmptyStyle}>No panes are running in this workspace right now.</p>
      )}
      {targets.map((target) => {
        const outcome = outcomes[target.paneId];
        const sending = outcome?.kind === "sending";
        return (
          <div key={target.paneId} style={sendRowStyle}>
            <span style={{ ...sendLabelStyle, opacity: target.eligible ? 1 : 0.5 }}>{target.label}</span>
            {target.eligible ? (
              <button
                type="button"
                onClick={() => onSend(skillName, target.paneId, target.sessionId)}
                disabled={sending}
                style={sendButtonStyle}
              >
                {sending ? "Sending…" : "Send"}
              </button>
            ) : (
              <span style={sendIneligibleStyle} title='A "shell" pane executes commands — it cannot act on a skill.'>
                shell pane — can't receive skills
              </span>
            )}
            {/* "Typed into the pane", not "the agent accepted it" — those are
              * genuinely different claims and we can only ever honestly make
              * the first. Writing to a pty is the same as the user typing:
              * if the agent is mid-task, still starting up, or sitting on a
              * modal of its own (cursor-agent's "Workspace Trust Required"
              * prompt is the one that caught this), the keystrokes go
              * nowhere and there is no signal back to us saying so. Hence
              * "Typed into the pane" plus a prompt to go and look, rather
              * than a confident "Sent." that would be overstating what we
              * actually know. */}
            {outcome?.kind === "success" && (
              <span style={sendResultOkStyle}>
                Typed into the pane — check it acted on it.{" "}
                {outcome.truncated && "The skill was too long and got cut off. "}
                <button type="button" onClick={() => onFocusSession(target.sessionId)} style={sendLinkStyle}>
                  View pane
                </button>
              </span>
            )}
            {outcome?.kind === "error" && <span style={sendResultErrorStyle}>{outcome.message}</span>}
          </div>
        );
      })}
    </div>
  );
}

const pageStyle: CSSProperties = {
  display: "flex",
  height: "100%",
  minHeight: 0,
  background: "var(--vd-bg)",
};

const listPaneStyle: CSSProperties = {
  width: 340,
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  borderRight: "1px solid var(--vd-border)",
  minHeight: 0,
};

const listHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  height: 40,
  flexShrink: 0,
  padding: "0 12px",
  borderBottom: "1px solid var(--vd-border)",
};

const listTitleStyle: CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--vd-text-faint)",
};

const countStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--vd-text-faint)",
};

const searchInputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--vd-bg)",
  color: "var(--vd-text)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 12,
};

function diagnosticsBannerStyle(hasError: boolean): CSSProperties {
  return {
    margin: "4px 8px",
    padding: "6px 8px",
    borderRadius: 4,
    border: `1px solid ${hasError ? "var(--vd-danger)" : "var(--vd-warn)"}`,
    background: `color-mix(in srgb, ${hasError ? "var(--vd-danger)" : "var(--vd-warn)"} 12%, var(--vd-bg))`,
    fontSize: 11,
  };
}

const diagnosticsToggleStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--vd-text)",
  fontSize: 11,
  cursor: "pointer",
  padding: 0,
  textAlign: "left",
  width: "100%",
};

const diagnosticsListStyle: CSSProperties = {
  listStyle: "none",
  margin: "6px 0 0",
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const diagnosticItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 6,
  color: "var(--vd-text-muted)",
};

const emptyListStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--vd-text-faint)",
  padding: "8px 8px",
  margin: 0,
  lineHeight: 1.6,
};

const sectionLabelStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--vd-text-faint)",
  padding: "8px 8px 2px",
};

const trustNoteStyle: CSSProperties = {
  fontSize: 10,
  color: "var(--vd-text-faint)",
  padding: "0 8px 6px",
  margin: 0,
  lineHeight: 1.5,
};

const rowDescriptionStyle: CSSProperties = {
  color: "var(--vd-text-muted)",
};

const rowDirLabelStyle: CSSProperties = {
  fontSize: 10,
  color: "var(--vd-text-faint)",
  flexShrink: 0,
  whiteSpace: "nowrap",
};

const detailPaneStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflowY: "auto",
  padding: 16,
};

const emptyDetailStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  color: "var(--vd-text-muted)",
  fontSize: 12,
};

const detailContentStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  maxWidth: 760,
};

const detailTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  fontWeight: 600,
  color: "var(--vd-text)",
};

const detailDirStyle: CSSProperties = {
  margin: 0,
  fontSize: 11,
  color: "var(--vd-text-faint)",
  fontFamily: "monospace",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const detailDescriptionStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "var(--vd-text)",
  lineHeight: 1.5,
};

const detailMetaRowStyle: CSSProperties = {
  display: "flex",
  gap: 16,
  fontSize: 11,
  color: "var(--vd-text-muted)",
};

const sendSectionStyle: CSSProperties = {
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: 10,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  background: "var(--vd-surface)",
};

const sendEmptyStyle: CSSProperties = {
  margin: 0,
  fontSize: 11,
  color: "var(--vd-text-faint)",
};

const sendRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
  flexWrap: "wrap",
};

const sendLabelStyle: CSSProperties = {
  color: "var(--vd-text)",
  minWidth: 110,
};

const sendButtonStyle: CSSProperties = {
  background: "var(--vd-accent)",
  color: "var(--vd-accent-text)",
  border: "none",
  borderRadius: 4,
  padding: "3px 10px",
  fontSize: 11,
  cursor: "pointer",
};

const sendIneligibleStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--vd-text-faint)",
  fontStyle: "italic",
};

const sendResultOkStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--vd-ok)",
};

const sendResultErrorStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--vd-danger)",
};

const sendLinkStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--vd-accent)",
  fontSize: 11,
  cursor: "pointer",
  padding: 0,
  textDecoration: "underline",
};

const bodyLabelStyle: CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--vd-text-faint)",
};

const bodyStyle: CSSProperties = {
  margin: 0,
  padding: 12,
  background: "var(--vd-bg)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  fontFamily: "monospace",
  fontSize: 11.5,
  lineHeight: 1.6,
  color: "var(--vd-text)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const emptyStateStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  color: "var(--vd-text-muted)",
  fontSize: 12,
  background: "var(--vd-bg)",
};
