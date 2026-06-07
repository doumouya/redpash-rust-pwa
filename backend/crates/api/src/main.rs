//! Doc: docs/internal/code/backend/api/main.md
//! `redpash-api` — HTTP entrypoint.
//!
//! Boots in three steps:
//!   1. load `.env` (DATABASE_URL, REDPASH_BIND, …) — silent if file missing
//!   2. init `tracing-subscriber` from RUST_LOG (default `info`)
//!   3. build the Axum router from `routes::router()` and serve until SIGTERM
//!
//! Routes live under `src/routes/`. This file should stay tiny — it is
//! just plumbing.

mod bootstrap;
mod db;
mod db_query;
mod error;
mod event;
mod id;
// RBAC enforcement: the effective-access resolver + view gate (P2 wires
// `case.view`; effective_role / Role expand as more atoms are gated).
#[allow(dead_code)]
mod rbac;
// Open codec registry + avro meta-codec decode (CAS_75A0D1FD) + the Kafka
// loader (ETL L hop). Each carries its own module-level allow(dead_code) for
// the not-yet-wired generic-PATCH / ingestion surface.
mod codec_avro;
mod codec_registry;
mod connectors_core;
// Field-level permission registry (CAS_C4219F2B) + the codec-delegating validator.
mod field_perms;
mod field_validate;
mod kafka_loader;
mod mysql_loader;
mod postgres_loader;
mod pipeline;
mod redact;
mod validate_expr;
mod validate_rules;
mod request_log;
mod routes;
mod state;
mod type_cache;
mod type_registry;

use std::net::SocketAddr;
use tracing_subscriber::filter::filter_fn;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Step 1 — env. `.env` is dev-only; in prod the systemd unit sets vars.
    let _ = dotenvy::dotenv();

    // ── Kafka loader mode (ETL L hop, CAS_75A0D1FD) ──────────────────────
    // One-shot: consume a Kafka batch → decode (avro meta-codec) → load into a
    // project_files row, then exit. Runs INSTEAD of serving when
    // REDPASH_KAFKA_LOAD is set — a `src/bin` can't reach `codec_avro`/`db`, so
    // the loader rides the main binary. Config via KAFKA_* env (see Cfg).
    if std::env::var("REDPASH_KAFKA_LOAD").is_ok() {
        tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).init();
        let db_url = std::env::var("DATABASE_URL")
            .map_err(|_| anyhow::anyhow!("DATABASE_URL not set"))?;
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&db_url)
            .await?;
        let data_dir = std::env::var("REDPASH_DATA_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from("./data"));
        // REDPASH_KAFKA_CONNECTION (a CON_ rid) → read the user-chosen destination
        // from the persisted connection; otherwise the legacy env hardcode.
        let cfg = match std::env::var("REDPASH_KAFKA_CONNECTION").ok().filter(|s| !s.is_empty()) {
            Some(conn_id) => kafka_loader::Cfg::from_connection(&pool, &conn_id).await?,
            None          => kafka_loader::Cfg::from_env()?,
        };
        let _ = kafka_loader::run(&pool, &data_dir, &cfg).await?; // CLI mode logs the rid itself
        return Ok(());
    }

    // Step 2 — tracing. RUST_LOG wins; otherwise the pre-market verbose
    // default: `info` on our crates + tower_http (so request_id-bearing
    // spans + per-request access logs surface) + `sqlx=info` (every query
    // logged for I-5 / I-2 investigation paths) + `hyper=warn` (hyper's
    // own info is too chatty to be useful). Tighten before market.
    //
    // JSON output with .flatten_event(true) — the structured-output
    // half of "verbose pre-market" per [[audit-everything]] memory.
    // Each log line becomes a single JSON object with span fields
    // (including request_id from request_id_mw) at the top level —
    // jq-queryable, joins cleanly to the events table via request_id.
    // Pretty-printed text was operator-friendly in dev but lost the
    // span context to grep noise; JSON is operator-friendly in BOTH
    // surfaces (jq for local dev, log-aggregator-ready for prod).
    // Registry + layers (was `fmt().init()`): the fmt layer keeps the
    // exact same JSON output, and `db_query::layer()` taps sqlx's query
    // events into the db_query_log table (DB observability). The pool the
    // capture layer writes to is wired in after Step 3 (init_pool) — it
    // doesn't exist yet here.
    //
    // One GLOBAL filter is the only enablement control; the capture layer
    // self-selects. Shape rationale:
    //   1. sqlx logs every statement at `DEBUG` (`log_statements` default),
    //      so the global max level MUST admit `sqlx::query` at debug or the
    //      events are dropped at the macro site and capture records nothing.
    //      `add_directive` forces that target on regardless of what RUST_LOG
    //      says, so capture can't be silently disabled by an operator's
    //      RUST_LOG (which otherwise wouldn't mention sqlx::query).
    //   2. The capture layer is UNFILTERED — it self-selects on the
    //      `sqlx::query` target inside `on_event` and applies its own
    //      verbose()/slow-threshold gate. Keeping enablement in the single
    //      global floor (rather than juggling a second per-layer filter's
    //      level hint against the fmt layer's) is the simplest shape that
    //      reliably delivers the DEBUG events, including the ones emitted
    //      inside the per-request `api` span.
    //   3. stdout keeps its old non-firehose shape: a per-layer filter on
    //      the FMT layer alone drops `sqlx::query`, so the forced debug
    //      directive feeds the capture layer without spamming the log.
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,sqlx=info,hyper=warn,tower_http=info"))
        .add_directive(
            "sqlx::query=debug"
                .parse()
                .expect("static directive is valid"),
        );
    tracing_subscriber::registry()
        .with(env_filter)
        .with(
            tracing_subscriber::fmt::layer()
                .json()
                .flatten_event(true)
                .with_filter(filter_fn(|meta: &tracing::Metadata<'_>| {
                    meta.target() != "sqlx::query"
                })),
        )
        .with(db_query::layer())
        .init();

    // Step 3 — app state (db pool, caches). Stubbed until Phase 2.
    let state = state::AppState::init().await?;

    // Wire the DB-observability capture pool now that it exists + start
    // its retention job. The capture layer no-ops until this runs.
    db_query::init_pool(state.db.clone());

    // Step 4 — process-level panic hook. Records every panic into the
    // `events` table (kind="panic", level="error") so background-task
    // failures aren't invisible. Investigation I-8 in the observability
    // doc — without this hook, a tokio task that panics logs to stderr
    // and disappears. The default hook is preserved (stderr backtrace +
    // thread name) by calling it first.
    //
    // ALSO emits a `tracing::error!` so panics land in Channel A's
    // structured JSON stream — without this, the JSON logs would have
    // a hole where the panic happened (only stderr + events table
    // captured it). request_id auto-attaches from the current span
    // when the panic happens inside a request task. Captures
    // `Backtrace::force_capture()` so the stack frames reach the
    // structured log even when RUST_BACKTRACE is unset — panics are
    // rare; the capture cost is only paid when one happens, and a
    // structured backtrace is the difference between "operator
    // diagnoses in 30s" and "operator pages a dev".
    {
        let pool = state.db.clone();
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            default_hook(info);
            let payload = info.payload().downcast_ref::<&'static str>()
                .map(|s| (*s).to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic (non-string payload)".to_string());
            let location = info.location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_else(|| "unknown".to_string());
            let backtrace = std::backtrace::Backtrace::force_capture();

            // Channel A — structured JSON log. Span context (request_id,
            // handler args from #[instrument]) attaches automatically.
            tracing::error!(
                panic.payload  = %payload,
                panic.location = %location,
                panic.backtrace = %backtrace,
                "process panic"
            );

            // Channel B — events table via the fire-and-forget path.
            // event::record spawns onto the current tokio runtime; a
            // boot-time panic before the runtime is up skips the DB
            // write (no runtime to spawn on) and falls through to the
            // tracing emit above + the default hook's stderr output.
            //
            // backtrace_head: redact + cap the first 20 frames into
            // events.context so the Monitoring panic pane (M-3, slice E)
            // has top-of-stack at-a-glance. The full backtrace stays
            // in Channel A's panic.backtrace field (deep-dive consumer).
            if tokio::runtime::Handle::try_current().is_ok() {
                let bt_head = redact::backtrace_head(&backtrace.to_string(), 20);
                event::error(&pool, "panic", redact::redact_chain(&payload))
                    .context(serde_json::json!({
                        "location":       location,
                        "backtrace_head": bt_head,
                    }))
                    .send();
            }
        }));
    }

    // Step 5 — router + bind.
    let app = routes::router(state);
    let bind: SocketAddr = std::env::var("REDPASH_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8080".into())
        .parse()?;

    tracing::info!(%bind, "redpash-api listening");
    let listener = tokio::net::TcpListener::bind(bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
