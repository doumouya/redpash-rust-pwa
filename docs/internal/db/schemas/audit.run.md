# `audit.run`

## Schema

<!-- doc-gen:schema:run START — generated from the live DB; do not hand-edit -->
**Table `audit.run`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `id` | bigint | NO | `nextval('audit.run_id_seq'::regclass)` |
| 2 | `tool` | text | NO |  |
| 3 | `ran_at` | timestamp with time zone | NO | `now()` |
| 4 | `git_sha` | text | YES |  |
| 5 | `git_branch` | text | YES |  |
| 6 | `stats` | jsonb | NO |  |
| 7 | `payload` | jsonb | NO |  |

- **Primary key:** `PRIMARY KEY (id)`
- **Checks:**
    - `run_tool_check` — CHECK ((tool = ANY (ARRAY['css'::text, 'html'::text, 'parallel'::text, 'tab-compare'::text, 'cross-page'::text, 'ui-snapshot'::text, 'api-doc'::text])))
- **Unique:**
    - `run_tool_git_sha_ran_at_key` — UNIQUE (tool, git_sha, ran_at)
- **Indexes:**
    - `CREATE INDEX audit_run_tool_time_idx ON audit.run USING btree (tool, ran_at DESC)`
    - `CREATE UNIQUE INDEX run_pkey ON audit.run USING btree (id)`
    - `CREATE UNIQUE INDEX run_tool_git_sha_ran_at_key ON audit.run USING btree (tool, git_sha, ran_at)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:run END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
