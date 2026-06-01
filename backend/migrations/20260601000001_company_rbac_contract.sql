-- RBAC permission contract (CAS_0DE2DDEF) — step 1: STORAGE ONLY, wired to nothing.
-- ──────────────────────────────────────────────────────────────────────────
-- Em's reframe: RBAC becomes one declarative, per-company, VERSIONED JSONB
-- contract that the single evaluator (resolve_grant) reads — the same
-- registry/validator shape already used for codecs/Avro/TypeDefinition.
--
-- The contract is the POLICY (the tier ladder is a framework default; this
-- stores the per-(team, object-TYPE) action grants + the company_owner/admins +
-- a DISPLAY-ONLY label map). The `memberships` graph stays the instances. The
-- engine branches on the TIER only — `context_role` and team/department NAMES
-- are free-text the framework ignores, so nothing here is keyed on a name:
-- `company_id`, the grant keys (team PK), and the object TYPE are the anchors.
--
-- Append-only + versioned: the active contract is max(version) per company;
-- every change is a new row → provable, rollback-able audit (the legal-stakes
-- answer). This migration adds the table only; the evaluator does NOT consult
-- it yet (step 2), so behaviour is unchanged (non-breaking).
CREATE TABLE company_rbac (
    company_id  TEXT        NOT NULL REFERENCES companies(redpash_id) ON DELETE CASCADE,
    version     INTEGER     NOT NULL,
    contract    JSONB       NOT NULL,
    created_by  TEXT        REFERENCES users(redpash_id),  -- who registered it (NULL = system/seed)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, version)
);

-- The active contract per company is the highest version — index the lookup.
CREATE INDEX company_rbac_active ON company_rbac (company_id, version DESC);
