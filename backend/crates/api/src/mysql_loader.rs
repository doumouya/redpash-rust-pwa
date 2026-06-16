//! MySQL connector loader — the server-side CONDUIT half of a connector pull.
//! Extract a source table via sqlx → a faithful, type-aware CSV (0 silent-loss) →
//! RETURN the bytes. The caller streams them to the client, whose on-device GlueSQL
//! ingests a queryable table — the customer data NEVER persists on our servers.
//! Ported from the predecessor's mysql_loader (the calibrated extraction is the
//! moat); the only change is the DESTINATION — bytes OUT, not pipeline::upload_csv.
//! v1: a full pull (incremental high-watermark deferred).
//!
//! Security (load-bearing, ported faithfully): host admission routes through
//! `connectors_core::host_gate` (SSRF + remote-must-encrypt — one reviewed copy);
//! connect options are built from DISCRETE components, NEVER a format!'d URL (no
//! userinfo host-smuggling); the optional `where` is an operator-trust boundary with
//! defense-in-depth guards + a LIMIT-0 dry-run; identifiers are backtick-quoted and
//! values are projected by INFORMATION_SCHEMA type so binary/geometry/bit never
//! corrupt; the session is pinned (utf8mb4 / UTC / known sql_mode), SESSION scope only.
#![allow(dead_code)]

use sqlx::mysql::{MySqlConnectOptions, MySqlSslMode};
use sqlx::{Connection, Executor, Row};

use crate::connectors_core::{self, SslMode};
use crate::error::AppError;

fn cfg_err(msg: impl Into<String>) -> AppError {
    AppError::bad_request("connector_cfg", msg)
}
fn pull_err(ctx: &str, e: impl std::fmt::Display) -> AppError {
    AppError::bad_request("connector_pull", format!("{ctx}: {e}"))
}

/// Source connection + table (+ optional column / WHERE pushdown).
pub struct Cfg {
    pub opts: MySqlConnectOptions, // discrete components, never a format!'d URL
    pub database: String,
    pub table: String,
    pub columns: Option<Vec<String>>, // pull only these (None = all); existence-checked in pull()
    pub where_sql: Option<String>,    // operator WHERE predicate (guarded; sanitize_where)
}

/// Map the engine-agnostic `connectors_core::SslMode` to the sqlx `MySqlSslMode`.
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
    /// Build from a connector's `config` JSONB: `{ host, port, user, password,
    /// database, table, ssl_mode?, ssl_ca?, columns?, where? }`. DISCRETE components
    /// only — the legacy full-URL `conn` key is REJECTED (SSRF). Host admission +
    /// remote-must-encrypt go through `connectors_core::host_gate`.
    pub fn from_config(config: &serde_json::Value) -> Result<Self, AppError> {
        let s = |k: &str| config.get(k).and_then(serde_json::Value::as_str).map(str::to_string);
        let database = s("database").ok_or_else(|| cfg_err("'database' is required"))?;
        let table = s("table").ok_or_else(|| cfg_err("'table' is required"))?;
        let columns = config
            .get("columns")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect::<Vec<_>>());
        let where_sql = match s("where") {
            Some(raw) => sanitize_where(&raw)?,
            None => None,
        };
        // SSRF: build from discrete components only; the legacy pre-built URL is refused.
        if s("conn").map(|c| !c.trim().is_empty()).unwrap_or(false) {
            return Err(cfg_err(
                "no pre-built `conn` URL — configure host / port / user / password / database (+ optional ssl_mode)",
            ));
        }
        let host = s("host").unwrap_or_else(|| "127.0.0.1".into());
        // explicit ssl_mode, else loopback→PREFERRED, remote→REQUIRED (no plaintext to a remote).
        let ssl_mode = match s("ssl_mode").as_deref() {
            Some(m) => connectors_core::parse_ssl_mode(m),
            None if connectors_core::is_loopback_host(&host) => SslMode::Preferred,
            None => SslMode::Required,
        };
        // THE security-load-bearing admission decision (shared core): block link-local /
        // metadata in every IP encoding + require encryption for any remote target.
        connectors_core::host_gate(&host, ssl_mode).map_err(|e| AppError::bad_request("connector_host", e))?;
        let port = u16::try_from(config.get("port").and_then(|v| v.as_u64()).unwrap_or(3306)).unwrap_or(3306);
        let user = s("user").unwrap_or_else(|| "root".into());
        // Decrypt the stored secret (v1: AEAD envelope); legacy plaintext passes
        // through. (privacy F-F)
        let pass = crate::crypto::decrypt_secret(&s("password").unwrap_or_default())
            .map_err(|e| AppError::bad_request("connector_secret", e))?;
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
        Ok(Self { opts, database, table, columns, where_sql })
    }
}

/// Backtick-quote a MySQL identifier.
fn qi(ident: &str) -> String {
    format!("`{}`", ident.replace('`', "``"))
}

/// RFC-4180 escape one CSV field; strip NUL (`\0`) — text stores can't hold it, and
/// type-aware projection already keeps real binary out (HEX), so a residual NUL is
/// binary leakage in a text value — drop it rather than fail the pull.
fn csv_field(s: Option<&str>) -> String {
    let Some(v) = s else { return String::new() };
    let v: std::borrow::Cow<str> = if v.contains('\0') { v.replace('\0', "").into() } else { v.into() };
    if v.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.into_owned()
    }
}

/// Apply optional column pushdown to the introspected `(name, data_type)` list (ordinal
/// order, case-insensitive). Applied to the LIVE introspection, so a name that isn't a
/// real column is rejected HERE; the select list only ever emits the qi-quoted
/// introspected name — a bogus/injected entry can never reach the query.
fn select_columns(
    all: Vec<(String, String)>,
    want: &Option<Vec<String>>,
) -> Result<Vec<(String, String)>, AppError> {
    let Some(want) = want else { return Ok(all) };
    if want.is_empty() {
        return Err(cfg_err("'columns' is an empty list — omit it to pull all columns"));
    }
    let have: std::collections::HashSet<String> = all.iter().map(|(n, _)| n.to_ascii_lowercase()).collect();
    let missing: Vec<&str> = want
        .iter()
        .filter(|w| !have.contains(&w.to_ascii_lowercase()))
        .map(String::as_str)
        .collect();
    if !missing.is_empty() {
        return Err(cfg_err(format!("columns {missing:?} not found in source table")));
    }
    let wantset: std::collections::HashSet<String> = want.iter().map(|w| w.to_ascii_lowercase()).collect();
    Ok(all.into_iter().filter(|(n, _)| wantset.contains(&n.to_ascii_lowercase())).collect())
}

/// Validate the optional `where`: trims; empty → None; reject `;`/SQL-comments; cap
/// length. An operator-trust boundary (the operator chose the table + creds), so an
/// arbitrary boolean predicate is by design — these are defense-in-depth guards, and
/// pull() also dry-runs the clause (`… WHERE (<expr>) LIMIT 0`).
fn sanitize_where(raw: &str) -> Result<Option<String>, AppError> {
    let w = raw.trim();
    if w.is_empty() {
        return Ok(None);
    }
    if w.len() > 4096 {
        return Err(cfg_err("'where' is too long (>4096 chars)"));
    }
    if w.contains(';') {
        return Err(cfg_err("'where' must be a single boolean expression (no ';')"));
    }
    if w.contains("--") || w.contains("/*") || w.contains("*/") {
        return Err(cfg_err("'where' must not contain SQL comments"));
    }
    Ok(Some(w.to_string()))
}

/// Render strategy for a column, chosen by its INFORMATION_SCHEMA `DATA_TYPE`, so
/// every value reaches the CSV as faithful, UTF-8-safe text. The ONE place MySQL's
/// type surface is handled — extend it here, never branch elsewhere.
fn project_expr(col: &str, data_type: &str) -> String {
    let q = qi(col);
    match data_type {
        // Spatial → EWKT (`SRID=<n>;<WKT>`) so the SRID survives (plain ST_AsText drops it).
        "geometry" | "point" | "linestring" | "polygon" | "multipoint" | "multilinestring"
        | "multipolygon" | "geometrycollection" => {
            format!("CONCAT('SRID=', ST_SRID({q}), ';', ST_AsText({q})) AS {q}")
        }
        // Binary → HEX (lossless ASCII; CAST AS CHAR would emit invalid UTF-8).
        "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob" => {
            format!("HEX({q}) AS {q}")
        }
        // BIT → its unsigned integer value as text.
        "bit" => format!("CAST(CAST({q} AS UNSIGNED) AS CHAR) AS {q}"),
        // FLOAT (binary32): widen to DOUBLE first so it serializes at full
        // shortest-round-trippable precision (a bare CAST AS CHAR truncates to ~6 digits).
        "float" => format!("CAST(CAST({q} AS DOUBLE) AS CHAR) AS {q}"),
        // Numeric / temporal / char / text / enum / set / json (+ unknown): CAST AS CHAR
        // is faithful text under the pinned utf8mb4 + UTC session.
        _ => format!("CAST({q} AS CHAR) AS {q}"),
    }
}

/// Whether the loader has an explicit, verified strategy for this `DATA_TYPE`. An
/// unrecognized type still extracts (CAST AS CHAR default) but is logged so a new
/// MySQL type surfaces structurally instead of being silently mangled.
fn is_recognized(data_type: &str) -> bool {
    matches!(
        data_type,
        "geometry" | "point" | "linestring" | "polygon" | "multipoint" | "multilinestring"
        | "multipolygon" | "geometrycollection"
        | "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob"
        | "bit"
        | "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint"
        | "decimal" | "numeric" | "float" | "double" | "real"
        | "date" | "time" | "datetime" | "timestamp" | "year"
        | "char" | "varchar" | "tinytext" | "text" | "mediumtext" | "longtext"
        | "enum" | "set" | "json"
    )
}

/// Connect + pin a deterministic, faithful session — utf8mb4, UTC, known sql_mode.
/// SESSION scope ONLY (never GLOBAL/PERSIST: the source's global state is untouched).
async fn connect_pinned(opts: &MySqlConnectOptions) -> Result<sqlx::MySqlConnection, AppError> {
    let mut my = sqlx::MySqlConnection::connect_with(opts)
        .await
        .map_err(|e| pull_err("connect to MySQL source", e))?;
    my.execute("SET NAMES utf8mb4").await.map_err(|e| pull_err("session pin: SET NAMES utf8mb4", e))?;
    my.execute("SET SESSION time_zone = '+00:00'").await.map_err(|e| pull_err("session pin: time_zone", e))?;
    my.execute("SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION'").await.map_err(|e| pull_err("session pin: sql_mode", e))?;
    Ok(my)
}

/// One-shot extract: connect (pinned) → list columns + types (information_schema) →
/// type-aware SELECT → faithful CSV. Returns the CSV bytes for the caller to stream to
/// the client's GlueSQL — never persisted on our servers. v1 buffers via `fetch_all`
/// (row streaming for very large tables is a refinement).
pub async fn pull(cfg: &Cfg) -> Result<Vec<u8>, AppError> {
    let mut my = connect_pinned(&cfg.opts).await?;

    // Columns in ordinal order + DATA_TYPE. CAST AS CHAR: MySQL 8 reports
    // information_schema metadata as BLOB, which sqlx refuses to decode as String.
    let col_rows = sqlx::query(
        "SELECT CAST(column_name AS CHAR) AS column_name, CAST(data_type AS CHAR) AS data_type \
         FROM information_schema.columns \
         WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
    )
    .bind(&cfg.database)
    .bind(&cfg.table)
    .fetch_all(&mut my)
    .await
    .map_err(|e| pull_err("read source schema (information_schema.columns)", e))?;
    // By index (MySQL case-folds result column names); DATA_TYPE normalized lowercase.
    let columns: Vec<(String, String)> = col_rows
        .iter()
        .map(|r| (r.get::<String, _>(0), r.get::<String, _>(1).to_ascii_lowercase()))
        .collect();
    if columns.is_empty() {
        return Err(AppError::not_found(
            "not_found",
            format!("table {}.{} not found or has no columns", cfg.database, cfg.table),
        ));
    }
    let columns = select_columns(columns, &cfg.columns)?;

    // Type-aware projection (identifiers backtick-quoted; binds are values-only).
    let select_list = columns
        .iter()
        .map(|(name, dt)| {
            if !is_recognized(dt) {
                tracing::warn!(data_type = %dt, column = %name, "mysql-pull: unrecognized type — defaulting to CAST AS CHAR");
            }
            project_expr(name, dt)
        })
        .collect::<Vec<_>>()
        .join(", ");
    let from = format!("{}.{}", qi(&cfg.database), qi(&cfg.table));
    let where_clause = match &cfg.where_sql {
        Some(w) => format!(" WHERE ({w})"),
        None => String::new(),
    };
    // Dry-run a configured predicate so a bad clause is a clean error BEFORE the pull.
    if cfg.where_sql.is_some() {
        let dry = format!("SELECT 1 FROM {from}{where_clause} LIMIT 0");
        sqlx::query(&dry)
            .fetch_optional(&mut my)
            .await
            .map_err(|e| AppError::bad_request("connector_where", format!("'where' clause is invalid: {e}")))?;
    }
    let sql = format!("SELECT {select_list} FROM {from}{where_clause}");

    let mut csv = String::new();
    csv.push_str(&columns.iter().map(|(c, _)| csv_field(Some(c))).collect::<Vec<_>>().join(","));
    csv.push('\n');

    let rows = sqlx::query(&sql)
        .fetch_all(&mut my)
        .await
        .map_err(|e| pull_err(&format!("extract {}.{}", cfg.database, cfg.table), e))?;
    for row in &rows {
        let mut line = String::new();
        for (i, (name, _)) in columns.iter().enumerate() {
            if i > 0 {
                line.push(',');
            }
            let v: Option<String> = row
                .try_get(i)
                .map_err(|e| pull_err(&format!("decode {}.{} column {name}", cfg.database, cfg.table), e))?;
            line.push_str(&csv_field(v.as_deref()));
        }
        csv.push_str(&line);
        csv.push('\n');
    }
    let _ = my.close().await;
    Ok(csv.into_bytes())
}
