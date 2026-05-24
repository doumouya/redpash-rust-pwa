-- ──────────── 025 optimization_points — the optimization-map table ────────────
-- The doc-side "Optimization map" tables in each subsystem doc
-- (commit f690550) become a first-class table that the /monitoring
-- page renders live. Each row pairs a known optimization opportunity
-- with the metadata to compute its current measured value against the
-- horizon threshold.
--
-- Spec: docs/internal/specs/optimization-map.md.
--
-- v1 is read-only: rows seeded here, status changes via direct psql
-- UPDATE until an admin UI ships. The PATCH endpoint is deferred per
-- spec §7.
--
-- Idempotent (IF NOT EXISTS + ON CONFLICT DO NOTHING).

CREATE TABLE IF NOT EXISTS optimization_points (
    id                BIGSERIAL    PRIMARY KEY,
    subsystem         TEXT         NOT NULL,
    phase             TEXT         NOT NULL,
    current_cost      TEXT         NOT NULL,
    horizon           TEXT         NOT NULL,
    status            TEXT         NOT NULL DEFAULT 'open'
                                  CHECK (status IN ('open', 'planned', 'done', 'wontfix')),
    measurement_kind  TEXT,
    measurement_key   TEXT,
    threshold_value   DOUBLE PRECISION,
    threshold_unit    TEXT,
    notes             TEXT,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (subsystem, phase)
);

CREATE INDEX IF NOT EXISTS optimization_points_subsystem_idx
    ON optimization_points (subsystem);
CREATE INDEX IF NOT EXISTS optimization_points_status_idx
    ON optimization_points (status);

-- ──────────── seed ────────────
-- Each row is one optimization-map entry from the 8 subsystem deep-
-- dives. ON CONFLICT DO NOTHING keeps the seed re-runnable: status
-- changes survive a re-apply.

INSERT INTO optimization_points
  (subsystem, phase, current_cost, horizon, measurement_kind, measurement_key, threshold_value, threshold_unit, notes)
VALUES
  -- ── api-routes ──
  ('api-routes', 'resolve_user_rid per authed call',
   '~1ms DB lookup per authed call',
   'in-memory session cache when sustained traffic exceeds ~50 req/s',
   'route_count_24h', 'GET /me', 4320000, 'requests_24h',
   '50 req/s × 86400s ≈ 4.32M; the cache pays off above this.'),

  ('api-routes', 'ensure_owner per resource access',
   '~1ms ownership query per resource hit',
   'fold into the resource hydrate to save the extra trip',
   'none', NULL, NULL, NULL,
   'Two queries today (owner_lookup + hydrate). One combined query is the win.'),

  -- ── data-engine ──
  ('data-engine', 'step replay (cache miss)',
   'O(n_steps × frame ops) per hydrate',
   'snapshot point past ordinal ~50 (materialize a checkpoint frame)',
   'none', NULL, NULL, NULL,
   'Per-file step count rarely climbs that high today; revisit when long-running cleaning sessions become common.'),

  ('data-engine', 'XLSX in-memory parse',
   'whole workbook resident during convert (calamine non-streaming)',
   'stream-XLSX via xlsxwriter C library or umya-spreadsheet at >256MB inputs',
   'none', NULL, NULL, NULL,
   'A 256MB xlsx becomes ~256MB resident through tokio::spawn_blocking.'),

  ('data-engine', 'cleanness_pct on dirty columns',
   'O(n) per dirty column via try_cast_count',
   'cache the result on project_files.cleanness_pct; only recompute on step apply',
   'none', NULL, NULL, NULL,
   'Already cached; horizon only matters if a future endpoint forces recompute on every read.'),

  -- ── step-engine ──
  ('step-engine', 'set_cell per cell edit',
   'O(rows) per edit — Polars columns immutable',
   'batch set_cells step if a bulk-edit UI ever ships',
   'none', NULL, NULL, NULL,
   'Frontend already debounces per-cell; only a "fill column with X" UI would tip this.'),

  ('step-engine', 'fix_invalid date variant',
   'O(rows × 7 strptimes) per dirty column',
   'cache the first-matching format and skip the rest on subsequent rows',
   'none', NULL, NULL, NULL,
   'Most files have one date format; the 7-format coalesce is brute force for the worst case.'),

  ('step-engine', 'drop_rows with O(n) contains',
   'Vec<u32> contains() is O(n_indices) per row',
   'switch to HashSet<u32> when select-mode pushes thousands of indices',
   'none', NULL, NULL, NULL,
   'Today: a handful of rows per drop_rows; negligible. Bulk-select would tip this.'),

  -- ── events-and-logs ──
  ('events-and-logs', 'request_log unbounded growth',
   'one row per request, no retention',
   '90-day retention policy (nightly TRUNCATE WHERE at < now() - interval ''90 days'')',
   'table_row_count', 'request_log', 1000000, 'rows',
   '1M rows = ~10 days at 100 req/s sustained. Tipping point for shipping retention.'),

  ('events-and-logs', 'events unbounded growth',
   'append-only, no archive',
   'keep forever; audit/troubleshooting needs the history',
   'table_row_count', 'events', 10000000, 'rows',
   'Lower write rate (~5% of requests). 10M rows = years at solo-dev scale.'),

  ('events-and-logs', '/projects error rate baseline',
   '~17% over 24h (anon polling + Phase-2 stale 500s)',
   'review when 4xx exceeds 50% — indicates a real bug, not the baseline',
   'route_error_rate_24h', 'GET /projects', 0.5, 'fraction',
   'The baseline is the noise floor. A real spike above 50% means something broke.'),

  -- ── audit-storage ──
  ('audit-storage', 'audit.run_diff over many findings',
   'O(findings_per_run) set ops in SQL',
   'expected to stay linear; revisit if a single audit produces 1000+ findings',
   'audit_finding_count', 'css/selector_conflict', 200, 'findings',
   'A run with >200 findings of one kind is a sign the audit script needs tuning, not the diff fn.'),

  -- ── wasm-engine ──
  ('wasm-engine', 'bundle delivery (gzipped)',
   '~3.3 MB over the wire',
   'feature-strip polars (drop regex / concat_str / parts of dtype-full) for a demo-only variant',
   'none', NULL, NULL, NULL,
   'Breaks "one engine, two surfaces" — trade carefully. The lazy-load + 5MB cap already handles the demo cost.'),

  ('wasm-engine', 'rows_to_df + df_to_rows per-cell allocation',
   'AnyValue match per cell × N rows',
   'batch per-column with typed iterators when input row count exceeds ~10k',
   'none', NULL, NULL, NULL,
   'Demo cap is 5MB CSV (~tens of thousands of rows); already at the horizon edge.'),

  ('wasm-engine', 'threaded wasm (Phase C)',
   'single-threaded today; polars par_iter blocked',
   'enable when SharedArrayBuffer + COEP/CORP deploy headers land',
   'none', NULL, NULL, NULL,
   'Requires `wasm-bindgen-rayon` build flavor + server config. Phase C territory.'),

  -- ── omnisearch ──
  ('omnisearch', 'ILIKE on projects.name (no GIN index)',
   'seq-scan at solo-dev scale, ~5ms',
   'CREATE INDEX projects_name_trgm USING gin (name gin_trgm_ops) at >10k projects',
   'table_row_count', 'projects', 10000, 'rows',
   'pg_trgm extension required; ILIKE becomes index-scannable above the threshold.'),

  ('omnisearch', 'sequential projects + files queries',
   'two round-trips per search; ~5-10ms each',
   'parallelize via tokio::join! when search latency becomes a hot complaint',
   'none', NULL, NULL, NULL,
   'Total ~15ms today is well within budget. 2x gain only matters at higher latencies.'),

  -- ── prefs ──
  ('prefs', 'subquery join for prefs on every /api/me',
   '1ms — indexed (user_redpash_id) lookup',
   'cache the rolled-up prefs JSONB on users table; invalidate on PATCH',
   'route_p95_ms_24h', 'GET /me', 50, 'ms',
   '/me is on every page boot; if p95 climbs past 50ms the prefs subquery is the easiest win.')
ON CONFLICT (subsystem, phase) DO NOTHING;
