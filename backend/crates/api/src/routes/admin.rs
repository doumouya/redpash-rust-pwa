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
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use chrono::Utc;
use serde::Deserialize;
use shared::{
    admin::{AdminFileSummary, ChartSummary, MembershipSummary, StepSummary, UserSummary},
    company::{Company, CompanySummary},
    Page,
};
use sqlx::Row;

use crate::{error::AppError, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/users",       get(list_users))
        .route("/companies",   get(list_companies))
        .route("/memberships", get(list_memberships))
        .route("/files",       get(list_files))
        .route("/charts",      get(list_charts))
        .route("/steps",       get(list_steps))
}

// ── shared query plumbing (private to this module) ──────────────────────

const DEFAULT_PAGE_SIZE: u32 = 50;
const MAX_PAGE_SIZE: u32 = 500;

#[derive(Deserialize)]
struct AdminQuery {
    #[serde(default)] page: Option<u32>,
    #[serde(default)] size: Option<u32>,
    #[serde(default)] q:    Option<String>, // free-text search where applicable
}

#[derive(Deserialize)]
struct MembershipsQuery {
    #[serde(default)] page:  Option<u32>,
    #[serde(default)] size:  Option<u32>,
    /// `project` | `company`. Required; defaults to `project` to keep
    /// the endpoint usable without a query string.
    #[serde(default)] scope: Option<String>,
    #[serde(default)] role:  Option<String>,
}

#[derive(Deserialize)]
struct FilesQuery {
    #[serde(default)] page:      Option<u32>,
    #[serde(default)] size:      Option<u32>,
    #[serde(default)] file_type: Option<String>,
    /// Filter by computed `file_stages.stage` (import | clean | report | publish).
    #[serde(default)] stage:     Option<String>,
    #[serde(default)] project:   Option<String>, // project_redpash_id
}

#[derive(Deserialize)]
struct StepsQuery {
    #[serde(default)] page:    Option<u32>,
    #[serde(default)] size:    Option<u32>,
    #[serde(default)] file:    Option<String>, // file_redpash_id
    #[serde(default)] kind:    Option<String>,
    #[serde(default)] applied: Option<bool>,
}

fn paginate(page: Option<u32>, size: Option<u32>) -> (i64, u32, u32) {
    let size = size.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);
    let page = page.unwrap_or(1).max(1);
    let offset = ((page - 1) as i64) * (size as i64);
    (offset, size, page)
}

fn build_page<T>(
    rows: Vec<T>,
    total: u64,
    all_count: u64,
    page: u32,
    size: u32,
    started: Instant,
) -> Page<T> {
    let pages = if total == 0 {
        0
    } else {
        ((total + size as u64 - 1) / size as u64) as u32
    };
    Page {
        rows,
        total,
        all_count,
        page,
        size,
        pages,
        ms: started.elapsed().as_millis() as u32,
        row_indices: Vec::new(),
    }
}

// ── /api/admin/users ────────────────────────────────────────────────────

async fn list_users(
    State(state): State<AppState>,
    Query(q):     Query<AdminQuery>,
) -> Result<Json<Page<UserSummary>>, AppError> {
    let started = Instant::now();
    let (offset, size, page) = paginate(q.page, q.size);

    let all_count: i64 = sqlx::query_scalar("SELECT COUNT(*)::BIGINT FROM users")
        .fetch_one(&state.db)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?;

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
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

    let rows = sqlx::query(
        "SELECT redpash_id, username, email, display_name, avatar_url,
                job_title, organisation, plan, created_at
           FROM users
          WHERE ($1::text IS NULL OR
                 username     ILIKE '%' || $1 || '%' OR
                 display_name ILIKE '%' || $1 || '%' OR
                 COALESCE(email,        '') ILIKE '%' || $1 || '%' OR
                 COALESCE(organisation, '') ILIKE '%' || $1 || '%')
          ORDER BY created_at DESC
          LIMIT $2 OFFSET $3",
    )
    .bind(q.q.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

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
            created_at:   r.try_get("created_at").unwrap_or_else(|_| Utc::now()),
        })
        .collect();

    Ok(Json(build_page(rows, total as u64, all_count as u64, page, size, started)))
}

// ── /api/admin/companies ────────────────────────────────────────────────

async fn list_companies(
    State(state): State<AppState>,
    Query(q):     Query<AdminQuery>,
) -> Result<Json<Page<CompanySummary>>, AppError> {
    let started = Instant::now();
    let (offset, size, page) = paginate(q.page, q.size);

    let all_count: i64 = sqlx::query_scalar("SELECT COUNT(*)::BIGINT FROM companies")
        .fetch_one(&state.db)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM companies
         WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR slug ILIKE '%' || $1 || '%')",
    )
    .bind(q.q.as_deref())
    .fetch_one(&state.db)
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

    let rows = sqlx::query(
        "SELECT c.redpash_id, c.name, c.slug, c.avatar_url,
                c.created_at, c.updated_at,
                (SELECT COUNT(*)::INT FROM company_memberships m WHERE m.company_id = c.redpash_id) AS member_count
           FROM companies c
          WHERE ($1::text IS NULL OR c.name ILIKE '%' || $1 || '%' OR c.slug ILIKE '%' || $1 || '%')
          ORDER BY c.created_at DESC
          LIMIT $2 OFFSET $3",
    )
    .bind(q.q.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

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

    // all_count = total across BOTH scopes (the rail tab's "everything"
    // count). total = scope+role-filtered count.
    let all_count: i64 = sqlx::query_scalar(
        "SELECT
           (SELECT COUNT(*) FROM project_memberships) +
           (SELECT COUNT(*) FROM company_memberships)",
    )
    .fetch_one(&state.db)
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

    // Scope-specific query — two different tables with parallel schemas.
    // Joined to users (display_name + username) and the scope parent
    // (project name or company name) so the row renders without a
    // second lookup.
    let (count_sql, rows_sql) = if scope == "project" {
        (
            "SELECT COUNT(*)::BIGINT FROM project_memberships m
             WHERE ($1::text IS NULL OR m.role = $1)",
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
              ORDER BY m.joined_at DESC
              LIMIT $2 OFFSET $3",
        )
    } else {
        (
            "SELECT COUNT(*)::BIGINT FROM company_memberships m
             WHERE ($1::text IS NULL OR m.role = $1)",
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
              ORDER BY m.joined_at DESC
              LIMIT $2 OFFSET $3",
        )
    };

    let total: i64 = sqlx::query_scalar(count_sql)
        .bind(q.role.as_deref())
        .fetch_one(&state.db)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?;

    let rows = sqlx::query(rows_sql)
        .bind(q.role.as_deref())
        .bind(size as i64)
        .bind(offset)
        .fetch_all(&state.db)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?;

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

async fn list_files(
    State(state): State<AppState>,
    Query(q):     Query<FilesQuery>,
) -> Result<Json<Page<AdminFileSummary>>, AppError> {
    let started = Instant::now();
    let (offset, size, page) = paginate(q.page, q.size);

    let all_count: i64 = sqlx::query_scalar("SELECT COUNT(*)::BIGINT FROM project_files")
        .fetch_one(&state.db)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?;

    // `status` was dropped in the object-model hard-refresh; `file_stages.stage`
    // is the computed replacement (import | clean | report | publish). LEFT JOIN
    // because a brand-new file row predates its file_stages entry by a
    // transaction tick — render those as the default `import` stage rather
    // than dropping them from the list.
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT
           FROM project_files f
           LEFT JOIN file_stages s ON s.file_redpash_id = f.redpash_id
          WHERE ($1::text IS NULL OR f.file_type = $1)
            AND ($2::text IS NULL OR COALESCE(s.stage, 'import') = $2)
            AND ($3::text IS NULL OR f.project_redpash_id = $3)",
    )
    .bind(q.file_type.as_deref())
    .bind(q.stage.as_deref())
    .bind(q.project.as_deref())
    .fetch_one(&state.db)
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

    let rows = sqlx::query(
        "SELECT f.redpash_id, f.project_redpash_id,
                p.name AS project_name,
                f.filename, f.display_name, f.file_type,
                COALESCE(s.stage, 'import') AS stage,
                f.row_count, f.col_count, f.file_size_bytes, f.cleanness_pct,
                f.created_at, f.updated_at
           FROM project_files f
           JOIN projects p ON p.redpash_id = f.project_redpash_id
           LEFT JOIN file_stages s ON s.file_redpash_id = f.redpash_id
          WHERE ($1::text IS NULL OR f.file_type = $1)
            AND ($2::text IS NULL OR COALESCE(s.stage, 'import') = $2)
            AND ($3::text IS NULL OR f.project_redpash_id = $3)
          ORDER BY f.created_at DESC
          LIMIT $4 OFFSET $5",
    )
    .bind(q.file_type.as_deref())
    .bind(q.stage.as_deref())
    .bind(q.project.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

    let rows: Vec<AdminFileSummary> = rows
        .into_iter()
        .map(|r| AdminFileSummary {
            redpash_id:         r.try_get("redpash_id").unwrap_or_default(),
            project_redpash_id: r.try_get("project_redpash_id").unwrap_or_default(),
            project_name:       r.try_get("project_name").unwrap_or_default(),
            filename:           r.try_get("filename").unwrap_or_default(),
            display_name:       r.try_get("display_name").ok(),
            file_type:          r.try_get("file_type").unwrap_or_default(),
            stage:              r.try_get("stage").unwrap_or_else(|_| "import".into()),
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

async fn list_charts(
    State(state): State<AppState>,
    Query(q):     Query<AdminQuery>,
) -> Result<Json<Page<ChartSummary>>, AppError> {
    let started = Instant::now();
    let (offset, size, page) = paginate(q.page, q.size);

    // Charts live in project_files with file_type='chart'. Two counts:
    //   all_count — every chart row ever (the Charts tab's true total).
    //   total     — post-search filter.
    let all_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM project_files WHERE file_type = 'chart'",
    )
    .fetch_one(&state.db)
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM project_files
         WHERE file_type = 'chart'
           AND ($1::text IS NULL OR
                filename                 ILIKE '%' || $1 || '%' OR
                COALESCE(display_name, '') ILIKE '%' || $1 || '%')",
    )
    .bind(q.q.as_deref())
    .fetch_one(&state.db)
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

    let rows = sqlx::query(
        "SELECT f.redpash_id, f.project_redpash_id, p.name AS project_name,
                f.filename, f.display_name,
                COALESCE(s.stage, 'import') AS stage,
                f.created_at, f.updated_at
           FROM project_files f
           JOIN projects p ON p.redpash_id = f.project_redpash_id
           LEFT JOIN file_stages s ON s.file_redpash_id = f.redpash_id
          WHERE f.file_type = 'chart'
            AND ($1::text IS NULL OR
                 f.filename                 ILIKE '%' || $1 || '%' OR
                 COALESCE(f.display_name, '') ILIKE '%' || $1 || '%')
          ORDER BY f.created_at DESC
          LIMIT $2 OFFSET $3",
    )
    .bind(q.q.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

    let rows: Vec<ChartSummary> = rows
        .into_iter()
        .map(|r| ChartSummary {
            redpash_id:         r.try_get("redpash_id").unwrap_or_default(),
            project_redpash_id: r.try_get("project_redpash_id").unwrap_or_default(),
            project_name:       r.try_get("project_name").unwrap_or_default(),
            filename:           r.try_get("filename").unwrap_or_default(),
            display_name:       r.try_get("display_name").ok(),
            stage:              r.try_get("stage").unwrap_or_else(|_| "import".into()),
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

    let all_count: i64 = sqlx::query_scalar("SELECT COUNT(*)::BIGINT FROM project_steps")
        .fetch_one(&state.db)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM project_steps
         WHERE ($1::text IS NULL OR file_redpash_id = $1)
           AND ($2::text IS NULL OR kind            = $2)
           AND ($3::bool IS NULL OR applied         = $3)",
    )
    .bind(q.file.as_deref())
    .bind(q.kind.as_deref())
    .bind(q.applied)
    .fetch_one(&state.db)
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

    let rows = sqlx::query(
        "SELECT s.redpash_id, s.file_redpash_id, f.filename AS file_filename,
                s.ordinal, s.kind, s.applied, s.created_at
           FROM project_steps s
           JOIN project_files f ON f.redpash_id = s.file_redpash_id
          WHERE ($1::text IS NULL OR s.file_redpash_id = $1)
            AND ($2::text IS NULL OR s.kind            = $2)
            AND ($3::bool IS NULL OR s.applied         = $3)
          ORDER BY s.created_at DESC
          LIMIT $4 OFFSET $5",
    )
    .bind(q.file.as_deref())
    .bind(q.kind.as_deref())
    .bind(q.applied)
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

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
