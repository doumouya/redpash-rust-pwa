//! Doc: docs/internal/code/backend/api/db/users.md
//! `users` row CRUD + memberships join + Google-OAuth upsert.
//!
//! Slice 3 of the db/mod.rs decomposition. Holds:
//!
//!   - The `UserRow` ↔ `UserProfile` shape (private `UserRow` derives
//!     `FromRow`; the `From<UserRow> for UserProfile` impl is the only
//!     way out of this module).
//!   - Find-by-{username, redpash_id, google_sub} reads.
//!   - List-all-users with membership prefetch (one users SELECT + one
//!     memberships SELECT joined client-side; cheap at directory scale).
//!   - Sparse `update_user`, insert, delete, Google-OAuth `upsert`.
//!   - `patch_user_prefs` — sparse upsert into the `user_preferences`
//!     table (migration 023 / 024 split prefs out of `users.prefs`).
//!
//! All readers fold the user's prefs in from `user_preferences` via a
//! correlated subquery (`COALESCE(jsonb_object_agg, '{}'::jsonb)`); the
//! `users.prefs` JSONB column itself was dropped in migration 024.

use shared::user::{UserMembership, UserProfile};
use sqlx::{FromRow, PgPool, Row};

#[derive(FromRow)]
struct UserRow {
    redpash_id:   String,
    username:     String,
    email:        Option<String>,
    display_name: String,
    first_name:   Option<String>,
    last_name:    Option<String>,
    avatar_url:   Option<String>,
    job_title:    Option<String>,
    organisation: Option<String>,
    use_case:     Option<String>,
    plan:         String,
    locale:       String,
    prefs:        serde_json::Value,
}
impl From<UserRow> for UserProfile {
    fn from(r: UserRow) -> Self {
        Self {
            redpash_id:   r.redpash_id,
            username:     r.username,
            email:        r.email,
            display_name: r.display_name,
            first_name:   r.first_name,
            last_name:    r.last_name,
            avatar_url:   r.avatar_url,
            job_title:    r.job_title,
            organisation: r.organisation,
            use_case:     r.use_case,
            plan:         r.plan,
            locale:       r.locale,
            prefs:        r.prefs,
            memberships:  Vec::new(),
        }
    }
}

pub async fn find_user_by_username(pool: &PgPool, username: &str) -> sqlx::Result<Option<UserProfile>> {
    let row: Option<UserRow> = sqlx::query_as(
        "SELECT redpash_id, username, email, display_name, avatar_url,
                job_title, organisation, use_case, plan, locale,
                -- prefs from the user_preferences table (mig 023);
                -- users.prefs JSONB column dropped in mig 024.
                COALESCE(
                  (SELECT jsonb_object_agg(p.key, p.value)
                     FROM user_preferences p
                    WHERE p.user_redpash_id = users.redpash_id),
                  '{}'::jsonb
                ) AS prefs,
                first_name, last_name
         FROM users WHERE username = $1",
    )
    .bind(username)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

pub async fn find_user_by_id(pool: &PgPool, rid: &str) -> sqlx::Result<Option<UserProfile>> {
    let row: Option<UserRow> = sqlx::query_as(
        "SELECT redpash_id, username, email, display_name, avatar_url,
                job_title, organisation, use_case, plan, locale,
                -- prefs from the user_preferences table (mig 023);
                -- users.prefs JSONB column dropped in mig 024.
                COALESCE(
                  (SELECT jsonb_object_agg(p.key, p.value)
                     FROM user_preferences p
                    WHERE p.user_redpash_id = users.redpash_id),
                  '{}'::jsonb
                ) AS prefs,
                first_name, last_name
         FROM users WHERE redpash_id = $1",
    )
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

/// One user's company memberships — ordered owner → admin → member,
/// ties broken by most-recent joined_at. Used by `/api/me` so the
/// Profile page can show the user's real org affiliations alongside
/// the editable free-text `organisation` bio field.
pub async fn list_memberships_for_user(
    pool:     &PgPool,
    user_rid: &str,
) -> sqlx::Result<Vec<UserMembership>> {
    let rows = sqlx::query(
        "SELECT cm.object_redpash_id AS company_id, c.name AS company_name, cm.role
           FROM memberships cm
           JOIN companies c ON c.redpash_id = cm.object_redpash_id
          WHERE cm.member_redpash_id = $1
          ORDER BY CASE cm.role
                     WHEN 'owner'  THEN 0
                     WHEN 'admin'  THEN 1
                     ELSE 2
                   END,
                   cm.joined_at DESC",
    )
    .bind(user_rid)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| UserMembership {
        company_id:   r.get("company_id"),
        company_name: r.get("company_name"),
        role:         r.get("role"),
    }).collect())
}

/// Every user — powers the Objects page's owner-reassignment picker.
/// No org scoping yet (single-tenant); add a `WHERE org_id = …` when
/// organisations land.
pub async fn list_users(pool: &PgPool) -> sqlx::Result<Vec<UserProfile>> {
    let rows: Vec<UserRow> = sqlx::query_as(
        "SELECT redpash_id, username, email, display_name, avatar_url,
                job_title, organisation, use_case, plan, locale,
                -- prefs from the user_preferences table (mig 023);
                -- users.prefs JSONB column dropped in mig 024.
                COALESCE(
                  (SELECT jsonb_object_agg(p.key, p.value)
                     FROM user_preferences p
                    WHERE p.user_redpash_id = users.redpash_id),
                  '{}'::jsonb
                ) AS prefs,
                first_name, last_name
         FROM users ORDER BY display_name ASC",
    )
    .fetch_all(pool)
    .await?;
    // Memberships in one round-trip — group_concat by user id, then
    // attach. Cheap at directory scale; if/when the users table grows
    // into thousands, switch to a windowed query or paginate.
    let mem_rows = sqlx::query(
        "SELECT m.member_redpash_id, m.object_redpash_id AS company_id, m.role, c.name AS company_name
         FROM memberships m
         JOIN companies c ON c.redpash_id = m.object_redpash_id",
    )
    .fetch_all(pool)
    .await?;
    let mut by_user: std::collections::HashMap<String, Vec<UserMembership>> =
        std::collections::HashMap::new();
    for r in &mem_rows {
        by_user.entry(r.get::<String, _>("member_redpash_id")).or_default().push(UserMembership {
            company_id:   r.get("company_id"),
            company_name: r.get("company_name"),
            role:         r.get("role"),
        });
    }
    Ok(rows.into_iter().map(|r| {
        let mut u: UserProfile = r.into();
        u.memberships = by_user.remove(&u.redpash_id).unwrap_or_default();
        u
    }).collect())
}

/// Sparse update — every `Option::Some` field overwrites the column;
/// `None` keeps the existing value via `COALESCE`. `updated_at` is
/// bumped on every call.
///
/// **Prefs do NOT flow through here.** As of migration 023, prefs live
/// in the `user_preferences` table and the only write path is
/// `patch_user_prefs(…)` (called from `PATCH /api/me/prefs`). The
/// legacy `users.prefs` JSONB column was dropped in migration 024.
/// See `docs/internal/spec-user-preferences.md`.
#[allow(clippy::too_many_arguments)]
pub async fn update_user(
    pool:         &PgPool,
    rid:          &str,
    display_name: Option<&str>,
    username:     Option<&str>,
    email:        Option<&str>,
    plan:         Option<&str>,
    avatar_url:   Option<&str>,
    job_title:    Option<&str>,
    organisation: Option<&str>,
    use_case:     Option<&str>,
    locale:       Option<&str>,
    first_name:   Option<&str>,
    last_name:    Option<&str>,
) -> sqlx::Result<Option<UserProfile>> {
    let row: Option<UserRow> = sqlx::query_as(
        "UPDATE users SET
            display_name = COALESCE($2,  display_name),
            username     = COALESCE($3,  username),
            email        = COALESCE($4,  email),
            plan         = COALESCE($5,  plan),
            avatar_url   = COALESCE($6,  avatar_url),
            job_title    = COALESCE($7,  job_title),
            organisation = COALESCE($8,  organisation),
            use_case     = COALESCE($9,  use_case),
            locale       = COALESCE($10, locale),
            first_name   = COALESCE($11, first_name),
            last_name    = COALESCE($12, last_name),
            updated_at   = now()
         WHERE redpash_id = $1
         RETURNING redpash_id, username, email, display_name, avatar_url,
                   job_title, organisation, use_case, plan, locale,
                   COALESCE(
                     (SELECT jsonb_object_agg(p.key, p.value)
                        FROM user_preferences p
                       WHERE p.user_redpash_id = users.redpash_id),
                     '{}'::jsonb
                   ) AS prefs,
                   first_name, last_name",
    )
    .bind(rid)
    .bind(display_name)
    .bind(username)
    .bind(email)
    .bind(plan)
    .bind(avatar_url)
    .bind(job_title)
    .bind(organisation)
    .bind(use_case)
    .bind(locale)
    .bind(first_name)
    .bind(last_name)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

/// Patch one or more pref rows for a user. Sparse upsert: every key
/// present in `patch` is set to the corresponding value; keys not
/// present stay as they are. JSONB values (scalars, arrays, booleans)
/// land verbatim. `updated_at` bumps per affected row.
pub async fn patch_user_prefs(
    pool:  &PgPool,
    rid:   &str,
    patch: &serde_json::Value,
) -> sqlx::Result<()> {
    // No-op on empty / non-object input — keeps the route handler's
    // "PATCH with no prefs field" path cheap.
    let Some(obj) = patch.as_object() else { return Ok(()); };
    if obj.is_empty() { return Ok(()); }
    sqlx::query(
        "INSERT INTO user_preferences (user_redpash_id, key, value, updated_at)
         SELECT $1, kv.key, kv.value, now()
           FROM jsonb_each($2::jsonb) AS kv(key, value)
         ON CONFLICT (user_redpash_id, key) DO UPDATE
            SET value      = EXCLUDED.value,
                updated_at = now()",
    )
    .bind(rid)
    .bind(patch)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn insert_user(
    pool:         &PgPool,
    rid:          &str,
    username:     &str,
    display_name: &str,
    email:        Option<&str>,
) -> sqlx::Result<UserProfile> {
    let row: UserRow = sqlx::query_as(
        "INSERT INTO users (redpash_id, username, display_name, email)
         VALUES ($1, $2, $3, $4)
         RETURNING redpash_id, username, email, display_name, avatar_url,
                   job_title, organisation, use_case, plan, locale,
                   COALESCE(
                     (SELECT jsonb_object_agg(p.key, p.value)
                        FROM user_preferences p
                       WHERE p.user_redpash_id = users.redpash_id),
                     '{}'::jsonb
                   ) AS prefs,
                   first_name, last_name",
    )
    .bind(rid)
    .bind(username)
    .bind(display_name)
    .bind(email)
    .fetch_one(pool)
    .await?;
    Ok(row.into())
}

/// Scrub-retain user deletion — the lifecycle replacement for the
/// pre-2026-05-31 hard `DELETE FROM users` (which CASCADEd every
/// membership and broke the audit-retention contract,
/// CAS_46BA67713EC84871991D3E7475598B47).
///
/// Single transaction, all-or-nothing:
///   STEP 2 — DELETE memberships LIKE 'TEM_%'. Teams aren't a display
///            surface so dropping the row is fine. CASE memberships are
///            KEPT — Reporter / Case Owner rows are load-bearing for
///            the "reported by X" / "assigned to Y" rendering via
///            CASE_USER_JOINS, which JOINs through to `users.display_name`
///            (= 'Deleted User' after step 4). Per workflow `wik561ah7`
///            synthesis: deleting case memberships makes those JOINs
///            return NULL and the frontend renders '—' instead of
///            'Deleted User', silently breaking the most-rendered surface.
///   STEP 3 — DELETE sessions + user_preferences. Auth must be destroyed.
///   STEP 4 — UPDATE users SET PII = NULL, display_name = 'Deleted User',
///            status = 'archived'. The users row + identity rid REMAIN
///            so historical JOINs resolve via `users.display_name`.
///
/// Returns Ok(true) if the scrub applied; Ok(false) if the user wasn't
/// found (caller renders 404). The sole-owner blocker (STEP 1 of Em's
/// transaction spec) is enforced caller-side via
/// `db::user_sole_owner_objects` so the route returns a structured 409
/// with the list of blocking object rids instead of a flat rollback.
///
/// Runbook (post-ship): docs/internal/runbooks/CAS_46BA67713EC84871991D3E7475598B47-scrub-retain-user-deletion.md
pub async fn scrub_user_tx(pool: &PgPool, rid: &str) -> sqlx::Result<bool> {
    let mut tx = pool.begin().await?;

    // STEP 2 — Teams memberships out, Cases retained (display contract).
    sqlx::query(
        "DELETE FROM memberships
         WHERE member_redpash_id = $1
           AND object_redpash_id LIKE 'TEM_%'",
    )
    .bind(rid)
    .execute(&mut *tx)
    .await?;

    // STEP 3 — Destroy auth + per-user prefs.
    sqlx::query("DELETE FROM sessions WHERE user_redpash_id = $1")
        .bind(rid)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM user_preferences WHERE user_redpash_id = $1")
        .bind(rid)
        .execute(&mut *tx)
        .await?;

    // STEP 4 — Scrub PII, retain identity row.
    let n = sqlx::query(
        "UPDATE users SET
           email        = NULL,
           google_sub   = NULL,
           first_name   = NULL,
           last_name    = NULL,
           job_title    = NULL,
           avatar_url   = NULL,
           display_name = 'Deleted User',
           status       = 'archived',
           updated_at   = now()
         WHERE redpash_id = $1",
    )
    .bind(rid)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(n.rows_affected() > 0)
}

/// Look up a user by their Google `sub` (subject) claim. The Google
/// `sub` is stable per Google account across name/email changes, so
/// this is the right matching key for returning users.
pub async fn find_user_by_google_sub(pool: &PgPool, sub: &str) -> sqlx::Result<Option<UserProfile>> {
    let row: Option<UserRow> = sqlx::query_as(
        "SELECT redpash_id, username, email, display_name, avatar_url,
                job_title, organisation, use_case, plan, locale,
                -- prefs from the user_preferences table (mig 023);
                -- users.prefs JSONB column dropped in mig 024.
                COALESCE(
                  (SELECT jsonb_object_agg(p.key, p.value)
                     FROM user_preferences p
                    WHERE p.user_redpash_id = users.redpash_id),
                  '{}'::jsonb
                ) AS prefs,
                first_name, last_name
         FROM users WHERE google_sub = $1",
    )
    .bind(sub)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

/// Upsert a user by Google sub. On insert, generates a new RID and
/// populates display_name / email / avatar_url from the OAuth claims.
/// On match, refreshes display_name / email / avatar_url so the
/// stored profile tracks the Google account.
pub async fn upsert_google_user(
    pool:         &PgPool,
    sub:          &str,
    email:        &str,
    display_name: &str,
    avatar_url:   Option<&str>,
) -> sqlx::Result<UserProfile> {
    if let Some(existing) = find_user_by_google_sub(pool, sub).await? {
        // Refresh the soft profile fields each sign-in so the user's
        // name and avatar stay in sync with their Google account.
        let row: UserRow = sqlx::query_as(
            "UPDATE users
                SET email        = $2,
                    display_name = $3,
                    avatar_url   = $4,
                    updated_at   = now()
              WHERE redpash_id = $1
              RETURNING redpash_id, username, email, display_name, avatar_url,
                        job_title, organisation, use_case, plan, locale,
                        COALESCE(
                          (SELECT jsonb_object_agg(p.key, p.value)
                             FROM user_preferences p
                            WHERE p.user_redpash_id = users.redpash_id),
                          '{}'::jsonb
                        ) AS prefs,
                        first_name, last_name",
        )
        .bind(&existing.redpash_id)
        .bind(email)
        .bind(display_name)
        .bind(avatar_url)
        .fetch_one(pool)
        .await?;
        return Ok(row.into());
    }
    let rid = crate::id::new("USR");
    // Username derives from email's local part — collision-resistant
    // via the RID suffix so unique-constraints don't fail on repeats.
    let local = email.split('@').next().unwrap_or("user");
    let username = format!("{local}.{}", &rid[4..12].to_ascii_lowercase());
    let row: UserRow = sqlx::query_as(
        "INSERT INTO users (redpash_id, username, email, display_name, avatar_url, google_sub)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING redpash_id, username, email, display_name, avatar_url,
                   job_title, organisation, use_case, plan, locale,
                   COALESCE(
                     (SELECT jsonb_object_agg(p.key, p.value)
                        FROM user_preferences p
                       WHERE p.user_redpash_id = users.redpash_id),
                     '{}'::jsonb
                   ) AS prefs,
                   first_name, last_name",
    )
    .bind(&rid)
    .bind(&username)
    .bind(email)
    .bind(display_name)
    .bind(avatar_url)
    .bind(sub)
    .fetch_one(pool)
    .await?;
    Ok(row.into())
}
