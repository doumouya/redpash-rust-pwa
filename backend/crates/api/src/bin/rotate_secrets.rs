//! `redpash-rotate-secrets` — re-encrypt every connector secret under the
//! CURRENT `REDPASH_MASTER_KEY` (privacy F-F key rotation).
//!
//! Run during a maintenance window AFTER swapping the master key:
//!   1. set the OLD key as `REDPASH_MASTER_KEY_PREV` and the NEW key as
//!      `REDPASH_MASTER_KEY` (so existing ciphertext still decrypts), then
//!   2. `cargo run -p api --bin redpash-rotate-secrets`, then
//!   3. drop `REDPASH_MASTER_KEY_PREV`.
//!
//! Field-agnostic: walks each connector's `config` JSONB and re-keys every
//! `v1:` envelope wherever it sits (no per-connector secret-field list). A
//! maintenance op, not a runtime route — so it can't time out an HTTP request
//! and isn't exposed to callers.

use eyre::{Result, WrapErr};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;

use api::crypto;

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

    let rows: Vec<(String, Value)> = sqlx::query_as("SELECT redpash_id, config FROM connectors")
        .fetch_all(&pool)
        .await
        .wrap_err("read connectors")?;

    let total = rows.len();
    let mut rotated = 0usize;
    for (rid, mut config) in rows {
        match crypto::rotate_value_in_place(&mut config) {
            Ok(true) => {
                sqlx::query("UPDATE connectors SET config = $1 WHERE redpash_id = $2")
                    .bind(&config)
                    .bind(&rid)
                    .execute(&pool)
                    .await
                    .wrap_err_with(|| format!("update connector {rid}"))?;
                rotated += 1;
                println!("rotated {rid}");
            }
            Ok(false) => {}
            // Don't abort the run on one bad row (e.g. a secret written under a
            // key we no longer hold) — surface it and keep going.
            Err(e) => eprintln!("WARN  skip {rid}: {e}"),
        }
    }
    println!("rotate-secrets: re-keyed {rotated}/{total} connector(s) under the current REDPASH_MASTER_KEY");
    Ok(())
}
