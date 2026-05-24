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
    http::{header, HeaderMap, StatusCode},
    routing::{get, patch},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use shared::user::{PrefsPatch, UserProfile};

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
    Router::new()
        .route("/", get(get_me).patch(patch_me))
        .route("/prefs", patch(patch_me_prefs))
        .route("/avatar", get(get_avatar))
}

async fn get_me(
    State(state): State<AppState>,
    headers:      HeaderMap,
) -> Result<Json<MeResponse>, AppError> {
    let user_rid = resolve_user_rid(&state, &headers).await?;
    let mut user = db::find_user_by_id(&state.db, &user_rid)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?
        .ok_or_else(|| AppError::not_found("not_found", "current user not found"))?;
    // Hydrate company memberships so the Profile page can show the
    // user's real org affiliations (the editable `organisation`
    // field is a free-text bio, distinct from these).
    user.memberships = db::list_memberships_for_user(&state.db, &user_rid)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?;
    let global_sentinels = db::list_global_sentinels(&state.db).await
        .map_err(|e| AppError::internal("db", e.to_string()))?;
    Ok(Json(MeResponse { user, global_sentinels }))
}

/// `PATCH /api/me` — sparse profile update. Every field is optional.
///
/// **Prefs do NOT belong on this endpoint anymore** (migration 023 /
/// docs/internal/spec-user-preferences.md). The `prefs` field is kept
/// in the body shape for one release as a deprecation forward — when
/// set, it's routed to `patch_user_prefs` with a tracing warning so
/// any stragglers light up the log. Next release: 400 with
/// `deprecated_field` kind.
#[derive(Deserialize)]
struct PatchMeBody {
    #[serde(default)] display_name: Option<String>,
    #[serde(default)] first_name:   Option<String>,
    #[serde(default)] last_name:    Option<String>,
    #[serde(default)] job_title:    Option<String>,
    #[serde(default)] organisation: Option<String>,
    #[serde(default)] use_case:     Option<String>,
    #[serde(default)] locale:       Option<String>,
    /// DEPRECATED — use `PATCH /api/me/prefs` instead. Forwarded for
    /// one release; logged + dropped after.
    #[serde(default)] prefs:        Option<serde_json::Value>,
}

async fn patch_me(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Json(body):   Json<PatchMeBody>,
) -> Result<Json<UserProfile>, AppError> {
    let user_rid = resolve_user_rid(&state, &headers).await?;

    // Deprecation forward: any caller still putting `prefs` on
    // PATCH /api/me gets logged + routed to the proper endpoint.
    // The next release removes this branch and 400s instead.
    if let Some(patch) = body.prefs.as_ref() {
        tracing::warn!(
            user = %user_rid,
            "deprecated: prefs in PATCH /api/me — use PATCH /api/me/prefs",
        );
        apply_prefs_patch(&state, &user_rid, patch).await?;
    }

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
        body.first_name.as_deref(),
        body.last_name.as_deref(),
    )
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?
    .ok_or_else(|| AppError::not_found("not_found", "current user not found"))?;

    Ok(Json(user))
}

/// `PATCH /api/me/prefs` — sparse upsert into `user_preferences`.
/// Body: `{ prefs: { key: value, ... } }`. Only keys present in the
/// patch are written; unmentioned keys stay. JSONB values (scalars,
/// arrays, booleans) land verbatim. 204 on success.
///
/// Also enforces the share_sentinels gate (lifted from the prior
/// PATCH /api/me path): if the post-patch state has
/// `share_sentinels === true`, the *new* entries in learned_sentinels
/// are mirrored to `sentinel_submissions`. The gate lives here because
/// it has to live in the only write path; the client can't be trusted
/// to skip the consent dialog and still write learned_sentinels.
async fn patch_me_prefs(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Json(body):   Json<PrefsPatch>,
) -> Result<StatusCode, AppError> {
    let user_rid = resolve_user_rid(&state, &headers).await?;
    apply_prefs_patch(&state, &user_rid, &body.prefs).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Shared path between `PATCH /api/me/prefs` (canonical) and the
/// deprecated `PATCH /api/me` forward. Snapshots learned_sentinels
/// pre-patch, applies the upsert, then diffs to surface only *new*
/// entries when share_sentinels is on.
async fn apply_prefs_patch(
    state:    &AppState,
    user_rid: &str,
    patch:    &serde_json::Value,
) -> Result<(), AppError> {
    // Pre-patch snapshot — used to find newly-added entries below.
    // Worst case (lookup race / fresh user) the set is empty and
    // every entry is treated as new.
    let prior_learned = db::find_user_by_id(&state.db, user_rid).await
        .map_err(|e| AppError::internal("db", e.to_string()))?
        .and_then(|u| canon_str_array(u.prefs.get("learned_sentinels")))
        .unwrap_or_default();

    db::patch_user_prefs(&state.db, user_rid, patch).await
        .map_err(|e| AppError::internal("db", e.to_string()))?;

    // Post-patch read for the share_sentinels gate. We re-read the
    // full prefs (not just the patch) because share_sentinels may
    // have been set on a prior PATCH and learned_sentinels patched
    // on this one — both states need to land for the gate to fire.
    let after_user = db::find_user_by_id(&state.db, user_rid).await
        .map_err(|e| AppError::internal("db", e.to_string()))?
        .ok_or_else(|| AppError::not_found("not_found", "current user not found"))?;

    let share: bool = after_user.prefs.get("share_sentinels")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if share {
        let after = canon_str_array(after_user.prefs.get("learned_sentinels")).unwrap_or_default();
        let prior_set: std::collections::HashSet<&String> = prior_learned.iter().collect();
        for canonical in after.iter().filter(|s| !prior_set.contains(s)) {
            if let Err(e) = db::record_sentinel_submission(&state.db, canonical, user_rid).await {
                // Don't fail the PATCH if a submission write fails —
                // the user's personal pref still landed, the global
                // signal is best-effort. Log + carry on.
                tracing::warn!(error = %e, canonical, "sentinel_submissions insert failed (non-fatal)");
            }
        }
    }
    Ok(())
}

/// `GET /api/me/avatar` — server-side proxy for the current user's
/// OAuth avatar. Google's `lh3.googleusercontent.com` serves images
/// without permissive CORP headers, so Firefox blocks them as opaque
/// cross-origin resources (OBR) when used as a CSS `background-image`.
/// Proxying through our own origin sidesteps the issue and lets us
/// cache the bytes in-process.
///
/// 404 when the user has no avatar_url. 502 when the upstream fetch
/// fails or returns a non-image. Cached forever (until restart) on
/// the first successful hit; the cache key is the avatar URL itself
/// so a future avatar rotation triggers a fresh fetch.
async fn get_avatar(
    State(state): State<AppState>,
    headers:      HeaderMap,
) -> Result<([(header::HeaderName, String); 2], Vec<u8>), AppError> {
    let user_rid = resolve_user_rid(&state, &headers).await?;
    let user = db::find_user_by_id(&state.db, &user_rid)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?
        .ok_or_else(|| AppError::not_found("not_found", "current user not found"))?;
    let url = user.avatar_url
        .ok_or_else(|| AppError::not_found("no_avatar", "user has no avatar"))?;

    if let Some(entry) = state.avatars.get(&url) {
        let (bytes, ct) = entry.value();
        return Ok((
            [
                (header::CONTENT_TYPE, ct.clone()),
                (header::CACHE_CONTROL, "private, max-age=86400".to_string()),
            ],
            bytes.clone(),
        ));
    }

    let resp = state.http.get(&url).send().await
        .map_err(|e| AppError {
            status:  StatusCode::BAD_GATEWAY,
            kind:    "avatar_fetch_failed",
            message: e.to_string(),
        })?;
    if !resp.status().is_success() {
        return Err(AppError {
            status:  StatusCode::BAD_GATEWAY,
            kind:    "avatar_fetch_failed",
            message: format!("upstream returned {}", resp.status()),
        });
    }
    let content_type = resp.headers().get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    if !content_type.starts_with("image/") {
        return Err(AppError {
            status:  StatusCode::BAD_GATEWAY,
            kind:    "avatar_fetch_failed",
            message: format!("non-image content-type: {content_type}"),
        });
    }
    let bytes = resp.bytes().await
        .map_err(|e| AppError {
            status:  StatusCode::BAD_GATEWAY,
            kind:    "avatar_fetch_failed",
            message: e.to_string(),
        })?
        .to_vec();
    state.avatars.insert(url.clone(), (bytes.clone(), content_type.clone()));

    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "private, max-age=86400".to_string()),
        ],
        bytes,
    ))
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
