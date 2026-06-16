//! Phase 4 exit gate: the sealed upload pipeline end-to-end against the live DB.
//!
//! Proves: pipeline::upload_csv applies RBAC (non-member denied leak-free,
//! member allowed), registers the file as an ENTITY (day-one #2), stores bytes
//! + a project_files row + score, and that the step-replay path (applied_steps
//! + data::steps::replay) reconstructs the cleaned frame. Every caller is a
//! real seeded non-admin user (the dev_user fake-green trap).
//!
//! Needs DATABASE_URL; skips cleanly when unset. Uses a temp data dir; tears
//! down through the entity registry (one delete path).

use api::{db, id, pipeline, type_cache::TypeDefCache};
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

async fn seed_project(pool: &PgPool, owner: &str) -> String {
    let rid = id::new("PRJ");
    let mut tx = pool.begin().await.unwrap();
    db::register_entity(&mut tx, &rid, "project").await.unwrap();
    sqlx::query("INSERT INTO projects (redpash_id, name) VALUES ($1, 'P')")
        .bind(&rid)
        .execute(&mut *tx)
        .await
        .unwrap();
    db::grant_owner(&mut tx, &rid, owner).await.unwrap();
    tx.commit().await.unwrap();
    rid
}

#[tokio::test]
async fn upload_pipeline_end_to_end() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("upload_flow: DATABASE_URL unset — skipped");
        return;
    };
    let pool = PgPool::connect(&url).await.expect("connect");
    sqlx::migrate!("../../migrations").run(&pool).await.expect("migrate");
    let cache = TypeDefCache::load(&pool).await.expect("cache");

    let tmp = std::env::temp_dir().join(format!("rpnext-test-{}", &id::new("X")[2..10]));
    std::fs::create_dir_all(tmp.join("files")).unwrap();

    let owner = seed_user(&pool, "owner").await;
    let stranger = seed_user(&pool, "stranger").await;
    let project = seed_project(&pool, &owner).await;

    let csv = b"id,name,amount\n1,Alice,10\n2,Bob,20\n2,Bob,20\n".to_vec();

    // ── RBAC: a non-member is denied, leak-free (404). ──
    let denied = pipeline::upload_csv(
        &pool, &cache, &tmp, &stranger, false, &project, "f.csv", csv.clone(), None,
    )
    .await;
    assert!(denied.is_err(), "stranger must be denied write-reach");
    assert_eq!(denied.err().unwrap().status, axum::http::StatusCode::NOT_FOUND);

    // ── owner (>= Member via the auto-granted owner edge) succeeds. ──
    let outcome = pipeline::upload_csv(
        &pool, &cache, &tmp, &owner, false, &project, "myfile.csv", csv.clone(), None,
    )
    .await
    .expect("owner upload");
    assert_eq!(outcome.filename, "myfile"); // ext stripped
    assert!(outcome.frame.height() >= 2);
    assert!(outcome.cleanness.is_some());

    // ── the file is a registered ENTITY (day-one #2) and a project_files row. ──
    let etype: Option<String> =
        sqlx::query_scalar("SELECT type FROM entities WHERE id = $1").bind(&outcome.rid).fetch_optional(&pool).await.unwrap();
    assert_eq!(etype.as_deref(), Some("file"));
    let meta = db::find_file(&pool, &outcome.rid).await.unwrap().expect("file row");
    assert_eq!(meta.project_id, project);
    assert!(std::path::Path::new(&tmp.join(&meta.storage_path)).exists(), "blob on disk");

    // ── RBAC on the file itself: owner can View (cascade from project),
    //    stranger cannot — and the deny is leak-free. ──
    let owner_caller = api::rbac::Caller { rid: owner.clone(), is_platform_admin: false };
    let stranger_caller = api::rbac::Caller { rid: stranger.clone(), is_platform_admin: false };
    assert!(rbac_view(&pool, &cache, &owner_caller, &outcome.rid).await);
    assert!(!rbac_view(&pool, &cache, &stranger_caller, &outcome.rid).await);

    // ── upload writes a genesis step (ordinal 0, "original") carrying the
    //    baseline cleanness — the score trajectory starts there. ──
    let genesis = db::applied_steps(&pool, &outcome.rid).await.unwrap();
    assert_eq!(genesis.len(), 1, "fresh file has only the genesis step");
    assert_eq!(genesis[0].kind, "original");

    // ── the genesis must NOT flip file_stages to 'clean' — an untouched file is 'new'. ──
    let stage_new: String = sqlx::query_scalar("SELECT stage FROM file_stages WHERE file_id = $1")
        .bind(&outcome.rid).fetch_one(&pool).await.unwrap();
    assert_eq!(stage_new, "new", "fresh file is 'new', not 'clean' (genesis excluded from the clean test)");

    // ── step replay: a change_case step replays over the genesis (identity). ──
    db::add_step(&pool, &outcome.rid, "change_case", &serde_json::json!({"mode":"lower"}), None).await.unwrap();
    let steps = db::applied_steps(&pool, &outcome.rid).await.unwrap();
    assert_eq!(steps.len(), 2, "genesis + the change_case step");
    assert_eq!(steps[0].kind, "original");
    assert_eq!(steps[1].kind, "change_case");
    // ── a REAL cleaning step flips file_stages to 'clean'. ──
    let stage_clean: String = sqlx::query_scalar("SELECT stage FROM file_stages WHERE file_id = $1")
        .bind(&outcome.rid).fetch_one(&pool).await.unwrap();
    assert_eq!(stage_clean, "clean", "a real cleaning step makes it 'clean'");
    // polars lazy collect derefs the fork's async runtime, which panics if
    // called from within a tokio runtime — so engine work goes through
    // spawn_blocking, exactly as the handlers do.
    let csv2 = csv.clone();
    let names: Vec<Option<String>> = tokio::task::spawn_blocking(move || {
        let base = data::parse::from_csv_bytes(&csv2, None).unwrap().0;
        let replayed = data::steps::replay(base, &steps).unwrap();
        replayed.column("name").unwrap().str().unwrap().iter().map(|o| o.map(str::to_string)).collect()
    })
    .await
    .unwrap();
    assert!(names.iter().any(|n| n.as_deref() == Some("alice")), "change_case lowered names: {names:?}");

    // ── undo un-applies the change_case, but the genesis (ordinal 0) is pinned. ──
    assert!(db::undo_step(&pool, &outcome.rid).await.unwrap());
    let after = db::applied_steps(&pool, &outcome.rid).await.unwrap();
    assert_eq!(after.len(), 1, "genesis survives undo");
    assert_eq!(after[0].kind, "original");
    // a further undo is a no-op — the genesis can't be undone.
    assert!(!db::undo_step(&pool, &outcome.rid).await.unwrap(), "genesis is not undoable");

    // ── teardown via the registry (cascade clears project_files, steps,
    //    memberships, entities). ──
    for rid in [&outcome.rid, &project, &owner, &stranger] {
        db::delete_entity(&pool, rid).await.unwrap();
    }
    let _ = std::fs::remove_dir_all(&tmp);
}

/// Batch commit (the cleaner's Save): db::add_steps lands N steps as ONE gesture —
/// sequential ordinals after the genesis, one redo-stack drop — and add_step still
/// works as a one-element batch.
#[tokio::test]
async fn batch_commit_lands_all_steps_in_one_gesture() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("upload_flow(batch): DATABASE_URL unset — skipped");
        return;
    };
    let pool = PgPool::connect(&url).await.expect("connect");
    sqlx::migrate!("../../migrations").run(&pool).await.expect("migrate");
    let cache = TypeDefCache::load(&pool).await.expect("cache");
    let tmp = std::env::temp_dir().join(format!("rpnext-test-{}", &id::new("X")[2..10]));
    std::fs::create_dir_all(tmp.join("files")).unwrap();
    let owner = seed_user(&pool, "owner").await;
    let project = seed_project(&pool, &owner).await;
    let csv = b"id,name\n1,Alice\n2,Bob\n".to_vec();
    let outcome = pipeline::upload_csv(&pool, &cache, &tmp, &owner, false, &project, "b.csv", csv, None)
        .await
        .expect("upload");

    // batch commits N steps in one gesture, sequential ordinals after the genesis.
    let ids = db::add_steps(
        &pool,
        &outcome.rid,
        &[
            ("snake_case_columns".to_string(), serde_json::json!({}), Some(99.0_f32)),
            ("change_case".to_string(), serde_json::json!({"mode":"lower"}), Some(98.5_f32)),
        ],
    )
    .await
    .unwrap();
    assert_eq!(ids.len(), 2, "one id per committed step");
    let steps = db::applied_steps(&pool, &outcome.rid).await.unwrap();
    assert_eq!(steps.len(), 3, "genesis + 2 batched steps");
    assert_eq!(steps[1].kind, "snake_case_columns");
    assert_eq!(steps[2].kind, "change_case");

    // the batch drops the redo stack ONCE: undo a step, then a new batch clears it.
    assert!(db::undo_step(&pool, &outcome.rid).await.unwrap()); // change_case -> redo stack
    db::add_steps(&pool, &outcome.rid, &[("drop_nulls".to_string(), serde_json::json!({}), Some(97.0_f32))])
        .await
        .unwrap();
    let after = db::applied_steps(&pool, &outcome.rid).await.unwrap();
    assert!(after.iter().all(|s| s.kind != "change_case"), "redo stack dropped on batch commit");
    assert_eq!(after.last().unwrap().kind, "drop_nulls");

    // add_step still works (delegates to add_steps).
    db::add_step(&pool, &outcome.rid, "drop_nulls", &serde_json::json!({}), None).await.unwrap();
    assert_eq!(db::applied_steps(&pool, &outcome.rid).await.unwrap().last().unwrap().kind, "drop_nulls");

    for rid in [&outcome.rid, &project, &owner] {
        let _ = db::delete_entity(&pool, rid).await;
    }
    let _ = std::fs::remove_dir_all(&tmp);
}

/// The data-work engine over the in-process functions the HTTP handlers call:
/// SQL (read-only), joins (overlap-coefficient + execute), group_by aggregation.
/// Engine calls go through spawn_blocking (the fork's async runtime panics in a
/// tokio context). Pure-compute verification — no DB needed.
#[tokio::test]
async fn data_work_engine_paths() {
    let employees = tokio::task::spawn_blocking(|| {
        data::parse::from_text("dept_id,name\nD1,Alice\nD2,Bob\nD1,Carol\n").unwrap()
    })
    .await
    .unwrap();
    let depts = tokio::task::spawn_blocking(|| {
        data::parse::from_text("id,label\nD1,Eng\nD2,Sales\nD3,Ops\n").unwrap()
    })
    .await
    .unwrap();

    // SQL: read-only SELECT over the workspace file as `t`.
    let t = employees.clone();
    let sql_out = tokio::task::spawn_blocking(move || {
        data::sql::run_sql(vec![("t".into(), t)], "SELECT name FROM t WHERE dept_id = 'D1'")
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(sql_out.height(), 2);
    // read-only guard rejects a mutation.
    assert!(!data::sql::is_read_only("DELETE FROM t"));

    // Joins: detect FK→PK, then execute.
    let (e, d) = (employees.clone(), depts.clone());
    let cands = tokio::task::spawn_blocking(move || data::joins::detect_pair(&e, &d, 0.3, 20))
        .await
        .unwrap()
        .unwrap();
    let top = cands.first().expect("a join candidate");
    assert_eq!((top.this_col.as_str(), top.other_col.as_str()), ("dept_id", "id"));
    let (e2, d2) = (employees.clone(), depts.clone());
    let joined = tokio::task::spawn_blocking(move || {
        data::joins::execute(&e2, &d2, &["dept_id".into()], &["id".into()], "inner")
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(joined.height(), 3); // every employee's dept resolves
    assert!(joined.get_column_names().iter().any(|n| n.as_str() == "label"));

    // group_by: count employees per dept.
    let spec = shared::report::ReportSpec {
        group_by: vec!["dept_id".into()],
        aggregations: vec![shared::report::Aggregation {
            col: "*".into(),
            fn_: shared::report::AggFn::Count,
            alias: Some("n".into()),
        }],
        ..Default::default()
    };
    let g = tokio::task::spawn_blocking(move || data::group_by::execute(&employees, &spec))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(g.height(), 2); // D1, D2
}

/// User deletion = SCRUB-RETAIN: blocked while the user is sole owner of any
/// object (transfer first), then anonymize + retain (no hard delete, no orphans).
#[tokio::test]
async fn user_scrub_blocks_sole_owner_then_retains() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("scrub: DATABASE_URL unset — skipped");
        return;
    };
    let pool = PgPool::connect(&url).await.expect("connect");
    sqlx::migrate!("../../migrations").run(&pool).await.expect("migrate");
    let cache = TypeDefCache::load(&pool).await.expect("cache");
    let tmp = std::env::temp_dir().join(format!("rpnext-test-{}", &id::new("X")[2..10]));
    std::fs::create_dir_all(tmp.join("files")).unwrap();
    let owner = seed_user(&pool, "scrub-owner").await;
    let other = seed_user(&pool, "scrub-co").await;
    let project = seed_project(&pool, &owner).await;
    let csv = b"id,name\n1,A\n".to_vec();
    let file = pipeline::upload_csv(&pool, &cache, &tmp, &owner, false, &project, "f.csv", csv, None)
        .await
        .expect("upload")
        .rid;

    // owner solely owns the project → scrub is blocked. (Files have NO per-file
    // owner edge — access flows through the project — so the project covers its
    // files; user_sole_owner_objects tracks the project, not the file.)
    let blocking = db::user_sole_owner_objects(&pool, &owner).await.unwrap();
    assert!(blocking.contains(&project), "sole owner of the project blocks");

    // transfer: co-own the project → owner is no longer sole owner.
    let mut tx = pool.begin().await.unwrap();
    db::grant_owner(&mut tx, &project, &other).await.unwrap();
    tx.commit().await.unwrap();
    assert!(db::user_sole_owner_objects(&pool, &owner).await.unwrap().is_empty(), "co-owned → not sole");

    // scrub: anonymize + RETAIN the row.
    assert!(db::scrub_user_tx(&pool, &owner).await.unwrap());
    let (dn, status, email): (String, String, Option<String>) =
        sqlx::query_as("SELECT display_name, status, email FROM users WHERE redpash_id = $1")
            .bind(&owner).fetch_one(&pool).await.unwrap();
    assert_eq!(dn, "Deleted User");
    assert_eq!(status, "archived");
    assert!(email.is_none(), "PII nulled");

    // objects survive (NOT hard-deleted) and stay owned by the co-owner.
    let file_alive: Option<i32> =
        sqlx::query_scalar("SELECT 1 FROM project_files WHERE redpash_id = $1")
            .bind(&file).fetch_optional(&pool).await.unwrap();
    assert!(file_alive.is_some(), "file retained after owner scrub");
    // The PROJECT keeps a live owner (the co-owner) — so its files aren't orphaned.
    // The scrubbed user's project owner edge is retained by design (only team
    // memberships are dropped); harmless, since they're archived + can't authenticate.
    let proj_owners: Vec<String> = sqlx::query_scalar(
        "SELECT member_redpash_id FROM memberships WHERE object_redpash_id = $1 AND role = 'owner'",
    ).bind(&project).fetch_all(&pool).await.unwrap();
    assert!(proj_owners.contains(&other), "project keeps a live owner — its files are not orphaned");

    for rid in [&file, &project, &owner, &other] {
        let _ = db::delete_entity(&pool, rid).await;
    }
    let _ = std::fs::remove_dir_all(&tmp);
}

/// The default project must NOT block scrub (every real user solely owns their
/// auto-created default project) and is DISPOSED with the user.
#[tokio::test]
async fn user_scrub_disposes_personal_default_project() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("scrub-dp: DATABASE_URL unset — skipped");
        return;
    };
    let pool = PgPool::connect(&url).await.expect("connect");
    sqlx::migrate!("../../migrations").run(&pool).await.expect("migrate");
    let owner = seed_user(&pool, "scrub-dp").await;
    let dp = db::ensure_default_project(&pool, &owner).await.unwrap();

    // sole owner of ONLY the default project → NOT blocked (it's excluded).
    assert!(
        db::user_sole_owner_objects(&pool, &owner).await.unwrap().is_empty(),
        "the personal default project must not block scrub",
    );
    assert!(db::scrub_user_tx(&pool, &owner).await.unwrap());

    // default project disposed; user retained + archived; FK self-cleared.
    let dp_alive: Option<i32> =
        sqlx::query_scalar("SELECT 1 FROM projects WHERE redpash_id = $1").bind(&dp).fetch_optional(&pool).await.unwrap();
    assert!(dp_alive.is_none(), "default project disposed on scrub");
    let (dn, dpid): (String, Option<String>) =
        sqlx::query_as("SELECT display_name, default_project_id FROM users WHERE redpash_id = $1")
            .bind(&owner).fetch_one(&pool).await.unwrap();
    assert_eq!(dn, "Deleted User");
    assert!(dpid.is_none(), "default_project_id self-cleared via ON DELETE SET NULL");

    // re-scrub is a no-op (idempotent).
    assert!(!db::scrub_user_tx(&pool, &owner).await.unwrap(), "re-scrub is a no-op");

    let _ = db::delete_entity(&pool, &owner).await;
}

async fn rbac_view(pool: &PgPool, cache: &TypeDefCache, caller: &api::rbac::Caller, rid: &str) -> bool {
    api::rbac::require_action(pool, cache, caller, rid, api::rbac::Action::View).await.is_ok()
}
