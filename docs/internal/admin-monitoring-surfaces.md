---
title: Admin + Monitoring surfaces
section: Internal
last modified date: 2026-05-23
---

# Admin + Monitoring surfaces — one shell, two pages

> **Internal — RedPash team only.** This is the IA + wire contract
> for the two new top-level pages that surface domain entities
> (`/home`, renamed from "Objects") and system telemetry
> (`/monitoring`). Both pages share one shell pattern: rail nav on
> the left, body on the right. The rail is the same `.rt-nav`
> component the Workspace already uses; the body owns its own
> sub-controls so we never end up with stacked horizontal tab rows.

## TL;DR

1. **Home replaces Objects** — signing in lands you on the org's
   command center, not a launchpad. "Log straight into business."
2. **One shell, two pages.** Same rail + body markup as the
   Workspace. Home rail = domain entities, Monitoring rail = system
   tables. Body changes per tab.
3. **Body owns its sub-controls.** Filter chips, sub-tabs, and
   contextual KPIs live inside each tab's body — never as a second
   horizontal row above. The rail solves the dual-row problem.
4. **Projects keeps the card board.** Other Home tabs render the
   redtable. Two render modes, picked per tab.
5. **Monitoring is a fixed composition** (KPI row + ECharts time
   series + distribution + ranked table + redtable drill-down) — not
   a user-built dashboard. The user-facing dashboard builder ships
   later, separate concern.

## 1. Topbar after the merge

```
Home · Workspace · Monitoring · Profile · Settings · Docs
```

Six top-level routes. Objects collapses into Home; Monitoring is
new.

## 2. `/home` — org command center

### Rail

Two static groups (categories, not dynamic projects — the only
semantic difference from the Workspace rail):

```
▼ ORG
  👥 Users
  🏢 Companies
  🔗 Memberships

▼ DATA
  📁 Projects   ← default tab
  📄 Files
  📊 Charts
  🔧 Steps
```

Compact mode collapses to a 60px icon rail like Workspace. Icons
from Bootstrap Icons (`bi-people`, `bi-building`, `bi-link-45deg`,
`bi-folder`, `bi-file-earmark`, `bi-bar-chart`, `bi-wrench`).

### Body — per tab

| Tab | Render | KPIs |
|---|---|---|
| **Projects** (default) | Card grid (existing design — pipeline + cleanness bar) | Total · With files · Avg cleanness · Updated this week |
| **Users** | Redtable (paginated) | Total · Active 7d · By role |
| **Companies** | Redtable | Total · Active 30d · With projects |
| **Memberships** | Redtable, with body-level sub-tabs (Project memberships / Company memberships) | Total · By role distribution |
| **Files** | Redtable | Total · By stage · By type · Avg cleanness |
| **Charts** | Redtable | Total · Last 7d · Used in reports |
| **Steps** | Redtable | Total · By kind · Last 24h |

KPIs render as a horizontal strip at the top of each tab's body —
contextual to the entity, not a global page strip. Same atomic
component family (`mountKpi`) as today's home stats.

### Greeting

A compact greeting header sits above the rail+body split:

```
Good evening, Em.
Pick up a project or scan a new CSV.
```

Time-aware (morning / afternoon / evening / night), uses
`session.first_name`. Two lines, full width, kept light.

## 3. `/monitoring` — ops panel

### Rail

```
▼ REQUESTS
  📨 Events
  🌐 Requests
  ⚡ Metrics

▼ AUDITS
  ▶ Runs
  ⚠ Findings
```

### Body — per tab

A fixed composition per tab. Layout for the Requests tab as the
canonical example:

```
┌─ time window chips: 1h · 24h · 7d · 30d ──────────┐  ← global per tab
│ Requests │ Avg lat │ Error rate │ p95 latency   │  ← KPI strip
│  12,847  │  84ms   │   1.2%     │   232ms       │
├───────────────────────────────────────────────────┤
│      p50 / p95 / p99 latency over window         │  ← ECharts line
├───────────────────────┬───────────────────────────┤
│  Status code mix      │  Top routes by p95        │  ← donut + ranked
├───────────────────────┴───────────────────────────┤
│   Raw redtable (read-only, paginated, filterable)│  ← drill-down
└───────────────────────────────────────────────────┘
```

Other Monitoring tabs follow the same pattern with different KPIs
and chart compositions.

## 4. Shell — `.rt-nav` reused

The same component the Workspace uses. **Same markup, different
semantic:**

- Workspace rail: groups are dynamic (one per project, fetched
  from `/api/projects`).
- Home/Monitoring rail: groups are static (declared in the page
  module's render function, e.g. `ORG`/`DATA`).

This is a documented divergence, not an accident. Don't refactor
the rail to assume dynamic groups. Don't refactor Home/Monitoring
to declare groups as a data payload.

Both pages reuse `rail.css` directly (no new CSS for the rail
itself). Page-level CSS adds only the shell layout (`rp-home__shell`,
`rp-monitoring__shell`) and per-tab body styles.

## 5. Reuse story — chart primitives

This page is the first real consumer of the chart primitives memory
`[[project_reports_charts_reuse]]` calls for. Three primitives,
stateless data-in:

| Primitive | Signature | First consumer |
|---|---|---|
| `mountKpi(el, { label, value, hint? })` | One big number with a label | Home greeting stats (already on `/home` today), Home tab KPIs, Monitoring KPI strip |
| `mountTimeSeries(el, { points, keys })` | ECharts line for time-series | Monitoring latency panel |
| `mountDistribution(el, { items })` | ECharts donut for proportions | Monitoring status-code mix |

These land in `frontend/scripts/charts.js` once they have two
consumers each. Until then, inline composition inside each page is
fine — premature extraction is its own debt.

## 6. Wire shape — what backend needs

Every list endpoint returns the canonical `Page<T>` shape (same as
`/api/files/:rid/page`). No new DTO category — the redtable
consumes `Page<T>` rows, the KPI strip consumes the row count + a
small aggregate.

### New endpoints — Home

| Endpoint | Returns | Status |
|---|---|---|
| `GET /api/admin/users` | `Page<UserSummary>` | **needed** |
| `GET /api/admin/companies` | `Page<CompanySummary>` | **needed** |
| `GET /api/admin/memberships?scope=project\|company` | `Page<MembershipSummary>` | **needed** |
| `GET /api/admin/files` | `Page<FileSummary>` (org-wide, not per project) | **needed** |
| `GET /api/admin/charts` | `Page<ChartSummary>` | **needed** |
| `GET /api/admin/steps` | `Page<StepSummary>` | **needed** |
| `GET /api/projects` (existing) | `Page<ProjectSummary>` | ✓ |

### New endpoints — Monitoring

| Endpoint | Returns | Status |
|---|---|---|
| `GET /api/metrics` (existing) | per-route p50/p95/p99 + counts × 4 windows | ✓ |
| `GET /api/monitoring/events?window=24h` | `Page<EventSummary>` | **needed** |
| `GET /api/monitoring/requests?window=24h` | `Page<RequestSummary>` + aggregate `{ status_mix, top_routes }` | **needed** |
| `GET /api/monitoring/audit-runs` | `Page<AuditRunSummary>` | **needed** |
| `GET /api/monitoring/audit-findings?run=<rid>` | `Page<AuditFindingSummary>` | **needed** |

All `?window=` values mirror `/api/metrics`: `1h`, `24h`, `7d`,
`30d`.

## 7. Auth-readiness

Tabs are computed from session permissions when RBAC ships. The
declaration shape is already permission-friendly:

```js
const HOME_TABS = [
  { group: "ORG",  key: "users",       label: "Users",       icon: "bi-people",       perm: "admin" },
  { group: "ORG",  key: "companies",   label: "Companies",   icon: "bi-building",     perm: "admin" },
  { group: "DATA", key: "projects",    label: "Projects",    icon: "bi-folder",       perm: "user"  },
  // ...
];
```

Today (solo dev, pre-prod): all tabs visible. Tomorrow (RBAC):
filter by `session.permissions`. Same code, no rewrite.

## 8. Phasing — what ships now vs. gated

**Phase 1 — Home shell (this PR):**
- `/home` rebuild on rail + body shell.
- Projects tab fully wired (uses existing `/api/projects`).
- Greeting + contextual KPIs for Projects.
- Other tabs (Users / Companies / etc.) render an honest "Coming
  when `/api/admin/<entity>` lands" placeholder citing the
  endpoint — same discipline as the disabled tool buttons.

**Phase 2 — Backend list endpoints (Gus):**
- `/api/admin/users`, `/companies`, `/memberships`, `/files`,
  `/charts`, `/steps` — paginated, `Page<T>` shape.
- Optional aggregates for KPI tiles (`/api/admin/<entity>/stats`).

**Phase 3 — Monitoring shell:**
- `/monitoring` page, same rail+body shell, same code path as
  Home for the redtable bodies.
- Wires `/api/metrics` (already live).

**Phase 4 — Monitoring panels (after Phase 2 + 3):**
- ECharts time-series + distribution panels.
- Drill-down via row selection.

**Phase 5 — Chart primitives extraction:**
- `mountKpi`, `mountTimeSeries`, `mountDistribution` land in
  `scripts/charts.js` once they have two consumers each.

## 9. What does NOT land in these pages

- **The user-facing dashboard builder** — separate workstream
  (planned per `[[project_logs_monitoring_dashboard]]`). The
  Monitoring page is a fixed composition; users can't add panels.
- **Real-time push** — telemetry pages poll on tab change + a
  manual refresh button. WebSockets / SSE is a later spike.
- **Cross-page linking** beyond the existing `?project=<rid>` hash
  param — e.g. clicking a project in Home's Projects tab opens
  Workspace, not an in-Home detail view.

---

**Status:** drafted 2026-05-23 by Torv. Open for Gus's read on
the wire shapes (§6) before Phase 2 work starts.
