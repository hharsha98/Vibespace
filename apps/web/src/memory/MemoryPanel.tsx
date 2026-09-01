/**
 * The Memory tab's contents (Phase 8) — a searchable note list, a note
 * reader with clickable `[[wikilinks]]` and a backlinks section, and
 * inline create/edit (never a separate route or modal — matches
 * Column.tsx's "+ Add task" inline-form convention, and DESIGN.md's ban on
 * native dialogs). Mounted inside RightDock.tsx's "Memory" tab, following
 * the same "this component fetches and owns its own data given just a
 * workspaceId" pattern Board.tsx documents at its own top.
 *
 * `openNoteRequest` is how the Graph view (Graph.tsx) tells this panel
 * "show this note" — same bumped-requestId pattern as App.tsx's
 * `editorOpenRequest` for the Editor. RightDock.tsx is what actually
 * switches ITS OWN tab to "memory" when this fires; this component only
 * needs to react to the slug.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { MemoryGraphEdge, MemoryNote, MemoryNoteWithBacklinks } from "@vibespace/shared";
import { EmptyState, Pill, StatusDot } from "../shell/ui.js";
import { SPACE } from "../shell/tokens.js";
import { tokenizeBody } from "./wikitext.js";

export interface OpenNoteRequest {
  slug: string;
  requestId: number;
}

export interface MemoryPanelProps {
  workspaceId: string | null;
  openNoteRequest: OpenNoteRequest | null;
}

type ListLoadState = "loading" | "loaded" | "error";
type DetailLoadState = "idle" | "loading" | "loaded" | "error";

/** Splits a comma-separated tags input field into a trimmed, non-empty
 * string array — the inverse of joining `tags` with ", " for display. */
function parseTagsInput(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export default function MemoryPanel({ workspaceId, openNoteRequest }: MemoryPanelProps) {
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [edges, setEdges] = useState<MemoryGraphEdge[]>([]);
  const [listLoadState, setListLoadState] = useState<ListLoadState>("loading");
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [selectedNote, setSelectedNote] = useState<MemoryNoteWithBacklinks | null>(null);
  const [detailLoadState, setDetailLoadState] = useState<DetailLoadState>("idle");

  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editTagsInput, setEditTagsInput] = useState("");

  const [addingNew, setAddingNew] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [pendingDeleteSlug, setPendingDeleteSlug] = useState<string | null>(null);

  // --- Load the note list + graph (for backlink counts) whenever the
  // active workspace changes -------------------------------------------
  const reload = useCallback(() => {
    if (!workspaceId) {
      setNotes([]);
      setEdges([]);
      setListLoadState("loaded");
      return;
    }
    setListLoadState("loading");
    setListError(null);
    const qs = `workspaceId=${encodeURIComponent(workspaceId)}`;
    // `res.ok` matters more here than it looks. Without it a 500 still
    // parses: the server's `{error: "..."}` body deserialises fine, so
    // `notesBody.notes` came out `undefined`, `setListLoadState("loaded")`
    // ran, and the panel reported an empty memory rather than a failure —
    // telling someone their notes are gone when the server merely errored.
    // It did not even stay that quiet: `notes.map(...)` further down throws
    // on `undefined`, blanking the panel. The note-detail fetch in this
    // same file already does this properly; these two were the
    // inconsistency, not the convention.
    const loadJson = async <T,>(url: string): Promise<T> => {
      const res = await fetch(url);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Server responded with ${res.status}`);
      }
      return (await res.json()) as T;
    };

    Promise.all([
      loadJson<{ notes: MemoryNote[] }>(`/api/memory/notes?${qs}`),
      loadJson<{ edges: MemoryGraphEdge[] }>(`/api/memory/graph?${qs}`),
    ])
      .then(([notesBody, graphBody]) => {
        setNotes(notesBody.notes);
        setEdges(graphBody.edges);
        setListLoadState("loaded");
      })
      .catch((err: unknown) => {
        setListError(err instanceof Error ? err.message : "Failed to load memory notes");
        setListLoadState("error");
      });
  }, [workspaceId]);

  useEffect(() => {
    reload();
    setSelectedSlug(null);
    setSelectedNote(null);
    setEditing(false);
  }, [reload]);

  // --- Open a specific note (list click, backlink click, wikilink click,
  // or an external request from the Graph view) --------------------------
  const openNote = useCallback(
    (slug: string) => {
      if (!workspaceId) return;
      setActionError(null);
      setEditing(false);
      setSelectedSlug(slug);
      setDetailLoadState("loading");
      fetch(`/api/memory/notes/${encodeURIComponent(slug)}?workspaceId=${encodeURIComponent(workspaceId)}`)
        .then(async (res) => {
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(body.error ?? `Server responded with ${res.status}`);
          }
          return (await res.json()) as MemoryNoteWithBacklinks;
        })
        .then((note) => {
          setSelectedNote(note);
          setDetailLoadState("loaded");
        })
        .catch((err: unknown) => {
          setActionError(err instanceof Error ? err.message : "Failed to load note");
          setDetailLoadState("error");
        });
    },
    [workspaceId]
  );

  // React to the Graph view (or anything else) asking us to show a note.
  // Deliberately keyed on `openNoteRequest?.requestId` alone, not the whole
  // `openNoteRequest` object or `openNote` itself — same bumped-counter
  // pattern App.tsx's `editorOpenRequest` effect uses for Editor.tsx, so
  // re-requesting the SAME slug (e.g. re-clicking a graph node twice) still
  // re-fires because the id changed, not because the slug did.
  useEffect(() => {
    if (!openNoteRequest) return;
    openNote(openNoteRequest.slug);
    // openNote intentionally omitted: it's stable in practice (only closes
    // over workspaceId) and including it would re-run this effect on every
    // workspace switch even when no new open request came in.
  }, [openNoteRequest?.requestId]);

  const backToList = useCallback(() => {
    setSelectedSlug(null);
    setSelectedNote(null);
    setEditing(false);
    setPendingDeleteSlug(null);
  }, []);

  // --- Create ---------------------------------------------------------
  const createNote = useCallback(
    (title: string, body?: string) => {
      if (!workspaceId) return;
      const trimmed = title.trim();
      if (!trimmed) return;
      setActionError(null);
      fetch("/api/memory/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, title: trimmed, body: body ?? "" }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const errBody = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(errBody.error ?? `Server responded with ${res.status}`);
          }
          return (await res.json()) as MemoryNote;
        })
        .then((created) => {
          reload();
          openNote(created.slug);
          setEditing(true);
          setEditTitle(created.title);
          setEditBody(created.body);
          setEditTagsInput("");
        })
        .catch((err: unknown) => {
          setActionError(err instanceof Error ? err.message : "Failed to create note");
        });
    },
    [workspaceId, reload, openNote]
  );

  const submitNewNote = () => {
    const trimmed = newTitle.trim();
    setAddingNew(false);
    setNewTitle("");
    if (trimmed) createNote(trimmed);
  };

  // A click on a dangling `[[link]]` in the reader: create the note
  // immediately (title = the link target, since that's the only text a
  // dangling link gives us) and drop straight into edit mode so the user
  // can fill in the body vibespace couldn't guess.
  const createFromDangling = useCallback((target: string) => createNote(target), [createNote]);

  // --- Edit -------------------------------------------------------------
  const startEditing = () => {
    if (!selectedNote) return;
    setEditTitle(selectedNote.title);
    setEditBody(selectedNote.body);
    setEditTagsInput(selectedNote.tags.join(", "));
    setEditing(true);
  };

  const saveEdit = useCallback(() => {
    if (!workspaceId || !selectedSlug) return;
    const trimmedTitle = editTitle.trim();
    if (!trimmedTitle) {
      setActionError('"title" must be a non-empty string');
      return;
    }
    setActionError(null);
    fetch(`/api/memory/notes/${encodeURIComponent(selectedSlug)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        title: trimmedTitle,
        body: editBody,
        tags: parseTagsInput(editTagsInput),
      }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Server responded with ${res.status}`);
        }
        return (await res.json()) as MemoryNote;
      })
      .then((updated) => {
        setSelectedNote((prev) => (prev ? { ...prev, ...updated } : prev));
        setEditing(false);
        reload();
      })
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : "Failed to save note");
      });
  }, [workspaceId, selectedSlug, editTitle, editBody, editTagsInput, reload]);

  // --- Delete -------------------------------------------------------------
  const confirmDelete = useCallback(
    (slug: string) => {
      if (!workspaceId) return;
      setActionError(null);
      fetch(`/api/memory/notes/${encodeURIComponent(slug)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "DELETE",
      })
        .then((res) => {
          if (!res.ok && res.status !== 204) throw new Error(`Server responded with ${res.status}`);
          setPendingDeleteSlug(null);
          backToList();
          reload();
        })
        .catch((err: unknown) => {
          setActionError(err instanceof Error ? err.message : "Failed to delete note");
        });
    },
    [workspaceId, backToList, reload]
  );

  // --- Derived data -------------------------------------------------------
  const notesBySlug = useMemo(() => new Map(notes.map((n) => [n.slug, n])), [notes]);

  const backlinkCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of edges) counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
    return counts;
  }, [edges]);

  const filteredNotes = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter(
      (n) => n.title.toLowerCase().includes(q) || n.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  }, [notes, search]);

  if (!workspaceId) {
    return (
      <div style={panelEmptyStyle}>
        <EmptyState title="No active workspace" description="Open a workspace to browse its notes." />
      </div>
    );
  }

  // --- Note detail view (reader or inline edit) ----------------------------
  if (selectedSlug) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button type="button" onClick={backToList} style={backButtonStyle}>
          ‹ All notes
        </button>

        {actionError && <p style={errorStyle}>{actionError}</p>}

        {detailLoadState === "loading" && <EmptyNote>Loading…</EmptyNote>}
        {detailLoadState === "error" && <EmptyNote>Failed to load this note.</EmptyNote>}

        {selectedNote && detailLoadState === "loaded" && !editing && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
              <h3 style={titleStyle}>{selectedNote.title}</h3>
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                <button type="button" title="Edit" onClick={startEditing} style={miniButtonStyle}>
                  ✎
                </button>
                <button
                  type="button"
                  title="Delete"
                  onClick={() => setPendingDeleteSlug(selectedNote.slug)}
                  style={miniButtonStyle}
                >
                  ✕
                </button>
              </div>
            </div>

            {selectedNote.tags.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {selectedNote.tags.map((tag) => (
                  <Pill key={tag} status="info">
                    {tag}
                  </Pill>
                ))}
              </div>
            )}

            {pendingDeleteSlug === selectedNote.slug && (
              <div style={confirmBannerStyle}>
                <span>Delete this note? This removes the .md file.</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" onClick={() => confirmDelete(selectedNote.slug)} style={dangerButtonStyle}>
                    Delete
                  </button>
                  <button type="button" onClick={() => setPendingDeleteSlug(null)} style={secondaryButtonStyle}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <div style={bodyStyle}>
              {selectedNote.body.trim().length === 0 ? (
                <span style={{ color: "var(--vd-text-faint)" }}>Empty note. Click ✎ to add content.</span>
              ) : (
                <NoteBody body={selectedNote.body} notesBySlug={notesBySlug} onOpen={openNote} onCreate={createFromDangling} />
              )}
            </div>

            <div>
              <SectionLabel>Backlinks ({selectedNote.backlinks.length})</SectionLabel>
              {selectedNote.backlinks.length === 0 ? (
                <p style={{ fontSize: 11, color: "var(--vd-text-faint)", margin: "4px 0 0" }}>
                  No other notes link here yet.
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
                  {selectedNote.backlinks.map((slug) => {
                    const note = notesBySlug.get(slug);
                    return (
                      <button
                        key={slug}
                        type="button"
                        onClick={() => openNote(slug)}
                        className="vd-row-hover"
                        style={backlinkRowStyle}
                      >
                        <StatusDot status="info" />
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {note?.title ?? slug}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {editing && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <input
              autoFocus
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="Title"
              style={inputStyle}
            />
            <input
              value={editTagsInput}
              onChange={(e) => setEditTagsInput(e.target.value)}
              placeholder="Tags, comma separated"
              style={inputStyle}
            />
            <textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              placeholder="Body — use [[other-slug]] to link another note"
              rows={10}
              style={textareaStyle}
            />
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" onClick={saveEdit} style={primaryButtonStyle}>
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  // A brand-new empty note that's cancelled out of immediately
                  // stays as an empty note in the list — same "no undo needed"
                  // reasoning as Board.tsx's optimistic delete: nothing
                  // destructive happened, there's just an empty note sitting
                  // there, same as if the user had saved it empty on purpose.
                }}
                style={secondaryButtonStyle}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // --- List view ------------------------------------------------------------
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search notes and tags…"
        style={inputStyle}
      />

      {actionError && <p style={errorStyle}>{actionError}</p>}

      {listLoadState === "loading" && <EmptyNote>Loading notes…</EmptyNote>}
      {listLoadState === "error" && <EmptyNote>{listError ?? "Failed to load memory notes."}</EmptyNote>}

      {listLoadState === "loaded" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {filteredNotes.length === 0 && notes.length > 0 && (
            <div style={listEmptyStyle}>
              <EmptyState title="No matches" description={`Nothing matches "${search}".`} />
            </div>
          )}
          {notes.length === 0 && (
            <div style={listEmptyStyle}>
              <EmptyState
                title="No notes yet"
                description="Write one below — use [[wikilinks]] to connect it to other notes in the graph."
              />
            </div>
          )}
          {filteredNotes.map((note) => (
            <button
              key={note.slug}
              type="button"
              onClick={() => openNote(note.slug)}
              className="vd-row-hover"
              style={noteRowStyle}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 12,
                  color: "var(--vd-text)",
                }}
              >
                {note.title}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                {note.tags.slice(0, 2).map((tag) => (
                  <Pill key={tag} status="idle">
                    {tag}
                  </Pill>
                ))}
                {(backlinkCounts.get(note.slug) ?? 0) > 0 && (
                  <span style={{ fontSize: 10, color: "var(--vd-text-faint)" }}>
                    {backlinkCounts.get(note.slug)}↩
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--vd-border)", paddingTop: 8 }}>
        {addingNew ? (
          <input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitNewNote();
              if (e.key === "Escape") {
                setAddingNew(false);
                setNewTitle("");
              }
            }}
            onBlur={submitNewNote}
            placeholder="Note title"
            style={inputStyle}
          />
        ) : (
          <button type="button" onClick={() => setAddingNew(true)} style={addButtonStyle}>
            + New note
          </button>
        )}
      </div>
    </div>
  );
}

/** Renders a note body via `tokenizeBody`: plain text, `<code>` for code
 * tokens, and a clickable button per `[[link]]` — styled as a real link
 * (navigates via `onOpen`) or, if `notesBySlug` has no entry for it, a
 * dangling one (faint text + a "create this note" affordance via
 * `onCreate`), per docs/DESIGN.md and this phase's own spec. */
function NoteBody({
  body,
  notesBySlug,
  onOpen,
  onCreate,
}: {
  body: string;
  notesBySlug: Map<string, MemoryNote>;
  onOpen: (slug: string) => void;
  onCreate: (target: string) => void;
}) {
  const tokens = useMemo(() => tokenizeBody(body), [body]);
  return (
    <>
      {tokens.map((token, i) => {
        if (token.kind === "text") {
          return <span key={i}>{token.value}</span>;
        }
        if (token.kind === "code") {
          return (
            <code key={i} style={codeSpanStyle}>
              {token.value}
            </code>
          );
        }
        const exists = notesBySlug.has(token.value);
        return exists ? (
          <button key={i} type="button" onClick={() => onOpen(token.value)} style={linkStyle}>
            [[{token.value}]]
          </button>
        ) : (
          <span key={i} style={danglingLinkStyle}>
            [[{token.value}]]
            <button type="button" onClick={() => onCreate(token.value)} title="Create this note" style={danglingCreateStyle}>
              +
            </button>
          </span>
        );
      })}
    </>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 12, color: "var(--vd-text-faint)", margin: 0, lineHeight: 1.5 }}>{children}</p>;
}

/** Wraps the panel-level EmptyState (no workspace) — this dock tab has no
 * fixed height of its own to centre within (RightDock.tsx just stacks
 * content), so this only adds breathing room above/below rather than
 * vertically centring like a full-height view's empty state would. */
const panelEmptyStyle: CSSProperties = {
  padding: `${SPACE.lg}px ${SPACE.xs}px`,
};

/** Wraps the note list's own "nothing to show" EmptyStates (no notes yet /
 * no search matches) — same idea, scaled to this 320px dock column rather
 * than a full centre view. */
const listEmptyStyle: CSSProperties = {
  padding: `${SPACE.md}px ${SPACE.xs}px`,
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--vd-text-faint)" }}>
      {children}
    </div>
  );
}

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--vd-bg)",
  color: "var(--vd-text)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "5px 8px",
  fontSize: 12,
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  fontFamily: "monospace",
  fontSize: 11,
  lineHeight: 1.5,
  resize: "vertical",
};

const noteRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 30,
  padding: "0 8px",
  boxSizing: "border-box",
  borderRadius: 4,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
  width: "100%",
};

const backlinkRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  height: 24,
  padding: "0 4px",
  background: "transparent",
  border: "none",
  color: "var(--vd-text)",
  fontSize: 11,
  cursor: "pointer",
  textAlign: "left",
  width: "100%",
};

const addButtonStyle: CSSProperties = {
  width: "100%",
  textAlign: "left",
  background: "transparent",
  border: "none",
  color: "var(--vd-text-faint)",
  fontSize: 12,
  padding: "4px 2px",
  cursor: "pointer",
};

const backButtonStyle: CSSProperties = {
  alignSelf: "flex-start",
  background: "transparent",
  border: "none",
  color: "var(--vd-text-muted)",
  fontSize: 11,
  padding: 0,
  cursor: "pointer",
};

const titleStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--vd-text)",
  lineHeight: 1.4,
};

const miniButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  padding: 0,
  background: "transparent",
  border: "none",
  borderRadius: 3,
  color: "var(--vd-text-faint)",
  fontSize: 11,
  cursor: "pointer",
};

const bodyStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.6,
  color: "var(--vd-text)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const codeSpanStyle: CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  background: "var(--vd-surface-raised)",
  border: "1px solid var(--vd-border)",
  borderRadius: 3,
  padding: "0 3px",
};

const linkStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  color: "var(--vd-info)",
  fontSize: 12,
  cursor: "pointer",
  textDecoration: "underline",
  textUnderlineOffset: 2,
};

// Dangling links render in --text-faint per docs/DESIGN.md's status
// vocabulary (idle/unwritten), with a small inline "+" that offers to
// create the missing note right there instead of forcing a trip to the
// list's own "+ New note" form.
const danglingLinkStyle: CSSProperties = {
  color: "var(--vd-text-faint)",
  display: "inline-flex",
  alignItems: "center",
  gap: 2,
};

const danglingCreateStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 14,
  height: 14,
  padding: 0,
  background: "color-mix(in srgb, var(--vd-idle) 20%, transparent)",
  border: "1px solid var(--vd-border)",
  borderRadius: 3,
  color: "var(--vd-text-muted)",
  fontSize: 10,
  lineHeight: 1,
  cursor: "pointer",
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
  padding: "4px 12px",
  fontSize: 12,
  cursor: "pointer",
};

const secondaryButtonStyle: CSSProperties = {
  background: "transparent",
  color: "var(--vd-text-muted)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "4px 12px",
  fontSize: 12,
  cursor: "pointer",
};

const dangerButtonStyle: CSSProperties = {
  background: "var(--vd-danger)",
  color: "var(--vd-bg)",
  border: "none",
  borderRadius: 4,
  padding: "4px 12px",
  fontSize: 12,
  cursor: "pointer",
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
