//! `sentinel_submissions` + `global_sentinels` SQL helpers.
//!
//! Two functions for the cleanness-vocabulary plumbing:
//!   - Read the globally-promoted canonicals (≥2 distinct users; the
//!     promotion threshold lives in the `global_sentinels` view).
//!   - Record one user's submission as a vote toward promotion.
//!
//! No shared DTOs; both helpers operate on `String` canonicals and the
//! caller is expected to have already trimmed + lowercased them. Same
//! shape as `db/sessions.rs` — `PgPool` + raw `sqlx::query` only.

use sqlx::{PgPool, Row};

/// Canonicals currently promoted to the global cleanness vocabulary.
/// The view's promotion threshold (≥2 distinct users) is enforced in
/// SQL — callers don't need to filter again.
///
/// Stable ascending order so a checksum / diff of the returned slice
/// is meaningful across calls (handy for in-process caching).
pub async fn list_global_sentinels(pool: &PgPool) -> sqlx::Result<Vec<String>> {
    let rows = sqlx::query("SELECT canonical FROM global_sentinels ORDER BY canonical")
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|r| r.get::<String, _>(0)).collect())
}

/// Record (or no-op) one submission. The PK is `(canonical, user_id)`
/// so re-submitting the same value from the same user is a no-op
/// (matches the user's expectation that picking the same sentinel
/// across multiple files doesn't count as multiple votes).
///
/// `canonical` is expected to be already trimmed + lowercased by the
/// caller — the table doesn't normalise.
pub async fn record_sentinel_submission(
    pool: &PgPool, canonical: &str, user_rid: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO sentinel_submissions (canonical, user_id) \
         VALUES ($1, $2) ON CONFLICT (canonical, user_id) DO NOTHING"
    )
    .bind(canonical)
    .bind(user_rid)
    .execute(pool)
    .await?;
    Ok(())
}
