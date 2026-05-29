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
    let row = sqlx::query("SELECT redpash_id FROM projects WHERE owner_id = $1 AND is_default LIMIT 1")
        .bind(owner)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.get::<String, _>(0)))
}

pub async fn insert_project(pool: &PgPool, rid: &str, owner: &str, name: &str, is_default: bool) -> sqlx::Result<()> {
    // Register the entity first, then insert the project — one tx so the
    // FK (projects.redpash_id -> entities.id) is satisfied atomically.
    let mut tx = pool.begin().await?;
    super::register_entity(&mut *tx, rid, "project").await?;
    sqlx::query("INSERT INTO projects (redpash_id, owner_id, name, is_default) VALUES ($1, $2, $3, $4)")
        .bind(rid)
        .bind(owner)
        .bind(name)
        .bind(is_default)
        .execute(&mut *tx)
        .await?;
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
        "SELECT redpash_id FROM projects \
         WHERE owner_id = $1 AND name = $2 \
         ORDER BY created_at ASC LIMIT 1",
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
// PROJECT-FILES-ACK: type=mixed — three project_files subqueries:
//   1) EXISTS dashboard rows for the 'published' overlay,
//   2) EXISTS any non-chart file for the 'active' derivation
//      (same predicate as file_count, so Files>0 ⟺ Active),
//   3) COUNT excluding charts for the user-facing file_count
//      (charts aren't surfaced as files in the rail).
const PROJECT_SELECT: &str =
    "SELECT p.redpash_id, p.name, p.description, p.is_default, p.owner_id, p.company_id,
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
     FROM projects p JOIN users u ON u.redpash_id = p.owner_id";

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
        &format!("{PROJECT_SELECT} WHERE p.owner_id = $1
                  ORDER BY p.is_default DESC, p.created_at ASC"),
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
    if is_default == Some(true) {
        sqlx::query(
            "UPDATE projects SET is_default = false, updated_at = now()
             WHERE owner_id = $1 AND is_default AND redpash_id <> $2",
        )
        .bind(owner)
        .bind(rid)
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
             is_default   = COALESCE($4, is_default),
             owner_id     = COALESCE($5, owner_id),
             company_id   = COALESCE($6, company_id),
             status       = COALESCE($7, status),
             updated_at   = now()
         WHERE redpash_id = $1",
    )
    .bind(rid)
    .bind(name)
    .bind(description)
    .bind(is_default)
    .bind(owner_id)
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
           AND EXISTS (SELECT 1 FROM projects WHERE redpash_id = $1 AND NOT is_default)",
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
    if is_default {
        sqlx::query(
            "UPDATE projects SET is_default = false, updated_at = now()
             WHERE owner_id = $1 AND is_default",
        )
        .bind(owner)
        .execute(&mut *tx)
        .await?;
    }
    super::register_entity(&mut *tx, rid, "project").await?;
    sqlx::query(
        "INSERT INTO projects (redpash_id, owner_id, name, description, company_id, is_default)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(rid)
    .bind(owner)
    .bind(name)
    .bind(description)
    .bind(company_id)
    .bind(is_default)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    // get_project re-selects through PROJECT_SELECT so the returned row
    // carries the joined owner_display_name / stage / file_count.
    get_project(pool, rid).await.map(|opt| opt.expect("just inserted"))
}
