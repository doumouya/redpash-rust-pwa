// Cases page label vocabulary — slice 6 of the god-object
// decomposition (Em 2026-05-27 — broadcast.md 00:53). Same pattern
// as slices 4 + 5 (pure data, module-private, structural extract).
//
// Seven exports cover the case-state vocabulary the kanban + detail
// panel + activity feed all reference:
//
//   STATUS_ORDER — the five-state lifecycle order (backlog → todo →
//     in_progress → in_review → done). Drives the kanban column
//     order + the click-cycle status advance.
//
//   STATUS_LABEL — pretty labels for each status enum value. Used
//     in chips + activity feed renders.
//
//   PRIORITY_LABEL — four-level priority labels (low/medium/high/
//     critical).
//
//   TYPE_LABEL — four case-type labels (task/bug/feature/epic).
//
//   RAIL_MARK_COLOR — status → color-token mapping for the rail's
//     `.rt-group-mark`. Same mapping the column accent stripe uses
//     (cases.css) so rail mark + column stripe + status chip read
//     as one palette.
//
//   DONE_WINDOW_MS / DONE_WINDOW_LABEL / DONE_WINDOW_ORDER — the
//     time-window filter caps the Done column / rail group to
//     recently-closed cases. Default "day" (today's closed),
//     persisted via the `casesDoneWindow` registered pref (prefs.js).
//
//     Edge note carried from the inline original: we use
//     `updated_at` as the proxy for "closed at" — accurate for the
//     common case (Done cases rarely get edits), wrong if a Done
//     case gets its description edited months after closing. The
//     honest fix is a `closed_at` column on `cases` or a derived
//     value from `events`; queued on Gus's lane.
//
// Module-private to cases.js today; promote if the kanban surface
// is composed elsewhere (e.g. a future Workspace cases-tab).

export const STATUS_ORDER = ["backlog", "todo", "in_progress", "in_review", "done"];

export const STATUS_LABEL = {
  backlog:     "Backlog",
  todo:        "Todo",
  in_progress: "In progress",
  in_review:   "In review",
  done:        "Done",
};

export const PRIORITY_LABEL = {
  low: "Low", medium: "Medium", high: "High", critical: "Critical",
};

export const TYPE_LABEL = {
  task: "Task", bug: "Bug", feature: "Feature", epic: "Epic",
};

export const RAIL_MARK_COLOR = {
  backlog:     "mute",
  todo:        "blue",
  in_progress: "mauve",
  in_review:   "peach",
  done:        "green",
};

export const DONE_WINDOW_MS = {
  day:   86_400_000,         // 24h
  week:  604_800_000,        // 7d
  month: 2_592_000_000,      // 30d
  all:   Infinity,
};

export const DONE_WINDOW_LABEL = {
  day:   "Today",
  week:  "Week",
  month: "Month",
  all:   "All",
};

export const DONE_WINDOW_ORDER = ["day", "week", "month", "all"];
