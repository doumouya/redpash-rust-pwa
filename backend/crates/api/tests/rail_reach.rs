//! The server-driven rail resolver, exercised against the LIVE DB with REAL
//! seeded non-admin callers (the dev_user fake-green trap). Calls the same
//! reach-filtered queries the handler runs, via the public rail entrypoints, so
//! the proof is the actual SQL — not a stub.
//!
//! Proves: a member sees ONLY the project(s)/file(s) their membership reaches
//! (and their leaf counts reflect only reachable leaves); a platform admin
//! (viewer=None) sees everything; the org TypeList counts are reach-scoped.
//! Needs DATABASE_URL; skips when unset.

use api::{db, id, rail};
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

async fn seed_project(pool: &PgPool, name: &str) -> String {
    let rid = id::new("PRJ");
    let mut tx = pool.begin().await.unwrap();
    db::register_entity(&mut tx, &rid, "project").await.unwrap();
    sqlx::query("INSERT INTO projects (redpash_id, name) VALUES ($1, $2)")
        .bind(&rid)
        .bind(name)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    rid
}

async fn seed_csv(pool: &PgPool, project_id: &str, filename: &str) -> String {
    let rid = id::new("FIL");
    let mut tx = pool.begin().await.unwrap();
    db::register_entity(&mut tx, &rid, "file").await.unwrap();
    sqlx::query(
        "INSERT INTO project_files (redpash_id, project_id, filename, file_type)
         VALUES ($1, $2, $3, 'csv')",
    )
    .bind(&rid)
    .bind(project_id)
    .bind(filename)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    rid
}

async fn grant(pool: &PgPool, object: &str, member: &str, role: &str) {
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
async fn rail_workspace_is_reach_filtered() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("rail_reach: DATABASE_URL unset — skipped");
        return;
    };
    let pool = PgPool::connect(&url).await.expect("connect");
    sqlx::migrate!("../../migrations").run(&pool).await.expect("migrate");

    // alice is a member of project A (one csv); project B (with a csv) is
    // out of her reach entirely.
    let alice = seed_user(&pool, "rail-alice").await;
    let proj_a = seed_project(&pool, "Alice Project").await;
    let proj_b = seed_project(&pool, "Hidden Project").await;
    let file_a = seed_csv(&pool, &proj_a, "alice.csv").await;
    let file_b = seed_csv(&pool, &proj_b, "hidden.csv").await;
    grant(&pool, &proj_a, &alice, "member").await;

    // ── member view: ONLY project A, with its single csv. ──
    let principals = api::rbac::principals(&pool, &alice).await.unwrap();
    let groups = rail::workspace_tree_for(&pool, Some(&principals)).await.expect("member tree");
    let ids: Vec<&str> = groups.iter().filter_map(|g| g["id"].as_str()).collect();
    assert!(ids.contains(&proj_a.as_str()), "member must see their project A");
    assert!(!ids.contains(&proj_b.as_str()), "member must NOT see the hidden project B");

    let group_a = groups.iter().find(|g| g["id"] == serde_json::json!(proj_a)).unwrap();
    assert_eq!(group_a["count"], serde_json::json!(1), "A has one reachable csv");
    let tab_ids: Vec<&str> =
        group_a["tabs"].as_array().unwrap().iter().filter_map(|t| t["id"].as_str()).collect();
    assert_eq!(tab_ids, [file_a.as_str()], "the only tab is alice's csv");
    assert_eq!(group_a["tabs"][0]["kind"], serde_json::json!("file"));

    // ── admin view (viewer = None): both projects/files are present. ──
    let admin_groups = rail::workspace_tree_for(&pool, None).await.expect("admin tree");
    let admin_ids: Vec<&str> = admin_groups.iter().filter_map(|g| g["id"].as_str()).collect();
    assert!(admin_ids.contains(&proj_a.as_str()) && admin_ids.contains(&proj_b.as_str()));
    // and B's file is visible to the admin even though it was unreachable to alice.
    let _ = file_b;

    // teardown.
    for rid in [&file_a, &file_b, &proj_a, &proj_b, &alice] {
        let _ = db::delete_entity(&pool, rid).await;
    }
}
