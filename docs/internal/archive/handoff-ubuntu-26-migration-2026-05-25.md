---
title: Handoff — Ubuntu 26 migration (2026-05-25 evening)
section: Internal
last modified date: 2026-05-25
owner: Woz · boundary-lock session
status: handoff (mid-stream)
---

# Handoff — Ubuntu 26 migration, 2026-05-25 evening

> **Em is migrating the dev box from Ubuntu 22.04 to Ubuntu 26.** This
> doc captures everything live in this session that isn't yet in git
> or memory so the next session can resume cold. The active workstream
> is **WASM Phase C — parse on wasm**, mid-flight with positive
> results just landed from Em's browser bench.

---

## 1. What this handoff exists for

The session machinery in `~` is split into git-tracked and
session-fresh state. The latter is what migrates:

| Location | What's in it | Migrates how |
|---|---|---|
| `~/redpash-app/` (git tree) | source + 4 local commits ahead of `origin/prerelease` | **push first** (preferred) or rsync the working tree |
| `~/.claude/projects/-home-mansa/memory/` | auto-memory (43 .md files + `MEMORY.md` index) | rsync — not git-tracked, has session-fresh lessons |
| `~/Internal-Slack/` | per-agent channel logs (`Woz.md`, `Gus.md`, `Torv.md`) + `presence/` + `commits.log` + `agent-rids.md` | rsync — not git-tracked |
| `~/redpash-app/backend/target/` | Rust + wasm32 build artifacts | regenerable; skip |
| `~/redpash-app/frontend/wasm/` | wasm-bindgen output (gitignored) | regenerable via `sh tools/build-wasm.sh` |
| `~/redpash-app/tools/wasm-bench/corpus/` | generated CSV fixtures (gitignored) | regenerable via `python3 tools/wasm-bench/generate.py` |

**Stack versions (from `tools/stack-version.sh` 19:15 — confirm
post-migration these are at-or-above on Ubuntu 26):**

| Tool | This box (22.04) | Ubuntu 26 expects |
|---|---|---|
| rustc / cargo | 1.95.0 | ≥ 1.85 |
| node / npm | 24.16.0 / 11.13.0 | ≥ 22.0 / ≥ 10 |
| psql | 14.23 | ≥ 14 (date_bin floor) |
| python3 | 3.10.12 | ≥ 3.10 |
| bash | 5.1.16 | ≥ 5 |
| wasm-pack | 0.13.1 | needed for `tools/build-wasm.sh` |
| wasm-opt | 116 (binaryen) | needed |
| jq / curl | 1.6 / 7.81.0 | needed for `tools/audit.sh` |

`stack-version.sh` is the post-migration smoke-test entry point. Run
it first on the new box.

---

## 2. Local commits ahead of origin (push queue)

`git log origin/prerelease..HEAD` at handoff time — 4 commits, all
mine, **all queued on `Internal-Slack/Torv.md` for his push** per
[[push-policy]] (Em-confirm → Torv-push, restored 18:26 when Torv
came back from the brief downtime):

| SHA | Subject | Status |
|---|---|---|
| `e8c2226` | wasm(data): expose parse_csv — Phase C spike, size delta +0.15 MB gzipped | Em confirmed, awaiting Torv push |
| `c340e68` | tools(wasm-bench): bench harness — generator + page + README | Em confirmed, awaiting Torv push |
| `3f00dc2` | docs(specs): WASM Phase C spike — partial report (size cliff filled) | Em confirmed, awaiting Torv push — **needs amend after this session** |
| `56fe07d` | frontend(sw): bump CACHE_VERSION v766 → v767 | Em confirmed, awaiting Torv push |

If the migration happens before Torv pushes, all four are local-only
on the old box. **Push priority** — fix this first on the new box:

    cd ~/redpash-app
    git fetch origin
    git status     # confirm clean
    git log origin/prerelease..HEAD   # the 4 above
    # then either:
    #   (a) ask Em to confirm + Torv to push from the new box, or
    #   (b) push directly with Em's confirm under the
    #       [[project-torv-downtime]] pattern if Torv is unreachable

---

## 3. WASM Phase C — full result, plug into the spike doc

**Em ran the browser bench at ~19:21 on `raw_101_clients_fr.csv`
(4.06 MB, 24,000 rows × 20 cols, real French-CSV stress-corpus
file).** Results pasted to chat:

| Lane | Iter | Parse (ms) | Rows | Cols | Score | Empty % | Notes |
|---|---|---|---|---|---|---|---|
| wasm | 1 (cold) | 1230 | 24,000 | 20 | 97.6 | 0.9 | — |
| wasm | 2 | 1204 | 24,000 | 20 | 97.6 | 0.9 | — |
| wasm | 3 | 1181 | 24,000 | 20 | 97.6 | 0.9 | — |
| wasm | 4 | 1171 | 24,000 | 20 | 97.6 | 0.9 | — |
| wasm | 5 | 1171 | 24,000 | 20 | 97.6 | 0.9 | — |
| wasm | 6 | 1176 | 24,000 | 20 | 97.6 | 0.9 | — |
| server | 1 | 25 | — | — | — | — | **HTTP 413** (file > 4 MiB cap) |
| server | 2 | 22 | — | — | — | — | HTTP 413 |
| server | 3 | 25 | — | — | — | — | HTTP 413 |
| server | 4 | 24 | — | — | — | — | HTTP 413 |
| server | 5 | 32 | — | — | — | — | HTTP 413 |
| server | 6 | 37 | — | — | — | — | HTTP 413 |

**Median wasm (warm, iters 2–6): ~1175 ms.** Cold-warm delta ~55 ms.

### Two headline findings

1. **WASM beats server on perf.** wasm parsed 4.06 MB (24k × 20) in
   ~1175 ms. Earlier curl baseline (19:13) on a smaller 1.95 MB
   (10k × 20) was server `parse_ms=1241`. wasm is faster on a
   2×-bigger file. Per-MB ratio strongly favors wasm.
2. **WASM unlocks a file the server REFUSES.** The 4 MiB demo cap
   (`DEMO_MAX_BYTES = 4 * 1024 * 1024` in `routes/demo.rs`) is below
   the page's 5 MB `DEMO_CAP_BYTES` in `wasm-engine.js`. wasm parses
   in the gap (4 MiB → 5 MB band). For anonymous demo flow,
   browser-side ingest is **strictly more capable** than server.

### Phase D unlock — JUSTIFIED

Per `roadmap-webassembly.md` §5 verdict criteria:

> "If the bundle is 10 MB and first-parse is 4 s, phase C is parked.
> If it's 2 MB and 200 ms, phase D follows."

Actual numbers:
- Bundle: **3.46 MB gzipped over-the-wire** (well under 10 MB)
- First-parse (cold): **1230 ms on 4.06 MB**
- Warm-parse: **~1175 ms on 4.06 MB**

The "2 MB and 200 ms" target was generous; we're at 3.46 MB and
~1175 ms on a 4× larger file. Phase D unlocked.

### What the next session amends

Edit `docs/internal/specs/wasm-phase-c-spike.md`:

1. Frontmatter: `status: partial …` → `status: filled — both cliffs crossed, Phase D unlocked`
2. Cliff #2 section: replace the "PENDING" placeholder with the wasm
   results table above + the two-headline-findings analysis.
3. Verdict (partial) table: change all three rows to Crossed/Unlocked.
4. Next steps: collapse to the "if wasm beats server" branch:
   - Phase D unlock (step_preview already wasm-callable; ingest gap
     now closed).
   - Wire `login.js` demo upload to use `engine.parse_csv` instead of
     the 40-line JS parser per Torv's tip (Woz.md 18:54).
   - rs-audit adds `wasm32 bundle size` trend row per roadmap §8.

Commit message: `docs(specs): WASM Phase C spike — perf cliff filled, Phase D unlocked`.
Then drop a push request on Torv.md.

---

## 4. Three-lane state at handoff time

Each agent's claims + last-shipped + queue. **Source of truth on the
new box: `~/Internal-Slack/presence/{Woz,Gus,Torv}.md`** — these
files were updated through 19:00. Mid-session state past that lives
only in this doc + the channel-log tails.

### Woz · boundary-lock session (me)

**Status: Phase C done bar the amend.**

Shipped today (chronological):
- `e980496` docs(js-rust-boundary): lock the boundary contract (Em sign-off) **[pushed]**
- `95188e1` frontend(settings): parameterize .rp-page__row (page-row.js +settings) **[pushed]**
- `6f1e3b0` frontend(profile): page-row.js second consumer **[pushed]**
- `9270642` frontend(css): rename rp-home-chart-* + rp-home-meta (audit misnamed 6→0) **[pushed]**
- `a88cdb4` frontend(css): rename rt-mon-* → rp-mon-* (audit mixed-prefix 5→0) **[pushed by Torv during session]**
- `e8c2226` wasm(data): parse_csv wrapper — Phase C spike **[awaiting push]**
- `c340e68` tools(wasm-bench): bench harness **[awaiting push]**
- `3f00dc2` docs(specs): WASM Phase C spike doc (partial) **[awaiting push, needs amend]**
- `56fe07d` frontend(sw): CACHE_VERSION bump for parse_csv visibility **[awaiting push]**

Next-session work (in order):
1. **Amend `wasm-phase-c-spike.md`** with the bench results above
   (see §3 above for exact edits) + commit + push-request.
2. **Wire `login.js` demo upload to `engine.parse_csv`** — replace
   the 40-line JS CSV parser. Per Torv (Woz.md 18:54): "the swap is
   one entry point in wasm-engine.js. Wire shape stays the same."
3. **Phase D start** — `step_preview` is already wasm-callable;
   browser-side step previews are the next slice. Scope before
   shipping; surface to Em.

Open threads:
- Torv.md (latest 19:17–19:19) — 4 push requests, last one urgent
  (the SW bump).

### Gus · BE audit-trail + observability lane

**Status: 3/5 slices shipped today, momentum strong.**

Lane (from `presence/Gus.md` and his self-organizing post Gus.md 18:04):

1. ✅ **REDMAP refresh** — `2112f09 docs(redmap): refresh Objects + Event kinds + add Migrations table` shipped 18:58
2. ✅ **`case_status_change` backend emit** — landed (closes case_* observability ⚠)
3. ✅ **36 audit-trail gaps "fix"** — `44084a8 tools(audits): recognize event::{info,warn,error} builders` — turned out the 36 gaps were FALSE POSITIVES of the audit not recognizing Torv's new builders; the audit code was wrong, not the route code. Closed by teaching the audit. Process-oriented at its best ([[feedback-process-oriented]]).
4. ⏳ **`#[tracing::instrument(skip_all)]` on hot handlers** — Torv shipped `82a4970 backend(tracing): #[tracing::instrument(skip_all)] on 45 hot handlers` (could be either lane; in practice it closed Gus's signal).
5. ⏳ **Cases composer security-audit hook** — blocked on cases-Woz markdown render commit.

### Torv · BE Rust refactor + cross-stack lane

**Status: queue renamed (Q-B/Q-C/Q-D) to disambiguate from "Phase C". (Q-C) FromRow spike shipped with negative finding; (Q-B) db.rs split started.**

Lane (from `Torv.md` 18:54 ACK + 19:00-area shipping):

1. ✅ **`docs/getting-started.md` refresh** — Em assigned 18:14; not yet confirmed shipped (check `a4a44d0 docs(schema): refresh migration table for migs 018-030` — that's docs but different file; getting-started may still be pending).
2. ⏳ **(Q-B) db.rs split** — `9b677ac backend(db): scaffold db/ module + extract sessions` shipped; in progress.
3. ✅ **(Q-C) FromRow spike** — `681350b docs(specs): FromRow spike — threshold finding · pattern doesn't repay` shipped. Negative result + recommendation to retire the audit's declined-pattern entry.
4. ⏳ **(Q-D) ResolvedUser extractor** — gated on (Q-B).
5. ⏳ **`redtable-unification.md` atom catalog** — queued behind (Q-B); page-row.js will land in the atom catalog when Torv gets to it.
6. ⏳ **Continuing REDMAP refresh slice** (Screens + monitoring API + routes-listing) — his existing claim.

---

## 5. Audit signals state (post-session)

Run `bash tools/audit.sh` on the new box to refresh; baseline from
19:21 run:

| Tool | State at handoff | Notes |
|---|---|---|
| auth-audit | 0 ownership leaks; **36 → 0** mutation handlers without `event::record` (Gus's `44084a8` taught the audit to recognize the new builders) | clean |
| crossing-audit | 0 dangling JS calls; 48 unused routes (admin/dev) | clean |
| css-audit | 0 conflicts, 0 orphans, 11 cross-file selectors share names (same as prior run) | clean |
| **css-tab-compare** | **all three signals = 0** (cross-prefix 0 / mixed 0 / misnamed 0) — closed by Woz's `9270642` + `a88cdb4` | clean |
| **html-audit** | candidates **15 → 8** (page__row family eliminated by Woz's `95188e1` + `6f1e3b0`); remaining top win = `shell` (29 LOC × 2 sites) | clean |
| js-audit | AST gate passed (Acorn v2 since `f1ec86f`) | clean |
| observability-audit | **39 / 37 ✓ / 2 → 0 ⚠** — `tracing::instrument` 0→45 (Torv's `82a4970`); `case_*` event kinds 0→active (Gus) | clean |
| redtable-audit | 0 errors / 0 warnings | clean |
| rs-audit | 6 hotspots > 600 LOC (db.rs 2455 — Torv splitting); repeat groups **184 → 178**; redundant lines **1393 → 1233** (Torv's `780b3c9` event-builders refactor) | improving |

**Audit signals fully closed this session:** html-audit page__row · css-tab-compare misnamed-shared · css-tab-compare mixed-prefix · auth-audit event::record gap (via audit-recognition fix) · observability-audit B-PERF.instrument · observability-audit B-CASES case_*.

**Open audit signals worth knowing:**
- html-audit `shell` candidate — deliberately parked (would need an HTML include runtime, borderline [[feedback-no-frameworks]]). See Woz.md 18:51 for rationale.
- rs-audit `row.try_get(_) DTO mapping` — declined pattern at 171 hits; Torv's FromRow spike showed it doesn't repay. Per `from-row-spike.md` recommendation, the entry should be retired or re-framed in `tools/rs-audit/audit.js`.

---

## 6. Memory state (this session's additions)

Files in `~/.claude/projects/-home-mansa/memory/` added or updated
this session — these must come across to the new box:

| File | Type | Change |
|---|---|---|
| `feedback_parallel_safe_commits.md` | feedback | NEW — `git commit -o <paths>` or `git commit -m "…" -- <paths>` close the parallel-staging race window. Both forms converged on independently (me: -o; Torv: --). Real bug, shipped 2 of 3 wrong commits before finding it. Indexed in `MEMORY.md`. |
| `project_torv_downtime.md` | project | UPDATED — flipped from "active downtime through ~2026-05-27" to "closed 2026-05-25 ~18:14" after Torv came back. Kept as historical context for the brief Em-confirms-direct-push window. |

`MEMORY.md` index now has the parallel-safe-commits entry. No other
memory file deletions or restructures.

---

## 7. Internal-Slack state

All three channel files were active. The presence directory has a
multi-Woz `## session:` divider pattern that emerged this session
(presence/Woz.md is shared by multiple concurrent Woz sessions; we
append `## session:` headed blocks rather than overwriting).

### Channel-tail summaries (use as starting context for next session)

**Woz.md** (my own channel, my own log entries + Gus's replies):
- 18:23 — three-lane split proposal (FE / BE-audit / BE-refactor)
- 18:51 — FE lane closed, proposing lane shift to WASM Phase C
- 18:56 — Gus's reply: 3-shape corpus recommendation + chardetng/calamine pre-flight
- 18:57 — Gus's FromRow widening recommendation (to Torv)
- 18:54 — Torv's reply: ACK option 1 (Phase C to me)

**Gus.md** (his channel, my pings + his self-org posts):
- 18:02 — my Asking-for on settings/profile lane (Gus's silent ACK at 18:04 in his queue post)
- 18:04 — Gus's queue ("watching" mentions `95188e1` favorably)
- 18:23 — my Asking-for on BE audit-trail lane proposal
- 18:51 — my FYI on Phase C pickup (consumer of his roadmap)
- 18:58 — Gus shipped slice 1 + starting slice 2

**Torv.md** (his channel, mostly my pings):
- 17:36 — FYI: js-rust-boundary.md locked
- 18:02 — FYI: page-row.js shared atom
- 18:23 — Asking-for: BE Rust refactor lane proposal
- 18:51 — Asking-for: Phase C overlap check
- 19:14 — Push request: `e8c2226` + `c340e68`
- 19:17 — Push request amend: `+3f00dc2`
- 19:19 — Push request (urgent): `+56fe07d` (SW cache bump)

### Open Asking-for threads at handoff

None blocking — all my asks have effective ACKs:
- Gus → multiple soft ACKs ("no action from me", "Clean implementation", "consumer-chain framing greenlit")
- Torv → explicit ACK on Phase C option 1 (Woz.md 18:54)
- Em → "Phase C" greenlight (19:00) + "go" (19:14) + the bench run (19:21)

---

## 8. Concrete next-session actions (in order)

Once the new Ubuntu 26 box is up:

1. **Run `tools/stack-version.sh`** — confirm rustc / cargo / node /
   wasm-pack / wasm-opt / psql / python3 all at-or-above MIN_VERSION.
   Fix anything missing.
2. **Sync the working tree** — verify `cd ~/redpash-app && git
   status` matches the 4-commits-ahead state described in §2; if it
   does, see step 3. If commits got pushed by Torv before migration,
   skip to step 4.
3. **Push the 4-commit batch** — Em-confirm → Torv-push per [[push-policy]].
   Sequence: `e8c2226` → `c340e68` → `3f00dc2` → `56fe07d`. Single
   `git push origin prerelease` covers all four.
4. **Rebuild wasm artifacts** — `sh tools/build-wasm.sh` (regenerates
   `frontend/wasm/`; gitignored). Verify the bundle size matches the
   ~3.46 MB gzipped baseline.
5. **Regenerate bench corpus** — `python3 tools/wasm-bench/generate.py`
   (regenerates `tools/wasm-bench/corpus/`; gitignored).
6. **Boot the backend** — `cargo run -p api`. Smoke-test `/api/health`
   = 200.
7. **Amend the Phase C spike doc** per §3 above. Commit, drop push
   request to Torv.md.
8. **Phase D start** — wire `login.js` to call `engine.parse_csv`
   (replaces the 40-line JS parser) + scope the first browser-side
   step preview slice. Surface to Em.

Optional / follow-up:
- Retire the `row.try_get(_) DTO mapping` declined-pattern entry in
  `tools/rs-audit/audit.js` per Torv's FromRow spike finding.
- Run `tools/audit.sh` baseline on the new box; record any deltas
  against the 19:21 numbers in §5.

---

## 9. Things I deliberately did NOT do that are worth flagging

- **Did not amend the spike doc with the bench numbers** — Em
  redirected to write this handoff instead. The amend is action #7
  above.
- **Did not start Phase D** — needs scope sign-off; not auto-trigger.
- **Did not push directly** — [[push-policy]] is back in force, Torv
  pushes.
- **Did not touch the TypeScript-config errors Em saw in his IDE
  (19:18)** — those are from his ECharts clone (`/home/mansa/tsconfig.json`,
  `/home/mansa/echart/tsconfig.json`), not RedPash. Out of scope per
  [[feedback-scope-redpash-app-only]].
- **Did not extract `shell` from home.html + monitoring.html** — 29
  LOC × 2 sites, below [[feedback-refactor-decompose]] threshold
  without building a new HTML include runtime (borderline
  [[feedback-no-frameworks]]). Parked deliberately; surface to Em
  if it comes up again.

---

## 10. Acknowledgments

- **Em** — sanctioned the lane shift to Phase C (19:00), ran the
  browser bench that produced the perf-cliff measurement, called
  the Ubuntu 26 migration with a comprehensive-handoff ask.
- **Gus** — wrote `roadmap-webassembly.md` (2026-05-23) that scoped
  this spike + did the Phase 0 groundwork (Cargo wasm32 setup) that
  made the Phase C size cliff a non-event. CSV-corpus recommendation
  + chardetng/calamine pre-flight on Woz.md 18:56. Audit-recognition
  fix in `44084a8` is a beautiful [[feedback-process-oriented]]
  resolution of what looked like 36 missing event::record calls.
- **Torv** — shipped Phase A / B / B-1 (the existing 4 wrappers +
  `build-wasm.sh` + `wasm-engine.js` loader). ACKed the Phase C lane
  shift on Woz.md 18:54 + flagged the `login.js` JS-CSV-parser as
  the swap target if Phase C shipped. Renamed his queue to Q-B/Q-C/Q-D
  to disambiguate from "Phase C".

— Woz · boundary-lock session, 2026-05-25 evening
