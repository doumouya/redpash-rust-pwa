//! `/api/auth/google/*` — full OAuth 2.0 authorization-code flow.
//!
//! Sequence:
//!   1. `GET  /api/auth/google/start`
//!      Mint a random `state` token, stash it in a short-lived
//!      `rp_oauth_state` cookie, redirect to Google's consent screen.
//!   2. `GET  /api/auth/google/callback?state=…&code=…`
//!      Verify `state` matches the cookie. Exchange `code` for tokens
//!      against `oauth2.googleapis.com`. Fetch the userinfo claims.
//!      Upsert the user by `google_sub`. Create a session row, set
//!      an HttpOnly `rp_session` cookie, redirect to `/`.
//!   3. `POST /api/auth/logout`
//!      Delete the session row and clear the cookie.
//!
//! The flow needs all three `GOOGLE_OAUTH_*` env vars (see state.rs).
//! Without them the auth routes 503; the rest of the app stays on the
//! bootstrap dev_user.

use axum::{
    extract::{Query, State},
    http::{header::{HeaderMap, HeaderName, HeaderValue, SET_COOKIE}, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::{db, error::AppError, state::AppState};

/// How long a session cookie is valid for on the client and in the DB.
const SESSION_TTL_DAYS: i64 = 30;
const SESSION_COOKIE:   &str = "rp_session";
const STATE_COOKIE:     &str = "rp_oauth_state";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/google/start",    get(start))
        .route("/google/callback", get(callback))
        .route("/logout",          post(logout))
        .route("/dev-login",       post(dev_login))
}

// ─── 1. start ────────────────────────────────────────────────────

async fn start(State(state): State<AppState>) -> Result<Response, AppError> {
    let cfg = state.oauth.as_ref().ok_or_else(|| AppError {
        status:  StatusCode::SERVICE_UNAVAILABLE,
        kind:    "oauth_disabled",
        message: "Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI.".into(),
        inner:   None,
    })?;

    // Random CSRF token. 128 bits of entropy via two UUIDs is plenty.
    let csrf = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());

    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?\
         client_id={}\
         &redirect_uri={}\
         &response_type=code\
         &scope=openid%20email%20profile\
         &state={}\
         &access_type=online\
         &prompt=select_account",
        urlencode(&cfg.client_id),
        urlencode(&cfg.redirect_uri),
        csrf,
    );

    // Stash the state in an HttpOnly cookie. 10 min is enough for the
    // round-trip; longer leaves stale tokens lying around.
    let cookie = format!(
        "{STATE_COOKIE}={csrf}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600"
    );
    let mut headers = HeaderMap::new();
    headers.insert(SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());

    Ok((headers, Redirect::to(&auth_url)).into_response())
}

// ─── 2. callback ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct CallbackParams {
    code:  Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct TokenResp {
    access_token: String,
    #[allow(dead_code)]
    id_token:     Option<String>,
}

#[derive(Deserialize)]
struct UserInfo {
    sub:     String,
    email:   String,
    #[serde(default)] name:    Option<String>,
    #[serde(default)] picture: Option<String>,
}

async fn callback(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Query(q):     Query<CallbackParams>,
) -> Result<Response, AppError> {
    let cfg = state.oauth.as_ref().ok_or_else(|| AppError {
        status:  StatusCode::SERVICE_UNAVAILABLE,
        kind:    "oauth_disabled",
        message: "Google OAuth is not configured.".into(),
        inner:   None,
    })?;

    // Google returns `?error=…` when the user denies consent.
    if let Some(err) = q.error {
        return Err(AppError::bad_request("oauth_denied", err));
    }
    let code  = q.code.ok_or_else(|| AppError::bad_request("oauth_no_code", "missing `code`"))?;
    let state_param = q.state.ok_or_else(|| AppError::bad_request("oauth_no_state", "missing `state`"))?;

    // CSRF check — `state` must match the cookie we set in /start.
    let expected = read_cookie(&headers, STATE_COOKIE)
        .ok_or_else(|| AppError::bad_request("oauth_no_state_cookie", "state cookie missing or expired"))?;
    if expected != state_param {
        return Err(AppError::bad_request("oauth_state_mismatch", "state mismatch — CSRF check failed"));
    }

    // Exchange the auth code for tokens.
    let token: TokenResp = state.http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code",          code.as_str()),
            ("client_id",     cfg.client_id.as_str()),
            ("client_secret", cfg.client_secret.as_str()),
            ("redirect_uri",  cfg.redirect_uri.as_str()),
            ("grant_type",    "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| AppError::internal("oauth_token_request", e.to_string()))?
        .error_for_status()
        .map_err(|e| AppError::bad_request("oauth_token_rejected", e.to_string()))?
        .json::<TokenResp>()
        .await
        .map_err(|e| AppError::internal("oauth_token_decode", e.to_string()))?;

    // Fetch profile claims with the access token. Could decode the
    // id_token JWT instead, but a one-line GET is simpler and the
    // userinfo endpoint is the documented source of truth.
    let info: UserInfo = state.http
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(&token.access_token)
        .send()
        .await
        .map_err(|e| AppError::internal("oauth_userinfo_request", e.to_string()))?
        .error_for_status()
        .map_err(|e| AppError::internal("oauth_userinfo_rejected", e.to_string()))?
        .json::<UserInfo>()
        .await
        .map_err(|e| AppError::internal("oauth_userinfo_decode", e.to_string()))?;

    let display = info.name.as_deref().unwrap_or_else(|| {
        // Fall back to the email local part if Google didn't include a name.
        info.email.split('@').next().unwrap_or("there")
    });
    let user = db::upsert_google_user(
        &state.db,
        &info.sub,
        &info.email,
        display,
        info.picture.as_deref(),
    )
    .await?;

    // Every user needs a default project — uploads land in it when
    // the request doesn't specify one. Idempotent on returning users.
    db::ensure_default_project(&state.db, &user.redpash_id)
        .await?;

    // Mint a session, drop the state cookie, set the session cookie,
    // redirect home.
    let sid = db::create_session(&state.db, &user.redpash_id, SESSION_TTL_DAYS)
        .await?;

    crate::event::info(
        &state.db,
        "auth_login",
        format!("{} signed in (Google OAuth)", user.username),
    )
    .user(user.redpash_id.clone())
    .session(sid.clone())
    .send();

    let mut out = HeaderMap::new();
    out.append(SET_COOKIE, HeaderValue::from_str(&clear_cookie(STATE_COOKIE)).unwrap());
    out.append(SET_COOKIE, HeaderValue::from_str(&session_cookie(&sid)).unwrap());
    Ok((out, Redirect::to("/")).into_response())
}

// ─── 3. logout ───────────────────────────────────────────────────

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, AppError> {
    if let Some(sid) = read_cookie(&headers, SESSION_COOKIE) {
        // Resolve the user before the session row is deleted so the
        // logout event can still be attributed.
        let user = db::find_session_user(&state.db, &sid).await.ok().flatten();
        let _ = db::delete_session(&state.db, &sid).await;
        crate::event::info(&state.db, "auth_logout", "signed out")
            .user_opt(user)
            .session(sid)
            .send();
    }
    let mut out = HeaderMap::new();
    out.insert(SET_COOKIE, HeaderValue::from_str(&clear_cookie(SESSION_COOKIE)).unwrap());
    Ok((out, StatusCode::NO_CONTENT).into_response())
}

// ─── dev-login (dev only) ────────────────────────────────────────
//
// `POST /api/auth/dev-login` — mints a session for ANY user by RID
// with no credentials. Powers the Home header's "log in as user"
// switcher for testing owner-scoped flows (project reassignment,
// company membership, …) without juggling Google accounts.
//
// Gated behind `state.dev_login` (the `REDPASH_DEV_LOGIN` env flag),
// off by default. This is a deliberate unauthenticated session-mint —
// it must never be enabled in production.

#[derive(Deserialize)]
struct DevLoginBody {
    user_id: String,
}

async fn dev_login(
    State(state): State<AppState>,
    Json(body):   Json<DevLoginBody>,
) -> Result<Response, AppError> {
    if !state.dev_login {
        return Err(AppError {
            status:  StatusCode::FORBIDDEN,
            kind:    "dev_login_disabled",
            message: "dev-login is disabled — set REDPASH_DEV_LOGIN=1 to enable (dev only)".into(),
            inner:   None,
        });
    }
    // Target must be a real user — clean 404 rather than minting a
    // session pointing at a non-existent RID.
    let user = db::find_user_by_id(&state.db, &body.user_id)
        .await?
        .ok_or_else(|| AppError::not_found("not_found", "user not found"))?;

    let sid = db::create_session(&state.db, &user.redpash_id, SESSION_TTL_DAYS)
        .await?;

    let mut out = HeaderMap::new();
    out.insert(SET_COOKIE, HeaderValue::from_str(&session_cookie(&sid)).unwrap());
    Ok((out, StatusCode::NO_CONTENT).into_response())
}

// ─── cookie helpers ──────────────────────────────────────────────

fn session_cookie(sid: &str) -> String {
    // Max-Age matches SESSION_TTL_DAYS so the client cookie expires in
    // step with the DB row. `Secure` is OFF in dev (HTTP) — flip on
    // when the deployment lands behind HTTPS.
    format!(
        "{SESSION_COOKIE}={sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age={}",
        SESSION_TTL_DAYS * 24 * 3600,
    )
}

fn clear_cookie(name: &str) -> String {
    format!("{name}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0")
}

/// Read a single cookie value by name from the request headers.
/// Tolerates multiple `cookie` headers (some clients send them separately).
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

/// Percent-encode the small subset of OAuth URL params we send (just
/// the redirect URI and client ID — both controlled by us, so we only
/// need to handle space + colon + slash + ampersand + equals).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
