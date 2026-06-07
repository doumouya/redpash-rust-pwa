# `public.optimization_points`

## Schema

<!-- doc-gen:schema:optimization_points START — generated from the live DB; do not hand-edit -->
**Table `public.optimization_points`** — generated 2026-06-07 from the live schema (applied migrations).

| # | column | type | null | default |
|---|--------|------|------|---------|
| 1 | `id` | bigint | NO | `nextval('optimization_points_id_seq'::regclass)` |
| 2 | `subsystem` | text | NO |  |
| 3 | `phase` | text | NO |  |
| 4 | `current_cost` | text | NO |  |
| 5 | `horizon` | text | NO |  |
| 6 | `status` | text | NO | `'open'::text` |
| 7 | `measurement_kind` | text | YES |  |
| 8 | `measurement_key` | text | YES |  |
| 9 | `threshold_value` | double precision | YES |  |
| 10 | `threshold_unit` | text | YES |  |
| 11 | `notes` | text | YES |  |
| 12 | `created_at` | timestamp with time zone | NO | `now()` |
| 13 | `updated_at` | timestamp with time zone | NO | `now()` |

- **Primary key:** `PRIMARY KEY (id)`
- **Checks:**
    - `optimization_points_status_check` — CHECK ((status = ANY (ARRAY['open'::text, 'planned'::text, 'done'::text, 'wontfix'::text])))
- **Unique:**
    - `optimization_points_subsystem_phase_key` — UNIQUE (subsystem, phase)
- **Indexes:**
    - `CREATE UNIQUE INDEX optimization_points_pkey ON public.optimization_points USING btree (id)`
    - `CREATE INDEX optimization_points_status_idx ON public.optimization_points USING btree (status)`
    - `CREATE INDEX optimization_points_subsystem_idx ON public.optimization_points USING btree (subsystem)`
    - `CREATE UNIQUE INDEX optimization_points_subsystem_phase_key ON public.optimization_points USING btree (subsystem, phase)`
- **Triggers:** _(none)_
<!-- doc-gen:schema:optimization_points END -->

## Notes (human — why / how-it-works / business-logic)

_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._
