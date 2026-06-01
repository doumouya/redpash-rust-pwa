# Gemini adversarial suite #1B — divergence analysis

**Run:** 2026-06-01T02:09 UTC
**Endpoint:** `POST /api/demo/parse` (same as Suite #1)
**Suite:** 20 fresh CSV payloads (different from Suite #1's 20)
**Raw output:** `gemini-suite-1b-raw.md`

## Why this is "1B" not "2"

Gemini was supposed to get `gemini-prompt-codec.md` (Avro decoder targeting `/api/demo/avro-decode`). Instead he returned **another round of CSV cases** against `/api/demo/parse`. Likely either:

- Wrong prompt pasted
- Gemini's chat context held the CSV framing from Suite #1's earlier session
- Gemini misread the codec prompt and defaulted to "more of the same"

Either way, **20 fresh CSV cases is more coverage** — half overlap with Suite #1's categories with different inputs, half are genuinely new edges. Suite #2 (codec) still queued — re-paste `gemini-prompt-codec.md` into a fresh Gemini chat to get it.

## Headline

**20/20 returned HTTP 200** (or expected 400/413). Parser is robust. **4 findings confirm Suite #1's bugs, 2 sharpen them, 3 reveal new behaviors.**

## Confirmations of Suite #1 findings (the parser hardening case CAS_BFF77F18 grows)

| # | Maps to Suite #1 | Same shape? |
|---|------------------|-------------|
| 1B-1 | Suite #1 HIGH-2 (unclosed quote) | ✓ rows=3 (lost one row), score=100 — silent data loss + lying score |
| 1B-2 | Suite #1 HIGH-4 (invalid UTF-8) | ✓ Literal `ÿþ` bytes + ASCII → rows=2 score=100, silently accepted as mojibake |
| 1B-5 | Suite #1 HIGH-2 amplified | ✓ Unclosed quote + nested quotes → rows=2 (lost 2 rows), score=100 — **worse than Suite #1 Case 2** |
| 1B-6 | Suite #1 HIGH-3 (delimiter detection) | ✓ Three candidate delimiters → picked `,`, cols=2 (wrong), score=95.6 |
| 1B-8 | Suite #1 LOW-6 (duplicate header score) | ✓ Duplicate id + 2 empty headers → score=86, no flag |
| 1B-12 | Suite #1 HIGH-3 amplified | EU `1.234,56` split into 2 columns by `,` → cols=3, score=89 (still close-to-clean for broken data) |

## Sharpenings — Suite #1's findings now have more precision

### Sharpening 1: Line endings — only **bare CR** is the killer

| Suite | Input | Result |
|-------|-------|--------|
| Suite #1 Case 1 | `\r\n` + `\n` + bare `\r3,C` (CR-only line) | rows=0 score=0 — **dropped all data** |
| Suite #1B Case 4 | `\r\n` + `\n` only (no bare CR) | rows=4 score=100 — **parses fine** |

The fix is narrower than HIGH-1 originally suggested: **bare CR is the bug, CRLF + LF mix is fine**. Gemini's normalize-`\r`-to-`\n` recommendation still handles both correctly, but the regression baseline can be tightened.

### Sharpening 2: Smart quotes are NOT unclosed quotes

Case 1B-3 has smart quotes (Unicode `"..."`) which look unclosed in row 3 (`Bad,"unclosed smart quote`). **Parser correctly ignored them as data** — rows=4 score=100 is RIGHT, not a bug. The "ASCII `"`" parser doesn't trip on `\u{201C}` / `\u{201D}` smart quotes; they're just multi-byte UTF-8 content. Useful clarification.

## New behaviors discovered (not in Suite #1)

### ✓ NEW WIN: Unicode in HEADERS works cleanly
Case 1B-17 — emoji + RTL Arabic + ZWJ + combining chars in **column names** — returned `rows=3 cols=4 score=100`. Suite #1 only proved Unicode handling in data; this confirms headers too. **No bug, real coverage win.**

### ⚠ NEW EDGE: Blank trailing lines count as empty rows
Case 1B-18 (header + 4 blank lines) → `rows=4 cols=3 empty_pct=100`. Parser treats each `\n\n` as an empty data row. Reasonable but worth knowing — a file ending in `\n\n\n\n` will have spurious "rows" with empty_pct=100. Score=53.75 catches it via empty_pct, so the score response is honest.

### ✓ NEW WIN: 100-column wide row
Case 1B-15 (programmatic 100 cols × 1 row) → `rows=1 cols=100 score=100 parse_ms=15`. Throughput on wide rows is fine — no quadratic behavior in column-count.

## Updated parser-hardening priority for CAS_BFF77F18

| Priority | Finding | New evidence from 1B |
|----------|---------|----------------------|
| **HIGH-2 (unclosed quote)** | Bumped to **HIGHEST** — Case 1B-5 lost 2 rows silently with score=100. Worst-case silent failure scale grows linearly with how many rows the quote eats. Fix matters most. |
| HIGH-3 (delimiter) | Confirmed across more delimiter combos (`;|,` mix Case 6, EU decimals Case 12). |
| HIGH-1 (line endings) | **Scope tightened** — only bare CR breaks; CRLF+LF is fine. Fix is still the right one (normalize all) but regression test is narrower. |
| HIGH-4 (invalid UTF-8) | Confirmed — both raw Latin-1 bytes (Suite #1 Case 12) and literal `ÿþ` (Case 1B-2) silently accepted with score=100. |
| LOW-6 (duplicate header score) | Confirmed (Case 1B-8). |

## Sequencing

Adding Suite #1B's findings to **CAS_BFF77F18** as confirming evidence + scope refinements. No new high-priority items beyond what Suite #1 already filed. Regression baseline grows to 40 cases (Suite #1 + Suite #1B) — re-running both confirms the verdict flip when BE's fixes land.

**Next: Suite #2 codec endpoint** — re-paste `gemini-prompt-codec.md` (not `gemini-prompt.md`) into a fresh Gemini chat. Look for the line *"This is Suite #2 of the [[gemini-adversary]] loop"* near the top — confirms the right prompt loaded.
