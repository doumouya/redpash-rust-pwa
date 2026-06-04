//! Doc: docs/internal/code/backend/api/db/connectors.md
//! `connectors` table CRUD — the persisted Kafka (and future S3/CDC) connection
//! that holds the user's CHOSEN destination project, so the loader reads it
//! instead of the `load.sh` env hardcode (Em: "ask the user which project").
//!
//! A connector is a first-class entity (polymorphic registry, type `connection`),
//! so it follows the same create/delete invariants as projects/cases:
//!   - **create:** `register_entity` BEFORE the `connectors` INSERT, one tx.
//!   - **delete:** via `delete_entity` (cascades the subtype row).
//!
//! The cluster SASL creds stay in the connector's `.env` (cluster-level, not
//! per-connection) for the RC; this row carries only the user-facing config:
//! name / topic / destination project / as_user. RBAC on the destination is
//! enforced at LOAD time by `pipeline::upload_csv` (and at CREATE time by the
//! route), reusing the same write-reach check as a UI upload.

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{PgPool, Row};

/// List/detail shape returned to the FE (the connections surface) — JSON.
#[derive(Serialize)]
pub struct ConnectorSummary {
    pub redpash_id: String,
    pub project_id: String,
    pub name:       String,
    pub kind:       String,
    pub topic:      Option<String>,
    pub as_user:    String,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
}

/// The minimal config the loader reads to route a load (the destination the
/// user chose). Kafka transport creds come from env; this is the framework half.
pub struct ConnectorLoadCfg {
    pub project_id: String,
    pub as_user:    String,
    pub topic:      Option<String>,
    pub kind:       String,
}

fn row_to_summary(r: &sqlx::postgres::PgRow) -> ConnectorSummary {
    ConnectorSummary {
        redpash_id: r.get("redpash_id"),
        project_id: r.get("project_id"),
        name:       r.get("name"),
        kind:       r.get("kind"),
        topic:      r.try_get("topic").ok(),
        as_user:    r.get("as_user"),
        created_by: r.get("created_by"),
        created_at: r.get::<DateTime<Utc>, _>("created_at"),
    }
}

/// Create a connector — register the entity, then insert the subtype row, in one
/// transaction (FK ordering, same as `insert_project`). The caller's write-reach
/// on `project_id` is checked by the ROUTE before this runs (fail-closed).
#[allow(clippy::too_many_arguments)]
pub async fn insert_connector(
    pool:       &PgPool,
    rid:        &str,
    project_id: &str,
    name:       &str,
    kind:       &str,
    topic:      Option<&str>,
    as_user:    &str,
    created_by: &str,
) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    super::register_entity(&mut *tx, rid, "connection").await?;
    sqlx::query(
        "INSERT INTO connectors (redpash_id, project_id, name, kind, topic, as_user, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(rid)
    .bind(project_id)
    .bind(name)
    .bind(kind)
    .bind(topic)
    .bind(as_user)
    .bind(created_by)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

const CONNECTOR_SELECT: &str =
    "SELECT redpash_id, project_id, name, kind, topic, as_user, created_by, created_at
     FROM connectors";

/// Connectors the caller can reach — same reach as `list_projects`
/// (CAS_3B0DAD92): platform admin → all; direct project membership → that
/// project's connectors; company owner/admin cascade → that company's projects'
/// connectors. So a connection shows up wherever its destination project does.
pub async fn list_connectors(pool: &PgPool, caller: &str) -> sqlx::Result<Vec<ConnectorSummary>> {
    let rows = sqlx::query(&format!(
        "{CONNECTOR_SELECT} c_outer
         WHERE EXISTS (SELECT 1 FROM users au
                       WHERE au.redpash_id = $1 AND au.role = 'admin')
            OR EXISTS (SELECT 1 FROM memberships pm
                       WHERE pm.object_redpash_id = c_outer.project_id
                         AND pm.member_redpash_id = $1)
            OR EXISTS (SELECT 1 FROM projects p
                       JOIN memberships cm ON cm.object_redpash_id = p.company_id
                       WHERE p.redpash_id = c_outer.project_id
                         AND cm.member_redpash_id = $1
                         AND cm.role IN ('owner', 'admin'))
         ORDER BY created_at DESC"
    ))
    .bind(caller)
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(row_to_summary).collect())
}

/// The full summary for one connector (route detail).
pub async fn get_connector(pool: &PgPool, rid: &str) -> sqlx::Result<Option<ConnectorSummary>> {
    let row = sqlx::query(&format!("{CONNECTOR_SELECT} WHERE redpash_id = $1"))
        .bind(rid)
        .fetch_optional(pool)
        .await?;
    Ok(row.as_ref().map(row_to_summary))
}

/// The loader's read: the destination + caller the load routes through. Returns
/// None if the connector doesn't exist (the loader fails loudly).
pub async fn get_connector_load_cfg(pool: &PgPool, rid: &str) -> sqlx::Result<Option<ConnectorLoadCfg>> {
    let row = sqlx::query(
        "SELECT project_id, as_user, topic, kind FROM connectors WHERE redpash_id = $1",
    )
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| ConnectorLoadCfg {
        project_id: r.get("project_id"),
        as_user:    r.get("as_user"),
        topic:      r.try_get("topic").ok(),
        kind:       r.get("kind"),
    }))
}
