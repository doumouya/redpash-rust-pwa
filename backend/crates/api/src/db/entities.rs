//! Doc: docs/internal/code/backend/api/db/entities.md
//! Entity Registry (supertype) helpers — step 1a of the membership
//! consolidation (case CAS_DC7EDAF82F1E494F846D83FA71C411A2).
//!
//! `entities` is the universal object handle: every top-level entity's
//! `redpash_id` FKs into it `ON DELETE CASCADE`, so polymorphic relations
//! (memberships) inherit DB-enforced cascade with no triggers. Today the
//! registry covers the membership OBJECT types (company / project / case);
//! user/file join later when something points polymorphically at them.
//!
//! Two invariants the rest of `db` relies on:
//!   - **create:** register the entity BEFORE inserting the subtype row
//!     (the subtype PK FKs into `entities`) — do both in one transaction.
//!   - **delete:** delete via the entity (`delete_entity`) — it cascades
//!     to the subtype row and every edge that FKs into the registry.

use sqlx::PgExecutor;

/// Insert the registry row for an entity. MUST run inside the same
/// transaction as, and before, the subtype `INSERT` (FK ordering).
pub async fn register_entity<'e, E>(ex: E, id: &str, etype: &str) -> sqlx::Result<()>
where
    E: PgExecutor<'e>,
{
    sqlx::query("INSERT INTO entities (id, type) VALUES ($1, $2)")
        .bind(id)
        .bind(etype)
        .execute(ex)
        .await?;
    Ok(())
}

/// Delete an entity by id. Cascades to the subtype row (companies /
/// projects / cases) and every edge FK'd into the registry — the single
/// delete path for any registered object. `true` if a row was removed.
pub async fn delete_entity<'e, E>(ex: E, id: &str) -> sqlx::Result<bool>
where
    E: PgExecutor<'e>,
{
    let res = sqlx::query("DELETE FROM entities WHERE id = $1")
        .bind(id)
        .execute(ex)
        .await?;
    Ok(res.rows_affected() > 0)
}
