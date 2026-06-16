//! Purpose: debug-build-only dev bootstrap. Release binaries do not contain
//! this module — there is no fallback identity in production (day-one #10);
//! the first real admin arrives via POST /api/auth/claim-admin.

#![cfg(debug_assertions)]

use sqlx::PgPool;

use crate::{db, id};

/// Ensure the 'dev' user exists as a platform admin with a default project.
/// Idempotent on every boot.
pub async fn ensure_dev_user(pool: &PgPool) -> eyre::Result<String> {
    let existing: Option<String> =
        sqlx::query_scalar("SELECT redpash_id FROM users WHERE username = 'dev'")
            .fetch_optional(pool)
            .await?;
    let rid = match existing {
        Some(rid) => rid,
        None => {
            let rid = id::new("USR");
            let mut tx = pool.begin().await?;
            db::register_entity(&mut tx, &rid, "user").await?;
            sqlx::query(
                "INSERT INTO users (redpash_id, username, display_name, role)
                 VALUES ($1, 'dev', 'Dev user', 'admin')",
            )
            .bind(&rid)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            rid
        }
    };
    db::ensure_default_project(pool, &rid).await?;
    tracing::info!(user = %rid, "dev bootstrap ready (debug build)");
    Ok(rid)
}
