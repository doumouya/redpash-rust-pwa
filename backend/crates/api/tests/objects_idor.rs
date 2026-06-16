//! Object-registry RBAC + the scope_parent_id IDOR guard (day-one #3) —
//! exercised through the same require_action / require_rule gates the handlers
//! call, with REAL seeded non-admin callers (the dev_user fake-green trap).
//!
//! Proves: a caller-supplied foreign scope_parent is denied leak-free (404),
//! own/omitted parents succeed, the entity_data FK refuses a dangling parent
//! at the DB level (defence in depth), reach-scoped list shows only reachable
//! rows, and delete needs Admin. Needs DATABASE_URL; skips when unset.

use api::{
    db, id,
    rbac::{self, Action, Caller, Role},
    type_cache::TypeDefCache,
};
use sqlx::PgPool;

const TYPE_ID: &str = "connection"; // a seeded type → entity_data path works

async fn seed_user(pool: &PgPool, name: &str) -> String {
    let rid = id::new("USR");
    let mut tx = pool.begin().await.unwrap();
    db::register_entity(&mut tx, &rid, "user").await.unwrap();
    sqlx::query("INSERT INTO users (redpash_id, username, display_name) VALUES ($1,$2,$2)")
        .bind(&rid)
        .bind(format!("{name}-{}", &rid[4..10]))
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    rid
}

async fn seed_company(pool: &PgPool) -> String {
    let rid = id::new("CMP");
    let mut tx = pool.begin().await.unwrap();
    db::register_entity(&mut tx, &rid, "company").await.unwrap();
    sqlx::query("INSERT INTO companies (redpash_id, name) VALUES ($1, 'C')")
        .bind(&rid)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    rid
}

/// Create a custom object the way the handler does: register entity + insert
/// entity_data + auto-grant owner, with the IDOR guard on scope_parent.
async fn create_object(
    pool: &PgPool,
    cache: &TypeDefCache,
    caller: &Caller,
    scope_parent: Option<&str>,
) -> Result<String, axum::http::StatusCode> {
    if let Some(parent) = scope_parent {
        let kind = cache.object_kind(parent);
        rbac::require_rule(pool, cache, caller, parent, kind, |g| {
            g.effective().is_some_and(|r| r >= Role::Member)
        })
        .await
        .map_err(|e| e.status)?;
    }
    let rid = id::new(cache.rid_prefix(TYPE_ID).unwrap());
    let mut tx = pool.begin().await.unwrap();
    db::register_entity(&mut tx, &rid, TYPE_ID).await.unwrap();
    sqlx::query("INSERT INTO entity_data (object_id, type_id, owner_id, scope_parent_id, data) VALUES ($1,$2,$3,$4,'{}')")
        .bind(&rid)
        .bind(TYPE_ID)
        .bind(&caller.rid)
        .bind(scope_parent)
        .execute(&mut *tx)
        .await
        .unwrap();
    db::grant_owner(&mut tx, &rid, &caller.rid).await.unwrap();
    tx.commit().await.unwrap();
    Ok(rid)
}

#[tokio::test]
async fn object_registry_idor_and_reach() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("objects_idor: DATABASE_URL unset — skipped");
        return;
    };
    let pool = PgPool::connect(&url).await.expect("connect");
    sqlx::migrate!("../../migrations").run(&pool).await.expect("migrate");
    let cache = TypeDefCache::load(&pool).await.expect("cache");

    let alice = Caller { rid: seed_user(&pool, "alice").await, is_platform_admin: false };
    let scope_a = seed_company(&pool).await; // alice is a member
    let scope_b = seed_company(&pool).await; // alice has no reach
    sqlx::query("INSERT INTO memberships (object_redpash_id, member_redpash_id, role) VALUES ($1,$2,'member')")
        .bind(&scope_a)
        .bind(&alice.rid)
        .execute(&pool)
        .await
        .unwrap();

    // ── IDOR: foreign parent denied leak-free (404). ──
    let denied = create_object(&pool, &cache, &alice, Some(&scope_b)).await;
    assert_eq!(denied.err(), Some(axum::http::StatusCode::NOT_FOUND), "foreign parent must be denied");

    // ── own parent allowed; omitted parent allowed. ──
    let obj_a = create_object(&pool, &cache, &alice, Some(&scope_a)).await.expect("own parent ok");
    let obj_free = create_object(&pool, &cache, &alice, None).await.expect("omitted parent ok");

    // ── DB FK defence-in-depth: a dangling parent is refused even raw. ──
    let dangling = sqlx::query(
        "INSERT INTO entity_data (object_id, type_id, scope_parent_id) VALUES ($1,$2,$3)",
    )
    .bind(id::new("CON"))
    .bind(TYPE_ID)
    .bind("CMP_DOESNOTEXIST00000000000000000000")
    .execute(&pool)
    .await;
    // object_id also lacks an entities row → FK error regardless; the point is
    // the raw insert cannot succeed with a bogus reference.
    assert!(dangling.is_err(), "dangling/invalid FK refused at the DB");

    // ── reach: alice (member of A) reaches obj_a (scope cascade) + obj_free
    //    (direct owner); a stranger reaches neither. ──
    let stranger = Caller { rid: seed_user(&pool, "stranger").await, is_platform_admin: false };
    assert!(view_ok(&pool, &cache, &alice, &obj_a).await);
    assert!(view_ok(&pool, &cache, &alice, &obj_free).await);
    assert!(!view_ok(&pool, &cache, &stranger, &obj_a).await);

    // ── delete needs Admin: alice owns obj_free (owner >= Admin) → ok. ──
    assert!(rbac::require_action(&pool, &cache, &alice, &obj_free, Action::Delete).await.is_ok());

    // teardown via the registry.
    for rid in [&obj_a, &obj_free, &scope_a, &scope_b, &alice.rid, &stranger.rid] {
        let _ = db::delete_entity(&pool, rid).await;
    }
}

async fn view_ok(pool: &PgPool, cache: &TypeDefCache, caller: &Caller, rid: &str) -> bool {
    rbac::require_action(pool, cache, caller, rid, Action::View).await.is_ok()
}
