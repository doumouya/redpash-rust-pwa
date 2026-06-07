---
title: Shared chrome — Rail footer
section: Internal
last modified date: 2026-06-07
---

# Shared chrome — Rail footer

The rail footer is the small utility cluster that sits at the bottom of
the left rail on every railed page: **Docs · Settings · Profile**. It is
the same component everywhere, mounted by each page's script, so the three
"where do I go for the boring-but-always-there destinations" links read
identically across Home, Workspace, Cases, Monitoring, and the utility
pages themselves.

## Why it exists (and why it's at the bottom of the rail)

These three destinations were relocated out of the topbar on 2026-05-28
(Em's call), VS-Code / Slack style. The split of concerns is deliberate:

- **Topbar** keeps the *primary* page navigation plus theme toggle and
  sign-out — the things tied to "what am I doing right now".
- **Rail foot** carries the *utility* destinations — Docs, Settings, your
  Profile — the things that are always one click away regardless of the
  page you're on.

Putting them at the bottom of the rail mirrors how desktop IDEs and chat
apps anchor account/settings/help: out of the primary flow, but never
hidden behind a menu.

## How it mounts

Each railed page imports `mountRailFooterNav(footEl, { active, session })`
from `rail-footer.js` and calls it after building its shell, passing the
rail-foot element (the page's `.rp-rail-footer`). Two arguments drive it:

- **`active`** — the id of the current page (`"docs"`, `"settings"`,
  `"profile"`, or `""` for any non-utility page). The matching entry gets
  the `is-active` class so it highlights. A page like Home passes `""`
  because none of the three utility entries represents it.
- **`session`** — supplies the signed-in identity. Only the Profile entry
  uses it: it renders as an **avatar with initials** rather than an icon,
  carrying the same "this is you" read the topbar avatar used to. Initials
  are derived from `display_name` (falling back to `username`), taking the
  first letter of up to two words; with no name it falls back to `··`.

The cluster is a fixed list of three entries — Docs (`#/docs`, book icon),
Settings (`#/settings`, gear icon), Profile (`#/profile`, avatar). The
hrefs are plain hash routes, so navigation is the standard client-side
router; the footer adds no routing logic of its own.

## Behaviours worth knowing

- **Append, don't clobber.** The cluster is *appended* to the rail foot
  with `insertAdjacentHTML(..., "beforeend")`. It deliberately does not
  replace any page-specific create actions already living in the foot
  (New case / Upload / etc.) — the two concerns coexist, read distinctly.
- **Idempotent re-mount.** Before painting, it removes any existing
  `.rp-rail-footnav` it previously added. A page re-render therefore
  *replaces* the prior cluster instead of stacking a second copy. It only
  removes its own node, so sibling create-actions survive a re-render.
- **No-op on a missing foot.** If `footEl` is null the function returns
  immediately — a page without a rail foot simply gets no footer nav
  rather than an error.
- **Escaped output.** Labels and initials are run through `esc()` before
  being interpolated into the markup, so a hostile display name can't
  inject HTML through the avatar.
- **Accessibility.** The cluster is wrapped in a `role="navigation"`
  region labelled `Utility`, and every entry carries a `title` for its
  label.

## Drift-prone edges

- The list of three entries is hard-coded. Adding a fourth needs both a
  new `FOOTER_NAV` entry **and** CSS support — active-entry styling and
  the avatar treatment live in the stylesheet, not here.
- The active-highlight depends on the CSS rule keyed off `is-active`;
  changing the class name silently breaks the highlight.

## Source files

- [`rail-footer.js`](../../code/frontend/scripts/rail-footer.md) — the
  component that builds and mounts the utility cluster.
