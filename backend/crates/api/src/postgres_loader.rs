//! Purpose: the **PostgreSQL loader** — extract a table via Rust-native `sqlx` → CSV
//! → `pipeline::upload_csv` (the framework write: RBAC + parse + insert_file + audit).
//! Thin transport like `mysql_loader` / `kafka_loader`: NEVER touches `db::insert_*`
//! directly (connector-through-framework). Runs IN-PROCESS from the connector "Pull"
//! sync endpoint (a sqlx SELECT is quick).
//! Doc: docs/internal/code/backend/api/postgres_loader.md
//!
//! Faithful extraction: every column is projected by its `information_schema`
//! `udt_name`. PostgreSQL's `::text` cast is the universal, lossless text output
//! (numeric is exact, json/jsonb verbatim, arrays as `{…}` literals, enum → label,
//! uuid / inet / ranges / built-in geometric all canonical), so the one place the
//! type surface is handled is `project_expr` — `bytea` → clean `encode(…, 'hex')`,
//! `money` → `::numeric` (drops the locale `$`/grouping), everything else → `::text`.
//! The session is pinned to UTC (`timestamptz` renders in UTC) + `bytea_output=hex`,
//! SESSION scope only (the source's global state is never mutated). Rows stream
//! (no full-table buffer); a decode error is surfaced, never swallowed.
//!
//! Connection security is the shared `connectors_core`: the host/TLS admission gate
//! (loopback any mode; a remote host must encrypt; link-local/metadata refused) + the
//! engine-agnostic `ssl_mode` (mapped here to `PgSslMode`). So Postgres reaches remote
//! sources over TLS (`ssl_mode=required`/`verify_*`, optional `ssl_root_cert`) exactly
//! like the MySQL connector.
#![allow(dead_code)]

use std::path::Path;

use anyhow::{Context, Result};
use futures_util::TryStreamExt;
use sqlx::postgres::{PgConnectOptions, PgSslMode};
use sqlx::{Column, Connection, Executor, PgPool, Row};

use crate::connectors_core;
use crate::pipeline;

/// Source connection + table, plus the user-chosen destination (project +
/// as_user) read from the `connectors` row.
pub struct Cfg {
    pub opts:        PgConnectOptions, // built from discrete components (never a format!'d URL)
    pub database:    String,
    pub schema:      String,
    pub table:       String,
    pub project_rid: String,
    pub as_user:     String,
}

/// Map the engine-agnostic `connectors_core::SslMode` → sqlx `PgSslMode`.
fn pg_ssl_mode(m: connectors_core::SslMode) -> PgSslMode {
    use connectors_core::SslMode::*;
    match m {
        Disabled => PgSslMode::Disable,
        Preferred => PgSslMode::Prefer,
        Required => PgSslMode::Require,
        VerifyCa => PgSslMode::VerifyCa,
        VerifyIdentity => PgSslMode::VerifyFull,
    }
}

impl Cfg {
    /// Build from a persisted connection (CON_… rid). Destination (project +
    /// as_user) is the user's choice on the `connectors` row; the Postgres
    /// connection lives in that row's `config` JSONB as
    /// `{ host, port, user, password, database, schema?, table }`.
    pub async fn from_connection(pool: &PgPool, connection_id: &str) -> Result<Self> {
        let c = crate::db::get_connector_load_cfg(pool, connection_id)
            .await
            .with_context(|| format!("load connector {connection_id}"))?
            .ok_or_else(|| anyhow::anyhow!("connector {connection_id} not found"))?;
        if c.kind != "postgres" {
            anyhow::bail!("connector {connection_id} is kind '{}', not a postgres load target", c.kind);
        }
        let cfg = &c.config;
        let s = |k: &str| cfg.get(k).and_then(serde_json::Value::as_str).map(str::to_string);
        let database = s("database").ok_or_else(|| anyhow::anyhow!("connector config: 'database' required"))?;
        let table    = s("table").ok_or_else(|| anyhow::anyhow!("connector config: 'table' required"))?;
        let schema   = s("schema").unwrap_or_else(|| "public".into());
        // SECURITY (SSRF): discrete components only — NEVER a format!'d
        // `postgres://user:pass@host/…` URL (a crafted user/pass can smuggle a host).
        if s("conn").map(|v| !v.trim().is_empty()).unwrap_or(false) {
            anyhow::bail!(
                "Postgres connector does not accept a pre-built `conn` URL — configure \
                 host / port / user / password / database (loopback only in v1)."
            );
        }
        let host = s("host").unwrap_or_else(|| "127.0.0.1".into());
        // ssl_mode: explicit from config, else loopback→Preferred, remote→Required.
        // The shared gate enforces remote-must-encrypt + the link-local/metadata block.
        let ssl_mode = match s("ssl_mode").as_deref() {
            Some(m) => connectors_core::parse_ssl_mode(m),
            None if connectors_core::is_loopback_host(&host) => connectors_core::SslMode::Preferred,
            None => connectors_core::SslMode::Required,
        };
        connectors_core::host_gate(&host, ssl_mode).map_err(|e| anyhow::anyhow!(e))?;
        let port = u16::try_from(cfg.get("port").and_then(|v| v.as_u64()).unwrap_or(5432)).unwrap_or(5432);
        let user = s("user").unwrap_or_else(|| "postgres".into());
        let pass = s("password").unwrap_or_default();
        let mut opts = PgConnectOptions::new()
            .host(&host)
            .port(port)
            .username(&user)
            .password(&pass)
            .database(&database)
            .ssl_mode(pg_ssl_mode(ssl_mode));
        // CA bundle for verify-ca / verify-full (server-cert validation).
        if let Some(ca) = s("ssl_root_cert").or_else(|| s("ssl_ca")).filter(|c| !c.trim().is_empty()) {
            opts = opts.ssl_root_cert(ca);
        }
        Ok(Self { opts, database, schema, table, project_rid: c.project_id, as_user: c.as_user })
    }
}

/// Double-quote a PostgreSQL identifier (and double embedded quotes).
fn qi(ident: &str) -> String { format!("\"{}\"", ident.replace('"', "\"\"")) }

/// RFC-4180 escape one CSV field.
///
/// Also strips NUL (`\0`): PostgreSQL text/JSONB cannot store it and the framework
/// write (`insert_file`) aborts on it. The source is Postgres so a NUL in a text
/// value is rare, but defense-in-depth for the NUL-breaks-insert class (shared with
/// `mysql_loader`).
fn csv_field(s: Option<&str>) -> String {
    let Some(v) = s else { return String::new() };
    let v: std::borrow::Cow<str> = if v.contains('\0') { v.replace('\0', "").into() } else { v.into() };
    if v.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.into_owned()
    }
}

/// Render strategy for a column, chosen by its `information_schema` `udt_name`, so
/// every value reaches the CSV as faithful UTF-8 text. PG's `::text` is the universal
/// lossless output; this is the one place the type surface is handled — extend it
/// (don't branch elsewhere).
fn project_expr(col: &str, udt: &str) -> String {
    let q = qi(col);
    match udt {
        // bytea `::text` is `\xDEAD…` — `encode(…, 'hex')` is clean hex (parity with mysql HEX).
        "bytea" => format!("encode({q}, 'hex') AS {q}"),
        // money `::text` is locale-formatted ($1,234.56) — `::numeric` is the clean fixed-point value.
        "money" => format!("{q}::numeric::text AS {q}"),
        // geometry/geography (PostGIS): `::text` would emit EWKB hex; ST_AsText gives WKT.
        // Conditional on PostGIS being present (not installed here) — wire when a source has it.
        "geometry" | "geography" => format!("ST_AsText({q}) AS {q}"),
        // Everything else: PG's universal faithful text — numeric (exact), json/jsonb (verbatim),
        // arrays (`{…}`), uuid, boolean, inet/cidr/macaddr, ranges, enum (→label), built-in
        // geometric, all date/time (timestamptz in UTC under the pinned session).
        _ => format!("{q}::text AS {q}"),
    }
}

/// The label for how `project_expr` renders a column — surfaced in the Schema facet.
fn projection_label(udt: &str) -> &'static str {
    match udt {
        "bytea" => "hex",
        "money" => "numeric",
        "geometry" | "geography" => "WKT",
        _ => "text",
    }
}

/// Whether the loader has an explicit, verified strategy for this `udt_name`. An
/// unrecognized type still extracts (via the `::text` default) but is logged so a new
/// Postgres type surfaces structurally instead of being silently assumed. Array types
/// (`udt_name` like `_int4`) are recognized via the leading-underscore convention.
fn is_recognized(udt: &str) -> bool {
    if udt.starts_with('_') {
        return true; // array of a base type — `::text` gives the `{…}` literal
    }
    matches!(
        udt,
        // numeric
        "int2" | "int4" | "int8" | "numeric" | "float4" | "float8" | "money"
        // character
        | "bpchar" | "varchar" | "text" | "char" | "name"
        // boolean
        | "bool"
        // temporal
        | "date" | "time" | "timetz" | "timestamp" | "timestamptz" | "interval"
        // structured
        | "uuid" | "json" | "jsonb" | "xml"
        // binary
        | "bytea"
        // network
        | "inet" | "cidr" | "macaddr" | "macaddr8"
        // bit string
        | "bit" | "varbit"
        // ranges + multiranges
        | "int4range" | "int8range" | "numrange" | "tsrange" | "tstzrange" | "daterange"
        | "int4multirange" | "int8multirange" | "nummultirange" | "tsmultirange"
        | "tstzmultirange" | "datemultirange"
        // built-in geometric
        | "point" | "line" | "lseg" | "box" | "path" | "polygon" | "circle"
        // PostGIS (conditional)
        | "geometry" | "geography"
    )
}

/// One-shot extract: connect (UTC-pinned session) → list columns + udt_names
/// (information_schema) → type-aware `SELECT` → stream rows → CSV →
/// `pipeline::upload_csv`. Returns the new file rid.
pub async fn run(pool: &PgPool, data_dir: &Path, cfg: &Cfg) -> Result<String> {
    let mut pg = connect_pinned(&cfg.opts).await?;

    // Provenance: log the source server profile. Best-effort — never fails the load.
    if let Ok(p) = sqlx::query("SELECT version() AS v, current_setting('TimeZone') AS tz")
        .fetch_one(&mut pg)
        .await
    {
        tracing::info!(
            version = %p.try_get::<String, _>("v").unwrap_or_default(),
            session_time_zone = %p.try_get::<String, _>("tz").unwrap_or_default(),
            "postgres-load: source profile (session pinned UTC / bytea hex)"
        );
    }

    // Columns in ordinal order, with udt_name for type-aware projection.
    let col_rows = sqlx::query(
        "SELECT column_name, udt_name FROM information_schema.columns \
         WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
    )
    .bind(&cfg.schema)
    .bind(&cfg.table)
    .fetch_all(&mut pg)
    .await
    .context("read source schema (information_schema.columns)")?;
    let columns: Vec<(String, String)> = col_rows
        .iter()
        .map(|r| (r.get::<String, _>("column_name"), r.get::<String, _>("udt_name").to_ascii_lowercase()))
        .collect();
    if columns.is_empty() {
        anyhow::bail!("table {}.{} not found or has no columns", cfg.schema, cfg.table);
    }

    // Type-aware projection: faithful, UTF-8-safe text per column.
    let select_list = columns
        .iter()
        .map(|(name, udt)| {
            if !is_recognized(udt) {
                tracing::warn!(udt_name = %udt, column = %name,
                    "postgres-load: unrecognized column type — defaulting to ::text");
            }
            project_expr(name, udt)
        })
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("SELECT {select_list} FROM {}.{}", qi(&cfg.schema), qi(&cfg.table));

    // Header.
    let mut csv = String::new();
    csv.push_str(&columns.iter().map(|(c, _)| csv_field(Some(c))).collect::<Vec<_>>().join(","));
    csv.push('\n');

    // Stream rows (bounded memory). Every projected column decodes as Option<String>;
    // a decode error is SURFACED, never swallowed.
    let mut stream = sqlx::query(&sql).fetch(&mut pg);
    let mut rows = 0usize;
    while let Some(row) = stream
        .try_next()
        .await
        .with_context(|| format!("extract {}.{}", cfg.schema, cfg.table))?
    {
        let mut line = String::new();
        for (i, (name, _)) in columns.iter().enumerate() {
            if i > 0 {
                line.push(',');
            }
            let v: Option<String> = row
                .try_get(i)
                .with_context(|| format!("decode {}.{} column {name}", cfg.schema, cfg.table))?;
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
        project = %cfg.project_rid, table = %cfg.table, "postgres-load: loaded");
    Ok(outcome.rid)
}

/// Connection probe for the "Test connection" action: connect with the secure
/// options (reuses `connect_pinned`, so the SSRF/TLS gate already ran in
/// `from_connection`) + a trivial `SELECT 1`. Read-only — proves creds + host + TLS
/// reachability without pulling data. Mirror of `mysql_loader::probe`.
pub async fn probe(cfg: &Cfg) -> Result<()> {
    let mut pg = connect_pinned(&cfg.opts).await?;
    sqlx::query("SELECT 1").execute(&mut pg).await.context("probe: SELECT 1")?;
    Ok(())
}

/// One ad-hoc read-only query result for the Admin DB Console — columns + rows of display
/// text. This is the console VIEW path (not the faithful CSV-extraction `run`): values render
/// via `to_jsonb`, so any column type displays without knowing the shape up front. A SQL NULL
/// comes back as `None` (distinct from an empty string — the console shows the NULL-vs-empty
/// distinction the CSV path can't).
#[derive(Debug, serde::Serialize)]
pub struct QueryResult {
    pub columns:   Vec<String>,
    pub rows:      Vec<Vec<Option<String>>>,
    pub truncated: bool, // the row cap clipped the result
}

/// Execute an admin's ad-hoc **read-only** SELECT and return up to `limit` rows. Defense in
/// depth (PG18-grounded):
///  1. only a single statement starting with SELECT/WITH is accepted (`guard_select`);
///  2. it runs inside a `READ ONLY` transaction — Postgres itself refuses any write/DDL even
///     if the guard is bypassed;
///  3. `statement_timeout` bounds runtime; the result is `LIMIT`-capped;
///  4. wrapping as a subquery blocks statement-chaining (a subquery is one SELECT).
/// The route is platform-admin gated + audits the statement.
pub async fn query(cfg: &Cfg, sql: &str, limit: i64) -> Result<QueryResult> {
    guard_select(sql)?;
    let cap = limit.clamp(1, 1000);
    let mut pg = connect_pinned(&cfg.opts).await?;

    // Column ORDER from the query's described result — `to_jsonb` keys come back sorted, so
    // they can't carry the SELECT-list order. describe = Parse+Describe (no execution, no
    // writes), run BEFORE the transaction on purpose: a bad-SQL describe (unknown relation /
    // column) then surfaces the REAL Postgres error to the admin, instead of aborting the txn
    // and getting masked as "current transaction is aborted" behind the follow-up fetch — the
    // dogfood bug (runbook 0018). The READ-ONLY txn below is still the execution guarantee.
    let ordered_cols: Vec<String> = (&mut pg)
        .describe(sql)
        .await
        .map_err(|e| anyhow::anyhow!("query failed: {e}"))?
        .columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect();

    pg.execute("BEGIN").await.context("query: begin")?;
    pg.execute("SET TRANSACTION READ ONLY").await.context("query: read only")?;
    pg.execute("SET LOCAL statement_timeout = '30s'").await.context("query: statement_timeout")?;

    // One extra row detects truncation; to_jsonb renders each row as a JSON object.
    let wrapped = format!("SELECT to_jsonb(_q) AS _row FROM ({sql}) AS _q LIMIT {}", cap + 1);
    let fetched = sqlx::query(&wrapped).fetch_all(&mut pg).await;
    let _ = pg.execute("ROLLBACK").await; // read-only — always roll back
    let fetched = fetched.map_err(|e| anyhow::anyhow!("query failed: {e}"))?;

    let mut columns: Vec<String> = ordered_cols;
    let mut rows: Vec<Vec<Option<String>>> = Vec::with_capacity(fetched.len());
    for r in &fetched {
        let obj: serde_json::Value = r.try_get("_row").context("decode row json")?;
        let map = obj.as_object();
        if columns.is_empty() {
            if let Some(m) = map { columns = m.keys().cloned().collect(); } // fallback: sorted jsonb keys
        }
        let row = columns
            .iter()
            .map(|c| map.and_then(|m| m.get(c)).and_then(|v| if v.is_null() { None } else { Some(json_cell(v)) }))
            .collect();
        rows.push(row);
    }
    let truncated = rows.len() > cap as usize;
    rows.truncate(cap as usize);
    Ok(QueryResult { columns, rows, truncated })
}

/// Reject anything that is not a single read-only query. The READ-ONLY transaction is the
/// real guarantee; this is the friendly early error: the statement must begin with SELECT or
/// WITH after stripping leading line (`--`) / block (`/* */`) comments + whitespace.
fn guard_select(sql: &str) -> Result<()> {
    let mut s = sql.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--") {
            s = rest.splitn(2, '\n').nth(1).unwrap_or("").trim_start();
        } else if let Some(rest) = s.strip_prefix("/*") {
            s = rest.splitn(2, "*/").nth(1).unwrap_or("").trim_start();
        } else {
            break;
        }
    }
    let head: String = s.chars().take(6).flat_map(char::to_lowercase).collect();
    if head.starts_with("select") || head.starts_with("with") {
        Ok(())
    } else {
        anyhow::bail!("only read-only SELECT / WITH queries are allowed in the DB console")
    }
}

/// Render a `to_jsonb` value to a display cell. Strings unquoted; numbers/bools as text;
/// nested arrays/objects as compact JSON. SQL NULL is handled as `None` by the caller.
fn json_cell(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Connect with the secure options + pin the SESSION (UTC / bytea hex) — shared by
/// `run` + the introspection readers so every path uses the SAME secure connection
/// (no format!'d URL) and the same faithful session.
async fn connect_pinned(opts: &PgConnectOptions) -> Result<sqlx::PgConnection> {
    let mut pg = sqlx::PgConnection::connect_with(opts).await.context("connect to Postgres source")?;
    pg.execute("SET TIME ZONE 'UTC'").await.context("session pin: time zone UTC")?;
    pg.execute("SET bytea_output = 'hex'").await.context("session pin: bytea_output hex")?;
    // Float fidelity: `extra_float_digits = 3` forces the maximum-precision text output for
    // real/double precision so `::text` round-trips exactly (a value-faithful extraction, the
    // Postgres analog of the mysql connector's FLOAT→DOUBLE fix). PG ≥12 already defaults to a
    // shortest-round-trippable representation, but pinning it explicitly makes the guarantee
    // independent of the source server's `extra_float_digits` setting. SESSION scope only.
    pg.execute("SET extra_float_digits = 3").await.context("session pin: extra_float_digits")?;
    Ok(pg)
}

/// A table in the connected database/schema — the connector's "Tables" facet.
#[derive(serde::Serialize)]
pub struct TableInfo {
    pub name: String,
    pub rows: Option<i64>, // pg_class.reltuples estimate (NULL when unanalyzed)
    pub kind: String,      // "BASE TABLE" | "VIEW"
}

/// A column + the loader's faithful-extraction strategy — the "Schema" facet.
#[derive(serde::Serialize)]
pub struct ColInfo {
    pub name: String,
    pub data_type: String,  // the udt_name (precise type)
    pub nullable: bool,
    pub key: String,        // "" | "PRI" (v1: primary key only)
    pub projection: String, // "hex" | "numeric" | "WKT" | "text"
}

/// List the tables in the connector's schema (information_schema.tables + the
/// pg_class reltuples estimate, which information_schema lacks).
pub async fn list_tables(cfg: &Cfg) -> Result<Vec<TableInfo>> {
    let mut pg = connect_pinned(&cfg.opts).await?;
    let rows = sqlx::query(
        "SELECT t.table_name AS name, \
                c.reltuples::bigint AS n_rows, \
                t.table_type AS kind \
           FROM information_schema.tables t \
           LEFT JOIN pg_namespace ns ON ns.nspname = t.table_schema \
           LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = ns.oid \
          WHERE t.table_schema = $1 \
          ORDER BY t.table_name",
    )
    .bind(&cfg.schema)
    .fetch_all(&mut pg)
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
/// (information_schema.columns + a PK flag from the primary-key constraint).
pub async fn describe_table(cfg: &Cfg, table: &str) -> Result<Vec<ColInfo>> {
    let mut pg = connect_pinned(&cfg.opts).await?;
    let rows = sqlx::query(
        "SELECT c.column_name AS name, c.udt_name AS udt, c.is_nullable AS nullable, \
                (pk.column_name IS NOT NULL) AS is_pk \
           FROM information_schema.columns c \
           LEFT JOIN ( \
                SELECT kcu.column_name \
                  FROM information_schema.table_constraints tc \
                  JOIN information_schema.key_column_usage kcu \
                    ON kcu.constraint_name = tc.constraint_name \
                   AND kcu.table_schema = tc.table_schema \
                 WHERE tc.constraint_type = 'PRIMARY KEY' \
                   AND tc.table_schema = $1 AND tc.table_name = $2 \
           ) pk ON pk.column_name = c.column_name \
          WHERE c.table_schema = $1 AND c.table_name = $2 \
          ORDER BY c.ordinal_position",
    )
    .bind(&cfg.schema)
    .bind(table)
    .fetch_all(&mut pg)
    .await
    .context("read information_schema.columns")?;
    if rows.is_empty() {
        anyhow::bail!("table {}.{} not found or has no columns", cfg.schema, table);
    }
    Ok(rows
        .iter()
        .map(|r| {
            let udt = r.get::<String, _>("udt").to_ascii_lowercase();
            ColInfo {
                projection: projection_label(&udt).to_string(),
                name: r.get::<String, _>("name"),
                nullable: r.try_get::<String, _>("nullable").map(|s| s == "YES").unwrap_or(true),
                key: if r.try_get::<bool, _>("is_pk").unwrap_or(false) { "PRI".to_string() } else { String::new() },
                data_type: udt,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_bytea_as_hex() {
        assert_eq!(project_expr("doc", "bytea"), "encode(\"doc\", 'hex') AS \"doc\"");
    }

    #[test]
    fn projects_money_as_numeric() {
        assert_eq!(project_expr("price", "money"), "\"price\"::numeric::text AS \"price\"");
    }

    #[test]
    fn projects_geometry_as_wkt() {
        assert_eq!(project_expr("g", "geometry"), "ST_AsText(\"g\") AS \"g\"");
    }

    #[test]
    fn projects_scalar_and_array_and_unknown_as_text() {
        assert_eq!(project_expr("n", "numeric"), "\"n\"::text AS \"n\"");
        assert_eq!(project_expr("j", "jsonb"), "\"j\"::text AS \"j\"");
        assert_eq!(project_expr("a", "_int4"), "\"a\"::text AS \"a\"");
        // an unrecognized future type still extracts safely via the default
        assert_eq!(project_expr("x", "some_future_type"), "\"x\"::text AS \"x\"");
    }

    #[test]
    fn recognizes_known_types_and_arrays_flags_unknown() {
        assert!(is_recognized("numeric"));
        assert!(is_recognized("jsonb"));
        assert!(is_recognized("uuid"));
        assert!(is_recognized("_text")); // array
        assert!(is_recognized("tstzrange"));
        assert!(!is_recognized("some_future_type"));
    }

    #[test]
    fn qi_escapes_double_quotes() {
        assert_eq!(qi("plain"), "\"plain\"");
        assert_eq!(qi("a\"b"), "\"a\"\"b\"");
    }

    #[test]
    fn csv_field_escapes_and_strips_nul() {
        assert_eq!(csv_field(Some("plain")), "plain");
        assert_eq!(csv_field(Some("a,b")), "\"a,b\"");
        assert_eq!(csv_field(Some("he \"q\"")), "\"he \"\"q\"\"\"");
        assert_eq!(csv_field(None), "");
        assert_eq!(csv_field(Some("a\0b")), "ab");
    }

    #[test]
    fn guard_accepts_read_only_rejects_writes() {
        assert!(guard_select("SELECT 1").is_ok());
        assert!(guard_select("  select * from users").is_ok());
        assert!(guard_select("WITH t AS (SELECT 1) SELECT * FROM t").is_ok());
        assert!(guard_select("-- a comment\nSELECT 1").is_ok());
        assert!(guard_select("/* block */ select 1").is_ok());
        assert!(guard_select("UPDATE users SET x=1").is_err());
        assert!(guard_select("DELETE FROM users").is_err());
        assert!(guard_select("DROP TABLE users").is_err());
        assert!(guard_select("INSERT INTO users VALUES (1)").is_err());
        assert!(guard_select("TRUNCATE users").is_err());
        assert!(guard_select("").is_err());
    }

    #[test]
    fn json_cell_renders_scalars_and_nested() {
        use serde_json::json;
        assert_eq!(json_cell(&json!("hi")), "hi");
        assert_eq!(json_cell(&json!(42)), "42");
        assert_eq!(json_cell(&json!(true)), "true");
        assert_eq!(json_cell(&json!({"a":1})), "{\"a\":1}");
        assert_eq!(json_cell(&json!([1, 2])), "[1,2]");
    }

    /// Dogfood: run the read-only console query against our OWN app DB. Needs the live
    /// app Postgres at 127.0.0.1:5433. Run explicitly: `cargo test -p api -- --ignored dogfood`.
    #[tokio::test]
    #[ignore]
    async fn dogfood_query_our_own_db() {
        let opts = PgConnectOptions::new()
            .host("127.0.0.1").port(5433)
            .username("mansa").password("mansa")
            .database("redpash_prerelease")
            .ssl_mode(PgSslMode::Prefer);
        let cfg = Cfg {
            opts, database: "redpash_prerelease".into(), schema: "public".into(),
            table: "users".into(), project_rid: String::new(), as_user: String::new(),
        };
        // a real read query against our own data
        let r = query(&cfg, "SELECT redpash_id, username, role FROM users ORDER BY username LIMIT 5", 10)
            .await.expect("query our own users");
        eprintln!("DOGFOOD cols={:?} rows={} truncated={}", r.columns, r.rows.len(), r.truncated);
        assert!(r.columns.iter().any(|c| c == "username"));
        assert!(!r.rows.is_empty());
        // the read-only guard refuses a write
        assert!(query(&cfg, "DELETE FROM users", 10).await.is_err());
        // JSONB round-trips through to_jsonb (a heavy-JSONB table)
        let p = query(&cfg, "SELECT redpash_id, spec FROM project_files WHERE spec IS NOT NULL LIMIT 3", 10)
            .await.expect("query jsonb spec");
        eprintln!("DOGFOOD jsonb cols={:?} rows={}", p.columns, p.rows.len());
        // cross-schema query works (audit.* is a second schema in our DB)
        query(&cfg, "SELECT id FROM audit.run LIMIT 1", 10).await.expect("cross-schema audit.run");
        // regression (runbook 0018): a bad query surfaces the REAL Postgres error, NOT the
        // masked "current transaction is aborted" that the post-BEGIN describe used to produce.
        let err = query(&cfg, "SELECT * FROM does_not_exist_xyz", 10).await.unwrap_err().to_string();
        assert!(err.contains("does not exist"), "expected real relation error, got: {err}");
        assert!(!err.contains("transaction is aborted"), "error was masked: {err}");
    }
}
