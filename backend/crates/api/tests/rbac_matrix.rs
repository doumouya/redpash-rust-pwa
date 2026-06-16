//! The seeded NON-ADMIN RBAC matrix — the Phase 2 exit gate.
//!
//! Every caller here is a real seeded user with is_platform_admin=false
//! (the predecessor's dev_user fake-green lesson: an admin caller silently
//! bypasses the very guard under test). Covers: cross-tenant default-deny,
//! transitive cascade (case→project→company, file→project→company —
//! recursion, not hand-written arms), team-closure grants, direct-vs-scope
//! reach, the entity_data custom-object arm, company_of, and the horizontal
//! contract intersection.
//!
//! Needs DATABASE_URL (e.g. postgres://mansa:mansa@localhost:5433/redpash_prerelease);
//! skips cleanly when unset so plain `cargo test` stays green offline.
//! Seeds are fresh rids per run and torn down through the entity registry
//! (one delete path — the cascade IS the cleanup).

use api::{
    db, id,
    rbac::{self, Action, Caller},
    type_cache::TypeDefCache,
};
use sqlx::PgPool;

fn caller(rid: &str) -> Caller {
    Caller { rid: rid.into(), is_platform_admin: false }
}

async fn seed_user(pool: &PgPool, name: &str) -> String {
    let rid = id::new("USR");
    let mut tx = pool.begin().await.unwrap();
    db::register_entity(&mut tx, &rid, "user").await.unwrap();
    sqlx::query("INSERT INTO users (redpash_id, username, display_name) VALUES ($1, $2, $2)")
        .bind(&rid)
        .bind(format!("{name}-{}", &rid[4..10]))
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    rid
}

async fn seed_entity(pool: &PgPool, prefix: &str, type_id: &str, insert: &str, binds: &[&str]) -> String {
    let rid = id::new(prefix);
    let mut tx = pool.begin().await.unwrap();
    db::register_entity(&mut tx, &rid, type_id).await.unwrap();
    let mut q = sqlx::query(insert).bind(&rid);
    for b in binds {
        q = q.bind(*b);
    }
    q.execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    rid
}

async fn edge(pool: &PgPool, object: &str, member: &str, role: &str) {
    sqlx::query("INSERT INTO memberships (object_redpash_id, member_redpash_id, role) VALUES ($1,$2,$3)")
        .bind(object)
        .bind(member)
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn non_admin_rbac_matrix() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("rbac_matrix: DATABASE_URL unset — skipped");
        return;
    };
    let pool = PgPool::connect(&url).await.expect("connect");
    sqlx::migrate!("../../migrations").run(&pool).await.expect("migrate");

    // A throwaway CUSTOM type so the entity_data arm is exercised through a
    // genuinely non-builtin path. Registered BEFORE the cache loads.
    let test_type = format!("rp_test_{}", &id::new("X")[2..8].to_lowercase());
    let test_prefix = "ZRP";
    sqlx::query(
        "INSERT INTO type_definitions (type_id, rid_prefix, display_name, display_name_plural,
         is_builtin, grid_served, ordinal, scope_parents)
         VALUES ($1, $2, 'Test', 'Tests', false, false, 999, '[\"scope_parent_id\"]')
         ON CONFLICT (rid_prefix) DO NOTHING",
    )
    .bind(&test_type)
    .bind(test_prefix)
    .execute(&pool)
    .await
    .unwrap();

    let cache = TypeDefCache::load(&pool).await.expect("type cache");

    // ── seed the world ──────────────────────────────────────────────────
    let alice = seed_user(&pool, "alice").await; // member of company A
    let bob = seed_user(&pool, "bob").await; // no edges at all
    let carol = seed_user(&pool, "carol").await; // in team eng
    let dave = seed_user(&pool, "dave").await; // direct owner of the case

    let cmp_a = seed_entity(&pool, "CMP", "company",
        "INSERT INTO companies (redpash_id, name) VALUES ($1, 'A')", &[]).await;
    let _cmp_b = seed_entity(&pool, "CMP", "company",
        "INSERT INTO companies (redpash_id, name) VALUES ($1, 'B')", &[]).await;
    let eng = seed_entity(&pool, "TEM", "team",
        "INSERT INTO teams (redpash_id, company_id, name) VALUES ($1, $2, 'eng')", &[&cmp_a]).await;
    let proj = seed_entity(&pool, "PRJ", "project",
        "INSERT INTO projects (redpash_id, company_id, name) VALUES ($1, $2, 'P')", &[&cmp_a]).await;
    let file = seed_entity(&pool, "FIL", "file",
        "INSERT INTO project_files (redpash_id, project_id, filename) VALUES ($1, $2, 'f.csv')",
        &[&proj]).await;
    let case = seed_entity(&pool, "CAS", "case",
        "INSERT INTO cases (redpash_id, company_id, project_id, title) VALUES ($1, $2, $3, 'c')",
        &[&cmp_a, &proj]).await;
    let custom = seed_entity(&pool, test_prefix, &test_type,
        "INSERT INTO entity_data (object_id, type_id, scope_parent_id) VALUES ($1, $2, $3)",
        &[&test_type.as_str(), &proj.as_str()]).await;

    edge(&pool, &cmp_a, &alice, "member").await; // alice → company A
    edge(&pool, &eng, &carol, "member").await; //   carol → team eng
    edge(&pool, &proj, &eng, "admin").await; //     team eng → admin on P
    edge(&pool, &case, &dave, "owner").await; //    dave → owner ON the case

    let gate = |c: &Caller, obj: &str, a: Action| {
        let (pool, cache, c, obj) = (pool.clone(), &cache, c.clone(), obj.to_string());
        async move { rbac::require_action(&pool, cache, &c, &obj, a).await }
    };

    // ── cascade reach (company member → everything under it, transitively) ─
    assert!(gate(&caller(&alice), &case, Action::View).await.is_ok(), "alice views case via company cascade");
    assert!(gate(&caller(&alice), &file, Action::View).await.is_ok(), "alice views file via file→project→company recursion");
    assert!(gate(&caller(&alice), &case, Action::Delete).await.is_err(), "member tier cannot delete");

    // ── default deny + leak-free shape ──────────────────────────────────
    let bob_err = gate(&caller(&bob), &case, Action::View).await.unwrap_err();
    assert_eq!(bob_err.status, axum::http::StatusCode::NOT_FOUND, "denial is 404, never 403");
    assert!(gate(&caller(&bob), &custom, Action::View).await.is_err(), "no edge, no custom object");

    // ── team closure + scope tiers ──────────────────────────────────────
    assert!(gate(&caller(&carol), &case, Action::Edit).await.is_ok(), "carol edits via team→project admin");
    assert!(gate(&caller(&carol), &case, Action::Delete).await.is_ok(), "scope admin deletes");
    assert!(gate(&caller(&carol), &custom, Action::View).await.is_ok(), "entity_data arm cascades to project");

    // ── direct vs scope reach ───────────────────────────────────────────
    let g = rbac::resolve_grant(&pool, &cache, &dave, &case).await.unwrap();
    assert!(g.is_member() && g.scope.is_none(), "dave is direct-only");
    assert!(gate(&caller(&dave), &case, Action::Delete).await.is_ok(), "direct owner deletes");
    assert!(gate(&caller(&dave), &file, Action::View).await.is_err(), "case ownership grants nothing on siblings");

    // ── company_of rides the same generated CTE ─────────────────────────
    assert_eq!(rbac::company_of(&pool, &cache, &case).await.unwrap().as_deref(), Some(cmp_a.as_str()));
    assert_eq!(rbac::company_of(&pool, &cache, &file).await.unwrap().as_deref(), Some(cmp_a.as_str()));

    // ── horizontal contract: tier ∩ per-team object-TYPE grants ─────────
    sqlx::query("INSERT INTO company_rbac (company_id, version, contract) VALUES ($1, 1, $2)")
        .bind(&cmp_a)
        .bind(serde_json::json!({
            "company": cmp_a, "grants": { eng.clone(): { "case": ["r", "u"] } }
        }))
        .execute(&pool)
        .await
        .unwrap();
    assert!(gate(&caller(&carol), &case, Action::Edit).await.is_ok(), "contract grants eng u on case");
    assert!(gate(&caller(&carol), &case, Action::Delete).await.is_err(), "contract withholds d — even from a scope admin");
    // Once a contract exists, a bare company member not keyed in any granted
    // team loses access entirely — tier alone no longer suffices (the
    // horizontal axis is now load-bearing). This is the model working.
    assert!(gate(&caller(&alice), &case, Action::View).await.is_err(), "no contract grant keys alice's principals → denied");
    assert!(gate(&caller(&alice), &case, Action::Edit).await.is_err(), "tier alone no longer suffices once a contract exists");

    // ── teardown: ONE delete path — the registry cascade ────────────────
    sqlx::query("DELETE FROM company_rbac WHERE company_id = $1").bind(&cmp_a).execute(&pool).await.unwrap();
    for rid in [&custom, &case, &file, &proj, &eng, &cmp_a, &_cmp_b, &alice, &bob, &carol, &dave] {
        db::delete_entity(&pool, rid).await.unwrap();
    }
    sqlx::query("DELETE FROM type_definitions WHERE type_id = $1").bind(&test_type).execute(&pool).await.unwrap();
}
