/**
 * The Prompts library (Phase 9.5b, PARITY #27): CRUD for saved, reusable
 * prompt text — see `@vibedeck/shared`'s `SavedPrompt` doc comment for the
 * GLOBAL (`workspaceId: null`, available in every workspace) vs.
 * workspace-scoped split this view makes visually obvious throughout (list
 * grouping, a pill on every row, and a toggle in the create form), per this
 * phase's spec. Another new centre view (Terminals | Editor | Preview |
 * Board | Graph | Swarm | Agents | Prompts, see App.tsx's `CenterView`),
 * same list+detail shape as Agents.tsx.
 *
 * `GET/POST/PATCH/DELETE /api/prompts` is backed by
 * `apps/server/src/prompts/routes.ts`, whose top comment explains the one
 * asymmetry that matters here: `workspaceId` is required to CREATE a
 * scoped prompt but optional to LIST (an unscoped GET just returns
 * globals) — see `reload` below for how that plays out client-side. A
 * prompt's scope is fixed at creation; PATCH only ever touches
 * `title`/`body` (see `UpdateSavedPromptOptions`), so the edit form has no
 * "move to a different workspace" control — there's nothing on the wire
 * that would accept one.
 *
 * One thing this view deliberately does NOT do: wire "send this prompt
 * straight into the focused pane's prompt bar". `PromptBar.tsx` owns its
 * `<input>` value as fully local component state with no prop to seed it
 * externally, and "which pane is focused" only exists inside
 * App.tsx/Grid.tsx. Reaching from here to there would mean threading a new
 * bumped-request prop through PromptBar -> Terminal.tsx -> PaneView.tsx ->
 * Grid.tsx -> App.tsx (the same shape `editorOpenRequest`/`openNoteRequest`
 * already use for the Editor/Memory tab) while also touching Terminal.tsx's
 * already-intricate agent-status/prompt-queue state machine along the way.
 * That's real cross-cutting plumbing, not a "natural fit" — so this view
 * ships "copy body" (`navigator.clipboard`, same fire-and-forget pattern
 * Terminal.tsx's own copy-on-select already uses) instead, which needs none
 * of that and covers the same "reuse a saved prompt" need with a paste.
 */
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import type { SavedPrompt } from "@vibedeck/shared";
import { Pill } from "../shell/ui.js";
import { groupPromptsByScope } from "./logic.js";

export interface PromptsProps {
  workspaceId: string | null;
  /** See Agents.tsx's identical prop for why this matters: centre views are
   * hidden with CSS `display`, never unmounted, so a plain mount-effect
   * fetch would show whatever was true the first time this view happened to
   * mount forever. */
  visible: boolean;
}

type LoadState = "loading" | "loaded" | "error";

async function parseErrorBody(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Server responded with ${res.status}`;
}

interface FormState {
  title: string;
  body: string;
  /** The create form's "available in every workspace" toggle. Only read on
   * CREATE (see `submit` below) — an existing prompt's scope can't change,
   * so this field is simply absent from edit mode's form state. */
  global: boolean;
}

const EMPTY_FORM: FormState = { title: "", body: "", global: false };

export default function Prompts({ workspaceId, visible }: PromptsProps) {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  // Which row's "copy body" button most recently succeeded — drives a
  // transient "Copied" label. Not persisted, not an error state; just a
  // couple of seconds of feedback so the click doesn't feel like a no-op.
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoadState("loading");
    setLoadError(null);
    // Unlike Board/Graph/Swarm, a missing workspaceId is NOT an empty-state
    // case here — GET /api/prompts with no `workspaceId` still returns every
    // global prompt (see prompts/routes.ts's top comment), which is a
    // perfectly valid thing to show.
    const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
    fetch(`/api/prompts${qs}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await parseErrorBody(res));
        return (await res.json()) as { prompts: SavedPrompt[] };
      })
      .then((body) => {
        setPrompts(body.prompts);
        setLoadState("loaded");
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : "Failed to load prompts");
        setLoadState("error");
      });
  }, [workspaceId]);

  useEffect(() => {
    if (!visible) return;
    reload();
  }, [visible, reload]);

  useEffect(() => {
    setSelectedId(null);
    setCreatingNew(false);
    setFormError(null);
  }, [workspaceId]);

  const selected = prompts.find((p) => p.id === selectedId) ?? null;
  const { global, workspace } = groupPromptsByScope(prompts);

  const startCreate = useCallback(() => {
    setCreatingNew(true);
    setSelectedId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  }, []);

  const startEdit = useCallback((prompt: SavedPrompt) => {
    setSelectedId(prompt.id);
    setCreatingNew(false);
    setForm({ title: prompt.title, body: prompt.body, global: prompt.workspaceId === null });
    setFormError(null);
    setPendingDeleteId(null);
  }, []);

  const cancelForm = useCallback(() => {
    setCreatingNew(false);
    setSelectedId(null);
    setFormError(null);
  }, []);

  const submit = useCallback(() => {
    const title = form.title.trim();
    if (!title) {
      setFormError('"title" must be a non-empty string');
      return;
    }
    if (!form.body.trim()) {
      setFormError('"body" must be a non-empty string');
      return;
    }
    setSaving(true);
    setFormError(null);

    const isEdit = selectedId !== null;
    const url = isEdit ? `/api/prompts/${selectedId}` : "/api/prompts";
    const method = isEdit ? "PATCH" : "POST";
    // Scope only matters on create — see FormState's own comment on `global`.
    const payload = isEdit
      ? { title, body: form.body }
      : { workspaceId: form.global ? null : workspaceId, title, body: form.body };

    fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(await parseErrorBody(res));
        return (await res.json()) as SavedPrompt;
      })
      .then((saved) => {
        setPrompts((prev) => (isEdit ? prev.map((p) => (p.id === saved.id ? saved : p)) : [...prev, saved]));
        setSelectedId(saved.id);
        setCreatingNew(false);
      })
      .catch((err: unknown) => {
        setFormError(err instanceof Error ? err.message : "Failed to save prompt");
      })
      .finally(() => setSaving(false));
  }, [form, selectedId, workspaceId]);

  const confirmDelete = useCallback((id: string) => {
    fetch(`/api/prompts/${id}`, { method: "DELETE" })
      .then((res) => {
        if (!res.ok && res.status !== 204) throw new Error(`Server responded with ${res.status}`);
        setPrompts((prev) => prev.filter((p) => p.id !== id));
        setPendingDeleteId(null);
        setSelectedId((prevSelected) => (prevSelected === id ? null : prevSelected));
      })
      .catch((err: unknown) => {
        setFormError(err instanceof Error ? err.message : "Failed to delete prompt");
      });
  }, []);

  const copyBody = useCallback((prompt: SavedPrompt) => {
    // Fire-and-forget, same pattern Terminal.tsx's own copy-on-select uses —
    // a clipboard write failing (permissions, insecure context) isn't worth
    // a whole error-bar interruption; the "Copied" label just won't appear.
    void navigator.clipboard.writeText(prompt.body).then(() => {
      setCopiedId(prompt.id);
      setTimeout(() => setCopiedId((prev) => (prev === prompt.id ? null : prev)), 1500);
    });
  }, []);

  if (loadState === "loading" && prompts.length === 0) {
    return <div style={emptyStateStyle}>Loading prompts…</div>;
  }
  if (loadState === "error") {
    return <div style={emptyStateStyle}>{loadError ?? "Failed to load prompts."}</div>;
  }

  const showForm = creatingNew || selected !== null;

  return (
    <div style={pageStyle}>
      <div style={listPaneStyle}>
        <div style={listHeaderStyle}>
          <span style={listTitleStyle}>Prompts</span>
          <button type="button" onClick={startCreate} style={addButtonStyle}>
            + New prompt
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 4 }}>
          {prompts.length === 0 && <p style={emptyListStyle}>No saved prompts yet.</p>}

          {global.length > 0 && (
            <>
              <SectionLabel>Global</SectionLabel>
              {global.map((prompt) => (
                <PromptRow
                  key={prompt.id}
                  prompt={prompt}
                  active={selectedId === prompt.id}
                  copied={copiedId === prompt.id}
                  onSelect={() => startEdit(prompt)}
                  onCopy={() => copyBody(prompt)}
                />
              ))}
            </>
          )}

          {workspace.length > 0 && (
            <>
              <SectionLabel>This workspace</SectionLabel>
              {workspace.map((prompt) => (
                <PromptRow
                  key={prompt.id}
                  prompt={prompt}
                  active={selectedId === prompt.id}
                  copied={copiedId === prompt.id}
                  onSelect={() => startEdit(prompt)}
                  onCopy={() => copyBody(prompt)}
                />
              ))}
            </>
          )}
        </div>
      </div>

      <div style={detailPaneStyle}>
        {!showForm && <div style={emptyDetailStyle}>Select a prompt to edit, or create a new one.</div>}

        {showForm && (
          <div style={formStyle}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3 style={formTitleStyle}>{creatingNew ? "New prompt" : "Edit prompt"}</h3>
              {!creatingNew && selected && (
                <button type="button" onClick={() => setPendingDeleteId(selected.id)} style={dangerLinkStyle}>
                  Delete
                </button>
              )}
            </div>

            {selected && pendingDeleteId === selected.id && (
              <div style={confirmBannerStyle}>
                <span>Delete "{selected.title}"? This can't be undone.</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" onClick={() => confirmDelete(selected.id)} style={dangerButtonStyle}>
                    Delete
                  </button>
                  <button type="button" onClick={() => setPendingDeleteId(null)} style={secondaryButtonStyle}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <label style={labelStyle}>
              <span style={labelTextStyle}>Title</span>
              <input
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Write tests for the function above"
                style={inputStyle}
              />
            </label>

            {creatingNew && (
              <label style={{ ...labelStyle, flexDirection: "row", alignItems: "center", gap: 6 }}>
                <input
                  type="checkbox"
                  checked={form.global}
                  onChange={(e) => setForm((f) => ({ ...f, global: e.target.checked }))}
                />
                <span style={{ fontSize: 12, color: "var(--vd-text)" }}>Available in every workspace</span>
              </label>
            )}
            {!creatingNew && selected && (
              <div>
                <Pill status={selected.workspaceId === null ? "info" : "idle"}>
                  {selected.workspaceId === null ? "Global" : "This workspace"}
                </Pill>
              </div>
            )}

            <label style={labelStyle}>
              <span style={labelTextStyle}>Body</span>
              <textarea
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                placeholder="The actual prompt text — this is what gets copied or pasted into an agent."
                rows={14}
                style={textareaStyle}
              />
            </label>

            {formError && <p style={errorStyle}>{formError}</p>}

            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" onClick={submit} disabled={saving} style={primaryButtonStyle}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={cancelForm} style={secondaryButtonStyle}>
                Cancel
              </button>
              {selected && (
                <button type="button" onClick={() => copyBody(selected)} style={secondaryButtonStyle}>
                  {copiedId === selected.id ? "Copied" : "Copy body"}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={sectionLabelStyle}>{children}</div>;
}

/** One row in the prompt list: title, a scope `Pill` (docs/DESIGN.md's
 * `info` tint for global, `idle` for workspace-scoped — the same
 * "meaningful colour, not decoration" rule every other Pill in the app
 * follows), and a "copy body" icon button that stops propagation so
 * clicking it copies without also selecting/opening the row for editing. */
function PromptRow({
  prompt,
  active,
  copied,
  onSelect,
  onCopy,
}: {
  prompt: SavedPrompt;
  active: boolean;
  copied: boolean;
  onSelect: () => void;
  onCopy: () => void;
}) {
  return (
    <div onClick={onSelect} style={{ ...promptRowStyle, background: active ? "var(--vd-surface-raised)" : undefined }}>
      <span style={promptRowTitleStyle}>{prompt.title}</span>
      <button
        type="button"
        title="Copy body"
        onClick={(e) => {
          e.stopPropagation();
          onCopy();
        }}
        style={copyButtonStyle}
      >
        {copied ? "✓" : "⧉"}
      </button>
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
  width: 280,
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

const addButtonStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--vd-accent)",
  fontSize: 11,
  cursor: "pointer",
  padding: 0,
};

const emptyListStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--vd-text-faint)",
  padding: "8px 8px",
  margin: 0,
};

const sectionLabelStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--vd-text-faint)",
  padding: "8px 8px 4px",
};

const promptRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  height: 30,
  padding: "0 8px",
  borderRadius: 4,
  cursor: "pointer",
};

const promptRowTitleStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 12,
  color: "var(--vd-text)",
};

const copyButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  padding: 0,
  flexShrink: 0,
  background: "transparent",
  border: "none",
  borderRadius: 3,
  color: "var(--vd-text-faint)",
  fontSize: 12,
  cursor: "pointer",
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

const formStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  maxWidth: 640,
};

const formTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--vd-text)",
};

const labelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "var(--vd-text-muted)",
};

const labelTextStyle: CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.04em",
  color: "var(--vd-text-muted)",
};

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--vd-bg)",
  color: "var(--vd-text)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 12,
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  fontFamily: "monospace",
  fontSize: 11,
  lineHeight: 1.5,
  resize: "vertical",
};

const errorStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--vd-danger)",
  margin: 0,
};

const primaryButtonStyle: CSSProperties = {
  background: "var(--vd-accent)",
  color: "var(--vd-accent-text)",
  border: "none",
  borderRadius: 4,
  padding: "5px 14px",
  fontSize: 12,
  cursor: "pointer",
};

const secondaryButtonStyle: CSSProperties = {
  background: "transparent",
  color: "var(--vd-text-muted)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "5px 14px",
  fontSize: 12,
  cursor: "pointer",
};

const dangerButtonStyle: CSSProperties = {
  background: "var(--vd-danger)",
  color: "var(--vd-bg)",
  border: "none",
  borderRadius: 4,
  padding: "5px 14px",
  fontSize: 12,
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
