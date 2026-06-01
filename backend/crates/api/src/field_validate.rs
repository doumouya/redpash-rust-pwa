//! Purpose: registry-driven write-validation of a field value against its
//! TypeDefinition `data_type` (spec docs/internal/specs/type-definition.md §4.2)
//! — a PURE format check (no DB) plus an async rid-reference existence +
//! rel.type check.
//! Doc: docs/internal/code/backend/api/field_validate.md
//!
//! DELIBERATELY UNWIRED (Em 2026-05-31, CAS_0FBF301F): the per-resource PATCH
//! handlers (cases / companies / projects / charts / dashboards / files) already
//! validate builtin writes with bespoke per-field logic + FK constraints + the
//! `require_fields` perm gate. Retrofitting this generic validator into them
//! would duplicate working validation (code debt) for no payoff today — there is
//! no generic object-field-write endpoint yet. This is the reusable validator
//! the FUTURE custom-object PATCH endpoint will call (a custom type has no
//! source-code handler to bake validation into — it MUST be registry-driven).
//! Built ready; not retrofitted. The module-level `allow(dead_code)` reflects
//! that staged state.
#![allow(dead_code)]

use serde_json::Value;

use crate::field_perms::Rel;

/// A write-validation failure. Maps to HTTP per spec §4.2:
/// `BadValue` → 400, `MissingRef` → 404.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldError {
    /// Value doesn't match the `data_type` / isn't in `options` / wrong ref type.
    BadValue(String),
    /// An rid references an entity that doesn't exist.
    MissingRef(String),
}

fn bad(m: impl Into<String>) -> FieldError {
    FieldError::BadValue(m.into())
}

/// Validate a value against a §4.2 `data_type` — PURE (no DB). For `rid` this
/// only confirms it's a string; existence + type go through [`validate_ref`].
///
/// Delegates to the [codec registry](crate::codec_registry) — `data_type` is an
/// opaque codec id, no longer a closed `match` (CAS_75A0D1FD). Values may arrive
/// as their native JSON type OR as a string (the cell-editor PATCHes
/// contenteditable strings); a JSON `null` is "clear the field" (the registry
/// handles it); an unregistered codec id → `BadValue("codec_not_registered: …")`.
pub fn validate_format(data_type: &str, value: &Value, options: &[&str]) -> Result<(), FieldError> {
    crate::codec_registry::registry().validate(data_type, value, options)
}

/// The table + rid prefix a relationship type resolves to. Names are hardcoded
/// (never user input) — safe to splice into the existence query.
struct RefTarget {
    prefix:    &'static str,
    table:     &'static str,
    /// For the `project_files`-backed types, the discriminating `file_type`.
    file_type: Option<&'static str>,
}

/// Map a `rel.type` to its backing table. Builtin types only; an unmapped type
/// (e.g. a custom type before its table exists) yields `None` → fail-open.
fn ref_target(rel_type: &str) -> Option<RefTarget> {
    Some(match rel_type {
        "user"          => RefTarget { prefix: "USR_", table: "users",           file_type: None },
        "company"       => RefTarget { prefix: "CMP_", table: "companies",       file_type: None },
        "project"       => RefTarget { prefix: "PRJ_", table: "projects",        file_type: None },
        "case"          => RefTarget { prefix: "CAS_", table: "cases",           file_type: None },
        "team"          => RefTarget { prefix: "TEM_", table: "teams",           file_type: None },
        "case_category" => RefTarget { prefix: "CAT_", table: "case_categories", file_type: None },
        // file / chart / dashboard share project_files; discriminate by file_type.
        // (file & dashboard even share the FIL_ prefix — chart got CHT_.)
        "file"          => RefTarget { prefix: "FIL_", table: "project_files",   file_type: Some("csv") },
        "chart"         => RefTarget { prefix: "CHT_", table: "project_files",   file_type: Some("chart") },
        "dashboard"     => RefTarget { prefix: "FIL_", table: "project_files",   file_type: Some("dashboard") },
        _ => return None,
    })
}

/// Validate an rid reference for a `rid` field: the value must look like the
/// declared target type (prefix mismatch → `BadValue`/400) and the referenced
/// row must exist (absent → `MissingRef`/404). An unmapped `rel.type` can't be
/// checked here, so it passes (the caller's FK / app logic is the backstop).
pub async fn validate_ref(pool: &sqlx::PgPool, rel: &Rel, rid: &str) -> Result<(), FieldError> {
    let Some(t) = ref_target(rel.ty) else { return Ok(()) };
    if !rid.starts_with(t.prefix) {
        return Err(bad(format!("expected a {} reference ({}…)", rel.ty, t.prefix)));
    }
    let exists: bool = match t.file_type {
        Some(ft) => {
            let sql = format!(
                "SELECT EXISTS(SELECT 1 FROM {} WHERE redpash_id = $1 AND file_type = $2)",
                t.table
            );
            sqlx::query_scalar(&sql).bind(rid).bind(ft).fetch_one(pool).await
        }
        None => {
            let sql = format!("SELECT EXISTS(SELECT 1 FROM {} WHERE redpash_id = $1)", t.table);
            sqlx::query_scalar(&sql).bind(rid).fetch_one(pool).await
        }
    }
    .map_err(|e| bad(format!("reference check failed: {e}")))?;

    if exists {
        Ok(())
    } else {
        Err(FieldError::MissingRef(format!("no {} with id {}", rel.ty, rid)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strings_and_markdown() {
        assert!(validate_format("string", &json!("hi"), &[]).is_ok());
        assert!(validate_format("markdown", &json!("# h"), &[]).is_ok());
        assert!(validate_format("string", &json!(5), &[]).is_err());
        // null clears, always ok.
        assert!(validate_format("string", &Value::Null, &[]).is_ok());
    }

    #[test]
    fn ints_accept_number_or_string() {
        assert!(validate_format("int", &json!(42), &[]).is_ok());
        assert!(validate_format("int", &json!("42"), &[]).is_ok());
        assert!(validate_format("int", &json!("4.2"), &[]).is_err());
        assert!(validate_format("int", &json!("abc"), &[]).is_err());
    }

    #[test]
    fn floats_accept_number_or_string() {
        assert!(validate_format("float", &json!(4.2), &[]).is_ok());
        assert!(validate_format("float", &json!("4.2"), &[]).is_ok());
        assert!(validate_format("float", &json!("nope"), &[]).is_err());
    }

    #[test]
    fn booleans_accept_bool_or_string() {
        assert!(validate_format("boolean", &json!(true), &[]).is_ok());
        assert!(validate_format("boolean", &json!("false"), &[]).is_ok());
        assert!(validate_format("boolean", &json!("TRUE"), &[]).is_ok());
        assert!(validate_format("boolean", &json!("yes"), &[]).is_err());
    }

    #[test]
    fn enums_check_options() {
        let opts = ["bug", "feature", "task", "epic"];
        assert!(validate_format("enum", &json!("bug"), &opts).is_ok());
        assert_eq!(
            validate_format("enum", &json!("draft"), &opts),
            Err(FieldError::BadValue("must be one of: bug, feature, task, epic".into()))
        );
    }

    #[test]
    fn datetimes_parse_iso8601() {
        assert!(validate_format("datetime", &json!("2026-05-31T22:00:00Z"), &[]).is_ok());
        assert!(validate_format("datetime", &json!("2026-05-31"), &[]).is_err());
        assert!(validate_format("datetime", &json!("not a date"), &[]).is_err());
    }

    #[test]
    fn json_object_ok_string_must_parse() {
        assert!(validate_format("json", &json!({"a": 1}), &[]).is_ok());
        assert!(validate_format("json", &json!("[1,2,3]"), &[]).is_ok());
        assert!(validate_format("json", &json!("{bad"), &[]).is_err());
    }

    #[test]
    fn unknown_data_type_errs() {
        assert!(matches!(
            validate_format("geo", &json!("x"), &[]),
            Err(FieldError::BadValue(_))
        ));
    }
}
