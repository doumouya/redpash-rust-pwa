//! Project creation — `db::create_project` (the path behind POST /api/projects)
//! + its RBAC reach, and the `ensure_default_project` refactor that now shares
//! the same insert spine.
//!
//! Proves: a new project registers as a `project` entity, the creator is
//! auto-granted owner and therefore reaches it (View/Edit/Delete via the
//! project→company cascade), a stranger reaches NEITHER (leak-free 404 at the
//! gate — never 403), and `ensure_default_project` stayed idempotent + atomic
//! (one default per user, set on the user row in the same tx). Needs
//! DATABASE_URL; skips when unset.

use api::{
    db, id,
    rbac::{self, Action, Caller},
    type_cache::TypeDefCache,
};
use sqlx::PgPool;

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

#[tokio::test]
async fn create_project_owner_reaches_stranger_denied() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("projects_create: DATABASE_URL unset — skipped");
        return;
    };
    let pool = PgPool::connect(&url).await.expect("connect");
    sqlx::migrate!("../../migrations").run(&pool).await.expect("migrate");
    let cache = TypeDefCache::load(&pool).await.expect("cache");

    let alice = Caller { rid: seed_user(&pool, "pc-alice").await, is_platform_admin: false };
    let stranger = Caller { rid: seed_user(&pool, "pc-stranger").await, is_platform_admin: false };

    // ── create: a PRJ_ rid, the projects row, the entity row, the owner edge. ──
    let (pid, created_at) = db::create_project(&pool, &alice.rid, "Quarterly").await.expect("create");
    assert!(pid.starts_with("PRJ"), "project rid prefix");
    // created_at is the DB DEFAULT now() (so the POST 201 body matches the list shape).
    assert!(created_at <= chrono::Utc::now(), "created_at returned from the insert");

    let name: String = sqlx::query_scalar("SELECT name FROM projects WHERE redpash_id = $1")
        .bind(&pid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(name, "Quarterly", "name persisted");

    let entity_type: String = sqlx::query_scalar("SELECT type FROM entities WHERE id = $1")
        .bind(&pid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(entity_type, "project", "registered as a project entity (FK + cascade spine)");

    let owner_role: String = sqlx::query_scalar(
        "SELECT role FROM memberships WHERE object_redpash_id = $1 AND member_redpash_id = $2",
    )
    .bind(&pid)
    .bind(&alice.rid)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(owner_role, "owner", "creator auto-granted owner");

    // ── reach: owner reaches View/Edit/Delete; a stranger reaches none. ──
    assert!(rbac::require_action(&pool, &cache, &alice, &pid, Action::View).await.is_ok());
    assert!(rbac::require_action(&pool, &cache, &alice, &pid, Action::Edit).await.is_ok());
    assert!(rbac::require_action(&pool, &cache, &alice, &pid, Action::Delete).await.is_ok());

    let denied = rbac::require_action(&pool, &cache, &stranger, &pid, Action::View).await;
    assert_eq!(
        denied.err().map(|e| e.status),
        Some(axum::http::StatusCode::NOT_FOUND),
        "stranger denied leak-free (404, never 403)"
    );

    for rid in [&pid, &alice.rid, &stranger.rid] {
        let _ = db::delete_entity(&pool, rid).await;
    }
}

#[tokio::test]
async fn ensure_default_project_stays_idempotent_and_atomic() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("projects_create(default): DATABASE_URL unset — skipped");
        return;
    };
    let pool = PgPool::connect(&url).await.expect("connect");
    sqlx::migrate!("../../migrations").run(&pool).await.expect("migrate");

    let user = seed_user(&pool, "pc-default").await;

    // The refactor routes through the shared `insert_project` helper; the second
    // call must return the SAME project (idempotent), and the default must be set
    // on the user row (create + set-default in one tx).
    let first = db::ensure_default_project(&pool, &user).await.expect("first");
    let second = db::ensure_default_project(&pool, &user).await.expect("second");
    assert_eq!(first, second, "default project is stable across calls");

    let dft: Option<String> =
        sqlx::query_scalar("SELECT default_project_id FROM users WHERE redpash_id = $1")
            .bind(&user)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(dft.as_deref(), Some(first.as_str()), "default set on the user row");

    // teardown: drop the user first (clears the default_project_id reference),
    // then the now-unreferenced project.
    for rid in [&user, &first] {
        let _ = db::delete_entity(&pool, rid).await;
    }
}
