//! Purpose: the **Kafka loader** — the L of ETL (CAS_75A0D1FD follow-on). Runs as
//! a MODE of the main binary (`REDPASH_KAFKA_LOAD=1`), not a `src/bin/` (those
//! can't see main.rs's `codec_avro`/`db`). One-shot batch:
//!   rskafka consume → codec_avro::decode (the avro meta-codec) → records_to_csv
//!   → data::parse + db::insert_file → a project_files row.
//! Doc: docs/internal/code/backend/api/kafka_loader.md
//!
//! Decisions baked in: rskafka (Em 2026-06-01 — rdkafka needs cmake/librdkafka,
//! absent; rskafka is pure-Rust, SASL_SSL-capable for Confluent Cloud). Schema
//! from the connector's saved contract file (data-contract-first). The decoded
//! Avro records land as a CSV-backed file in a project — maximal reuse of the
//! battle-tested upload/import path ([object-model]: all content is a File).
//!
//! The consume is live-cluster + PII; verification of the E hop is a run against
//! the real Confluent cluster (operator's call). The T+L core (records_to_csv +
//! decode→csv→parse) is unit-tested offline.
#![allow(dead_code)]

use std::path::Path;

use anyhow::{Context, Result};
use serde_json::Value;
use sqlx::PgPool;

use crate::codec_avro::{self, WireFormat};

/// Loader run config (from env in the main-binary mode branch).
pub struct Cfg {
    pub bootstrap:     String,
    pub sasl_user:     String,
    pub sasl_password: String,
    pub topic:         String,
    pub max_records:   usize,
    pub project_rid:   String,
    pub contract_path: String,
    pub wire_format:   WireFormat,
}

impl Cfg {
    /// Build from env. Kafka creds reuse the connector's KAFKA_* names.
    pub fn from_env() -> Result<Self> {
        let var = |k: &str| std::env::var(k).with_context(|| format!("{k} not set"));
        Ok(Self {
            bootstrap:     var("KAFKA_BOOTSTRAP")?,
            sasl_user:     var("KAFKA_KEY")?,
            sasl_password: var("KAFKA_SECRET")?,
            topic:         var("KAFKA_TOPIC")?,
            max_records:   std::env::var("KAFKA_MAX_RECORDS").ok().and_then(|s| s.parse().ok()).unwrap_or(500),
            project_rid:   var("KAFKA_TARGET_PROJECT")?,
            contract_path: var("KAFKA_CONTRACT")?,
            wire_format:   WireFormat::from_meta(std::env::var("KAFKA_WIRE_FORMAT").ok().as_deref()),
        })
    }
}

/// Extract the bare Avro schema JSON from a Confluent contract envelope file
/// (`.schema` field), or treat the file as a bare Avro schema if there's no
/// envelope. Data-contract-first: the schema is a checked-in file.
pub fn load_contract_schema(path: &Path) -> Result<String> {
    let raw = std::fs::read_to_string(path).with_context(|| format!("read contract {}", path.display()))?;
    let json: Value = serde_json::from_str(&raw).context("contract is not JSON")?;
    match json.get("schema").and_then(Value::as_str) {
        Some(s) => Ok(s.to_string()), // Confluent envelope: .schema is the avro schema (a JSON string)
        None => Ok(raw),              // already a bare avro schema
    }
}

/// Top-level field names of an Avro record schema, IN ORDER — the CSV column
/// order, so the dataset's columns match the producer's schema.
pub fn schema_field_names(avro_schema_json: &str) -> Result<Vec<String>> {
    let s: Value = serde_json::from_str(avro_schema_json).context("avro schema is not JSON")?;
    let fields = s.get("fields").and_then(Value::as_array).context("avro schema has no fields[]")?;
    Ok(fields
        .iter()
        .filter_map(|f| f.get("name").and_then(Value::as_str).map(str::to_string))
        .collect())
}

/// Flatten decoded records to CSV bytes for the import pipeline. Scalars become
/// cell values; nested arrays/objects (Account.telephone[], …) serialize to a
/// compact JSON string in the cell (the redtable + cleaner can expand later).
/// RFC-4180 quoting. Column order is the schema's.
pub fn records_to_csv(records: &[Value], columns: &[String]) -> String {
    let mut out = String::new();
    out.push_str(&columns.iter().map(|c| csv_field(c)).collect::<Vec<_>>().join(","));
    out.push('\n');
    for rec in records {
        let row = columns
            .iter()
            .map(|col| csv_field(&cell_to_string(rec.get(col).unwrap_or(&Value::Null))))
            .collect::<Vec<_>>()
            .join(",");
        out.push_str(&row);
        out.push('\n');
    }
    out
}

fn cell_to_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        // nested array/object → compact JSON (the cell holds the sub-record).
        other => other.to_string(),
    }
}

fn csv_field(s: &str) -> String {
    if s.contains('"') || s.contains(',') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// The L: write CSV bytes as a project_files row (reuses the upload pipeline —
/// parse → summarize → insert_file). Returns the new file rid.
pub async fn ingest_csv(
    pool:     &PgPool,
    data_dir: &Path,
    project:  &str,
    filename: &str,
    csv:      &[u8],
) -> Result<String> {
    let rid = crate::id::new("FIL");
    let storage_rel = format!("files/{rid}.bin");
    let abs = data_dir.join("files").join(format!("{rid}.bin"));
    std::fs::create_dir_all(abs.parent().unwrap()).ok();
    std::fs::write(&abs, csv).with_context(|| format!("write {}", abs.display()))?;

    let (df, encoding) = data::parse::from_csv_bytes(csv, None).context("parse loaded csv")?;
    let columns = data::dtype::summarize(&df).context("summarize loaded frame")?;
    crate::db::insert_file(
        pool, &rid, project, filename, &encoding,
        df.height() as u64, df.width() as u32, csv.len() as u64, &storage_rel, &columns, None,
    )
    .await
    .context("insert_file")?;
    Ok(rid)
}

/// Consume up to `max_records` raw record VALUES via rskafka (SASL PLAIN over
/// TLS — Confluent Cloud). Walks EVERY partition of the topic from each one's
/// EARLIEST offset (data is spread across partitions; offset 0 is out-of-range
/// once retention has pruned). Returns the raw bytes per record; decode is the
/// caller's (codec_avro). Live-cluster path.
async fn consume_raw(cfg: &Cfg) -> Result<Vec<Vec<u8>>> {
    use rskafka::client::{
        partition::{OffsetAt, UnknownTopicHandling},
        ClientBuilder, Credentials, SaslConfig,
    };
    use std::sync::Arc;

    // TLS is MANDATORY here: SASL PLAIN sends the credentials in cleartext, so it
    // must ride TLS (Confluent Cloud = SASL_SSL). Fail-closed — there is NO
    // plaintext fallback; if the TLS config can't be built, the run errors out
    // rather than leaking creds over the wire.
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .context("tls protocol versions")?
    .with_root_certificates(roots)
    .with_no_client_auth();

    let client = ClientBuilder::new(vec![cfg.bootstrap.clone()])
        .tls_config(Arc::new(tls))
        .sasl_config(SaslConfig::Plain(Credentials::new(
            cfg.sasl_user.clone(),
            cfg.sasl_password.clone(),
        )))
        .build()
        .await
        .context("kafka connect")?;

    // Discover the topic's partitions — the JLR messages are spread across
    // them, so a single-partition fetch (the old partition-0 default) finds
    // nothing (high_watermark = -1).
    let topics = client.list_topics().await.context("list topics")?;
    let topic = topics
        .into_iter()
        .find(|t| t.name == cfg.topic)
        .with_context(|| format!("topic {} not visible to these credentials", cfg.topic))?;
    let mut partitions: Vec<i32> = topic.partitions.into_iter().collect();
    partitions.sort_unstable();
    tracing::info!(topic = %cfg.topic, partitions = ?partitions, "kafka-load: partitions");

    let mut out = Vec::new();
    for pid in partitions {
        if out.len() >= cfg.max_records {
            break;
        }
        let pc = client
            .partition_client(cfg.topic.clone(), pid, UnknownTopicHandling::Error)
            .await
            .with_context(|| format!("partition client {pid}"))?;

        // Start at the partition's REAL earliest (offset 0 is OffsetOutOfRange
        // once retention prunes); stop at the latest (high watermark).
        let earliest = pc.get_offset(OffsetAt::Earliest).await.context("earliest offset")?;
        let latest = pc.get_offset(OffsetAt::Latest).await.context("latest offset")?;
        if earliest >= latest {
            continue; // empty partition
        }
        let mut offset = earliest;
        while offset < latest && out.len() < cfg.max_records {
            let (batch, hwm) = pc
                .fetch_records(offset, 1..1_000_000, 1_000)
                .await
                .with_context(|| format!("fetch partition {pid} @ {offset}"))?;
            if batch.is_empty() {
                break;
            }
            for rec in &batch {
                if let Some(v) = &rec.record.value {
                    out.push(v.clone());
                }
                offset = rec.offset + 1;
                if out.len() >= cfg.max_records {
                    break;
                }
            }
            if offset >= hwm {
                break;
            }
        }
    }
    Ok(out)
}

/// One-shot run: consume → decode → csv → ingest. Logs a summary.
pub async fn run(pool: &PgPool, data_dir: &Path, cfg: &Cfg) -> Result<()> {
    let schema = load_contract_schema(Path::new(&cfg.contract_path))?;
    let columns = schema_field_names(&schema)?;

    let raw = consume_raw(cfg).await?;
    tracing::info!(consumed = raw.len(), topic = %cfg.topic, "kafka-load: consumed");

    let mut records = Vec::with_capacity(raw.len());
    let (mut ok, mut bad) = (0usize, 0usize);
    for bytes in &raw {
        match codec_avro::decode(bytes, &schema, cfg.wire_format) {
            Ok(v) => { records.push(v); ok += 1; }
            Err(e) => { bad += 1; tracing::warn!(error = %e, "kafka-load: decode failed"); }
        }
    }
    tracing::info!(decoded = ok, failed = bad, "kafka-load: decoded");

    if records.is_empty() {
        tracing::warn!("kafka-load: nothing to load");
        return Ok(());
    }

    let csv = records_to_csv(&records, &columns);
    let filename = format!("{}-load", cfg.topic);
    let rid = ingest_csv(pool, data_dir, &cfg.project_rid, &filename, csv.as_bytes()).await?;
    tracing::info!(file = %rid, rows = records.len(), project = %cfg.project_rid, "kafka-load: loaded");
    println!("kafka-load: loaded {} rows into {rid} (project {})", records.len(), cfg.project_rid);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn schema_field_names_in_order() {
        let schema = r#"{"type":"record","name":"R","fields":[
            {"name":"a","type":"string"},{"name":"b","type":["null","string"]},
            {"name":"c","type":{"type":"array","items":"string"}}]}"#;
        assert_eq!(schema_field_names(schema).unwrap(), ["a", "b", "c"]);
    }

    #[test]
    fn csv_quotes_special_chars() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("he said \"hi\""), "\"he said \"\"hi\"\"\"");
        assert_eq!(csv_field("line\nbreak"), "\"line\nbreak\"");
    }

    #[test]
    fn records_to_csv_flattens_nested_as_json() {
        let cols = vec!["accountId".to_string(), "firstName".to_string(), "telephone".to_string()];
        let records = vec![
            json!({"accountId": "ACC-1", "firstName": "Ada", "telephone": [{"phoneNumber": "555,1"}]}),
            json!({"accountId": "ACC-2", "firstName": Value::Null, "telephone": []}),
        ];
        let csv = records_to_csv(&records, &cols);
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "accountId,firstName,telephone");
        // nested array → compact JSON, comma inside → quoted
        assert_eq!(lines[1], "ACC-1,Ada,\"[{\"\"phoneNumber\"\":\"\"555,1\"\"}]\"");
        // null firstName → empty cell; empty array → []
        assert_eq!(lines[2], "ACC-2,,[]");
    }

    #[test]
    fn end_to_end_records_to_loadable_frame() {
        // The T+L bridge offline: decoded records → CSV → the import parser
        // yields a frame with the expected shape (no Kafka, no DB).
        let cols = vec!["accountId".to_string(), "country".to_string()];
        let records = vec![
            json!({"accountId": "ACC-1", "country": "GB"}),
            json!({"accountId": "ACC-2", "country": "DE"}),
        ];
        let csv = records_to_csv(&records, &cols);
        let (df, _enc) = data::parse::from_csv_bytes(csv.as_bytes(), None).expect("parse csv");
        assert_eq!(df.height(), 2);
        assert_eq!(df.width(), 2);
        let summary = data::dtype::summarize(&df).expect("summarize");
        assert_eq!(summary.len(), 2);
    }

    #[test]
    fn load_contract_schema_unwraps_envelope() {
        let envelope = r#"{"subject":"x","version":2,"id":100003,
            "schema":"{\"type\":\"record\",\"name\":\"R\",\"fields\":[{\"name\":\"a\",\"type\":\"string\"}]}"}"#;
        let s = serde_json::from_str::<Value>(&{
            let tmp = std::env::temp_dir().join("rp-kload-contract-test.json");
            std::fs::write(&tmp, envelope).unwrap();
            let got = load_contract_schema(&tmp).unwrap();
            std::fs::remove_file(&tmp).ok();
            got
        })
        .unwrap();
        assert_eq!(s["name"], "R");
    }
}
