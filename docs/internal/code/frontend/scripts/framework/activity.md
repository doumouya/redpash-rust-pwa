---
title: frontend/scripts/framework/activity.js
source: ../../../../../../frontend/scripts/framework/activity.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-05
---

# framework/activity.js — Activity-timeline component

## Purpose

One reusable **activity timeline** (`rp-activity`) — an event feed rendered as a
connected vertical timeline. De-cased from the per-page Cases activity feed
(`cases.js` `renderActivityList` / `activityRow`, the old `rp-cases-activity-*`
classes) so any page (Cases, Monitoring, an audit trail) mounts the same component
rather than re-rolling it.

`mountActivity(host, { events, empty })` → self-registers as `register("activity", …)`.
Each event `{ kind, occurred_at, message, actor? }` renders a lead marker (a kind-toned
`rp-activity-dot`, or an `rp-avatar` when an `actor` is present), the action text with
an optional `rp-status` kind pill, and a relative `<time>` (absolute value on hover /
`datetime`). The `kind` (de-prefixed of `case_`) keys a tone (`ok` / `info` / `warn`);
unmapped kinds render neutral. Composes the `rp-avatar` + `rp-status` atoms; **all
dynamic values are `esc()`-escaped** (the established `comments.js` safe-`innerHTML`
pattern — only self-constructed markup + internal tone constants are unescaped).

CSS twin: `frontend/styles/framework/activity.css` (built on the two-tier `--rp-*`
tokens, so it themes for free). Render-proven in `framework-sandbox.html`.

## Public surface

- `mountActivity(host, { events, empty })` → `{ update(next) }`; self-registers as
  `register("activity", …)`.
- Event shape: `{ kind, occurred_at, message, actor? }`. `kind` is de-prefixed of
  `case_`, and its first word keys the `TONE` map (`ok` / `info` / `warn`, else
  neutral). `actor` (`{ name }` or a string) is optional — present → `rp-avatar`
  marker, absent → a toned `rp-activity-dot`. `occurred_at` feeds the relative
  `<time>` (with the absolute on `title` + `datetime`).
- Composes the `rp-avatar` + `rp-status` atoms; tones map to `rp-status`'s
  `is-active` / `is-new` / `is-lapsed` states via the `PILL` table.

## Drift-prone areas

- The `TONE` / `PILL` maps key off the **first word** of the de-prefixed kind — a new
  event kind renders neutral (no pill colour) until it's added to `TONE`.
- The pill uses `rp-status`'s legacy `is-*` state classes. When the coherence campaign
  migrates `rp-status` to `data-tone`, update the `PILL` map **and** `eventHTML`
  together, or the pill loses its colour.
- `relTime` is computed at render; long-lived mounts should call `update()` to refresh
  `"2h"` → `"3h"`. Every dynamic value passes through `esc()` — keep any new field
  escaped (the file builds HTML strings, so an un-escaped field is an XSS hole).
