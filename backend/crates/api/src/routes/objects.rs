//! Purpose: the generic object resource — `/api/objects/:type[/:rid]` CRUD over
//! the polymorphic `entity_data` (JSONB) store. ONE handler for every
//! TypeDefinition-declared custom type: declaring a type (Stage 3
//! `register_type`) gives it full CRUD + RBAC + audit + field validation with
//! zero new code (object-registry Stage 2, CAS_0FBF301F). Builtins keep their
//! typed tables + bespoke routes (Hybrid-C storage); only custom types route
//! here. Gating reuses the type-agnostic `rbac::resolve_grant` + `require_fields`;
//! validation reuses `validate_rules::validate_value` off the type's catalog.
//! Doc: docs/internal/code/backend/api/routes/objects.md

use std::time::Instant;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use shared::Page;
use sqlx::types::Json as SqlxJson;

use crate::error::AppError;
use crate::rbac::Role;
use crate::state::AppState;
use crate::validate_rules::Row;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/:type", get(list).post(create))
        .route("/:type/:rid", get(get_one).patch(patch).delete(delete_one))
}

#[derive(Serialize)]
struct ObjectView {
    #[serde(rename = "type")]
    type_id: String,
    rid:     String,
    owner:   String,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope_parent: Option<String>,
    data:    Value,
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

/// 404 if `type_id` isn't a registered type (leak-free — same shape as an
/// unknown object).
fn require_type(state: &AppState, type_id: &str) -> Result<(), AppError> {
    if state.type_cache.is_type(type_id) {
        Ok(())
    } else {
        Err(AppError::not_found("not_found", format!("unknown type {type_id}")))
    }
}

/// Validate each provided field against the type's catalog (`data_type` +
/// options), with `row` carrying the merged current+proposed values for
/// cross-field rules. A field not in the catalog is a 400.
fn validate_fields(
    state:   &AppState,
    type_id: &str,
    data:    &Map<String, Value>,
    row:     &Row,
) -> Result<(), AppError> {
    for (field, value) in data {
        let def = state
            .type_cache
            .find_default(type_id, field)
            .ok_or_else(|| AppError::bad_request("unknown_field", format!("{type_id} has no field {field}")))?;
        let outcome =
            crate::validate_rules::validate_value(def.data_type, &def.options, field, &[], value, row);
        if let Some(v) = outcome.errors.first() {
            let kind = if v.rule_code == "data_type" { "data_type" } else { "invalid" };
            return Err(AppError::bad_request(kind, v.message.clone()));
        }
    }
    Ok(())
}

/// `POST /api/objects/:type` — create a custom object. Validates the body fields
/// against the type catalog, then (one tx) registers the entity, inserts the
/// `entity_data` row, and auto-grants the creator an `owner` membership so RBAC
/// resolves without the scope cascade. 404 unknown type.
async fn create(
    State(state):  State<AppState>,
    headers:       HeaderMap,
    Path(type_id): Path<String>,
    Json(body):    Json<CreateBody>,
) -> Result<(StatusCode, Json<ObjectView>), AppError> {
    let caller = super::resolve_user_rid(&state, &headers).await?;
    require_type(&state, &type_id)?;

    let merged: Row = body.data.clone().into_iter().collect();
    validate_fields(&state, &type_id, &body.data, &merged)?;

    // IDOR guard (runbook: objects-scope-parent-idor, case pending). `scope_parent_id`
    // is caller-supplied; without a reach check any authenticated user could graft this
    // object under a scope they don't belong to — it would then surface to that scope's
    // members (the list REACH clause) and hand its admins cascade write over it. Require
    // >=Member reach on the parent — the same write-into-parent rule as connectors.rs.
    // require_grant 404s a parent the caller can't reach (leak-free: existing-but-foreign
    // is indistinguishable from missing); object_kind default-denies an unknown id (it
    // resolves an empty grant -> 404).
    if let Some(parent) = body.scope_parent_id.as_deref() {
        let kind = state.type_cache.object_kind(parent);
        crate::rbac::require_grant(&state, &caller, parent, kind, |g| {
            g.effective().is_some_and(|r| r >= Role::Member)
        })
        .await?;
    }

    let prefix = state
        .type_cache
        .rid_prefix(&type_id)
        .ok_or_else(|| AppError::internal("registry", "type missing rid_prefix"))?;
    let rid = crate::id::new(prefix.trim_end_matches('_'));
    let data_val = Value::Object(body.data);

    let mut tx = state.db.begin().await?;
    crate::db::register_entity(&mut *tx, &rid, &type_id).await?;
    sqlx::query(
        "INSERT INTO entity_data (object_id, type_id, owner_id, scope_parent_id, data) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&rid)
    .bind(&type_id)
    .bind(&caller)
    .bind(&body.scope_parent_id)
    .bind(&data_val)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO memberships (object_redpash_id, member_redpash_id, role, context_role) \
         VALUES ($1, $2, 'owner', '')",
    )
    .bind(&rid)
    .bind(&caller)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    crate::event::info(&state.db, format!("{type_id}_create"), format!("created {type_id} {rid}"))
        .user(caller.clone())
        .context(serde_json::json!({ "type": type_id, "rid": rid }))
        .send();

    Ok((
        StatusCode::CREATED,
        Json(ObjectView { type_id, rid, owner: caller, scope_parent: body.scope_parent_id, data: data_val }),
    ))
}

/// `GET /api/objects/:type/:rid` — one object. `case.view`-equivalent: any reach
/// (the resolver). 404 on a type mismatch or no reach (leak-free).
async fn get_one(
    State(state):        State<AppState>,
    headers:             HeaderMap,
    Path((type_id, rid)): Path<(String, String)>,
) -> Result<Json<ObjectView>, AppError> {
    let caller = super::resolve_user_rid(&state, &headers).await?;
    require_type(&state, &type_id)?;
    let row = load(&state, &type_id, &rid).await?;
    crate::rbac::require_view(&state, &caller, &rid, &type_id).await?;
    Ok(Json(row))
}

/// `PATCH /api/objects/:type/:rid` — merge field changes. Coarse gate (member+ on
/// the object) → field-level `require_fields` → `validate_value` per changed
/// field (merging stored values for cross-field rules) → JSONB merge.
async fn patch(
    State(state):        State<AppState>,
    headers:             HeaderMap,
    Path((type_id, rid)): Path<(String, String)>,
    Json(body):          Json<PatchBody>,
) -> Result<Json<ObjectView>, AppError> {
    let caller = super::resolve_user_rid(&state, &headers).await?;
    require_type(&state, &type_id)?;
    let current = load(&state, &type_id, &rid).await?;

    crate::rbac::require_grant(&state, &caller, &rid, &type_id, |g| {
        g.effective().is_some_and(|r| r >= Role::Member)
    })
    .await?;
    let fields: Vec<&str> = body.data.keys().map(String::as_str).collect();
    crate::field_perms::require_fields(&state, &caller, &rid, &type_id, &fields).await?;

    // Merge stored + proposed for cross-field rules, then validate.
    let mut merged_map = match current.data {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    let row: Row = merged_map
        .clone()
        .into_iter()
        .chain(body.data.clone())
        .collect();
    validate_fields(&state, &type_id, &body.data, &row)?;

    for (k, v) in body.data {
        merged_map.insert(k, v);
    }
    let data_val = Value::Object(merged_map);
    sqlx::query("UPDATE entity_data SET data = $1, updated_at = now() WHERE object_id = $2")
        .bind(&data_val)
        .bind(&rid)
        .execute(&state.db)
        .await?;

    crate::event::info(&state.db, format!("{type_id}_update"), format!("updated {type_id} {rid}"))
        .user(caller)
        .context(serde_json::json!({ "type": type_id, "rid": rid }))
        .send();

    Ok(Json(ObjectView {
        type_id,
        rid,
        owner: current.owner,
        scope_parent: current.scope_parent,
        data: data_val,
    }))
}

/// `DELETE /api/objects/:type/:rid` — admin+ on the object. Deletes the entity
/// (cascades `entity_data`) + the object's memberships, in one tx.
async fn delete_one(
    State(state):        State<AppState>,
    headers:             HeaderMap,
    Path((type_id, rid)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    let caller = super::resolve_user_rid(&state, &headers).await?;
    require_type(&state, &type_id)?;
    let _ = load(&state, &type_id, &rid).await?; // 404 if missing / type mismatch
    crate::rbac::require_grant(&state, &caller, &rid, &type_id, |g| {
        g.effective().is_some_and(|r| r >= Role::Admin)
    })
    .await?;

    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM memberships WHERE object_redpash_id = $1")
        .bind(&rid)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM entities WHERE id = $1")
        .bind(&rid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    crate::event::warn(&state.db, format!("{type_id}_delete"), format!("deleted {type_id} {rid}"))
        .user(caller)
        .context(serde_json::json!({ "type": type_id, "rid": rid }))
        .send();
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/objects/:type` — the caller's RBAC-reachable rows of the type, as a
/// paginated `Page<Value>`. A **builtin** type delivers via its registered reach
/// provider (typed table); a **custom** type falls through to the `entity_data`
/// default below. Reach via `list_viewer` (admin → no filter). SHAPING
/// (filter/search/sort/page) runs in the data-engine wasm on the CLIENT under the
/// row cap; `page/size/q/sort` here drive only the over-cap server fallback.
async fn list(
    State(state):  State<AppState>,
    headers:       HeaderMap,
    Path(type_id): Path<String>,
    Query(q):      Query<super::admin::AdminQuery>,
) -> Result<Json<Page<Value>>, AppError> {
    let caller = super::resolve_user_rid(&state, &headers).await?;
    require_type(&state, &type_id)?;
    let viewer = super::list_viewer(&state, &caller).await?;
    let page = match super::list_registry::registry().get(&type_id) {
        Some(p) => (p.list)(&state, &caller, &q, viewer.as_deref()).await?,
        None    => entity_data_page(&state, &type_id, &q, viewer.as_deref()).await?,
    };
    Ok(Json(page))
}

/// Custom-type fallback: reach-scoped paginated page over `entity_data`. Reach =
/// direct membership on the object OR its `scope_parent` (the cascade — Stage 2
/// was direct-only). Rows are the `data` JSONB with `rid`/`owner`/`scope_parent`
/// merged in at top level (flat, like the typed providers). `viewer = None` ⇒
/// admin (every row). Optional `q` does a coarse `data::text` substring match for
/// the over-cap server fallback; the client engine does the real filtering.
async fn entity_data_page(
    state:   &AppState,
    type_id: &str,
    q:       &super::admin::AdminQuery,
    viewer:  Option<&[String]>,
) -> Result<Page<Value>, AppError> {
    let started = Instant::now();
    let (offset, size, page) = super::pagination::paginate(q.page, q.size);

    const REACH: &str = "($2::text[] IS NULL OR EXISTS (SELECT 1 FROM memberships m \
         WHERE m.member_redpash_id = ANY($2) \
           AND m.object_redpash_id IN (ed.object_id, ed.scope_parent_id)))";

    let all_count: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*)::BIGINT FROM entity_data ed WHERE ed.type_id = $1 AND {REACH}"
    ))
    .bind(type_id)
    .bind(viewer)
    .fetch_one(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*)::BIGINT FROM entity_data ed WHERE ed.type_id = $1 AND {REACH} \
            AND ($3::text IS NULL OR ed.data::text ILIKE '%' || $3 || '%')"
    ))
    .bind(type_id)
    .bind(viewer)
    .bind(q.q.as_deref())
    .fetch_one(&state.db)
    .await?;

    let rows: Vec<(String, String, Option<String>, SqlxJson<Value>)> = sqlx::query_as(&format!(
        "SELECT ed.object_id, ed.owner_id, ed.scope_parent_id, ed.data \
           FROM entity_data ed \
          WHERE ed.type_id = $1 AND {REACH} \
            AND ($3::text IS NULL OR ed.data::text ILIKE '%' || $3 || '%') \
          ORDER BY ed.created_at DESC LIMIT $4 OFFSET $5"
    ))
    .bind(type_id)
    .bind(viewer)
    .bind(q.q.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let rows: Vec<Value> = rows
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
            m.insert("owner".into(), Value::String(owner));
            if let Some(sp) = scope_parent {
                m.insert("scope_parent".into(), Value::String(sp));
            }
            Value::Object(m)
        })
        .collect();

    Ok(super::pagination::build_page(rows, total as u64, all_count as u64, page, size, started))
}

/// Load one object's `entity_data` row → `ObjectView`, enforcing the type
/// matches (404 leak-free on miss / mismatch).
async fn load(state: &AppState, type_id: &str, rid: &str) -> Result<ObjectView, AppError> {
    let row: Option<(String, String, Option<String>, SqlxJson<Value>)> = sqlx::query_as(
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

// ─────────────────────────────────────────────────────────────────────────────
// Regression test — `scope_parent_id` IDOR (CAS_DD6F55FB, runbook
// objects-scope-parent-idor). The fix (commit d3f933a) gates a caller-supplied
// `scope_parent_id` behind `require_grant(... >= Member)` so an authenticated
// user can't graft an object under a scope they don't belong to. These tests
// PIN that guard: they call the module-private `create(...)` DIRECTLY and assert
// on the returned `Result` (StatusCode on Ok, AppError.status on Err) — no axum
// server, no visibility change to `create`.
//
// HARNESS: the dogfood pattern from `postgres_loader.rs` — `#[tokio::test]
// #[ignore]` against the LIVE app Postgres at 127.0.0.1:5433 / mansa:mansa /
// redpash_prerelease. Run explicitly:
//   cargo test -p api -- --ignored scope_parent_idor --nocapture
//
// CRITICAL trap (architect-flagged): the non-admin caller is a REAL seeded
// `users` row reached via an `rp_session` cookie — NOT `state.dev_user`. A
// dev_user caller trips `is_platform_admin`'s fast-path and would silently
// bypass the very guard under test (a fake-green). Each test seeds two `company`
// scopes (A, B) + a caller + a session, and tears the seeded rows down at the end
// (entities-cascade covers the data/membership rows; users + session deleted
// explicitly) so the shared DB stays clean.
#[cfg(test)]
mod scope_parent_idor_tests {
    use super::*;
    use axum::extract::{Path, State};
    use axum::http::header::{HeaderMap, HeaderValue, COOKIE};
    use sqlx::PgPool;

    const TYPE_ID: &str = "connection";

    /// The seeded fixture for one test: two `company` scopes + a caller `users`
    /// row + a live session. Hold it for the duration of the test, then call
    /// [`Seed::teardown`] to delete exactly what we minted.
    struct Seed {
        scope_a: String,
        scope_b: String,
        caller:  String,
        sid:     String,
    }

    impl Seed {
        /// Mint scope A, scope B, and the caller. `caller_role` is the
        /// `users.role` value (`"user"` for a normal caller, `"admin"` for a
        /// platform admin — AC-4). `member_of_a` adds a `member` edge on scope A.
        async fn create(pool: &PgPool, caller_role: &str, member_of_a: bool) -> Seed {
            let scope_a = crate::id::new("CMP");
            let scope_b = crate::id::new("CMP");
            let caller = crate::id::new("USR");

            // scope A + scope B — real `company` entities (register entity, then
            // the companies subtype row; slug is UNIQUE so derive it from the rid).
            for scope in [&scope_a, &scope_b] {
                crate::db::register_entity(pool, scope, "company").await.expect("register company entity");
                sqlx::query("INSERT INTO companies (redpash_id, name, slug) VALUES ($1, $2, $3)")
                    .bind(scope)
                    .bind(format!("idor-test {scope}"))
                    .bind(scope.to_lowercase())
                    .execute(pool)
                    .await
                    .expect("insert company");
            }

            // caller — a real `users` row (entity FIRST, per users_entity_fk).
            crate::db::register_entity(pool, &caller, "user").await.expect("register user entity");
            sqlx::query("INSERT INTO users (redpash_id, username, display_name, role) VALUES ($1, $2, $3, $4)")
                .bind(&caller)
                .bind(format!("idor-caller-{caller}"))
                .bind("IDOR Test Caller")
                .bind(caller_role)
                .execute(pool)
                .await
                .expect("insert user");

            if member_of_a {
                sqlx::query(
                    "INSERT INTO memberships (object_redpash_id, member_redpash_id, role, context_role) \
                     VALUES ($1, $2, 'member', '')",
                )
                .bind(&scope_a)
                .bind(&caller)
                .execute(pool)
                .await
                .expect("seed member edge on scope A");
            }

            let sid = crate::db::create_session(pool, &caller, 1).await.expect("create session");

            Seed { scope_a, scope_b, caller, sid }
        }

        /// `Cookie: rp_session=<sid>` so `resolve_user_rid` resolves THIS caller
        /// (never `state.dev_user` — that would fast-path the platform-admin
        /// bypass and hide the guard).
        fn headers(&self) -> HeaderMap {
            let mut h = HeaderMap::new();
            h.insert(
                COOKIE,
                HeaderValue::from_str(&format!("rp_session={}", self.sid)).expect("cookie header"),
            );
            h
        }

        /// Delete exactly what we seeded. `entities` cascade removes the
        /// companies rows, the user's owned `entity_data`, and every membership
        /// edge FK'd into the registry; the `users` row and the `sessions` row
        /// FK separately (users → entities is the user entity we drop; sessions
        /// reference the user) so delete those explicitly and first.
        async fn teardown(&self, pool: &PgPool) {
            let _ = sqlx::query("DELETE FROM sessions WHERE redpash_id = $1")
                .bind(&self.sid)
                .execute(pool)
                .await;
            // Any objects created in-test under this caller (AC-2/3/4) — drop via
            // their entity so entity_data + memberships cascade.
            let owned: Vec<(String,)> =
                sqlx::query_as("SELECT object_id FROM entity_data WHERE owner_id = $1")
                    .bind(&self.caller)
                    .fetch_all(pool)
                    .await
                    .unwrap_or_default();
            for (oid,) in owned {
                let _ = crate::db::delete_entity(pool, &oid).await;
            }
            let _ = sqlx::query("DELETE FROM users WHERE redpash_id = $1")
                .bind(&self.caller)
                .execute(pool)
                .await;
            for scope in [&self.scope_a, &self.scope_b] {
                let _ = crate::db::delete_entity(pool, scope).await;
            }
        }
    }

    /// Build the full `AppState` the way the binary does — `AppState::init()`
    /// runs migrate (idempotent on the live DB) + bootstrap + loads the
    /// `type_cache`, so `create` sees a real `connection` type and a real
    /// `object_kind`/`rid_prefix`. Points `DATABASE_URL` at the live prerelease
    /// DB (the dogfood target). OAuth stays off → cookie-session resolution.
    async fn live_state() -> AppState {
        std::env::set_var(
            "DATABASE_URL",
            "postgres://mansa:mansa@127.0.0.1:5433/redpash_prerelease",
        );
        // Keep on-disk artifacts out of the repo root.
        std::env::set_var("REDPASH_DATA_DIR", std::env::temp_dir().join("redpash-idor-test").to_string_lossy().to_string());
        AppState::init().await.expect("AppState::init against live prerelease DB")
    }

    /// Count `entity_data` rows owned by `caller` — used to prove the denied
    /// path (AC-1) wrote NOTHING.
    async fn owned_rows(pool: &PgPool, caller: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*)::BIGINT FROM entity_data WHERE owner_id = $1")
            .bind(caller)
            .fetch_one(pool)
            .await
            .expect("count owned rows")
    }

    /// AC-1 — FOREIGN-PARENT INJECTION DENIED (the bug, now fixed).
    /// Caller is a Member of scope A only; create with `scope_parent_id = B`
    /// (no reach to B) ⇒ 404 (AppError.status == NOT_FOUND), and NO `entity_data`
    /// row is written.
    #[tokio::test]
    #[ignore]
    async fn scope_parent_idor_ac1_foreign_parent_denied() {
        let state = live_state().await;
        let seed = Seed::create(&state.db, "user", /* member_of_a */ true).await;

        let before = owned_rows(&state.db, &seed.caller).await;
        let body = CreateBody { data: Map::new(), scope_parent_id: Some(seed.scope_b.clone()) };
        let result = create(
            State(state.clone()),
            seed.headers(),
            Path(TYPE_ID.to_string()),
            Json(body),
        )
        .await;

        let err = result.err().expect("AC-1: foreign-parent create must be denied");
        assert_eq!(
            err.status,
            StatusCode::NOT_FOUND,
            "AC-1: denial must be leak-free 404 (got {})",
            err.status,
        );
        let after = owned_rows(&state.db, &seed.caller).await;
        assert_eq!(after, before, "AC-1: no entity_data row may be written on a denied create");

        seed.teardown(&state.db).await;
    }

    /// AC-2 — OWN-PARENT ATTACH ALLOWED.
    /// Caller is a Member of A; create with `scope_parent_id = A` ⇒ 201 CREATED;
    /// the persisted row has `scope_parent_id = A`, `owner_id = caller`, and an
    /// auto-created `owner` membership edge on the new object.
    #[tokio::test]
    #[ignore]
    async fn scope_parent_idor_ac2_own_parent_allowed() {
        let state = live_state().await;
        let seed = Seed::create(&state.db, "user", /* member_of_a */ true).await;

        let body = CreateBody { data: Map::new(), scope_parent_id: Some(seed.scope_a.clone()) };
        let (status, Json(view)) = create(
            State(state.clone()),
            seed.headers(),
            Path(TYPE_ID.to_string()),
            Json(body),
        )
        .await
        .expect("AC-2: own-parent create must succeed");

        assert_eq!(status, StatusCode::CREATED, "AC-2: own-parent attach is 201");
        assert_eq!(view.scope_parent.as_deref(), Some(seed.scope_a.as_str()), "AC-2: view echoes scope A");
        assert_eq!(view.owner, seed.caller, "AC-2: owner is the caller");

        // Persisted row.
        let row: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT owner_id, scope_parent_id FROM entity_data WHERE object_id = $1",
        )
        .bind(&view.rid)
        .fetch_optional(&state.db)
        .await
        .expect("load persisted row");
        let (owner_id, scope_parent_id) = row.expect("AC-2: entity_data row must exist");
        assert_eq!(owner_id, seed.caller, "AC-2: persisted owner_id is the caller");
        assert_eq!(scope_parent_id.as_deref(), Some(seed.scope_a.as_str()), "AC-2: persisted scope_parent_id is A");

        // Auto `owner` membership edge on the new object.
        let owner_edges: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::BIGINT FROM memberships \
             WHERE object_redpash_id = $1 AND member_redpash_id = $2 AND role = 'owner'",
        )
        .bind(&view.rid)
        .bind(&seed.caller)
        .fetch_one(&state.db)
        .await
        .expect("count owner edges");
        assert_eq!(owner_edges, 1, "AC-2: exactly one auto owner membership edge on the new object");

        seed.teardown(&state.db).await;
    }

    /// AC-3 — OMITTED PARENT ALLOWED (the guard only fires when a parent is
    /// supplied). Non-admin caller, `scope_parent_id = None` ⇒ 201 with
    /// `scope_parent = None`. Caller need not be a member of anything.
    #[tokio::test]
    #[ignore]
    async fn scope_parent_idor_ac3_omitted_parent_allowed() {
        let state = live_state().await;
        let seed = Seed::create(&state.db, "user", /* member_of_a */ false).await;

        let body = CreateBody { data: Map::new(), scope_parent_id: None };
        let (status, Json(view)) = create(
            State(state.clone()),
            seed.headers(),
            Path(TYPE_ID.to_string()),
            Json(body),
        )
        .await
        .expect("AC-3: no-parent create must succeed");

        assert_eq!(status, StatusCode::CREATED, "AC-3: omitted-parent create is 201");
        assert_eq!(view.scope_parent, None, "AC-3: scope_parent stays None when omitted");

        let scope_parent_id: Option<String> =
            sqlx::query_scalar("SELECT scope_parent_id FROM entity_data WHERE object_id = $1")
                .bind(&view.rid)
                .fetch_one(&state.db)
                .await
                .expect("load persisted scope_parent_id");
        assert_eq!(scope_parent_id, None, "AC-3: persisted scope_parent_id is NULL");

        seed.teardown(&state.db).await;
    }

    /// AC-4 — PLATFORM ADMIN BYPASSES (intended). Caller has `users.role='admin'`
    /// (NOT via the dev_user fast-path — a real seeded admin). Create with
    /// `scope_parent_id = B` (no membership on B) ⇒ 201, proving the
    /// `is_platform_admin` bypass is deliberate, not a hole.
    #[tokio::test]
    #[ignore]
    async fn scope_parent_idor_ac4_platform_admin_bypass() {
        let state = live_state().await;
        let seed = Seed::create(&state.db, "admin", /* member_of_a */ false).await;
        // Sanity: the admin caller must NOT be the bootstrap dev_user — otherwise
        // AC-4 would pass via the fast-path, not the role='admin' branch.
        assert_ne!(
            seed.caller.as_str(),
            state.dev_user.as_ref().as_str(),
            "AC-4: admin caller must be a distinct seeded user, not dev_user",
        );

        let body = CreateBody { data: Map::new(), scope_parent_id: Some(seed.scope_b.clone()) };
        let (status, Json(view)) = create(
            State(state.clone()),
            seed.headers(),
            Path(TYPE_ID.to_string()),
            Json(body),
        )
        .await
        .expect("AC-4: platform-admin foreign-parent create must succeed");

        assert_eq!(status, StatusCode::CREATED, "AC-4: platform admin bypasses the reach gate (201)");
        assert_eq!(view.scope_parent.as_deref(), Some(seed.scope_b.as_str()), "AC-4: view echoes scope B");

        seed.teardown(&state.db).await;
    }
}
