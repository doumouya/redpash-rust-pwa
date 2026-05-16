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
            db::insert_user(pool, &rid, DEV_USERNAME, "Dev user", None)
                .await
                .context("creating dev user")?
        }
    };

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
