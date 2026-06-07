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
use sqlx::mysql::{MySqlConnectOptions, MySqlSslMode};
use sqlx::{Connection, Executor, PgPool, Row};

use crate::connectors_core::{self, SslMode};
use crate::pipeline;

/// Source connection + table, plus the user-chosen destination (project +
/// as_user) read from the `connectors` row.
pub struct Cfg {
    pub opts:        MySqlConnectOptions, // built from discrete components (never a format!'d URL)
    pub database:    String,
    pub table:       String,
    pub project_rid: String,
    pub as_user:     String,
}

/// Map the engine-agnostic `connectors_core::SslMode` to the sqlx `MySqlSslMode`.
/// The host/TLS admission gate (SSRF + remote-must-encrypt) + the `ssl_mode` parse
/// now live ONCE in `connectors_core` — shared with `postgres_loader`, so the SSRF
/// rule set (incl. the IPv4-mapped / embedded-v4 / NAT64 / zoned encodings) has one
/// reviewed copy, not a per-loader divergence. See CAS_A0BDFCED / runbook 0012.
fn mysql_ssl_mode(m: SslMode) -> MySqlSslMode {
    match m {
        SslMode::Disabled => MySqlSslMode::Disabled,
        SslMode::Preferred => MySqlSslMode::Preferred,
        SslMode::Required => MySqlSslMode::Required,
        SslMode::VerifyCa => MySqlSslMode::VerifyCa,
        SslMode::VerifyIdentity => MySqlSslMode::VerifyIdentity,
    }
}

impl Cfg {
    /// Build from a persisted connection (CON_… rid). Destination (project +
    /// as_user) is the user's choice on the `connectors` row; the MySQL connection
    /// lives in that row's `config` JSONB as `{ host, port, user, password, database,
    /// table, ssl_mode?, ssl_ca? }` (loopback or remote-over-TLS — see `host_tls_gate`).
    /// The legacy `conn` full-URL key is rejected (SSRF).
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
        // SECURITY (SSRF): build connect options from DISCRETE components — NEVER a
        // format!'d `mysql://user:pass@host/…` URL, where a crafted user/pass can
        // smuggle a different host through the userinfo. The legacy `conn` full-URL
        // config key is rejected: unused by the live flow and an unbounded host vector.
        // Host admission (loopback-vs-remote + link-local/metadata block, in every IP
        // encoding) + remote-must-encrypt is delegated to `connectors_core::host_gate`,
        // the ONE reviewed copy shared with postgres_loader (CAS_A0BDFCED / runbook 0012).
        if s("conn").map(|c| !c.trim().is_empty()).unwrap_or(false) {
            anyhow::bail!(
                "MySQL connector does not accept a pre-built `conn` URL — configure \
                 host / port / user / password / database (+ optional ssl_mode)."
            );
        }
        let host = s("host").unwrap_or_else(|| "127.0.0.1".into());
        // ssl_mode: explicit from config, else loopback→PREFERRED (works whether or not the
        // local server has TLS), remote→REQUIRED (no plaintext fallback to a remote host).
        let ssl_mode = match s("ssl_mode").as_deref() {
            Some(m) => connectors_core::parse_ssl_mode(m),
            None if connectors_core::is_loopback_host(&host) => SslMode::Preferred,
            None => SslMode::Required,
        };
        // The one security-load-bearing admission decision (shared core): block
        // link-local / metadata hosts always + require encryption for any remote target.
        connectors_core::host_gate(&host, ssl_mode).map_err(|e| anyhow::anyhow!(e))?;
        let port = u16::try_from(cfg.get("port").and_then(|v| v.as_u64()).unwrap_or(3306)).unwrap_or(3306);
        let user = s("user").unwrap_or_else(|| "root".into());
        let pass = s("password").unwrap_or_default();
        let mut opts = MySqlConnectOptions::new()
            .host(&host)
            .port(port)
            .username(&user)
            .password(&pass)
            .database(&database)
            .ssl_mode(mysql_ssl_mode(ssl_mode));
        if let Some(ca) = s("ssl_ca").filter(|c| !c.trim().is_empty()) {
            opts = opts.ssl_ca(ca); // CA bundle path for VERIFY_CA / VERIFY_IDENTITY
        }
        Ok(Self { opts, database, table, project_rid: c.project_id, as_user: c.as_user })
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
    let mut my = connect_pinned(&cfg.opts).await?;

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

/// Connect with the secure options + pin the SESSION (utf8mb4 / UTC / known
/// sql_mode) — shared by `run` + the introspection readers so every path uses the
/// SAME secure connection (no format!'d URL) and the same faithful session.
async fn connect_pinned(opts: &MySqlConnectOptions) -> Result<sqlx::MySqlConnection> {
    let mut my = sqlx::MySqlConnection::connect_with(opts).await.context("connect to MySQL source")?;
    my.execute("SET NAMES utf8mb4").await.context("session pin: SET NAMES utf8mb4")?;
    my.execute("SET SESSION time_zone = '+00:00'").await.context("session pin: time_zone")?;
    my.execute("SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION'").await.context("session pin: sql_mode")?;
    Ok(my)
}

/// A table in the connected database — the connector's "Tables" facet.
#[derive(serde::Serialize)]
pub struct TableInfo {
    pub name: String,
    pub rows: Option<i64>, // information_schema estimate (NULL for views / some engines)
    pub kind: String,      // "BASE TABLE" | "VIEW"
}

/// A column + the loader's faithful-extraction strategy — the "Schema" facet.
#[derive(serde::Serialize)]
pub struct ColInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub key: String,        // "" | "PRI" | "UNI" | "MUL"
    pub projection: String, // how run() extracts it: "WKT" | "HEX" | "int" | "text"
}

/// The label for how `project_expr` renders a column type — surfaced in the Schema
/// facet so the user sees the faithful-extraction strategy (geometry → WKT, etc.).
fn projection_label(data_type: &str) -> &'static str {
    match data_type {
        "geometry" | "point" | "linestring" | "polygon" | "multipoint" | "multilinestring"
        | "multipolygon" | "geometrycollection" => "WKT",
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" => "HEX",
        "bit" => "int",
        _ => "text",
    }
}

/// List the tables in the connector's database (information_schema.tables). The
/// `table_name` / `table_type` metadata columns are CAST AS CHAR (MySQL 8 reports
/// them as BLOB; sqlx won't decode BLOB as String); `table_rows` CAST AS SIGNED.
pub async fn list_tables(cfg: &Cfg) -> Result<Vec<TableInfo>> {
    let mut my = connect_pinned(&cfg.opts).await?;
    // `rows` is RESERVED in MySQL 8 (window functions) — alias the count `n_rows`.
    let rows = sqlx::query(
        "SELECT CAST(table_name AS CHAR) AS name, CAST(table_rows AS SIGNED) AS n_rows, \
         CAST(table_type AS CHAR) AS kind \
         FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name",
    )
    .bind(&cfg.database)
    .fetch_all(&mut my)
    .await
    .context("list information_schema.tables")?;
    Ok(rows
        .iter()
        .map(|r| TableInfo {
            name: r.get::<String, _>("name"),
            rows: r.try_get::<Option<i64>, _>("n_rows").unwrap_or(None),
            kind: r.try_get::<String, _>("kind").unwrap_or_default(),
        })
        .collect())
}

/// Describe a table's columns + the loader's projection strategy per column
/// (information_schema.columns). `table` is any table in the connected database —
/// the Schema facet can inspect a table without pulling it.
pub async fn describe_table(cfg: &Cfg, table: &str) -> Result<Vec<ColInfo>> {
    let mut my = connect_pinned(&cfg.opts).await?;
    let rows = sqlx::query(
        "SELECT CAST(column_name AS CHAR) AS name, CAST(data_type AS CHAR) AS data_type, \
         CAST(is_nullable AS CHAR) AS nullable, CAST(column_key AS CHAR) AS col_key \
         FROM information_schema.columns WHERE table_schema = ? AND table_name = ? \
         ORDER BY ordinal_position",
    )
    .bind(&cfg.database)
    .bind(table)
    .fetch_all(&mut my)
    .await
    .context("read information_schema.columns")?;
    if rows.is_empty() {
        anyhow::bail!("table {}.{} not found or has no columns", cfg.database, table);
    }
    Ok(rows
        .iter()
        .map(|r| {
            let dt = r.get::<String, _>("data_type").to_ascii_lowercase();
            ColInfo {
                projection: projection_label(&dt).to_string(),
                name: r.get::<String, _>("name"),
                nullable: r.try_get::<String, _>("nullable").map(|s| s == "YES").unwrap_or(true),
                key: r.try_get::<String, _>("col_key").unwrap_or_default(),
                data_type: dt,
            }
        })
        .collect())
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

    #[test]
    fn maps_core_ssl_mode_to_sqlx() {
        // The gate + parse + SSRF rules are tested in connectors_core; here we only
        // own the SslMode -> MySqlSslMode mapping.
        assert!(matches!(mysql_ssl_mode(SslMode::Disabled), MySqlSslMode::Disabled));
        assert!(matches!(mysql_ssl_mode(SslMode::Preferred), MySqlSslMode::Preferred));
        assert!(matches!(mysql_ssl_mode(SslMode::Required), MySqlSslMode::Required));
        assert!(matches!(mysql_ssl_mode(SslMode::VerifyCa), MySqlSslMode::VerifyCa));
        assert!(matches!(mysql_ssl_mode(SslMode::VerifyIdentity), MySqlSslMode::VerifyIdentity));
    }

    // Live TLS proof against the local MySQL bench (8.4, redpash/redpash, self-signed
    // cert). Ignored by default — needs the bench up; run with:
    //   cargo test -p api mysql_tls_live -- --ignored --nocapture
    // Asserts our sqlx + rustls path actually negotiates TLS (non-empty Ssl_cipher) at
    // ssl_mode=REQUIRED — the mode the remote gate now allows off-loopback.
    #[tokio::test]
    #[ignore]
    async fn mysql_tls_live_required_negotiates() {
        let opts = MySqlConnectOptions::new()
            .host("127.0.0.1")
            .port(3306)
            .username("redpash")
            .password("redpash")
            .ssl_mode(MySqlSslMode::Required);
        let mut my = connect_pinned(&opts).await.expect("TLS connect to bench");
        let cipher: String = sqlx::query("SHOW SESSION STATUS LIKE 'Ssl_cipher'")
            .fetch_one(&mut my)
            .await
            .expect("Ssl_cipher status")
            .get::<String, _>(1);
        assert!(!cipher.is_empty(), "expected an active TLS cipher, got empty (plaintext)");
    }
}
