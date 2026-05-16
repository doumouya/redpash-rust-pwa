//! `/api/me` — current user profile.
//!
//! Resolution order:
//!   1. If an `rp_session` cookie is present and resolves to a valid
//!      session, return that user.
//!   2. Otherwise, when OAuth is *not* configured (dev mode), fall
//!      back to the bootstrap `state.dev_user`.
//!   3. When OAuth *is* configured but no valid session is present,
//!      return 401 so the frontend can redirect to the landing page.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use shared::user::UserProfile;

use crate::{db, error::AppError, state::AppState};

/// The `/api/me` payload combines the profile DTO with session-scoped
/// context that the frontend needs at bootstrap time but doesn't
/// belong on a generic `UserProfile`. Today: `global_sentinels` — the
/// shared cleanness vocabulary that's been flagged by ≥2 users. The
/// Cleaner's Fix-invalid modal merges it with `prefs.learned_sentinels`
/// + this-session ad-hoc additions before scanning a file.
///
/// `#[serde(flatten)]` keeps the wire shape backward-compatible: every
/// `UserProfile` field appears at the top level alongside the new keys.
#[derive(Serialize)]
struct MeResponse {
    #[serde(flatten)]
    user:              UserProfile,
    /// Canonical (trim + lowercase) sentinels currently promoted to
    /// the shared vocabulary. Sorted ascending for stable diffs.
    global_sentinels:  Vec<String>,
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/", get(get_me).patch(patch_me))
}

async fn get_me(
    State(state): State<AppState>,
    headers:      HeaderMap,
) -> Result<Json<MeResponse>, AppError> {
    let user_rid = resolve_user_rid(&state, &headers).await?;
    let user = db::find_user_by_id(&state.db, &user_rid)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?
        .ok_or_else(|| AppError::not_found("not_found", "current user not found"))?;
    let global_sentinels = db::list_global_sentinels(&state.db).await
        .map_err(|e| AppError::internal("db", e.to_string()))?;
    Ok(Json(MeResponse { user, global_sentinels }))
}

/// `PATCH /api/me` — sparse profile update. Every field is optional;
/// `prefs` is shallow-merged with the existing JSONB, so callers can
/// flip one key (`{"prefs":{"accent":"#ff0000"}}`) without
/// re-sending the whole object.
#[derive(Deserialize)]
struct PatchMeBody {
    #[serde(default)] display_name: Option<String>,
    #[serde(default)] job_title:    Option<String>,
    #[serde(default)] organisation: Option<String>,
    #[serde(default)] use_case:     Option<String>,
    #[serde(default)] locale:       Option<String>,
    #[serde(default)] prefs:        Option<serde_json::Value>,
}

async fn patch_me(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Json(body):   Json<PatchMeBody>,
) -> Result<Json<UserProfile>, AppError> {
    let user_rid = resolve_user_rid(&state, &headers).await?;

    // Snapshot the prior learned_sentinels so we can diff after the
    // shallow-merge and surface only the *new* additions to the
    // shared submissions table. Worst case (lookup race / new user)
    // the prior set is empty and we treat every entry as new.
    let prior_learned = db::find_user_by_id(&state.db, &user_rid).await
        .map_err(|e| AppError::internal("db", e.to_string()))?
        .and_then(|u| canon_str_array(u.prefs.get("learned_sentinels")))
        .unwrap_or_default();

    let user = db::update_user(
        &state.db,
        &user_rid,
        body.display_name.as_deref(),
        None, // username — /me doesn't expose
        None, // email — managed by OAuth flow, not user-editable here
        None, // plan — billing-only, not user-editable
        None, // avatar_url — managed by OAuth/upload, not user-editable here
        body.job_title.as_deref(),
        body.organisation.as_deref(),
        body.use_case.as_deref(),
        body.locale.as_deref(),
        body.prefs.as_ref(),
    )
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?
    .ok_or_else(|| AppError::not_found("not_found", "current user not found"))?;

    // Server-side enforcement of the sharing contract: a submission
    // only joins the shared `sentinel_submissions` table when the user
    // has explicitly consented (`prefs.share_sentinels === true`). We
    // never trust the client to do the right thing here — it could
    // skip the consent dialog and still PATCH learned_sentinels; the
    // gate has to live here.
    let share: bool = user.prefs.get("share_sentinels")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if share {
        let after = canon_str_array(user.prefs.get("learned_sentinels")).unwrap_or_default();
        let prior_set: std::collections::HashSet<&String> = prior_learned.iter().collect();
        for canonical in after.iter().filter(|s| !prior_set.contains(s)) {
            if let Err(e) = db::record_sentinel_submission(&state.db, canonical, &user_rid).await {
                // Don't fail the PATCH if a submission write fails —
                // the user's personal pref still landed, and the
                // global signal is best-effort. Log + carry on.
                tracing::warn!(error = %e, canonical, "sentinel_submissions insert failed (non-fatal)");
            }
        }
    }

    Ok(Json(user))
}

/// Coerce a `prefs.learned_sentinels` JSON value into a deduped Vec
/// of canonical (trimmed + lowercased + non-empty) strings. Non-array
/// or mixed-type input yields `None` so the caller falls back to
/// "no prior learned set".
fn canon_str_array(v: Option<&serde_json::Value>) -> Option<Vec<String>> {
    let arr = v?.as_array()?;
    let mut out: Vec<String> = arr.iter()
        .filter_map(|x| x.as_str().map(|s| s.trim().to_ascii_lowercase()))
        .filter(|s| !s.is_empty())
        .collect();
    out.sort();
    out.dedup();
    Some(out)
}

/// Pick which user the request is for. Shared by `/api/me` today;
/// Phase 4b will adopt it across every owner-scoped endpoint.
pub async fn resolve_user_rid(state: &AppState, headers: &HeaderMap) -> Result<String, AppError> {
    if let Some(sid) = super::read_cookie(headers, "rp_session") {
        if let Some(uid) = db::find_session_user(&state.db, &sid)
            .await
            .map_err(|e| AppError::internal("db", e.to_string()))?
        {
            return Ok(uid);
        }
    }
    // No session — OAuth disabled means dev mode (fall back). OAuth
    // enabled means the user must sign in.
    if state.oauth.is_some() {
        return Err(AppError {
            status:  StatusCode::UNAUTHORIZED,
            kind:    "unauthenticated",
            message: "no session cookie".into(),
        });
    }
    Ok(state.dev_user.as_ref().clone())
}
