//! Doc: docs/internal/code/backend/api/bootstrap.md
//! Startup-time idempotent setup.
//!
//! Runs after migrations. Ensures the dev user + their default project
//! exist so the upload pipeline always has somewhere to put files. Once
//! Phase 4 (Google OAuth) ships, this falls back to a no-op when at
//! least one human user already exists.

use crate::{db, id};
use anyhow::Context;
use shared::user::UserProfile;
use sqlx::PgPool;

const DEV_USERNAME: &str = "dev";

pub struct Bootstrap {
    pub user:    UserProfile,
    pub project: String,
}

pub async fn run(pool: &PgPool) -> anyhow::Result<Bootstrap> {
    let user = match db::find_user_by_username(pool, DEV_USERNAME)
        .await
        .context("looking up dev user")?
    {
        Some(u) => u,
        None => {
            let rid = id::new("USR");
            tracing::info!(%rid, "creating dev user");
            db::insert_user(pool, &rid, DEV_USERNAME, "Dev user", None, None, None, None)
                .await
                .context("creating dev user")?
        }
    };

    // The bootstrap/dev user is the platform admin (users.role = 'admin', mig
    // 20260531000002). Idempotent — keeps the dev-mode RBAC bypass working
    // (rbac::is_platform_admin) regardless of how the row was created.
    sqlx::query("UPDATE users SET role = 'admin' WHERE redpash_id = $1 AND role <> 'admin'")
        .bind(&user.redpash_id)
        .execute(pool)
        .await
        .context("promoting dev user to admin")?;

    // Bootstrap admin allowlist — promote founders / additional admins without
    // a psql one-liner (CAS_D78667D1). `REDPASH_BOOTSTRAP_ADMINS` is a
    // comma-separated list of `redpash_id` OR `username` values; each is
    // promoted idempotently on every boot. Closes the gap where a non-dev
    // login (Em's real Google account, another Torv) saw empty list pages
    // because RBAC strips rows for a caller with no platform-admin role.
    // Unknown tokens are a no-op (0 rows) — safe to leave stale entries.
    if let Ok(raw) = std::env::var("REDPASH_BOOTSTRAP_ADMINS") {
        for token in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let promoted = sqlx::query(
                "UPDATE users SET role = 'admin'
                 WHERE (redpash_id = $1 OR username = $1) AND role <> 'admin'",
            )
            .bind(token)
            .execute(pool)
            .await
            .context("promoting bootstrap admin from allowlist")?;
            if promoted.rows_affected() > 0 {
                tracing::info!(%token, "promoted bootstrap admin from REDPASH_BOOTSTRAP_ADMINS");
            }
        }
    }

    let project = match db::find_default_project(pool, &user.redpash_id)
        .await
        .context("looking up default project")?
    {
        Some(p) => p,
        None => {
            let rid = id::new("PRJ");
            tracing::info!(%rid, "creating default project");
            db::insert_project(pool, &rid, &user.redpash_id, "Workspace", true)
                .await
                .context("creating default project")?;
            rid
        }
    };

    Ok(Bootstrap { user, project })
}
