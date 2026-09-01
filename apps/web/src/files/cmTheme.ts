/**
 * Builds a CodeMirror 6 theme from vibespace's own `Theme` tokens — the
 * editor's equivalent of `Terminal.tsx` assigning `theme.terminal` straight
 * to xterm. Two pieces come back, bundled into one `Extension[]`:
 *
 *  - an `EditorView.theme()` covering the editor's OWN chrome (background,
 *    cursor, selection, gutters, active line) from `theme.ui` — the same
 *    `--vd-*` tokens the rest of the shell uses.
 *  - a `syntaxHighlighting(HighlightStyle)` covering token colours, drawn
 *    from `theme.terminal`'s ANSI palette rather than inventing a THIRD
 *    colour scheme — a theme's green/blue/magenta already means something
 *    (it's what `ls --color`/git diffs render in the terminal right next
 *    to this editor), so syntax highlighting reuses those same hues rather
 *    than clashing with them.
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { Theme } from "../themes/themes.js";

export function buildCodeMirrorTheme(theme: Theme): Extension {
  const { ui, terminal, isDark } = theme;

  const chrome = EditorView.theme(
    {
      "&": {
        color: ui.text,
        backgroundColor: ui.background,
        height: "100%",
        fontSize: "13px",
      },
      ".cm-content": {
        fontFamily: "'SF Mono', Menlo, Monaco, 'Cascadia Code', 'Fira Code', monospace",
        caretColor: terminal.cursor,
      },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: terminal.cursor },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: terminal.selectionBackground,
      },
      ".cm-activeLine": {
        backgroundColor: `color-mix(in srgb, ${ui.surfaceRaised} 60%, transparent)`,
      },
      ".cm-gutters": {
        backgroundColor: ui.surface,
        color: ui.textFaint,
        border: "none",
      },
      ".cm-activeLineGutter": { backgroundColor: ui.surfaceRaised, color: ui.text },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 4px" },
      "&.cm-editor.cm-focused": { outline: "none" },
      ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.4" },
      ".cm-searchMatch": {
        backgroundColor: `color-mix(in srgb, ${terminal.yellow} 30%, transparent)`,
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: `color-mix(in srgb, ${terminal.yellow} 55%, transparent)`,
      },
      ".cm-tooltip": {
        backgroundColor: ui.surfaceRaised,
        border: `1px solid ${ui.border}`,
        color: ui.text,
      },
    },
    { dark: isDark }
  );

  // Token colours, drawn from this theme's own ANSI palette so they read as
  // native to it rather than a foreign accent — same reasoning as
  // themes.ts's `deriveUi` deriving status colours from `terminal.green`
  // etc instead of inventing separate ones.
  const highlightStyle = HighlightStyle.define([
    { tag: t.comment, color: ui.textFaint, fontStyle: "italic" },
    { tag: t.lineComment, color: ui.textFaint, fontStyle: "italic" },
    { tag: t.blockComment, color: ui.textFaint, fontStyle: "italic" },
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: terminal.magenta },
    { tag: [t.string, t.special(t.string), t.regexp], color: terminal.green },
    { tag: [t.number, t.bool, t.null, t.atom], color: terminal.cyan },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: terminal.blue },
    { tag: t.definition(t.variableName), color: ui.text },
    { tag: t.variableName, color: ui.text },
    { tag: t.propertyName, color: terminal.blue },
    { tag: [t.typeName, t.className, t.namespace], color: terminal.yellow },
    { tag: t.operator, color: terminal.red },
    { tag: [t.punctuation, t.bracket], color: ui.textMuted },
    { tag: [t.tagName], color: terminal.red },
    { tag: [t.attributeName], color: terminal.yellow },
    { tag: t.meta, color: ui.textFaint },
    { tag: t.heading, color: terminal.blue, fontWeight: "bold" },
    { tag: t.link, color: terminal.cyan, textDecoration: "underline" },
    { tag: t.invalid, color: ui.danger, textDecoration: "underline" },
  ]);

  return [chrome, syntaxHighlighting(highlightStyle)];
}
