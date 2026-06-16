//! Purpose: field-level permissions — the predecessor's PermClass pattern,
//! re-rooted on the DB catalog. Per-role read/write cells DERIVE from a
//! field's `perm_class` (type_fields, seeded data — never persisted cells, so
//! seeds can't drift), and the sparse `field_permissions` override table
//! layers on top. `require_fields` is the write gate: it runs AFTER the
//! coarse Edit gate, so its denial may be a 403 naming the blocked field —
//! existence is already admitted, nothing leaks.
//!
//! Tier resolution rides the ONE resolver (rbac::resolve_grant → effective);
//! platform admins bypass FIRST, like every gate in the house.

use std::collections::HashMap;

use sqlx::PgPool;

use crate::{
    error::AppError,
    rbac::{self, Caller},
    type_cache::TypeDefCache,
};

/// Permission for one `(field, role)` cell. `Write` implies `Read`; ordered so
/// "at least Read" is a `>=`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Perm {
    None,
    Read,
    Write,
}

impl Perm {
    /// The wire shape on /api/types cells: "rw" | "r" | "".
    pub fn wire(self) -> &'static str {
        match self {
            Perm::Write => "rw",
            Perm::Read => "r",
            Perm::None => "",
        }
    }
    /// A field_permissions override row → a cell (can_write implies read).
    pub fn from_flags(can_read: bool, can_write: bool) -> Perm {
        if can_write {
            Perm::Write
        } else if can_read {
            Perm::Read
        } else {
            Perm::None
        }
    }
}

/// The permission class of a field — the per-role default matrix DERIVES from
/// it, so a custom type's fields resolve without hand-authored defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermClass {
    /// `W W R R` — default editable field (owner/admin write, below read).
    Standard,
    /// `W W W R` — member-writable content (participants edit).
    Collaborative,
    /// `W R R R` — ownership-adjacent knobs (role/status/kind).
    OwnerGrade,
    /// `W N N N` — owner-only personal pin.
    Personal,
    /// `R R R R` — system-managed (username, company_id).
    Readonly,
}

impl PermClass {
    /// Parse the stored wire string (type_fields.perm_class) back to the enum.
    pub fn parse(s: &str) -> Option<PermClass> {
        match s {
            "standard" => Some(PermClass::Standard),
            "collaborative" => Some(PermClass::Collaborative),
            "owner_grade" => Some(PermClass::OwnerGrade),
            "personal" => Some(PermClass::Personal),
            "readonly" => Some(PermClass::Readonly),
            _ => None,
        }
    }
    /// `[owner, admin, member, viewer]`.
    pub fn cells(self) -> [Perm; 4] {
        use Perm::{None as N, Read as R, Write as W};
        match self {
            PermClass::Standard => [W, W, R, R],
            PermClass::Collaborative => [W, W, W, R],
            PermClass::OwnerGrade => [W, R, R, R],
            PermClass::Personal => [W, N, N, N],
            PermClass::Readonly => [R, R, R, R],
        }
    }
}

/// The four tiers, in cells() order. The ONE place the role↔index mapping
/// lives; admin.rs validates override roles against it.
pub const TIERS: [&str; 4] = ["owner", "admin", "member", "viewer"];

pub fn tier_index(role: &str) -> Option<usize> {
    TIERS.iter().position(|r| *r == role)
}

/// The merged cell matrix for one type: field → `[Perm; 4]` in TIERS order
/// (perm_class derivation ⊕ field_permissions overrides). Loaded once per
/// request and shared across rows — list masking must not re-query per row.
pub struct FieldMatrix {
    cells: HashMap<String, [Perm; 4]>,
}

impl FieldMatrix {
    /// Fast path: when every cell of every field is at least Read, masking is
    /// a no-op — the common case until an admin stores a hiding override.
    pub fn fully_readable(&self) -> bool {
        self.cells.values().all(|c| c.iter().all(|p| *p >= Perm::Read))
    }
    /// The fields BELOW Read for a tier — what masking strips from `data`.
    pub fn unreadable(&self, tier_idx: usize) -> Vec<&str> {
        self.cells
            .iter()
            .filter(|(_, c)| c[tier_idx] < Perm::Read)
            .map(|(f, _)| f.as_str())
            .collect()
    }
    pub fn cell(&self, field: &str, tier_idx: usize) -> Perm {
        self.cells.get(field).map(|c| c[tier_idx]).unwrap_or(Perm::None)
    }
}

/// Load the merged matrix for a type (both write gates and read masking
/// resolve through this one derivation).
pub async fn matrix(pool: &PgPool, type_id: &str) -> Result<FieldMatrix, AppError> {
    let classes: Vec<(String, String)> =
        sqlx::query_as("SELECT field, perm_class FROM type_fields WHERE type_id = $1")
            .bind(type_id)
            .fetch_all(pool)
            .await?;
    let mut cells: HashMap<String, [Perm; 4]> = classes
        .into_iter()
        .map(|(f, pc)| {
            let derived =
                PermClass::parse(&pc).map(PermClass::cells).unwrap_or([Perm::None; 4]);
            (f, derived)
        })
        .collect();
    let overrides: Vec<(String, String, bool, bool)> = sqlx::query_as(
        "SELECT field, role, can_read, can_write FROM field_permissions WHERE type_id = $1",
    )
    .bind(type_id)
    .fetch_all(pool)
    .await?;
    for (field, role, r, w) in overrides {
        if let (Some(c), Some(i)) = (cells.get_mut(&field), tier_index(&role)) {
            c[i] = Perm::from_flags(r, w);
        }
    }
    Ok(FieldMatrix { cells })
}

/// Field-level write gate. Runs AFTER the coarse Edit gate has admitted the
/// caller (so a 403 here leaks nothing — existence is already known): every
/// field being written must resolve to `Write` for the caller's effective
/// tier in the merged matrix (perm_class derivation ⊕ field_permissions
/// overrides). Platform admins bypass. 403 `field_forbidden` naming the FIRST
/// blocked field. A field missing from the catalog is default-deny (None) —
/// the handlers also reject it earlier as 400 unknown_field.
pub async fn require_fields(
    pool: &PgPool,
    cache: &TypeDefCache,
    caller: &Caller,
    object: &str,
    type_id: &str,
    fields: &[&str],
) -> Result<(), AppError> {
    if fields.is_empty() || caller.is_platform_admin {
        return Ok(());
    }
    // The coarse gate already passed, so a grant exists in every normal path;
    // a contract-company-owner with zero membership edges is the documented
    // edge (leak-free 404 keeps the house shape until that tier is modeled).
    let tier = rbac::resolve_grant(pool, cache, &caller.rid, object)
        .await?
        .effective()
        .ok_or_else(|| AppError::not_found("not_found", format!("{type_id} {object}")))?;
    let role = tier.as_str();
    let idx = tier_index(role).expect("rbac::Role strings align with TIERS");

    let classes: Vec<(String, String)> =
        sqlx::query_as("SELECT field, perm_class FROM type_fields WHERE type_id = $1")
            .bind(type_id)
            .fetch_all(pool)
            .await?;
    let overrides: HashMap<String, Perm> = sqlx::query_as::<_, (String, bool, bool)>(
        "SELECT field, can_read, can_write FROM field_permissions
         WHERE type_id = $1 AND role = $2",
    )
    .bind(type_id)
    .bind(role)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(f, r, w)| (f, Perm::from_flags(r, w)))
    .collect();

    for f in fields {
        let derived = classes
            .iter()
            .find(|(fld, _)| fld == f)
            .and_then(|(_, pc)| PermClass::parse(pc))
            .map(|pc| pc.cells()[idx])
            .unwrap_or(Perm::None);
        let perm = overrides.get(*f).copied().unwrap_or(derived);
        if perm != Perm::Write {
            return Err(AppError::forbidden(
                "field_forbidden",
                format!("your role ({role}) can't edit {type_id}.{f}"),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cells_derive_per_class() {
        use Perm::{None as N, Read as R, Write as W};
        assert_eq!(PermClass::Standard.cells(), [W, W, R, R]);
        assert_eq!(PermClass::Collaborative.cells(), [W, W, W, R]);
        assert_eq!(PermClass::OwnerGrade.cells(), [W, R, R, R]);
        assert_eq!(PermClass::Personal.cells(), [W, N, N, N]);
        assert_eq!(PermClass::Readonly.cells(), [R, R, R, R]);
    }

    #[test]
    fn wire_and_flags_round() {
        assert_eq!(Perm::Write.wire(), "rw");
        assert_eq!(Perm::Read.wire(), "r");
        assert_eq!(Perm::None.wire(), "");
        assert_eq!(Perm::from_flags(true, true), Perm::Write);
        assert_eq!(Perm::from_flags(false, true), Perm::Write); // write implies read
        assert_eq!(Perm::from_flags(true, false), Perm::Read);
        assert_eq!(Perm::from_flags(false, false), Perm::None);
    }

    #[test]
    fn tiers_align_with_role_strings() {
        // rbac::Role::as_str must map onto cells() indices.
        assert_eq!(tier_index(crate::rbac::Role::Owner.as_str()), Some(0));
        assert_eq!(tier_index(crate::rbac::Role::Admin.as_str()), Some(1));
        assert_eq!(tier_index(crate::rbac::Role::Member.as_str()), Some(2));
        assert_eq!(tier_index(crate::rbac::Role::Viewer.as_str()), Some(3));
    }
}
