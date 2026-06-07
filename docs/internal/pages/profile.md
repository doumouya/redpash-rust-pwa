---
title: Page — Profile
section: Internal
last modified date: 2026-06-07
---

# Page — Profile

The Profile page is the signed-in user's own account surface: the identity
card (avatar / name / email / plan), the editable personal-info form, a usage
read-out, and the plan + connections status. It is the "view and edit my own
record" screen — the user-facing companion to the admin Users tab on Home.

Markup lives in `frontend/partials/profile.html`; all behavior is in
`frontend/scripts/pages/profile.js`. Data comes from `GET /api/me`, and the
one write path is `PATCH /api/me`.

> **Note on the rebuild plan.** `docs/profile-settings-rebuild.md` describes a
> planned 2-tab "record page" rewrite (`profile-record.js`, avatar upload,
> Plan/Connections folded into record sections, `set-account` dropped from
> Settings). That **live cutover never landed.** The shipped page is the
> 4-tab `profile.js` documented here — describe and change *this*, not the
> plan. Where the two disagree, the code wins.

## Layout — rail shell, four tab panels

Profile adopts the shared `.rp-shell` rail-page layout (same frame as
Settings / Home / Monitoring): topbar, a left rail, and a main surface. The
rail body is a tab index built in JS from `PROFILE_SECTIONS`:

1. **Personal info** — identity card + the editable form (default landing tab).
2. **Usage** — a horizontal ECharts bar of the user's entity counts.
3. **Plan** — current plan name, feature list, and an Upgrade affordance.
4. **Connections** — connected auth accounts (Google live; others "Soon").

Each section is a `[data-prof-tab]` panel. Clicking a rail tab calls
`activate(tabId)`, which shows the target panel and hides the rest via the
`hidden` attribute — full-page tab switching, not in-page scroll-anchors.
This matches Home / Monitoring behavior (Em 2026-05-28: consistent across
pages). Rail collapse is the shared `mountRailCollapse` helper; the rail
footer carries the cross-page nav (Docs / Settings / Profile).

### Why Usage is lazy-rendered

ECharts cannot compute a chart's size inside a `display:none` / `hidden`
panel — it would render at zero width. So `loadUsage` is **not** called at
page load; instead `activate` fires it the first time the Usage tab actually
becomes visible (guarded by a `usageLoaded` flag so it runs once). This is the
single most important quirk to know before touching the tab logic.

## Data flow

On mount: `mountTopbar` + `mountRailFooterNav` + `mountProfileRail` +
`renderForm`, then `await api.get("/me")`. A failed `/me` paints a placeholder
and bails — no partial state.

`GET /api/me` returns the `UserProfile` (flattened) plus session context. The
page reads: `display_name`, `username`, `email`, `job_title`, `use_case`,
`redpash_id` (the `USR_` Account ID), `avatar_url`, `plan`, and `memberships`.
Memberships are hydrated server-side from the user's real company affiliations
(`db::list_memberships_for_user`).

Population is split by concern: `populateIdentity` (avatar, name, email, plan
pills), `populateForm` (the input values), `populateMemberships`, and
`populateConnections`. The avatar shows the image if `avatar_url` is set,
otherwise two-letter initials from the display name (or username).

## Editing — what the UI actually writes

The form is **read-only until Edit is pressed.** `setEditMode(app, editing)`
toggles the `is-editing` class, clears/sets `readonly` on named inputs, makes
the use-case pills interactive (`pointer-events` + opacity), enables Save, and
swaps the Edit button between pencil/"Edit" and lock/"Lock".

On submit, `PATCH /api/me` is sent with exactly three fields:

- `display_name` (text input)
- `job_title` (text input)
- `use_case` (the active pill: operational / research / reporting / other)

Empty strings are coerced to `null`. On success the identity name + avatar
re-paint inline (no remount) and the form re-locks. On failure Save re-enables
and an `alert` reports the status.

**Read-only by design:** username (server-assigned), email (from the Google
account), and Account ID (`redpash_id`). The Account ID row has a copy-to-
clipboard button that briefly swaps to a check icon; clipboard failures (no
HTTPS / no permission) are swallowed silently.

### UI vs backend capability gap (deliberate)

`PATCH /api/me` accepts more fields than the UI sends — `first_name`,
`last_name`, `organisation`, and `locale` are all writable server-side. The
live Profile form simply doesn't expose inputs for them. **Avatar is not
user-editable on this endpoint** — `me.rs` passes `None` for `avatar_url`
(managed by OAuth / a separate upload path). So the rebuild plan's "avatar
upload via PATCH /me" is aspirational, not current. If you add fields to the
form, the backend is already ready for the four listed above; avatar would
need a different route.

Memberships are **read-only here** — joining / leaving / role changes happen
on Home → Companies. Each membership renders as a link there. This is distinct
from the free-text `organisation` bio field. The page never edits memberships.

## Usage tab

`loadUsage` fetches `/projects`, `/charts`, `/dashboards` in parallel
(`Promise.allSettled`, so one failing list doesn't blank the chart). It
derives four counts: Dashboards, Charts, Files (summed from each project's
`file_count`, so no dedicated endpoint is needed), and Projects. Charts stands
in for "Reports" — on prerelease the object model merged reports into
chart-typed `project_files` rows.

The chart is drawn with the shared `kpiBarH` helper (the same renderer as the
Home + Monitoring KPI strips), so Profile inherits theme + bar improvements
for free. Each bar carries a `hash`; clicking a bar navigates to the matching
Home tab.

## Plan & Connections — affordances, not flows

Both tabs are intentionally light because pricing/billing aren't wired:

- **Plan** shows the plan name (mapped via `PLAN_LABELS`: free / pro / trial),
  the free-tier feature list, and an "Upgrade · Soon" badge. There is no real
  upgrade flow yet — the affordance exists ahead of pricing.
- **Connections** shows Google as live (Connected with the user's email when
  present) and Microsoft / Apple as "Soon" rows. Google is the only real auth
  configuration today; MFA / Authenticator / Corporate SSO / Okta are
  future-proofing the rebuild plan calls out but none are built.

## Source files

- [`frontend/scripts/pages/profile.js`](../code/frontend/scripts/pages/profile.md) — the page controller: rail tabs, form render/edit/save, usage, identity.
- [`backend/api/routes/me.rs`](../code/backend/api/routes/me.md) — `GET`/`PATCH /api/me`, `/me/avatar`; the profile DTO + sparse update.
- [`frontend/scripts/page-row.js`](../code/frontend/scripts/page-row.md) — `inputRow` / `mountRow` builders for the personal-info form rows.
- [`frontend/scripts/echarts-kpi.js`](../code/frontend/scripts/echarts-kpi.md) — `kpiBarH`, the shared horizontal-bar renderer behind the Usage chart.
- [`frontend/scripts/topbar.js`](../code/frontend/scripts/topbar.md) — the topbar mounted at page load.
- [`frontend/scripts/rail-footer.js`](../code/frontend/scripts/rail-footer.md) — the rail footer cross-page nav.
- [`frontend/scripts/rail-controls.js`](../code/frontend/scripts/rail-controls.md) — `mountRailCollapse` for the rail collapse toggle.
