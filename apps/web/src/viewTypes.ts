/**
 * `CenterView` — which view the centre column is showing (Phase 6's view
 * switcher; Phase 7 added "board", Phase 9.5b added "agents"/"prompts").
 * Pulled out of App.tsx into its own file so `shell/viewIcons.tsx` can key
 * its icon lookup off the same type without App.tsx and viewIcons.tsx
 * importing from each other (App.tsx owns the `CenterView` STATE, but
 * viewIcons.tsx only needs the TYPE — this file is the shared dependency
 * both sit below, not a new home for any actual logic).
 */
export type CenterView =
  | "terminals"
  | "editor"
  | "preview"
  | "board"
  | "graph"
  | "swarm"
  | "agents"
  | "prompts"
  | "skills"
  | "settings";
