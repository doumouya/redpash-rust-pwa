//! Purpose: the `/api/channels` + `/api/messages` surface — the messaging MVP
//! (global chat POC, P1). A channel is a scoped ENTITY (membership = who's in); a
//! message is an entity scoped to its channel; a DM is a 2-member channel.
//!
//! Reach is by MEMBERSHIP ON THE CHANNEL (`channel.scope_parents = []`), so a DM
//! stays private to its two users — NOT company-visible. A message inherits reach
//! from its channel (`message.scope_parents = ["channel_id"]`, the generated RBAC
//! cascade). So `require_action(channel, View)` = a member can read; `Edit` = a
//! member can post; admin bypasses for moderation.
//!
//! Bodies are RAW Markdown TEXT — there is NO server-side HTML sanitizer; the FE
//! renders through a safe md→html (never raw HTML), the same contract as
//! case_comments. Near-real-time is by POLLING: `GET /messages?after=<cursor>`.
//! Mirrors cases.rs (the dedicated-surface pattern): register_entity + grant_owner
//! + require_action + event, reusing the same RBAC + audit substrate.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    db,
    error::AppError,
    event, id,
    rbac::{self, Action, Caller},
    state::AppState,
};

pub fn channel_routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list_channels).post(create_channel))
        .route("/:rid/read", post(mark_read))
}

pub fn message_routes() -> Router<AppState> {
    Router::new().route("/", get(list_messages).post(post_message))
}

// ─── helpers ────────────────────────────────────────────────────────────────

/// Parse an optional ISO-8601 cursor → a clean 400 (never a raw cast 500).
fn parse_at(s: &str) -> Result<DateTime<Utc>, AppError> {
    DateTime::parse_from_rfc3339(s.trim())
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|_| AppError::bad_request("invalid_timestamp", "must be an ISO-8601 / RFC-3339 timestamp"))
}

/// The channel row as JSON, with the display NAME resolved: a `dm` shows the OTHER
/// member's display_name (a DM has no name of its own); a `channel` shows its name.
async fn fetch_channel(pool: &PgPool, rid: &str, caller_rid: &str) -> Result<Option<Value>, AppError> {
    let row: Option<(String, String, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT redpash_id, name, kind, created_at FROM channels WHERE redpash_id = $1",
    )
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    let Some((rid, name, kind, created_at)) = row else { return Ok(None) };
    let display = if kind == "dm" {
        sqlx::query_scalar::<_, String>(
            "SELECT u.display_name FROM memberships m JOIN users u ON u.redpash_id = m.member_redpash_id
              WHERE m.object_redpash_id = $1 AND m.member_redpash_id <> $2 LIMIT 1",
        )
        .bind(&rid)
        .bind(caller_rid)
        .fetch_optional(pool)
        .await?
        .filter(|s| !s.is_empty())
        .unwrap_or(name)
    } else {
        name
    };
    Ok(Some(json!({ "rid": rid, "name": display, "kind": kind, "created_at": created_at.to_rfc3339() })))
}

// ─── channels ─────────────────────────────────────────────────────────────────

/// GET /api/channels — the CALLER'S channels (reach = membership on the channel),
/// each with its last message + the caller's unread count. Always scoped to the
/// caller's own membership — even a platform admin sees only their channels here
/// (the personal sidebar must not surface everyone's DMs).
async fn list_channels(State(state): State<AppState>, caller: Caller) -> Result<Json<Value>, AppError> {
    let principals = rbac::principals(&state.db, &caller.rid).await?;
    let rows: Vec<(String, String, String, Option<String>, Option<DateTime<Utc>>, i64)> = sqlx::query_as(
        "SELECT c.redpash_id,
                CASE WHEN c.kind = 'dm' THEN COALESCE(
                       (SELECT u.display_name FROM memberships mm JOIN users u ON u.redpash_id = mm.member_redpash_id
                         WHERE mm.object_redpash_id = c.redpash_id AND mm.member_redpash_id <> $2 LIMIT 1), c.name)
                     ELSE c.name END AS display,
                c.kind,
                (SELECT m.body FROM messages m WHERE m.channel_id = c.redpash_id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
                (SELECT m.created_at FROM messages m WHERE m.channel_id = c.redpash_id ORDER BY m.created_at DESC LIMIT 1) AS last_at,
                (SELECT COUNT(*)::BIGINT FROM messages m
                   WHERE m.channel_id = c.redpash_id
                     AND m.created_at > COALESCE(
                         (SELECT r.last_read_at FROM channel_reads r WHERE r.channel_id = c.redpash_id AND r.user_id = $2),
                         'epoch'::timestamptz)) AS unread
           FROM channels c
          WHERE EXISTS (SELECT 1 FROM memberships m
                         WHERE m.member_redpash_id = ANY($1) AND m.object_redpash_id = c.redpash_id)
          ORDER BY last_at DESC NULLS LAST, c.created_at DESC",
    )
    .bind(principals.as_slice())
    .bind(&caller.rid)
    .fetch_all(&state.db)
    .await?;

    let items: Vec<Value> = rows
        .into_iter()
        .map(|(rid, name, kind, last, last_at, unread)| {
            json!({
                "rid": rid,
                "name": name,
                "kind": kind,
                "last_message": last,
                "last_at": last_at.map(|t| t.to_rfc3339()),
                "unread": unread,
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
struct CreateChannel {
    name: Option<String>,
    kind: String,
    #[serde(default)]
    member_ids: Vec<String>,
}

/// POST /api/channels {name?, kind, member_ids[]} — create a channel/DM. Any authed
/// caller may open one (global chat, v1). `kind:"dm"` is GET-or-create by the member
/// pair (returns the existing 1:1 channel, 200, if it exists). The creator owns it;
/// supplied members are added (`member`). Members must be real users (clean 400).
async fn create_channel(
    State(state): State<AppState>,
    caller: Caller,
    Json(body): Json<CreateChannel>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let kind = body.kind.trim();
    if kind != "channel" && kind != "dm" {
        return Err(AppError::bad_request("invalid_kind", "kind must be 'channel' or 'dm'"));
    }
    // Normalize members: trim, drop blanks + the caller (they're added as owner).
    let mut members: Vec<String> = body
        .member_ids
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && *s != caller.rid)
        .collect();
    members.sort();
    members.dedup();

    // Each member must exist — a clean 400 over a raw FK 500.
    for m in &members {
        let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM users WHERE redpash_id = $1")
            .bind(m)
            .fetch_optional(&state.db)
            .await?;
        if exists.is_none() {
            return Err(AppError::bad_request("invalid_member", format!("no such user {m}")));
        }
    }

    if kind == "dm" {
        if members.len() != 1 {
            return Err(AppError::bad_request("dm_members", "a dm needs exactly one other member"));
        }
        let other = &members[0];
        // GET-or-create: an existing dm whose membership set is EXACTLY {caller, other}.
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT c.redpash_id FROM channels c
              WHERE c.kind = 'dm'
                AND EXISTS (SELECT 1 FROM memberships m WHERE m.object_redpash_id = c.redpash_id AND m.member_redpash_id = $1)
                AND EXISTS (SELECT 1 FROM memberships m WHERE m.object_redpash_id = c.redpash_id AND m.member_redpash_id = $2)
                AND (SELECT COUNT(DISTINCT m.member_redpash_id) FROM memberships m WHERE m.object_redpash_id = c.redpash_id) = 2
              LIMIT 1",
        )
        .bind(&caller.rid)
        .bind(other)
        .fetch_optional(&state.db)
        .await?;
        if let Some(rid) = existing {
            let row = fetch_channel(&state.db, &rid, &caller.rid)
                .await?
                .ok_or_else(|| AppError::internal("messaging", "existing dm not found"))?;
            return Ok((StatusCode::OK, Json(row)));
        }
    }

    let name = body.name.as_deref().unwrap_or("").trim();
    let rid = id::new("CHN");
    let mut tx = state.db.begin().await?;
    db::register_entity(&mut tx, &rid, "channel").await?;
    sqlx::query("INSERT INTO channels (redpash_id, name, kind) VALUES ($1, $2, $3)")
        .bind(&rid)
        .bind(name)
        .bind(kind)
        .execute(&mut *tx)
        .await?;
    db::grant_owner(&mut tx, &rid, &caller.rid).await?;
    for m in &members {
        sqlx::query(
            "INSERT INTO memberships (object_redpash_id, member_redpash_id, role)
             VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
        )
        .bind(&rid)
        .bind(m)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    event::info(
        &state.db,
        "channel_create",
        format!("created {kind} {rid}"),
        Some(caller.rid.clone()),
        json!({ "channel": rid, "kind": kind }),
    );
    let row = fetch_channel(&state.db, &rid, &caller.rid)
        .await?
        .ok_or_else(|| AppError::internal("messaging", "created channel not found"))?;
    Ok((StatusCode::CREATED, Json(row)))
}

#[derive(Deserialize)]
struct ReadBody {
    at: Option<String>,
}

/// POST /api/channels/:rid/read {at?} — mark the channel read up to `at` (default
/// now). View reach. Upsert; GREATEST so a read-mark never moves backwards.
async fn mark_read(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
    Json(body): Json<ReadBody>,
) -> Result<StatusCode, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::View).await?;
    let at = match body.at.as_deref() {
        Some(s) => parse_at(s)?,
        None => Utc::now(),
    };
    sqlx::query(
        "INSERT INTO channel_reads (channel_id, user_id, last_read_at) VALUES ($1, $2, $3)
         ON CONFLICT (channel_id, user_id)
         DO UPDATE SET last_read_at = GREATEST(channel_reads.last_read_at, EXCLUDED.last_read_at)",
    )
    .bind(&rid)
    .bind(&caller.rid)
    .bind(at)
    .execute(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ─── messages ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct MessagesQuery {
    channel: String,
    after: Option<String>,
    limit: Option<i64>,
}

/// GET /api/messages?channel=:rid&after?=<iso>&limit=50 — a channel's messages,
/// ASCENDING. View reach on the channel (404 leak-free for a non-member, so a DM is
/// invisible to outsiders). `after` is the incremental polling cursor.
async fn list_messages(
    State(state): State<AppState>,
    caller: Caller,
    Query(q): Query<MessagesQuery>,
) -> Result<Json<Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &q.channel, Action::View).await?;
    let after = match q.after.as_deref() {
        Some(s) => Some(parse_at(s)?),
        None => None,
    };
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let items: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(m) FROM messages m
          WHERE m.channel_id = $1 AND ($2::timestamptz IS NULL OR m.created_at > $2)
          ORDER BY m.created_at ASC LIMIT $3",
    )
    .bind(&q.channel)
    .bind(after)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
struct PostMessage {
    channel_id: String,
    body: String,
}

/// POST /api/messages {channel_id, body} — post a message. Edit reach on the channel
/// (Member+). Body is raw Markdown text (rendered safe by the FE). Emits an event.
async fn post_message(
    State(state): State<AppState>,
    caller: Caller,
    Json(body): Json<PostMessage>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &body.channel_id, Action::Edit).await?;
    // A platform admin bypasses require_action's existence check → confirm the
    // channel exists before the FK insert (clean 404 over a 500).
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM channels WHERE redpash_id = $1")
        .bind(&body.channel_id)
        .fetch_optional(&state.db)
        .await?;
    if exists.is_none() {
        return Err(AppError::not_found("not_found", format!("channel {}", body.channel_id)));
    }
    let text = body.body.trim();
    if text.is_empty() {
        return Err(AppError::bad_request("empty_message", "message body is required"));
    }
    let rid = id::new("MSG");
    let mut tx = state.db.begin().await?;
    // A message is a registered entity scoped to its channel (no owner edge — reach
    // flows from channel membership via the cascade, not a per-message grant).
    db::register_entity(&mut tx, &rid, "message").await?;
    sqlx::query("INSERT INTO messages (redpash_id, channel_id, author_id, body) VALUES ($1, $2, $3, $4)")
        .bind(&rid)
        .bind(&body.channel_id)
        .bind(&caller.rid)
        .bind(text)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    event::info(
        &state.db,
        "message_post",
        format!("posted to channel {}", body.channel_id),
        Some(caller.rid.clone()),
        json!({ "channel": body.channel_id, "message": rid }),
    );
    let row: Value = sqlx::query_scalar("SELECT to_jsonb(m) FROM messages m WHERE m.redpash_id = $1")
        .bind(&rid)
        .fetch_one(&state.db)
        .await?;
    Ok((StatusCode::CREATED, Json(row)))
}
