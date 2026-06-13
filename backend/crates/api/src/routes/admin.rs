//! Doc: docs/internal/code/backend/api/routes/admin.md
//! `/api/admin` — org-wide read surface for the `/home` rail tabs.
//!
//!   GET /api/admin/users        ← Users tab
//!   GET /api/admin/companies    ← Companies tab
//!   GET /api/admin/memberships  ← Memberships tab    (?scope=project|company)
//!   GET /api/admin/files        ← Files tab          (org-wide, not per-project)
//!   GET /api/admin/charts       ← Charts tab         (project_files where file_type='chart')
//!   GET /api/admin/steps        ← Steps tab          (every project_step across all files)
//!
//! All six return `Page<T>` — same shape as `/api/files/:rid/page` and
//! `/api/monitoring/*`, so the redtable on each tab reuses the
//! existing reader and the LIST_VIEWS spec table on the frontend
//! grows by one entry per new endpoint.
//!
//! Wire contract: `docs/internal/admin-monitoring-surfaces.md §6`.
//! Open today (solo / localhost); gate behind the company-admin role
//! when RBAC lands. Same posture as events.rs / metrics.rs /
//! monitoring.rs.

use std::time::Instant;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use shared::{
    admin::{
        AdminFileSummary, ChartStats, ChartSummary, CompanyStats, FileStats,
        MembershipStats, MembershipSummary, StepStats, StepSummary, TeamStats,
        UserStats, UserSummary,
    },
    company::{Company, CompanySummary},
    team::{Team, TeamSummary},
    type_def::{TypeDefinition, TypeList},
    Page,
};
use std::collections::HashMap;
use sqlx::Row;

use crate::{db, error::AppError, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/users",             get(list_users))
        .route("/users/stats",       get(stats_users))
        .route("/users/:rid",        axum::routing::patch(patch_user_role).delete(delete_user))
        .route("/companies",         get(list_companies))
        .route("/companies/stats",   get(stats_companies))
        .route("/companies/:rid",    axum::routing::delete(delete_company))
        .route("/teams",             get(list_teams_admin))
        .route("/teams/stats",       get(stats_teams))
        .route("/memberships",       get(list_memberships).post(create_membership))
        .route("/memberships/stats", get(stats_memberships))
        // Memberships use a synthetic compound rid in the path —
        // `{scope}:{scope_redpash_id}:{member_redpash_id}` — since the
        // table's primary key is composite. delete_membership parses
        // and dispatches to the right table.
        .route("/memberships/:rid",  axum::routing::delete(delete_membership))
        .route("/files",             get(list_files))
        .route("/files/stats",       get(stats_files))
        .route("/charts",            get(list_charts))
        .route("/charts/stats",      get(stats_charts))
        .route("/steps",             get(list_steps))
        .route("/steps/stats",       get(stats_steps))
        .route("/rbac",              get(rbac_resolve))
        .route("/audit-catalog",     get(audit_catalog))
        .route("/fields",            get(list_fields).put(put_field))
        .route("/types",             get(list_types).post(register_type))
        .route("/types/:type",       get(get_type))
}

// ── shared query plumbing (private to this module) ──────────────────────

use super::pagination::{build_page, paginate};

#[derive(Deserialize)]
pub(super) struct AdminQuery {
    #[serde(default)] pub(super) page: Option<u32>,
    #[serde(default)] pub(super) size: Option<u32>,
    #[serde(default)] pub(super) q:    Option<String>, // free-text search where applicable
    /// Click-to-sort header support. Validated against the per-endpoint
    /// SORTABLE_* allowlist; bad / missing values fall back to each
    /// handler's default column. `dir` → "asc"|"desc" (default "desc").
    #[serde(default)] pub(super) sort: Option<String>,
    #[serde(default)] pub(super) dir:  Option<String>,
}

#[derive(Deserialize)]
struct MembershipsQuery {
    #[serde(default)] page:  Option<u32>,
    #[serde(default)] size:  Option<u32>,
    /// `project` | `company`. Required; defaults to `project` to keep
    /// the endpoint usable without a query string.
    #[serde(default)] scope: Option<String>,
    #[serde(default)] role:  Option<String>,
    /// Free-text search across user display_name + username + the
    /// scope-parent name (project / company). ILIKE substring match.
    #[serde(default)] q:     Option<String>,
    /// Same click-to-sort shape as AdminQuery. Validated against
    /// SORTABLE_MEMBERSHIPS at the handler boundary.
    #[serde(default)] sort:  Option<String>,
    #[serde(default)] dir:   Option<String>,
}

#[derive(Deserialize)]
struct FilesQuery {
    #[serde(default)] page:      Option<u32>,
    #[serde(default)] size:      Option<u32>,
    #[serde(default)] file_type: Option<String>,
    /// Filter by computed `file_stages.stage` (import | clean | report | publish).
    #[serde(default)] stage:     Option<String>,
    #[serde(default)] project:   Option<String>, // project_redpash_id
    /// ILIKE search over filename + display_name + project name —
    /// drives the toolbar search box on the Home Files tab.
    #[serde(default)] q:         Option<String>,
    /// Click-to-sort header support. Validated against SORTABLE_FILES;
    /// bad values fall back to `created_at`. dir → "asc"|"desc"
    /// (default "desc").
    #[serde(default)] sort:      Option<String>,
    #[serde(default)] dir:       Option<String>,
}

#[derive(Deserialize)]
struct StepsQuery {
    #[serde(default)] page:    Option<u32>,
    #[serde(default)] size:    Option<u32>,
    #[serde(default)] file:    Option<String>, // file_redpash_id
    #[serde(default)] kind:    Option<String>,
    #[serde(default)] applied: Option<bool>,
    /// Free-text search across kind + filename (the joined file's
    /// name). ILIKE substring.
    #[serde(default)] q:       Option<String>,
}

/// Resolve a (sort, dir) query pair against a per-endpoint allowlist
/// of sortable column references. Returns `(col_sql, dir_sql)` strings
/// safe to splice into an `ORDER BY {col} {dir}` clause — never user
/// input directly. Bad / missing sort col falls back to `default_col`;
/// bad / missing dir falls back to `DESC`.
///
/// Click-to-sort headers on the Home redtable toolbar send the column
/// the user clicked; this gates the SQL injection vector at the
/// allowlist boundary. New endpoints declare their own SORTABLE_*
/// constant — keep it short, keep it audited.
pub(super) fn sort_clause(
    sort:        Option<&str>,
    dir:         Option<&str>,
    allow:       &[&str],
    default_col: &str,
) -> (String, &'static str) {
    let col = sort
        .and_then(|s| if allow.contains(&s) { Some(s) } else { None })
        .unwrap_or(default_col)
        .to_string();
    let dir = if matches!(dir, Some(d) if d.eq_ignore_ascii_case("asc")) { "ASC" } else { "DESC" };
    (col, dir)
}

// ── /api/admin/users ────────────────────────────────────────────────────

/// Sortable columns for /api/admin/users — wire-keys the Home Users tab
/// can pass via ?sort=. Mirror's the LIST_VIEWS column spec on the frontend.
const SORTABLE_USERS: &[&str] = &[
    "display_name", "first_name", "last_name", "username", "email",
    "plan", "role", "job_title", "organisation", "org_name", "org_role",
    "created_at",
];

async fn list_users(
    State(state): State<AppState>,
    Query(q):     Query<AdminQuery>,
) -> Result<Json<Page<UserSummary>>, AppError> {
    let started = Instant::now();
    let (offset, size, page) = paginate(q.page, q.size);

    let (sort_key, sort_dir) = sort_clause(
        q.sort.as_deref(), q.dir.as_deref(), SORTABLE_USERS, "created_at",
    );
    // Wire-key → SQL ref. Aliases like `org_name` resolve to the LEFT
    // JOIN LATERAL column; `org_role` likewise. NULLS LAST is appended
    // by the ORDER BY format! below so users without a company affiliation
    // sort to the tail regardless of dir.
    let sort_col = match sort_key.as_str() {
        "display_name" => "u.display_name",
        "first_name"   => "u.first_name",
        "last_name"    => "u.last_name",
        "username"     => "u.username",
        "email"        => "u.email",
        "plan"         => "u.plan",
        "role"         => "u.role",
        "job_title"    => "u.job_title",
        "organisation" => "u.organisation",
        "org_name"     => "m.company_name",
        "org_role"     => "m.role",
        _              => "u.created_at",
    };

    let all_count: i64 = db::count_total(&state.db, "users").await?;

    // ILIKE-search over username + display_name + email + organisation
    // when ?q= is set. Single $1 used four times — Postgres caches the
    // compiled pattern, no per-column compile cost.
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM users
         WHERE ($1::text IS NULL OR
                username     ILIKE '%' || $1 || '%' OR
                display_name ILIKE '%' || $1 || '%' OR
                COALESCE(email,        '') ILIKE '%' || $1 || '%' OR
                COALESCE(organisation, '') ILIKE '%' || $1 || '%')",
    )
    .bind(q.q.as_deref())
    .fetch_one(&state.db)
    .await?;

    // LEFT JOIN LATERAL pulls the user's "top" company membership row:
    // owner before admin before member, ties broken by most-recent
    // joined_at. One company per user — the Home Users tab shows the
    // primary org affiliation, multi-org users can drill into
    // /admin/memberships for the full list.
    // ORDER BY built via format! — sort_col comes from the SORTABLE_USERS
    // allowlist (never user input directly). SQL injection closed at the
    // sort_clause boundary. NULLS LAST keeps users without an org_name /
    // job_title at the tail regardless of dir.
    let sql = format!(
        "SELECT u.redpash_id, u.username, u.email, u.display_name,
                u.first_name, u.last_name, u.avatar_url,
                u.job_title, u.organisation, u.plan, u.role, u.created_at,
                m.company_id   AS org_id,
                m.company_name AS org_name,
                m.role         AS org_role
           FROM users u
           LEFT JOIN LATERAL (
             SELECT cm.object_redpash_id AS company_id, c.name AS company_name, cm.role
               FROM memberships cm
               JOIN companies c ON c.redpash_id = cm.object_redpash_id
              WHERE cm.member_redpash_id = u.redpash_id
              ORDER BY CASE cm.role
                         WHEN 'owner'  THEN 0
                         WHEN 'admin'  THEN 1
                         ELSE 2
                       END,
                       cm.joined_at DESC
              LIMIT 1
           ) m ON TRUE
          WHERE ($1::text IS NULL OR
                 u.username     ILIKE '%' || $1 || '%' OR
                 u.display_name ILIKE '%' || $1 || '%' OR
                 COALESCE(u.email,        '') ILIKE '%' || $1 || '%' OR
                 COALESCE(u.organisation, '') ILIKE '%' || $1 || '%')
          ORDER BY {sort_col} {sort_dir} NULLS LAST
          LIMIT $2 OFFSET $3"
    );
    let rows = sqlx::query(&sql)
    .bind(q.q.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let rows: Vec<UserSummary> = rows
        .into_iter()
        .map(|r| UserSummary {
            redpash_id:   r.try_get("redpash_id").unwrap_or_default(),
            username:     r.try_get("username").unwrap_or_default(),
            email:        r.try_get("email").ok(),
            display_name: r.try_get("display_name").unwrap_or_default(),
            first_name:   r.try_get("first_name").ok(),
            last_name:    r.try_get("last_name").ok(),
            avatar_url:   r.try_get("avatar_url").ok(),
            job_title:    r.try_get("job_title").ok(),
            organisation: r.try_get("organisation").ok(),
            plan:         r.try_get("plan").unwrap_or_default(),
            role:         r.try_get("role").unwrap_or_else(|_| "user".into()),
            org_id:       r.try_get("org_id").ok(),
            org_name:     r.try_get("org_name").ok(),
            org_role:     r.try_get("org_role").ok(),
            created_at:   r.try_get("created_at").unwrap_or_else(|_| Utc::now()),
        })
        .collect();

    Ok(Json(build_page(rows, total as u64, all_count as u64, page, size, started)))
}

// ── /api/admin/companies ────────────────────────────────────────────────

const SORTABLE_COMPANIES: &[&str] = &[
    "name", "slug", "member_count", "created_at", "updated_at",
];

async fn list_companies(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Query(q):     Query<AdminQuery>,
) -> Result<Json<Page<CompanySummary>>, AppError> {
    let started = Instant::now();
    // Resolve the caller so each row can carry the caller's own role
    // in that company (the "My role" column on the Home Companies tab).
    // The endpoint stays dev-permissive — resolving the caller is only
    // for the my_role projection, not a gate.
    let caller = super::resolve_user_rid(&state, &headers).await?;
    let (offset, size, page) = paginate(q.page, q.size);

    let (sort_key, sort_dir) = sort_clause(
        q.sort.as_deref(), q.dir.as_deref(), SORTABLE_COMPANIES, "created_at",
    );
    let sort_col = match sort_key.as_str() {
        "name"         => "c.name",
        "slug"         => "c.slug",
        // member_count is a subquery alias — Postgres allows referring to
        // SELECT aliases in ORDER BY, so this resolves cleanly.
        "member_count" => "member_count",
        "updated_at"   => "c.updated_at",
        _              => "c.created_at",
    };

    let all_count: i64 = db::count_total(&state.db, "companies").await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM companies
         WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR slug ILIKE '%' || $1 || '%')",
    )
    .bind(q.q.as_deref())
    .fetch_one(&state.db)
    .await?;

    // `my_role` picks the caller's HIGHEST-precedence role on the
    // company (owner > admin > member). Post-PK-widening a user can
    // hold multiple (role, context_role) rows on the same object, so
    // a plain `(SELECT m2.role …)` would return >1 row and 500. See
    // the matching team list for the same pattern.
    let sql = format!(
        "SELECT c.redpash_id, c.name, c.slug, c.avatar_url,
                c.created_at, c.updated_at,
                (SELECT COUNT(*)::INT FROM memberships m WHERE m.object_redpash_id = c.redpash_id) AS member_count,
                (SELECT m2.role FROM memberships m2
                  WHERE m2.object_redpash_id = c.redpash_id AND m2.member_redpash_id = $2
                  ORDER BY CASE m2.role
                    WHEN 'owner'  THEN 0
                    WHEN 'admin'  THEN 1
                    WHEN 'member' THEN 2
                    WHEN 'viewer' THEN 3
                    ELSE 4 END
                  LIMIT 1) AS my_role
           FROM companies c
          WHERE ($1::text IS NULL OR c.name ILIKE '%' || $1 || '%' OR c.slug ILIKE '%' || $1 || '%')
          ORDER BY {sort_col} {sort_dir} NULLS LAST
          LIMIT $3 OFFSET $4"
    );
    let rows = sqlx::query(&sql)
    .bind(q.q.as_deref())
    .bind(&caller)
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let rows: Vec<CompanySummary> = rows
        .into_iter()
        .map(|r| CompanySummary {
            company: Company {
                redpash_id: r.try_get("redpash_id").unwrap_or_default(),
                name:       r.try_get("name").unwrap_or_default(),
                slug:       r.try_get("slug").unwrap_or_default(),
                avatar_url: r.try_get("avatar_url").ok(),
                created_at: r.try_get("created_at").unwrap_or_else(|_| Utc::now()),
                updated_at: r.try_get("updated_at").unwrap_or_else(|_| Utc::now()),
            },
            member_count: r.try_get::<i32, _>("member_count").unwrap_or(0) as u32,
            // The caller's own role in this company (NULL when they're
            // not a member), joined via the my_role subquery. Drives the
            // "My role" column on the Home Companies tab.
            my_role: r.try_get::<String, _>("my_role").ok(),
        })
        .collect();

    Ok(Json(build_page(rows, total as u64, all_count as u64, page, size, started)))
}

// ── /api/admin/teams ────────────────────────────────────────────────────

const SORTABLE_TEAMS: &[&str] = &[
    "name", "kind", "company_name", "member_count", "created_at",
];

async fn list_teams_admin(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Query(q):     Query<AdminQuery>,
) -> Result<Json<Page<TeamSummary>>, AppError> {
    let started = Instant::now();
    // my_role projection — same shape as list_companies. Endpoint is
    // dev-permissive (RBAC tightening lives at the team CRUD route).
    let caller = super::resolve_user_rid(&state, &headers).await?;
    let (offset, size, page) = paginate(q.page, q.size);

    let (sort_key, sort_dir) = sort_clause(
        q.sort.as_deref(), q.dir.as_deref(), SORTABLE_TEAMS, "created_at",
    );
    let sort_col = match sort_key.as_str() {
        "name"         => "t.name",
        "kind"         => "t.kind",
        "company_name" => "company_name",
        "member_count" => "member_count",
        _              => "t.created_at",
    };

    let all_count: i64 = db::count_total(&state.db, "teams").await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM teams
         WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%')",
    )
    .bind(q.q.as_deref())
    .fetch_one(&state.db)
    .await?;

    // `my_role` picks the caller's HIGHEST-precedence role on the team
    // (owner > admin > member > viewer). Post-PK-widening a user can
    // hold multiple (role, context_role) rows on the same object, so a
    // plain `(SELECT m2.role …)` would return >1 row and 500 — order +
    // LIMIT 1 collapses it to the most authoritative tier.
    let sql = format!(
        "SELECT t.redpash_id, t.company_id, t.name, t.kind, t.created_at,
                COALESCE(c.name, '') AS company_name,
                (SELECT COUNT(*)::INT FROM memberships m
                  WHERE m.object_redpash_id = t.redpash_id) AS member_count,
                (SELECT m2.role FROM memberships m2
                  WHERE m2.object_redpash_id = t.redpash_id AND m2.member_redpash_id = $2
                  ORDER BY CASE m2.role
                    WHEN 'owner'  THEN 0
                    WHEN 'admin'  THEN 1
                    WHEN 'member' THEN 2
                    WHEN 'viewer' THEN 3
                    ELSE 4 END
                  LIMIT 1) AS my_role
           FROM teams t
           LEFT JOIN companies c ON c.redpash_id = t.company_id
          WHERE ($1::text IS NULL OR t.name ILIKE '%' || $1 || '%')
          ORDER BY {sort_col} {sort_dir} NULLS LAST
          LIMIT $3 OFFSET $4"
    );
    let rows = sqlx::query(&sql)
        .bind(q.q.as_deref())
        .bind(&caller)
        .bind(size as i64)
        .bind(offset)
        .fetch_all(&state.db)
        .await?;

    let rows: Vec<TeamSummary> = rows
        .into_iter()
        .map(|r| TeamSummary {
            team: Team {
                redpash_id: r.try_get("redpash_id").unwrap_or_default(),
                company_id: r.try_get("company_id").unwrap_or_default(),
                name:       r.try_get("name").unwrap_or_default(),
                kind:       r.try_get("kind").unwrap_or_else(|_| "team".to_string()),
                created_at: r.try_get("created_at").unwrap_or_else(|_| Utc::now()),
            },
            company_name: r.try_get("company_name").unwrap_or_default(),
            member_count: r.try_get::<i32, _>("member_count").unwrap_or(0) as u32,
            my_role:      r.try_get::<String, _>("my_role").ok(),
        })
        .collect();

    Ok(Json(build_page(rows, total as u64, all_count as u64, page, size, started)))
}

async fn stats_teams(
    State(state): State<AppState>,
) -> Result<Json<TeamStats>, AppError> {
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*)::BIGINT FROM teams")
        .fetch_one(&state.db).await?;
    // "with_members" — teams whose membership count is ≥2 (creator +
    // at least one other). Single-owner teams haven't been adopted yet.
    let with_members: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM teams t
          WHERE (SELECT COUNT(*) FROM memberships m
                  WHERE m.object_redpash_id = t.redpash_id) >= 2"
    ).fetch_one(&state.db).await?;
    let by_company: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT company_id)::BIGINT FROM teams"
    ).fetch_one(&state.db).await?;
    Ok(Json(TeamStats {
        total:        total        as u64,
        with_members: with_members as u64,
        by_company:   by_company   as u64,
    }))
}

// ── /api/admin/memberships ──────────────────────────────────────────────

const SORTABLE_MEMBERSHIPS: &[&str] = &[
    "user_display_name", "user_username", "scope", "scope_name", "role", "joined_at",
];

async fn list_memberships(
    State(state): State<AppState>,
    Query(q):     Query<MembershipsQuery>,
) -> Result<Json<Page<MembershipSummary>>, AppError> {
    let started = Instant::now();
    let (offset, size, page) = paginate(q.page, q.size);
    let scope = q.scope.as_deref().unwrap_or("project");
    if scope != "project" && scope != "company" && scope != "case" && scope != "team" {
        return Err(AppError::bad_request(
            "admin",
            "scope must be one of: project, company, case, team",
        ));
    }

    let (sort_key, sort_dir) = sort_clause(
        q.sort.as_deref(), q.dir.as_deref(), SORTABLE_MEMBERSHIPS, "joined_at",
    );
    // The four scope-specific queries share aliases (user_display_name,
    // scope_name, role, joined_at) so the same sort_col resolves against
    // every branch.
    let sort_col = match sort_key.as_str() {
        "user_display_name" => "u.display_name",
        "user_username"     => "u.username",
        "scope_name"        => match scope {
            "project" => "p.name",
            "case"    => "ca.title",
            "team"    => "t.name",
            _         => "c.name",
        },
        // "scope" is a literal column emitted by the SELECT — a
        // single string per response since the WHERE filters by it.
        // Sorting by it is a no-op within a single result set; keep
        // it in the allowlist so the FE chevron still works but the
        // ORDER BY targets the constant alias.
        "scope"             => "scope",
        "role"              => "m.role",
        _                   => "m.joined_at",
    };

    // all_count = total across all four scopes (project + company + case +
    // team), the rail tab's "everything" count. total = scope+role-filtered
    // count. Per-scope COUNT(*) via JOIN-as-filter so rows whose object
    // isn't one of the registered scopes (none today, but cheap insurance)
    // don't inflate the count.
    let all_count: i64 = sqlx::query_scalar(
        "SELECT
            (SELECT COUNT(*) FROM memberships m
                JOIN projects  p ON p.redpash_id = m.object_redpash_id)
          + (SELECT COUNT(*) FROM memberships m
                JOIN companies c ON c.redpash_id = m.object_redpash_id)
          + (SELECT COUNT(*) FROM memberships m
                JOIN cases     ca ON ca.redpash_id = m.object_redpash_id)
          + (SELECT COUNT(*) FROM memberships m
                JOIN teams     t  ON t.redpash_id  = m.object_redpash_id)",
    )
    .fetch_one(&state.db)
    .await?;

    // Scope-specific query — two different tables with parallel schemas.
    // Joined to users (display_name + username) and the scope parent
    // (project name or company name) so the row renders without a
    // second lookup. ORDER BY built via format! with sort_col sourced
    // from SORTABLE_MEMBERSHIPS allowlist. ?q= searches user_display_name
    // / user_username / scope_name (project or company name) via ILIKE.
    let count_sql = match scope {
        "project" => {
            "SELECT COUNT(*)::BIGINT
               FROM memberships m
               JOIN projects p ON p.redpash_id = m.object_redpash_id
               JOIN users    u ON u.redpash_id = m.member_redpash_id
              WHERE ($1::text IS NULL OR m.role = $1)
                AND ($2::text IS NULL OR
                     u.display_name ILIKE '%' || $2 || '%' OR
                     u.username     ILIKE '%' || $2 || '%' OR
                     p.name         ILIKE '%' || $2 || '%')"
        }
        "case" => {
            "SELECT COUNT(*)::BIGINT
               FROM memberships m
               JOIN cases ca ON ca.redpash_id = m.object_redpash_id
               JOIN users u  ON u.redpash_id  = m.member_redpash_id
              WHERE ($1::text IS NULL OR m.role = $1)
                AND ($2::text IS NULL OR
                     u.display_name ILIKE '%' || $2 || '%' OR
                     u.username     ILIKE '%' || $2 || '%' OR
                     ca.title       ILIKE '%' || $2 || '%')"
        }
        "team" => {
            "SELECT COUNT(*)::BIGINT
               FROM memberships m
               JOIN teams t ON t.redpash_id  = m.object_redpash_id
               JOIN users u ON u.redpash_id  = m.member_redpash_id
              WHERE ($1::text IS NULL OR m.role = $1)
                AND ($2::text IS NULL OR
                     u.display_name ILIKE '%' || $2 || '%' OR
                     u.username     ILIKE '%' || $2 || '%' OR
                     t.name         ILIKE '%' || $2 || '%')"
        }
        _ => {
            "SELECT COUNT(*)::BIGINT
               FROM memberships m
               JOIN companies c ON c.redpash_id = m.object_redpash_id
               JOIN users     u ON u.redpash_id = m.member_redpash_id
              WHERE ($1::text IS NULL OR m.role = $1)
                AND ($2::text IS NULL OR
                     u.display_name ILIKE '%' || $2 || '%' OR
                     u.username     ILIKE '%' || $2 || '%' OR
                     c.name         ILIKE '%' || $2 || '%')"
        }
    };
    let rows_sql = match scope {
        "project" => format!(
            "SELECT 'project' AS scope,
                    m.object_redpash_id      AS scope_redpash_id,
                    p.name                   AS scope_name,
                    m.member_redpash_id      AS member_redpash_id,
                    u.display_name           AS user_display_name,
                    u.username               AS user_username,
                    m.role                   AS role,
                    m.joined_at              AS joined_at
               FROM memberships m
               JOIN projects p ON p.redpash_id = m.object_redpash_id
               JOIN users    u ON u.redpash_id = m.member_redpash_id
              WHERE ($1::text IS NULL OR m.role = $1)
                AND ($2::text IS NULL OR
                     u.display_name ILIKE '%' || $2 || '%' OR
                     u.username     ILIKE '%' || $2 || '%' OR
                     p.name         ILIKE '%' || $2 || '%')
              ORDER BY {sort_col} {sort_dir} NULLS LAST
              LIMIT $3 OFFSET $4"
        ),
        "case" => format!(
            "SELECT 'case' AS scope,
                    m.object_redpash_id      AS scope_redpash_id,
                    ca.title                 AS scope_name,
                    m.member_redpash_id      AS member_redpash_id,
                    u.display_name           AS user_display_name,
                    u.username               AS user_username,
                    m.role                   AS role,
                    m.joined_at              AS joined_at
               FROM memberships m
               JOIN cases ca ON ca.redpash_id = m.object_redpash_id
               JOIN users u  ON u.redpash_id  = m.member_redpash_id
              WHERE ($1::text IS NULL OR m.role = $1)
                AND ($2::text IS NULL OR
                     u.display_name ILIKE '%' || $2 || '%' OR
                     u.username     ILIKE '%' || $2 || '%' OR
                     ca.title       ILIKE '%' || $2 || '%')
              ORDER BY {sort_col} {sort_dir} NULLS LAST
              LIMIT $3 OFFSET $4"
        ),
        "team" => format!(
            "SELECT 'team' AS scope,
                    m.object_redpash_id      AS scope_redpash_id,
                    t.name                   AS scope_name,
                    m.member_redpash_id      AS member_redpash_id,
                    u.display_name           AS user_display_name,
                    u.username               AS user_username,
                    m.role                   AS role,
                    m.joined_at              AS joined_at
               FROM memberships m
               JOIN teams t ON t.redpash_id  = m.object_redpash_id
               JOIN users u ON u.redpash_id  = m.member_redpash_id
              WHERE ($1::text IS NULL OR m.role = $1)
                AND ($2::text IS NULL OR
                     u.display_name ILIKE '%' || $2 || '%' OR
                     u.username     ILIKE '%' || $2 || '%' OR
                     t.name         ILIKE '%' || $2 || '%')
              ORDER BY {sort_col} {sort_dir} NULLS LAST
              LIMIT $3 OFFSET $4"
        ),
        _ => format!(
            "SELECT 'company' AS scope,
                    m.object_redpash_id AS scope_redpash_id,
                    c.name           AS scope_name,
                    m.member_redpash_id AS member_redpash_id,
                    u.display_name   AS user_display_name,
                    u.username       AS user_username,
                    m.role           AS role,
                    m.joined_at      AS joined_at
               FROM memberships m
               JOIN companies c ON c.redpash_id = m.object_redpash_id
               JOIN users     u ON u.redpash_id = m.member_redpash_id
              WHERE ($1::text IS NULL OR m.role = $1)
                AND ($2::text IS NULL OR
                     u.display_name ILIKE '%' || $2 || '%' OR
                     u.username     ILIKE '%' || $2 || '%' OR
                     c.name         ILIKE '%' || $2 || '%')
              ORDER BY {sort_col} {sort_dir} NULLS LAST
              LIMIT $3 OFFSET $4"
        ),
    };

    let total: i64 = sqlx::query_scalar(count_sql)
        .bind(q.role.as_deref())
        .bind(q.q.as_deref())
        .fetch_one(&state.db)
        .await?;

    let rows = sqlx::query(&rows_sql)
        .bind(q.role.as_deref())
        .bind(q.q.as_deref())
        .bind(size as i64)
        .bind(offset)
        .fetch_all(&state.db)
        .await?;

    let rows: Vec<MembershipSummary> = rows
        .into_iter()
        .map(|r| MembershipSummary {
            scope:             r.try_get("scope").unwrap_or_default(),
            scope_redpash_id:  r.try_get("scope_redpash_id").unwrap_or_default(),
            scope_name:        r.try_get("scope_name").unwrap_or_default(),
            member_redpash_id:   r.try_get("member_redpash_id").unwrap_or_default(),
            user_display_name: r.try_get("user_display_name").unwrap_or_default(),
            user_username:     r.try_get("user_username").unwrap_or_default(),
            role:              r.try_get("role").unwrap_or_default(),
            joined_at:         r.try_get("joined_at").unwrap_or_else(|_| Utc::now()),
        })
        .collect();

    Ok(Json(build_page(rows, total as u64, all_count as u64, page, size, started)))
}

// ── /api/admin/files ────────────────────────────────────────────────────

/// Sortable columns on `/admin/files`. Keys are the wire vocabulary
/// the click-to-sort header sends; values are the SQL column refs
/// spliced into ORDER BY. Keep small — every entry is a public-surface
/// promise that the user can sort by it.
const SORTABLE_FILES: &[&str] = &[
    "filename", "display_name", "file_type", "stage",
    "row_count", "col_count", "file_size_bytes", "cleanness_pct",
    "updated_at", "created_at",
];

async fn list_files(
    State(state): State<AppState>,
    Query(q):     Query<FilesQuery>,
) -> Result<Json<Page<AdminFileSummary>>, AppError> {
    let started = Instant::now();
    let (offset, size, page) = paginate(q.page, q.size);
    // Wire-key → SQL-column ref. `stage` is the computed COALESCE
    // alias; everything else lives on f.* directly. Sort happens
    // post-JOIN so the SQL alias resolves.
    let (sort_key, sort_dir) = sort_clause(
        q.sort.as_deref(), q.dir.as_deref(), SORTABLE_FILES, "created_at",
    );
    let sort_col = match sort_key.as_str() {
        "filename"        => "f.filename",
        "display_name"    => "COALESCE(f.display_name, f.filename)",
        "file_type"       => "f.file_type",
        "stage"           => "COALESCE(s.stage, 'new')",
        "row_count"       => "f.row_count",
        "col_count"       => "f.col_count",
        "file_size_bytes" => "f.file_size_bytes",
        "cleanness_pct"   => "f.cleanness_pct",
        "updated_at"      => "f.updated_at",
        _                 => "f.created_at",
    };

    let all_count: i64 = db::count_total(&state.db, "project_files").await?;

    // `status` was dropped in the object-model hard-refresh; `file_stages.stage`
    // is the computed replacement (import | clean | report | publish). LEFT JOIN
    // because a brand-new file row predates its file_stages entry by a
    // transaction tick — render those as the default `import` stage rather
    // than dropping them from the list.
    //
    // PROJECT-FILES-ACK: type=any — admin Files tab; q.file_type optionally
    // filters the response, but the SQL is polymorphic by default (admin
    // surface lists every file_type unless the caller narrows).
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT
           FROM project_files f
           JOIN projects p ON p.redpash_id = f.project_redpash_id
           LEFT JOIN file_stages s ON s.file_redpash_id = f.redpash_id
          WHERE ($1::text IS NULL OR f.file_type = $1)
            AND ($2::text IS NULL OR COALESCE(s.stage, 'new') = $2)
            AND ($3::text IS NULL OR f.project_redpash_id = $3)
            AND ($4::text IS NULL OR
                 f.filename                 ILIKE '%' || $4 || '%' OR
                 COALESCE(f.display_name, '') ILIKE '%' || $4 || '%' OR
                 p.name                     ILIKE '%' || $4 || '%')",
    )
    .bind(q.file_type.as_deref())
    .bind(q.stage.as_deref())
    .bind(q.project.as_deref())
    .bind(q.q.as_deref())
    .fetch_one(&state.db)
    .await?;

    // ORDER BY is built via format! because sqlx can't bind identifiers;
    // sort_col is sourced from the SORTABLE_FILES allowlist (never user
    // input directly), so SQL injection is closed at the boundary.
    // NULLS LAST keeps null row_counts at the tail when sorting ASC.
    //
    // PROJECT-FILES-ACK: type=any — same admin Files listing as the
    // total-count query above; q.file_type optionally narrows.
    let sql = format!(
        "SELECT f.redpash_id, f.project_redpash_id,
                p.name AS project_name,
                f.filename, f.display_name, f.file_type,
                COALESCE(s.stage, 'new') AS stage,
                f.row_count, f.col_count, f.file_size_bytes, f.cleanness_pct,
                f.created_at, f.updated_at
           FROM project_files f
           JOIN projects p ON p.redpash_id = f.project_redpash_id
           LEFT JOIN file_stages s ON s.file_redpash_id = f.redpash_id
          WHERE ($1::text IS NULL OR f.file_type = $1)
            AND ($2::text IS NULL OR COALESCE(s.stage, 'new') = $2)
            AND ($3::text IS NULL OR f.project_redpash_id = $3)
            AND ($4::text IS NULL OR
                 f.filename                 ILIKE '%' || $4 || '%' OR
                 COALESCE(f.display_name, '') ILIKE '%' || $4 || '%' OR
                 p.name                     ILIKE '%' || $4 || '%')
          ORDER BY {} {} NULLS LAST
          LIMIT $5 OFFSET $6",
        sort_col, sort_dir,
    );
    let rows = sqlx::query(&sql)
    .bind(q.file_type.as_deref())
    .bind(q.stage.as_deref())
    .bind(q.project.as_deref())
    .bind(q.q.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let rows: Vec<AdminFileSummary> = rows
        .into_iter()
        .map(|r| AdminFileSummary {
            redpash_id:         r.try_get("redpash_id").unwrap_or_default(),
            project_redpash_id: r.try_get("project_redpash_id").unwrap_or_default(),
            project_name:       r.try_get("project_name").unwrap_or_default(),
            filename:           r.try_get("filename").unwrap_or_default(),
            display_name:       r.try_get("display_name").ok(),
            file_type:          r.try_get("file_type").unwrap_or_default(),
            stage:              r.try_get("stage").unwrap_or_else(|_| "new".into()),
            row_count:          r.try_get("row_count").ok(),
            col_count:          r.try_get("col_count").ok(),
            file_size_bytes:    r.try_get("file_size_bytes").ok(),
            cleanness_pct:      r.try_get("cleanness_pct").ok(),
            created_at:         r.try_get("created_at").unwrap_or_else(|_| Utc::now()),
            updated_at:         r.try_get("updated_at").unwrap_or_else(|_| Utc::now()),
        })
        .collect();

    Ok(Json(build_page(rows, total as u64, all_count as u64, page, size, started)))
}

// ── /api/admin/charts ───────────────────────────────────────────────────

const SORTABLE_CHARTS: &[&str] = &[
    "display_name", "filename", "project_name", "stage", "created_at", "updated_at",
];

async fn list_charts(
    State(state): State<AppState>,
    Query(q):     Query<AdminQuery>,
) -> Result<Json<Page<ChartSummary>>, AppError> {
    // Admin surface: no viewer filter (already platform-admin-gated by the nest).
    Ok(Json(charts_page(&state, &q, None).await?))
}

/// Paginated chart list, reach-aware. `viewer = None` → every chart (admin).
/// `viewer = Some(principals)` → only charts whose project (or its company) the
/// caller can reach — the user-scoped `/api/charts` list. The reach predicate
/// mirrors `db::list_projects` / `list_cases` (charts are `project_files`).
pub(super) async fn charts_page(
    state:  &AppState,
    q:      &AdminQuery,
    viewer: Option<&[String]>,
) -> Result<Page<ChartSummary>, AppError> {
    let started = Instant::now();
    let (offset, size, page) = paginate(q.page, q.size);

    let (sort_key, sort_dir) = sort_clause(
        q.sort.as_deref(), q.dir.as_deref(), SORTABLE_CHARTS, "created_at",
    );
    let sort_col = match sort_key.as_str() {
        // display_name is nullable — COALESCE to filename so the sort is
        // deterministic even when display_name is missing.
        "display_name" => "COALESCE(f.display_name, f.filename)",
        "filename"     => "f.filename",
        "project_name" => "p.name",
        "stage"        => "COALESCE(s.stage, 'new')",
        "updated_at"   => "f.updated_at",
        _              => "f.created_at",
    };

    // Reach: $1 is the caller's principals (self + teams) as text[], or NULL for
    // admin (no filter). A chart is reachable if the caller is a member of its
    // project OR the project's company. Same shape across the project_files family.
    const REACH: &str =
        "($1::text[] IS NULL OR EXISTS (SELECT 1 FROM memberships m
              WHERE m.member_redpash_id = ANY($1)
                AND m.object_redpash_id IN (f.project_redpash_id, p.company_id)))";

    // Charts live in project_files with file_type='chart'. Two counts:
    //   all_count — every chart in reach (pre-search) — the tab's true total.
    //   total     — post-search filter.
    // PROJECT-FILES-ACK: type=chart — Charts tab; all three queries filter to it.
    let all_count: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*)::BIGINT FROM project_files f
           JOIN projects p ON p.redpash_id = f.project_redpash_id
          WHERE f.file_type = 'chart' AND {REACH}"
    ))
    .bind(viewer)
    .fetch_one(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*)::BIGINT FROM project_files f
           JOIN projects p ON p.redpash_id = f.project_redpash_id
          WHERE f.file_type = 'chart' AND {REACH}
            AND ($2::text IS NULL OR
                 f.filename                 ILIKE '%' || $2 || '%' OR
                 COALESCE(f.display_name, '') ILIKE '%' || $2 || '%')"
    ))
    .bind(viewer)
    .bind(q.q.as_deref())
    .fetch_one(&state.db)
    .await?;

    // ORDER BY built via format! with sort_col from the SORTABLE_CHARTS
    // allowlist (never user input directly).
    let sql = format!(
        "SELECT f.redpash_id, f.project_redpash_id, p.name AS project_name,
                f.filename, f.display_name,
                COALESCE(s.stage, 'new') AS stage,
                f.created_at, f.updated_at
           FROM project_files f
           JOIN projects p ON p.redpash_id = f.project_redpash_id
           LEFT JOIN file_stages s ON s.file_redpash_id = f.redpash_id
          WHERE f.file_type = 'chart' AND {REACH}
            AND ($2::text IS NULL OR
                 f.filename                 ILIKE '%' || $2 || '%' OR
                 COALESCE(f.display_name, '') ILIKE '%' || $2 || '%')
          ORDER BY {sort_col} {sort_dir} NULLS LAST
          LIMIT $3 OFFSET $4"
    );
    let rows = sqlx::query(&sql)
    .bind(viewer)
    .bind(q.q.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let rows: Vec<ChartSummary> = rows
        .into_iter()
        .map(|r| ChartSummary {
            redpash_id:         r.try_get("redpash_id").unwrap_or_default(),
            project_redpash_id: r.try_get("project_redpash_id").unwrap_or_default(),
            project_name:       r.try_get("project_name").unwrap_or_default(),
            filename:           r.try_get("filename").unwrap_or_default(),
            display_name:       r.try_get("display_name").ok(),
            stage:              r.try_get("stage").unwrap_or_else(|_| "new".into()),
            created_at:         r.try_get("created_at").unwrap_or_else(|_| Utc::now()),
            updated_at:         r.try_get("updated_at").unwrap_or_else(|_| Utc::now()),
        })
        .collect();

    Ok(build_page(rows, total as u64, all_count as u64, page, size, started))
}

// ── /api/admin/steps ────────────────────────────────────────────────────

async fn list_steps(
    State(state): State<AppState>,
    Query(q):     Query<StepsQuery>,
) -> Result<Json<Page<StepSummary>>, AppError> {
    let started = Instant::now();
    let (offset, size, page) = paginate(q.page, q.size);

    let all_count: i64 = db::count_total(&state.db, "project_steps").await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT
           FROM project_steps s
           JOIN project_files f ON f.redpash_id = s.file_redpash_id
          WHERE ($1::text IS NULL OR s.file_redpash_id = $1)
            AND ($2::text IS NULL OR s.kind            = $2)
            AND ($3::bool IS NULL OR s.applied         = $3)
            AND ($4::text IS NULL OR
                 s.kind     ILIKE '%' || $4 || '%' OR
                 f.filename ILIKE '%' || $4 || '%')",
    )
    .bind(q.file.as_deref())
    .bind(q.kind.as_deref())
    .bind(q.applied)
    .bind(q.q.as_deref())
    .fetch_one(&state.db)
    .await?;

    let rows = sqlx::query(
        "SELECT s.redpash_id, s.file_redpash_id, f.filename AS file_filename,
                s.ordinal, s.kind, s.applied, s.created_at
           FROM project_steps s
           JOIN project_files f ON f.redpash_id = s.file_redpash_id
          WHERE ($1::text IS NULL OR s.file_redpash_id = $1)
            AND ($2::text IS NULL OR s.kind            = $2)
            AND ($3::bool IS NULL OR s.applied         = $3)
            AND ($4::text IS NULL OR
                 s.kind     ILIKE '%' || $4 || '%' OR
                 f.filename ILIKE '%' || $4 || '%')
          ORDER BY s.created_at DESC
          LIMIT $5 OFFSET $6",
    )
    .bind(q.file.as_deref())
    .bind(q.kind.as_deref())
    .bind(q.applied)
    .bind(q.q.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let rows: Vec<StepSummary> = rows
        .into_iter()
        .map(|r| StepSummary {
            redpash_id:      r.try_get("redpash_id").unwrap_or_default(),
            file_redpash_id: r.try_get("file_redpash_id").unwrap_or_default(),
            file_filename:   r.try_get("file_filename").unwrap_or_default(),
            ordinal:         r.try_get("ordinal").unwrap_or(0),
            kind:            r.try_get("kind").unwrap_or_default(),
            applied:         r.try_get("applied").unwrap_or(true),
            created_at:      r.try_get("created_at").unwrap_or_else(|_| Utc::now()),
        })
        .collect();

    Ok(Json(build_page(rows, total as u64, all_count as u64, page, size, started)))
}

// ── stats endpoints (Home KPI strips) ───────────────────────────────────

/// Run a `SELECT key, COUNT(*) FROM …` and collect into a HashMap<String, u64>.
/// Used by every `by_*` distribution below — keeps the per-handler code
/// to the SQL string + the result Map name.
///
/// pub(super) so `routes::monitoring`'s stats handlers can share the
/// same one-liner without duplicating the boilerplate.
pub(super) async fn group_count(
    pool:  &sqlx::PgPool,
    query: &str,
) -> Result<HashMap<String, u64>, AppError> {
    let rows = sqlx::query(query)
        .fetch_all(pool)
        .await?;
    let mut out = HashMap::with_capacity(rows.len());
    for r in rows {
        let key: String = r.try_get(0).unwrap_or_default();
        let cnt: i64    = r.try_get(1).unwrap_or(0);
        if !key.is_empty() {
            out.insert(key, cnt as u64);
        }
    }
    Ok(out)
}

// ── /api/admin/users/stats ──────────────────────────────────────────────

async fn stats_users(State(state): State<AppState>) -> Result<Json<UserStats>, AppError> {
    let total: i64 = db::count_total(&state.db, "users").await?;

    // Active proxy: any event captured against the user in the last 7d.
    // SET NULL on events.user_redpash_id (per the migration) means events
    // belonging to deleted users don't count toward "active" — correct.
    let active_7d: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT user_redpash_id)::BIGINT
           FROM events
          WHERE user_redpash_id IS NOT NULL
            AND occurred_at >= now() - interval '7 days'",
    )
    .fetch_one(&state.db)
    .await?;

    let by_plan = group_count(
        &state.db,
        "SELECT plan, COUNT(*)::BIGINT FROM users GROUP BY plan",
    ).await?;

    Ok(Json(UserStats {
        total: total as u64,
        active_7d: active_7d as u64,
        by_plan,
    }))
}

// ── /api/admin/companies/stats ──────────────────────────────────────────

async fn stats_companies(State(state): State<AppState>) -> Result<Json<CompanyStats>, AppError> {
    let total: i64 = db::count_total(&state.db, "companies").await?;

    // Activity proxy: any file in any of the company's projects has
    // updated_at in the last 30d. EXISTS rather than DISTINCT-join so
    // a chatty project doesn't double-count the parent company.
    let active_30d: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM companies c
          WHERE EXISTS (
            SELECT 1
              FROM projects p
              JOIN project_files f ON f.project_redpash_id = p.redpash_id
             WHERE p.company_id = c.redpash_id
               AND f.updated_at >= now() - interval '30 days'
          )",
    )
    .fetch_one(&state.db)
    .await?;

    let with_projects: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM companies c
          WHERE EXISTS (SELECT 1 FROM projects p WHERE p.company_id = c.redpash_id)",
    )
    .fetch_one(&state.db)
    .await?;

    Ok(Json(CompanyStats {
        total: total as u64,
        active_30d: active_30d as u64,
        with_projects: with_projects as u64,
    }))
}

// ── /api/admin/memberships/stats ────────────────────────────────────────

#[derive(Deserialize)]
struct MembershipsStatsQuery {
    #[serde(default)] scope: Option<String>,
}

async fn stats_memberships(
    State(state): State<AppState>,
    Query(q):     Query<MembershipsStatsQuery>,
) -> Result<Json<MembershipStats>, AppError> {
    let scope = q.scope.as_deref().unwrap_or("project");
    if scope != "project" && scope != "company" && scope != "case" && scope != "team" {
        return Err(AppError::bad_request(
            "admin",
            "scope must be one of: project, company, case, team",
        ));
    }

    // One table now; split scopes by the object rid prefix (\\_ escapes the
    // literal underscore so the LIKE matches the prefix, not a wildcard).
    let (count_sql, group_sql) = match scope {
        "project" => (
            "SELECT COUNT(*)::BIGINT FROM memberships WHERE object_redpash_id LIKE 'PRJ\\_%'",
            "SELECT role, COUNT(*)::BIGINT FROM memberships WHERE object_redpash_id LIKE 'PRJ\\_%' GROUP BY role",
        ),
        "case" => (
            "SELECT COUNT(*)::BIGINT FROM memberships WHERE object_redpash_id LIKE 'CAS\\_%'",
            "SELECT role, COUNT(*)::BIGINT FROM memberships WHERE object_redpash_id LIKE 'CAS\\_%' GROUP BY role",
        ),
        "team" => (
            "SELECT COUNT(*)::BIGINT FROM memberships WHERE object_redpash_id LIKE 'TEM\\_%'",
            "SELECT role, COUNT(*)::BIGINT FROM memberships WHERE object_redpash_id LIKE 'TEM\\_%' GROUP BY role",
        ),
        _ => (
            "SELECT COUNT(*)::BIGINT FROM memberships WHERE object_redpash_id LIKE 'CMP\\_%'",
            "SELECT role, COUNT(*)::BIGINT FROM memberships WHERE object_redpash_id LIKE 'CMP\\_%' GROUP BY role",
        ),
    };

    let total: i64 = sqlx::query_scalar(count_sql)
        .fetch_one(&state.db)
        .await?;
    let by_role = group_count(&state.db, group_sql).await?;

    Ok(Json(MembershipStats {
        scope: scope.into(),
        total: total as u64,
        by_role,
    }))
}

// ── /api/admin/files/stats ──────────────────────────────────────────────

async fn stats_files(State(state): State<AppState>) -> Result<Json<FileStats>, AppError> {
    let total: i64 = db::count_total(&state.db, "project_files").await?;

    // PROJECT-FILES-ACK: type=any — stage histogram for the Home Files
    // tab; every file_type contributes to its stage's count.
    let by_stage = group_count(
        &state.db,
        "SELECT COALESCE(s.stage, 'new') AS stage, COUNT(*)::BIGINT
           FROM project_files f
           LEFT JOIN file_stages s ON s.file_redpash_id = f.redpash_id
          GROUP BY COALESCE(s.stage, 'new')",
    ).await?;

    // PROJECT-FILES-ACK: type=any — file_type histogram; the whole
    // point is to count every type.
    let by_type = group_count(
        &state.db,
        "SELECT file_type, COUNT(*)::BIGINT FROM project_files GROUP BY file_type",
    ).await?;

    // AVG over the non-null subset. Returns NULL if every row is NULL —
    // map that to None so the KPI strip shows a dash instead of 0%.
    //
    // PROJECT-FILES-ACK: type=any — cleanness_pct is only populated
    // on csv rows (chart/dashboard rows store NULL), so the WHERE
    // self-filters; no need to gate by file_type.
    let avg_cleanness: Option<f64> = sqlx::query_scalar(
        "SELECT AVG(cleanness_pct)::DOUBLE PRECISION
           FROM project_files
          WHERE cleanness_pct IS NOT NULL",
    )
    .fetch_one(&state.db)
    .await?;

    Ok(Json(FileStats {
        total: total as u64,
        by_stage,
        by_type,
        avg_cleanness: avg_cleanness.map(|v| v as f32),
    }))
}

// ── /api/admin/charts/stats ─────────────────────────────────────────────

async fn stats_charts(State(state): State<AppState>) -> Result<Json<ChartStats>, AppError> {
    // PROJECT-FILES-ACK: type=chart — Charts tab stats card; all
    // three queries below filter to file_type='chart' inline.
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM project_files WHERE file_type = 'chart'",
    )
    .fetch_one(&state.db)
    .await?;

    // PROJECT-FILES-ACK: type=chart — recent-charts gauge.
    let last_7d: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM project_files
          WHERE file_type = 'chart'
            AND created_at >= now() - interval '7 days'",
    )
    .fetch_one(&state.db)
    .await?;

    // The "report" criterion per the object model: a project counts as
    // a report when it contains ≥1 chart-typed file. So `used_in_reports`
    // = distinct projects that have at least one chart.
    //
    // PROJECT-FILES-ACK: type=chart — distinct projects with ≥1 chart.
    let used_in_reports: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT project_redpash_id)::BIGINT
           FROM project_files
          WHERE file_type = 'chart'",
    )
    .fetch_one(&state.db)
    .await?;

    Ok(Json(ChartStats {
        total: total as u64,
        last_7d: last_7d as u64,
        used_in_reports: used_in_reports as u64,
    }))
}

// ── /api/admin/steps/stats ──────────────────────────────────────────────

async fn stats_steps(State(state): State<AppState>) -> Result<Json<StepStats>, AppError> {
    let total: i64 = db::count_total(&state.db, "project_steps").await?;

    let by_kind = group_count(
        &state.db,
        "SELECT kind, COUNT(*)::BIGINT FROM project_steps GROUP BY kind",
    ).await?;

    let last_24h: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM project_steps
          WHERE created_at >= now() - interval '24 hours'",
    )
    .fetch_one(&state.db)
    .await?;

    Ok(Json(StepStats {
        total: total as u64,
        by_kind,
        last_24h: last_24h as u64,
    }))
}

// ── delete endpoints — wired against the Home tabs' bulk-select ────────
//
// All three are dev-permissive ([[redpash-stage]] — solo-dev / pre-prod;
// production RBAC + soft-delete + audit-gates land in the per-tab admin
// console). FK cascades do the heavy lifting:
//
//   users          → projects (CASCADE), memberships (CASCADE), sessions (CASCADE)
//   companies      → memberships (CASCADE via entities), projects.company_id (SET NULL)
//   memberships    → no cascade; the row itself is the unit of access
//
// 404 if the row is missing; otherwise 204 No Content. Every delete
// emits a `*_delete` event for the audit-trail.

async fn delete_user(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<StatusCode, AppError> {
    // AUTH-AUDIT-ACK: admin endpoints are dev-permissive in v1; the
    // admin-only role gate lands with the RBAC slice. The can't-delete-self
    // guard stays here regardless — it's a footgun independent of RBAC
    // (the scrub flow wipes the caller's own sessions / prefs).
    let caller = super::resolve_user_rid(&state, &headers).await?;
    if rid == caller {
        return Err(AppError::bad_request(
            "invalid",
            "cannot delete your own account",
        ));
    }
    // Scrub-retain (CAS_46BA67713EC84871991D3E7475598B47): admin /admin/users/:rid
    // now runs the 4-step scrub instead of hard DELETE. Sole-owner blocker
    // pre-check returns 409 with the blocking object rids so the admin UI
    // can render "transfer these first" — same gate as routes/users.rs.
    let blocking = db::user_sole_owner_objects(&state.db, &rid).await?;
    if !blocking.is_empty() {
        return Err(AppError::conflict(
            "sole_owner_blocker",
            format!(
                "cannot scrub: user is sole owner of {} object(s); transfer ownership first",
                blocking.len()
            ),
        ));
    }
    let scrubbed = db::scrub_user_tx(&state.db, &rid).await?;
    if !scrubbed {
        return Err(AppError::not_found("not_found", format!("user {rid}")));
    }
    crate::event::warn(&state.db, "user_scrub", format!("scrubbed user {rid}"))
        .user(caller)
        .context(serde_json::json!({ "target_user": rid }))
        .send();
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/admin/fields` — the **field registry** as a redtable (CAS_C4219F2B):
/// one row per object field, with its properties (`is_editable`, `is_sortable`)
/// + the per-role permission state (`owner`/`admin`/`member`/`viewer`) as
/// columns — "how the fields are actually shaped". Returns a `Page<FieldRow>`
/// so the Admin Console renders it through the same redtable reader as every
/// other LIST_VIEWS tab. Slice 1: the static default registry (no overrides
/// yet). GATED to platform admins.
async fn list_fields(
    State(state): State<AppState>,
    headers:      HeaderMap,
) -> Result<Json<Page<crate::field_perms::FieldRow>>, AppError> {
    let caller = super::resolve_user_rid(&state, &headers).await?;
    if !crate::rbac::is_platform_admin(&state, &caller).await? {
        return Err(AppError::not_found("not_found", "fields"));
    }
    let mut rows = state.type_cache.grid_rows();
    // Overlay the sparse field_permissions overrides → served matrix is
    // defaults ⊕ overrides (CAS_C4219F2B slice 2).
    let overrides: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT object_type, field, role, permission FROM field_permissions",
    )
    .fetch_all(&state.db)
    .await?;
    for (obj, field, role, perm) in &overrides {
        if let Some(p) = crate::field_perms::Perm::from_str(perm) {
            if let Some(row) = rows.iter_mut().find(|r| r.object == obj && r.field == field) {
                row.apply_override(role, p);
            }
        }
    }
    let n = rows.len() as u64;
    Ok(Json(Page {
        rows,
        total: n,
        all_count: n,
        page: 1,
        size: n as u32,
        pages: 1,
        ms: 0,
        row_indices: Vec::new(),
    }))
}

#[derive(Deserialize)]
struct FieldPermBody {
    object:     String,
    field:      String,
    role:       String,
    permission: String,
}

/// `PUT /api/admin/fields` — set one `(object, field, role)` cell of the field
/// registry (CAS_C4219F2B slice 2). Body `{object, field, role, permission}`.
/// Validates against the catalog (unknown field → 404; a read-only/computed
/// field can't be granted `write` → 400). Setting a cell back to its catalog
/// default deletes the override row (keeps `field_permissions` sparse).
/// GATED to platform admins. Returns the merged `FieldRow`.
async fn put_field(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Json(body):   Json<FieldPermBody>,
) -> Result<Json<crate::field_perms::FieldRow>, AppError> {
    let caller = super::resolve_user_rid(&state, &headers).await?;
    if !crate::rbac::is_platform_admin(&state, &caller).await? {
        return Err(AppError::not_found("not_found", "fields"));
    }
    if !matches!(body.role.as_str(), "owner" | "admin" | "member" | "viewer") {
        return Err(AppError::bad_request("invalid", "role must be owner, admin, member or viewer"));
    }
    let perm = crate::field_perms::Perm::from_str(&body.permission)
        .ok_or_else(|| AppError::bad_request("invalid", "permission must be write, read or none"))?;
    let def = state.type_cache.find_default(&body.object, &body.field)
        .ok_or_else(|| AppError::not_found("not_found", "unknown object/field"))?;
    if !def.is_editable && perm == crate::field_perms::Perm::Write {
        return Err(AppError::bad_request("read_only", "this field is read-only — it can't be granted write"));
    }

    // Reverting to the catalog default removes the override (keeps it sparse).
    let is_default = def.default_for(&body.role) == Some(perm);
    if is_default {
        sqlx::query("DELETE FROM field_permissions WHERE object_type = $1 AND field = $2 AND role = $3")
            .bind(&body.object).bind(&body.field).bind(&body.role)
            .execute(&state.db).await?;
    } else {
        sqlx::query(
            "INSERT INTO field_permissions (object_type, field, role, permission, updated_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (object_type, field, role)
             DO UPDATE SET permission = EXCLUDED.permission, updated_at = now(), updated_by = EXCLUDED.updated_by",
        )
        .bind(&body.object).bind(&body.field).bind(&body.role).bind(perm.as_str()).bind(&caller)
        .execute(&state.db).await?;
    }
    crate::event::info(&state.db, "field_permission_set",
        format!("{}.{} [{}] -> {}", body.object, body.field, body.role, perm.as_str()))
        .user(caller)
        .context(serde_json::json!({
            "object": body.object, "field": body.field, "role": body.role,
            "permission": perm.as_str(), "reverted_to_default": is_default,
        }))
        .send();

    // Return the merged row (all current overrides for this object/field applied).
    let mut row = def.clone();
    let ovs: Vec<(String, String)> = sqlx::query_as(
        "SELECT role, permission FROM field_permissions WHERE object_type = $1 AND field = $2",
    )
    .bind(&body.object).bind(&body.field)
    .fetch_all(&state.db).await?;
    for (role, p) in &ovs {
        if let Some(pp) = crate::field_perms::Perm::from_str(p) {
            row.apply_override(role, pp);
        }
    }
    Ok(Json(row))
}

// ── /api/admin/types (TypeDefinition contract, CAS_0FBF301F) ──────────────

/// All `field_permissions` override rows `(object_type, field, role, permission)`.
async fn fetch_field_overrides(
    state: &AppState,
) -> Result<Vec<(String, String, String, String)>, AppError> {
    Ok(sqlx::query_as(
        "SELECT object_type, field, role, permission FROM field_permissions",
    )
    .fetch_all(&state.db)
    .await?)
}

/// Stamp the `field_permissions` overrides onto one TypeDefinition's per-role
/// cells — the same `defaults ⊕ overrides` merge as `/admin/fields` (spec §3.2),
/// but written onto the FieldDef cells the `/types` wire shape carries. The
/// permission vocabulary stays single-sourced through `field_perms::Perm`.
fn overlay_overrides(t: &mut TypeDefinition, overrides: &[(String, String, String, String)]) {
    for (obj, field, role, perm) in overrides {
        if &t.type_id != obj {
            continue;
        }
        let Some(p) = crate::field_perms::Perm::from_str(perm) else { continue };
        if let Some(f) = t.fields.iter_mut().find(|f| &f.key == field) {
            let pv = Some(p.as_str().to_string());
            match role.as_str() {
                "owner"  => f.owner = pv,
                "admin"  => f.admin = pv,
                "member" => f.member = pv,
                "viewer" => f.viewer = pv,
                _ => {}
            }
        }
    }
}

/// `GET /api/admin/types` — every builtin object type as a TypeDefinition
/// (identity + fields + relationships + ui_hints), the runtime-typed contract
/// the framework layer consumes instead of hardcoding object types (spec §4.1,
/// CAS_0FBF301F). Each `fields[]` entry carries storage (`data_type`) +
/// presentation (`editor`/`options`/`rel`) + the resolved per-role cells
/// (perm_class default ⊕ field_permissions overrides). GATED to platform admins,
/// same posture as `/admin/fields`.
async fn list_types(
    State(state): State<AppState>,
    headers:      HeaderMap,
) -> Result<Json<TypeList>, AppError> {
    let caller = super::resolve_user_rid(&state, &headers).await?;
    if !crate::rbac::is_platform_admin(&state, &caller).await? {
        return Err(AppError::not_found("not_found", "types"));
    }
    let mut types = state.type_cache.type_defs().to_vec();
    let overrides = fetch_field_overrides(&state).await?;
    for t in &mut types {
        overlay_overrides(t, &overrides);
    }
    Ok(Json(TypeList { types }))
}

/// `GET /api/admin/types/:type` — one builtin TypeDefinition by `type` id
/// (404 if it isn't a builtin type). Same gating + override merge as the list.
async fn get_type(
    State(state):  State<AppState>,
    headers:       HeaderMap,
    Path(type_id): Path<String>,
) -> Result<Json<TypeDefinition>, AppError> {
    let caller = super::resolve_user_rid(&state, &headers).await?;
    if !crate::rbac::is_platform_admin(&state, &caller).await? {
        return Err(AppError::not_found("not_found", "types"));
    }
    let mut td = state.type_cache.type_def(&type_id).cloned()
        .ok_or_else(|| AppError::not_found("not_found", "unknown type"))?;
    let overrides = fetch_field_overrides(&state).await?;
    overlay_overrides(&mut td, &overrides);
    Ok(Json(td))
}

#[derive(Deserialize)]
struct RegisterFieldBody {
    field:       String,
    data_type:   String,
    perm_class:  Option<String>,
    is_sortable: Option<bool>,
    #[serde(default)]
    options:     Vec<String>,
    rel_type:    Option<String>,
    #[serde(default)]
    rel_multi:   bool,
}

#[derive(Deserialize)]
struct RegisterTypeBody {
    type_id:             String,
    rid_prefix:          String,
    display_name:        String,
    display_name_plural: Option<String>,
    rail_icon:           Option<String>,
    #[serde(default)]
    default_columns:     Vec<String>,
    default_sort:        Option<String>,
    grid_served:         Option<bool>,
    #[serde(default)]
    fields:              Vec<RegisterFieldBody>,
}

/// `POST /api/admin/types` — **register_type**: declare a custom object type.
/// Validates (type_id new, rid_prefix free, perm_classes valid) then inserts the
/// `type_definitions` + `type_fields` rows in one tx. The TypeDefCache picks the
/// type up on its next load (restart); a live hot-swap is a follow-on. Once
/// loaded, the generic `/api/objects/:type` handler serves it with zero more code
/// (object-registry Stage 3, CAS_0FBF301F). Platform-admin gated.
async fn register_type(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Json(body):   Json<RegisterTypeBody>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let caller = super::resolve_user_rid(&state, &headers).await?;
    if !crate::rbac::is_platform_admin(&state, &caller).await? {
        return Err(AppError::not_found("not_found", "types"));
    }
    let type_id    = body.type_id.trim().to_lowercase();
    let rid_prefix = body.rid_prefix.trim().to_uppercase();
    if type_id.is_empty() || rid_prefix.is_empty() {
        return Err(AppError::bad_request("invalid", "type_id and rid_prefix are required"));
    }
    if state.type_cache.is_type(&type_id) {
        return Err(AppError::conflict("conflict", format!("type {type_id} already exists")));
    }
    // rid_prefix must not collide with an existing (builtin or custom) prefix.
    if state.type_cache.object_kind(&format!("{rid_prefix}X")) != "unknown" {
        return Err(AppError::bad_request("invalid", format!("rid_prefix {rid_prefix} is already in use")));
    }
    for f in &body.fields {
        let pc = f.perm_class.as_deref().unwrap_or("standard");
        if crate::field_perms::PermClass::from_str(pc).is_none() {
            return Err(AppError::bad_request("invalid", format!("unknown perm_class {pc} on field {}", f.field)));
        }
    }
    let json_arr = |v: &[String]| serde_json::Value::Array(
        v.iter().map(|s| serde_json::Value::String(s.clone())).collect(),
    );
    let next_ord: i32 = sqlx::query_scalar("SELECT COALESCE(MAX(ordinal), -1) + 1 FROM type_definitions")
        .fetch_one(&state.db).await?;

    let mut tx = state.db.begin().await?;
    // The cache check above catches a LOADED duplicate; the DB unique constraints
    // (type_id PK + the partial rid_prefix index) catch a same-session one the
    // stale cache can't see → map 23505 to a clean 409.
    let td_insert = sqlx::query(
        "INSERT INTO type_definitions \
           (type_id, rid_prefix, display_name, display_name_plural, rail_icon, \
            default_columns, default_sort, is_builtin, ordinal, grid_served) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,$8,$9)",
    )
    .bind(&type_id).bind(&rid_prefix).bind(&body.display_name)
    .bind(body.display_name_plural.as_deref().unwrap_or(&body.display_name))
    .bind(&body.rail_icon)
    .bind(json_arr(&body.default_columns))
    .bind(&body.default_sort)
    .bind(next_ord)
    .bind(body.grid_served.unwrap_or(true))
    .execute(&mut *tx).await;
    if let Err(sqlx::Error::Database(ref e)) = td_insert {
        if e.code().as_deref() == Some("23505") {
            return Err(AppError::conflict("conflict", format!("type {type_id} or prefix {rid_prefix} already exists")));
        }
    }
    td_insert?;
    for (i, f) in body.fields.iter().enumerate() {
        sqlx::query(
            "INSERT INTO type_fields \
               (type_id, field, ordinal, data_type, perm_class, is_sortable, options, rel_type, rel_multi) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        )
        .bind(&type_id).bind(&f.field).bind(i as i32)
        .bind(&f.data_type)
        .bind(f.perm_class.as_deref().unwrap_or("standard"))
        .bind(f.is_sortable.unwrap_or(true))
        .bind(json_arr(&f.options))
        .bind(&f.rel_type).bind(f.rel_multi)
        .execute(&mut *tx).await?;
    }
    tx.commit().await?;

    crate::event::info(&state.db, "type_register", format!("registered type {type_id}"))
        .user(caller)
        .context(serde_json::json!({ "type_id": type_id, "rid_prefix": rid_prefix, "fields": body.fields.len() }))
        .send();

    Ok((StatusCode::CREATED, Json(serde_json::json!({
        "type_id":    type_id,
        "rid_prefix": rid_prefix,
        "fields":     body.fields.len(),
        "note":       "type registered; live after the next cache load (restart)",
    }))))
}

/// `GET /api/admin/audit-catalog` — the static-audit half of the Admin Console
/// audit frame (CAS_274EDF3B). One row per tool: its latest run + finding
/// counts (severity-bucketed `low ≤5 / med 6-15 / high >15`, mirroring
/// `/monitoring/audit-findings/stats`) + the **diff vs the previous run**
/// (`new`/`regressed`/`improved`/`fixed`/`unchanged` counts off `audit.run_diff`).
/// The flat run/finding lists already live on `/api/monitoring/audit-*`; this
/// adds the "what changed since last run" dimension nothing exposed yet, plus
/// the per-tool catalog overview. GATED to platform admins. The runtime-event
/// axis of the same frame is `/api/monitoring/events`.
async fn audit_catalog(
    State(state): State<AppState>,
    headers:      HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let caller = super::resolve_user_rid(&state, &headers).await?;
    if !crate::rbac::is_platform_admin(&state, &caller).await? {
        return Err(AppError::not_found("not_found", "audit"));
    }
    // Latest + previous run per tool in one window pass.
    let runs: Vec<(String, i64, DateTime<Utc>, Option<String>, Option<String>, Option<i64>)> =
        sqlx::query_as(
            "WITH ranked AS (
                 SELECT id, tool, ran_at, git_sha, git_branch,
                        row_number() OVER (PARTITION BY tool ORDER BY ran_at DESC) AS rn
                 FROM audit.run)
             SELECT cur.tool, cur.id, cur.ran_at, cur.git_sha, cur.git_branch, prev.id
             FROM ranked cur
             LEFT JOIN ranked prev ON prev.tool = cur.tool AND prev.rn = 2
             WHERE cur.rn = 1
             ORDER BY cur.tool",
        )
        .fetch_all(&state.db)
        .await?;

    let mut tools = Vec::with_capacity(runs.len());
    for (tool, cur_id, ran_at, git_sha, git_branch, prev_id) in runs {
        let buckets: Vec<(String, i64)> = sqlx::query_as(
            "SELECT CASE WHEN severity IS NULL OR severity <= 5 THEN 'low'
                         WHEN severity <= 15 THEN 'med' ELSE 'high' END, count(*)
             FROM audit.finding WHERE run_id = $1 GROUP BY 1",
        )
        .bind(cur_id)
        .fetch_all(&state.db)
        .await?;
        let pick = |k: &str| buckets.iter().find(|(b, _)| b == k).map_or(0, |(_, c)| *c);
        let (high, med, low) = (pick("high"), pick("med"), pick("low"));

        let diff = if let Some(pid) = prev_id {
            let statuses: Vec<(String, i64)> = sqlx::query_as(
                "SELECT status, count(*) FROM audit.run_diff($1, $2) GROUP BY status",
            )
            .bind(cur_id)
            .bind(pid)
            .fetch_all(&state.db)
            .await?;
            let g = |k: &str| statuses.iter().find(|(s, _)| s == k).map_or(0, |(_, c)| *c);
            serde_json::json!({
                "prev_run_id": pid,
                "new":       g("new"),
                "regressed": g("regressed"),
                "improved":  g("improved"),
                "fixed":     g("fixed"),
                "unchanged": g("unchanged"),
            })
        } else {
            serde_json::Value::Null
        };

        tools.push(serde_json::json!({
            "tool":          tool,
            "latest_run_id": cur_id,
            "ran_at":        ran_at,
            "git_sha":       git_sha,
            "git_branch":    git_branch,
            "findings":      { "total": high + med + low, "high": high, "med": med, "low": low },
            "diff":          diff,
        }));
    }
    Ok(Json(serde_json::json!({ "tools": tools })))
}

#[derive(Deserialize)]
struct RbacQuery { subject: String, object: String }

/// `GET /api/admin/rbac?subject=<rid>&object=<rid>` — RBAC introspection
/// (CAS_274EDF3B, the Admin Console slice). Answers "what reach does this
/// subject have on this object, and *why*" straight off the resolver: the
/// reach-split tiers (`direct` / `scope` / `effective`), the platform-admin
/// bypass flag, the subject's principal closure (self + teams), and the
/// contributing membership edges. GATED to platform admins (leak-free 404 —
/// it exposes the org membership graph). The Admin Console FE (co-owned,
/// teams-lane) renders this; shape stays JSON until that tab locks it.
async fn rbac_resolve(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Query(q):     Query<RbacQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let caller = super::resolve_user_rid(&state, &headers).await?;
    if !crate::rbac::is_platform_admin(&state, &caller).await? {
        return Err(AppError::not_found("not_found", "rbac"));
    }
    let subject = q.subject.trim();
    let object = q.object.trim();
    if subject.is_empty() || object.is_empty() {
        return Err(AppError::bad_request("invalid", "subject and object are required"));
    }
    // LEAN SINGLE-USER NEUTER (CAS_C8A9): the multi-tenant resolver
    // (resolve_grant / principals / grant_edges) is deleted — the sole user is
    // a platform admin with full reach. Report the degenerate "sees all" result
    // (no membership-graph edges) without touching the now-gone machinery.
    let subject_is_admin = crate::rbac::is_platform_admin(&state, subject).await?;
    let effective = if subject_is_admin { Some("all") } else { None };
    Ok(Json(serde_json::json!({
        "subject":                   subject,
        "object":                    object,
        "subject_is_platform_admin": subject_is_admin,
        "direct":                    serde_json::Value::Null,
        "scope":                     serde_json::Value::Null,
        "effective":                 effective,
        "principals":                serde_json::json!([]),
        "edges":                     serde_json::json!([]),
    })))
}

#[derive(Deserialize)]
struct PatchUserBody {
    /// Platform role (`admin` | `user`) → `users.role`.
    #[serde(default)] role:     Option<String>,
    /// Role in the user's PRIMARY company (`owner` | `admin` | `member`) →
    /// updates the top company membership.
    #[serde(default)] org_role: Option<String>,
    /// The user's primary company (`CMP_…`) → sets / swaps the top company
    /// membership.
    #[serde(default)] org_id:   Option<String>,
}

/// The user's TOP company membership as `(company_rid, role, context_role)`, or
/// None. Mirrors the precedence + LATERAL pick in `list_users` (owner > admin >
/// member, then most-recent) so `org_role` / `org` edits target the SAME
/// membership the Users tab shows.
async fn top_company_membership(
    pool:     &sqlx::PgPool,
    user_rid: &str,
) -> Result<Option<(String, String, String)>, AppError> {
    Ok(sqlx::query_as::<_, (String, String, String)>(
        "SELECT object_redpash_id, role, context_role
           FROM memberships
          WHERE member_redpash_id = $1 AND object_redpash_id LIKE 'CMP\\_%'
          ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
                   joined_at DESC
          LIMIT 1",
    )
    .bind(user_rid)
    .fetch_optional(pool)
    .await?)
}

/// True if a sqlx error is a Postgres unique-violation (SQLSTATE 23505) — used
/// to turn a membership PK collision into a clean 409 instead of a 500.
fn is_unique_violation(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .and_then(|d| d.code())
        .map_or(false, |c| c == "23505")
}

/// `PATCH /api/admin/users/:rid` — mutate a user's platform role and/or their
/// primary-company affiliation. All body fields optional; each present field is
/// applied independently (the Home Users tab edits one cell at a time):
///   - `role`     → platform role (`admin`|`user`); CAS_D78667D1 option (b),
///                  the UI path to grant platform-admin, with a **last-admin
///                  guard** (never strand the platform with zero admins).
///   - `org_role` → role in the user's top company membership (owner/admin/member).
///   - `org_id`   → set (if none) or swap the user's primary company (`CMP_…`),
///                  keeping the existing role on a swap.
/// **Gated** to platform admins (leak-free 404) — every field is an
/// org-management mutation. Backs the editable Role + Org cells on the Users tab.
async fn patch_user_role(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<PatchUserBody>,
) -> Result<StatusCode, AppError> {
    let caller = super::resolve_user_rid(&state, &headers).await?;
    if !crate::rbac::is_platform_admin(&state, &caller).await? {
        // Leak-free: a non-admin can't distinguish "no such endpoint/user".
        return Err(AppError::not_found("not_found", format!("user {rid}")));
    }
    // Confirm the target exists once (404 otherwise); grab the current platform
    // role for the last-admin guard.
    let current_role = sqlx::query_as::<_, (String,)>("SELECT role FROM users WHERE redpash_id = $1")
        .bind(&rid)
        .fetch_optional(&state.db)
        .await?
        .map(|(r,)| r)
        .ok_or_else(|| AppError::not_found("not_found", format!("user {rid}")))?;

    // ── platform role ──────────────────────────────────────────────────────
    if let Some(role) = body.role.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if !matches!(role, "admin" | "user") {
            return Err(AppError::bad_request("invalid", "role must be admin or user"));
        }
        // Last-admin guard — demoting the only platform admin locks everyone out.
        if current_role == "admin" && role == "user" {
            let admin_count = sqlx::query_as::<_, (i64,)>("SELECT count(*) FROM users WHERE role = 'admin'")
                .fetch_one(&state.db).await?.0;
            if admin_count <= 1 {
                return Err(AppError::conflict("last_admin", "cannot demote the last platform admin"));
            }
        }
        if role != current_role {
            sqlx::query("UPDATE users SET role = $1 WHERE redpash_id = $2")
                .bind(role).bind(&rid).execute(&state.db).await?;
            crate::event::warn(&state.db, "user_role_change", format!("{rid} role: {current_role} -> {role}"))
                .user(caller.clone())
                .context(serde_json::json!({ "target_user": rid, "prior_role": current_role, "new_role": role }))
                .send();
        }
    }

    // ── org_role: role in the user's primary company membership ──────────────
    if let Some(new_role) = body.org_role.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let company_ok = state.type_cache.scope_roles("company")
            .is_some_and(|sr| sr.roles.contains(&new_role));
        if !company_ok {
            return Err(AppError::bad_request("invalid", "org_role must be one of: owner, admin, member"));
        }
        let (company, cur, ctx) = top_company_membership(&state.db, &rid)
            .await?
            .ok_or_else(|| AppError::not_found("not_found", "user has no company membership — set an org first"))?;
        if cur != new_role {
            // role is part of the membership PK → the UPDATE can collide with an
            // existing (company, user, new_role, ctx) row.
            let res = sqlx::query(
                "UPDATE memberships SET role = $1
                  WHERE object_redpash_id = $2 AND member_redpash_id = $3
                    AND role = $4 AND context_role = $5",
            )
            .bind(new_role).bind(&company).bind(&rid).bind(&cur).bind(&ctx)
            .execute(&state.db).await;
            match res {
                Ok(_) => {}
                Err(e) if is_unique_violation(&e) => {
                    return Err(AppError::conflict("conflict", "user already holds that role in this company"));
                }
                Err(e) => return Err(e.into()),
            }
            crate::event::info(&state.db, "user_org_role_change",
                format!("{rid} org_role @ {company}: {cur} -> {new_role}"))
                .user(caller.clone())
                .context(serde_json::json!({ "target_user": rid, "company": company, "prior_role": cur, "new_role": new_role }))
                .send();
        }
    }

    // ── org_id: set / swap the user's primary company ────────────────────────
    if let Some(org_id) = body.org_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if !org_id.starts_with("CMP_") {
            return Err(AppError::bad_request("invalid", "org_id must be a company id (CMP_…)"));
        }
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM companies WHERE redpash_id = $1)")
            .bind(org_id).fetch_one(&state.db).await?;
        if !exists {
            return Err(AppError::not_found("not_found", format!("company {org_id}")));
        }
        match top_company_membership(&state.db, &rid).await? {
            // No current company → assign one (default 'member').
            None => {
                sqlx::query(
                    "INSERT INTO memberships (object_redpash_id, member_redpash_id, role, context_role)
                     VALUES ($1, $2, 'member', '')",
                )
                .bind(org_id).bind(&rid).execute(&state.db).await
                .map_err(|e| if is_unique_violation(&e) {
                    AppError::conflict("conflict", "user already a member of that company")
                } else { e.into() })?;
                crate::event::info(&state.db, "user_org_set", format!("{rid} org set -> {org_id}"))
                    .user(caller.clone())
                    .context(serde_json::json!({ "target_user": rid, "company": org_id }))
                    .send();
            }
            // Different company → re-point the membership (keep role + context).
            Some((cur_co, cur_role, ctx)) if cur_co != org_id => {
                let mut tx = state.db.begin().await?;
                sqlx::query(
                    "DELETE FROM memberships
                      WHERE object_redpash_id = $1 AND member_redpash_id = $2
                        AND role = $3 AND context_role = $4",
                )
                .bind(&cur_co).bind(&rid).bind(&cur_role).bind(&ctx)
                .execute(&mut *tx).await?;
                let ins = sqlx::query(
                    "INSERT INTO memberships (object_redpash_id, member_redpash_id, role, context_role)
                     VALUES ($1, $2, $3, $4)",
                )
                .bind(org_id).bind(&rid).bind(&cur_role).bind(&ctx)
                .execute(&mut *tx).await;
                match ins {
                    Ok(_) => tx.commit().await?,
                    Err(e) if is_unique_violation(&e) => {
                        tx.rollback().await.ok();
                        return Err(AppError::conflict("conflict", "user already a member of that company"));
                    }
                    Err(e) => {
                        tx.rollback().await.ok();
                        return Err(e.into());
                    }
                }
                crate::event::info(&state.db, "user_org_change", format!("{rid} org: {cur_co} -> {org_id}"))
                    .user(caller.clone())
                    .context(serde_json::json!({ "target_user": rid, "prior_company": cur_co, "new_company": org_id, "role": cur_role }))
                    .send();
            }
            // Same company → no-op.
            Some(_) => {}
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn delete_company(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<StatusCode, AppError> {
    // AUTH-AUDIT-ACK: same dev-permissive stance as delete_user.
    let caller = super::resolve_user_rid(&state, &headers).await?;
    let removed = db::delete_company(&state.db, &rid).await?;
    if !removed {
        return Err(AppError::not_found("not_found", format!("company {rid}")));
    }
    crate::event::warn(&state.db, "company_delete", format!("deleted company {rid}"))
        .user(caller)
        .context(serde_json::json!({ "company": rid }))
        .send();
    Ok(StatusCode::NO_CONTENT)
}

// Per-scope role allow-lists (system + context) now live in `type_scope_roles`,
// read via `state.type_cache.scope_roles(scope)` (object-registry Stage 1).

#[derive(Deserialize)]
struct CreateMembershipBody {
    scope:    String,        // "project" | "company" | "case" | "team"
    scope_id: String,        // PRJ_ / CMP_ / CAS_ / TEM_
    user_id:  String,        // USR_…
    /// Optional system role. Defaults per scope (viewer / member) to
    /// match the SQL column default. Validated against the per-scope
    /// allow-list.
    #[serde(default)] role: Option<String>,
    /// Optional free-text business label ("Reporter", "CEO", etc.).
    /// Bounded at the API boundary by *_CONTEXT_ROLES so typos don't
    /// silently fragment the category. Stored NULL when omitted.
    #[serde(default)] context_role: Option<String>,
}

/// Create a membership row in the unified `memberships` table (the
/// object rid carries the scope); `scope` drives only the role
/// allow-list + field-validation, then a single INSERT. Returns 201 with
/// the bare membership triple so the FE can
/// reconstruct the synthetic rid without an extra GET; the full
/// MembershipSummary is recoverable via /api/admin/memberships (the
/// FE refetches after a successful POST anyway).
///
/// Errors:
///   - 400 invalid scope / role / empty id
///   - 404 if scope_id or user_id doesn't exist (FK 23503 → not_found)
///   - 409 if the (scope_id, user_id) pair already has a membership
///     (PK 23505 → conflict)
async fn create_membership(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Json(body):   Json<CreateMembershipBody>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let caller = super::resolve_user_rid(&state, &headers).await?;
    let scope    = body.scope.trim();
    let scope_id = body.scope_id.trim();
    let user_id  = body.user_id.trim();
    if scope_id.is_empty() || user_id.is_empty() {
        return Err(AppError::bad_request("invalid", "scope_id and user_id are required"));
    }
    let sr = state.type_cache.scope_roles(scope).ok_or_else(|| AppError::bad_request(
        "invalid",
        "scope must be one of: project, company, case, team",
    ))?;
    let (role_allow, ctx_allow, role_default) = (&sr.roles, &sr.context_roles, sr.default_role);
    // Default per migration column-default (viewer / member). The SQL
    // DEFAULT would handle this if we omitted the column, but binding
    // explicitly keeps the audit event accurate.
    let role_owned: String = body.role
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(role_default)
        .to_string();
    if !role_allow.contains(&role_owned.as_str()) {
        return Err(AppError::bad_request(
            "invalid",
            format!("role for {scope} must be one of: {}", role_allow.join(", ")),
        ));
    }
    // Optional context_role: trim, drop-on-blank, then bound by the
    // per-scope allow-list. None / empty is valid (most project +
    // company memberships don't carry one).
    let context_role_owned: Option<String> = body.context_role
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(ref ctx) = context_role_owned {
        if !ctx_allow.contains(&ctx.as_str()) {
            return Err(AppError::bad_request(
                "invalid",
                format!(
                    "context_role for {scope} must be one of: {} (or empty)",
                    ctx_allow.join(", "),
                ),
            ));
        }
    }
    // Mirror the db::insert_membership None→"" coercion so the response
    // echoes the actual persisted row (empty string, not null) — keeps
    // wire shape consistent with /api/admin/memberships list output.
    let stored_context_role: &str = context_role_owned.as_deref().unwrap_or("");
    match db::insert_membership(
        &state.db, scope, scope_id, user_id, &role_owned,
        context_role_owned.as_deref(),
    ).await {
        Ok(()) => {
            crate::event::info(
                &state.db,
                "membership_create",
                format!("added {role_owned} {scope} membership: {user_id} → {scope_id}"),
            )
            .user(caller)
            .context(serde_json::json!({
                "scope":        scope,
                "scope_id":     scope_id,
                "user_id":      user_id,
                "role":         role_owned,
                "context_role": stored_context_role,
            }))
            .send();
            Ok((
                StatusCode::CREATED,
                Json(serde_json::json!({
                    "scope":        scope,
                    "scope_id":     scope_id,
                    "user_id":      user_id,
                    "role":         role_owned,
                    "context_role": stored_context_role,
                })),
            ))
        }
        Err(sqlx::Error::Database(e)) => match e.code().as_deref() {
            Some("23503") => Err(AppError::not_found(
                "not_found",
                format!("{scope} or user not found"),
            )),
            Some("23505") => Err(AppError::conflict(
                "membership_exists",
                "membership already exists for this user + scope",
            )),
            _ => Err(AppError::internal("db", e.to_string())),
        },
        Err(e) => Err(AppError::internal("db", e.to_string())),
    }
}

/// Memberships have a composite primary key (scope_id + user_id), so
/// the path-rid is a synthetic triple: `{scope}:{scope_id}:{user_id}`.
/// Frontend constructs it from the MembershipSummary row; the handler
/// parses + dispatches to the right table.
async fn delete_membership(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<StatusCode, AppError> {
    let caller = super::resolve_user_rid(&state, &headers).await?;
    let parts: Vec<&str> = rid.split(':').collect();
    if parts.len() != 3 {
        return Err(AppError::bad_request(
            "invalid",
            "memberships rid must be {scope}:{scope_id}:{user_id}",
        ));
    }
    let (scope, scope_id, user_id) = (parts[0], parts[1], parts[2]);
    if scope != "project" && scope != "company" && scope != "case" && scope != "team" {
        return Err(AppError::bad_request(
            "invalid",
            "scope must be one of: project, company, case, team",
        ));
    }
    let removed = db::delete_membership(&state.db, scope, scope_id, user_id).await?;
    if !removed {
        return Err(AppError::not_found("not_found", format!("membership {rid}")));
    }
    crate::event::warn(
        &state.db,
        "membership_delete",
        format!("removed {scope} membership {user_id} from {scope_id}"),
    )
    .user(caller)
    .context(serde_json::json!({
        "scope":    scope,
        "scope_id": scope_id,
        "user_id":  user_id,
    }))
    .send();
    Ok(StatusCode::NO_CONTENT)
}
