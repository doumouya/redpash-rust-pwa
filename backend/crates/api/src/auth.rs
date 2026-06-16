//! Purpose: `/api/auth/*` — Google OAuth code flow + sessions, ported
//! near-verbatim (userinfo-over-JWT, upsert-by-sub, no refresh tokens,
//! opaque rp_session cookie), with the day-one #10 hardening:
//!   - dev-login is COMPILED OUT of release builds (cfg, not env);
//!   - the Secure cookie attribute has ONE flip point: on in release,
//!     off in debug (HTTP dev) — no env var to forget;
//!   - first-admin claim replaces the bootstrap-admins env escape hatch.
//! CSRF posture: SameSite=Lax + the OAuth state cookie; an origin-check
//! middleware for state-changing JSON routes lands in Phase 4.

use axum::{
    extract::{Query, State},
    http::{
        header::{HeaderMap, HeaderName, HeaderValue, SET_COOKIE},
        StatusCode,
    },
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::{db, error::AppError, rbac::Caller, session, state::AppState};

const SESSION_TTL_DAYS: i64 = 30;
pub const SESSION_COOKIE: &str = "rp_session";
const STATE_COOKIE: &str = "rp_oauth_state";

/// Day-one #10: the single Secure flip point — compile profile, not env.
#[cfg(debug_assertions)]
const SECURE_ATTR: &str = "";
#[cfg(not(debug_assertions))]
const SECURE_ATTR: &str = "; Secure";

pub fn routes() -> Router<AppState> {
    let r = Router::new()
        .route("/google/start", get(start))
        .route("/google/callback", get(callback))
        .route("/logout", post(logout))
        .route("/claim-admin", post(claim_admin));
    // Compiled out of release binaries entirely — not a runtime flag.
    #[cfg(debug_assertions)]
    let r = r.route("/dev-login", post(dev_login));
    r
}

// ─── start ──────────────────────────────────────────────────────────────────

async fn start(State(state): State<AppState>) -> Result<Response, AppError> {
    let cfg = oauth_cfg(&state)?;
    let csrf = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?\
         client_id={}&redirect_uri={}&response_type=code\
         &scope=openid%20email%20profile&state={}\
         &access_type=online&prompt=select_account",
        urlencode(&cfg.client_id),
        urlencode(&cfg.redirect_uri),
        csrf,
    );
    let cookie =
        format!("{STATE_COOKIE}={csrf}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600{SECURE_ATTR}");
    let mut headers = HeaderMap::new();
    headers.insert(SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
    Ok((headers, Redirect::to(&auth_url)).into_response())
}

// ─── callback ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CallbackParams {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct TokenResp {
    access_token: String,
}

#[derive(Deserialize)]
struct UserInfo {
    sub: String,
    email: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    picture: Option<String>,
}

async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<CallbackParams>,
) -> Result<Response, AppError> {
    let cfg = oauth_cfg(&state)?;
    if let Some(err) = q.error {
        return Err(AppError::bad_request("oauth_denied", err));
    }
    let code = q.code.ok_or_else(|| AppError::bad_request("oauth_no_code", "missing `code`"))?;
    let state_param =
        q.state.ok_or_else(|| AppError::bad_request("oauth_no_state", "missing `state`"))?;
    let expected = read_cookie(&headers, STATE_COOKIE).ok_or_else(|| {
        AppError::bad_request("oauth_no_state_cookie", "state cookie missing or expired")
    })?;
    if expected != state_param {
        return Err(AppError::bad_request("oauth_state_mismatch", "CSRF check failed"));
    }

    let token: TokenResp = state
        .http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code.as_str()),
            ("client_id", cfg.client_id.as_str()),
            ("client_secret", cfg.client_secret.as_str()),
            ("redirect_uri", cfg.redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| AppError::internal("oauth_token_request", e.to_string()))?
        .error_for_status()
        .map_err(|e| AppError::bad_request("oauth_token_rejected", e.to_string()))?
        .json()
        .await
        .map_err(|e| AppError::internal("oauth_token_decode", e.to_string()))?;

    // userinfo over id_token JWT: one documented GET, no JWT verification
    // code to own.
    let info: UserInfo = state
        .http
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(&token.access_token)
        .send()
        .await
        .map_err(|e| AppError::internal("oauth_userinfo_request", e.to_string()))?
        .error_for_status()
        .map_err(|e| AppError::internal("oauth_userinfo_rejected", e.to_string()))?
        .json()
        .await
        .map_err(|e| AppError::internal("oauth_userinfo_decode", e.to_string()))?;

    let display = info
        .name
        .as_deref()
        .unwrap_or_else(|| info.email.split('@').next().unwrap_or("there"));
    let user =
        db::upsert_google_user(&state.db, &info.sub, &info.email, display, info.picture.as_deref())
            .await?;
    db::ensure_default_project(&state.db, &user.redpash_id).await?;
    let sid = db::create_session(&state.db, &user.redpash_id, SESSION_TTL_DAYS).await?;

    let mut out = HeaderMap::new();
    out.append(SET_COOKIE, HeaderValue::from_str(&clear_cookie(STATE_COOKIE)).unwrap());
    out.append(SET_COOKIE, HeaderValue::from_str(&session_cookie(&sid)).unwrap());
    Ok((out, Redirect::to("/")).into_response())
}

// ─── logout ──────────────────────────────────────────────────────────────────

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, AppError> {
    if let Some(sid) = read_cookie(&headers, SESSION_COOKIE) {
        let _ = db::delete_session(&state.db, &sid).await;
        session::invalidate(&state, &sid);
    }
    let mut out = HeaderMap::new();
    out.insert(SET_COOKIE, HeaderValue::from_str(&clear_cookie(SESSION_COOKIE)).unwrap());
    Ok((out, StatusCode::NO_CONTENT).into_response())
}

// ─── first-admin claim ───────────────────────────────────────────────────────
// Replaces REDPASH_BOOTSTRAP_ADMINS: the first authenticated user to call
// this while NO admin exists becomes one (atomic — exactly one winner).
// Subsequent admins are granted by an admin through the admin surface.

async fn claim_admin(
    State(state): State<AppState>,
    caller: Caller,
) -> Result<Response, AppError> {
    if db::claim_first_admin(&state.db, &caller.rid).await? {
        // The cached (rid, is_admin) tuple is now stale for this user's
        // session(s); the 60s TTL self-corrects — log the claim loudly.
        tracing::warn!(user = %caller.rid, "first platform admin claimed");
        Ok((StatusCode::OK, Json(serde_json::json!({ "claimed": true }))).into_response())
    } else {
        // Leak-free shape: an existing-admin install answers exactly like a
        // wrong route — don't advertise admin presence to probes.
        Err(AppError::not_found("not_found", "nothing to claim"))
    }
}

// ─── dev-login (debug builds ONLY — does not exist in release) ──────────────

#[cfg(debug_assertions)]
#[derive(Deserialize, Default)]
struct DevLoginBody {
    #[serde(default)]
    user_id: Option<String>,
}

#[cfg(debug_assertions)]
async fn dev_login(
    State(state): State<AppState>,
    body: axum::body::Bytes,
) -> Result<Response, AppError> {
    // Raw Bytes so a no-body POST isn't 415'd; empty body → dev user.
    let user_id = if body.is_empty() {
        state.dev_user.as_ref().clone()
    } else {
        let parsed: DevLoginBody = serde_json::from_slice(&body)
            .map_err(|e| AppError::bad_request("invalid_json", e.to_string()))?;
        parsed.user_id.unwrap_or_else(|| state.dev_user.as_ref().clone())
    };
    let user = db::find_user_by_id(&state.db, &user_id)
        .await?
        .ok_or_else(|| AppError::not_found("not_found", "user not found"))?;
    let sid = db::create_session(&state.db, &user.redpash_id, SESSION_TTL_DAYS).await?;
    let mut out = HeaderMap::new();
    out.insert(SET_COOKIE, HeaderValue::from_str(&session_cookie(&sid)).unwrap());
    Ok((out, StatusCode::NO_CONTENT).into_response())
}

// ─── cookie helpers ──────────────────────────────────────────────────────────

fn session_cookie(sid: &str) -> String {
    format!(
        "{SESSION_COOKIE}={sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age={}{SECURE_ATTR}",
        SESSION_TTL_DAYS * 24 * 3600,
    )
}

fn clear_cookie(name: &str) -> String {
    format!("{name}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0{SECURE_ATTR}")
}

fn oauth_cfg(state: &AppState) -> Result<std::sync::Arc<crate::state::OAuthConfig>, AppError> {
    state.oauth.clone().ok_or_else(|| {
        AppError::service_unavailable(
            "oauth_disabled",
            "Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI.",
        )
    })
}

/// Read one cookie by name; tolerates multiple `cookie` headers.
pub fn read_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    for h in headers.get_all(HeaderName::from_static("cookie")).iter() {
        let raw = h.to_str().ok()?;
        for piece in raw.split(';') {
            let p = piece.trim();
            if let Some(rest) = p.strip_prefix(&format!("{name}=")) {
                return Some(rest.to_string());
            }
        }
    }
    None
}

/// Percent-encode the few OAuth params we send (both values are ours).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
