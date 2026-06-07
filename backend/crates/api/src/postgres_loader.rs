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
use sqlx::{Connection, Executor, PgPool, Row};

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

/// Connect with the secure options + pin the SESSION (UTC / bytea hex) — shared by
/// `run` + the introspection readers so every path uses the SAME secure connection
/// (no format!'d URL) and the same faithful session.
async fn connect_pinned(opts: &PgConnectOptions) -> Result<sqlx::PgConnection> {
    let mut pg = sqlx::PgConnection::connect_with(opts).await.context("connect to Postgres source")?;
    pg.execute("SET TIME ZONE 'UTC'").await.context("session pin: time zone UTC")?;
    pg.execute("SET bytea_output = 'hex'").await.context("session pin: bytea_output hex")?;
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
}
