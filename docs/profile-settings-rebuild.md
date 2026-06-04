It's also an occasion to see what is missing. And to Rebuild Profile and Settings pages on a totally different level. We also want RedPash in general to be extremely customizable. 
We don't know yet what Customer will need/ask to be customizable. We have to think out of the Box.

Profile page: The goal is to allow User to view and edit his personal details, his current plan, his different Memberships/Teams and role in each situation.
- Do we currently give the options to User to update all the fields on the User object in the platform ? We don't even give the option to change the profile picture..., Think of this UI as the Record page that should appear when clicking on a row in the User tables in Home page
- Do we show everything that should be consider relevant for a User to be informed of his Usage of the platform in Usage tab?
- the Plan tab, even if everything is not set yet regarding the pricing and offering of the service, but we don't even see an indication about how User could upgrade his current plan, how can we solve this?
- Connections: at the moment only Google is the real Auth configuration, but what are the evolution we don't see ? MFA ? Authenticator App? Corporate SSO? Okta?
- Do we really need 4 tabs here? do we keep 4 tabs in anticipation of potential future addition ? could 2 tabs be enough to reach the goal?
- Do we have dupes between the Profile and Settings pages? What is the point of component id="set-account" in the settings page when we already have a Profile page already showing the same thing?
- What are components in Settings that should actually belong to the Profile page?

---

## Executed — 2026-06-04 (sandbox-proven, framework components; live cutover pending)

Both pages rebuilt from the framework component set in `framework-sandbox.html` (zero legacy
class leak, 0 console errors). The shared **form-control unlock** landed first: `rp-field`
(labeled row), `rp-seg` (segmented/toggle — JS builder over the existing seg.css), `rp-select`
(dropdown over rp-menu), `rp-badge` (soft-tint pill, replaces ~4 page-local copies),
`rp-avatar-upload` (the picture edit). Commits: form-controls `73b26cd`, Profile `0a6342a`,
Settings `a98a98d`.

**Profile = the User record page** (`profile-record.js`), answering the brief:
- *Update all User fields / profile picture?* — YES now. Every `UserProfile` field renders as an
  `rp-field`: editable ones an `rp-input` → `PATCH /users` (first/last name, job title,
  organisation, use case, locale, display name via the rp-head editable title); handle/email
  read-only. **Profile picture** via `rp-avatar-upload` → `PATCH /users {avatar_url}` (backend
  was already ready; the UI just never exposed it). Framed as the record page (rp-head object
  header with the `USR_` rid pill) — the detail that opens from a Home Users row.
- *Usage* — kept as the 2nd tab (stat-strip + charts); deeper usage metrics are a follow-up.
- *Plan upgrade* — an explicit **Upgrade** button + plan badge in the record's Plan section
  (affordance exists even pre-pricing).
- *Connections future-proofing* — Google (live) + **MFA / Authenticator / Corporate SSO / Okta**
  as "Soon" rows.
- *4 tabs → 2* — YES: **Record + Usage**. Plan & Connections became record *sections*.
- *Dupes / `set-account`?* — CONFIRMED. `set-account` (display name / username / sign-out)
  duplicates Profile → it **drops from Settings**; account identity lives on the Profile record
  (sign-out stays reachable from the topbar/rail). That's the dedup, applied at the live cutover.
- *What Settings components belong to Profile?* — the account-identity prefs (the `set-account`
  block); they move to the record.

**Settings = configure-by-example** (`settings-config.js`) — your idea, full: each preference
sits beside a LIVE instance of the component it controls. Verified the controls drive the
previews: Theme (seg) re-themes a sample card; Default chart kind (seg) morphs a real ECharts
chart (bar/line/pie); Rows-per-page (select) grows a table; Show-row-numbers (seg) toggles the
RedTable's `#` column. The pref registry (`prefs.js`) + persistence stay; the cutover folds them
into this shape (each `onChange` writes the pref).

**Pending (the live cutover phase, coordinated + Em-gated):** repoint `profile.html`/`profile.js`
→ the record; `settings.html`/`settings.js` → configure-by-example; drop `set-account` + migrate
account prefs; wire the `onPatch`/`onAvatarFile`/`onUpgrade` seams. Docs page stays the markdown
viewer (only its rail swaps at the general rail cutover).