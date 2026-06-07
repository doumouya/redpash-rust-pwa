//! Doc: docs/internal/code/backend/api/state.md
//! Shared application state.
//!
//! Cloned into every handler via Axum's `State<AppState>` extractor —
//! everything inside is `Arc`-backed and cheap to clone.
//!
//! Three stores:
//!   - `db`       : Postgres pool — required from phase 2 onwards.
//!   - `files`    : in-memory cache of parsed CSV uploads keyed by RID.
//!                  Survives many requests; lost on restart. Cache miss
//!                  re-reads from `<data_dir>/files/<rid>.bin` and
//!                  reparses with Polars.
//!   - `data_dir` : root of on-disk storage. Configured via
//!                  REDPASH_DATA_DIR (default `./data`). The `files/`
//!                  subdir holds uploaded byte blobs.
//!   - `dev_user`   : RID of the bootstrap user. Read only by
//!                    `routes::me::resolve_user_rid` when no
//!                    `rp_session` cookie is present *and* OAuth is
//!                    disabled (i.e. local dev without Google creds).
//!                    Every upload / list / create now uses the
//!                    session user instead.

use dashmap::DashMap;
use polars::prelude::DataFrame;
use shared::file::{ColumnMeta, FileSummary};
use sqlx::postgres::{PgPool, PgPoolOptions};
use std::{path::PathBuf, sync::Arc, time::Duration};

#[derive(Clone)]
pub struct FileEntry {
    pub summary: FileSummary,
    pub columns: Vec<ColumnMeta>,
    pub frame:   Arc<DataFrame>,
}

/// Google OAuth config — present only when all three env vars are set.
/// When `None`, the auth routes return 503 and the `current_user`
/// extractor falls back to the bootstrap dev_user.
#[derive(Clone, Debug)]
pub struct OAuthConfig {
    pub client_id:     String,
    pub client_secret: String,
    pub redirect_uri:  String,
}

#[derive(Clone)]
pub struct AppState {
    pub db:              PgPool,
    pub files:           Arc<DashMap<String, FileEntry>>,
    pub data_dir:        Arc<PathBuf>,
    pub dev_user:        Arc<String>,
    pub oauth:           Option<Arc<OAuthConfig>>,
    pub http:            reqwest::Client,
    /// Cache of fetched avatar bytes keyed by source URL. Google's
    /// `lh3.googleusercontent.com` returns opaque responses to the
    /// browser (Firefox OBR), so `/api/me/avatar` proxies them
    /// server-side. Values are `(bytes, content_type)`. Lost on
    /// restart — refilled on first hit.
    pub avatars:         Arc<DashMap<String, (Vec<u8>, String)>>,
    /// When true, `POST /api/auth/dev-login` mints a session for ANY
    /// user by RID with no credentials — powers the Home header's
    /// "log in as user" switcher for testing owner-scoped flows.
    /// Opt-in via `REDPASH_DEV_LOGIN`; off by default. Never enable in
    /// production — it's an unauthenticated session-mint endpoint.
    pub dev_login:       bool,
    /// RID of the canonical "internal" company — drives the
    /// internal/external case discriminator on `/api/cases?source=`.
    /// A case is internal iff its reporter is a member of this
    /// company. Resolved at startup from `REDPASH_INTERNAL_COMPANY_NAME`
    /// (default "RedPash"); `None` when no matching company exists,
    /// in which case the source filter is a no-op.
    pub internal_company_id: Arc<Option<String>>,
    /// The data-driven type registry (type_definitions/type_fields/
    /// type_scope_roles), loaded once after migrate. Replaces the code-side
    /// field/type/role registries (object-registry Stage 1).
    pub type_cache:          Arc<crate::type_cache::TypeDefCache>,
}

impl AppState {
    pub async fn init() -> anyhow::Result<Self> {
        let url = std::env::var("DATABASE_URL")
            .map_err(|_| anyhow::anyhow!("DATABASE_URL is not set — see backend/.env.example"))?;

        let db = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(5))
            .connect(&url)
            .await?;

        // 1. Schema. sqlx::migrate! embeds the migrations at build time
        //    relative to the api crate's manifest dir.
        sqlx::migrate!("../../migrations").run(&db).await?;

        // 1b. Type registry — load the seeded type_definitions/type_fields/
        //     type_scope_roles into the immutable cache. Order is migrate
        //     (which seeds) → load, never the reverse.
        let type_cache = Arc::new(crate::type_cache::TypeDefCache::load(&db).await?);

        // 2. Dev user + default project.
        let bs = crate::bootstrap::run(&db).await?;

        // 3. On-disk layout.
        let data_dir: PathBuf = std::env::var("REDPASH_DATA_DIR")
            .unwrap_or_else(|_| "./data".into())
            .into();
        std::fs::create_dir_all(data_dir.join("files"))?;

        tracing::info!(user = %bs.user.redpash_id, project = %bs.project, "bootstrap ready");

        // Google OAuth — opt-in via env vars. Without all three set,
        // auth routes 503 and the app stays in dev_user-only mode for
        // local development.
        let oauth = match (
            std::env::var("GOOGLE_OAUTH_CLIENT_ID").ok().filter(|s| !s.is_empty()),
            std::env::var("GOOGLE_OAUTH_CLIENT_SECRET").ok().filter(|s| !s.is_empty()),
            std::env::var("GOOGLE_OAUTH_REDIRECT_URI").ok().filter(|s| !s.is_empty()),
        ) {
            (Some(client_id), Some(client_secret), Some(redirect_uri)) => {
                tracing::info!("google oauth configured (redirect_uri = {redirect_uri})");
                Some(Arc::new(OAuthConfig { client_id, client_secret, redirect_uri }))
            }
            _ => {
                tracing::info!("google oauth not configured — running in dev_user mode");
                None
            }
        };

        // bs.project is intentionally dropped — every upload looks up
        // (or creates) the *session user's* default project now.
        let _ = bs.project;

        // Dev-only "log in as user" switch — opt-in, off by default.
        let dev_login = std::env::var("REDPASH_DEV_LOGIN")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if dev_login {
            tracing::warn!("REDPASH_DEV_LOGIN enabled — /api/auth/dev-login mints sessions with no credentials. Dev only.");
        }

        // Resolve the canonical "internal" company by name. Drives the
        // /api/cases?source= filter — a case is internal iff its
        // reporter shares a membership in this company. Default name
        // matches the seeded RedPash company; override via env when
        // the canonical company is named differently.
        let internal_company_name = std::env::var("REDPASH_INTERNAL_COMPANY_NAME")
            .unwrap_or_else(|_| "RedPash".to_string());
        let internal_company_id: Option<String> = sqlx::query_scalar(
            "SELECT redpash_id FROM companies WHERE name = $1 LIMIT 1",
        )
        .bind(&internal_company_name)
        .fetch_optional(&db)
        .await?;
        match &internal_company_id {
            Some(rid) => tracing::info!(company = %internal_company_name, %rid, "internal company resolved"),
            None      => tracing::warn!(
                company = %internal_company_name,
                "no matching company — /api/cases?source= filter will be a no-op until one is created",
            ),
        }

        Ok(Self {
            db,
            files:           Arc::new(DashMap::new()),
            data_dir:        Arc::new(data_dir),
            dev_user:        Arc::new(bs.user.redpash_id),
            oauth,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .expect("reqwest client init"),
            avatars: Arc::new(DashMap::new()),
            dev_login,
            internal_company_id: Arc::new(internal_company_id),
            type_cache,
        })
    }

    pub fn file_path(&self, rid: &str) -> PathBuf {
        self.data_dir.join("files").join(format!("{rid}.bin"))
    }
}
