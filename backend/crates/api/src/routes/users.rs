//! Doc: docs/internal/code/backend/api/routes/users.md
//! `/api/users` — user directory.
//!
//! Powers the Objects page's owner-reassignment picker and the Users
//! tab. Single-tenant for now: returns every user.
//!
//! Endpoints:
//!   GET    /api/users          list every user (incl. memberships)
//!   POST   /api/users          create a user (dev tool — no email gate)
//!   PATCH  /api/users/:rid     sparse metadata update
//!   DELETE /api/users/:rid     delete a user (cascades sessions /
//!                              memberships / owned projects)
//!
//! All four are dev-permissive — any authenticated user can read /
//! create / patch / delete any user. Tighten before multi-tenant prod.

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use shared::user::UserProfile;

use crate::{db, error::AppError, id, state::AppState};

#[derive(Serialize)]
struct UserList { items: Vec<UserProfile> }

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/",     get(list).post(create))
        .route("/:rid", get(get_one).patch(patch).delete(delete_one))
}

async fn list(
    State(state): State<AppState>,
    headers:      HeaderMap,
) -> Result<Json<UserList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    // See-down scope: platform admins see every user; everyone else sees the
    // caller + users sharing a company with them (CAS_AF2690C0, step-3).
    let viewer = if crate::rbac::is_platform_admin(&state, &user).await? { None } else { Some(user.as_str()) };
    let items = db::list_users(&state.db, viewer)
        .await?;
    Ok(Json(UserList { items }))
}

#[derive(Deserialize)]
struct CreateUserBody {
    username:     String,
    display_name: String,
    #[serde(default)] email:      Option<String>,
    #[serde(default)] first_name: Option<String>,
    #[serde(default)] last_name:  Option<String>,
    /// Optional avatar URL at create. Same field as `PatchUserBody`
    /// at L109; pre-seating it saves a follow-up PATCH right after
    /// signup. The FE Users modal exposes this so admins can paste a
    /// URL when filing a fresh user.
    #[serde(default)] avatar_url: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Json(body):   Json<CreateUserBody>,
) -> Result<Json<UserProfile>, AppError> {
    let caller = super::resolve_user_rid(&state, &headers).await?;
    let username     = body.username.trim();
    let display_name = body.display_name.trim();
    if username.is_empty() || display_name.is_empty() {
        return Err(AppError::bad_request("invalid", "username and display_name are required"));
    }
    let email      = body.email.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let first_name = body.first_name.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let last_name  = body.last_name.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let avatar_url = body.avatar_url.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let rid   = id::new("USR");
    let res   = db::insert_user(&state.db, &rid, username, display_name, email, first_name, last_name, avatar_url).await;
    match res {
        Ok(u) => {
            crate::event::info(&state.db, "user_create", format!("created user {username}"))
                .user(caller)
                .context(serde_json::json!({ "user": rid, "username": username }))
                .send();
            Ok(Json(u))
        }
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("23505") => {
            Err(AppError::conflict("username_taken", "username already in use"))
        }
        Err(e) => Err(AppError::internal("db", e.to_string())),
    }
}

async fn get_one(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<UserProfile>, AppError> {
    // AUTH-AUDIT-ACK: admin surface dev-permissive per [[redpash-stage]];
    // gate at RBAC (route /admin/users + role check)
    super::resolve_user_rid(&state, &headers).await?;
    let u = db::find_user_by_id(&state.db, &rid)
        .await?
        .ok_or_else(|| AppError::not_found("not_found", format!("user {rid}")))?;
    Ok(Json(u))
}

#[derive(Deserialize)]
struct PatchUserBody {
    #[serde(default)] display_name: Option<String>,
    #[serde(default)] first_name:   Option<String>,
    #[serde(default)] last_name:    Option<String>,
    #[serde(default)] username:     Option<String>,
    #[serde(default)] email:        Option<String>,
    #[serde(default)] plan:         Option<String>,
    #[serde(default)] avatar_url:   Option<String>,
    #[serde(default)] job_title:    Option<String>,
    #[serde(default)] organisation: Option<String>,
    #[serde(default)] use_case:     Option<String>,
    #[serde(default)] locale:       Option<String>,
}

async fn patch(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<PatchUserBody>,
) -> Result<Json<UserProfile>, AppError> {
    // AUTH-AUDIT-ACK: admin surface dev-permissive per [[redpash-stage]];
    // gate at RBAC (sibling get_one + delete_one share the dev-stage policy)
    let caller = super::resolve_user_rid(&state, &headers).await?;
    let trim = |o: Option<String>| o.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let display_name = trim(body.display_name);
    let first_name   = trim(body.first_name);
    let last_name    = trim(body.last_name);
    let username     = trim(body.username);
    let email        = trim(body.email);
    let plan         = trim(body.plan);
    let avatar_url   = trim(body.avatar_url);
    let job_title    = trim(body.job_title);
    let organisation = trim(body.organisation);
    let use_case     = trim(body.use_case);
    let locale       = trim(body.locale);
    let mut fields: Vec<&str> = Vec::new();
    if display_name.is_some() { fields.push("display_name"); }
    if first_name.is_some()   { fields.push("first_name");   }
    if last_name.is_some()    { fields.push("last_name");    }
    if username.is_some()     { fields.push("username");     }
    if email.is_some()        { fields.push("email");        }
    if plan.is_some()         { fields.push("plan");         }
    if avatar_url.is_some()   { fields.push("avatar_url");   }
    if job_title.is_some()    { fields.push("job_title");    }
    if organisation.is_some() { fields.push("organisation"); }
    if use_case.is_some()     { fields.push("use_case");     }
    if locale.is_some()       { fields.push("locale");       }
    let res = db::update_user(
        &state.db, &rid,
        display_name.as_deref(),
        username.as_deref(),
        email.as_deref(),
        plan.as_deref(),
        avatar_url.as_deref(),
        job_title.as_deref(),
        organisation.as_deref(),
        use_case.as_deref(),
        locale.as_deref(),
        first_name.as_deref(),
        last_name.as_deref(),
    ).await;
    match res {
        Ok(opt) => {
            let user = opt.ok_or_else(|| AppError::not_found("not_found", format!("user {rid}")))?;
            crate::event::info(&state.db, "user_update", format!("updated user {rid}"))
                .user(caller)
                .context(serde_json::json!({ "user": rid, "fields": fields }))
                .send();
            Ok(Json(user))
        }
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("23505") => {
            Err(AppError::conflict("username_taken", "username already in use"))
        }
        Err(e) => Err(AppError::internal("db", e.to_string())),
    }
}

async fn delete_one(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    // AUTH-AUDIT-ACK: admin surface dev-permissive per [[redpash-stage]];
    // gate at RBAC (admin-role check + self-delete protection)
    let caller = super::resolve_user_rid(&state, &headers).await?;

    // Scrub-retain (CAS_46BA67713EC84871991D3E7475598B47): hard DELETE was
    // CASCADEing every membership and silently erasing audit history.
    // Step 1 — block if user is sole owner of any object so we don't
    // strand companies/projects without an owner. Returns 409 with the
    // blocking rid list so the UI can surface "transfer these first".
    let blocking = db::user_sole_owner_objects(&state.db, &rid).await?;
    if !blocking.is_empty() {
        return Err(AppError::conflict(
            "sole_owner_blocker",
            format!(
                "cannot scrub: user is sole owner of {} object(s); transfer ownership first",
                blocking.len()
            ),
        ));
    }
    // Steps 2-4: teams memberships out, sessions + prefs out, PII null +
    // display_name='Deleted User' + status='archived'. Single tx.
    let scrubbed = db::scrub_user_tx(&state.db, &rid).await?;
    if !scrubbed {
        return Err(AppError::not_found("not_found", format!("user {rid}")));
    }
    crate::event::warn(&state.db, "user_scrub", format!("scrubbed user {rid}"))
        .user(caller)
        .context(serde_json::json!({ "user": rid }))
        .send();
    Ok(Json(serde_json::json!({ "ok": true, "scrubbed": true })))
}
