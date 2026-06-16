use gluesql::prelude::{Glue, Payload, Value};
use gluesql_idb_storage::IdbStorage;
use wasm_bindgen::prelude::*;

fn je<E: std::fmt::Display>(e: E) -> JsError { JsError::new(&e.to_string()) }

fn count_of(p: Vec<Payload>) -> i64 {
    if let Some(Payload::Select { rows, .. }) = p.first() {
        if let Some(r) = rows.first() {
            if let Some(Value::I64(n)) = r.first() { return *n; }
        }
    }
    -1
}

async fn open() -> Result<Glue<IdbStorage>, JsError> {
    let storage = IdbStorage::new(Some("redpash_spike".to_owned())).await.map_err(je)?;
    Ok(Glue::new(storage))
}

/// Create a table in IndexedDB, load `rows`, try CREATE INDEX, mutate, return
/// JSON. (Timed from JS via performance.now around the call.)
#[wasm_bindgen]
pub async fn idb_setup(rows: usize) -> Result<String, JsError> {
    let mut glue = open().await?;
    let _ = glue.execute("DROP TABLE IF EXISTS t").await;
    glue.execute("CREATE TABLE t (id INTEGER, name TEXT, amount INTEGER)").await.map_err(je)?;

    let mut vals = String::new();
    for i in 0..rows {
        if i > 0 { vals.push(','); }
        vals.push_str(&format!("({i},'name{}',{})", i % 100, i % 1000));
    }
    glue.execute(&format!("INSERT INTO t VALUES {vals}")).await.map_err(je)?;

    // the question: does idb storage support indexes (memory didn't)?
    let index = match glue.execute("CREATE INDEX idx_id ON t (id)").await {
        Ok(_) => "SUPPORTED".to_string(),
        Err(e) => format!("UNSUPPORTED: {e}"),
    };

    let count = count_of(glue.execute("SELECT COUNT(*) AS n FROM t").await.map_err(je)?);
    glue.execute("UPDATE t SET name = 'EDITED' WHERE id = 5").await.map_err(je)?;
    glue.execute("DELETE FROM t WHERE id = 6").await.map_err(je)?;
    let after = count_of(glue.execute("SELECT COUNT(*) AS n FROM t").await.map_err(je)?);
    let edited = count_of(glue.execute("SELECT COUNT(*) AS n FROM t WHERE name = 'EDITED'").await.map_err(je)?);

    Ok(serde_json::json!({
        "index": index, "inserted": count, "after_delete": after, "edited_rows": edited,
    }).to_string())
}

/// Re-open the SAME idb namespace and count — run AFTER a page reload to prove
/// the data (and the edit/delete) persisted.
#[wasm_bindgen]
pub async fn idb_count() -> Result<String, JsError> {
    let mut glue = open().await?;
    let count = count_of(glue.execute("SELECT COUNT(*) AS n FROM t").await.map_err(je)?);
    let edited = count_of(glue.execute("SELECT COUNT(*) AS n FROM t WHERE name = 'EDITED'").await.map_err(je)?);
    Ok(serde_json::json!({ "persisted_count": count, "persisted_edits": edited }).to_string())
}
