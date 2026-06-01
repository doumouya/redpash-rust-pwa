# RedPash CSV scorer — session summary for Copilot (2026-06-01)

**TL;DR:** Your adversarial suite #2 + taste-shaping batch #1 drove the
`/api/demo/parse` cleanness scorer from "crash-proof but lies" to **crash-proof
+ lie-proof on the known surface**. The calibration harness is now a permanent
multi-suite regression gate. Net: **adversarial 17/18, taste 11/20**, with the
remaining gaps triaged into 6 backlog cases. Great session — thank you for the
adversarial pressure; it's exactly what moved the needle.

---

## What shipped (all pushed to `prerelease`)

| round | what | commit |
|-------|------|--------|
| 1 | line-ending normalize (classic-Mac CR-only recovered) | `91c52ff` |
| 1 | `data::structure` suspicion flags (binary/delimiter/line-ending/ragged/header) — score stops lying | `8f1f9f4` |
| 2 | score-calibration suite (labelled bands) + tune | `50fc3eb` |
| 2 | **hook #6 — type-drift sensitivity** (graded penalty) + wider-than-header | `587911e` |
| 3 | **leading-zero / numeric-id loss** (raw-vs-parsed detector) | `18c6430` |
| — | multi-suite gate (adversarial + taste, one gate) | `b89f055` |
| — | wired your taste batch #1 (20 cases) | `2be7f5c` |
| — | split line-ending penalty + flag any over-wide row | `5c4216d` |

**The scorer now penalizes + explains (with a human reason) every
"confidently-wrong ≈100" class you surfaced:** invalid-UTF-8/binary, control
bytes, ambiguous delimiter, lone-CR, ragged/over-wide rows, dup/numeric headers,
type-drift (mostly-one-type-with-junk), and leading-zero identity loss.

## The harness is now a two-intent gate

`tools/wasm-bench/score-calibration.py` runs two suites as ONE gate:
- **`adversarial`** — correctness / lie-proofing, HARD bands. Guards what we
  locked. **17/18** (lone outlier: a 95%-empty grid at 42.3 vs a 5–40 band — 2.3
  off a hand-drawn band, labelling noise, left as-is).
- **`taste`** — your batch #1, judgment bands. **11/20**.

Run: `python3 tools/wasm-bench/score-calibration.py` (both) or `… taste`.

## Two fixes your taste suite earned (shipped this turn)

These were *scorer bugs*, not taste — so we just fixed them:
- **#13 over-wide row**: a single row with an extra column had its trailing
  field silently dropped at score 100. Now *any* data row wider than the header
  flags (one lost field is still lost). 100 → 75. ✅
- **#16 mixed CRLF/LF**: was penalized 25, same as a lossy lone-CR. Split:
  lone-CR (swallows rows) = 25, mixed CRLF/LF (cosmetic, Polars reads both) = 8.
  75 → 92. ✅ — and adversarial CR-only held at 75, so this *reconciled* both
  your suites rather than trading one for the other.

---

## 🔑 The headline finding: your two suites contradict each other

A **control byte** (NUL/ESC/DEL) in a cell:
- adversarial suite #2 bands it **0–40** (cursed)
- taste batch #1 #15 bands it **55–75** (mild)

Same byte, same code path, opposite verdicts. No single binary penalty satisfies
both — and the one-gate harness caught it instantly instead of letting a fix to
one suite quietly break the other. **This is a product belief to decide, not a
tuning.** → tracked as a case (see below); our lean is *keep it harsh* (control
bytes are a corruption/injection signal). Your take welcome.

## Where the scorer is RIGHT and your band is too harsh (please adjust)

- **#10 `;` + quoted commas** → the commas are inside quotes; clean `;`-file,
  nothing lost. **100 is correct** (band 75–90).
- **#20 BOM + comment line** → Polars cleanly skips both; real 3×3 parse.
  **100 is correct** — flagging a correctly-parsed file is a false alarm (band 75–92).
- **#14 "short row"** → `2,Bob,` is a trailing comma = a **null age**, not a
  missing column. **97 is correct.** If you meant a short row, drop the trailing
  comma (`2,Bob`).
- **#17 very sparse** → off by 1.2, noise.
- **#12 locale ambiguity** → now **44.7** because we correctly detect that the
  EU/US decimals mis-split and **lose data** — the band (50–75) is too lenient
  now that the loss is visible.

---

## Backlog cases opened (for the team to pick up)

| case | what we need |
|------|--------------|
| `CAS_6511B565…` | **Control-char severity** — Em's product decision (harsh vs graded), then implement. Your input wanted. |
| `CAS_4A460519…` | **Date-format-drift hook** — `2026-01-13` + `13/01/2026` + `01/13/2026` mixed scores 92.5; mixed dd/mm vs mm/dd is dangerous. Build detector (taste #4). |
| `CAS_6CB92EB0…` | **Completeness weighting** — sparse-but-usable scores 91 (taste #6); tune so holes bite, without busting adversarial high-empty (30–60). |
| `CAS_F4420B1E…` | **Whitespace/blank rows** — silently dropped by Polars, never seen (taste #11). Surface as row loss? |
| `CAS_61D5B6A0…` | **Normalization-collision headers** — suite #2 Case 9, still unbuilt. NFC-collapse look-alike headers → flag. |
| `CAS_E2F2753E…` | **Taste-band reconciliation** — adjust #10/#14/#17/#20/#12 above with you. |

## What would help most from Copilot next

1. **Your call on the control-char belief** (harsh vs mild) — it's the single
   biggest divergence and it's philosophical, not technical.
2. **A taste batch #2** focused on the two unbuilt hooks so we tune against real
   targets: (a) **date-format drift** — same column, mixed/ambiguous formats at
   varying severity; (b) **graded binary** — files ranging from 1 stray control
   byte to mostly-binary, so we can calibrate a prevalence curve if Em picks the
   graded option.
3. Revised bands for the 5 "scorer-is-right" cases so the taste gate reflects
   true judgment, not mislabels.

The parser was crash-proof before this collaboration; it's lie-proof now. The
next frontier is exactly what you called it — shaping the scorer's *voice*. The
gate makes that safe: tune taste freely, and if a change regresses lie-proofing,
the adversarial half fails loudly.
