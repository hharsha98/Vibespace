import { useEffect } from "react";
import { WORKSPACE_COLORS } from "@vibespace/shared";
import { SHADOW_VAR } from "./tokens.js";

/**
 * The workspace colour swatch grid, as a popover.
 *
 * Lifted out of `WorkspaceRail.tsx` unchanged so the workspace TAB strip
 * can use it too. That move is the whole reason this file exists: colour
 * was reachable only from the rail's workspace list, so removing that list
 * (workspaces live in top-bar tabs now, matching BridgeSpace's layout)
 * would have left tabs displaying a colour that nothing could change — a
 * feature deleted by accident while tidying up.
 *
 * Positioned `absolute` against whatever the caller anchors it to, so the
 * caller owns placement and this owns the swatches.
 */
export default function ColorPickerPopover({
  current,
  onPick,
  onClose,
}: {
  current: string | null;
  onPick: (color: string | null) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onClickAway = () => onClose();
    // Deferred to the next tick: the swatch dot's own onClick (which opens
    // this popover) also bubbles to `document` in the SAME click event —
    // without a delay, this listener would fire immediately and close the
    // popover the instant it opens.
    const timer = setTimeout(() => document.addEventListener("click", onClickAway), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", onClickAway);
    };
  }, [onClose]);

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="vd-scale-in"
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        marginTop: 4,
        zIndex: 30,
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 4,
        padding: 6,
        background: "var(--vd-surface-raised)",
        border: "1px solid var(--vd-border)",
        borderRadius: 6,
        boxShadow: SHADOW_VAR.lg,
      }}
    >
      <button
        type="button"
        onClick={() => onPick(null)}
        title="No colour"
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          cursor: "pointer",
          background: "transparent",
          border: current === null ? "2px solid var(--vd-accent)" : "1px dashed var(--vd-text-faint)",
          padding: 0,
        }}
      />
      {WORKSPACE_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onPick(color)}
          title={color}
          style={{
            width: 18,
            height: 18,
            borderRadius: "50%",
            cursor: "pointer",
            background: color,
            border: current === color ? "2px solid var(--vd-text)" : "1px solid var(--vd-border)",
            padding: 0,
          }}
        />
      ))}
      <button
        type="button"
        onClick={onClose}
        title="Close"
        style={{
          gridColumn: "1 / -1",
          background: "transparent",
          border: "none",
          color: "var(--vd-text-faint)",
          fontSize: 10,
          cursor: "pointer",
          padding: "2px 0 0",
        }}
      >
        Close
      </button>
    </div>
  );
}
