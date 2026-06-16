//! Purpose: GET /api/search?q=<text>&limit=<int> — omnisearch backing the
//! topbar's centred search box. ONE flat, `kind`-discriminated result list; the
//! frontend groups by kind. It does NOT invent RBAC: every source REUSES the
//! rail's reach-scoped query VERBATIM (rail.rs / objects.rs) — omnisearch just
//! flattens those sources, ILIKE-filters by the query, prefix-boosts, and ranks.
//!
//! `viewer = None` ⇒ platform admin (no filter); else the caller's principal
//! closure (`rbac::principals`) threaded as a `$N::text[]` bind into the SAME
//! `($N::text[] IS NULL OR EXISTS(memberships…))` reach clause every list uses.
//! Any authed Caller — extraction IS the gate (mirrors rail.rs); search shows
//! only what the caller can reach, so it never leaks foreign structure.
//!
//! Bounded twice: a per-kind SQL LIMIT (5) so one query stays cheap, AND a
//! kind-balanced round-robin total cap at the end (ported from the predecessor's
//! search.rs) so a noisy kind can't drown the others and grouping stays
//! contiguous. Five kinds: project / file (+chart/dashboard slices) / user /
//! company / team — the surfaces with a browse page to deep-link into.

use std::collections::HashMap;
use std::time::Instant;

use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row as _;

use crate::{
    error::AppError,
    rbac::{self, Caller},
    state::AppState,
};

pub fn routes() -> Router<AppState> {
    Router::new().route("/", get(search))
}

#[derive(Deserialize)]
struct SearchQuery {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

/// One flat result. `kind` discriminates; the frontend groups by it. `hash` is
/// the SPA deep-link to the surface that hosts the row.
#[derive(Serialize)]
struct SearchResult {
    kind: &'static str,
    rid: String,
    label: String,
    sub: String,
    hash: String,
}

const PER_KIND_LIMIT: i64 = 5;
const DEFAULT_TOTAL_LIMIT: u32 = 20;
const MAX_TOTAL_LIMIT: u32 = 100;
const MIN_Q_LEN: usize = 1;

/// GET /api/search — the reach-filtered omnisearch. Any authed caller; platform
/// admin searches the unfiltered directory (viewer = None).
async fn search(
    State(state): State<AppState>,
    caller: Caller,
    Query(q): Query<SearchQuery>,
) -> Result<Json<Value>, AppError> {
    let started = Instant::now();

    // viewer = None → admin (no reach filter); else the principal closure —
    // VERBATIM the rail.rs / objects.rs shape, threaded as a `$N::text[]` bind.
    let viewer: Option<Vec<String>> = if caller.is_platform_admin {
        None
    } else {
        Some(rbac::principals(&state.db, &caller.rid).await?)
    };
    let viewer = viewer.as_deref();

    // Trim + bail on empty. Single-char queries are noisy but allowed (the
    // per-kind ILIKE is still bounded by LIMIT) — gives the user feedback that
    // typing is doing something.
    let q_trim = q.q.unwrap_or_default().trim().to_string();
    let total_cap = q.limit.unwrap_or(DEFAULT_TOTAL_LIMIT).clamp(1, MAX_TOTAL_LIMIT);
    if q_trim.len() < MIN_Q_LEN {
        return Ok(Json(json!({ "q": "", "ms": started.elapsed().as_millis() as u32, "results": [] })));
    }

    let mut results: Vec<SearchResult> = Vec::with_capacity(total_cap as usize);

    // ── project ─────────────────────────────────────────────────────────────
    // rail.rs projects reach VERBATIM (membership on the project OR its
    // company). No `description`/`updated_at` columns here — match `name`,
    // sub = "", order by created_at (same as the rail). Prefix-boost via CASE.
    let rows = sqlx::query(
        "SELECT p.redpash_id, p.name
           FROM projects p
          WHERE ($1::text[] IS NULL OR EXISTS (
                    SELECT 1 FROM memberships m
                    WHERE m.member_redpash_id = ANY($1)
                      AND m.object_redpash_id IN (p.redpash_id, p.company_id)))
            AND p.name ILIKE '%' || $2 || '%'
          ORDER BY (CASE WHEN p.name ILIKE $2 || '%' THEN 0 ELSE 1 END),
                   p.created_at DESC
          LIMIT $3",
    )
    .bind(viewer)
    .bind(&q_trim)
    .bind(PER_KIND_LIMIT)
    .fetch_all(&state.db)
    .await?;
    for r in rows {
        let rid: String = r.try_get("redpash_id").unwrap_or_default();
        results.push(SearchResult {
            kind: "project",
            label: r.try_get("name").unwrap_or_default(),
            sub: String::new(),
            hash: "#/workspace".into(),
            rid,
        });
    }

    // ── file / chart / dashboard ──────────────────────────────────────────────
    // rail.rs project_files LEAVES reach VERBATIM (membership on the file, its
    // project, or the project's company), but for ALL file_types (the rail's
    // `leaf_where` slice is dropped). Match `filename` (no display_name column);
    // sub = "in {project}". One query; the kind comes from file_type, and a
    // ROW_NUMBER() per file_type keeps the mix balanced so a busy type can't
    // monopolise the 5-row leaf cap before the round-robin even sees it.
    let rows = sqlx::query(
        "WITH ranked AS (
            SELECT pf.redpash_id, pf.filename, pf.file_type, p.name AS project_name,
                   ROW_NUMBER() OVER (
                     PARTITION BY pf.file_type
                     ORDER BY (CASE WHEN pf.filename ILIKE $2 || '%' THEN 0 ELSE 1 END),
                              pf.created_at DESC
                   ) AS rn
              FROM project_files pf
              JOIN projects p ON p.redpash_id = pf.project_id
             WHERE ($1::text[] IS NULL OR EXISTS (
                       SELECT 1 FROM memberships m
                       WHERE m.member_redpash_id = ANY($1)
                         AND m.object_redpash_id IN (pf.redpash_id, pf.project_id, p.company_id)))
               AND pf.filename ILIKE '%' || $2 || '%'
         )
         SELECT redpash_id, filename, file_type, project_name
           FROM ranked
          WHERE rn <= $3
          ORDER BY file_type, rn",
    )
    .bind(viewer)
    .bind(&q_trim)
    .bind(PER_KIND_LIMIT)
    .fetch_all(&state.db)
    .await?;
    for r in rows {
        let rid: String = r.try_get("redpash_id").unwrap_or_default();
        let filename: String = r.try_get("filename").unwrap_or_default();
        let file_type: String = r.try_get("file_type").unwrap_or_default();
        let project_name: String = r.try_get("project_name").unwrap_or_default();
        // All three file kinds land in the same workspace surface.
        let kind = match file_type.as_str() {
            "chart" => "chart",
            "dashboard" => "dashboard",
            _ => "file", // csv (and anything new with no explicit slot)
        };
        results.push(SearchResult {
            kind,
            label: filename,
            sub: format!("in {project_name}"),
            hash: format!("#/workspace?file={rid}"),
            rid,
        });
    }

    // ── user ──────────────────────────────────────────────────────────────────
    // objects.rs `org_builtin("user")` reach VERBATIM (self-visibility via
    // `redpash_id = ANY` OR a membership edge). Match display_name / username /
    // email; label = display_name (fallback username), sub = @username.
    let rows = sqlx::query(
        "SELECT t.redpash_id, t.display_name, t.username
           FROM users t
          WHERE ($1::text[] IS NULL OR t.redpash_id = ANY($1) OR EXISTS (
                    SELECT 1 FROM memberships m
                    WHERE m.member_redpash_id = ANY($1)
                      AND m.object_redpash_id = t.redpash_id))
            AND (t.display_name        ILIKE '%' || $2 || '%'
              OR t.username            ILIKE '%' || $2 || '%'
              OR COALESCE(t.email, '') ILIKE '%' || $2 || '%')
          ORDER BY (CASE WHEN t.display_name ILIKE $2 || '%'
                           OR t.username     ILIKE $2 || '%' THEN 0 ELSE 1 END),
                   t.display_name
          LIMIT $3",
    )
    .bind(viewer)
    .bind(&q_trim)
    .bind(PER_KIND_LIMIT)
    .fetch_all(&state.db)
    .await?;
    for r in rows {
        let rid: String = r.try_get("redpash_id").unwrap_or_default();
        let display_name: String = r.try_get("display_name").unwrap_or_default();
        let username: String = r.try_get("username").unwrap_or_default();
        results.push(SearchResult {
            kind: "user",
            label: if display_name.is_empty() { username.clone() } else { display_name },
            sub: if username.is_empty() { String::new() } else { format!("@{username}") },
            hash: "#/org".into(),
            rid,
        });
    }

    // ── company ─────────────────────────────────────────────────────────────
    // objects.rs `org_builtin("company")` reach VERBATIM (membership on the
    // company). Match `name`; sub = "" (no slug column).
    let rows = sqlx::query(
        "SELECT t.redpash_id, t.name
           FROM companies t
          WHERE ($1::text[] IS NULL OR EXISTS (
                    SELECT 1 FROM memberships m
                    WHERE m.member_redpash_id = ANY($1)
                      AND m.object_redpash_id = t.redpash_id))
            AND t.name ILIKE '%' || $2 || '%'
          ORDER BY (CASE WHEN t.name ILIKE $2 || '%' THEN 0 ELSE 1 END), t.name
          LIMIT $3",
    )
    .bind(viewer)
    .bind(&q_trim)
    .bind(PER_KIND_LIMIT)
    .fetch_all(&state.db)
    .await?;
    for r in rows {
        let rid: String = r.try_get("redpash_id").unwrap_or_default();
        results.push(SearchResult {
            kind: "company",
            label: r.try_get("name").unwrap_or_default(),
            sub: String::new(),
            hash: "#/org".into(),
            rid,
        });
    }

    // ── team ────────────────────────────────────────────────────────────────
    // objects.rs `org_builtin("team")` reach VERBATIM (membership on the team
    // OR its company). Match `name`; sub = "".
    let rows = sqlx::query(
        "SELECT t.redpash_id, t.name
           FROM teams t
          WHERE ($1::text[] IS NULL OR EXISTS (
                    SELECT 1 FROM memberships m
                    WHERE m.member_redpash_id = ANY($1)
                      AND m.object_redpash_id IN (t.redpash_id, t.company_id)))
            AND t.name ILIKE '%' || $2 || '%'
          ORDER BY (CASE WHEN t.name ILIKE $2 || '%' THEN 0 ELSE 1 END), t.name
          LIMIT $3",
    )
    .bind(viewer)
    .bind(&q_trim)
    .bind(PER_KIND_LIMIT)
    .fetch_all(&state.db)
    .await?;
    for r in rows {
        let rid: String = r.try_get("redpash_id").unwrap_or_default();
        results.push(SearchResult {
            kind: "team",
            label: r.try_get("name").unwrap_or_default(),
            sub: String::new(),
            hash: "#/org".into(),
            rid,
        });
    }

    // Kind-balanced cap (ported from the predecessor's search.rs). The frontend
    // groups by kind transitions, so each kind must stay contiguous — a flat
    // `truncate` would drop whichever kinds were appended LAST. Round-robin one
    // slot per kind per round (append order) until the cap fills, then emit
    // contiguous per kind — every matching kind gets a fair slice.
    let results = round_robin_cap(results, total_cap as usize);

    Ok(Json(json!({
        "q": q_trim,
        "ms": started.elapsed().as_millis() as u32,
        "results": results,
    })))
}

/// Trim `results` to `cap` while keeping kinds contiguous and fairly sliced.
/// Bucket by kind (preserving first-seen order), then hand out one slot per kind
/// per round until `cap` is exhausted (or every bucket is drained), then emit
/// each kind's allocated slice contiguously. A no-op when already within `cap`.
fn round_robin_cap(results: Vec<SearchResult>, cap: usize) -> Vec<SearchResult> {
    if results.len() <= cap {
        return results;
    }
    let mut order: Vec<&'static str> = Vec::new();
    let mut buckets: HashMap<&'static str, Vec<SearchResult>> = HashMap::new();
    for r in results {
        if !buckets.contains_key(r.kind) {
            order.push(r.kind);
        }
        buckets.entry(r.kind).or_default().push(r);
    }
    let mut alloc: HashMap<&'static str, usize> = order.iter().map(|k| (*k, 0usize)).collect();
    let mut remaining = cap;
    loop {
        let mut progressed = false;
        for k in &order {
            if remaining == 0 {
                break;
            }
            if alloc[k] < buckets[k].len() {
                *alloc.get_mut(k).unwrap() += 1;
                remaining -= 1;
                progressed = true;
            }
        }
        if remaining == 0 || !progressed {
            break;
        }
    }
    let mut out = Vec::with_capacity(cap);
    for k in &order {
        let take = alloc[k];
        let b = buckets.get_mut(k).unwrap();
        out.extend(b.drain(..take));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(kind: &'static str, rid: &str) -> SearchResult {
        SearchResult { kind, rid: rid.into(), label: String::new(), sub: String::new(), hash: String::new() }
    }

    #[test]
    fn round_robin_is_a_noop_within_cap() {
        let got = round_robin_cap(vec![r("project", "a"), r("user", "b")], 20);
        assert_eq!(got.iter().map(|x| x.rid.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    }

    #[test]
    fn round_robin_gives_each_kind_a_fair_slice_and_keeps_kinds_contiguous() {
        // 6 projects + 6 users, cap 4 → 2 each (round-robin), kinds contiguous.
        let mut input = Vec::new();
        for i in 0..6 {
            input.push(r("project", &format!("p{i}")));
        }
        for i in 0..6 {
            input.push(r("user", &format!("u{i}")));
        }
        let got = round_robin_cap(input, 4);
        let rids: Vec<&str> = got.iter().map(|x| x.rid.as_str()).collect();
        assert_eq!(rids, ["p0", "p1", "u0", "u1"]);
        // Kinds stay contiguous (no interleaving).
        assert_eq!(got.iter().map(|x| x.kind).collect::<Vec<_>>(), ["project", "project", "user", "user"]);
    }

    #[test]
    fn round_robin_drains_a_small_kind_then_overflows_to_the_big_one() {
        // 1 company + 5 files, cap 4. Round 1: company+file (company drained).
        // Rounds 2-3: file only → 3 files total. company first (append order).
        let mut input = vec![r("company", "c0")];
        for i in 0..5 {
            input.push(r("file", &format!("f{i}")));
        }
        let got = round_robin_cap(input, 4);
        assert_eq!(
            got.iter().map(|x| x.rid.as_str()).collect::<Vec<_>>(),
            ["c0", "f0", "f1", "f2"]
        );
    }
}
