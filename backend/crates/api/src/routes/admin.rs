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
use chrono::Utc;
use serde::Deserialize;
use shared::{
    admin::{
        AdminFileSummary, ChartStats, ChartSummary, CompanyStats, FileStats,
        MembershipStats, MembershipSummary, StepStats, StepSummary, UserStats,
        UserSummary,
    },
    company::{Company, CompanySummary},
    Page,
};
use std::collections::HashMap;
use sqlx::Row;

use crate::{db, error::AppError, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/users",             get(list_users))
        .route("/users/stats",       get(stats_users))
        .route("/users/:rid",        axum::routing::delete(delete_user))
        .route("/companies",         get(list_companies))
        .route("/companies/stats",   get(stats_companies))
        .route("/companies/:rid",    axum::routing::delete(delete_company))
        .route("/memberships",       get(list_memberships))
        .route("/memberships/stats", get(stats_memberships))
        // Memberships use a synthetic compound rid in the path —
        // `{scope}:{scope_redpash_id}:{user_redpash_id}` — since the
        // table's primary key is composite. delete_membership parses
        // and dispatches to the right table.
        .route("/memberships/:rid",  axum::routing::delete(delete_membership))
        .route("/files",             get(list_files))
        .route("/files/stats",       get(stats_files))
        .route("/charts",            get(list_charts))
        .route("/charts/stats",      get(stats_charts))
        .route("/steps",             get(list_steps))
        .route("/steps/stats",       get(stats_steps))
}

// ── shared query plumbing (private to this module) ──────────────────────

use super::pagination::{build_page, paginate};

#[derive(Deserialize)]
struct AdminQuery {
    #[serde(default)] page: Option<u32>,
    #[serde(default)] size: Option<u32>,
    #[serde(default)] q:    Option<String>, // free-text search where applicable
    /// Click-to-sort header support. Validated against the per-endpoint
    /// SORTABLE_* allowlist; bad / missing values fall back to each
    /// handler's default column. `dir` → "asc"|"desc" (default "desc").
    #[serde(default)] sort: Option<String>,
    #[serde(default)] dir:  Option<String>,
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
    "display_name", "username", "email", "plan", "job_title",
    "organisation", "org_name", "org_role", "created_at",
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
        "username"     => "u.username",
        "email"        => "u.email",
        "plan"         => "u.plan",
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

    // LEFT JOIN LATERAL pulls the user's "top" company_memberships row:
    // owner before admin before member, ties broken by most-recent
    // joined_at. One company per user — the Home Users tab shows the
    // primary org affiliation, multi-org users can drill into
    // /admin/memberships for the full list.
    // ORDER BY built via format! — sort_col comes from the SORTABLE_USERS
    // allowlist (never user input directly). SQL injection closed at the
    // sort_clause boundary. NULLS LAST keeps users without an org_name /
    // job_title at the tail regardless of dir.
    let sql = format!(
        "SELECT u.redpash_id, u.username, u.email, u.display_name, u.avatar_url,
                u.job_title, u.organisation, u.plan, u.created_at,
                m.company_id   AS org_id,
                m.company_name AS org_name,
                m.role         AS org_role
           FROM users u
           LEFT JOIN LATERAL (
             SELECT cm.company_id, c.name AS company_name, cm.role
               FROM company_memberships cm
               JOIN companies c ON c.redpash_id = cm.company_id
              WHERE cm.user_redpash_id = u.redpash_id
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
            avatar_url:   r.try_get("avatar_url").ok(),
            job_title:    r.try_get("job_title").ok(),
            organisation: r.try_get("organisation").ok(),
            plan:         r.try_get("plan").unwrap_or_default(),
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
    Query(q):     Query<AdminQuery>,
) -> Result<Json<Page<CompanySummary>>, AppError> {
    let started = Instant::now();
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

    let sql = format!(
        "SELECT c.redpash_id, c.name, c.slug, c.avatar_url,
                c.created_at, c.updated_at,
                (SELECT COUNT(*)::INT FROM company_memberships m WHERE m.company_id = c.redpash_id) AS member_count
           FROM companies c
          WHERE ($1::text IS NULL OR c.name ILIKE '%' || $1 || '%' OR c.slug ILIKE '%' || $1 || '%')
          ORDER BY {sort_col} {sort_dir} NULLS LAST
          LIMIT $2 OFFSET $3"
    );
    let rows = sqlx::query(&sql)
    .bind(q.q.as_deref())
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
            // Admin view — no per-caller role here. RBAC will gate the
            // endpoint itself; for now my_role stays unset.
            my_role: None,
        })
        .collect();

    Ok(Json(build_page(rows, total as u64, all_count as u64, page, size, started)))
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
    if scope != "project" && scope != "company" {
        return Err(AppError::bad_request(
            "admin",
            "scope must be one of: project, company",
        ));
    }

    let (sort_key, sort_dir) = sort_clause(
        q.sort.as_deref(), q.dir.as_deref(), SORTABLE_MEMBERSHIPS, "joined_at",
    );
    // The two scope-specific queries share aliases (user_display_name,
    // scope_name, role, joined_at) so the same sort_col resolves against
    // either branch.
    let sort_col = match sort_key.as_str() {
        "user_display_name" => "u.display_name",
        "user_username"     => "u.username",
        "scope_name"        => match scope { "project" => "p.name", _ => "c.name" },
        // "scope" is a literal column emitted by the SELECT — a
        // single string per response since the WHERE filters by it.
        // Sorting by it is a no-op within a single result set; keep
        // it in the allowlist so the FE chevron still works but the
        // ORDER BY targets the constant alias.
        "scope"             => "scope",
        "role"              => "m.role",
        _                   => "m.joined_at",
    };

    // all_count = total across BOTH scopes (the rail tab's "everything"
    // count). total = scope+role-filtered count.
    let all_count: i64 = sqlx::query_scalar(
        "SELECT
           (SELECT COUNT(*) FROM project_memberships) +
           (SELECT COUNT(*) FROM company_memberships)",
    )
    .fetch_one(&state.db)
    .await?;

    // Scope-specific query — two different tables with parallel schemas.
    // Joined to users (display_name + username) and the scope parent
    // (project name or company name) so the row renders without a
    // second lookup. ORDER BY built via format! with sort_col sourced
    // from SORTABLE_MEMBERSHIPS allowlist. ?q= searches user_display_name
    // / user_username / scope_name (project or company name) via ILIKE.
    let count_sql = if scope == "project" {
        "SELECT COUNT(*)::BIGINT
           FROM project_memberships m
           JOIN projects p ON p.redpash_id = m.project_redpash_id
           JOIN users    u ON u.redpash_id = m.user_redpash_id
          WHERE ($1::text IS NULL OR m.role = $1)
            AND ($2::text IS NULL OR
                 u.display_name ILIKE '%' || $2 || '%' OR
                 u.username     ILIKE '%' || $2 || '%' OR
                 p.name         ILIKE '%' || $2 || '%')"
    } else {
        "SELECT COUNT(*)::BIGINT
           FROM company_memberships m
           JOIN companies c ON c.redpash_id = m.company_id
           JOIN users     u ON u.redpash_id = m.user_redpash_id
          WHERE ($1::text IS NULL OR m.role = $1)
            AND ($2::text IS NULL OR
                 u.display_name ILIKE '%' || $2 || '%' OR
                 u.username     ILIKE '%' || $2 || '%' OR
                 c.name         ILIKE '%' || $2 || '%')"
    };
    let rows_sql = if scope == "project" {
        format!(
            "SELECT 'project' AS scope,
                    m.project_redpash_id     AS scope_redpash_id,
                    p.name                   AS scope_name,
                    m.user_redpash_id        AS user_redpash_id,
                    u.display_name           AS user_display_name,
                    u.username               AS user_username,
                    m.role                   AS role,
                    m.joined_at              AS joined_at
               FROM project_memberships m
               JOIN projects p ON p.redpash_id = m.project_redpash_id
               JOIN users    u ON u.redpash_id = m.user_redpash_id
              WHERE ($1::text IS NULL OR m.role = $1)
                AND ($2::text IS NULL OR
                     u.display_name ILIKE '%' || $2 || '%' OR
                     u.username     ILIKE '%' || $2 || '%' OR
                     p.name         ILIKE '%' || $2 || '%')
              ORDER BY {sort_col} {sort_dir} NULLS LAST
              LIMIT $3 OFFSET $4"
        )
    } else {
        format!(
            "SELECT 'company' AS scope,
                    m.company_id     AS scope_redpash_id,
                    c.name           AS scope_name,
                    m.user_redpash_id AS user_redpash_id,
                    u.display_name   AS user_display_name,
                    u.username       AS user_username,
                    m.role           AS role,
                    m.joined_at      AS joined_at
               FROM company_memberships m
               JOIN companies c ON c.redpash_id = m.company_id
               JOIN users     u ON u.redpash_id = m.user_redpash_id
              WHERE ($1::text IS NULL OR m.role = $1)
                AND ($2::text IS NULL OR
                     u.display_name ILIKE '%' || $2 || '%' OR
                     u.username     ILIKE '%' || $2 || '%' OR
                     c.name         ILIKE '%' || $2 || '%')
              ORDER BY {sort_col} {sort_dir} NULLS LAST
              LIMIT $3 OFFSET $4"
        )
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
            user_redpash_id:   r.try_get("user_redpash_id").unwrap_or_default(),
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

    // Charts live in project_files with file_type='chart'. Two counts:
    //   all_count — every chart row ever (the Charts tab's true total).
    //   total     — post-search filter.
    //
    // PROJECT-FILES-ACK: type=chart — admin Charts tab; all three
    // queries below filter to file_type='chart' inline.
    let all_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM project_files WHERE file_type = 'chart'",
    )
    .fetch_one(&state.db)
    .await?;

    // PROJECT-FILES-ACK: type=chart — post-search count for the Charts tab.
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM project_files
         WHERE file_type = 'chart'
           AND ($1::text IS NULL OR
                filename                 ILIKE '%' || $1 || '%' OR
                COALESCE(display_name, '') ILIKE '%' || $1 || '%')",
    )
    .bind(q.q.as_deref())
    .fetch_one(&state.db)
    .await?;

    // PROJECT-FILES-ACK: type=chart — row data for the Charts tab.
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
          WHERE f.file_type = 'chart'
            AND ($1::text IS NULL OR
                 f.filename                 ILIKE '%' || $1 || '%' OR
                 COALESCE(f.display_name, '') ILIKE '%' || $1 || '%')
          ORDER BY {sort_col} {sort_dir} NULLS LAST
          LIMIT $2 OFFSET $3"
    );
    let rows = sqlx::query(&sql)
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

    Ok(Json(build_page(rows, total as u64, all_count as u64, page, size, started)))
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
    if scope != "project" && scope != "company" {
        return Err(AppError::bad_request(
            "admin",
            "scope must be one of: project, company",
        ));
    }

    let (count_sql, group_sql) = if scope == "project" {
        (
            "SELECT COUNT(*)::BIGINT FROM project_memberships",
            "SELECT role, COUNT(*)::BIGINT FROM project_memberships GROUP BY role",
        )
    } else {
        (
            "SELECT COUNT(*)::BIGINT FROM company_memberships",
            "SELECT role, COUNT(*)::BIGINT FROM company_memberships GROUP BY role",
        )
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
//   companies      → company_memberships (CASCADE), projects.company_id (SET NULL)
//   memberships    → no cascade; the row itself is the unit of access
//
// 404 if the row is missing; otherwise 204 No Content. Every delete
// emits a `*_delete` event for the audit-trail.

async fn delete_user(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<StatusCode, AppError> {
    // AUTH-AUDIT-ACK: admin endpoints are dev-permissive in v1; RBAC
    // gate (admin-only + can't-delete-self) lands with the RBAC slice.
    let caller = super::resolve_user_rid(&state, &headers).await?;
    let removed = db::delete_user(&state.db, &rid).await?;
    if !removed {
        return Err(AppError::not_found("not_found", format!("user {rid}")));
    }
    crate::event::record(&state.db, crate::event::EventDraft {
        origin:  "backend",
        level:   "warn",
        kind:    "user_delete".into(),
        message: format!("deleted user {rid}"),
        user:    Some(caller),
        context: serde_json::json!({ "target_user": rid }),
        ..Default::default()
    });
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
    crate::event::record(&state.db, crate::event::EventDraft {
        origin:  "backend",
        level:   "warn",
        kind:    "company_delete".into(),
        message: format!("deleted company {rid}"),
        user:    Some(caller),
        context: serde_json::json!({ "company": rid }),
        ..Default::default()
    });
    Ok(StatusCode::NO_CONTENT)
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
    if scope != "project" && scope != "company" {
        return Err(AppError::bad_request(
            "invalid",
            "scope must be one of: project, company",
        ));
    }
    let removed = db::delete_membership(&state.db, scope, scope_id, user_id).await?;
    if !removed {
        return Err(AppError::not_found("not_found", format!("membership {rid}")));
    }
    crate::event::record(&state.db, crate::event::EventDraft {
        origin:  "backend",
        level:   "warn",
        kind:    "membership_delete".into(),
        message: format!("removed {scope} membership {user_id} from {scope_id}"),
        user:    Some(caller),
        context: serde_json::json!({
            "scope":    scope,
            "scope_id": scope_id,
            "user_id":  user_id,
        }),
        ..Default::default()
    });
    Ok(StatusCode::NO_CONTENT)
}
