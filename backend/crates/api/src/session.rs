//! Purpose: the per-request auth context — resolved ONCE, cached, typed.
//!
//! `Caller` is an axum extractor: cookie → session row → user rid +
//! is_platform_admin, behind a 60s TTL cache. Handlers receive the verdict;
//! no gate re-queries the users table (the predecessor ran ~5 auth queries
//! per file PATCH). Endpoints that take `Caller` cannot forget auth — absence
//! of a session is a typed 401 before the handler body runs (debug builds
//! fall back to the dev bootstrap user so local dev needs zero setup).

use axum::{extract::FromRequestParts, http::request::Parts};

use crate::{auth, db, error::AppError, rbac::Caller, state::AppState, state::SESSION_CACHE_TTL};

#[axum::async_trait]
impl FromRequestParts<AppState> for Caller {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let sid = auth::read_cookie(&parts.headers, auth::SESSION_COOKIE);

        if let Some(sid) = sid {
            // Cache hit within TTL → zero queries.
            if let Some(hit) = state.sessions.get(&sid) {
                let (rid, is_admin, at) = hit.value().clone();
                if at.elapsed() < SESSION_CACHE_TTL {
                    return Ok(Caller { rid, is_platform_admin: is_admin });
                }
            }
            if let Some(rid) = db::find_session_user(&state.db, &sid).await? {
                let is_admin: bool = sqlx::query_scalar(
                    "SELECT role = 'admin' FROM users WHERE redpash_id = $1",
                )
                .bind(&rid)
                .fetch_optional(&state.db)
                .await?
                .unwrap_or(false);
                state
                    .sessions
                    .insert(sid, (rid.clone(), is_admin, std::time::Instant::now()));
                return Ok(Caller { rid, is_platform_admin: is_admin });
            }
        }

        // Debug builds: no/expired session falls back to the dev bootstrap
        // user (always a platform admin). Compiled out of release.
        #[cfg(debug_assertions)]
        {
            return Ok(Caller {
                rid: state.dev_user.as_ref().clone(),
                is_platform_admin: true,
            });
        }

        #[cfg(not(debug_assertions))]
        Err(AppError::unauthenticated())
    }
}

/// Eager invalidation (logout, role changes).
pub fn invalidate(state: &AppState, sid: &str) {
    state.sessions.remove(sid);
}
