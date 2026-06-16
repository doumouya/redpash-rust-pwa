//! `redpash-retention` — the zero-risk retention pass (privacy F-C, partial):
//!   1. GC expired sessions (`sessions` is NOT partitioned, so a DELETE is the
//!      right tool — the "DROP PARTITION, never DELETE" rule is for the
//!      observability tables only).
//!   2. Reap ORPHAN blobs: a `<data_dir>/{files,attachments}/<rid>.bin` whose
//!      registry row is gone (e.g. a deep company/team -> project -> file
//!      teardown that delete_entity_and_blobs' direct sweep didn't reach, or a
//!      pre-existing orphan). This closes F-A's deeper-cascade follow-up.
//!
//! NOT done here (deferred decision): monthly partition rotation for
//! events/request_log/db_query_log — the tables ship with a single DEFAULT
//! partition, so real DROP-PARTITION retention needs a partitioning migration
//! first. See docs/privacy/assessment-2026-06-16.md (F-C).
//!
//! Run from a maintenance schedule (cron/systemd timer):
//!     cargo run -p api --bin redpash-retention

use eyre::{Result, WrapErr};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// In-flight grace: the upload pipeline writes the blob just before its registry
/// row commits, so never reap a blob touched within the last hour.
const GRACE: Duration = Duration::from_secs(3600);

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();
    let _ = dotenvy::from_filename("backend/.env");

    let db_url = std::env::var("DATABASE_URL").wrap_err("DATABASE_URL not set")?;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&db_url)
        .await
        .wrap_err("connect Postgres")?;
    let data_dir: PathBuf = std::env::var("REDPASH_DATA_DIR")
        .unwrap_or_else(|_| "./data".into())
        .into();

    let sessions = sqlx::query("DELETE FROM sessions WHERE expires_at < now()")
        .execute(&pool)
        .await
        .wrap_err("gc sessions")?
        .rows_affected();
    println!("retention: deleted {sessions} expired session(s)");

    let files = reap_dir(&pool, &data_dir.join("files"), "project_files").await?;
    let atts = reap_dir(&pool, &data_dir.join("attachments"), "case_attachments").await?;
    println!("retention: reaped {files} orphan file blob(s), {atts} orphan attachment blob(s)");
    Ok(())
}

/// Remove every `<rid>.bin` in `dir` whose `redpash_id` has no row in `table`,
/// skipping files written within the grace window. `table` is a fixed literal
/// (no injection surface).
async fn reap_dir(pool: &PgPool, dir: &Path, table: &str) -> Result<usize> {
    let mut rd = match tokio::fs::read_dir(dir).await {
        Ok(r) => r,
        Err(_) => return Ok(0), // dir absent on a fresh deploy — nothing to reap
    };
    let mut removed = 0usize;
    while let Some(ent) = rd.next_entry().await? {
        let path = ent.path();
        let Some(rid) = path.file_name().and_then(|s| s.to_str()).and_then(|n| n.strip_suffix(".bin"))
        else {
            continue;
        };
        if let Ok(modified) = ent.metadata().await.and_then(|m| m.modified()) {
            let recent = SystemTime::now().duration_since(modified).map(|age| age < GRACE).unwrap_or(true);
            if recent {
                continue;
            }
        }
        let exists: Option<i32> = sqlx::query_scalar(&format!("SELECT 1 FROM {table} WHERE redpash_id = $1"))
            .bind(rid)
            .fetch_optional(pool)
            .await?;
        if exists.is_none() {
            let _ = tokio::fs::remove_file(&path).await;
            removed += 1;
            println!("reaped orphan {}", path.display());
        }
    }
    Ok(removed)
}
