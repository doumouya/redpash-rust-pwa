-- ============================================================================
-- data_class — the PII / sensitivity dimension on type_fields, ORTHOGONAL to
-- perm_class. perm_class answers "WHO may edit this field"; data_class answers
-- "IS this personal data" (GDPR Art. 4). The two don't correlate — `email` is
-- perm_class 'standard' yet personal; `company.name` is 'standard' yet none —
-- so sensitivity earns its own column ("a dimension is a column, derive the
-- rest"). Consumers (log redaction, /api/me export scoping, erasure-by-class)
-- key off it; this migration stores only the INPUT. Closes privacy finding F-G
-- (docs/privacy/assessment-2026-06-16.md); surfaced verbatim on /api/types.
--
-- Scope: only CATALOGED fields (type_fields rows) carry data_class. Derived
-- display columns surfaced via registry_display_fields (e.g. users.avatar_url)
-- have no type_fields row; users.google_sub is already denylisted in
-- objects::HIDDEN_COLUMNS (never browsed). Classifying derived columns is a
-- follow-up, tracked against F-G.
-- ============================================================================

ALTER TABLE type_fields
    ADD COLUMN data_class text NOT NULL DEFAULT 'none'
        CHECK (data_class IN ('none', 'personal', 'sensitive'));

-- Tag the cataloged personal-data fields. User identity fields are the user's
-- own personal data; free-text case title/description routinely carry third-
-- party PII. (assignee_id/reporter_id are user-id references, not PII in
-- themselves → left 'none'.)
UPDATE type_fields SET data_class = 'personal'
WHERE (type_id, field) IN (
    ('user', 'email'),
    ('user', 'display_name'),
    ('user', 'username'),
    ('case', 'title'),
    ('case', 'description')
);
