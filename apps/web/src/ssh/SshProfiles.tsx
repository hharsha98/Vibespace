/**
 * The SSH Profiles page: CRUD (+ one-click Duplicate) for stored connection
 * profiles — see `packages/shared/src/protocol.ts`'s `SshProfile` doc
 * comment for the full design, including the deliberate "no stored
 * credentials, auth is your own ssh-agent/keys" trade-off.
 *
 * Structured like `agents/Agents.tsx` (same list+detail centre-view shape,
 * per the task brief), with two deliberate differences:
 *
 *  - Profiles here are GLOBAL, not workspace-scoped (a host is a machine,
 *    not a project — see `SshProfile`'s doc comment) — so unlike Agents.tsx,
 *    this component takes no `workspaceId` prop and never gates on one
 *    being set.
 *  - This component is CONTROLLED, not self-fetching, unlike Agents.tsx.
 *    Agent profiles are only ever read by this one page, so Agents.tsx
 *    owning its own fetch is the simplest correct thing. SSH profiles are
 *    ALSO read by the empty-pane picker (PaneView.tsx's "Remote (SSH)"
 *    group) — if this page kept its own private copy the way Agents.tsx
 *    does, creating a profile here wouldn't show up in the picker until
 *    some unrelated refetch happened to fire. App.tsx therefore owns the
 *    one shared `sshProfiles` list and passes it down as `profiles`, with
 *    `onProfilesChange` as the single way this page (or anything else) ever
 *    updates it — so the picker and this page can never drift apart.
 */
import { useCallback, useState, type CSSProperties } from "react";
import type { SshProfile } from "@vibedeck/shared";
import { charCountColor, charCountStatus } from "../shell/textLimits.js";
import { Button, EmptyState, ListRow, Pill } from "../shell/ui.js";
import { FONT, RADIUS, SPACE } from "../shell/tokens.js";
import { formatSshDestination, parseSshPortInput } from "./logic.js";

// Mirrors the server's own cap (SSH_PROFILE_STARTUP_COMMAND_MAX_LENGTH in
// packages/shared/src/protocol.ts), duplicated as a plain literal here
// purely for the textarea's maxLength/counter — small enough and stable
// enough that a runtime import for just this one number isn't worth it.
const STARTUP_COMMAND_MAX_LENGTH = 20_000;

export type SshProfilesLoadState = "loading" | "loaded" | "error";

export interface SshProfilesProps {
  /** Whether this is the visible centre view. Unlike Agents.tsx, this no
   * longer drives a fetch effect here (App.tsx owns fetching — see this
   * file's top comment) — kept purely so a future purely-visual "only
   * animate while visible" tweak has the flag available without adding a
   * new prop. */
  visible: boolean;
  /** The shared, app-wide SSH profile list — see this file's top comment
   * for why App.tsx (not this component) owns fetching it. */
  profiles: SshProfile[];
  loadState: SshProfilesLoadState;
  loadError: string | null;
  /** Re-fetches `profiles` from the server. Only needed for the error
   * state's retry affordance — every successful create/update/delete/
   * duplicate below updates `profiles` directly via `onProfilesChange`
   * instead of triggering a full round-trip. */
  onReload: () => void;
  /** The one way this page ever changes the shared profile list — App.tsx
   * passes its own `setSshProfiles` (or an equivalent updater) here. */
  onProfilesChange: (profiles: SshProfile[]) => void;
}

async function parseErrorBody(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Server responded with ${res.status}`;
}

interface FormState {
  name: string;
  host: string;
  user: string;
  port: string;
  defaultDirectory: string;
  startupCommand: string;
}

const EMPTY_FORM: FormState = { name: "", host: "", user: "", port: "", defaultDirectory: "", startupCommand: "" };

function formToPayload(form: FormState): {
  name: string;
  host: string;
  user: string | null;
  port: number | null;
  defaultDirectory: string | null;
  startupCommand: string | null;
} {
  return {
    name: form.name.trim(),
    host: form.host.trim(),
    user: form.user.trim() || null,
    port: parseSshPortInput(form.port) ?? null,
    defaultDirectory: form.defaultDirectory.trim() || null,
    startupCommand: form.startupCommand || null,
  };
}

function profileToForm(profile: SshProfile): FormState {
  return {
    name: profile.name,
    host: profile.host,
    user: profile.user ?? "",
    port: profile.port !== null ? String(profile.port) : "",
    defaultDirectory: profile.defaultDirectory ?? "",
    startupCommand: profile.startupCommand ?? "",
  };
}

export default function SshProfiles({
  profiles,
  loadState,
  loadError,
  onReload,
  onProfilesChange,
}: SshProfilesProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);

  const selected = profiles.find((p) => p.id === selectedId) ?? null;

  const startCreate = useCallback(() => {
    setCreatingNew(true);
    setSelectedId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  }, []);

  const startEdit = useCallback((profile: SshProfile) => {
    setSelectedId(profile.id);
    setCreatingNew(false);
    setForm(profileToForm(profile));
    setFormError(null);
    setPendingDeleteId(null);
  }, []);

  const cancelForm = useCallback(() => {
    setCreatingNew(false);
    setSelectedId(null);
    setFormError(null);
  }, []);

  const submit = useCallback(() => {
    const name = form.name.trim();
    if (!name) {
      setFormError('"name" must be a non-empty string');
      return;
    }
    const host = form.host.trim();
    if (!host) {
      setFormError('"host" must be a non-empty string');
      return;
    }
    const port = parseSshPortInput(form.port);
    if (port === undefined) {
      setFormError('"port" must be a number between 1 and 65535, or left blank');
      return;
    }
    if (form.startupCommand.length > STARTUP_COMMAND_MAX_LENGTH) {
      setFormError(`"startupCommand" must be at most ${STARTUP_COMMAND_MAX_LENGTH.toLocaleString()} characters`);
      return;
    }

    setSaving(true);
    setFormError(null);

    const isEdit = selectedId !== null;
    const url = isEdit ? `/api/ssh-profiles/${selectedId}` : "/api/ssh-profiles";
    const method = isEdit ? "PATCH" : "POST";

    fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formToPayload(form)),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(await parseErrorBody(res));
        return (await res.json()) as SshProfile;
      })
      .then((saved) => {
        onProfilesChange(
          isEdit ? profiles.map((p) => (p.id === saved.id ? saved : p)) : [...profiles, saved]
        );
        setSelectedId(saved.id);
        setCreatingNew(false);
      })
      .catch((err: unknown) => {
        setFormError(err instanceof Error ? err.message : "Failed to save SSH profile");
      })
      .finally(() => setSaving(false));
  }, [form, selectedId, profiles, onProfilesChange]);

  const confirmDelete = useCallback(
    (id: string) => {
      fetch(`/api/ssh-profiles/${id}`, { method: "DELETE" })
        .then((res) => {
          if (!res.ok && res.status !== 204) throw new Error(`Server responded with ${res.status}`);
          onProfilesChange(profiles.filter((p) => p.id !== id));
          setPendingDeleteId(null);
          setSelectedId((prevSelected) => (prevSelected === id ? null : prevSelected));
        })
        .catch((err: unknown) => {
          setFormError(err instanceof Error ? err.message : "Failed to delete SSH profile");
        });
    },
    [profiles, onProfilesChange]
  );

  // One-click Duplicate (BridgeSpace v3.2.1 parity) — the new copy is
  // selected immediately, same "land on what you just created" UX the
  // create form's own success path already follows above.
  const duplicate = useCallback(
    (id: string) => {
      setDuplicatingId(id);
      fetch(`/api/ssh-profiles/${id}/duplicate`, { method: "POST" })
        .then(async (res) => {
          if (!res.ok) throw new Error(await parseErrorBody(res));
          return (await res.json()) as SshProfile;
        })
        .then((copy) => {
          onProfilesChange([...profiles, copy]);
          startEdit(copy);
        })
        .catch((err: unknown) => {
          setFormError(err instanceof Error ? err.message : "Failed to duplicate SSH profile");
        })
        .finally(() => setDuplicatingId(null));
    },
    [startEdit, profiles, onProfilesChange]
  );

  if (loadState === "loading" && profiles.length === 0) {
    return (
      <div style={emptyStateStyle}>
        <EmptyState title="Loading SSH profiles…" />
      </div>
    );
  }
  if (loadState === "error") {
    return (
      <div style={emptyStateStyle}>
        <EmptyState
          title="Couldn't load SSH profiles"
          description={loadError ?? "Failed to load SSH profiles."}
          action={
            <Button variant="secondary" onClick={onReload}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  const commandLength = form.startupCommand.length;
  const commandStatus = charCountStatus(commandLength, STARTUP_COMMAND_MAX_LENGTH);
  const showForm = creatingNew || selected !== null;

  return (
    <div style={pageStyle}>
      <div style={listPaneStyle}>
        <div style={listHeaderStyle}>
          <span style={listTitleStyle}>SSH Profiles</span>
          {profiles.length > 0 && (
            <button type="button" onClick={startCreate} style={addButtonStyle}>
              + New profile
            </button>
          )}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 4 }}>
          {profiles.length === 0 && (
            <div style={emptyListWrapStyle}>
              <EmptyState
                icon={<SshGlyphBadge />}
                title="No SSH profiles yet"
                description="Save a host, optional user/port, and a default directory/startup command as a reusable remote connection you can open a pane on."
                action={
                  <Button variant="primary" onClick={startCreate}>
                    + New profile
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
              title={`${profile.name} — ${formatSshDestination(profile)}`}
              onClick={() => startEdit(profile)}
              trailing={<Pill status="info">{formatSshDestination(profile)}</Pill>}
            />
          ))}
        </div>
      </div>

      <div style={detailPaneStyle}>
        {!showForm && (
          <div style={emptyDetailStyle}>
            <EmptyState
              icon={<SshGlyphBadge />}
              title="Select a profile"
              description="Pick one from the list to edit it, or create a new one."
              action={
                <Button variant="secondary" onClick={startCreate}>
                  + New profile
                </Button>
              }
            />
          </div>
        )}

        {showForm && (
          <div style={formStyle}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3 style={formTitleStyle}>{creatingNew ? "New SSH profile" : "Edit SSH profile"}</h3>
              {!creatingNew && selected && (
                <div style={{ display: "flex", gap: SPACE.sm, alignItems: "center" }}>
                  <button
                    type="button"
                    onClick={() => duplicate(selected.id)}
                    disabled={duplicatingId === selected.id}
                    style={duplicateLinkStyle}
                  >
                    {duplicatingId === selected.id ? "Duplicating…" : "Duplicate"}
                  </button>
                  <button type="button" onClick={() => setPendingDeleteId(selected.id)} style={dangerLinkStyle}>
                    Delete
                  </button>
                </div>
              )}
            </div>

            {/* The auth trade-off, stated in the UI itself, not just in
                code comments — see SshProfile's doc comment in
                packages/shared/src/protocol.ts for the full reasoning. */}
            <p style={authNoteStyle}>
              Authentication uses your own SSH keys/agent (whatever <code>ssh</code> in a normal terminal
              already uses) — vibedeck never stores a password. A host that only accepts password auth will
              prompt for one inside the pane, like any terminal.
            </p>

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
                placeholder="e.g. prod-server"
                style={inputStyle}
              />
            </label>

            <div style={{ display: "flex", gap: SPACE.md }}>
              <label style={{ ...labelStyle, flex: 2 }}>
                <span style={labelTextStyle}>Host</span>
                <input
                  value={form.host}
                  onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
                  placeholder="e.g. prod.example.com"
                  style={inputStyle}
                />
              </label>
              <label style={{ ...labelStyle, flex: 1 }}>
                <span style={labelTextStyle}>User (optional)</span>
                <input
                  value={form.user}
                  onChange={(e) => setForm((f) => ({ ...f, user: e.target.value }))}
                  placeholder="ssh's default"
                  style={inputStyle}
                />
              </label>
              <label style={{ ...labelStyle, flex: 1 }}>
                <span style={labelTextStyle}>Port (optional)</span>
                <input
                  value={form.port}
                  onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
                  placeholder="22"
                  inputMode="numeric"
                  style={inputStyle}
                />
              </label>
            </div>

            <label style={labelStyle}>
              <span style={labelTextStyle}>Default directory (optional)</span>
              <input
                value={form.defaultDirectory}
                onChange={(e) => setForm((f) => ({ ...f, defaultDirectory: e.target.value }))}
                placeholder="e.g. /srv/app — cd's here right after connecting"
                style={inputStyle}
              />
            </label>

            <label style={labelStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={labelTextStyle}>Startup command (optional)</span>
                <span style={{ fontSize: 11, color: charCountColor(commandStatus) }}>
                  {commandLength.toLocaleString()} / {STARTUP_COMMAND_MAX_LENGTH.toLocaleString()}
                </span>
              </div>
              <textarea
                value={form.startupCommand}
                onChange={(e) => setForm((f) => ({ ...f, startupCommand: e.target.value }))}
                maxLength={STARTUP_COMMAND_MAX_LENGTH}
                placeholder="e.g. source .venv/bin/activate — runs after connecting (and after cd'ing, if a directory is set above)"
                rows={4}
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

/** The SSH Profiles page's own tinted-circle icon badge — a small "remote
 * machine" glyph, matching the style AgentGlyphBadge (agents/Agents.tsx)
 * already establishes: two concentric shapes standing in for "a machine,
 * plus a connection to it". Reused between the list-empty and detail-empty
 * states, same as every other page's empty-state icon in this codebase. */
function SshGlyphBadge() {
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
        <rect x="2.5" y="5" width="12.5" height="9.5" rx="1.8" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5 8.2L7.6 10L5 11.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M9 11.8H12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M14.5 3.5C16 4.3 17 5.9 17 7.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" opacity="0.7" />
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

const authNoteStyle: CSSProperties = {
  margin: 0,
  padding: SPACE.sm,
  fontSize: FONT.meta,
  lineHeight: 1.5,
  color: "var(--vd-text-muted)",
  background: "var(--vd-surface-raised)",
  border: "1px solid var(--vd-border)",
  borderRadius: RADIUS.sm,
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

const duplicateLinkStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--vd-accent)",
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
