//! Purpose: the LIST provider registry — reach-scoped delivery of a builtin
//! object type's rows for `GET /api/objects/:type`. Mirrors `codec_registry` /
//! `validate_rules::RuleRegistry` (`OnceLock<HashMap>` + `with_builtins` /
//! `register` / `get`); the async, DB-touching twin of `Codec.validate`.
//!
//! Architecture (Em, 2026-06-08 — "one engine, two surfaces"): the SERVER's job
//! is reach-scoped *delivery* of a type's rows; SHAPING (filter/search/sort/page)
//! runs in the data-engine wasm on the CLIENT. So a provider returns the caller's
//! RBAC-reachable rows as `Page<Value>` (uniform shape) and need not honour the
//! type's chips — those are client filters. `page/size/q/sort` are still passed
//! through for the over-cap server fallback (the Workspace `CLIENT_ENGINE_ROW_CAP`
//! hybrid). A new builtin = one `register` call; custom types fall through to the
//! `entity_data` default in `routes/objects.rs`. No central `match`.
//! Doc: docs/internal/code/backend/api/routes/list_registry.md

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;
use std::time::Instant;

use chrono::Utc;
use serde::Serialize;
use serde_json::Value;
use shared::Page;
use sqlx::Row;

use super::admin::AdminQuery;
use super::pagination::{build_page, paginate};
use crate::error::AppError;
use crate::state::AppState;

/// The future a provider returns: a boxed, pinned, `Send` future yielding the
/// uniform `Page<Value>`. `'a` ties it to the borrowed state/query/viewer.
pub type ListFuture<'a> = Pin<Box<dyn Future<Output = Result<Page<Value>, AppError>> + Send + 'a>>;

/// A provider fn pointer — same value-shape as `Codec.validate`, but async +
/// reach-aware. `caller` is the resolved user rid (some providers need it for a
/// per-row projection like `my_role` or the company-share reach); `viewer = None`
/// ⇒ admin (no reach filter); `Some(principals)` ⇒ the caller + their teams
/// (`routes::list_viewer`).
pub type ProviderFn = for<'a> fn(
    &'a AppState,
    &'a str,
    &'a AdminQuery,
    Option<&'a [String]>,
) -> ListFuture<'a>;

pub struct ListProvider {
    pub type_id: &'static str,
    pub list:    ProviderFn,
}

pub struct ListProviderRegistry {
    providers: HashMap<&'static str, ListProvider>,
}

impl ListProviderRegistry {
    pub fn new() -> Self {
        Self { providers: HashMap::new() }
    }
    pub fn with_builtins() -> Self {
        let mut r = Self::new();
        for p in builtin_providers() {
            r.register(p);
        }
        r
    }
    pub fn register(&mut self, p: ListProvider) {
        self.providers.insert(p.type_id, p);
    }
    pub fn get(&self, type_id: &str) -> Option<&ListProvider> {
        self.providers.get(type_id)
    }
}

impl Default for ListProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Process-wide builtin registry — same `OnceLock` shape as
/// `codec_registry::registry()`. Stateless (the fn pointers are `'static`; the
/// pool/query/viewer are per-call), so it lives in a `OnceLock`, not `AppState`.
pub fn registry() -> &'static ListProviderRegistry {
    static REG: OnceLock<ListProviderRegistry> = OnceLock::new();
    REG.get_or_init(ListProviderRegistry::with_builtins)
}

fn builtin_providers() -> Vec<ListProvider> {
    vec![
        ListProvider { type_id: "chart",   list: chart },
        ListProvider { type_id: "file",    list: file },
        ListProvider { type_id: "company", list: company },
        ListProvider { type_id: "team",       list: team },
        ListProvider { type_id: "user",       list: user },
        ListProvider { type_id: "membership", list: membership },
    ]
}

/// Serialize a typed `Page<T>` → `Page<Value>` (the uniform row shape the generic
/// handler returns — provider rows carry the type's columns at top level, with
/// the SAME serde key names the `/admin/*` tabs already render, so the frontend
/// column specs are unchanged).
fn to_value_page<T: Serialize>(p: Page<T>) -> Result<Page<Value>, AppError> {
    let rows = p
        .rows
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::internal("serialize", e.to_string()))?;
    Ok(Page {
        rows,
        total: p.total,
        all_count: p.all_count,
        page: p.page,
        size: p.size,
        pages: p.pages,
        ms: p.ms,
        row_indices: p.row_indices,
    })
}

// ── builtin providers — reach-scoped row DELIVERY (engine-shaped: no server
//    chips; shaping runs in the wasm engine on the client). `viewer = None` ⇒
//    admin (no filter). `all_count` is REACH-scoped (never a platform total) so a
//    tab KPI can't leak the global count. Each reuses the proven `*Summary`
//    serde shape so the frontend column keys are unchanged. ──

/// chart — project_files (file_type='chart'); reach = member of the project or
/// its company. Reuses the admin reach core (one query, two callers).
fn chart<'a>(state: &'a AppState, _caller: &'a str, q: &'a AdminQuery, viewer: Option<&'a [String]>) -> ListFuture<'a> {
    Box::pin(async move { to_value_page(super::admin::charts_page(state, q, viewer).await?) })
}

/// The project_files reach predicate ($1 = principals): a row is reachable when
/// the caller is a member of its project OR the project's company.
const PF_REACH: &str = "($1::text[] IS NULL OR EXISTS (SELECT 1 FROM memberships m \
     WHERE m.member_redpash_id = ANY($1) \
       AND m.object_redpash_id IN (f.project_redpash_id, p.company_id)))";

/// file — DATA files only (charts/dashboards are their own types); same reach as
/// chart. Columns mirror `AdminFileSummary` (the Home Files tab spec).
fn file<'a>(state: &'a AppState, _caller: &'a str, q: &'a AdminQuery, viewer: Option<&'a [String]>) -> ListFuture<'a> {
    Box::pin(async move {
        use shared::admin::AdminFileSummary;
        let started = Instant::now();
        let (offset, size, page) = paginate(q.page, q.size);
        const KIND: &str = "f.file_type NOT IN ('chart','dashboard')";
        const BASE: &str = "FROM project_files f JOIN projects p ON p.redpash_id = f.project_redpash_id";
        const SEARCH: &str = "($2::text IS NULL OR f.filename ILIKE '%'||$2||'%' \
             OR COALESCE(f.display_name,'') ILIKE '%'||$2||'%' OR p.name ILIKE '%'||$2||'%')";

        let all_count: i64 = sqlx::query_scalar(&format!(
            "SELECT COUNT(*)::BIGINT {BASE} WHERE {KIND} AND {PF_REACH}"
        ))
        .bind(viewer)
        .fetch_one(&state.db)
        .await?;
        let total: i64 = sqlx::query_scalar(&format!(
            "SELECT COUNT(*)::BIGINT {BASE} WHERE {KIND} AND {PF_REACH} AND {SEARCH}"
        ))
        .bind(viewer)
        .bind(q.q.as_deref())
        .fetch_one(&state.db)
        .await?;
        let rows = sqlx::query(&format!(
            "SELECT f.redpash_id, f.project_redpash_id, p.name AS project_name, \
                    f.filename, f.display_name, f.file_type, \
                    COALESCE(s.stage,'new') AS stage, f.row_count, f.col_count, \
                    f.file_size_bytes, f.cleanness_pct, f.created_at, f.updated_at \
               {BASE} LEFT JOIN file_stages s ON s.file_redpash_id = f.redpash_id \
              WHERE {KIND} AND {PF_REACH} AND {SEARCH} \
              ORDER BY f.created_at DESC LIMIT $3 OFFSET $4"
        ))
        .bind(viewer)
        .bind(q.q.as_deref())
        .bind(size as i64)
        .bind(offset)
        .fetch_all(&state.db)
        .await?;
        let rows: Vec<AdminFileSummary> = rows
            .iter()
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
        to_value_page(build_page(rows, total as u64, all_count as u64, page, size, started))
    })
}

/// company — reach = member of the company; `my_role` = caller's highest tier.
/// Columns mirror `CompanySummary` (the Home Companies tab spec).
fn company<'a>(state: &'a AppState, caller: &'a str, q: &'a AdminQuery, viewer: Option<&'a [String]>) -> ListFuture<'a> {
    Box::pin(async move {
        use shared::company::{Company, CompanySummary};
        let started = Instant::now();
        let (offset, size, page) = paginate(q.page, q.size);
        const REACH: &str = "($1::text[] IS NULL OR EXISTS (SELECT 1 FROM memberships m \
             WHERE m.member_redpash_id = ANY($1) AND m.object_redpash_id = c.redpash_id))";
        const SEARCH: &str = "($2::text IS NULL OR c.name ILIKE '%'||$2||'%' OR c.slug ILIKE '%'||$2||'%')";

        let all_count: i64 = sqlx::query_scalar(&format!(
            "SELECT COUNT(*)::BIGINT FROM companies c WHERE {REACH}"
        ))
        .bind(viewer)
        .fetch_one(&state.db)
        .await?;
        let total: i64 = sqlx::query_scalar(&format!(
            "SELECT COUNT(*)::BIGINT FROM companies c WHERE {REACH} AND {SEARCH}"
        ))
        .bind(viewer)
        .bind(q.q.as_deref())
        .fetch_one(&state.db)
        .await?;
        // my_role: caller's highest-precedence role on the company (owner>admin>
        // member>viewer); ORDER+LIMIT 1 collapses the widened (role,context) PK.
        let rows = sqlx::query(&format!(
            "SELECT c.redpash_id, c.name, c.slug, c.avatar_url, c.created_at, c.updated_at, \
                    (SELECT COUNT(*)::INT FROM memberships m WHERE m.object_redpash_id = c.redpash_id) AS member_count, \
                    (SELECT m2.role FROM memberships m2 \
                      WHERE m2.object_redpash_id = c.redpash_id AND m2.member_redpash_id = $3 \
                      ORDER BY CASE m2.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 WHEN 'viewer' THEN 3 ELSE 4 END \
                      LIMIT 1) AS my_role \
               FROM companies c WHERE {REACH} AND {SEARCH} \
              ORDER BY c.created_at DESC LIMIT $4 OFFSET $5"
        ))
        .bind(viewer)
        .bind(q.q.as_deref())
        .bind(caller)
        .bind(size as i64)
        .bind(offset)
        .fetch_all(&state.db)
        .await?;
        let rows: Vec<CompanySummary> = rows
            .iter()
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
                my_role:      r.try_get::<String, _>("my_role").ok(),
            })
            .collect();
        to_value_page(build_page(rows, total as u64, all_count as u64, page, size, started))
    })
}

/// team — reach = member of the team OR its company; `my_role` = caller's tier.
/// Columns mirror `TeamSummary` (the Home Teams tab spec).
fn team<'a>(state: &'a AppState, caller: &'a str, q: &'a AdminQuery, viewer: Option<&'a [String]>) -> ListFuture<'a> {
    Box::pin(async move {
        use shared::team::{Team, TeamSummary};
        let started = Instant::now();
        let (offset, size, page) = paginate(q.page, q.size);
        const REACH: &str = "($1::text[] IS NULL OR EXISTS (SELECT 1 FROM memberships m \
             WHERE m.member_redpash_id = ANY($1) AND m.object_redpash_id IN (t.redpash_id, t.company_id)))";
        const SEARCH: &str = "($2::text IS NULL OR t.name ILIKE '%'||$2||'%')";

        let all_count: i64 = sqlx::query_scalar(&format!(
            "SELECT COUNT(*)::BIGINT FROM teams t WHERE {REACH}"
        ))
        .bind(viewer)
        .fetch_one(&state.db)
        .await?;
        let total: i64 = sqlx::query_scalar(&format!(
            "SELECT COUNT(*)::BIGINT FROM teams t WHERE {REACH} AND {SEARCH}"
        ))
        .bind(viewer)
        .bind(q.q.as_deref())
        .fetch_one(&state.db)
        .await?;
        let rows = sqlx::query(&format!(
            "SELECT t.redpash_id, t.company_id, t.name, t.kind, t.created_at, \
                    COALESCE(c.name,'') AS company_name, \
                    (SELECT COUNT(*)::INT FROM memberships m WHERE m.object_redpash_id = t.redpash_id) AS member_count, \
                    (SELECT m2.role FROM memberships m2 \
                      WHERE m2.object_redpash_id = t.redpash_id AND m2.member_redpash_id = $3 \
                      ORDER BY CASE m2.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 WHEN 'viewer' THEN 3 ELSE 4 END \
                      LIMIT 1) AS my_role \
               FROM teams t LEFT JOIN companies c ON c.redpash_id = t.company_id \
              WHERE {REACH} AND {SEARCH} \
              ORDER BY t.created_at DESC LIMIT $4 OFFSET $5"
        ))
        .bind(viewer)
        .bind(q.q.as_deref())
        .bind(caller)
        .bind(size as i64)
        .bind(offset)
        .fetch_all(&state.db)
        .await?;
        let rows: Vec<TeamSummary> = rows
            .iter()
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
        to_value_page(build_page(rows, total as u64, all_count as u64, page, size, started))
    })
}

/// user — reach = company-share: the caller, plus anyone who shares a company
/// membership with the caller (admin ⇒ all). Columns mirror `UserSummary`.
fn user<'a>(state: &'a AppState, caller: &'a str, q: &'a AdminQuery, viewer: Option<&'a [String]>) -> ListFuture<'a> {
    Box::pin(async move {
        use shared::admin::UserSummary;
        let started = Instant::now();
        let (offset, size, page) = paginate(q.page, q.size);
        // Company-share scope: NULL ⇒ admin (all users); else the caller rid.
        let scope: Option<&str> = if viewer.is_some() { Some(caller) } else { None };
        const REACH: &str = "($1::text IS NULL OR u.redpash_id = $1 OR EXISTS ( \
             SELECT 1 FROM memberships ma JOIN memberships mb ON mb.object_redpash_id = ma.object_redpash_id \
              WHERE ma.member_redpash_id = $1 AND mb.member_redpash_id = u.redpash_id \
                AND ma.object_redpash_id LIKE 'CMP\\_%'))";
        const SEARCH: &str = "($2::text IS NULL OR u.username ILIKE '%'||$2||'%' \
             OR u.display_name ILIKE '%'||$2||'%' OR COALESCE(u.email,'') ILIKE '%'||$2||'%' \
             OR COALESCE(u.organisation,'') ILIKE '%'||$2||'%')";

        let all_count: i64 = sqlx::query_scalar(&format!(
            "SELECT COUNT(*)::BIGINT FROM users u WHERE {REACH}"
        ))
        .bind(scope)
        .fetch_one(&state.db)
        .await?;
        let total: i64 = sqlx::query_scalar(&format!(
            "SELECT COUNT(*)::BIGINT FROM users u WHERE {REACH} AND {SEARCH}"
        ))
        .bind(scope)
        .bind(q.q.as_deref())
        .fetch_one(&state.db)
        .await?;
        // LEFT JOIN LATERAL pulls the user's top company membership (owner>admin>
        // member, ties by recency) for the org_name/org_role columns.
        let rows = sqlx::query(&format!(
            "SELECT u.redpash_id, u.username, u.email, u.display_name, u.first_name, u.last_name, \
                    u.avatar_url, u.job_title, u.organisation, u.plan, u.role, u.created_at, \
                    m.company_id AS org_id, m.company_name AS org_name, m.role AS org_role \
               FROM users u \
               LEFT JOIN LATERAL ( \
                 SELECT cm.object_redpash_id AS company_id, c.name AS company_name, cm.role \
                   FROM memberships cm JOIN companies c ON c.redpash_id = cm.object_redpash_id \
                  WHERE cm.member_redpash_id = u.redpash_id \
                  ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, cm.joined_at DESC \
                  LIMIT 1 ) m ON TRUE \
              WHERE {REACH} AND {SEARCH} \
              ORDER BY u.display_name ASC LIMIT $3 OFFSET $4"
        ))
        .bind(scope)
        .bind(q.q.as_deref())
        .bind(size as i64)
        .bind(offset)
        .fetch_all(&state.db)
        .await?;
        let rows: Vec<UserSummary> = rows
            .iter()
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
        to_value_page(build_page(rows, total as u64, all_count as u64, page, size, started))
    })
}

/// membership — "my memberships": every membership the caller (or their teams)
/// holds, across all four scopes (project/company/case/team), UNION-ed. Reach =
/// `m.member_redpash_id = ANY($1)` (admin ⇒ all). Columns mirror
/// `MembershipSummary` (the Home Memberships tab spec). `$2` searches the user +
/// scope name; `all_count` reuses the union with `$2 = NULL` (reach-only count).
fn membership<'a>(state: &'a AppState, _caller: &'a str, q: &'a AdminQuery, viewer: Option<&'a [String]>) -> ListFuture<'a> {
    Box::pin(async move {
        use shared::admin::MembershipSummary;
        let started = Instant::now();
        let (offset, size, page) = paginate(q.page, q.size);
        // One scope branch: $1 = principals reach (NULL ⇒ admin all), $2 = search
        // over the member's name + the scope object's name.
        let branch = |scope: &str, table: &str, alias: &str, name_col: &str| -> String {
            format!(
                "SELECT '{scope}' AS scope, m.object_redpash_id AS scope_redpash_id, \
                        {name_col} AS scope_name, m.member_redpash_id, \
                        u.display_name AS user_display_name, u.username AS user_username, \
                        m.role, m.joined_at \
                   FROM memberships m \
                   JOIN {table} {alias} ON {alias}.redpash_id = m.object_redpash_id \
                   JOIN users u ON u.redpash_id = m.member_redpash_id \
                  WHERE ($1::text[] IS NULL OR m.member_redpash_id = ANY($1)) \
                    AND ($2::text IS NULL OR u.display_name ILIKE '%'||$2||'%' \
                         OR u.username ILIKE '%'||$2||'%' OR {name_col} ILIKE '%'||$2||'%')"
            )
        };
        let union = format!(
            "{} UNION ALL {} UNION ALL {} UNION ALL {}",
            branch("project", "projects", "p", "p.name"),
            branch("company", "companies", "c", "c.name"),
            branch("case", "cases", "ca", "ca.title"),
            branch("team", "teams", "t", "t.name"),
        );

        // all_count = reach-only ($2 NULL bypasses search); total = reach+search.
        let all_count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*)::BIGINT FROM ({union}) s"))
            .bind(viewer)
            .bind(None::<&str>)
            .fetch_one(&state.db)
            .await?;
        let total: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*)::BIGINT FROM ({union}) s"))
            .bind(viewer)
            .bind(q.q.as_deref())
            .fetch_one(&state.db)
            .await?;
        let rows = sqlx::query(&format!(
            "SELECT * FROM ({union}) s ORDER BY joined_at DESC LIMIT $3 OFFSET $4"
        ))
        .bind(viewer)
        .bind(q.q.as_deref())
        .bind(size as i64)
        .bind(offset)
        .fetch_all(&state.db)
        .await?;
        let rows: Vec<MembershipSummary> = rows
            .iter()
            .map(|r| MembershipSummary {
                scope:             r.try_get("scope").unwrap_or_default(),
                scope_redpash_id:  r.try_get("scope_redpash_id").unwrap_or_default(),
                scope_name:        r.try_get("scope_name").unwrap_or_default(),
                member_redpash_id: r.try_get("member_redpash_id").unwrap_or_default(),
                user_display_name: r.try_get("user_display_name").unwrap_or_default(),
                user_username:     r.try_get("user_username").unwrap_or_default(),
                role:              r.try_get("role").unwrap_or_default(),
                joined_at:         r.try_get("joined_at").unwrap_or_else(|_| Utc::now()),
            })
            .collect();
        to_value_page(build_page(rows, total as u64, all_count as u64, page, size, started))
    })
}
