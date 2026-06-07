# `audit.finding`

## Schema

<!-- doc-gen:schema:finding START — generated from the live DB; do not hand-edit -->
**Table `audit.finding`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `run_id` | bigint | NO |  |
| 2 | `tool` | text | NO |  |
| 3 | `kind` | text | NO |  |
| 4 | `finding_key` | text | NO |  |
| 5 | `severity` | integer | YES |  |
| 6 | `detail` | jsonb | NO |  |

- **Primary key:** `PRIMARY KEY (run_id, finding_key)`
- **Foreign keys:**
    - `finding_run_id_fkey` — FOREIGN KEY (run_id) REFERENCES audit.run(id) ON DELETE CASCADE
- **Indexes:**
    - `CREATE INDEX audit_finding_key_idx ON audit.finding USING btree (tool, kind, finding_key)`
    - `CREATE UNIQUE INDEX finding_pkey ON audit.finding USING btree (run_id, finding_key)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:finding END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
