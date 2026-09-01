/**
 * The Agents page (Phase 9.5b, PARITY #26): CRUD for this workspace's saved
 * agent "personas" — a name, which underlying CLI it runs as (`baseAgent`),
 * and a system prompt typed into that CLI's pty ahead of a dispatched task
 * (see `@vibespace/shared`'s `AgentProfile` doc comment for the full idea).
 * A new centre view (Terminals | Editor | Preview | Board | Graph | Swarm |
 * Agents | Prompts, see App.tsx's `CenterView`), following the same "fetch
 * and own its own data given just a workspaceId" pattern as
 * Board.tsx/Graph.tsx/Swarm.tsx, with a list+detail layout scaled up from
 * MemoryPanel.tsx's (that one lives in a 320px dock tab; this is a full
 * centre view, so the list gets its own column instead of a "back" button).
 *
 * `GET/POST/PATCH/DELETE /api/agent-profiles` is backed by
 * `apps/server/src/agents/routes.ts` — see that file's top comment for why
 * agent-profile CRUD lives under `/api/agent-profiles` and NOT `/api/agents`
 * (that path already means something else: "which CLIs are installed on
 * this machine", a static, workspace-less check with no database row).
 */
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  AGENT_IDS,
  AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH,
  AGENT_SPECS,
  type AgentId,
  type AgentProfile,
} from "@vibespace/shared";
import { charCountColor, charCountStatus } from "../shell/textLimits.js";
import { Button, EmptyState, ListRow, Pill } from "../shell/ui.js";
import { FONT, RADIUS, SPACE } from "../shell/tokens.js";

export interface AgentsProps {
  workspaceId: string | null;
  /**
   * Whether this is the visible centre view. Centre views are never
   * unmounted, only hidden with CSS `display` (see App.tsx's top comment),
   * so this component mounts exactly once, usually long before anyone has
   * clicked its tab — a plain mount-effect fetch would show that first
   * (typically empty) result forever. Same trap Graph.tsx's own `visible`
   * prop doc describes, and the same fix: refetch whenever this flips true.
   */
  visible: boolean;
}

type LoadState = "loading" | "loaded" | "error";

async function parseErrorBody(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Server responded with ${res.status}`;
}

interface FormState {
  name: string;
  systemPrompt: string;
  baseAgent: AgentId;
}

const EMPTY_FORM: FormState = { name: "", systemPrompt: "", baseAgent: AGENT_IDS[0] };

export default function Agents({ workspaceId, visible }: AgentsProps) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!workspaceId) {
      setProfiles([]);
      setLoadState("loaded");
      return;
    }
    setLoadState("loading");
    setLoadError(null);
    fetch(`/api/agent-profiles?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await parseErrorBody(res));
        return (await res.json()) as { agents: AgentProfile[] };
      })
      .then((body) => {
        setProfiles(body.agents);
        setLoadState("loaded");
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : "Failed to load agent profiles");
        setLoadState("error");
      });
  }, [workspaceId]);

  // Re-fetch on mount-while-visible, on becoming visible, and whenever the
  // active workspace changes — see the `visible` prop's own doc comment for
  // why the middle case matters here specifically.
  useEffect(() => {
    if (!visible) return;
    reload();
  }, [visible, reload]);

  // Switching workspaces (even while this view stays hidden) invalidates
  // whatever was selected — a stale selectedId from the OLD workspace could
  // otherwise briefly point at a profile id that means nothing here.
  useEffect(() => {
    setSelectedId(null);
    setCreatingNew(false);
    setFormError(null);
  }, [workspaceId]);

  const selected = profiles.find((p) => p.id === selectedId) ?? null;

  const startCreate = useCallback(() => {
    setCreatingNew(true);
    setSelectedId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  }, []);

  const startEdit = useCallback((profile: AgentProfile) => {
    setSelectedId(profile.id);
    setCreatingNew(false);
    setForm({ name: profile.name, systemPrompt: profile.systemPrompt, baseAgent: profile.baseAgent });
    setFormError(null);
    setPendingDeleteId(null);
  }, []);

  const cancelForm = useCallback(() => {
    setCreatingNew(false);
    setSelectedId(null);
    setFormError(null);
  }, []);

  const submit = useCallback(() => {
    if (!workspaceId) return;
    const name = form.name.trim();
    if (!name) {
      setFormError('"name" must be a non-empty string');
      return;
    }
    if (!form.systemPrompt.trim()) {
      setFormError('"systemPrompt" must be a non-empty string');
      return;
    }
    // Mirrors agents/routes.ts's own length check — the textarea's
    // `maxLength` below already stops most typing/pasting past the cap, but
    // this is the same "don't just trust the client widget" belt-and-braces
    // check `AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH` deserves given it's
    // shared specifically so both sides agree.
    if (form.systemPrompt.length > AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH) {
      setFormError(`"systemPrompt" must be at most ${AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH} characters`);
      return;
    }
    setSaving(true);
    setFormError(null);

    const isEdit = selectedId !== null;
    const url = isEdit ? `/api/agent-profiles/${selectedId}` : "/api/agent-profiles";
    const method = isEdit ? "PATCH" : "POST";
    const payload = isEdit
      ? { name, systemPrompt: form.systemPrompt, baseAgent: form.baseAgent }
      : { workspaceId, name, systemPrompt: form.systemPrompt, baseAgent: form.baseAgent };

    fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(await parseErrorBody(res));
        return (await res.json()) as AgentProfile;
      })
      .then((saved) => {
        setProfiles((prev) => (isEdit ? prev.map((p) => (p.id === saved.id ? saved : p)) : [...prev, saved]));
        setSelectedId(saved.id);
        setCreatingNew(false);
      })
      .catch((err: unknown) => {
        // The 409 duplicate-name response (agents/routes.ts's
        // `duplicateNameError`) lands here as `err.message` — a readable
        // sentence naming exactly what collided, not a raw JSON blob — same
        // as every other validation error this form can hit.
        setFormError(err instanceof Error ? err.message : "Failed to save agent profile");
      })
      .finally(() => setSaving(false));
  }, [workspaceId, form, selectedId]);

  const confirmDelete = useCallback((id: string) => {
    fetch(`/api/agent-profiles/${id}`, { method: "DELETE" })
      .then((res) => {
        if (!res.ok && res.status !== 204) throw new Error(`Server responded with ${res.status}`);
        setProfiles((prev) => prev.filter((p) => p.id !== id));
        setPendingDeleteId(null);
        setSelectedId((prevSelected) => (prevSelected === id ? null : prevSelected));
      })
      .catch((err: unknown) => {
        setFormError(err instanceof Error ? err.message : "Failed to delete agent profile");
      });
  }, []);

  if (!workspaceId) {
    return (
      <div style={emptyStateStyle}>
        <EmptyState title="No workspace open" description="Open a workspace to manage its agent profiles." />
      </div>
    );
  }
  if (loadState === "loading" && profiles.length === 0) {
    return (
      <div style={emptyStateStyle}>
        <EmptyState title="Loading agents…" />
      </div>
    );
  }
  if (loadState === "error") {
    return (
      <div style={emptyStateStyle}>
        <EmptyState
          title="Couldn't load agents"
          description={loadError ?? "Failed to load agent profiles."}
        />
      </div>
    );
  }

  const promptLength = form.systemPrompt.length;
  const promptStatus = charCountStatus(promptLength, AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH);
  const showForm = creatingNew || selected !== null;

  return (
    <div style={pageStyle}>
      <div style={listPaneStyle}>
        <div style={listHeaderStyle}>
          <span style={listTitleStyle}>Agents</span>
          {/* Hidden while the list is empty — EmptyState's own primary
              action below already offers the identical "+ New agent" call
              to action, so showing both would just be the same action
              twice, same "don't offer a CTA the empty state already owns"
              idiom board/Column.tsx's hideAddTrigger follows. */}
          {profiles.length > 0 && (
            <button type="button" onClick={startCreate} style={addButtonStyle}>
              + New agent
            </button>
          )}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 4 }}>
          {profiles.length === 0 && (
            <div style={emptyListWrapStyle}>
              <EmptyState
                icon={<AgentGlyphBadge />}
                title="No agent profiles yet"
                description="Save a name, base CLI, and system prompt as a reusable persona you can dispatch board cards to."
                action={
                  <Button variant="primary" onClick={startCreate}>
                    + New agent
                  </Button>
                }
              />
            </div>
          )}
          {profiles.map((profile) => (
            <ListRow
              key={profile.id}
              active={selectedId === profile.id}
              label={profile.name}
              title={profile.name}
              onClick={() => startEdit(profile)}
              trailing={<Pill status="info">{AGENT_SPECS[profile.baseAgent].displayName}</Pill>}
            />
          ))}
        </div>
      </div>

      <div style={detailPaneStyle}>
        {!showForm && (
          <div style={emptyDetailStyle}>
            <EmptyState
              icon={<AgentGlyphBadge />}
              title="Select an agent"
              description="Pick one from the list to edit it, or create a new one."
              action={
                <Button variant="secondary" onClick={startCreate}>
                  + New agent
                </Button>
              }
            />
          </div>
        )}

        {showForm && (
          <div style={formStyle}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3 style={formTitleStyle}>{creatingNew ? "New agent" : "Edit agent"}</h3>
              {!creatingNew && selected && (
                <button type="button" onClick={() => setPendingDeleteId(selected.id)} style={dangerLinkStyle}>
                  Delete
                </button>
              )}
            </div>

            {selected && pendingDeleteId === selected.id && (
              <div style={confirmBannerStyle}>
                <span>Delete "{selected.name}"? This can't be undone.</span>
                <div style={{ display: "flex", gap: SPACE.sm }}>
                  <button
                    type="button"
                    onClick={() => confirmDelete(selected.id)}
                    className="vd-btn-danger"
                    style={dangerButtonStyle}
                  >
                    Delete
                  </button>
                  <Button variant="secondary" onClick={() => setPendingDeleteId(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            <label style={labelStyle}>
              <span style={labelTextStyle}>Name</span>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Backend reviewer"
                style={inputStyle}
              />
            </label>

            <label style={labelStyle}>
              <span style={labelTextStyle}>Base CLI</span>
              <select
                value={form.baseAgent}
                onChange={(e) => setForm((f) => ({ ...f, baseAgent: e.target.value as AgentId }))}
                style={inputStyle}
              >
                {AGENT_IDS.map((id) => (
                  <option key={id} value={id}>
                    {AGENT_SPECS[id].displayName}
                  </option>
                ))}
              </select>
            </label>

            <label style={labelStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={labelTextStyle}>System prompt</span>
                <span style={{ fontSize: 11, color: charCountColor(promptStatus) }}>
                  {promptLength.toLocaleString()} / {AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH.toLocaleString()}
                </span>
              </div>
              <textarea
                value={form.systemPrompt}
                onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
                maxLength={AGENT_PROFILE_SYSTEM_PROMPT_MAX_LENGTH}
                placeholder="What should this agent always know or do before it starts working?"
                rows={18}
                style={textareaStyle}
              />
            </label>

            {formError && <p style={errorStyle}>{formError}</p>}

            <div style={{ display: "flex", gap: SPACE.sm }}>
              <Button type="submit" variant="primary" onClick={submit} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button variant="secondary" onClick={cancelForm}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The Agents page's own tinted-circle icon badge — a small dashed-outline
 * "persona" glyph (two overlapping rounded shapes, standing in for "an agent
 * plus its own system prompt"), reused between the list-empty and detail-
 * empty states so this page reads as one designed screen, not two different
 * placeholder treatments. Same `color-mix` badge pattern board/Column.tsx's
 * `iconBadgeStyle` and skills/Skills.tsx's detail badge already use. */
function AgentGlyphBadge() {
  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 36,
        height: 36,
        borderRadius: "50%",
        background: "color-mix(in srgb, var(--vd-accent) 16%, transparent)",
      }}
    >
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden style={{ color: "var(--vd-accent)" }}>
        <circle cx="8" cy="7" r="3.2" stroke="currentColor" strokeWidth="1.3" />
        <path d="M2.5 17c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="15" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.5 1.5" opacity="0.7" />
      </svg>
    </span>
  );
}

const pageStyle: CSSProperties = {
  display: "flex",
  height: "100%",
  minHeight: 0,
  background: "var(--vd-bg)",
};

const listPaneStyle: CSSProperties = {
  width: 260,
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
  fontSize: FONT.meta,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--vd-text-faint)",
};

const addButtonStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--vd-accent)",
  fontSize: FONT.meta,
  cursor: "pointer",
  padding: 0,
};

/** Wraps the list column's empty EmptyState with the same top-heavy padding
 * board/Column.tsx's own invite-empty wrapper uses, so it doesn't sit flush
 * under the header. */
const emptyListWrapStyle: CSSProperties = {
  padding: `${SPACE.xl}px ${SPACE.sm}px ${SPACE.sm}px`,
};

const detailPaneStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflowY: "auto",
  padding: SPACE.lg,
};

const emptyDetailStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  color: "var(--vd-text-muted)",
  fontSize: FONT.body,
};

const formStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: SPACE.md,
  maxWidth: 640,
};

const formTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: FONT.title,
  fontWeight: 600,
  color: "var(--vd-text)",
};

const labelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: FONT.body,
  color: "var(--vd-text-muted)",
};

const labelTextStyle: CSSProperties = {
  fontSize: FONT.meta,
  letterSpacing: "0.04em",
  color: "var(--vd-text-muted)",
};

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--vd-bg)",
  color: "var(--vd-text)",
  border: "1px solid var(--vd-border)",
  borderRadius: RADIUS.sm,
  padding: "6px 8px",
  fontSize: FONT.body,
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  fontFamily: "monospace",
  fontSize: FONT.meta,
  lineHeight: 1.5,
  resize: "vertical",
};

const errorStyle: CSSProperties = {
  fontSize: FONT.meta,
  color: "var(--vd-danger)",
  margin: 0,
};

const dangerButtonStyle: CSSProperties = {
  background: "var(--vd-danger)",
  color: "var(--vd-bg)",
  border: "none",
  borderRadius: RADIUS.sm,
  padding: "5px 14px",
  fontSize: FONT.body,
  cursor: "pointer",
};

const dangerLinkStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--vd-danger)",
  fontSize: 11,
  cursor: "pointer",
  padding: 0,
};

const confirmBannerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: 8,
  background: "color-mix(in srgb, var(--vd-danger) 15%, var(--vd-bg))",
  border: "1px solid var(--vd-danger)",
  borderRadius: 4,
  fontSize: 11,
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
