-- ──────────── audit storage — dev-meta, NOT app data ────────────
-- Persists the output of tools/css-audit + tools/html-audit runs so
-- codebase health is trackable over time (trend lines + per-finding
-- new/fixed/regressed diffs). These tables are dev-tooling metadata —
-- they are never read or written by the application request path.
--
-- Design + rationale: tools/audit-storage-brainstorming.md
--
-- Idempotent (IF NOT EXISTS throughout) so a manual psql apply and the
-- later sqlx::migrate! pass at backend boot don't collide.

CREATE SCHEMA IF NOT EXISTS audit;

-- One row per `node audit-bro.js` execution. `payload` holds the full
-- report `data` object — source of truth, survives audit-output shape
-- changes, and lets any historical run be re-rendered. `stats` is
-- duplicated out as a top-level column purely so trend queries don't
-- reach into a large JSONB on every read.
CREATE TABLE IF NOT EXISTS audit.run (
    id          BIGSERIAL    PRIMARY KEY,
    tool        TEXT         NOT NULL CHECK (tool IN ('css', 'html')),
    ran_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    git_sha     TEXT,
    git_branch  TEXT,
    stats       JSONB        NOT NULL,
    payload     JSONB        NOT NULL,
    -- cheap dedupe guard; git_sha NULLs are distinct in Postgres so this
    -- never blocks a run, it just catches an accidental double-insert.
    UNIQUE (tool, git_sha, ran_at)
);
CREATE INDEX IF NOT EXISTS audit_run_tool_time_idx
    ON audit.run (tool, ran_at DESC);

-- One row per individual finding (selector conflict / class divergence /
-- component candidate), exploded from audit.run.payload at ingest time.
-- `finding_key` is the STABLE identity across runs — that is what makes
-- the new/fixed/regressed diff queries a plain join. A derived
-- projection: if the explode logic changes, re-explode from payload.
CREATE TABLE IF NOT EXISTS audit.finding (
    run_id       BIGINT  NOT NULL REFERENCES audit.run(id) ON DELETE CASCADE,
    tool         TEXT    NOT NULL,
    kind         TEXT    NOT NULL,   -- selector_conflict | class_divergence | component_candidate
    finding_key  TEXT    NOT NULL,
    severity     INTEGER,            -- conflictCount / divergentCount / saved
    detail       JSONB   NOT NULL,
    PRIMARY KEY (run_id, finding_key)
);
CREATE INDEX IF NOT EXISTS audit_finding_key_idx
    ON audit.finding (tool, kind, finding_key);
