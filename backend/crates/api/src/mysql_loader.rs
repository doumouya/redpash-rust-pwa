//! Purpose: the **MySQL loader** — extract a table via Rust-native `sqlx` → CSV →
//! `pipeline::upload_csv` (the framework write: RBAC + parse + insert_file +
//! audit). Thin transport like `kafka_loader`: NEVER touches `db::insert_*`
//! directly (connector-through-framework / connectors-audit). Runs IN-PROCESS
//! from the SheetWise "Pull" sync endpoint (a sqlx SELECT is quick, unlike the
//! Kafka consume which is its own binary mode).
//! Doc: docs/internal/code/backend/api/mysql_loader.md
//!
//! The live source is read-only here (one SELECT); the rows land as a CSV file
//! the customer queries — a safe disposable copy, never the source DB (Em). Every
//! column is `CAST … AS CHAR` so arbitrary schemas decode uniformly as strings.
#![allow(dead_code)]

use std::path::Path;

use anyhow::{Context, Result};
use sqlx::{PgPool, Row};

use crate::pipeline;

/// Source connection + table, plus the user-chosen destination (project +
/// as_user) read from the `connectors` row.
pub struct Cfg {
    pub conn:        String, // mysql://user:pass@host:port/db
    pub database:    String,
    pub table:       String,
    pub project_rid: String,
    pub as_user:     String,
}

impl Cfg {
    /// Build from a persisted connection (CON_… rid). Destination (project +
    /// as_user) is the user's choice on the `connectors` row; the MySQL
    /// connection lives in that row's `config` JSONB (localhost v1) as either
    /// `{ conn, database, table }` or `{ host, port, user, password, database, table }`.
    pub async fn from_connection(pool: &PgPool, connection_id: &str) -> Result<Self> {
        let c = crate::db::get_connector_load_cfg(pool, connection_id)
            .await
            .with_context(|| format!("load connector {connection_id}"))?
            .ok_or_else(|| anyhow::anyhow!("connector {connection_id} not found"))?;
        if c.kind != "mysql" {
            anyhow::bail!("connector {connection_id} is kind '{}', not a mysql load target", c.kind);
        }
        let cfg = &c.config;
        let s = |k: &str| cfg.get(k).and_then(serde_json::Value::as_str).map(str::to_string);
        let database = s("database").ok_or_else(|| anyhow::anyhow!("connector config: 'database' required"))?;
        let table    = s("table").ok_or_else(|| anyhow::anyhow!("connector config: 'table' required"))?;
        let conn = match s("conn") {
            Some(c) if !c.trim().is_empty() => c,
            _ => {
                let host = s("host").unwrap_or_else(|| "127.0.0.1".into());
                // v1 is localhost-only. ssl-mode=DISABLED (plaintext) is acceptable
                // ONLY for loopback — a remote host over plaintext would leak the
                // credentials + the data, so reject it until a sqlx TLS feature lands
                // (then default to ssl-mode=REQUIRED). Guards the security finding.
                let loopback = matches!(host.as_str(), "127.0.0.1" | "::1" | "localhost")
                    || host.starts_with("127.");
                if !loopback {
                    anyhow::bail!(
                        "MySQL connector v1 is localhost-only — host '{host}' is remote, which would \
                         transport credentials + data in plaintext (ssl-mode=DISABLED). Enable a sqlx \
                         TLS feature (runtime-tokio-rustls + tls-rustls) and ssl-mode=REQUIRED before \
                         connecting to a remote MySQL."
                    );
                }
                let port = cfg.get("port").and_then(|v| v.as_u64()).unwrap_or(3306);
                let user = s("user").unwrap_or_else(|| "root".into());
                let pass = s("password").unwrap_or_default();
                format!("mysql://{user}:{pass}@{host}:{port}/{database}?ssl-mode=DISABLED")
            }
        };
        Ok(Self { conn, database, table, project_rid: c.project_id, as_user: c.as_user })
    }
}

/// Backtick-quote a MySQL identifier.
fn qi(ident: &str) -> String { format!("`{}`", ident.replace('`', "``")) }

/// RFC-4180 escape one CSV field.
fn csv_field(s: Option<&str>) -> String {
    match s {
        None => String::new(),
        Some(v) if v.contains([',', '"', '\n', '\r']) => format!("\"{}\"", v.replace('"', "\"\"")),
        Some(v) => v.to_string(),
    }
}

/// One-shot extract: connect → list columns (information_schema) → `SELECT` with
/// every column `CAST … AS CHAR` (uniform string decode for any source type) →
/// build CSV → `pipeline::upload_csv`. Returns the new file rid.
pub async fn run(pool: &PgPool, data_dir: &Path, cfg: &Cfg) -> Result<String> {
    let my = sqlx::MySqlPool::connect(&cfg.conn).await.context("connect to MySQL source")?;

    let col_rows = sqlx::query(
        "SELECT column_name FROM information_schema.columns \
         WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
    )
    .bind(&cfg.database)
    .bind(&cfg.table)
    .fetch_all(&my)
    .await
    .context("read source schema (information_schema.columns)")?;
    let columns: Vec<String> = col_rows.iter().map(|r| r.get::<String, _>("column_name")).collect();
    if columns.is_empty() {
        anyhow::bail!("table {}.{} not found or has no columns", cfg.database, cfg.table);
    }

    // CAST every column to CHAR so each value reads uniformly as Option<String>
    // (no per-type decode). Identifiers are backtick-quoted (binds are values-only).
    let select_list = columns.iter()
        .map(|c| format!("CAST({} AS CHAR) AS {}", qi(c), qi(c)))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("SELECT {select_list} FROM {}.{}", qi(&cfg.database), qi(&cfg.table));
    let rows = sqlx::query(&sql).fetch_all(&my).await
        .with_context(|| format!("extract {}.{}", cfg.database, cfg.table))?;

    let mut csv = String::new();
    csv.push_str(&columns.iter().map(|c| csv_field(Some(c))).collect::<Vec<_>>().join(","));
    csv.push('\n');
    for row in &rows {
        let line = (0..columns.len())
            .map(|i| {
                let v: Option<String> = row.try_get::<Option<String>, _>(i).ok().flatten();
                csv_field(v.as_deref())
            })
            .collect::<Vec<_>>()
            .join(",");
        csv.push_str(&line);
        csv.push('\n');
    }

    // Through the framework (RBAC + parse + insert_file + audit) — never db::insert_*.
    // caller_is_admin=false: the as_user's write-reach is checked, no bypass.
    let outcome = pipeline::upload_csv(
        pool, data_dir, &cfg.as_user, false, &cfg.project_rid, &cfg.table, csv.into_bytes(), None,
    )
    .await
    .map_err(|e| anyhow::anyhow!("upload to project: {}", e.message))?;

    tracing::info!(file = %outcome.rid, rows = rows.len(), cols = columns.len(),
        project = %cfg.project_rid, table = %cfg.table, "mysql-load: loaded");
    Ok(outcome.rid)
}
