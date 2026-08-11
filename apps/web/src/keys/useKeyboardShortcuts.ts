import { useEffect, useRef } from "react";
import { isMacPlatform, matchShortcut } from "./keymap.js";

/** One handler per action id from `KEYMAP` (see `keymap.ts`). Not every id
 * needs an entry — an unhandled shortcut is simply ignored (and NOT
 * preventDefault'd, so e.g. a browser-level combo we don't otherwise touch
 * still works normally). */
export type ShortcutHandlers = Partial<Record<string, (event: KeyboardEvent) => void>>;

/**
 * Installs a single `keydown` listener on `window`, in the CAPTURE phase,
 * that maps every keystroke through `matchShortcut` and calls the matching
 * handler from `handlers`.
 *
 * Two things this hook exists specifically to get right:
 *
 * 1. **Capture phase, not bubble.** A capture-phase listener on `window`
 *    runs before the event reaches ANY other element's own listener,
 *    including xterm.js's hidden textarea inside a focused terminal. That's
 *    what lets `event.preventDefault()` here stop the keystroke from ever
 *    being typed into the terminal — see the top-level comment in
 *    `Terminal.tsx` for the second half of that story
 *    (`attachCustomKeyEventHandler`, xterm's own belt-and-suspenders check).
 *
 * 2. **Don't hijack real typing.** None of our shortcuts use a bare,
 *    unmodified key, so normal typing is never at risk on its own — but a
 *    modified combo (Cmd/Ctrl+something) firing a page-level action while
 *    the user is mid-edit in one of the app's own text fields (workspace
 *    name, the create-workspace path field, the rename input...) would
 *    still be surprising. So while a text `<input>`/`<textarea>` has
 *    focus, every shortcut is suppressed EXCEPT the command palette
 *    (Cmd/Ctrl+K), which should always be reachable no matter what's
 *    focused. Escape needs no special case here: it isn't in `KEYMAP` at
 *    all (nothing maps a bare Escape to an action id), so it always falls
 *    straight through to whatever component-local Escape handler is
 *    listening (the command palette's own, the terminal search box's own).
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers, enabled = true): void {
  // Keep the latest handlers/enabled in a ref so the listener (attached
  // once, on mount) always calls the current version without needing to be
  // torn down and re-attached on every render — React effects that depend
  // on a fresh object literal (like `handlers` usually is, if defined
  // inline in a component) would otherwise remove+re-add the window
  // listener on every single render.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const isMac = isMacPlatform();

    const onKeyDown = (event: KeyboardEvent) => {
      if (!enabledRef.current) return;

      const actionId = matchShortcut(event, isMac);
      if (!actionId) return; // Not one of ours — let it through untouched.

      const target = event.target as HTMLElement | null;
      // xterm.js renders a hidden <textarea> to capture keyboard input into
      // the terminal. It has tagName "TEXTAREA" just like a real text
      // field, but a terminal being focused is the MOST common state in
      // this app — shortcuts must still fire there (that's the whole
      // "keyboard-first" point), so it's explicitly exempted from the
      // "don't hijack typing" guard below.
      const isXtermHelper = target?.classList.contains("xterm-helper-textarea") ?? false;
      const isTextField =
        !isXtermHelper &&
        !!target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if (isTextField && actionId !== "command-palette") {
        return; // Let the app's own text field keep the keystroke.
      }

      const handler = handlersRef.current[actionId];
      if (!handler) return; // Recognised shortcut, but nothing wired up for it right now.

      event.preventDefault();
      handler(event);
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);
}
