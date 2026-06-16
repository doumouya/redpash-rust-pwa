//! GlueSQL-wasm + IndexedDB — the on-device customer-data store ("InnoDB version").
//! Each user's data lives in its OWN idb namespace (per-user isolation, client-side);
//! tables are queryable SQL (it's an ETL tool). Shipped beside the Polars engine
//! (data.js) — Polars computes, GlueSQL persists + serves queries on the device.
//! Nothing here ever reaches our servers.
//!
//! API (all async; the JS side awaits): ingest_csv(namespace, table, csv) ->
//! {table, columns, rows}; query(namespace, sql) -> {columns, rows}; drop_table.

use gluesql::prelude::{Glue, Payload, Value};
use gluesql_idb_storage::IdbStorage;
use wasm_bindgen::prelude::*;

fn je<E: std::fmt::Display>(e: E) -> JsError {
    JsError::new(&e.to_string())
}

/// Open the user's idb-backed GlueSQL db. `namespace` = a per-user store id (the
/// caller passes the user's store key); each user's data is fully segregated by
/// IndexedDB namespace.
async fn open(namespace: &str) -> Result<Glue<IdbStorage>, JsError> {
    let storage = IdbStorage::new(Some(namespace.to_owned())).await.map_err(je)?;
    Ok(Glue::new(storage))
}

/// A single-quoted SQL string literal with `'` doubled — the values come from
/// arbitrary CSV cells, so they MUST be escaped (no string interpolation of raw
/// data into SQL otherwise).
fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// A table/column identifier restricted to a bare `[A-Za-z0-9_]` token — these
/// are interpolated into DDL, so anything else is refused (belt-and-braces).
fn ident(s: &str) -> Result<String, JsError> {
    let t = s.trim();
    if !t.is_empty() && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        Ok(t.to_string())
    } else {
        Err(je(format!("unsafe identifier: {s:?}")))
    }
}

/// Ingest a CSV into `table`, queryable. v1: every column TEXT (queryable; numeric
/// typing — passing the Polars-inferred dtypes from the FE — is the next refinement).
/// Drops + recreates the table (idempotent re-ingest), batched INSERTs.
#[wasm_bindgen]
pub async fn ingest_csv(namespace: String, table: String, csv: String) -> Result<String, JsError> {
    let table = ident(&table)?;
    let mut rdr = csv::ReaderBuilder::new().has_headers(true).from_reader(csv.as_bytes());
    let cols: Vec<String> = rdr
        .headers()
        .map_err(je)?
        .iter()
        .map(ident)
        .collect::<Result<_, _>>()?;
    if cols.is_empty() {
        return Err(je("CSV has no header columns"));
    }

    let mut glue = open(&namespace).await?;
    glue.execute(&format!("DROP TABLE IF EXISTS {table}")).await.ok();
    let coldefs = cols.iter().map(|c| format!("{c} TEXT")).collect::<Vec<_>>().join(", ");
    glue.execute(&format!("CREATE TABLE {table} ({coldefs})")).await.map_err(je)?;

    let ncol = cols.len();
    let mut rows = 0usize;
    let mut batch: Vec<String> = Vec::new();
    for rec in rdr.records() {
        let rec = rec.map_err(je)?;
        // pad/truncate ragged rows to the header width so VALUES always matches.
        let mut vals: Vec<String> = rec.iter().take(ncol).map(lit).collect();
        while vals.len() < ncol {
            vals.push("NULL".to_string());
        }
        batch.push(format!("({})", vals.join(", ")));
        rows += 1;
        if batch.len() >= 500 {
            glue.execute(&format!("INSERT INTO {table} VALUES {}", batch.join(", "))).await.map_err(je)?;
            batch.clear();
        }
    }
    if !batch.is_empty() {
        glue.execute(&format!("INSERT INTO {table} VALUES {}", batch.join(", "))).await.map_err(je)?;
    }

    Ok(serde_json::json!({ "table": table, "columns": cols, "rows": rows }).to_string())
}

fn value_to_json(v: &Value) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        Value::Null => J::Null,
        Value::Bool(b) => J::Bool(*b),
        Value::I8(n) => J::from(*n),
        Value::I16(n) => J::from(*n),
        Value::I32(n) => J::from(*n),
        Value::I64(n) => J::from(*n),
        Value::U8(n) => J::from(*n),
        Value::U16(n) => J::from(*n),
        Value::U32(n) => J::from(*n),
        Value::U64(n) => J::from(*n),
        Value::F32(f) => serde_json::Number::from_f64(*f as f64).map(J::Number).unwrap_or(J::Null),
        Value::F64(f) => serde_json::Number::from_f64(*f).map(J::Number).unwrap_or(J::Null),
        Value::Str(s) => J::String(s.clone()),
        // dates/decimals/uuid/etc. — stringify (queryable display; refine as needed).
        other => J::String(format!("{other:?}")),
    }
}

/// Run a read query over the user's store; returns `{columns, rows}`.
#[wasm_bindgen]
pub async fn query(namespace: String, sql: String) -> Result<String, JsError> {
    let mut glue = open(&namespace).await?;
    let payloads = glue.execute(&sql).await.map_err(je)?;
    let out = match payloads.into_iter().next() {
        Some(Payload::Select { labels, rows }) => serde_json::json!({
            "columns": labels,
            "rows": rows.iter()
                .map(|r| r.iter().map(value_to_json).collect::<Vec<_>>())
                .collect::<Vec<_>>(),
        }),
        _ => serde_json::json!({ "columns": [], "rows": [] }),
    };
    Ok(out.to_string())
}

/// Drop a table from the user's store.
#[wasm_bindgen]
pub async fn drop_table(namespace: String, table: String) -> Result<(), JsError> {
    let table = ident(&table)?;
    let mut glue = open(&namespace).await?;
    glue.execute(&format!("DROP TABLE IF EXISTS {table}")).await.map_err(je)?;
    Ok(())
}
