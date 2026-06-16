//! The registry DISPLAY derive: every real column of a builtin's table shows in
//! the registry — objects::registry_display_fields (the /objects row data) and
//! types::payload (the /api/types column headers) agree on the same set — minus
//! the internal/sensitive denylist, and WITHOUT widening the write surface.
//! Needs DATABASE_URL (the lean DB); skips cleanly when unset.

use api::{objects, types};

async fn pool() -> Option<sqlx::PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    sqlx::PgPool::connect(&url).await.ok()
}

#[tokio::test]
async fn registry_derives_all_columns_minus_denylist() {
    let Some(pool) = pool().await else {
        eprintln!("registry_fields: DATABASE_URL unset — skipped");
        return;
    };

    // case: the derive surfaces the columns the hand-seed omitted (error_message,
    // attachments, redpash_id) while keeping the curated ones. cases has no
    // denylisted column, so the full table shows.
    let case = objects::registry_display_fields(&pool, "case")
        .await
        .unwrap()
        .expect("case is a builtin");
    let names: Vec<&str> = case.iter().map(|(f, _)| f.as_str()).collect();
    for want in ["title", "redpash_id", "error_message", "attachments", "created_at"] {
        assert!(names.contains(&want), "case registry should expose `{want}` (have {names:?})");
    }

    // file: the server FS path + data-bearing blobs are DENYLISTED, while a benign
    // DERIVED-and-uncataloged column (encoding) IS surfaced — so this proves both
    // that the derive reached the real table AND that the denylist filtered it
    // (storage_path = server path; columns_meta = raw CSV cell samples; spec = config).
    let file = objects::registry_display_fields(&pool, "file")
        .await
        .unwrap()
        .expect("file is a builtin");
    let fnames: Vec<&str> = file.iter().map(|(f, _)| f.as_str()).collect();
    for leak in ["storage_path", "columns_meta", "spec"] {
        assert!(!fnames.contains(&leak), "file registry must NOT leak `{leak}` (have {fnames:?})");
    }
    assert!(fnames.contains(&"encoding"), "file registry SHOULD derive benign metadata like `encoding` (have {fnames:?})");
    assert!(fnames.contains(&"filename"), "file registry should expose filename");

    // user: the OAuth SUBJECT is denylisted.
    let user = objects::registry_display_fields(&pool, "user")
        .await
        .unwrap()
        .expect("user is a builtin");
    let unames: Vec<&str> = user.iter().map(|(f, _)| f.as_str()).collect();
    assert!(!unames.contains(&"google_sub"), "user registry must NOT leak google_sub (have {unames:?})");

    // non-builtin (custom/entity_data) types derive nothing — None, not an error.
    assert!(objects::registry_display_fields(&pool, "does_not_exist").await.unwrap().is_none());

    // /api/types carries the SAME fields as the row data, and the derived ones are
    // READONLY (display-only — the write gate is catalog_fields/type_fields, so a
    // PATCH still can't set them; their absence here would drop them from the FE).
    let payload = types::payload(&pool).await.unwrap();
    let case_t = payload["types"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["type_id"] == "case")
        .expect("case type in /api/types");
    let fields = case_t["fields"].as_array().unwrap();
    let err = fields
        .iter()
        .find(|f| f["key"] == "error_message")
        .expect("error_message present as a /api/types column");
    assert_eq!(err["perm_class"], "readonly", "a derived column is readonly (write surface unaffected)");
    for (f, _) in &case {
        assert!(
            fields.iter().any(|jf| jf["key"] == f.as_str()),
            "/api/types case is missing column `{f}` that /objects returns (FE intersection would drop it)"
        );
    }
}
