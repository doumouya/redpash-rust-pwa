//! Doc: docs/internal/code/backend/api/routes/demo.md
//! `/api/demo` — the public landing-page "parse any CSV" demo.
//!
//! `POST /api/demo/parse` takes a raw CSV body, parses + cleanness-
//! scores it entirely in memory, and returns the score. **No auth,
//! nothing stored, no file row** — it exists to show a visitor what
//! RedPash sees in their messiest file, then funnel them to sign-up.
//!
//! The body is capped small here — the workspace-wide 256 MiB limit is
//! for real authenticated uploads, not an anonymous demo endpoint.

use std::time::Instant;

use axum::{body::Bytes, extract::DefaultBodyLimit, http::StatusCode, routing::post, Json, Router};
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::{codec_avro, error::AppError, state::AppState};

/// 4 MiB — a demo file, not a real dataset.
const DEMO_MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Serialize)]
struct DemoResult {
    rows:            usize,
    columns:         usize,
    /// Blended cleanness score, 0–100 — AFTER the structure-suspicion penalty,
    /// so a "looks clean" file that's actually mis-delimited/truncated/binary
    /// doesn't read ≈100.
    score:           f64,
    /// The pre-penalty cleanness score (type/null quality only).
    score_raw:       f64,
    /// Structure-suspicion flags (delimiter/line-ending/binary/header/ragged).
    structure:       data::structure::StructureFlags,
    /// String columns whose values are really numbers / dates / bools.
    type_mismatches: usize,
    /// Empty cells as a percentage of the whole grid.
    empty_pct:       f64,
    parse_ms:        u64,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/parse", post(parse))
        .route("/avro-decode", post(avro_decode))
        .route("/validate", post(validate_demo))
        // 4 MiB cap on the whole router → over-limit bodies become 413.
        .layer(DefaultBodyLimit::max(DEMO_MAX_BYTES))
}

#[derive(Deserialize)]
struct AvroDecodeBody {
    /// The writer Avro schema, as a JSON string.
    schema:       String,
    /// "raw" (bare Avro) | "confluent" ({0x00, 4-byte schema_id} framing).
    wire_format:  String,
    /// The message bytes, base64-encoded (standard alphabet).
    bytes_base64: String,
}

#[derive(Serialize)]
struct AvroDecodeResult {
    decoded:    serde_json::Value,
    decode_ms:  u64,
    byte_count: usize,
}

/// `POST /api/demo/avro-decode` — decode an Avro payload against a supplied
/// schema, in memory, no auth (the adversarial-testing sibling of `/parse`;
/// drives Gemini Suite #2 at [codec_avro](../codec_avro.md) without Kafka).
/// 400 = bad body / base64 / wire_format / schema; 422 = decode mismatch;
/// 413 = body over 4 MiB (the router's DefaultBodyLimit).
async fn avro_decode(Json(body): Json<AvroDecodeBody>) -> Result<Json<AvroDecodeResult>, AppError> {
    // wire_format (400)
    let wire = match body.wire_format.as_str() {
        "raw" => codec_avro::WireFormat::Raw,
        "confluent" => codec_avro::WireFormat::Confluent,
        other => {
            return Err(AppError::bad_request(
                "wire_format",
                format!("must be \"raw\" or \"confluent\", got {other:?}"),
            ))
        }
    };
    // base64 → bytes (400)
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(body.bytes_base64.trim())
        .map_err(|e| AppError::bad_request("bytes_base64", format!("invalid base64: {e}")))?;
    // schema must parse (400) — distinct from a schema/bytes mismatch (422)
    codec_avro::validate_schema(&body.schema).map_err(|e| AppError::bad_request("schema", e))?;

    // decode_guarded is crash-safe: a recursive schema is byte-capped + run on a
    // big-stack thread (recursion-bomb guard), a non-recursive schema decodes
    // uncapped. Runs off the async runtime (it blocks on its decode thread). A
    // recursion-bomb / mismatch → 422; the 4 MiB router body cap covers oversize → 413.
    let byte_count = bytes.len();
    let started = Instant::now();
    let schema = body.schema.clone();
    let decoded = tokio::task::spawn_blocking(move || codec_avro::decode_guarded(&bytes, &schema, wire))
        .await
        .map_err(|e| AppError::internal("join", e.to_string()))?
        .map_err(|e| AppError {
            status:  StatusCode::UNPROCESSABLE_ENTITY,
            kind:    "decode_failed",
            message: e,
            inner:   None,
        })?;

    Ok(Json(AvroDecodeResult {
        decoded,
        decode_ms: started.elapsed().as_millis() as u64,
        byte_count,
    }))
}

/// `POST /api/demo/parse` — parse + score a CSV, in memory, no auth.
async fn parse(body: Bytes) -> Result<Json<DemoResult>, AppError> {
    if body.is_empty() {
        return Err(AppError::bad_request("empty", "no CSV content"));
    }

    let result = tokio::task::spawn_blocking(move || -> Result<DemoResult, data::DataError> {
        let started = Instant::now();
        let (df, _enc) = data::parse::from_csv_bytes(body.as_ref(), None)?;
        let cols = data::dtype::summarize(&df)?;
        let parse_ms = started.elapsed().as_millis() as u64;

        // Eval against the canonical sentinel set only (`&[]`), same as
        // the score_dir harness — keeps the demo score reproducible.
        let score_raw = data::stats::cleanness_report(&df, &cols, &[])
            .map(|r| r.score as f64)
            .unwrap_or(0.0);

        // Structure suspicion: a clean type/null score lies when the file was
        // silently mis-delimited / truncated / decoded-from-binary / mis-headered.
        // Penalize so a cursed file can't read ≈100, and surface the reasons.
        let structure = data::structure::detect(body.as_ref(), &df);
        let score = (score_raw - structure.penalty() as f64).max(0.0);

        // Type drift — a string column that's really numeric / date /
        // bool: the dirt the cleaner fixes.
        let type_mismatches = cols
            .iter()
            .filter(|c| {
                c.dtype == "string"
                    && matches!(c.semantic_dtype.as_str(), "int" | "float" | "date" | "bool")
            })
            .count();

        // Empty-cell fraction across the whole grid.
        let total_cells = df.width() * df.height();
        let empty_cells: usize = df.get_columns().iter().map(|s| s.null_count()).sum();
        let empty_pct = if total_cells > 0 {
            empty_cells as f64 / total_cells as f64 * 100.0
        } else {
            0.0
        };

        Ok(DemoResult {
            rows: df.height(),
            columns: df.width(),
            score,
            score_raw,
            structure,
            type_mismatches,
            empty_pct,
            parse_ms,
        })
    })
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))??;

    Ok(Json(result))
}

// ── POST /api/demo/validate — the field-validation adversarial surface ──
// The twin of `/parse`: the open target for `tools/wasm-bench/validate-calibration.py`
// and a Copilot/Gemini field-validation challenge surface. Stateless, no auth,
// nothing stored. Runs the §v2 two-tier pipeline (validate_rules::validate_value)
// and returns the FieldOutcome — 400 when Tier-1 errors exist, else 200 with
// Tier-2 warnings + confidence.

/// Default field key when the caller doesn't name one.
fn default_field() -> String {
    "field".to_string()
}

#[derive(Deserialize)]
struct ValidateBody {
    /// The field's codec id (e.g. "int", "string", "decimal").
    data_type: String,
    /// Enum options (for the `enum` codec).
    #[serde(default)]
    options:   Vec<String>,
    /// The field key (used in error/warning messages + as the row slot for
    /// cross-field expressions).
    #[serde(default = "default_field")]
    field:     String,
    /// The §v2 validate rules to apply.
    #[serde(default)]
    rules:     Vec<shared::type_def::ValidateRule>,
    /// The proposed value under test.
    value:     serde_json::Value,
    /// Sibling field values for cross-field (`expression`) rules. The handler
    /// always inserts `field -> value` so an expression sees the value under
    /// test, even if the caller omits it here.
    #[serde(default)]
    row:       std::collections::BTreeMap<String, serde_json::Value>,
}

async fn validate_demo(
    Json(body): Json<ValidateBody>,
) -> (StatusCode, Json<crate::validate_rules::FieldOutcome>) {
    let mut row = body.row;
    row.insert(body.field.clone(), body.value.clone());
    let opts: Vec<&str> = body.options.iter().map(String::as_str).collect();
    let outcome = crate::validate_rules::validate_value(
        &body.data_type,
        &opts,
        &body.field,
        &body.rules,
        &body.value,
        &row,
    );
    let status = if outcome.is_ok() { StatusCode::OK } else { StatusCode::BAD_REQUEST };
    (status, Json(outcome))
}
