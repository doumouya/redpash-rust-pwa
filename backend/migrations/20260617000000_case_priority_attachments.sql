-- Cases: priority + attachments — the Phase B/C backend support.

-- priority: the MCP `case_create` sends it (default 'medium') and the kanban card wants a
-- priority dot, but the cases table had no such column. The enum MATCHES the MCP contract
-- (low/medium/high/critical) — the planning doc's "urgent" was a divergence.
ALTER TABLE cases ADD COLUMN priority text NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'critical'));
CREATE INDEX cases_priority_idx ON cases (priority);

-- case_attachments: METADATA ONLY. It mirrors project_files' STORAGE posture (immutable raw
-- bytes on server disk + a row of metadata) but NOT its entity identity: an attachment is not
-- independently shareable, so it is NOT a registered `entity` — its RBAC derives from the
-- parent case (View → read, Edit → add/remove), the same way project_steps are not entities.
-- The "no customer data in Postgres" invariant holds BY CONSTRUCTION: there is no bytes/content
-- column here. The bytes live at storage_path on the server disk (the durable share + recovery
-- source, exactly as CSVs), and the client caches a GlueSQL working copy for fast/offline view.
CREATE TABLE case_attachments (
    redpash_id   text PRIMARY KEY,                       -- ATT_<32-hex> (bare id, NOT an entity)
    case_id      text NOT NULL REFERENCES cases(redpash_id) ON DELETE CASCADE,
    comment_id   text REFERENCES case_comments(id) ON DELETE SET NULL,
    filename     text NOT NULL,
    mime         text NOT NULL DEFAULT 'application/octet-stream',
    size_bytes   bigint NOT NULL,
    storage_path text NOT NULL,                          -- relative: attachments/<ATT_rid>.bin
    uploaded_by  text REFERENCES users(redpash_id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_attachments_case_idx ON case_attachments (case_id);

-- Keep the curated `case` field catalog truthful: priority becomes a browsable, readonly
-- registry field (the read-only registry view auto-derives real columns; the seed gives it a
-- label + order + the option vocabulary). Ordinal 35 places it right after `type` (30).
INSERT INTO type_fields (type_id, field, label, ordinal, data_type, perm_class, options) VALUES
    ('case', 'priority', 'Priority', 35, 'string', 'readonly', '["low","medium","high","critical"]');
