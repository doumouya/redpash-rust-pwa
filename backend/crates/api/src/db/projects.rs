//! Doc: docs/internal/code/backend/api/db/projects.md
//! `projects` table CRUD + the shared ProjectSummary SELECT.
//!
//! Slice 4 of the db/mod.rs decomposition. Holds:
//!
//!   - The `PROJECT_SELECT` constant — every reader joins through
//!     `users` for the owner display fields, folds in `file_stages`
//!     for the computed `stage`, and overlays a 'published' status
//!     when the project has a public dashboard. Spliced with a
//!     per-caller WHERE.
//!   - `row_to_project` — private row→DTO mapping; the only seam
//!     between raw `sqlx::postgres::PgRow` and `ProjectSummary`.
//!   - Default-project + named-project find-or-create helpers
//!     (`ensure_default_project`, `ensure_named_project`).
//!   - `list_projects`, `get_project`, `update_project_meta` (sparse
//!     COALESCE + transactional default-flip), `project_file_rids`
//!     (pre-cascade-delete prep), `delete_project` (with the default
//!     guard), `create_project` (transactional default-flip + insert).
//!
//! The `projects_owner_default_idx` partial unique index allows only
//! one default per owner; every write that touches `is_default = true`
//! pairs the insert/update with a transactional flip-off of any
//! existing default in the same tx.

use chrono::{DateTime, Utc};
use shared::project::ProjectSummary;
use sqlx::{PgPool, Row};

pub async fn find_default_project(pool: &PgPool, owner: &str) -> sqlx::Result<Option<String>> {
    // Default project moved off the project (is_default) onto the user.
    let row = sqlx::query("SELECT default_project_id FROM users WHERE redpash_id = $1")
        .bind(owner)
        .fetch_optional(pool)
        .await?;
    Ok(row.and_then(|r| r.get::<Option<String>, _>(0)))
}

pub async fn insert_project(pool: &PgPool, rid: &str, owner: &str, name: &str, is_default: bool) -> sqlx::Result<()> {
    // One tx: register the entity, insert the project, seat the owner as a
    // membership (ownership lives there now), and — if this is the user's
    // default — point users.default_project_id at it.
    let mut tx = pool.begin().await?;
    super::register_entity(&mut *tx, rid, "project").await?;
    sqlx::query("INSERT INTO projects (redpash_id, name) VALUES ($1, $2)")
        .bind(rid)
        .bind(name)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO memberships (object_redpash_id, member_redpash_id, role)
         VALUES ($1, $2, 'owner')",
    )
    .bind(rid)
    .bind(owner)
    .execute(&mut *tx)
    .await?;
    if is_default {
        sqlx::query("UPDATE users SET default_project_id = $2 WHERE redpash_id = $1")
            .bind(owner)
            .bind(rid)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Idempotent — returns the user's default project RID, creating it
/// if the user has none yet. Called on every Google sign-in so a
/// brand-new account lands with a usable workspace immediately.
pub async fn ensure_default_project(pool: &PgPool, owner: &str) -> sqlx::Result<String> {
    if let Some(rid) = find_default_project(pool, owner).await? {
        return Ok(rid);
    }
    let rid = crate::id::new("PRJ");
    insert_project(pool, &rid, owner, "Workspace", true).await?;
    Ok(rid)
}

/// Find a project by name within this owner's workspace. Returns the
/// first match (name is not unique today; could be made unique with a
/// partial index later). Case-sensitive match.
pub async fn find_project_by_name(pool: &PgPool, owner: &str, name: &str) -> sqlx::Result<Option<String>> {
    let row = sqlx::query(
        "SELECT p.redpash_id FROM projects p \
         JOIN memberships m ON m.object_redpash_id = p.redpash_id \
                           AND m.role = 'owner' AND m.member_redpash_id = $1 \
         WHERE p.name = $2 \
         ORDER BY p.created_at ASC LIMIT 1",
    )
    .bind(owner)
    .bind(name)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| r.get::<String, _>(0)))
}

/// Find-or-create a project under `owner` with the given name.
///
/// Called from the upload handler when the multipart payload carries a
/// `project_name` field (the workspace rail focuses a project before
/// upload). Without this, every upload would pool into the auto-created
/// default "Workspace" and the user couldn't split files into separate
/// projects. The matching is case-sensitive on `name`, so a fresh
/// capitalisation creates a new project. is_default stays false here so
/// the user's default-Workspace assignment isn't disturbed.
pub async fn ensure_named_project(pool: &PgPool, owner: &str, name: &str) -> sqlx::Result<String> {
    if let Some(rid) = find_project_by_name(pool, owner, name).await? {
        return Ok(rid);
    }
    let rid = crate::id::new("PRJ");
    insert_project(pool, &rid, owner, name, false).await?;
    Ok(rid)
}

// Shared SELECT for ProjectSummary — joins `users` for the owner's
// display_name / username. `{where}` is spliced per caller.
//
// `stage` is computed: the most advanced stage of any file in the
// project, aggregated from the `file_stages` view. `status` is
// DERIVED (precedence: published > archived > active > draft), not the
// raw stored column:
//   - 'published' when the project has a public dashboard,
//   - else 'archived' when the stored p.status is 'archived' — the one
//     lifecycle state that sticks (set via PATCH /projects; cleared by
//     the activity auto-unarchive in add_step),
//   - else 'active' when the project holds at least one (non-chart)
//     file — it's a real, in-use project,
//   - else 'draft' (empty / freshly-created, no files yet).
// The stored draft↔active distinction is content-derived now, so an
// in-use project reads 'active' without a manual edit (matches the
// original "open project = active" intent the old Objects page had).
//
// Owner now resolves through the owner-membership (role='owner') instead of
// the dropped `p.owner_id` column; `is_default` is derived from the owner's
// `users.default_project_id`. The owner LATERAL takes the earliest owner
// membership (deterministic; the app seats exactly one). INNER LATERAL is
// safe today — every project has an owner membership — until tombstoning can
// vacate ownership; at that point this becomes LEFT + `owner_id` Option<>.
//
// PROJECT-FILES-ACK: type=mixed — three project_files subqueries:
//   1) EXISTS dashboard rows for the 'published' overlay,
//   2) EXISTS any non-chart file for the 'active' derivation
//      (same predicate as file_count, so Files>0 ⟺ Active),
//   3) COUNT excluding charts for the user-facing file_count
//      (charts aren't surfaced as files in the rail).
const PROJECT_SELECT: &str =
    "SELECT p.redpash_id, p.name, p.description,
            COALESCE(u.default_project_id = p.redpash_id, false) AS is_default,
            om.member_redpash_id AS owner_id, p.company_id,
            (SELECT CASE COALESCE(MAX(fs.stage_rank), 0)
                      WHEN 3 THEN 'publish' WHEN 2 THEN 'design' WHEN 1 THEN 'clean'
                      ELSE 'new' END
             FROM file_stages fs WHERE fs.project_redpash_id = p.redpash_id) AS stage,
            CASE
              WHEN EXISTS (SELECT 1 FROM project_files d
                           WHERE d.project_redpash_id = p.redpash_id
                             AND d.file_type = 'dashboard' AND d.is_public)
                THEN 'published'
              WHEN p.status = 'archived' THEN 'archived'
              WHEN EXISTS (SELECT 1 FROM project_files f2
                           WHERE f2.project_redpash_id = p.redpash_id
                             AND f2.file_type <> 'chart')
                THEN 'active'
              ELSE 'draft'
            END AS status,
            p.created_at, p.updated_at,
            u.display_name AS owner_display_name, u.username AS owner_username,
            (SELECT COUNT(*) FROM project_files f
             WHERE f.project_redpash_id = p.redpash_id AND f.file_type <> 'chart') AS file_count
     FROM projects p
     JOIN LATERAL (SELECT m.member_redpash_id FROM memberships m
                   WHERE m.object_redpash_id = p.redpash_id AND m.role = 'owner'
                   ORDER BY m.joined_at LIMIT 1) om ON true
     JOIN users u ON u.redpash_id = om.member_redpash_id";

fn row_to_project(r: &sqlx::postgres::PgRow) -> ProjectSummary {
    ProjectSummary {
        redpash_id:         r.get("redpash_id"),
        name:               r.get("name"),
        description:        r.try_get("description").ok(),
        file_count:         r.try_get::<i64, _>("file_count").unwrap_or(0) as u32,
        cleanness_pct:      None,
        stage:              r.get("stage"),
        status:             r.get("status"),
        is_default:         r.get("is_default"),
        owner_id:           r.get("owner_id"),
        owner_display_name: r.get("owner_display_name"),
        owner_username:     r.get("owner_username"),
        company_id:         r.get("company_id"),
        created_at:         r.get::<DateTime<Utc>, _>("created_at"),
        updated_at:         r.get::<DateTime<Utc>, _>("updated_at"),
    }
}

pub async fn list_projects(pool: &PgPool, owner: &str) -> sqlx::Result<Vec<ProjectSummary>> {
    let rows = sqlx::query(
        // `om` (owner membership) + `is_default` (alias) come from PROJECT_SELECT.
        &format!("{PROJECT_SELECT} WHERE om.member_redpash_id = $1
                  ORDER BY is_default DESC, p.created_at ASC"),
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(row_to_project).collect())
}

pub async fn get_project(pool: &PgPool, rid: &str) -> sqlx::Result<Option<ProjectSummary>> {
    let row = sqlx::query(&format!("{PROJECT_SELECT} WHERE p.redpash_id = $1"))
        .bind(rid)
        .fetch_optional(pool)
        .await?;
    Ok(row.as_ref().map(row_to_project))
}

// Sparse metadata update from the Objects overview's inline edit-mode.
// COALESCE keeps any field the caller didn't send. Returns the fresh
// ProjectSummary (re-fetched through the owner join) or None if the
// project doesn't exist. `owner` is the project's current owner —
// needed to clear their existing default when flipping `is_default` on
// (the `projects_owner_default_idx` partial unique index allows only
// one default per owner, so the two writes run in one transaction).
#[allow(clippy::too_many_arguments)]
pub async fn update_project_meta(
    pool:        &PgPool,
    rid:         &str,
    owner:       &str,
    name:        Option<&str>,
    description: Option<&str>,
    is_default:  Option<bool>,
    owner_id:    Option<&str>,
    company_id:  Option<&str>,
    status:      Option<&str>,
) -> sqlx::Result<Option<ProjectSummary>> {
    let mut tx = pool.begin().await?;
    // Default lives on `users.default_project_id` now (one column = one
    // default per user, so no flip-off of siblings needed). Some(true) sets
    // it; Some(false) clears it when this project is the current default.
    match is_default {
        Some(true) => {
            sqlx::query("UPDATE users SET default_project_id = $2 WHERE redpash_id = $1")
                .bind(owner)
                .bind(rid)
                .execute(&mut *tx)
                .await?;
        }
        Some(false) => {
            sqlx::query(
                "UPDATE users SET default_project_id = NULL
                 WHERE redpash_id = $1 AND default_project_id = $2",
            )
            .bind(owner)
            .bind(rid)
            .execute(&mut *tx)
            .await?;
        }
        None => {}
    }
    // Owner transfer -> move the owner membership to the new user. Widened PK:
    // no ON CONFLICT on (object,user); a user holds one tier row per object
    // (context_role = ''). Clear the current owner(s) AND the new owner's prior
    // tier row, then set the new owner.
    if let Some(new_owner) = owner_id {
        sqlx::query(
            "DELETE FROM memberships
              WHERE object_redpash_id = $1
                AND (role = 'owner' OR (member_redpash_id = $2 AND context_role = ''))",
        )
        .bind(rid)
        .bind(new_owner)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO memberships (object_redpash_id, member_redpash_id, role)
             VALUES ($1, $2, 'owner')",
        )
        .bind(rid)
        .bind(new_owner)
        .execute(&mut *tx)
        .await?;
    }
    // COALESCE keeps any unsent field — including `company_id`, so this
    // path can set or re-scope a project's company but not clear it back
    // to personal (a dedicated unset path lands with the company UI).
    let res = sqlx::query(
        "UPDATE projects
         SET name        = COALESCE($2, name),
             description  = COALESCE($3, description),
             company_id   = COALESCE($4, company_id),
             status       = COALESCE($5, status),
             updated_at   = now()
         WHERE redpash_id = $1",
    )
    .bind(rid)
    .bind(name)
    .bind(description)
    .bind(company_id)
    .bind(status)
    .execute(&mut *tx)
    .await?;
    if res.rows_affected() == 0 {
        tx.rollback().await?;
        return Ok(None);
    }
    tx.commit().await?;
    get_project(pool, rid).await
}

/// File RIDs in a project — the project-delete handler grabs these
/// *before* the cascade clears the rows, so it can evict the hot-frame
/// cache and unlink the on-disk blobs (the FK cascade only drops DB
/// rows, not the files on disk).
pub async fn project_file_rids(pool: &PgPool, project_rid: &str) -> sqlx::Result<Vec<String>> {
    // PROJECT-FILES-ACK: type=any — cascade-delete prep needs every
    // file_type so on-disk blobs + hot-frame cache evict for all rows.
    let rows = sqlx::query("SELECT redpash_id FROM project_files WHERE project_redpash_id = $1")
        .bind(project_rid)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|r| r.get::<String, _>("redpash_id")).collect())
}

/// Delete a project — unless it's the owner's **default**. The
/// `AND NOT is_default` guard makes the check atomic with the delete:
/// `Ok(false)` means the row exists (the handler's `ensure_owner`
/// already confirmed that) but is the default, so the caller must
/// promote another project to default first. Cascades to files /
/// steps / dashboards / memberships via FK.
pub async fn delete_project(pool: &PgPool, rid: &str) -> sqlx::Result<bool> {
    // Delete via the entity registry so the entities row + every edge
    // (files / steps / memberships) cascade in one shot. The `is_default`
    // guard is preserved as an EXISTS predicate: a default project can't be
    // deleted (the caller must promote another to default first), so
    // `Ok(false)` still means "exists but is the default."
    let res = sqlx::query(
        "DELETE FROM entities
         WHERE id = $1
           AND EXISTS (SELECT 1 FROM projects WHERE redpash_id = $1)
           AND NOT EXISTS (SELECT 1 FROM users WHERE default_project_id = $1)",
    )
    .bind(rid)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Create a project with full metadata. Wraps insert in a tx alongside
/// the default-flip so the `projects_owner_default_idx` partial unique
/// index never sees two defaults at once. Returns the freshly-selected
/// ProjectSummary (joined through `users` for the owner display fields).
#[allow(clippy::too_many_arguments)]
pub async fn create_project(
    pool:        &PgPool,
    rid:         &str,
    owner:       &str,
    name:        &str,
    description: Option<&str>,
    company_id:  Option<&str>,
    is_default:  bool,
) -> sqlx::Result<ProjectSummary> {
    let mut tx = pool.begin().await?;
    super::register_entity(&mut *tx, rid, "project").await?;
    sqlx::query(
        "INSERT INTO projects (redpash_id, name, description, company_id)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(rid)
    .bind(name)
    .bind(description)
    .bind(company_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO memberships (object_redpash_id, member_redpash_id, role)
         VALUES ($1, $2, 'owner')",
    )
    .bind(rid)
    .bind(owner)
    .execute(&mut *tx)
    .await?;
    if is_default {
        sqlx::query("UPDATE users SET default_project_id = $2 WHERE redpash_id = $1")
            .bind(owner)
            .bind(rid)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    // get_project re-selects through PROJECT_SELECT so the returned row
    // carries the joined owner_display_name / stage / file_count. The row
    // was just committed, but a concurrent delete or a read-replica lag
    // can still return None — surface that as an error rather than panic
    // the task (which axum turns into an opaque 500).
    get_project(pool, rid).await?.ok_or(sqlx::Error::RowNotFound)
}
