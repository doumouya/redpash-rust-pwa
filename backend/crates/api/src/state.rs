//! Purpose: shared application state — Arc-backed, cheap to clone.

use std::{path::PathBuf, sync::Arc, time::Duration};

use dashmap::DashMap;
use polars::prelude::DataFrame;
use shared::file::ColumnMeta;
use sqlx::postgres::{PgPool, PgPoolOptions};

/// A hydrated file in the in-memory cache: the parsed frame (base CSV + applied
/// steps replayed) plus its summary. Arc-shared so a page read clones cheaply.
#[derive(Clone)]
pub struct FileEntry {
    pub columns: Vec<ColumnMeta>,
    pub cleanness: Option<f32>,
    pub frame: Arc<DataFrame>,
}

/// Present only when all three GOOGLE_OAUTH_* env vars are set; without them
/// the auth routes 503 and (debug builds only) the dev bootstrap user serves.
#[derive(Clone, Debug)]
pub struct OAuthConfig {
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
}

/// session-id → (user rid, is_platform_admin, cached_at). 60s TTL: kills the
/// predecessor's 2+ session/admin queries per request while keeping role
/// changes near-live. Logout invalidates eagerly.
pub type SessionCache = Arc<DashMap<String, (String, bool, std::time::Instant)>>;
pub const SESSION_CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub oauth: Option<Arc<OAuthConfig>>,
    pub http: reqwest::Client,
    pub type_cache: Arc<crate::type_cache::TypeDefCache>,
    pub sessions: SessionCache,
    /// Root of on-disk file storage. Uploaded bytes live IMMUTABLE under
    /// `<data_dir>/files/<rid>.bin`; the cache rehydrates from there on miss.
    pub data_dir: Arc<PathBuf>,
    /// In-memory parsed-frame cache, keyed by file rid. Lost on restart;
    /// refilled by single-flight hydration (see files::hydrate). NOTE: a
    /// size/LRU budget is the documented Phase-4 follow-on — today it is
    /// unbounded (fine at dev scale).
    pub files: Arc<DashMap<String, FileEntry>>,
    /// Per-rid hydration locks — single-flight so concurrent readers of a
    /// cold file parse it once, not N times (kills the predecessor's
    /// duplicate-parse race).
    pub hydrating: Arc<DashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Cross-origin allowlist for the CSRF origin guard (host[:port] entries
    /// from REDPASH_ALLOWED_ORIGINS). Loopback origins are always allowed in
    /// debug builds; in release, only these.
    pub allowed_origins: Arc<Vec<String>>,
    /// Debug builds only: the auto-bootstrapped dev user's rid. Release
    /// builds never have one — no fallback identity exists (day-one #10).
    #[cfg(debug_assertions)]
    pub dev_user: Arc<String>,
}

impl AppState {
    pub async fn init() -> eyre::Result<Self> {
        let url = std::env::var("DATABASE_URL")
            .map_err(|_| eyre::eyre!("DATABASE_URL is not set"))?;
        let db = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(5))
            .connect(&url)
            .await?;

        // Order: migrate (which seeds the registry) → load the cache.
        sqlx::migrate!("../../migrations").run(&db).await?;
        let type_cache = Arc::new(crate::type_cache::TypeDefCache::load(&db).await?);

        let oauth = match (
            env_nonempty("GOOGLE_OAUTH_CLIENT_ID"),
            env_nonempty("GOOGLE_OAUTH_CLIENT_SECRET"),
            env_nonempty("GOOGLE_OAUTH_REDIRECT_URI"),
        ) {
            (Some(client_id), Some(client_secret), Some(redirect_uri)) => {
                tracing::info!(%redirect_uri, "google oauth configured");
                Some(Arc::new(OAuthConfig { client_id, client_secret, redirect_uri }))
            }
            _ => {
                tracing::info!("google oauth not configured");
                None
            }
        };

        // Debug-only dev bootstrap: a 'dev' platform-admin user + default
        // project so local dev works with zero setup. Compiled OUT of
        // release binaries entirely (day-one #10) — not an env flag.
        #[cfg(debug_assertions)]
        let dev_user = Arc::new(crate::bootstrap::ensure_dev_user(&db).await?);

        let data_dir: PathBuf =
            std::env::var("REDPASH_DATA_DIR").unwrap_or_else(|_| "./data".into()).into();
        std::fs::create_dir_all(data_dir.join("files"))?;
        std::fs::create_dir_all(data_dir.join("attachments"))?;

        let allowed_origins: Vec<String> = std::env::var("REDPASH_ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        Ok(Self {
            db,
            oauth,
            http: reqwest::Client::builder().timeout(Duration::from_secs(10)).build()?,
            type_cache,
            sessions: Arc::new(DashMap::new()),
            data_dir: Arc::new(data_dir),
            files: Arc::new(DashMap::new()),
            hydrating: Arc::new(DashMap::new()),
            allowed_origins: Arc::new(allowed_origins),
            #[cfg(debug_assertions)]
            dev_user,
        })
    }

    pub fn file_path(&self, rid: &str) -> PathBuf {
        self.data_dir.join("files").join(format!("{rid}.bin"))
    }

    /// Case attachment bytes — immutable raw `.bin` (no parse), the analogue of
    /// `file_path` for the `attachments/` store.
    pub fn attachment_path(&self, rid: &str) -> PathBuf {
        self.data_dir.join("attachments").join(format!("{rid}.bin"))
    }
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.is_empty())
}
