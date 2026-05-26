-- ──────────── relax audit.run.tool CHECK to the broader audit family ─────
-- Mig 028 originally pinned `audit.run.tool` to ('css', 'html') — the two
-- audits that existed when the table landed. The audit family has since
-- grown: css-parallel emits `parallels.json`, css-tab-compare-audit emits
-- `audit.json` keyed on a different finding shape, css-cross-page-audit
-- joined later, and the Path-B UX/UI automation lane adds `ui-snapshot`
-- as a tracked audit too (computed-style snapshots of `.rt-*` atoms per
-- route, treated as findings so atom@route@prop drift surfaces through
-- the same audit.run_diff machinery as the existing tools).
--
-- The CHECK needs to accept all four. Doing this as a single mig now
-- (including `ui-snapshot` pre-emptively) so we don't migrate twice
-- when the Path-B Layer 2 ui-snapshot work lands — its finding shape
-- is still being designed but the tool name is locked.
--
-- The constraint is dropped + re-added (Postgres has no in-place
-- "modify CHECK predicate" — DROP + ADD is the canonical pattern).
-- Postgres auto-names CHECK constraints; the existing one is
-- `run_tool_check` per the default naming rule (table.column → check).
--
-- Idempotent: IF EXISTS on the drop + plain ADD (a re-run would have
-- the new constraint already in place, ADD CONSTRAINT would error if
-- the named constraint exists — so we DROP the new name too defensively
-- before re-adding).
--
-- Coordinated with the Path-B UX/UI automation lane proposal — Woz's
-- Asking-for on Gus.md 2026-05-26 21:22; Em greenlit Layer 1a at the
-- same date.

ALTER TABLE audit.run
    DROP CONSTRAINT IF EXISTS run_tool_check;

ALTER TABLE audit.run
    DROP CONSTRAINT IF EXISTS audit_run_tool_check;

ALTER TABLE audit.run
    ADD CONSTRAINT audit_run_tool_check
    CHECK (tool IN (
        'css',
        'html',
        'parallel',
        'tab-compare',
        'cross-page',
        'ui-snapshot'
    ));
