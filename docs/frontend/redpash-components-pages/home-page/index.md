---
title: Home page (`#/home`)
section: Frontend
order: 11
---

# Home page (`#/home`)

The authenticated landing surface — what users see right after Google
sign-in. Full-bleed (no topbar). A **single dashboard card**: upload
zone, recent-projects / latest-files minitables, and a stat strip.

The four browse redtables (projects / files / reports / dashboards)
that used to be Home steps 2–5 moved to the dedicated
[`/objects` page](../objects-page/index.md). Home links into it from
the stat buttons, the bottom-left float bar, and the minitable rows.

---

## Files

| File | Role |
|---|---|
| [`partials/home.html`](../../../../frontend/partials/home.html) | Markup. One `.hs-card` dashboard card + float bars + top-left avatar + contact / file-review modals. |
| [`styles/pages/home.css`](../../../../frontend/styles/pages/home.css) | Library `@import`s (home-screen / minitable / stat-strip / upload-zone / card / modal / avatar / float-btn …) + avatar size bump + minitable placeholder rows. |
| [`scripts/pages/home.js`](../../../../frontend/scripts/pages/home.js) | Dashboard data load + minitable / stat-strip renderers + the upload → file-review → confirm flow. Inline-onclick globals (`homeOpenReview`, `homeUploadConfirm`, `homeUpload`, `doLogout`, `doContact`). |
| [`scripts/main.js`](../../../../frontend/scripts/main.js) (shell) | Route flagged `chrome: "full"` → main.css hides topbar / zeroes `.rp-app` gutter / re-binds `--accent` to library blue. |

---

## The dashboard card

A single `.hs-card.hs-import` (`data-step="1"`), two-column layout:

- **Left (`.hs-import-text`)** — eyebrow + headline + copy, then two
  `.rp-minitable`s:
  - **Recent projects** — top 5 by `updated_at desc`. Always renders
    exactly 5 rows; missing slots are aria-hidden placeholders (`—`
    cells) so the table keeps its visual weight.
  - **Latest files** — top 5 files in the most-recent project, fetched
    on its own request so it doesn't block the page render.
- **Right (`.hs-import-panel`)** — the stat strip + the upload card.

The old scroll-snap step machinery (5 step cards, right-side
`.rp-page-dots`, `homeGoTo`, the IntersectionObserver) is **gone** —
there's only one card now.

### Stat strip

`renderStats()` animates three counters from 0 → real values over
900 ms (`ease-out-cubic` via `requestAnimationFrame`). Each stat is a
**button** that navigates into `/objects`:

| Stat | Value | Links to |
|---|---|---|
| Projects | `homeData.projects.length` | `#/objects?tab=projects` |
| Files | `Σ project.file_count` | `#/objects?tab=files` |
| Published | `reports.is_public + dashboards.is_public` | `#/objects?tab=reports` |

### Upload flow

The upload zone accepts CSV / TSV / Excel, `multiple` allowed.

1. `homeOpenReview(files)` splits the drop into CSV/TSV vs Excel vs
   unsupported.
2. **CSV / TSV** → library `file-review.js` analyses client-side and
   opens `#modal-ul-review` (single- or multi-file panel auto-picked).
3. **Excel** (`.xlsx` / `.xls` / `.xlsm` / `.xlsb` / `.ods`) →
   short-circuits past the modal (the analyser only reads text bytes);
   `homeUpload` direct-uploads, and the Rust backend converts to CSV
   during ingest via `calamine` — see
   [features/cleaner.md](../../../features/cleaner.md).
4. The modal CTA → `homeUploadConfirm()`: requires a project name,
   closes the modal immediately, then fire-and-forget POSTs each file
   to `/api/files/upload`. Single-file uploads auto-navigate to
   `#/cleaner?file=…` **after** the backend confirms (with a 600 ms
   minimum-visible floor so a sub-100 ms round-trip doesn't stutter the
   modal → cleaner transition). Multi-file stays on `/home` and
   refreshes the dashboard in place.

---

## Float bars + avatar

**Top-right float bar** — Docs (`#/docs`) · Theme toggle
(`rpToggleTheme` from shell) · Log out (`doLogout`, POSTs
`/api/auth/logout` + reload). The Settings gear is **gone** — settings
now live in `/profile`'s Settings section, and the top-left avatar is
the single entry point to anything account-shaped.

**Bottom-left float bar** — Projects / Files / Reports / Dashboards,
each a plain `<a href="#/objects?tab=…">` into the browse page, plus
Contact (`openModal('contact')`).

**Top-left avatar** — `.rp-avatar.rp-avatar--lg.rp-avatar--float
.rp-avatar--glass.rp-photo-av`, links to `#/profile`. Initials from
`session.display_name` / `session.username` (2-letter, uppercase).
When `session.avatar_url` is set, JS swaps `backgroundImage` and clears
`textContent` — the library's `background-size: cover` crops the photo
cleanly. Bumped to **4rem / 4.5rem** so it reads as "you", distinct
from the **2.5rem / 3rem** float buttons; the override is in `home.css`
scoped to `#home-avatar.rp-avatar--lg`.

---

## JS wiring (inline `onclick` handlers)

Defined inside `mount()` so the router can re-register them on each
/home navigation.

| Handler | Source | Behavior |
|---|---|---|
| `homeOpenReview(files)` | home.js | Splits the drop; CSV → file-review modal, Excel → direct upload. |
| `homeUploadConfirm()` | home.js | CTA from the file-review modal — POSTs each pending file, auto-navs single uploads to the cleaner. |
| `homeUpload(file)` | home.js | Single-file direct upload (Excel short-circuit + programmatic entry point). |
| `doLogout()` | home.js (defensive) / **main.js** (canonical) | `POST /api/auth/logout` + redirect to `#/landing`. |
| `doContact()` | home.js | Toast — no `/api/contact` endpoint yet. |
| `openModal` / `closeModal` | **main.js** (shell) | Modal toggle. |
| `rpToggleTheme()` / `rpSetTheme(t)` | **main.js** (shell) | Theme cycle + account-level persist via `rpSavePref`. |

---

## Wired vs stubbed against the backend

| Surface | Endpoint | Status |
|---|---|---|
| Recent-projects minitable | `GET /api/projects` | ✅ live |
| Latest-files minitable | `GET /api/projects/:rid/files` (top project) | ✅ live |
| Stat: Projects / Files / Published | `/api/projects` + `/api/reports` + `/api/dashboards` | ✅ live |
| Upload zone | `POST /api/files/upload` (CSV + XLSX dispatch) | ✅ live |
| Stat buttons / float bar → /objects | `#/objects?tab=…` | ✅ live |
| Minitable row click → cleaner | `#/cleaner?project=…` / `#/cleaner?file=…` | ✅ live |
| Log out | `POST /api/auth/logout` + redirect | ✅ live |
| Avatar | initials from `/api/me`; photo background from `avatar_url` | ✅ live |
| Contact form | — | ⛔ stub — Send toasts; no `/api/contact` yet. |

> Browsing / searching / managing projects / files / reports /
> dashboards — including delete, rename, and the redtable toolbar —
> all moved to the [`/objects` page](../objects-page/index.md).

---

## Cache / refresh

Every change to the partial, CSS, JS, or any imported library
component triggers a `service-worker.js` `CACHE_VERSION` bump. Hard-
refresh (Ctrl+Shift+R) to see edits.
