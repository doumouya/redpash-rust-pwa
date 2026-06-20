-- case_docs_reconciled — the docs-currency close-gate's data source (CAS_406BD7D387C14BEA973F513FE1BEBAA8).
--
-- WHY: a Case may not reach its terminal close (`done` internal / `Closed` external)
-- until its change is reconciled into the docs (CLAUDE.md "Docs stay current"). The
-- cases backend has NO per-request git, so the git-derived fact — "a commit referencing
-- CAS_<id> touched docs/, or declared the change doc-neutral with a `Docs:` trailer" — is
-- precomputed OFF-request by the `redpash-commit-ingest` bin (run best-effort by the
-- pre-push hook) and recorded here. The PATCH close guard reads it with one `SELECT
-- EXISTS`; an empty result is a `422 docs_not_reconciled`.
--
-- FRESHNESS (cases.docs_gate_floor): reconciliation is NOT lifetime-permanent. The gate
-- requires a reconciliation whose `commit_at` is NEWER than the case's last close (the
-- floor, set to now() each time the case enters a terminal). So a reopen → rework →
-- reclose cycle must reconcile its OWN docs; a prior cycle's row (commit_at < floor) is
-- stale and does not satisfy the new close. (Without this, reopen+undocumented-rework
-- +reclose would pass on the first cycle's row — adversarial-review bypass-HIGH. A plain
-- delete-on-reopen can't fix it: the full-range ingest would re-create the old row.)
--
-- CO-REFERENCE (accepted): the docs signal is PER-COMMIT, not per-case — a commit's
-- docs-touch / `Docs:` ack reconciles EVERY case it references. A shared docs change
-- legitimately serves several cases; co-referencing an unrelated case piggybacks, which
-- is the same trust model as the `CAS_` ref itself (you could fake either).
--
-- NOT an entity, and deliberately NOT FK'd to `cases`: the ingest reads git, which can
-- carry a stale or foreign `CAS_` ref — a bad ref must log, not abort. Same posture as
-- the observability tables. The gate only ever queries a real, in-flight case_rid.
CREATE TABLE case_docs_reconciled (
    case_rid     text NOT NULL,            -- UPPERCASE CAS_<32hex>, normalized by the ingest
    commit_sha   text NOT NULL,
    touched_docs boolean NOT NULL DEFAULT false,
    docs_ack     boolean NOT NULL DEFAULT false,
    commit_at    timestamptz NOT NULL,     -- the commit's date; must exceed the case floor
    ingested_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (case_rid, commit_sha)
);

-- The gate's only lookup: every reconciliation row for one case.
CREATE INDEX case_docs_reconciled_case_idx ON case_docs_reconciled (case_rid);

-- The per-case close-floor: now() at each terminal entry; the gate requires a
-- reconciliation commit dated after it. NULL ⇒ never closed ⇒ any qualifying row works.
ALTER TABLE cases ADD COLUMN docs_gate_floor timestamptz;
