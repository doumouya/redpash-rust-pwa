---
title: Audit cadence
section: Internal
order: 51
last modified date: 2026-05-24
owner: Torv
status: stub
---

# Audit cadence

> **TODO (Torv).** Formalise the existing practice into a written rule.

The current practice (live since 2026-05-21):

1. `sh tools/audit.sh` runs the five audits (js, rs, css, html, crossing) before every commit
2. Findings ingested into `audit.run` + `audit.finding` (the audit-storage subsystem)
3. New findings trigger a small, immediate cleanup — *not* a deferred big-bang pass
4. Trend reading: `audit.run_diff()` SQL surfaces drift between runs

To cover:

- The five audits and what each catches
- The "small + frequent beats big + rare" rule (`[[feedback_cleaning_cadence]]`)
- The merge gate: `audit.sh` clean → push allowed
- When to add a new audit tool (the trigger: a class of bug the existing suite missed)
- The audit-storage subsystem reference for the trend-reading side
