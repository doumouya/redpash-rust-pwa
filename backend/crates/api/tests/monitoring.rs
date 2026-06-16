//! Monitoring audit-trail backend: the `audit` migration applies, `audit.run_diff`
//! classifies findings (new/fixed/regressed/improved/unchanged), and the queries
//! the `/api/monitoring` handlers run (runs list+filter, findings-by-run, the
//! scoped by_severity/by_kind stats group-bys) return the right shapes against
//! real Postgres. Scoped to a unique test tool + asserted by run id, so it's
//! robust on a shared DB that may already hold audit rows. Needs DATABASE_URL.

use sqlx::PgPool;

const TOOL: &str = "torv-test-mon";

async fn insert_run(pool: &PgPool, tool: &str, branch: &str, ago_secs: i32) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO audit.run (tool, git_branch, ran_at, stats, payload)
         VALUES ($1, $2, now() - (($3::text) || ' seconds')::interval, '{}'::jsonb, '[]'::jsonb)
         RETURNING id",
    )
    .bind(tool)
    .bind(branch)
    .bind(ago_secs)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn insert_finding(pool: &PgPool, run_id: i64, kind: &str, key: &str, sev: Option<i32>) {
    sqlx::query(
        "INSERT INTO audit.finding (run_id, tool, kind, finding_key, severity, detail)
         VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)",
    )
    .bind(run_id)
    .bind(TOOL)
    .bind(kind)
    .bind(key)
    .bind(sev)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn run_diff_classifies_and_handler_queries_hold() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("monitoring: DATABASE_URL unset — skipped");
        return;
    };
    let pool = PgPool::connect(&url).await.expect("connect");
    sqlx::migrate!("../../migrations").run(&pool).await.expect("migrate");

    // Leading cleanup: if a prior run panicked mid-test, its rows leaked (the
    // teardown only runs on the happy path) and would break the tool-scoped count
    // assert forever on this shared DB. Clear our test tools first (cascade clears
    // findings). NULL git_sha + advancing ran_at mean re-runs never collide.
    let _ = sqlx::query("DELETE FROM audit.run WHERE tool LIKE 'torv-test-mon%'")
        .execute(&pool)
        .await;

    // Two runs for our tool (older r1, newer r2) + a second tool, so the tool
    // filter has signal. Distinct ran_at fixes "latest run" ordering.
    let r1 = insert_run(&pool, TOOL, "main", 120).await;
    let r2 = insert_run(&pool, TOOL, "main", 0).await;
    let other = insert_run(&pool, "torv-test-mon2", "main", 0).await;

    // r1 → r2 cover every run_diff branch:
    //   unchanged (same key+sev), fixed (gone in r2), regressed (sev↑), improved
    //   (sev↓), new (only in r2), and a NULL-severity finding present in both.
    insert_finding(&pool, r1, "k", "unchanged", Some(1)).await;
    insert_finding(&pool, r1, "k", "fixed", Some(1)).await;
    insert_finding(&pool, r1, "k", "regressed", Some(1)).await;
    insert_finding(&pool, r1, "k", "improved", Some(5)).await;
    insert_finding(&pool, r1, "kn", "nullsev", None).await;

    insert_finding(&pool, r2, "k", "unchanged", Some(1)).await;
    insert_finding(&pool, r2, "k", "new", Some(2)).await;
    insert_finding(&pool, r2, "k", "regressed", Some(5)).await;
    insert_finding(&pool, r2, "k", "improved", Some(1)).await;
    insert_finding(&pool, r2, "kn", "nullsev", None).await;

    // ── run_diff(r2, r1) ──
    let diff: Vec<(String, i64)> =
        sqlx::query_as("SELECT status, COUNT(*)::bigint FROM audit.run_diff($1, $2) GROUP BY status")
            .bind(r2)
            .bind(r1)
            .fetch_all(&pool)
            .await
            .unwrap();
    let n = |s: &str| diff.iter().find(|(k, _)| k == s).map(|(_, c)| *c).unwrap_or(0);
    assert_eq!(n("new"), 1, "k|new is new");
    assert_eq!(n("fixed"), 1, "k|fixed disappeared");
    assert_eq!(n("regressed"), 1, "k|regressed severity rose");
    assert_eq!(n("improved"), 1, "k|improved severity fell");
    assert_eq!(n("unchanged"), 2, "k|unchanged + kn|nullsev");

    // ── runs list query (the handler's), filtered to our tool → r1 + r2 ──
    let run_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*)::BIGINT FROM audit.run WHERE ($1::text IS NULL OR tool = $1)")
            .bind(TOOL)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(run_count, 2);

    // ── findings list for r2 (the handler's run filter) → 5 rows ──
    let f_count: i64 = sqlx::query_scalar("SELECT COUNT(*)::BIGINT FROM audit.finding WHERE run_id = $1")
        .bind(r2)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(f_count, 5);

    // ── by_severity scoped to r2 (the stats query): all sevs ≤5 or NULL → 'low' ──
    let sev: Vec<(String, i64)> = sqlx::query_as(
        "SELECT CASE WHEN severity IS NULL OR severity <= 5 THEN 'low'
                     WHEN severity <= 15 THEN 'med' ELSE 'high' END, COUNT(*)::BIGINT
           FROM audit.finding WHERE run_id = $1 GROUP BY 1",
    )
    .bind(r2)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(sev, vec![("low".to_string(), 5)]);

    // ── by_kind scoped to r2 → {k:4, kn:1} ──
    let kinds: Vec<(String, i64)> = sqlx::query_as(
        "SELECT kind, COUNT(*)::BIGINT FROM audit.finding WHERE run_id = $1 GROUP BY kind ORDER BY kind",
    )
    .bind(r2)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(kinds, vec![("k".to_string(), 4), ("kn".to_string(), 1)]);

    // teardown (cascade clears findings).
    for id in [r1, r2, other] {
        let _ = sqlx::query("DELETE FROM audit.run WHERE id = $1").bind(id).execute(&pool).await;
    }
}
