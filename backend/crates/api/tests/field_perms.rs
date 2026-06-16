//! S7 field gate + /api/types contract — exercised through the SAME functions
//! the handlers call (field_perms::require_fields, types::payload), with REAL
//! seeded NON-ADMIN callers (the dev_user fake-green trap: a platform admin
//! bypasses the very gate under test).
//!
//! Proves: member tier cannot write an owner_grade field (403 field_forbidden),
//! owner can, readonly blocks even the owner (platform admin bypasses), a
//! field_permissions override row flips a cell live, and GET /api/types serves
//! the seeded catalog in ordinal order with derived ⊕ overlaid cells.
//! Needs DATABASE_URL; skips cleanly when unset.

use api::{
    db, field_perms, id,
    rbac::Caller,
    type_cache::TypeDefCache,
    types,
};
use axum::http::StatusCode;
use sqlx::PgPool;

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

async fn edge(pool: &PgPool, object: &str, member: &str, role: &str) {
    sqlx::query(
        "INSERT INTO memberships (object_redpash_id, member_redpash_id, role) VALUES ($1,$2,$3)",
    )
    .bind(object)
    .bind(member)
    .bind(role)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn field_gate_and_types_contract() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("field_perms: DATABASE_URL unset — skipped");
        return;
    };
    let pool = PgPool::connect(&url).await.expect("connect");
    sqlx::migrate!("../../migrations").run(&pool).await.expect("migrate");
    let cache = TypeDefCache::load(&pool).await.expect("cache");

    // ── seeded non-admin callers on a user object ───────────────────────
    let owner = Caller { rid: seed_user(&pool, "fp-owner").await, is_platform_admin: false };
    let member = Caller { rid: seed_user(&pool, "fp-member").await, is_platform_admin: false };
    let victim = seed_user(&pool, "fp-victim").await;
    edge(&pool, &victim, &owner.rid, "owner").await;
    edge(&pool, &victim, &member.rid, "member").await;

    let gate = |c: &Caller, fields: &'static [&'static str]| {
        let (pool, cache, c, victim) = (pool.clone(), &cache, c.clone(), victim.clone());
        async move {
            field_perms::require_fields(&pool, cache, &c, &victim, "user", fields).await
        }
    };

    // ── member tier cannot write owner_grade — 403 field_forbidden ─────
    let err = gate(&member, &["role"]).await.unwrap_err();
    assert_eq!(err.status, StatusCode::FORBIDDEN, "field gate is the one 403");
    assert_eq!(err.kind, "field_forbidden");
    assert!(err.message.contains("user.role"), "names the blocked field: {}", err.message);
    // standard is member-read-only too
    assert!(gate(&member, &["email"]).await.is_err(), "standard: member reads, not writes");

    // ── owner writes owner_grade + standard; nobody writes readonly ────
    assert!(gate(&owner, &["role", "status", "email", "display_name"]).await.is_ok());
    assert!(gate(&owner, &["username"]).await.is_err(), "readonly blocks even the owner");
    let admin = Caller { rid: owner.rid.clone(), is_platform_admin: true };
    assert!(gate(&admin, &["username"]).await.is_ok(), "platform admin bypasses");

    // ── an override row flips a cell: email becomes member-writable ────
    sqlx::query(
        "INSERT INTO field_permissions (type_id, field, role, can_read, can_write)
         VALUES ('user','email','member',true,true)
         ON CONFLICT (type_id, field, role)
         DO UPDATE SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert!(gate(&member, &["email"]).await.is_ok(), "override grants member write");
    assert!(gate(&member, &["role"]).await.is_err(), "other fields stay derived");

    // ── GET /api/types: the wire shape ──────────────────────────────────
    let payload = types::payload(&pool).await.expect("types payload");
    let types_arr = payload["types"].as_array().expect("types array");
    assert!(!types_arr.is_empty());
    let user_t = types_arr.iter().find(|t| t["type_id"] == "user").expect("user type");
    assert_eq!(user_t["rid_prefix"], "USR");
    assert_eq!(user_t["display_name_plural"], "Users");
    let fields = user_t["fields"].as_array().expect("fields");
    let keys: Vec<&str> = fields.iter().map(|f| f["key"].as_str().unwrap()).collect();
    assert_eq!(
        keys,
        ["display_name", "username", "email", "role", "status"],
        "ordinal order is the wire order"
    );
    let role_f = fields.iter().find(|f| f["key"] == "role").unwrap();
    assert_eq!(role_f["perm_class"], "owner_grade");
    assert_eq!(role_f["label"], "Role");
    assert_eq!(role_f["cells"]["owner"], "rw");
    assert_eq!(role_f["cells"]["admin"], "r");
    assert_eq!(role_f["cells"]["member"], "r");
    assert_eq!(role_f["options"][0], "user");
    let email_f = fields.iter().find(|f| f["key"] == "email").unwrap();
    assert_eq!(email_f["cells"]["member"], "rw", "override overlays the derived cell");
    assert_eq!(email_f["cells"]["viewer"], "r", "other cells stay derived");
    let username_f = fields.iter().find(|f| f["key"] == "username").unwrap();
    assert_eq!(username_f["cells"]["owner"], "r", "readonly derives RRRR");

    // ── teardown: drop the override + the seeded entities ───────────────
    sqlx::query(
        "DELETE FROM field_permissions WHERE type_id='user' AND field='email' AND role='member'",
    )
    .execute(&pool)
    .await
    .unwrap();
    for rid in [&victim, &owner.rid, &member.rid] {
        let _ = db::delete_entity(&pool, rid).await;
    }
}

/// READ side of the matrix — what builtin list/view masking derives from.
/// Uses the TEAM catalog so it can't race field_gate_and_types_contract's
/// user-type overrides (tests in one binary run concurrently).
#[tokio::test]
async fn read_matrix_drives_masking() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("field_perms: DATABASE_URL unset — skipped");
        return;
    };
    let pool = PgPool::connect(&url).await.expect("connect");
    sqlx::migrate!("../../migrations").run(&pool).await.expect("migrate");

    let clear = || async {
        sqlx::query(
            "DELETE FROM field_permissions WHERE type_id='team' AND field='kind' AND role='viewer'",
        )
        .execute(&pool)
        .await
        .unwrap();
    };
    clear().await; // a prior panicked run must not poison this one

    // Seeded catalogs hide nothing → masking takes the fast path.
    let m = field_perms::matrix(&pool, "team").await.unwrap();
    assert!(m.fully_readable(), "seeds are fully readable");

    // A hiding override (can_read=false) flips the slow path on, for exactly
    // that tier and exactly that field.
    sqlx::query(
        "INSERT INTO field_permissions (type_id, field, role, can_read, can_write)
         VALUES ('team','kind','viewer',false,false)",
    )
    .execute(&pool)
    .await
    .unwrap();
    let m = field_perms::matrix(&pool, "team").await.unwrap();
    assert!(!m.fully_readable(), "a hiding override is visible to the fast path");
    let viewer = field_perms::tier_index("viewer").unwrap();
    let member = field_perms::tier_index("member").unwrap();
    assert_eq!(m.unreadable(viewer), vec!["kind"], "the hidden field, only");
    assert!(m.unreadable(member).is_empty(), "other tiers keep their derived read");
    assert_eq!(m.cell("kind", viewer), field_perms::Perm::None);
    assert_eq!(m.cell("kind", member), field_perms::Perm::Read);

    clear().await;
}
