//! Purpose: cross-cutting request middleware. Today: the CSRF origin guard +
//! the static cache policy (immutable for content-hashed assets).
//!
//! Defense-in-depth on top of SameSite=Lax cookies (which already block
//! cross-site cookie-bearing POST/fetch). On a state-changing method, if the
//! browser sent an Origin header it must be same-origin or allowlisted —
//! otherwise 403. A missing Origin (same-origin requests that omit it,
//! non-browser clients) passes: those aren't the CSRF threat (no ambient
//! cookie auto-attach across sites). Loopback origins are always allowed in
//! debug builds; release trusts only REDPASH_ALLOWED_ORIGINS.

use axum::{
    extract::State,
    http::{Method, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::state::AppState;

fn origin_host(origin: &str) -> Option<&str> {
    // strip scheme → host[:port]
    let after = origin.split("://").nth(1).unwrap_or(origin);
    after.split('/').next().filter(|s| !s.is_empty())
}

fn is_loopback_origin(host: &str) -> bool {
    let h = host.split(':').next().unwrap_or(host);
    h == "localhost" || h == "127.0.0.1" || h == "[::1]" || h == "::1"
}

pub async fn origin_guard(
    State(state): State<AppState>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let unsafe_method = matches!(
        *req.method(),
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );
    if unsafe_method {
        if let Some(origin) = req.headers().get(axum::http::header::ORIGIN).and_then(|v| v.to_str().ok()) {
            let host = origin_host(origin).unwrap_or("");
            let loopback_ok = cfg!(debug_assertions) && is_loopback_origin(host);
            let allowed = loopback_ok
                || state.allowed_origins.iter().any(|a| a == host || a == origin);
            if !allowed {
                return (
                    StatusCode::FORBIDDEN,
                    axum::Json(serde_json::json!({
                        "error": "cross-origin request refused",
                        "kind": "bad_origin",
                    })),
                )
                    .into_response();
            }
        }
    }
    next.run(req).await
}

/// CONTENT-HASHED assets are immutable by construction (build-fe.sh /
/// build-wasm.sh: the hash IS the cache version — a change is a new URL), so
/// they get the year-long immutable header. Everything else keeps the outer
/// no-store (HTML entry points and the SW are what NAME the hashes, so they
/// must never be cached; dev source must always reflect the last edit). API
/// paths never match the pattern.
pub async fn immutable_for_hashed(req: Request<axum::body::Body>, next: Next) -> Response {
    let hashed = is_hashed_asset(req.uri().path());
    let mut resp = next.run(req).await;
    if hashed && resp.status().is_success() {
        resp.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }
    resp
}

/// `name.<8-16 hex>.(js|css|wasm)` — the shape both build pipelines emit.
fn is_hashed_asset(path: &str) -> bool {
    let Some((stem, ext)) = path.rsplit_once('.') else { return false };
    if !matches!(ext, "js" | "css" | "wasm") {
        return false;
    }
    let Some((_, h)) = stem.rsplit_once('.') else { return false };
    (8..=16).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashed_asset_shape() {
        assert!(is_hashed_asset("/wasm/data_bg.25df774b9cf3.wasm"));
        assert!(is_hashed_asset("/framework/boot/main.ab12cd34ef56.js"));
        assert!(is_hashed_asset("/styles/main.0123456789ab.css"));
        assert!(!is_hashed_asset("/framework/boot/main.js"), "unhashed js");
        assert!(!is_hashed_asset("/service-worker.js"), "the SW must revalidate");
        assert!(!is_hashed_asset("/index.html"), "entry points must revalidate");
        assert!(!is_hashed_asset("/apps/admin/org/org.html"), "partials revalidate");
        assert!(!is_hashed_asset("/api/files/FIL_ABC.js"), "uppercase ≠ a hash");
        assert!(!is_hashed_asset("/styles/main.abc.css"), "too short to be a hash");
    }

    #[test]
    fn origin_host_strips_scheme_and_path() {
        assert_eq!(origin_host("https://app.redpash.com"), Some("app.redpash.com"));
        assert_eq!(origin_host("http://localhost:8080"), Some("localhost:8080"));
        assert_eq!(origin_host("null"), Some("null"));
    }

    #[test]
    fn loopback_origins_recognized() {
        assert!(is_loopback_origin("localhost:8080"));
        assert!(is_loopback_origin("127.0.0.1"));
        assert!(!is_loopback_origin("evil.com"));
    }
}
