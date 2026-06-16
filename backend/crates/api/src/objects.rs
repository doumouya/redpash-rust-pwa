//! Purpose: /api/objects/:type[/:rid] — the generic object resource over the
//! polymorphic entity_data (JSONB) store. ONE handler for every registered
//! TypeDefinition: a new custom type gets full CRUD + RBAC + audit with ZERO
//! new code (the "framework, not product" thesis). Gating is the type-agnostic
//! require_action; the IDOR guard (day-one #3) gates a caller-supplied
//! scope_parent_id behind >= Member reach on the parent.
//!
//! S7: the ORG BUILTINS (user/company/team) dispatch to their TYPED tables on
//! the same wire shape — catalog-validated fields (type_fields), the field
//! gate (field_perms::require_fields) AFTER the coarse Edit gate, reach-scoped
//! lists mirroring the entity_data REACH clause over typed columns. Custom
//! types stay on the entity_data path untouched (no catalogs yet → no field
//! gate there).

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::types::Json as SqlxJson;
use sqlx::{PgPool, Row as _};

use crate::{
    db,
    error::AppError,
    event, field_perms,
    rbac::{self, Action, Caller, Role},
    state::AppState,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/:type", get(list).post(create))
        .route("/:type/:rid", get(get_one).patch(patch).delete(delete_one))
}

#[derive(Serialize)]
struct ObjectView {
    #[serde(rename = "type")]
    type_id: String,
    rid: String,
    owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope_parent: Option<String>,
    data: Value,
}

#[derive(Deserialize)]
struct CreateBody {
    #[serde(default)]
    data: Map<String, Value>,
    scope_parent_id: Option<String>,
}

#[derive(Deserialize)]
struct PatchBody {
    #[serde(default)]
    data: Map<String, Value>,
}

fn require_type(state: &AppState, type_id: &str) -> Result<(), AppError> {
    if state.type_cache.is_type(type_id) {
        Ok(())
    } else {
        Err(AppError::not_found("not_found", format!("unknown type {type_id}")))
    }
}

/// POST /api/objects/:type — create. Registers the entity, inserts the
/// entity_data row, auto-grants the creator an owner edge (one tx). The IDOR
/// guard requires >= Member reach on a supplied scope_parent (day-one #3); the
/// FK on entity_data.scope_parent_id additionally refuses a dangling parent.
async fn create(
    State(state): State<AppState>,
    caller: Caller,
    Path(type_id): Path<String>,
    Json(body): Json<CreateBody>,
) -> Result<(StatusCode, Json<ObjectView>), AppError> {
    require_type(&state, &type_id)?;
    if registry_read_only(&type_id) {
        return Err(AppError::bad_request(
            "not_creatable",
            format!("{type_id} is created by its own flow (upload / projects), not the registry"),
        ));
    }
    if let Some((table, _)) = org_builtin(&type_id) {
        return builtin_create(&state, caller, &type_id, table, body).await;
    }

    // IDOR guard: a caller-supplied parent must be reachable at >= Member, or
    // any authed user could graft this object under a foreign scope (and hand
    // its admins cascade write). require_rule 404s an unreachable/foreign
    // parent — leak-free.
    if let Some(parent) = body.scope_parent_id.as_deref() {
        let kind = state.type_cache.object_kind(parent);
        rbac::require_rule(&state.db, &state.type_cache, &caller, parent, kind, |g| {
            g.effective().is_some_and(|r| r >= Role::Member)
        })
        .await?;
    }

    let prefix = state
        .type_cache
        .rid_prefix(&type_id)
        .ok_or_else(|| AppError::internal("registry", "type missing rid_prefix"))?;
    let rid = crate::id::new(prefix);
    let data_val = Value::Object(body.data);

    let mut tx = state.db.begin().await?;
    db::register_entity(&mut tx, &rid, &type_id).await?;
    sqlx::query(
        "INSERT INTO entity_data (object_id, type_id, owner_id, scope_parent_id, data)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&rid)
    .bind(&type_id)
    .bind(&caller.rid)
    .bind(&body.scope_parent_id)
    .bind(&data_val)
    .execute(&mut *tx)
    .await?;
    db::grant_owner(&mut tx, &rid, &caller.rid).await?;
    tx.commit().await?;

    event::info(
        &state.db,
        format!("{type_id}_create"),
        format!("created {type_id} {rid}"),
        Some(caller.rid.clone()),
        serde_json::json!({ "type": type_id, "rid": rid }),
    );

    Ok((
        StatusCode::CREATED,
        Json(ObjectView {
            type_id,
            rid,
            owner: Some(caller.rid),
            scope_parent: body.scope_parent_id,
            data: data_val,
        }),
    ))
}

/// GET /api/objects/:type/:rid — any reach (View). 404 leak-free on miss /
/// type mismatch / no reach.
async fn get_one(
    State(state): State<AppState>,
    caller: Caller,
    Path((type_id, rid)): Path<(String, String)>,
) -> Result<Json<ObjectView>, AppError> {
    require_type(&state, &type_id)?;
    if let Some((table, _)) = org_builtin(&type_id) {
        let mut view = builtin_view(&state, table, &type_id, &rid).await?;
        rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::View).await?;
        mask_view(&state, &caller, &type_id, &mut view).await?;
        return Ok(Json(view));
    }
    let row = load(&state, &type_id, &rid).await?;
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::View).await?;
    Ok(Json(row))
}

/// PATCH /api/objects/:type/:rid — merge field changes (Edit gate). Org
/// builtins additionally run the FIELD GATE (require_fields) after the coarse
/// gate; custom types stay catalog-free for now (data stored as-is).
async fn patch(
    State(state): State<AppState>,
    caller: Caller,
    Path((type_id, rid)): Path<(String, String)>,
    Json(body): Json<PatchBody>,
) -> Result<Json<ObjectView>, AppError> {
    require_type(&state, &type_id)?;
    if registry_read_only(&type_id) {
        return Err(AppError::bad_request(
            "not_editable",
            format!("{type_id} is edited by its own flow, not the registry"),
        ));
    }
    if let Some((table, _)) = org_builtin(&type_id) {
        return builtin_patch(&state, caller, &type_id, table, &rid, body).await;
    }
    let current = load(&state, &type_id, &rid).await?;
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::Edit).await?;

    let mut merged = match current.data {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    for (k, v) in body.data {
        merged.insert(k, v);
    }
    let data_val = Value::Object(merged);
    sqlx::query("UPDATE entity_data SET data = $1, updated_at = now() WHERE object_id = $2")
        .bind(&data_val)
        .bind(&rid)
        .execute(&state.db)
        .await?;

    event::info(
        &state.db,
        format!("{type_id}_update"),
        format!("updated {type_id} {rid}"),
        Some(caller.rid),
        serde_json::json!({ "type": type_id, "rid": rid }),
    );
    Ok(Json(ObjectView {
        type_id,
        rid,
        owner: current.owner,
        scope_parent: current.scope_parent,
        data: data_val,
    }))
}

/// DELETE /api/objects/:type/:rid — Admin+ on the object. Deletes through the
/// registry (cascade clears entity_data + memberships).
async fn delete_one(
    State(state): State<AppState>,
    caller: Caller,
    Path((type_id, rid)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    require_type(&state, &type_id)?;
    // Existence check on the right store (typed table for org builtins,
    // entity_data otherwise) — 404 leak-free on miss/mismatch. The delete
    // itself stays THE generic registry delete either way.
    if let Some((table, _)) = org_builtin(&type_id) {
        let sql = format!("SELECT 1 FROM {table} WHERE redpash_id = $1{}", builtin_row_scope(&type_id));
        let exists: Option<i32> =
            sqlx::query_scalar(&sql).bind(&rid).fetch_optional(&state.db).await?;
        if exists.is_none() {
            return Err(AppError::not_found("not_found", format!("{type_id} {rid}")));
        }
    } else {
        let _ = load(&state, &type_id, &rid).await?;
    }
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::Delete).await?;

    // Users are SCRUB-RETAINED, not hard-deleted: a hard DELETE cascades their
    // membership edges (stranding sole-owned objects) and erases audit. Block if
    // the user solely owns anything (transfer first), else anonymize + retain.
    if type_id == "user" {
        let blocking = db::user_sole_owner_objects(&state.db, &rid).await?;
        if !blocking.is_empty() {
            return Err(AppError::conflict(
                "sole_owner_blocker",
                format!(
                    "user is sole owner of {} object(s); transfer ownership first",
                    blocking.len()
                ),
            ));
        }
        // Collect live sessions BEFORE scrub deletes the rows — the cache is
        // keyed by sid and would otherwise keep the scrubbed user authed ~60s.
        let sids: Vec<String> = sqlx::query_scalar("SELECT id FROM sessions WHERE user_id = $1")
            .bind(&rid)
            .fetch_all(&state.db)
            .await?;
        if !db::scrub_user_tx(&state.db, &rid).await? {
            return Err(AppError::not_found("not_found", format!("user {rid}")));
        }
        for sid in &sids {
            crate::session::invalidate(&state, sid);
        }
        event::warn(
            &state.db,
            "user_scrub".to_string(),
            format!("scrubbed user {rid}"),
            Some(caller.rid),
            serde_json::json!({ "type": "user", "rid": rid }),
        );
        return Ok(StatusCode::NO_CONTENT);
    }

    db::delete_entity(&state.db, &rid).await?;
    event::warn(
        &state.db,
        format!("{type_id}_delete"),
        format!("deleted {type_id} {rid}"),
        Some(caller.rid),
        serde_json::json!({ "type": type_id, "rid": rid }),
    );
    Ok(StatusCode::NO_CONTENT)
}

// ─── list ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default = "default_page")]
    page: u32,
    #[serde(default = "default_size")]
    size: u32,
    #[serde(default)]
    q: Option<String>,
}
fn default_page() -> u32 {
    1
}
fn default_size() -> u32 {
    50
}

/// GET /api/objects/:type — the caller's RBAC-reachable rows, paginated. Reach
/// = direct membership on the object OR its scope_parent (the cascade). Admin →
/// every row. `all_count` is reach-scoped (never the platform total — a KPI
/// must not leak the global count). The optional `q` is a coarse server-side
/// substring fallback; the client engine does the real shaping.
async fn list(
    State(state): State<AppState>,
    caller: Caller,
    Path(type_id): Path<String>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    require_type(&state, &type_id)?;
    if let Some((table, reach)) = org_builtin(&type_id) {
        return builtin_list(&state, &caller, &type_id, table, reach, q).await;
    }
    // viewer = None → admin (no reach filter); else the principal closure.
    let viewer: Option<Vec<String>> = if caller.is_platform_admin {
        None
    } else {
        Some(rbac::principals(&state.db, &caller.rid).await?)
    };
    let viewer_ref = viewer.as_deref();

    const REACH: &str = "($2::text[] IS NULL OR EXISTS (SELECT 1 FROM memberships m
         WHERE m.member_redpash_id = ANY($2)
           AND m.object_redpash_id IN (ed.object_id, ed.scope_parent_id)))";

    let all_count: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*)::BIGINT FROM entity_data ed WHERE ed.type_id = $1 AND {REACH}"
    ))
    .bind(&type_id)
    .bind(viewer_ref)
    .fetch_one(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*)::BIGINT FROM entity_data ed WHERE ed.type_id = $1 AND {REACH}
            AND ($3::text IS NULL OR ed.data::text ILIKE '%' || $3 || '%')"
    ))
    .bind(&type_id)
    .bind(viewer_ref)
    .bind(q.q.as_deref())
    .fetch_one(&state.db)
    .await?;

    let size = q.size.clamp(1, 500);
    let offset = (q.page.saturating_sub(1) * size) as i64;
    let rows: Vec<(String, Option<String>, Option<String>, SqlxJson<Value>)> = sqlx::query_as(&format!(
        "SELECT ed.object_id, ed.owner_id, ed.scope_parent_id, ed.data
           FROM entity_data ed
          WHERE ed.type_id = $1 AND {REACH}
            AND ($3::text IS NULL OR ed.data::text ILIKE '%' || $3 || '%')
          ORDER BY ed.created_at DESC LIMIT $4 OFFSET $5"
    ))
    .bind(&type_id)
    .bind(viewer_ref)
    .bind(q.q.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let items: Vec<Value> = rows
        .into_iter()
        .map(|(rid, owner, scope_parent, data)| {
            let mut m = match data.0 {
                Value::Object(m) => m,
                other => {
                    let mut m = Map::new();
                    m.insert("value".into(), other);
                    m
                }
            };
            m.insert("rid".into(), Value::String(rid));
            if let Some(o) = owner {
                m.insert("owner".into(), Value::String(o));
            }
            if let Some(sp) = scope_parent {
                m.insert("scope_parent".into(), Value::String(sp));
            }
            Value::Object(m)
        })
        .collect();

    Ok(Json(serde_json::json!({
        "items": items,
        "total": total,
        "all_count": all_count,
        "page": q.page,
        "size": size,
    })))
}

/// Load one entity_data row → ObjectView, enforcing the type matches (404
/// leak-free on miss / mismatch).
async fn load(state: &AppState, type_id: &str, rid: &str) -> Result<ObjectView, AppError> {
    let row: Option<(String, Option<String>, Option<String>, SqlxJson<Value>)> = sqlx::query_as(
        "SELECT type_id, owner_id, scope_parent_id, data FROM entity_data WHERE object_id = $1",
    )
    .bind(rid)
    .fetch_optional(&state.db)
    .await?;
    let (rtype, owner, scope_parent, data) =
        row.ok_or_else(|| AppError::not_found("not_found", format!("{type_id} {rid}")))?;
    if rtype != type_id {
        return Err(AppError::not_found("not_found", format!("{type_id} {rid}")));
    }
    Ok(ObjectView { type_id: rtype, rid: rid.to_string(), owner, scope_parent, data: data.0 })
}

// ─── org builtins (S7): typed tables behind the same wire ──────────────────

/// The org builtins served from their TYPED tables: (table, REACH clause).
/// The reach mirrors the entity_data REACH — membership on the row itself or
/// its company cascade — rewritten over typed columns. `$1` is the caller's
/// principal closure (NULL ⇒ platform admin, no filter); the closure contains
/// the caller's own rid, so `t.redpash_id = ANY($1)` is self-visibility on the
/// user list. The fuller company-share rule for users is the documented
/// follow-on. project/file/case keep their existing surfaces; custom types
/// keep entity_data.
fn org_builtin(type_id: &str) -> Option<(&'static str, &'static str)> {
    match type_id {
        "user" => Some((
            "users",
            "($1::text[] IS NULL OR t.redpash_id = ANY($1) OR EXISTS (
                SELECT 1 FROM memberships m
                WHERE m.member_redpash_id = ANY($1)
                  AND m.object_redpash_id = t.redpash_id))",
        )),
        "company" => Some((
            "companies",
            "($1::text[] IS NULL OR EXISTS (
                SELECT 1 FROM memberships m
                WHERE m.member_redpash_id = ANY($1)
                  AND m.object_redpash_id = t.redpash_id))",
        )),
        "team" => Some((
            "teams",
            "($1::text[] IS NULL OR EXISTS (
                SELECT 1 FROM memberships m
                WHERE m.member_redpash_id = ANY($1)
                  AND m.object_redpash_id IN (t.redpash_id, t.company_id)))",
        )),
        // Registry data tables. Reach is the hierarchy-aware principals closure
        // ($1), mirroring the file-list / projects.rs handlers: a caller reaches
        // a file via membership on the file, its project, or the project's
        // company (and a project via the project or its company). CSV only for
        // file (charts/dashboards have the Designer surface).
        "file" => Some((
            "project_files",
            "(t.file_type = 'csv' AND ($1::text[] IS NULL OR EXISTS (
                SELECT 1 FROM memberships m
                WHERE m.member_redpash_id = ANY($1)
                  AND m.object_redpash_id IN (t.redpash_id, t.project_id,
                        (SELECT company_id FROM projects WHERE redpash_id = t.project_id)))))",
        )),
        "project" => Some((
            "projects",
            "($1::text[] IS NULL OR EXISTS (
                SELECT 1 FROM memberships m
                WHERE m.member_redpash_id = ANY($1)
                  AND m.object_redpash_id IN (t.redpash_id, t.company_id)))",
        )),
        // Case browse view. Reach = membership on the case itself OR either
        // declared scope_parent (company_id / project_id) — mirrors the
        // type_definitions scope_parents and the rbac::require_action cascade
        // used by get/patch/delete. Browse + DELETE only (registry_read_only);
        // cases are created + advanced by agents on the dedicated /api/cases
        // surface, where the status workflow lives.
        "case" => Some((
            "cases",
            "($1::text[] IS NULL OR EXISTS (
                SELECT 1 FROM memberships m
                WHERE m.member_redpash_id = ANY($1)
                  AND m.object_redpash_id IN (t.redpash_id, t.company_id, t.project_id)))",
        )),
        _ => None,
    }
}

/// file/project are managed by their own flows (upload, /projects) and have
/// non-text, provenance-owned typed columns — the registry exposes them READ +
/// DELETE only, never create/edit. (Rename has its own dedicated endpoint.)
/// `case` joins them browse+DELETE-only here: cases are created and advanced by
/// agents on the dedicated /api/cases surface (where the status workflow lives),
/// not the generic registry.
fn registry_read_only(type_id: &str) -> bool {
    matches!(type_id, "file" | "project" | "case")
}

/// The CSV-only row scope the file registry surface advertises. file/chart/
/// dashboard share the project_files table; the registry's `file` type is CSVs
/// (charts/dashboards are the Designer's), so get/delete scope to match the
/// list/view reach — keeping DELETE /objects/file/<chart> a leak-free 404 and the
/// audit label truthful. Unqualified column — resolves against the single table
/// in both the aliased view query and the bare existence query.
fn builtin_row_scope(type_id: &str) -> &'static str {
    if type_id == "file" { " AND file_type = 'csv'" } else { "" }
}

/// READ masking — field VISIBILITY is part of the boundary, not just display.
/// A field the caller's tier can't read is OMITTED from the wire `data`:
/// presence MEANS readable (a readable-but-empty value still arrives as
/// null, so clients can tell "no data" from "no access"). Platform admins
/// see everything; the matrix loads once per request and the per-row tier
/// resolve only runs on the slow path (an admin actually stored a hiding
/// override — see FieldMatrix::fully_readable).
fn mask_fields(data: &mut Value, unreadable: &[&str]) {
    if let Value::Object(m) = data {
        for f in unreadable {
            m.remove(*f);
        }
    }
}

/// The caller's tier on one row, for masking. Self rows are reachable with no
/// membership edge (the closure contains the caller's own rid), so the OWN
/// user row resolves to owner — a user must never lose sight of their own
/// personal fields. Reachable-but-grantless otherwise reads as viewer.
async fn caller_tier(
    state: &AppState,
    caller: &Caller,
    type_id: &str,
    rid: &str,
) -> Result<Role, AppError> {
    if type_id == "user" && rid == caller.rid {
        return Ok(Role::Owner);
    }
    Ok(rbac::resolve_grant(&state.db, &state.type_cache, &caller.rid, rid)
        .await?
        .effective()
        .unwrap_or(Role::Viewer))
}

async fn mask_view(
    state: &AppState,
    caller: &Caller,
    type_id: &str,
    view: &mut ObjectView,
) -> Result<(), AppError> {
    if caller.is_platform_admin {
        return Ok(());
    }
    let matrix = field_perms::matrix(&state.db, type_id).await?;
    if matrix.fully_readable() {
        return Ok(());
    }
    let tier = caller_tier(state, caller, type_id, &view.rid).await?;
    let idx = field_perms::tier_index(tier.as_str()).expect("rbac::Role strings align with TIERS");
    mask_fields(&mut view.data, &matrix.unreadable(idx));
    Ok(())
}

/// Required-on-create fields per org builtin — the ONE place this knowledge
/// exists (mirrors type_cache::builtin_table's posture).
fn required_on_create(type_id: &str) -> &'static [&'static str] {
    match type_id {
        "user" => &["display_name"],
        "company" => &["name"],
        "team" => &["name", "company_id"],
        _ => &[],
    }
}

struct CatalogField {
    field: String,
    options: Option<Vec<String>>,
}

/// The type's field catalog (type_fields), ordinal order. Field names get
/// interpolated into SQL — refuse anything that isn't a bare identifier
/// (belt-and-braces; the rows are our seeds, same posture as type_cache).
async fn catalog_fields(pool: &PgPool, type_id: &str) -> Result<Vec<CatalogField>, AppError> {
    let rows: Vec<(String, Option<Value>)> =
        sqlx::query_as("SELECT field, options FROM type_fields WHERE type_id = $1 ORDER BY ordinal")
            .bind(type_id)
            .fetch_all(pool)
            .await?;
    let mut out = Vec::with_capacity(rows.len());
    for (field, options) in rows {
        let safe = !field.is_empty()
            && field.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
        if !safe {
            return Err(AppError::internal("registry", format!("unsafe field name {field:?}")));
        }
        let options = options.and_then(|v| serde_json::from_value::<Vec<String>>(v).ok());
        out.push(CatalogField { field, options });
    }
    if out.is_empty() {
        return Err(AppError::internal("registry", format!("no field catalog for {type_id}")));
    }
    Ok(out)
}

/// Validate a builtin write payload against the catalog: every key known
/// (400 unknown_field — the wire contract), values string/null (every org
/// catalog column is text), options respected when declared.
fn validate_payload(
    catalog: &[CatalogField],
    data: &Map<String, Value>,
    type_id: &str,
) -> Result<(), AppError> {
    for (k, v) in data {
        let Some(cf) = catalog.iter().find(|c| &c.field == k) else {
            return Err(AppError::bad_request(
                "unknown_field",
                format!("{type_id} has no field {k}"),
            ));
        };
        let s = match v {
            Value::Null => None,
            Value::String(s) => Some(s.as_str()),
            _ => {
                return Err(AppError::bad_request(
                    "invalid_value",
                    format!("{type_id}.{k} must be a string"),
                ))
            }
        };
        if let (Some(opts), Some(s)) = (&cf.options, s) {
            if !opts.iter().any(|o| o == s) {
                return Err(AppError::bad_request(
                    "invalid_value",
                    format!("{type_id}.{k} must be one of {opts:?}"),
                ));
            }
        }
        // NOT NULL columns: a required field can't be nulled/blanked away.
        if required_on_create(type_id).contains(&k.as_str())
            && s.is_none_or(|s| s.trim().is_empty())
        {
            return Err(AppError::bad_request(
                "invalid_value",
                format!("{type_id}.{k} can't be empty"),
            ));
        }
    }
    Ok(())
}

/// Internal / sensitive columns the generic registry NEVER surfaces, even though
/// they're real columns. Generic by exact column name across every builtin table:
///   - `google_sub`    — the OAuth subject (a server secret),
///   - `storage_path`  — the on-disk file path (server filesystem),
///   - `columns_meta`  — per-column CSV profile incl. `sample`, the first real cell
///                       VALUE of each column = raw user data (governance: never
///                       broadcast it; the bulk list would, unmaskably),
///   - `spec`          — chart/dashboard config JSON (data-derived).
/// `columns_meta`/`spec` are JSONB blobs that render as opaque `::text` anyway, so
/// hiding them costs nothing for the grid. DISPLAY-only — the write gate is the
/// curated type_fields (validate_payload), so this list never affects PATCH/create.
const HIDDEN_COLUMNS: &[&str] = &["google_sub", "storage_path", "columns_meta", "spec"];

/// Field names interpolate into SQL — accept only bare identifiers (the typed
/// tables are ours; belt-and-braces, same posture as catalog_fields).
fn bare_ident(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// The ordered DISPLAY field set for a builtin type. READ-ONLY registry types
/// (file/project/case) DERIVE every real column of the typed table — don't
/// hand-seed — so the browse view shows the WHOLE object, minus HIDDEN_COLUMNS;
/// type_fields is then an OVERLAY for ORDER (cataloged fields first in their
/// curated ordinal, then the remaining real columns in schema order). The
/// EDITABLE builtins (user/company/team) instead keep their curated type_fields:
/// that catalog IS their editable field set, and /api/types' per-tier cells + the
/// edit form are built off it. The `bool` flags cataloged (carries the curated
/// label/perm/options for /api/types) vs a derived readonly column. `None` for
/// non-builtin (entity_data) types. This is THE field set both /api/types (column
/// headers, via types::payload) and /objects (row data, here) share, so the FE
/// column⋂row-keys intersection keeps every field. The WRITE gate stays
/// catalog_fields — deriving here never widens what PATCH/create accept.
pub async fn registry_display_fields(
    pool: &PgPool,
    type_id: &str,
) -> Result<Option<Vec<(String, bool)>>, AppError> {
    let Some((table, _)) = org_builtin(type_id) else {
        return Ok(None);
    };
    // Editable builtins keep their curated catalog (see above) — only the
    // read-only registry browse types derive the full table.
    if !registry_read_only(type_id) {
        let cataloged: Vec<String> =
            sqlx::query_scalar("SELECT field FROM type_fields WHERE type_id = $1 ORDER BY ordinal")
                .bind(type_id)
                .fetch_all(pool)
                .await?;
        return Ok(Some(cataloged.into_iter().map(|f| (f, true)).collect()));
    }
    let real: Vec<String> = sqlx::query_scalar(
        "SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
    )
    .bind(table)
    .fetch_all(pool)
    .await?;
    for c in &real {
        if !bare_ident(c) {
            return Err(AppError::internal("registry", format!("unsafe column name {c:?}")));
        }
    }
    let real: Vec<String> =
        real.into_iter().filter(|c| !HIDDEN_COLUMNS.contains(&c.as_str())).collect();
    let real_set: std::collections::HashSet<&str> = real.iter().map(String::as_str).collect();
    let cataloged: Vec<String> =
        sqlx::query_scalar("SELECT field FROM type_fields WHERE type_id = $1 ORDER BY ordinal")
            .bind(type_id)
            .fetch_all(pool)
            .await?;
    let mut out: Vec<(String, bool)> = Vec::with_capacity(real.len());
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for f in cataloged {
        if real_set.contains(f.as_str()) && seen.insert(f.clone()) {
            out.push((f, true));
        }
    }
    for c in real {
        if seen.insert(c.clone()) {
            out.push((c, false));
        }
    }
    Ok(Some(out))
}

/// Load one typed row → ObjectView (404 leak-free on miss). Columns DERIVE from
/// registry_display_fields (the whole object, minus the denylist). `owner` is the
/// first owner membership edge — typed tables have no owner_id column (ownership
/// IS a membership row).
async fn builtin_view(
    state: &AppState,
    table: &str,
    type_id: &str,
    rid: &str,
) -> Result<ObjectView, AppError> {
    let fields = registry_display_fields(&state.db, type_id)
        .await?
        .ok_or_else(|| AppError::internal("registry", format!("{type_id} is not a builtin")))?;
    // ::text so non-text typed columns (row_count, created_at, attachments jsonb, …)
    // decode uniformly as Option<String>; a no-op on the all-text columns.
    let cols = fields.iter().map(|(f, _)| format!("t.{f}::text")).collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT {cols} FROM {table} t WHERE t.redpash_id = $1{}",
        builtin_row_scope(type_id)
    );
    let row = sqlx::query(&sql)
        .bind(rid)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found("not_found", format!("{type_id} {rid}")))?;
    let mut data = Map::new();
    for (i, (f, _)) in fields.iter().enumerate() {
        let v: Option<String> = row.try_get(i)?;
        data.insert(f.clone(), v.map(Value::String).unwrap_or(Value::Null));
    }
    let owner: Option<String> = sqlx::query_scalar(
        "SELECT member_redpash_id FROM memberships
         WHERE object_redpash_id = $1 AND role = 'owner' ORDER BY created_at LIMIT 1",
    )
    .bind(rid)
    .fetch_optional(&state.db)
    .await?;
    Ok(ObjectView {
        type_id: type_id.to_string(),
        rid: rid.to_string(),
        owner,
        scope_parent: None,
        data: Value::Object(data),
    })
}

/// POST for an org builtin — typed insert + register_entity + grant_owner in
/// ONE tx, exactly like the generic path. Only catalog fields are accepted;
/// the team parent (company_id) gets the same IDOR guard the generic
/// scope_parent gets (>= Member reach, 404 leak-free).
async fn builtin_create(
    state: &AppState,
    caller: Caller,
    type_id: &str,
    table: &str,
    body: CreateBody,
) -> Result<(StatusCode, Json<ObjectView>), AppError> {
    if body.scope_parent_id.is_some() {
        return Err(AppError::bad_request(
            "unknown_field",
            "builtin types take their parent via catalog fields (e.g. team.company_id)",
        ));
    }
    let catalog = catalog_fields(&state.db, type_id).await?;
    validate_payload(&catalog, &body.data, type_id)?;
    for req in required_on_create(type_id) {
        match body.data.get(*req) {
            Some(Value::String(s)) if !s.trim().is_empty() => {}
            _ => {
                return Err(AppError::bad_request(
                    "missing_field",
                    format!("{type_id}.{req} is required"),
                ))
            }
        }
    }

    // The field gate at CREATE: the creator becomes owner, so cells resolve at
    // the owner tier — a readonly-class field (user.username is system-managed
    // by the OAuth claim flow) is not settable here either. Required-on-create
    // fields are exempt: they are birth INPUTS, not edits (team.company_id is
    // readonly-class because RE-parenting is what's forbidden). Platform
    // admins bypass, same as every gate.
    if !caller.is_platform_admin {
        let matrix = field_perms::matrix(&state.db, type_id).await?;
        for k in body.data.keys() {
            if required_on_create(type_id).contains(&k.as_str()) {
                continue;
            }
            if matrix.cell(k, 0) != field_perms::Perm::Write {
                return Err(AppError::forbidden(
                    "field_forbidden",
                    format!("your role (owner) can't edit {type_id}.{k}"),
                ));
            }
        }
    }

    // IDOR guard on the typed parent column (day-one #3, same rule as the
    // generic scope_parent): the supplied company must exist AND be reachable
    // at >= Member — both failures are the same leak-free 404.
    if type_id == "team" {
        let parent = body.data.get("company_id").and_then(Value::as_str).unwrap_or("");
        let exists: Option<i32> =
            sqlx::query_scalar("SELECT 1 FROM companies WHERE redpash_id = $1")
                .bind(parent)
                .fetch_optional(&state.db)
                .await?;
        if exists.is_none() {
            return Err(AppError::not_found("not_found", format!("company {parent}")));
        }
        rbac::require_rule(&state.db, &state.type_cache, &caller, parent, "company", |g| {
            g.effective().is_some_and(|r| r >= Role::Member)
        })
        .await?;
    }

    let prefix = state
        .type_cache
        .rid_prefix(type_id)
        .ok_or_else(|| AppError::internal("registry", "type missing rid_prefix"))?;
    let rid = crate::id::new(prefix);

    // Dynamic INSERT over the PROVIDED catalog columns only — DB defaults
    // fill the rest (role='user', status='active', kind='team').
    let provided: Vec<(&String, Option<String>)> = body
        .data
        .iter()
        .map(|(k, v)| (k, v.as_str().map(str::to_string)))
        .collect();
    let mut cols = vec!["redpash_id".to_string()];
    let mut params = vec!["$1".to_string()];
    for (i, (k, _)) in provided.iter().enumerate() {
        cols.push((*k).clone());
        params.push(format!("${}", i + 2));
    }
    let sql = format!(
        "INSERT INTO {table} ({}) VALUES ({})",
        cols.join(", "),
        params.join(", ")
    );

    let mut tx = state.db.begin().await?;
    db::register_entity(&mut tx, &rid, type_id).await?;
    let mut q = sqlx::query(&sql).bind(&rid);
    for (_, v) in &provided {
        q = q.bind(v);
    }
    q.execute(&mut *tx).await?;
    db::grant_owner(&mut tx, &rid, &caller.rid).await?;
    tx.commit().await?;

    event::info(
        &state.db,
        format!("{type_id}_create"),
        format!("created {type_id} {rid}"),
        Some(caller.rid.clone()),
        serde_json::json!({ "type": type_id, "rid": rid }),
    );

    let view = builtin_view(state, table, type_id, &rid).await?;
    Ok((StatusCode::CREATED, Json(view)))
}

/// PATCH for an org builtin: 404-leak-free load → coarse Edit gate → catalog
/// validation (400 unknown_field) → THE FIELD GATE (403 field_forbidden
/// naming the first blocked field; platform admin bypasses) → typed UPDATE of
/// exactly the provided columns.
async fn builtin_patch(
    state: &AppState,
    caller: Caller,
    type_id: &str,
    table: &str,
    rid: &str,
    body: PatchBody,
) -> Result<Json<ObjectView>, AppError> {
    let catalog = catalog_fields(&state.db, type_id).await?;
    let _ = builtin_view(state, table, type_id, rid).await?; // 404 on miss
    rbac::require_action(&state.db, &state.type_cache, &caller, rid, Action::Edit).await?;
    validate_payload(&catalog, &body.data, type_id)?;

    let written: Vec<&str> = body.data.keys().map(String::as_str).collect();
    field_perms::require_fields(&state.db, &state.type_cache, &caller, rid, type_id, &written)
        .await?;

    if !body.data.is_empty() {
        let mut sets = Vec::with_capacity(body.data.len());
        let mut binds: Vec<Option<String>> = Vec::with_capacity(body.data.len());
        for (i, (k, v)) in body.data.iter().enumerate() {
            sets.push(format!("{k} = ${}", i + 2));
            binds.push(v.as_str().map(str::to_string));
        }
        let sql = format!("UPDATE {table} SET {} WHERE redpash_id = $1", sets.join(", "));
        let mut q = sqlx::query(&sql).bind(rid);
        for b in &binds {
            q = q.bind(b);
        }
        q.execute(&state.db).await?;
    }

    event::info(
        &state.db,
        format!("{type_id}_update"),
        format!("updated {type_id} {rid}"),
        Some(caller.rid.clone()),
        serde_json::json!({ "type": type_id, "rid": rid }),
    );
    let mut view = builtin_view(state, table, type_id, rid).await?;
    mask_view(state, &caller, type_id, &mut view).await?;
    Ok(Json(view))
}

/// GET list for an org builtin — the REAL typed table, reach-scoped, same wire
/// shape as the entity_data list ({ items: [flat incl rid], total, all_count,
/// page, size }). `q` is the same coarse substring fallback, over the catalog
/// columns.
async fn builtin_list(
    state: &AppState,
    caller: &Caller,
    type_id: &str,
    table: &str,
    reach: &str,
    q: ListQuery,
) -> Result<Json<Value>, AppError> {
    let fields = registry_display_fields(&state.db, type_id)
        .await?
        .ok_or_else(|| AppError::internal("registry", format!("{type_id} is not a builtin")))?;
    let viewer: Option<Vec<String>> = if caller.is_platform_admin {
        None
    } else {
        Some(rbac::principals(&state.db, &caller.rid).await?)
    };
    let viewer_ref = viewer.as_deref();

    // ::text so non-text typed columns decode uniformly as Option<String> (and
    // concat_ws search coerces consistently); a no-op on the all-text columns.
    let cols = fields.iter().map(|(f, _)| format!("t.{f}::text")).collect::<Vec<_>>().join(", ");
    let search = format!("concat_ws(' ', {cols}) ILIKE '%' || $2 || '%'");

    let all_count: i64 =
        sqlx::query_scalar(&format!("SELECT COUNT(*)::BIGINT FROM {table} t WHERE {reach}"))
            .bind(viewer_ref)
            .fetch_one(&state.db)
            .await?;

    let total: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*)::BIGINT FROM {table} t WHERE {reach} AND ($2::text IS NULL OR {search})"
    ))
    .bind(viewer_ref)
    .bind(q.q.as_deref())
    .fetch_one(&state.db)
    .await?;

    let size = q.size.clamp(1, 500);
    let offset = (q.page.saturating_sub(1) * size) as i64;
    let rows = sqlx::query(&format!(
        "SELECT t.redpash_id, {cols} FROM {table} t
          WHERE {reach} AND ($2::text IS NULL OR {search})
          ORDER BY t.created_at DESC LIMIT $3 OFFSET $4"
    ))
    .bind(viewer_ref)
    .bind(q.q.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let mut m = Map::new();
        let rid: String = row.try_get(0)?;
        m.insert("rid".into(), Value::String(rid));
        for (i, (f, _)) in fields.iter().enumerate() {
            let v: Option<String> = row.try_get(i + 1)?;
            m.insert(f.clone(), v.map(Value::String).unwrap_or(Value::Null));
        }
        items.push(Value::Object(m));
    }

    // READ masking per row (see mask_fields): the matrix loads once; the
    // per-row tier resolve only runs when a hiding override is stored.
    if !caller.is_platform_admin {
        let matrix = field_perms::matrix(&state.db, type_id).await?;
        if !matrix.fully_readable() {
            for item in &mut items {
                let rid =
                    item.get("rid").and_then(Value::as_str).unwrap_or_default().to_string();
                let tier = caller_tier(state, caller, type_id, &rid).await?;
                let idx = field_perms::tier_index(tier.as_str())
                    .expect("rbac::Role strings align with TIERS");
                mask_fields(item, &matrix.unreadable(idx));
            }
        }
    }

    Ok(Json(serde_json::json!({
        "items": items,
        "total": total,
        "all_count": all_count,
        "page": q.page,
        "size": size,
    })))
}
