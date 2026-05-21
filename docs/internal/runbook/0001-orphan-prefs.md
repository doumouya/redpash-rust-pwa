---
title: 0001 — Orphan preferences
section: Runbook
order: 1
last modified date: 2026-05-21
---

# 0001 — Orphan preferences

**Date:** 2026-05-21 · **Area:** frontend / Settings · **Status:** partially resolved

## Problem Statement

A review of the user-preferences system asked a plain question: do the
controls on the Settings page all actually *do* something?

Four did not. The control persisted the user's choice correctly, but no
code anywhere read the value back — the control's sub-label promised an
effect that never happened. These are **orphan prefs**:

| Pref | Settings section | Sub-label promised |
|---|---|---|
| `density` | Appearance | redtable row height in Cleaner / Reports |
| `default_delimiter` | File handling | delimiter applied at file open |
| `default_encoding` | File handling | fallback encoding at file open |
| `export_format` | File handling | default format when downloading |

The entire **File handling** section was cosmetic — all three of its
controls were orphans.

## Troubleshooting steps

1. **UI inventory.** Walked every Settings / Profile control. All 15 are
   wired to `rpSavePref` and persist correctly — there was no *dead
   control* (UI with no persistence).
2. **Storage inventory.** `rpSavePref` writes the account `users.prefs`
   JSONB (plus a localStorage mirror for the ~10 keys in `PREFS_LS_MAP`).
   29 distinct pref keys are written across the app.
3. **Cross-reference.** For each of the 29 keys, located the write site
   and the read/apply site. 25 had a consumer. Four did not — `grep`
   across `frontend/` and `backend/` found *no read site* for `density`,
   `default_delimiter`, `default_encoding`, or `export_format`.
4. **Consumer-path check.** Confirmed the gap at the other end: the
   backend `export` handler is hardcoded CSV-only (`CsvWriter`), and the
   file-open path auto-sniffs delimiter + encoding without ever reading
   a stored user default.

The profile-page doc had already flagged three of the four (🟡 "not yet
read"); `density` was an unflagged fourth.

## RCA

The controls were built **UI-first**. The Settings page shipped the pill
groups and the `rpSavePref` persistence, but the *consumer* half — the
redtable reading `density`, the file-open path honouring delimiter /
encoding, the export path honouring format — was never built.

Persistence working is a convincing illusion: the choice sticks across
reloads, so the control *looks* finished. And nothing catches the gap —
a pref with a writer and no reader is invisible to the type system and
to every test. It is a pure semantic gap, visible only by cross-
referencing write sites against read sites by hand.

## Solution

**Fixed now — `density`.** Wired frontend-only, mirroring the existing
`data-theme` pattern: `main.js` sets `<html data-density>` at boot from
`prefs.density`, `redtable.css` shrinks `tbody tr` height under
`html[data-density="compact"]`, and `settings.js` applies it live on
click.

**Deferred — the File-handling trio.** `default_delimiter`,
`default_encoding` and `export_format` need backend work that does not
belong in a frontend change: `export` must grow xlsx / json writers and
a format parameter, and the file-open path must accept delimiter /
encoding overrides. Until then the three controls are badged **"Soon"**
in Settings so the UI stops promising an effect it cannot deliver. They
remain a tracked backend follow-up.

**Prevention.** When adding a preference, wire the *reader* in the same
change as the *writer* — or badge it "Soon" from day one. A persisted
value with no consumer is a bug, not a feature.

## Post Checking

- `main.js`, `settings.js` and `service-worker.js` pass a Node 22 syntax
  check. (The Bash shell's Node 12 rejects `??` and ES modules — a false
  alarm; always verify with Node 22.)
- `density` is a visual change — confirm in a browser: Settings ›
  Appearance › density › **Compact**, then open a redtable (Cleaner /
  Reports / Objects) and check the rows shorten (`3rem` → `2.25rem`).
  The choice must also survive a reload — it is applied at boot from
  `prefs.density`, mirroring `data-theme`.
- The three "Soon" badges render via the existing `.rp-soon` CSS — no
  new style was needed.
- **Still watching:** the File-handling trio remains an open backend
  follow-up. This entry's status stays *partially resolved* until
  `default_delimiter` / `default_encoding` / `export_format` are wired
  for real — extend this entry when that lands.

## Links

- Files touched: `frontend/scripts/main.js`, `frontend/scripts/pages/settings.js`,
  `frontend/styles/components/redtable/redtable.css`,
  `frontend/partials/settings.html`.
- Method: pref write-site ↔ read-site cross-reference (`rpSavePref` grep).
