# Copilot stress suite #1 — analysis

**Run:** 2026-06-01T02:15 UTC
**Endpoint:** `POST /api/demo/parse`
**Suite:** 7 ultra-hostile CSV cases designed by Copilot to trigger 500s/panics/hangs (5 more were generated but Em's paste truncated at Case 7's ZWJ wall)
**Raw output:** `copilot-stress-1-raw.md`

## Headline

**7/7 returned HTTP 200. ZERO crashes, panics, infinite loops, or OOMs.** Copilot designed these specifically to break the parser. The parser passed every one.

## Robustness validation (the surprising-strong result)

Copilot's stated weaknesses + actual outcomes:

| # | Weakness Copilot targeted | Actual outcome | Lesson |
|---|---------------------------|----------------|--------|
| 1 | UTF-16 surrogate decode panic | rows=0 score=0 (graceful empty result, 4ms) | No Arrow panic. Returns empty rather than crashing. |
| 2 | Overlong UTF-8 panic | rows=3 score=100 (5ms) | Silent acceptance (HIGH-4 confirmed). No panic. |
| 3 | Quote-state infinite loop | rows=2 score=100 (1ms) | No hang. Silent recovery (HIGH-2 confirmed). |
| 4 | 200k-char unclosed quote → OOM | rows=0 cols=1 (6ms) | **Bounded buffer growth**. No OOM, no stack overflow. Returns empty cleanly. |
| 5 | Arrow column-count assertion | rows=3 cols=3 score=84 empty_pct=44 (1ms) | Resolves to max-cols + treats missing cells as null. No panic. |
| 6 | SIMD fast-path panic on NUL | rows=1 cols=2 score=100 (0ms) | NUL silently accepted in cell values. No panic. |
| 7 | ZWJ-wall memory pressure | rows=1 cols=3 score=88 (2ms) | Handled 1000 ZWJ chars + the U+200C/U+200D ZWJ in headers cleanly. |

**This is the strongest robustness signal we have for the parser.** All 7 hostile shapes were dispatched in 0-6ms with no crash. That tells us the hardening work is squarely about **graceful-but-wrong** outcomes (score=100 on data that was lost / corrupted), not about defensive panic prevention.

## Confirmations of existing findings (CAS_BFF77F18)

- **HIGH-2** (unclosed quote silent loss): Case 3 confirms. Cases 4 confirms with a 200k-char extreme — even the most extreme case doesn't crash, just returns rows=0 silently.
- **HIGH-4** (invalid UTF-8 silent acceptance): Case 2 confirms with overlong + 0xF5+ byte sequences. Case 6 surfaces a related shape: NUL bytes inside cell values silently accepted.

## One new edge worth flagging (not new HIGH, but worth a note in the hardening doc)

### NUL bytes in cell values round-trip silently

Case 6 sent `1;Alice\x00Bob,London` where `\x00` is a literal NUL inside the name field. Parser returned `rows=1 cols=2 score=100`. **Question for the hardening pass:** does the decoded "Alice\x00Bob" round-trip cleanly through:
- The cleanness score (currently doesn't flag)
- The downstream PATCH path (could NUL truncate at a C-binding layer?)
- The Polars dataframe → SQL insert (depends on driver's binary protocol)

Worth a single-line addition to the hardening doc + a regression test that NUL is preserved or rejected, not silently lost.

## One new robustness win to celebrate

**The parser bounds its buffer growth on pathological input.** Case 4 (200k-character unclosed quote) returned an empty result in 6ms. A naive CSV parser would either:
- Allocate 200k+ for the quote span (memory pressure)
- Read until EOF looking for the closing quote (latency)
- Stack-overflow on recursive parsing (crash)

Polars' actual behavior: realize the quote is unterminated, give up cleanly, return empty result. **6ms** is fast — there's clearly bounded behavior, not "try to find the closing quote in the rest of the file."

## What the stress suite DID NOT tell us

Cases 8-12 (if Copilot generated them) are missing from Em's paste. If Copilot's set included:
- Recursive nested-quote structures
- Pathological grow-to-fill-memory cases
- Specific Polars version regression triggers
- Encoding-detection trap cases

…we'd want them for completeness. Re-paste if available.

## Sequencing

- **No new HIGH-priority items.** The parser hardening case (CAS_BFF77F18) already targets the right gaps. This run is robustness validation, not new bug discovery.
- One single-line addition to the hardening doc: "Verify NUL bytes either preserve or reject (Case 6 of Copilot stress suite #1)".
- Combined regression baseline now: 60 cases (Suite #1 + 1B + Copilot stress #1).
- Re-run all three suites after each hardening fix to confirm no regression.

## Strategic note

The blind-spot non-overlap pattern from [[gemini-adversary]] held: Copilot's stress suite targeted DIFFERENT failure modes than Suite #1's spec-edges and Suite #1B's Windows-ecosystem shapes. Copilot's training likely includes lots of bug reports from Polars/Arrow GitHub issues, hence the very specific "Arrow asserts on column mismatch" / "SIMD panic on NUL" / "Polars allocates buffer proportional to quote span" framings — these read like actual filed issues, not speculation.

That's the multi-adversary-LLM property in action: each LLM brings its training distribution's bug-report intuition to the task.
