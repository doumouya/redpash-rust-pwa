//! Runtime event capture — fire-and-forget writes to the `events` table.
//!
//! `record(pool, draft)` persists an event WITHOUT blocking the caller:
//! it clones the pool (cheap — `Arc` inside) and spawns the INSERT on a
//! detached task. A failed insert is logged and swallowed. The rule is
//! absolute — the observability layer must never slow down, or fail,
//! the thing it observes.
//!
//! Two capture paths feed this:
//!   - the `routes::mod::capture_mw` middleware — every 4xx/5xx response;
//!   - explicit `event::record(...)` calls — notable lifecycle actions
//!     (login, upload, step apply, …) and the frontend `POST /api/events`.
//!
//! ## Ergonomic builders — `info` / `warn` / `error`
//!
//! Direct `record(pool, EventDraft { … })` calls still work, but every
//! lifecycle call site was 7-9 lines of struct-literal boilerplate
//! (`origin: "backend"`, `level: "info"`, `..Default::default()`, …).
//! The level-named builders absorb the constants and expose only the
//! fields a typical call mutates:
//!
//! ```ignore
//! event::info(&state.db, "auth_login", format!("{} signed in", name))
//!     .user(user_rid)
//!     .session(sid)
//!     .send();
//!
//! event::info(&state.db, "file_upload", format!("uploaded {filename}"))
//!     .user(user_rid)
//!     .context(json!({ "file": rid, "rows": n }))
//!     .send();
//! ```
//!
//! `#[must_use]` on the builder catches `send()`-forgotten calls at
//! compile time. The builder defers spawning until `.send()` — no
//! Drop magic, no surprise spawns.

use serde_json::Value;
use sqlx::PgPool;

/// A draft event to persist. Build one, hand it to [`record`].
///
/// `origin` / `level` are `&'static str` — every call site passes a
/// literal (the frontend-report handler maps its runtime string onto
/// the fixed set first). Everything else is owned so the draft can move
/// into the detached insert task.
#[derive(Debug, Clone, Default)]
pub struct EventDraft {
    pub origin:      &'static str,   // "backend" | "frontend"
    pub level:       &'static str,   // "debug" | "info" | "warn" | "error"
    pub kind:        String,
    pub message:     String,
    pub source:      Option<String>,
    pub user:        Option<String>,
    pub session_id:  Option<String>,
    pub request_id:  Option<String>,
    pub http_method: Option<String>,
    pub http_path:   Option<String>,
    pub http_status: Option<i32>,
    pub duration_ms: Option<i32>,
    pub context:     Value,
}

/// Persist `draft` without blocking the caller. The INSERT runs on a
/// detached `tokio` task; a failure is `warn!`-logged and dropped.
pub fn record(pool: &PgPool, draft: EventDraft) {
    let pool = pool.clone();
    tokio::spawn(async move {
        let rid = crate::id::new("EVT");
        // The column defaults to '{}'; a null payload would violate NOT NULL.
        let context = if draft.context.is_null() {
            serde_json::json!({})
        } else {
            draft.context
        };
        let res = sqlx::query(
            "INSERT INTO events
                 (redpash_id, origin, level, kind, message, source,
                  user_redpash_id, session_id, request_id,
                  http_method, http_path, http_status, duration_ms, context)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        )
        .bind(rid.as_str())
        .bind(draft.origin)
        .bind(draft.level)
        .bind(draft.kind.as_str())
        .bind(draft.message.as_str())
        .bind(draft.source.as_deref())
        .bind(draft.user.as_deref())
        .bind(draft.session_id.as_deref())
        .bind(draft.request_id.as_deref())
        .bind(draft.http_method.as_deref())
        .bind(draft.http_path.as_deref())
        .bind(draft.http_status)
        .bind(draft.duration_ms)
        .bind(context)
        .execute(&pool)
        .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "event insert failed (non-fatal)");
        }
    });
}

/// Builder for a backend-origin lifecycle event. Constructed by
/// [`info`], [`warn`], or [`error`]; finalised with `.send()` (which
/// spawns the same fire-and-forget insert path as [`record`]).
///
/// `#[must_use]` so a builder constructed without `.send()` warns at
/// compile time — the event would otherwise silently never fire.
#[must_use = "EventBuilder must be sent with .send() — otherwise the event never fires"]
pub struct EventBuilder<'a> {
    pool: &'a PgPool,
    draft: EventDraft,
}

impl<'a> EventBuilder<'a> {
    /// Attribute the event to a user (`USR_…` rid).
    pub fn user(mut self, u: impl Into<String>) -> Self {
        self.draft.user = Some(u.into());
        self
    }

    /// Attribute when the caller already has an `Option<String>` —
    /// avoids the `.map(Into::into)` ceremony at the call site.
    pub fn user_opt(mut self, u: Option<String>) -> Self {
        self.draft.user = u;
        self
    }

    /// Stamp the originating session (`SES_…` rid) — auth flows mostly.
    pub fn session(mut self, s: impl Into<String>) -> Self {
        self.draft.session_id = Some(s.into());
        self
    }

    /// Free-form structured payload (the `events.context` JSONB column).
    pub fn context(mut self, c: Value) -> Self {
        self.draft.context = c;
        self
    }

    /// Persist the event. Spawns the INSERT on a detached task; never
    /// blocks. After `.send()` the builder is consumed.
    pub fn send(self) {
        record(self.pool, self.draft);
    }
}

/// Start an `info`-level backend event. Chain optional fields and
/// terminate with `.send()`.
pub fn info<'a>(
    pool: &'a PgPool,
    kind: impl Into<String>,
    message: impl Into<String>,
) -> EventBuilder<'a> {
    EventBuilder {
        pool,
        draft: EventDraft {
            origin: "backend",
            level: "info",
            kind: kind.into(),
            message: message.into(),
            ..Default::default()
        },
    }
}

/// `warn`-level sibling of [`info`].
pub fn warn<'a>(
    pool: &'a PgPool,
    kind: impl Into<String>,
    message: impl Into<String>,
) -> EventBuilder<'a> {
    EventBuilder {
        pool,
        draft: EventDraft {
            origin: "backend",
            level: "warn",
            kind: kind.into(),
            message: message.into(),
            ..Default::default()
        },
    }
}

/// `error`-level sibling of [`info`]. The `capture_mw` middleware
/// emits its own `error`-level events for 4xx/5xx responses; this
/// helper covers the explicit-call sites (panic hook, etc).
pub fn error<'a>(
    pool: &'a PgPool,
    kind: impl Into<String>,
    message: impl Into<String>,
) -> EventBuilder<'a> {
    EventBuilder {
        pool,
        draft: EventDraft {
            origin: "backend",
            level: "error",
            kind: kind.into(),
            message: message.into(),
            ..Default::default()
        },
    }
}

/// Stashed in an error `Response`'s extensions by `AppError::into_response`
/// so the capture middleware can read the error's kind + message after
/// the handler has returned (the `AppError` itself is long gone by then).
///
/// `chain_redacted` carries a sanitized rendering of the underlying
/// `eyre::Report` (when AppError had `inner: Some(_)`) — runs through
/// `crate::redact::redact_chain` at the airlock. `None` for 4xx errors
/// (the message IS the explanation) AND for 5xx without inner (the
/// rare hand-constructed `internal()` calls). Powers the Monitoring
/// page's M-4 error-chain expander (slice E).
#[derive(Debug, Clone)]
pub struct EventInfo {
    pub kind:           &'static str,
    pub message:        String,
    pub chain_redacted: Option<String>,
}
