// Format primitives — ISO timestamp / age / clock / day helpers used
// across the frontend. Extracted from cases.js per the cases-UI review
// (Em greenlit 2026-05-25). Lives at the root of `scripts/` next to
// `dom.js`, `prefs.js`, `theme.js` — the small-utility module tier.
//
// Today's consumer: pages/cases.js (chat-bubble day dividers + age +
// timestamp displays). Inline duplicates still live in
// pages/home.js (`fmtTime`), pages/monitoring.js (`fmtTime`,
// `fmtCount`, `fmtPct`, `fmtMeasurement`), and pages/workspace.js
// (`fmtRelTime` is the same concept as `fmtAge` under a different
// name) — those migrate naturally on their next touch. Not blocking;
// the atom existing here is the invitation.
//
// Every function tolerates bad/empty ISO input — returns a placeholder
// ("—" / "") rather than throwing or rendering "Invalid Date".

/**
 * Full timestamp for read displays (Reporter info row, activity feed,
 * details DL). Locale-aware: respects the user's date + time format
 * preference set by the browser.
 *
 * @param {string} iso  RFC3339 / ISO 8601 timestamp; empty/invalid → "—"
 * @returns {string}
 */
export function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/**
 * Clock face (HH:MM, locale-aware). Used in comment-bubble headers
 * where the date is already implied by the day-divider above.
 */
export function fmtClock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Relative age — "10s", "5m", "3h", "2d". Compact (≤ 4 chars). Used
 * on kanban cards + rail items where the full timestamp would crowd
 * the row. Caps at days; weeks+ should use `fmtTime` instead.
 */
export function fmtAge(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Math.max(0, Date.now() - d.getTime()) / 1000;
  if (diff < 60)    return Math.floor(diff) + "s";
  if (diff < 3600)  return Math.floor(diff / 60) + "m";
  if (diff < 86400) return Math.floor(diff / 3600) + "h";
  return Math.floor(diff / 86400) + "d";
}

/**
 * Calendar-day grouping key — `YYYY-M-D` (month 0-indexed, no zero
 * pad). Used to detect day boundaries when walking a chronologically-
 * ordered list (e.g. comments). Same calendar day → same key.
 *
 * Not an ISO date; format is deliberately opaque (consumer compares
 * keys, doesn't parse). `—` for invalid input matches `fmtTime` style.
 */
export function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
}

/**
 * Human day label — "Today" / "Yesterday" / weekday name (within a
 * week) / locale-formatted full date (older). Sits on a chat-bubble
 * day-divider above the first comment of each day.
 */
export function dayLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(today) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7)   return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
