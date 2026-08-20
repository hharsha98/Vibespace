/**
 * The mission's command bar (Phase 9b requirement #5 / PARITY.md #36): one
 * input that can address a single agent or broadcast to the whole mission —
 * `POST /api/swarm/missions/:id/messages` with `toAgentId` set, or omitted
 * for a broadcast (see docs/SWARM.md's Mailbox section).
 *
 * Two ways to pick a target, kept in sync:
 *  1. The dropdown on the left — explicit, discoverable, defaults to "All
 *     agents".
 *  2. Typing `@` in the input — `mentionQueryAt`/`parseMention` (logic.ts,
 *     unit-tested there) drive an inline suggestion list; picking one sets
 *     the dropdown AND strips the typed `@partial` text back out, so the
 *     mention doesn't ALSO end up duplicated in the message body.
 *
 * A message typed with a leading `@Label` is honoured even if the user
 * never opens the suggestion popup (just typed and hit Enter) — `submit()`
 * falls back to `parseMention` when the dropdown is still on "All agents",
 * so keyboard-only use works exactly like clicking a suggestion would.
 */
import { useMemo, useRef, useState } from "react";
import type { MissionAgent } from "@vibedeck/shared";
import { RADIUS, SHADOW_VAR, SPACE } from "../shell/tokens.js";
import { mentionQueryAt, parseMention, roleColorVar, roleGlyph } from "./logic.js";

export interface CommandBarProps {
  agents: MissionAgent[];
  disabled: boolean;
  onSend: (body: string, toAgentId: string | null) => void;
}

export default function CommandBar({ agents, disabled, onSend }: CommandBarProps) {
  const [text, setText] = useState("");
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null); // null = broadcast
  const [cursorIndex, setCursorIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const mentionTargets = useMemo(() => agents.map((a) => ({ id: a.id, label: a.label })), [agents]);

  const mentionQuery = mentionQueryAt(text, cursorIndex);
  const suggestions = useMemo(() => {
    if (mentionQuery === null) return [];
    const query = mentionQuery.toLowerCase();
    return agents.filter((a) => a.label.toLowerCase().startsWith(query));
  }, [mentionQuery, agents]);

  function pickSuggestion(agent: MissionAgent) {
    const upToCursor = text.slice(0, cursorIndex);
    const at = upToCursor.lastIndexOf("@");
    if (at === -1) return;
    const newText = (text.slice(0, at) + text.slice(cursorIndex)).trimStart();
    setTargetAgentId(agent.id);
    setText(newText);
    inputRef.current?.focus();
  }

  function submit() {
    let toAgentId = targetAgentId;
    let body = text.trim();

    // Dropdown still says "All agents" but the text itself leads with a
    // recognised @mention (typed and Enter-pressed without ever opening the
    // suggestion list) — honour it the same way clicking a suggestion would.
    if (toAgentId === null) {
      const parsed = parseMention(text, mentionTargets);
      if (parsed.targetAgentId) {
        toAgentId = parsed.targetAgentId;
        body = parsed.body;
      }
    }

    if (!body) return;
    onSend(body, toAgentId);
    setText("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (suggestions.length > 0 && mentionQuery !== null) {
        pickSuggestion(suggestions[0]);
        return;
      }
      submit();
    }
    // Escape while a mention is in progress: nothing to explicitly clean up
    // — the suggestion popup's visibility is entirely derived from
    // `mentionQuery` (itself derived from `text`/`cursorIndex`), so it
    // disappears the moment the user types past the mention or moves the
    // cursor off it. No separate "dismissed" state to track.
  }

  const targetAgent = agents.find((a) => a.id === targetAgentId) ?? null;

  return (
    <div style={wrapperStyle}>
      {suggestions.length > 0 && mentionQuery !== null && (
        <div style={suggestionListStyle}>
          {suggestions.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => pickSuggestion(agent)}
              className="vd-row-hover"
              style={suggestionRowStyle}
            >
              <span style={{ color: roleColorVar(agent.role) }}>{roleGlyph(agent.role)}</span>
              <span>{agent.label}</span>
              <span style={{ color: "var(--vd-text-faint)", fontSize: 10 }}>{agent.role}</span>
            </button>
          ))}
        </div>
      )}

      <div style={barStyle}>
        <select
          value={targetAgentId ?? "__all__"}
          onChange={(e) => setTargetAgentId(e.target.value === "__all__" ? null : e.target.value)}
          disabled={disabled}
          title="Message target"
          style={targetSelectStyle}
        >
          <option value="__all__">All agents</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.label}
            </option>
          ))}
        </select>

        <input
          ref={inputRef}
          type="text"
          value={text}
          disabled={disabled}
          placeholder="Direct the swarm… (@ to target one agent)"
          onChange={(e) => {
            setText(e.target.value);
            setCursorIndex(e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyUp={(e) => setCursorIndex((e.target as HTMLInputElement).selectionStart ?? text.length)}
          onClick={(e) => setCursorIndex((e.target as HTMLInputElement).selectionStart ?? text.length)}
          onKeyDown={handleKeyDown}
          style={inputStyle}
        />

        <button
          type="button"
          onClick={submit}
          disabled={disabled || !text.trim()}
          className="vd-btn-primary"
          style={sendButtonStyle}
        >
          {targetAgent ? `Send to ${targetAgent.label}` : "Broadcast"}
        </button>
      </div>
    </div>
  );
}

const wrapperStyle: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  bottom: 12,
  transform: "translateX(-50%)",
  width: "min(640px, 90%)",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const barStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: SPACE.sm,
  padding: SPACE.xs + 2,
  background: "var(--vd-surface)",
  border: "1px solid var(--vd-border)",
  borderRadius: RADIUS.lg,
  boxShadow: SHADOW_VAR.md,
};

const targetSelectStyle: React.CSSProperties = {
  background: "var(--vd-bg)",
  color: "var(--vd-text)",
  border: "1px solid var(--vd-border)",
  borderRadius: 4,
  padding: "5px 6px",
  fontSize: 11,
  flexShrink: 0,
  maxWidth: 130,
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "transparent",
  color: "var(--vd-text)",
  border: "none",
  outline: "none",
  fontSize: 12,
  padding: "5px 4px",
};

const sendButtonStyle: React.CSSProperties = {
  flexShrink: 0,
  background: "var(--vd-accent)",
  color: "var(--vd-accent-text)",
  border: "none",
  borderRadius: 4,
  padding: "5px 10px",
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const suggestionListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  background: "var(--vd-surface-raised)",
  border: "1px solid var(--vd-border)",
  borderRadius: RADIUS.md,
  overflow: "hidden",
  boxShadow: SHADOW_VAR.md,
};

const suggestionRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 10px",
  background: "transparent",
  border: "none",
  borderBottom: "1px solid var(--vd-border)",
  color: "var(--vd-text)",
  fontSize: 12,
  cursor: "pointer",
  textAlign: "left",
};
