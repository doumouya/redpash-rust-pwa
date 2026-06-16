//! Purpose: the db helper layer — registry-first invariants made functions.
//! Non-macro sqlx throughout (the crate builds without a live DATABASE_URL).
//!
//! Invariants enforced here, not in handlers:
//!   - register the entity FIRST, in the same tx as the subtype insert;
//!   - delete THROUGH the registry (entities row), cascade does the rest;
//!   - every created object auto-grants its creator an owner membership
//!     ("there is no object without an owner").

use sqlx::{PgPool, Postgres, Transaction};

use crate::id;

#[derive(Debug, Clone, serde::Serialize)]
pub struct User {
    pub redpash_id: String,
    pub username: Option<String>,
    pub email: Option<String>,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub role: String,
    pub default_project_id: Option<String>,
}

const USER_SELECT: &str = "SELECT redpash_id, username, email, display_name, avatar_url, role,
                           default_project_id FROM users";

type UserRow = (String, Option<String>, Option<String>, String, Option<String>, String, Option<String>);

fn user_from(r: UserRow) -> User {
    User {
        redpash_id: r.0,
        username: r.1,
        email: r.2,
        display_name: r.3,
        avatar_url: r.4,
        role: r.5,
        default_project_id: r.6,
    }
}

// ─── entities ──────────────────────────────────────────────────────────────

/// Registry-row-first, same tx as the subtype insert.
pub async fn register_entity(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    type_id: &str,
) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO entities (id, type) VALUES ($1, $2)")
        .bind(id)
        .bind(type_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// THE delete path — through the registry; FK cascade clears the subtype row,
/// memberships, and everything downstream.
pub async fn delete_entity(pool: &PgPool, id: &str) -> sqlx::Result<bool> {
    let res = sqlx::query("DELETE FROM entities WHERE id = $1").bind(id).execute(pool).await?;
    Ok(res.rows_affected() > 0)
}

/// Objects a user is the SOLE owner of (an owner edge with no OTHER owner). A
/// user must not be scrubbed while this is non-empty — else those objects strand
/// without an owner (the "no object without an owner" invariant, enforced at
/// DELETE time, not just create).
pub async fn user_sole_owner_objects(pool: &PgPool, user_rid: &str) -> sqlx::Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT m1.object_redpash_id
         FROM memberships m1
         WHERE m1.member_redpash_id = $1 AND m1.role = 'owner'
           -- the user's PERSONAL default project is disposed WITH them on scrub
           -- (not transferred), so it must never block — else no real user, who
           -- always solely owns their auto-created default project, is scrubbable.
           AND m1.object_redpash_id IS DISTINCT FROM
               (SELECT default_project_id FROM users WHERE redpash_id = $1)
           AND NOT EXISTS (
             SELECT 1 FROM memberships m2
             WHERE m2.object_redpash_id = m1.object_redpash_id
               AND m2.member_redpash_id <> $1
               AND m2.role = 'owner')",
    )
    .bind(user_rid)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(rid,)| rid).collect())
}

/// SCRUB-RETAIN a user — the delete path for users. A hard DELETE would CASCADE
/// their membership edges (stranding sole-owned objects) and erase audit history,
/// so instead we anonymize + RETAIN. The caller MUST have checked
/// `user_sole_owner_objects` first. One tx: leave every team/department, kill
/// sessions + per-user settings, null PII + mark archived as "Deleted User". The
/// user row, co-owner/member edges, and audit history are retained.
pub async fn scrub_user_tx(pool: &PgPool, rid: &str) -> sqlx::Result<bool> {
    let mut tx = pool.begin().await?;
    // Dispose the user's PERSONAL default project (+ its files/steps) IF they
    // solely own it — it's their private workspace, removed with them. The FK
    // users.default_project_id is ON DELETE SET NULL, so the column self-clears.
    sqlx::query(
        "DELETE FROM entities WHERE id = (SELECT default_project_id FROM users WHERE redpash_id = $1)
           AND NOT EXISTS (
             SELECT 1 FROM memberships m
             WHERE m.object_redpash_id = (SELECT default_project_id FROM users WHERE redpash_id = $1)
               AND m.member_redpash_id <> $1 AND m.role = 'owner')",
    )
    .bind(rid)
    .execute(&mut *tx)
    .await?;
    // Leave every team/department (team rids are TEM_*); co-ownership on SHARED
    // projects/files is retained (those objects keep their other owner).
    sqlx::query(
        "DELETE FROM memberships WHERE member_redpash_id = $1 AND object_redpash_id LIKE 'TEM_%'",
    )
    .bind(rid)
    .execute(&mut *tx)
    .await?;
    // Auth out + EVERY per-user store out. The avoided hard-DELETE cascade used to
    // clear these; scrub-retain keeps the user row, so they must be cleared here.
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(rid).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM settings WHERE scope_type = 'user' AND scope_id = $1")
        .bind(rid)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM user_preferences WHERE user_id = $1").bind(rid).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM user_sentinels WHERE user_id = $1").bind(rid).execute(&mut *tx).await?;
    // Null PII, retain the identity row (archived "Deleted User"). `status <>
    // 'archived'` makes a re-scrub a no-op (rows_affected 0 → the caller 404s and
    // the audit event isn't re-emitted).
    let n = sqlx::query(
        "UPDATE users SET email = NULL, google_sub = NULL, username = NULL, avatar_url = NULL,
                          display_name = 'Deleted User', status = 'archived'
         WHERE redpash_id = $1 AND status <> 'archived'",
    )
    .bind(rid)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(n.rows_affected() > 0)
}

/// Auto-grant: creator gets the owner edge in the same tx as the create.
pub async fn grant_owner(
    tx: &mut Transaction<'_, Postgres>,
    object: &str,
    member: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO memberships (object_redpash_id, member_redpash_id, role)
         VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING",
    )
    .bind(object)
    .bind(member)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

// ─── users ─────────────────────────────────────────────────────────────────

pub async fn find_user_by_id(pool: &PgPool, rid: &str) -> sqlx::Result<Option<User>> {
    let row: Option<UserRow> = sqlx::query_as(&format!("{USER_SELECT} WHERE redpash_id = $1"))
        .bind(rid)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(user_from))
}

/// Upsert by Google `sub` — never email (sub is stable across email changes;
/// one sub = one RedPash user, no account linking). New users get their
/// entity row first (registry invariant).
pub async fn upsert_google_user(
    pool: &PgPool,
    sub: &str,
    email: &str,
    display_name: &str,
    avatar_url: Option<&str>,
) -> sqlx::Result<User> {
    let mut tx = pool.begin().await?;
    let existing: Option<UserRow> =
        sqlx::query_as(&format!("{USER_SELECT} WHERE google_sub = $1"))
            .bind(sub)
            .fetch_optional(&mut *tx)
            .await?;
    let user = match existing {
        Some(row) => {
            let u = user_from(row);
            sqlx::query(
                "UPDATE users SET email = $2, display_name = $3, avatar_url = $4
                 WHERE redpash_id = $1",
            )
            .bind(&u.redpash_id)
            .bind(email)
            .bind(display_name)
            .bind(avatar_url)
            .execute(&mut *tx)
            .await?;
            User {
                email: Some(email.to_string()),
                display_name: display_name.to_string(),
                avatar_url: avatar_url.map(str::to_string),
                ..u
            }
        }
        None => {
            let rid = id::new("USR");
            register_entity(&mut tx, &rid, "user").await?;
            let username = email.split('@').next().unwrap_or("user").to_string();
            sqlx::query(
                "INSERT INTO users (redpash_id, google_sub, email, username, display_name, avatar_url)
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(&rid)
            .bind(sub)
            .bind(email)
            .bind(&username)
            .bind(display_name)
            .bind(avatar_url)
            .execute(&mut *tx)
            .await?;
            User {
                redpash_id: rid,
                username: Some(username),
                email: Some(email.to_string()),
                display_name: display_name.to_string(),
                avatar_url: avatar_url.map(str::to_string),
                role: "user".into(),
                default_project_id: None,
            }
        }
    };
    tx.commit().await?;
    Ok(user)
}

/// First-admin claim (replaces the predecessor's REDPASH_BOOTSTRAP_ADMINS env
/// escape hatch). Atomic: succeeds only while NO admin exists, so exactly one
/// caller can ever win the race — after that it is a normal admin-grants-admin
/// flow through the admin surface.
pub async fn claim_first_admin(pool: &PgPool, rid: &str) -> sqlx::Result<bool> {
    let res = sqlx::query(
        "UPDATE users SET role = 'admin'
         WHERE redpash_id = $1
           AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')",
    )
    .bind(rid)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Insert a project + its full registry spine inside an OPEN tx: the entity
/// row, the `projects` subtype row, and the creator's owner grant. The shared
/// core of `create_project` (own tx) and `ensure_default_project` (which sets
/// the same project as the user's default in the SAME tx, so create+default
/// stay atomic). Private — every project is born through one of those two.
/// Returns the new project's `(rid, created_at)` — created_at lets `create_project`
/// hand back the full `projects.rs` list-item shape without a re-fetch.
async fn insert_project(
    tx: &mut Transaction<'_, Postgres>,
    owner_rid: &str,
    name: &str,
) -> sqlx::Result<(String, chrono::DateTime<chrono::Utc>)> {
    let pid = id::new("PRJ");
    register_entity(tx, &pid, "project").await?;
    let created_at: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("INSERT INTO projects (redpash_id, name) VALUES ($1, $2) RETURNING created_at")
            .bind(&pid)
            .bind(name)
            .fetch_one(&mut **tx)
            .await?;
    grant_owner(tx, &pid, owner_rid).await?;
    Ok((pid, created_at))
}

/// Create a new project owned by `owner_rid`. A project is a top-level
/// container — any caller may create one (the same baseline capability that
/// gives every user a default project); the creator becomes its owner via
/// `grant_owner`. Exercises both spines: entity registry + owner auto-grant.
/// Returns `(rid, created_at)`.
pub async fn create_project(
    pool: &PgPool,
    owner_rid: &str,
    name: &str,
) -> sqlx::Result<(String, chrono::DateTime<chrono::Utc>)> {
    let mut tx = pool.begin().await?;
    let out = insert_project(&mut tx, owner_rid, name).await?;
    tx.commit().await?;
    Ok(out)
}

/// Every user needs a default project (uploads land there when unspecified).
/// Idempotent; create + set-as-default share one tx so a crash never strands a
/// project that isn't yet anyone's default.
pub async fn ensure_default_project(pool: &PgPool, user_rid: &str) -> sqlx::Result<String> {
    if let Some(Some(pid)) =
        sqlx::query_scalar::<_, Option<String>>("SELECT default_project_id FROM users WHERE redpash_id = $1")
            .bind(user_rid)
            .fetch_optional(pool)
            .await?
    {
        return Ok(pid);
    }
    let mut tx = pool.begin().await?;
    let (pid, _) = insert_project(&mut tx, user_rid, "My project").await?;
    sqlx::query("UPDATE users SET default_project_id = $2 WHERE redpash_id = $1")
        .bind(user_rid)
        .bind(&pid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(pid)
}

// ─── sessions ──────────────────────────────────────────────────────────────

pub async fn create_session(pool: &PgPool, user_rid: &str, ttl_days: i64) -> sqlx::Result<String> {
    let sid = id::new("SES");
    sqlx::query(
        "INSERT INTO sessions (id, user_id, expires_at)
         VALUES ($1, $2, now() + make_interval(days => $3::int))",
    )
    .bind(&sid)
    .bind(user_rid)
    .bind(ttl_days as i32)
    .execute(pool)
    .await?;
    Ok(sid)
}

/// User rid for a live session; expired rows self-delete on read.
pub async fn find_session_user(pool: &PgPool, sid: &str) -> sqlx::Result<Option<String>> {
    let row: Option<(String, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as("SELECT user_id, expires_at FROM sessions WHERE id = $1")
            .bind(sid)
            .fetch_optional(pool)
            .await?;
    let Some((user_rid, expires_at)) = row else { return Ok(None) };
    if expires_at < chrono::Utc::now() {
        let _ = sqlx::query("DELETE FROM sessions WHERE id = $1").bind(sid).execute(pool).await;
        return Ok(None);
    }
    Ok(Some(user_rid))
}

pub async fn delete_session(pool: &PgPool, sid: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM sessions WHERE id = $1").bind(sid).execute(pool).await?;
    Ok(())
}

// ─── files ───────────────────────────────────────────────────────────────
// NOTE: there is deliberately NO public `insert_file` here. Creating a
// project_files row is sealed inside pipeline::upload_csv (the ONE write
// path) — day-one: every producer inherits RBAC + audit + scoring, and the
// bypass the predecessor's connectors hit is impossible by visibility, not
// convention.

#[derive(Debug, Clone)]
pub struct FileMeta {
    pub redpash_id: String,
    pub project_id: String,
    pub filename: String,
    pub file_type: String,
    pub storage_path: String,
    pub row_count: Option<i64>,
    pub col_count: Option<i32>,
    pub cleanness_pct: Option<f32>,
}

pub async fn find_file(pool: &PgPool, rid: &str) -> sqlx::Result<Option<FileMeta>> {
    let row: Option<(String, String, String, String, String, Option<i64>, Option<i32>, Option<f32>)> =
        sqlx::query_as(
            "SELECT redpash_id, project_id, filename, file_type, storage_path,
                    row_count, col_count, cleanness_pct
             FROM project_files WHERE redpash_id = $1",
        )
        .bind(rid)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| FileMeta {
        redpash_id: r.0,
        project_id: r.1,
        filename: r.2,
        file_type: r.3,
        storage_path: r.4,
        row_count: r.5,
        col_count: r.6,
        cleanness_pct: r.7,
    }))
}

/// The other CSV data files in a project (for join detection) — (rid, filename),
/// excluding `exclude_rid`.
pub async fn project_csv_files(
    pool: &PgPool,
    project: &str,
    exclude_rid: &str,
) -> sqlx::Result<Vec<(String, String)>> {
    sqlx::query_as(
        "SELECT redpash_id, filename FROM project_files
         WHERE project_id = $1 AND file_type = 'csv' AND redpash_id <> $2
         ORDER BY created_at",
    )
    .bind(project)
    .bind(exclude_rid)
    .fetch_all(pool)
    .await
}

/// Re-derive row/col counts + cleanness after a step changes the frame. The
/// columns_meta JSONB is refreshed too so the client's edit-mode cache stays
/// accurate. NOT a read-path side effect — only called on explicit mutations.
pub async fn update_file_stats(
    pool: &PgPool,
    rid: &str,
    rows: i64,
    cols: i32,
    cleanness: Option<f32>,
    columns_meta: &serde_json::Value,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE project_files SET row_count = $2, col_count = $3, cleanness_pct = $4,
         columns_meta = $5 WHERE redpash_id = $1",
    )
    .bind(rid)
    .bind(rows)
    .bind(cols)
    .bind(cleanness)
    .bind(columns_meta)
    .execute(pool)
    .await?;
    Ok(())
}

// ─── steps ─────────────────────────────────────────────────────────────────

/// The applied steps for a file, in order — the hydrate path replays these
/// over the base CSV.
pub async fn applied_steps(pool: &PgPool, file: &str) -> sqlx::Result<Vec<shared::Step>> {
    let rows: Vec<(String, serde_json::Value)> = sqlx::query_as(
        "SELECT kind, params FROM project_steps
         WHERE file_id = $1 AND applied ORDER BY ordinal",
    )
    .bind(file)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(kind, params)| shared::Step { kind, params }).collect())
}

/// Append a step. New steps drop any redo stack (rows after the current max
/// applied ordinal that are not applied), then take the next ordinal.
pub async fn add_step(
    pool: &PgPool,
    file: &str,
    kind: &str,
    params: &serde_json::Value,
    cleanness: Option<f32>,
) -> sqlx::Result<String> {
    // Single-step commit = a one-element batch. Returns its id.
    let ids = add_steps(pool, file, &[(kind.to_string(), params.clone(), cleanness)]).await?;
    Ok(ids.into_iter().next().expect("add_steps yields one id per step"))
}

/// Commit a batch of steps as ONE atomic gesture: drop the redo stack once, then
/// INSERT all N at sequential ordinals in a single transaction. Either every step
/// lands or none does — the all-or-nothing Save the staging buffer wants, vs N
/// separate add_step calls that can leave a partial commit on a mid-chain failure.
/// Each tuple carries the cleanness AS OF that step (genesis = the upload baseline
/// at ordinal 0); the log of these is the score trajectory. Returns the new ids.
pub async fn add_steps(
    pool: &PgPool,
    file: &str,
    steps: &[(String, serde_json::Value, Option<f32>)],
) -> sqlx::Result<Vec<String>> {
    let mut tx = pool.begin().await?;
    // Drop the redo stack ONCE for the whole gesture: un-applied rows are now unreachable.
    sqlx::query("DELETE FROM project_steps WHERE file_id = $1 AND NOT applied")
        .bind(file)
        .execute(&mut *tx)
        .await?;
    let mut next: i32 = sqlx::query_scalar(
        "SELECT coalesce(max(ordinal), -1) + 1 FROM project_steps WHERE file_id = $1",
    )
    .bind(file)
    .fetch_one(&mut *tx)
    .await?;
    let mut ids = Vec::with_capacity(steps.len());
    for (kind, params, cleanness) in steps {
        let sid = id::new("STP");
        sqlx::query(
            "INSERT INTO project_steps (id, file_id, ordinal, kind, params, applied, cleanness)
             VALUES ($1, $2, $3, $4, $5, true, $6)",
        )
        .bind(&sid)
        .bind(file)
        .bind(next)
        .bind(kind)
        .bind(params)
        .bind(cleanness)
        .execute(&mut *tx)
        .await?;
        ids.push(sid);
        next += 1;
    }
    tx.commit().await?;
    Ok(ids)
}

/// Undo: un-apply the highest applied step (flip applied=false). Returns false
/// if there's nothing to undo. `kind <> 'original'` pins the genesis step (the
/// upload baseline) — keyed by IDENTITY, not a magic ordinal, so it is correct
/// for pre-migration files too (which have no genesis and whose first real step
/// sits at ordinal 0 — `ordinal >= 1` would have wrongly made it un-undoable).
/// The genesis is never un-applied, so it can't be swept into the redo-stack drop.
pub async fn undo_step(pool: &PgPool, file: &str) -> sqlx::Result<bool> {
    let res = sqlx::query(
        "UPDATE project_steps SET applied = false
         WHERE id = (SELECT id FROM project_steps WHERE file_id = $1 AND applied AND kind <> 'original'
                     ORDER BY ordinal DESC LIMIT 1)",
    )
    .bind(file)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Redo: re-apply the lowest un-applied step. Returns false if nothing to redo.
pub async fn redo_step(pool: &PgPool, file: &str) -> sqlx::Result<bool> {
    let res = sqlx::query(
        "UPDATE project_steps SET applied = true
         WHERE id = (SELECT id FROM project_steps WHERE file_id = $1 AND NOT applied
                     ORDER BY ordinal ASC LIMIT 1)",
    )
    .bind(file)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}
