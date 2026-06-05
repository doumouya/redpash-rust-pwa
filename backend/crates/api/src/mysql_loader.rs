//! Purpose: the **MySQL loader** — extract a table via Rust-native `sqlx` → CSV →
//! `pipeline::upload_csv` (the framework write: RBAC + parse + insert_file +
//! audit). Thin transport like `kafka_loader`: NEVER touches `db::insert_*`
//! directly (connector-through-framework / connectors-audit). Runs IN-PROCESS
//! from the SheetWise "Pull" sync endpoint (a sqlx SELECT is quick, unlike the
//! Kafka consume which is its own binary mode).
//! Doc: docs/internal/code/backend/api/mysql_loader.md
//!
//! Faithful extraction: every column is projected by its INFORMATION_SCHEMA
//! `DATA_TYPE` (spatial → WKT, binary → hex, bit → int, else CAST AS CHAR) so no
//! type silently corrupts (geometry/binary used to land as garbage). The session
//! is pinned deterministically on connect — utf8mb4 (no charset truncation),
//! `time_zone='+00:00'` (TIMESTAMP in UTC), a known `sql_mode` — all SESSION
//! scope, so the source server's global state is never mutated. Rows stream
//! (no full-table buffering) and a decode error is surfaced, never swallowed.
//! The live source is read-only here (one SELECT); the rows land as a CSV file
//! the customer queries — a safe disposable copy, never the source DB (Em).
#![allow(dead_code)]

use std::path::Path;

use anyhow::{Context, Result};
use futures_util::TryStreamExt;
use sqlx::{Connection, Executor, PgPool, Row};

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
///
/// Also strips NUL (`\0`, U+0000): PostgreSQL text/JSONB cannot store it and the
/// framework write (`insert_file`) aborts with "unsupported Unicode escape
/// sequence". Type-aware projection already keeps real binary out (HEX, not CAST
/// AS CHAR), so a residual NUL is binary leakage in a text value — drop it rather
/// than fail the whole pull. Defense-in-depth for the NUL-breaks-insert class.
fn csv_field(s: Option<&str>) -> String {
    let Some(v) = s else { return String::new() };
    let v: std::borrow::Cow<str> = if v.contains('\0') { v.replace('\0', "").into() } else { v.into() };
    if v.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.into_owned()
    }
}

/// Render strategy for a column, chosen by its INFORMATION_SCHEMA `DATA_TYPE`,
/// so every value reaches the CSV as faithful, UTF-8-safe text. This is the one
/// place MySQL's type surface is handled — extend it (don't branch elsewhere).
fn project_expr(col: &str, data_type: &str) -> String {
    let q = qi(col);
    match data_type {
        // Spatial: stored as internal geometry/WKB — `CAST AS CHAR` would emit raw
        // bytes (invalid UTF-8). ST_AsText gives Well-Known Text, e.g. "POINT(1 2)".
        "geometry" | "point" | "linestring" | "polygon" | "multipoint" | "multilinestring"
        | "multipolygon" | "geometrycollection" => format!("ST_AsText({q}) AS {q}"),
        // Binary: not UTF-8 — HEX keeps every byte losslessly as ASCII hex.
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" => {
            format!("HEX({q}) AS {q}")
        }
        // BIT: a bitfield — render its unsigned integer value as text.
        "bit" => format!("CAST(CAST({q} AS UNSIGNED) AS CHAR) AS {q}"),
        // Numeric / temporal / char / text / enum / set / json (and any unknown
        // type): CAST AS CHAR is faithful text under the pinned utf8mb4 + UTC session.
        _ => format!("CAST({q} AS CHAR) AS {q}"),
    }
}

/// Whether the loader has an explicit, verified strategy for this `DATA_TYPE`. An
/// unrecognized type still extracts (via the `CAST AS CHAR` default) but is logged
/// so a new MySQL type surfaces structurally instead of being silently mangled.
fn is_recognized(data_type: &str) -> bool {
    matches!(
        data_type,
        // spatial
        "geometry" | "point" | "linestring" | "polygon" | "multipoint" | "multilinestring"
        | "multipolygon" | "geometrycollection"
        // binary
        | "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob"
        // bit
        | "bit"
        // numeric
        | "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint"
        | "decimal" | "numeric" | "float" | "double" | "real"
        // temporal
        | "date" | "time" | "datetime" | "timestamp" | "year"
        // string / structured
        | "char" | "varchar" | "tinytext" | "text" | "mediumtext" | "longtext"
        | "enum" | "set" | "json"
    )
}

/// One-shot extract: connect (pinned session) → list columns + types
/// (information_schema) → type-aware `SELECT` → stream rows → CSV →
/// `pipeline::upload_csv`. Returns the new file rid.
pub async fn run(pool: &PgPool, data_dir: &Path, cfg: &Cfg) -> Result<String> {
    // One connection, pinned to a deterministic, faithful session — SESSION scope
    // only (never GLOBAL/PERSIST: the source's global state is never mutated).
    let mut my = sqlx::MySqlConnection::connect(&cfg.conn).await.context("connect to MySQL source")?;
    my.execute("SET NAMES utf8mb4").await.context("session pin: SET NAMES utf8mb4")?;
    my.execute("SET SESSION time_zone = '+00:00'").await.context("session pin: time_zone")?;
    my.execute("SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION'").await.context("session pin: sql_mode")?;

    // Provenance + safety: log the source server profile (and the limits a big
    // pull could hit). Best-effort — never fails the load.
    if let Ok(p) = sqlx::query(
        "SELECT @@version AS v, @@global.time_zone AS tz, @@global.sql_mode AS mode, \
         @@max_allowed_packet AS pkt, @@net_read_timeout AS net_to",
    )
    .fetch_one(&mut my)
    .await
    {
        tracing::info!(
            version = %p.try_get::<String, _>("v").unwrap_or_default(),
            src_time_zone = %p.try_get::<String, _>("tz").unwrap_or_default(),
            src_sql_mode = %p.try_get::<String, _>("mode").unwrap_or_default(),
            max_allowed_packet = p.try_get::<u64, _>("pkt").unwrap_or(0),
            net_read_timeout = p.try_get::<u64, _>("net_to").unwrap_or(0),
            "mysql-load: source profile (session pinned utf8mb4 / UTC)"
        );
    }

    // Columns in ordinal order, with DATA_TYPE for type-aware projection.
    // `CAST(… AS CHAR)`: MySQL 8's information_schema reports metadata columns
    // (notably DATA_TYPE) with a BLOB result type, which sqlx refuses to decode
    // as `String` ("Rust type String … not compatible with SQL type BLOB"). The
    // cast forces a text result so both decode as `String` under the utf8mb4 session.
    let col_rows = sqlx::query(
        "SELECT CAST(column_name AS CHAR) AS column_name, CAST(data_type AS CHAR) AS data_type \
         FROM information_schema.columns \
         WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
    )
    .bind(&cfg.database)
    .bind(&cfg.table)
    .fetch_all(&mut my)
    .await
    .context("read source schema (information_schema.columns)")?;
    // By index (MySQL case-folds the result column names). DATA_TYPE is reported
    // lowercase, but normalize defensively before matching.
    let columns: Vec<(String, String)> = col_rows
        .iter()
        .map(|r| (r.get::<String, _>(0), r.get::<String, _>(1).to_ascii_lowercase()))
        .collect();
    if columns.is_empty() {
        anyhow::bail!("table {}.{} not found or has no columns", cfg.database, cfg.table);
    }

    // Type-aware projection: faithful, UTF-8-safe text for every column. Identifiers
    // are backtick-quoted (binds are values-only).
    let select_list = columns
        .iter()
        .map(|(name, dt)| {
            if !is_recognized(dt) {
                tracing::warn!(data_type = %dt, column = %name,
                    "mysql-load: unrecognized column type — defaulting to CAST AS CHAR");
            }
            project_expr(name, dt)
        })
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("SELECT {select_list} FROM {}.{}", qi(&cfg.database), qi(&cfg.table));

    // Header.
    let mut csv = String::new();
    csv.push_str(&columns.iter().map(|(c, _)| csv_field(Some(c))).collect::<Vec<_>>().join(","));
    csv.push('\n');

    // Stream rows (bounded memory — no full-table `fetch_all`). Every projected
    // column decodes as Option<String>; a decode error is SURFACED, never swallowed.
    let mut stream = sqlx::query(&sql).fetch(&mut my);
    let mut rows = 0usize;
    while let Some(row) = stream
        .try_next()
        .await
        .with_context(|| format!("extract {}.{}", cfg.database, cfg.table))?
    {
        let mut line = String::new();
        for (i, (name, _)) in columns.iter().enumerate() {
            if i > 0 {
                line.push(',');
            }
            let v: Option<String> = row
                .try_get(i)
                .with_context(|| format!("decode {}.{} column {name}", cfg.database, cfg.table))?;
            line.push_str(&csv_field(v.as_deref()));
        }
        csv.push_str(&line);
        csv.push('\n');
        rows += 1;
    }
    drop(stream);

    // Through the framework (RBAC + parse + insert_file + audit) — never db::insert_*.
    // caller_is_admin=false: the as_user's write-reach is checked, no bypass.
    let outcome = pipeline::upload_csv(
        pool, data_dir, &cfg.as_user, false, &cfg.project_rid, &cfg.table, csv.into_bytes(), None,
    )
    .await
    .map_err(|e| anyhow::anyhow!("upload to project: {}", e.message))?;

    tracing::info!(file = %outcome.rid, rows, cols = columns.len(),
        project = %cfg.project_rid, table = %cfg.table, "mysql-load: loaded");
    Ok(outcome.rid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_spatial_as_wkt() {
        assert_eq!(project_expr("location", "geometry"), "ST_AsText(`location`) AS `location`");
        assert_eq!(project_expr("p", "point"), "ST_AsText(`p`) AS `p`");
        assert_eq!(project_expr("g", "geometrycollection"), "ST_AsText(`g`) AS `g`");
    }

    #[test]
    fn projects_binary_as_hex() {
        assert_eq!(project_expr("doc", "longblob"), "HEX(`doc`) AS `doc`");
        assert_eq!(project_expr("b", "varbinary"), "HEX(`b`) AS `b`");
    }

    #[test]
    fn projects_bit_as_unsigned_text() {
        assert_eq!(project_expr("flags", "bit"), "CAST(CAST(`flags` AS UNSIGNED) AS CHAR) AS `flags`");
    }

    #[test]
    fn projects_scalar_and_unknown_as_char() {
        assert_eq!(project_expr("name", "varchar"), "CAST(`name` AS CHAR) AS `name`");
        assert_eq!(project_expr("amt", "decimal"), "CAST(`amt` AS CHAR) AS `amt`");
        assert_eq!(project_expr("g", "enum"), "CAST(`g` AS CHAR) AS `g`");
        // an unrecognized future type still extracts safely via the default
        assert_eq!(project_expr("x", "vector"), "CAST(`x` AS CHAR) AS `x`");
    }

    #[test]
    fn recognizes_known_types_flags_unknown() {
        assert!(is_recognized("geometry"));
        assert!(is_recognized("bigint"));
        assert!(is_recognized("json"));
        assert!(is_recognized("longblob"));
        assert!(!is_recognized("vector"));
        assert!(!is_recognized("some_future_type"));
    }

    #[test]
    fn qi_escapes_backticks() {
        assert_eq!(qi("plain"), "`plain`");
        assert_eq!(qi("a`b"), "`a``b`");
    }

    #[test]
    fn csv_field_escapes_per_rfc4180() {
        assert_eq!(csv_field(Some("plain")), "plain");
        assert_eq!(csv_field(Some("a,b")), "\"a,b\"");
        assert_eq!(csv_field(Some("he \"q\"")), "\"he \"\"q\"\"\"");
        assert_eq!(csv_field(Some("line\nbreak")), "\"line\nbreak\"");
        assert_eq!(csv_field(None), "");
        // NUL is stripped (PostgreSQL text/JSONB cannot store it; would abort insert_file)
        assert_eq!(csv_field(Some("a\0b")), "ab");
        assert_eq!(csv_field(Some("\0\0")), "");
        assert_eq!(csv_field(Some("x\0,y")), "\"x,y\"");
    }
}
