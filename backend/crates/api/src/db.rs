//! Thin SQL helpers.
//!
//! All queries are non-macro (`sqlx::query` + `query_as::<_, Row>`) so
//! the crate compiles without `DATABASE_URL` at build time. Each helper
//! takes a `&PgPool` and returns a domain DTO from `shared::*`.

use chrono::{DateTime, Utc};
use shared::chart::Chart;
use shared::company::{Company, CompanyMember, CompanySummary};
use shared::dashboard::{Dashboard, DashboardSpec};
use shared::event::Event;
use shared::file::{ColumnMeta, FileSummary};
use shared::project::ProjectSummary;
use shared::step::ProjectStep;
use shared::user::{UserMembership, UserProfile};
use sqlx::{FromRow, PgPool, Row};

/// `SELECT COUNT(*)::BIGINT FROM <table>` — bare-table row count.
///
/// **`table` must be a string literal or an internally-controlled
/// constant — never user input.** sqlx can't bind identifiers, so
/// the table name is interpolated via `format!`. Every caller in
/// this crate passes a static `&str`; do not break that invariant.
///
/// 14 hand-rolled inline `sqlx::query_scalar("SELECT COUNT(*)::BIGINT
/// FROM …")` chains collapsed into this helper per the
/// rust-dedup-audit-2026-05-24 item B.
pub async fn count_total(pool: &PgPool, table: &str) -> sqlx::Result<i64> {
    sqlx::query_scalar(&format!("SELECT COUNT(*)::BIGINT FROM {}", table))
        .fetch_one(pool)
        .await
}

// ─── users ──────────────────────────────────────────────────────

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
        "SELECT cm.company_id, c.name AS company_name, cm.role
           FROM company_memberships cm
           JOIN companies c ON c.redpash_id = cm.company_id
          WHERE cm.user_redpash_id = $1
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
        "SELECT m.user_redpash_id, m.company_id, m.role, c.name AS company_name
         FROM company_memberships m
         JOIN companies c ON c.redpash_id = m.company_id",
    )
    .fetch_all(pool)
    .await?;
    let mut by_user: std::collections::HashMap<String, Vec<UserMembership>> =
        std::collections::HashMap::new();
    for r in &mem_rows {
        by_user.entry(r.get::<String, _>("user_redpash_id")).or_default().push(UserMembership {
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

pub async fn delete_user(pool: &PgPool, rid: &str) -> sqlx::Result<bool> {
    // FKs from sessions / project_memberships / company_memberships /
    // projects.owner_id all cascade — the row going away takes the
    // user's auth + their owned projects with it. Use with care; the
    // Users-tab UI in dev mode is intentionally permissive.
    let n = sqlx::query("DELETE FROM users WHERE redpash_id = $1")
        .bind(rid)
        .execute(pool)
        .await?;
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

// ─── sessions ───────────────────────────────────────────────────

pub async fn create_session(pool: &PgPool, user_rid: &str, ttl_days: i64) -> sqlx::Result<String> {
    let sid = crate::id::new("SES");
    sqlx::query(
        "INSERT INTO sessions (redpash_id, user_redpash_id, expires_at)
         VALUES ($1, $2, now() + ($3 || ' days')::interval)",
    )
    .bind(&sid)
    .bind(user_rid)
    .bind(ttl_days.to_string())
    .execute(pool)
    .await?;
    Ok(sid)
}

/// Returns the user RID for a session if it exists and hasn't expired.
/// Auto-deletes the row if expired (cheap cleanup on the read path).
pub async fn find_session_user(pool: &PgPool, sid: &str) -> sqlx::Result<Option<String>> {
    let row: Option<(String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT user_redpash_id, expires_at FROM sessions WHERE redpash_id = $1",
    )
    .bind(sid)
    .fetch_optional(pool)
    .await?;
    let Some((user_rid, expires_at)) = row else { return Ok(None); };
    if expires_at < Utc::now() {
        let _ = sqlx::query("DELETE FROM sessions WHERE redpash_id = $1")
            .bind(sid)
            .execute(pool)
            .await;
        return Ok(None);
    }
    Ok(Some(user_rid))
}

pub async fn delete_session(pool: &PgPool, sid: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM sessions WHERE redpash_id = $1")
        .bind(sid)
        .execute(pool)
        .await?;
    Ok(())
}

// ─── sentinel_submissions ───────────────────────────────────────

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

// ─── projects ───────────────────────────────────────────────────

pub async fn find_default_project(pool: &PgPool, owner: &str) -> sqlx::Result<Option<String>> {
    let row = sqlx::query("SELECT redpash_id FROM projects WHERE owner_id = $1 AND is_default LIMIT 1")
        .bind(owner)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.get::<String, _>(0)))
}

pub async fn insert_project(pool: &PgPool, rid: &str, owner: &str, name: &str, is_default: bool) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO projects (redpash_id, owner_id, name, is_default) VALUES ($1, $2, $3, $4)")
        .bind(rid)
        .bind(owner)
        .bind(name)
        .bind(is_default)
        .execute(pool)
        .await?;
    Ok(())
}

/// Idempotent — returns the user's default project RID, creating it
/// if the user has none yet. Called on every Google sign-in so a
/// brand-new account lands with a usable workspace immediately.
pub async fn ensure_default_project(pool: &PgPool, owner: &str) -> sqlx::Result<String> {
    if let Some(rid) = find_default_project(pool, owner).await? {
        return Ok(rid);
    }
    let rid = crate::id::new("PRJ");
    insert_project(pool, &rid, owner, "Workspace", true).await?;
    Ok(rid)
}

/// Find a project by name within this owner's workspace. Returns the
/// first match (name is not unique today; could be made unique with a
/// partial index later). Case-sensitive match.
pub async fn find_project_by_name(pool: &PgPool, owner: &str, name: &str) -> sqlx::Result<Option<String>> {
    let row = sqlx::query(
        "SELECT redpash_id FROM projects \
         WHERE owner_id = $1 AND name = $2 \
         ORDER BY created_at ASC LIMIT 1",
    )
    .bind(owner)
    .bind(name)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| r.get::<String, _>(0)))
}

/// Find-or-create a project under `owner` with the given name.
///
/// Called from the upload handler when the file-review modal supplies a
/// project_name field — without this, every upload pools into the
/// auto-created "Workspace" default and the user can never split files
/// into separate projects. The matching is case-sensitive on `name`, so
/// a fresh capitalisation creates a new project. is_default stays false
/// here so the user's default-Workspace assignment isn't disturbed.
pub async fn ensure_named_project(pool: &PgPool, owner: &str, name: &str) -> sqlx::Result<String> {
    if let Some(rid) = find_project_by_name(pool, owner, name).await? {
        return Ok(rid);
    }
    let rid = crate::id::new("PRJ");
    insert_project(pool, &rid, owner, name, false).await?;
    Ok(rid)
}

// Shared SELECT for ProjectSummary — joins `users` for the owner's
// display_name / username. `{where}` is spliced per caller.
//
// `stage` is computed: the most advanced stage of any file in the
// project, aggregated from the `file_stages` view. `status` is the
// stored column, with a 'published' overlay when the project has a
// public dashboard (the stored draft/active/archived is what the
// inline edit-cell writes; 'published' is never persisted).
const PROJECT_SELECT: &str =
    "SELECT p.redpash_id, p.name, p.description, p.is_default, p.owner_id, p.company_id,
            (SELECT CASE COALESCE(MAX(fs.stage_rank), 0)
                      WHEN 3 THEN 'publish' WHEN 2 THEN 'design' WHEN 1 THEN 'clean'
                      ELSE 'new' END
             FROM file_stages fs WHERE fs.project_redpash_id = p.redpash_id) AS stage,
            CASE WHEN EXISTS (SELECT 1 FROM project_files d
                              WHERE d.project_redpash_id = p.redpash_id
                                AND d.file_type = 'dashboard' AND d.is_public)
                 THEN 'published' ELSE p.status END AS status,
            p.created_at, p.updated_at,
            u.display_name AS owner_display_name, u.username AS owner_username,
            (SELECT COUNT(*) FROM project_files f
             WHERE f.project_redpash_id = p.redpash_id AND f.file_type <> 'chart') AS file_count
     FROM projects p JOIN users u ON u.redpash_id = p.owner_id";

fn row_to_project(r: &sqlx::postgres::PgRow) -> ProjectSummary {
    ProjectSummary {
        redpash_id:         r.get("redpash_id"),
        name:               r.get("name"),
        description:        r.try_get("description").ok(),
        file_count:         r.try_get::<i64, _>("file_count").unwrap_or(0) as u32,
        cleanness_pct:      None,
        stage:              r.get("stage"),
        status:             r.get("status"),
        is_default:         r.get("is_default"),
        owner_id:           r.get("owner_id"),
        owner_display_name: r.get("owner_display_name"),
        owner_username:     r.get("owner_username"),
        company_id:         r.get("company_id"),
        created_at:         r.get::<DateTime<Utc>, _>("created_at"),
        updated_at:         r.get::<DateTime<Utc>, _>("updated_at"),
    }
}

pub async fn list_projects(pool: &PgPool, owner: &str) -> sqlx::Result<Vec<ProjectSummary>> {
    let rows = sqlx::query(
        &format!("{PROJECT_SELECT} WHERE p.owner_id = $1
                  ORDER BY p.is_default DESC, p.created_at ASC"),
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(row_to_project).collect())
}

pub async fn get_project(pool: &PgPool, rid: &str) -> sqlx::Result<Option<ProjectSummary>> {
    let row = sqlx::query(&format!("{PROJECT_SELECT} WHERE p.redpash_id = $1"))
        .bind(rid)
        .fetch_optional(pool)
        .await?;
    Ok(row.as_ref().map(row_to_project))
}

// Sparse metadata update from the Objects overview's inline edit-mode.
// COALESCE keeps any field the caller didn't send. Returns the fresh
// ProjectSummary (re-fetched through the owner join) or None if the
// project doesn't exist. `owner` is the project's current owner —
// needed to clear their existing default when flipping `is_default` on
// (the `projects_owner_default_idx` partial unique index allows only
// one default per owner, so the two writes run in one transaction).
#[allow(clippy::too_many_arguments)]
pub async fn update_project_meta(
    pool:        &PgPool,
    rid:         &str,
    owner:       &str,
    name:        Option<&str>,
    description: Option<&str>,
    is_default:  Option<bool>,
    owner_id:    Option<&str>,
    company_id:  Option<&str>,
    status:      Option<&str>,
) -> sqlx::Result<Option<ProjectSummary>> {
    let mut tx = pool.begin().await?;
    if is_default == Some(true) {
        sqlx::query(
            "UPDATE projects SET is_default = false, updated_at = now()
             WHERE owner_id = $1 AND is_default AND redpash_id <> $2",
        )
        .bind(owner)
        .bind(rid)
        .execute(&mut *tx)
        .await?;
    }
    // COALESCE keeps any unsent field — including `company_id`, so this
    // path can set or re-scope a project's company but not clear it back
    // to personal (a dedicated unset path lands with the company UI).
    let res = sqlx::query(
        "UPDATE projects
         SET name        = COALESCE($2, name),
             description  = COALESCE($3, description),
             is_default   = COALESCE($4, is_default),
             owner_id     = COALESCE($5, owner_id),
             company_id   = COALESCE($6, company_id),
             status       = COALESCE($7, status),
             updated_at   = now()
         WHERE redpash_id = $1",
    )
    .bind(rid)
    .bind(name)
    .bind(description)
    .bind(is_default)
    .bind(owner_id)
    .bind(company_id)
    .bind(status)
    .execute(&mut *tx)
    .await?;
    if res.rows_affected() == 0 {
        tx.rollback().await?;
        return Ok(None);
    }
    tx.commit().await?;
    get_project(pool, rid).await
}

/// File RIDs in a project — the project-delete handler grabs these
/// *before* the cascade clears the rows, so it can evict the hot-frame
/// cache and unlink the on-disk blobs (the FK cascade only drops DB
/// rows, not the files on disk).
pub async fn project_file_rids(pool: &PgPool, project_rid: &str) -> sqlx::Result<Vec<String>> {
    let rows = sqlx::query("SELECT redpash_id FROM project_files WHERE project_redpash_id = $1")
        .bind(project_rid)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|r| r.get::<String, _>("redpash_id")).collect())
}

/// Delete a project — unless it's the owner's **default**. The
/// `AND NOT is_default` guard makes the check atomic with the delete:
/// `Ok(false)` means the row exists (the handler's `ensure_owner`
/// already confirmed that) but is the default, so the caller must
/// promote another project to default first. Cascades to files /
/// steps / dashboards / memberships via FK.
pub async fn delete_project(pool: &PgPool, rid: &str) -> sqlx::Result<bool> {
    let res = sqlx::query("DELETE FROM projects WHERE redpash_id = $1 AND NOT is_default")
        .bind(rid)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Create a project with full metadata. Wraps insert in a tx alongside
/// the default-flip so the `projects_owner_default_idx` partial unique
/// index never sees two defaults at once. Returns the freshly-selected
/// ProjectSummary (joined through `users` for the owner display fields).
#[allow(clippy::too_many_arguments)]
pub async fn create_project(
    pool:        &PgPool,
    rid:         &str,
    owner:       &str,
    name:        &str,
    description: Option<&str>,
    company_id:  Option<&str>,
    is_default:  bool,
) -> sqlx::Result<ProjectSummary> {
    let mut tx = pool.begin().await?;
    if is_default {
        sqlx::query(
            "UPDATE projects SET is_default = false, updated_at = now()
             WHERE owner_id = $1 AND is_default",
        )
        .bind(owner)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "INSERT INTO projects (redpash_id, owner_id, name, description, company_id, is_default)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(rid)
    .bind(owner)
    .bind(name)
    .bind(description)
    .bind(company_id)
    .bind(is_default)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    // get_project re-selects through PROJECT_SELECT so the returned row
    // carries the joined owner_display_name / stage / file_count.
    get_project(pool, rid).await.map(|opt| opt.expect("just inserted"))
}

// ─── project_files ──────────────────────────────────────────────

#[derive(FromRow)]
struct FileRow {
    redpash_id:         String,
    project_redpash_id: String,
    filename:           String,
    display_name:       Option<String>,
    file_type:          String,
    stage:              String,
    row_count:          Option<i64>,
    col_count:          Option<i32>,
    file_size_bytes:    Option<i64>,
    cleanness_pct:      Option<f32>,
    encoding:           Option<String>,
    delimiter:          Option<String>,
    storage_path:       String,
    created_at:         DateTime<Utc>,
    updated_at:         DateTime<Utc>,
}

pub struct FileFull {
    pub summary:      FileSummary,
    pub storage_path: String,
}

impl From<FileRow> for FileFull {
    fn from(r: FileRow) -> Self {
        let summary = FileSummary {
            redpash_id:         r.redpash_id,
            project_redpash_id: r.project_redpash_id,
            filename:           r.filename,
            display_name:       r.display_name,
            file_type:          r.file_type,
            stage:              r.stage,
            row_count:          r.row_count.map(|v| v as u64),
            col_count:          r.col_count.map(|v| v as u32),
            file_size_bytes:    r.file_size_bytes.map(|v| v as u64),
            cleanness_pct:      r.cleanness_pct,
            encoding:           r.encoding,
            delimiter:          r.delimiter,
            created_at:         r.created_at,
            updated_at:         r.updated_at,
            fully_null_rows:    None, // populated by hydrate, not persisted
        };
        Self { summary, storage_path: r.storage_path }
    }
}

pub async fn list_files_in_project(pool: &PgPool, project_rid: &str) -> sqlx::Result<Vec<FileSummary>> {
    // Returns every file in the project — including chart-typed rows.
    // Charts used to be filtered out here because the (deleted)
    // Reports page owned the chart surface; now that the Designer
    // is inline in the Workspace, the rail needs to list them too
    // so the user can re-open a saved chart for editing.
    let rows: Vec<FileRow> = sqlx::query_as(
        "SELECT pf.redpash_id, pf.project_redpash_id, pf.filename, pf.display_name, pf.file_type,
                fs.stage, pf.row_count, pf.col_count, pf.file_size_bytes, pf.cleanness_pct,
                pf.encoding, pf.delimiter, pf.storage_path, pf.created_at, pf.updated_at
         FROM project_files pf
         JOIN file_stages fs ON fs.file_redpash_id = pf.redpash_id
         WHERE pf.project_redpash_id = $1
         ORDER BY pf.created_at ASC",
    )
    .bind(project_rid)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| FileFull::from(r).summary).collect())
}

/// Every file owned by `owner_rid` (FK chain via project_files →
/// projects → owner_id). Powers `GET /api/files`. Returns every
/// file_type including chart — same reasoning as
/// list_files_in_project above: charts are first-class files since
/// the Designer landed inline in the Workspace.
pub async fn list_user_files(pool: &PgPool, owner_rid: &str) -> sqlx::Result<Vec<FileSummary>> {
    let rows: Vec<FileRow> = sqlx::query_as(
        "SELECT f.redpash_id, f.project_redpash_id, f.filename, f.display_name,
                f.file_type, fs.stage, f.row_count, f.col_count, f.file_size_bytes,
                f.cleanness_pct, f.encoding, f.delimiter,
                f.storage_path, f.created_at, f.updated_at
         FROM project_files f
         JOIN projects p ON p.redpash_id = f.project_redpash_id
         JOIN file_stages fs ON fs.file_redpash_id = f.redpash_id
         WHERE p.owner_id = $1
         ORDER BY f.updated_at DESC",
    )
    .bind(owner_rid)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| FileFull::from(r).summary).collect())
}

/// (rid, display_name or filename) for every file in `project_rid`
/// except `exclude_rid`. Powers the joins detector.
pub async fn list_files_in_project_except(
    pool:         &PgPool,
    project_rid:  &str,
    exclude_rid:  &str,
) -> sqlx::Result<Vec<(String, String)>> {
    let rows = sqlx::query(
        "SELECT redpash_id, COALESCE(display_name, filename) AS title
         FROM project_files
         WHERE project_redpash_id = $1 AND redpash_id <> $2
           AND file_type <> 'chart'
         ORDER BY created_at ASC",
    )
    .bind(project_rid)
    .bind(exclude_rid)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter()
        .map(|r| (r.get::<String, _>("redpash_id"), r.get::<String, _>("title")))
        .collect())
}

pub async fn find_file(pool: &PgPool, rid: &str) -> sqlx::Result<Option<FileFull>> {
    let row: Option<FileRow> = sqlx::query_as(
        "SELECT pf.redpash_id, pf.project_redpash_id, pf.filename, pf.display_name, pf.file_type,
                fs.stage, pf.row_count, pf.col_count, pf.file_size_bytes, pf.cleanness_pct,
                pf.encoding, pf.delimiter, pf.storage_path, pf.created_at, pf.updated_at
         FROM project_files pf
         JOIN file_stages fs ON fs.file_redpash_id = pf.redpash_id
         WHERE pf.redpash_id = $1",
    )
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

/// Delete a file row. `project_steps` and any chart files built from
/// it (the `source_file_id` self-FK) declare `ON DELETE CASCADE` on
/// `project_files`, so the step history and derived charts go with it.
/// Returns whether a row was actually removed (false → caller
/// surfaces a 404).
pub async fn delete_file(pool: &PgPool, rid: &str) -> sqlx::Result<bool> {
    let res = sqlx::query("DELETE FROM project_files WHERE redpash_id = $1")
        .bind(rid)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Sparse metadata update — `display_name`, `project_redpash_id`
/// (move the file to another project), `encoding` and `delimiter`. A
/// `None` leaves that column untouched (COALESCE). File `stage` is
/// computed from the `file_stages` view, not stored, so it isn't
/// editable here. Re-fetches through `find_file` so the returned
/// summary carries the joined stage.
pub async fn update_file_meta(
    pool:               &PgPool,
    rid:                &str,
    display_name:       Option<&str>,
    project_redpash_id: Option<&str>,
    encoding:           Option<&str>,
    delimiter:          Option<&str>,
) -> sqlx::Result<Option<FileFull>> {
    let res = sqlx::query(
        "UPDATE project_files
         SET display_name       = COALESCE($2, display_name),
             project_redpash_id = COALESCE($3, project_redpash_id),
             encoding           = COALESCE($4, encoding),
             delimiter          = COALESCE($5, delimiter),
             updated_at         = now()
         WHERE redpash_id = $1",
    )
    .bind(rid)
    .bind(display_name)
    .bind(project_redpash_id)
    .bind(encoding)
    .bind(delimiter)
    .execute(pool)
    .await?;
    if res.rows_affected() == 0 {
        return Ok(None);
    }
    find_file(pool, rid).await
}

pub async fn update_file_encoding(pool: &PgPool, rid: &str, encoding: &str) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE project_files SET encoding = $1, updated_at = now() WHERE redpash_id = $2",
    )
    .bind(encoding)
    .bind(rid)
    .execute(pool)
    .await?;
    Ok(())
}

/// Null-out a file's cleanness score (testing/dev convenience). Used
/// by `DELETE /api/files/:rid/cleanness` so the user can clear scores
/// and re-run the score-files button to verify the recompute path.
pub async fn clear_file_cleanness(pool: &PgPool, rid: &str) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE project_files SET cleanness_pct = NULL, updated_at = now()
         WHERE redpash_id = $1",
    )
    .bind(rid)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn update_file_columns(
    pool:      &PgPool,
    rid:       &str,
    columns:   &[ColumnMeta],
    row_count: u64,
    col_count: u32,
    cleanness: Option<f32>,
) -> sqlx::Result<()> {
    let cols_json = serde_json::to_value(columns).unwrap_or(serde_json::json!([]));
    sqlx::query(
        "UPDATE project_files
         SET columns_meta = $1, row_count = $2, col_count = $3,
             cleanness_pct = $4, updated_at = now()
         WHERE redpash_id = $5",
    )
    .bind(cols_json)
    .bind(row_count as i64)
    .bind(col_count as i32)
    .bind(cleanness)
    .bind(rid)
    .execute(pool)
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn insert_file(
    pool:         &PgPool,
    rid:          &str,
    project:      &str,
    filename:     &str,
    encoding:     &str,
    row_count:    u64,
    col_count:    u32,
    size_bytes:   u64,
    storage_path: &str,
    columns:      &[ColumnMeta],
    cleanness:    Option<f32>,
) -> sqlx::Result<()> {
    let cols_json = serde_json::to_value(columns).unwrap_or(serde_json::json!([]));
    sqlx::query(
        "INSERT INTO project_files
            (redpash_id, project_redpash_id, filename, display_name,
             row_count, col_count, file_size_bytes, encoding, storage_path,
             columns_meta, cleanness_pct)
         VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(rid)
    .bind(project)
    .bind(filename)
    .bind(row_count as i64)
    .bind(col_count as i32)
    .bind(size_bytes as i64)
    .bind(encoding)
    .bind(storage_path)
    .bind(cols_json)
    .bind(cleanness)
    .execute(pool)
    .await?;
    Ok(())
}

// ─── charts (chart-typed project_files rows) ────────────────────

#[derive(FromRow)]
struct ChartRow {
    redpash_id:         String,
    project_redpash_id: String,
    source_file_id:     String,
    title:              String,
    spec:               serde_json::Value,
    created_at:         DateTime<Utc>,
    updated_at:         DateTime<Utc>,
}
impl From<ChartRow> for Chart {
    fn from(r: ChartRow) -> Self {
        Self {
            redpash_id:         r.redpash_id,
            project_redpash_id: r.project_redpash_id,
            source_file_id:     r.source_file_id,
            title:              r.title,
            spec:               r.spec,
            created_at:         r.created_at,
            updated_at:         r.updated_at,
        }
    }
}

// A chart is a project_files row with file_type='chart'. `title` is
// COALESCE(display_name, filename) — both are set to the chart title.
const CHART_COLS: &str = "redpash_id, project_redpash_id, source_file_id,
                          COALESCE(display_name, filename) AS title,
                          spec, created_at, updated_at";

pub async fn list_charts(pool: &PgPool, owner: &str) -> sqlx::Result<Vec<Chart>> {
    // Single-table SELECT — a JOIN to `projects` collides the shared,
    // unqualified CHART_COLS on redpash_id / created_at / updated_at
    // ("column reference redpash_id is ambiguous"). Owner filter runs as
    // a subquery so CHART_COLS stays usable as-is, shared unchanged with
    // find_chart / insert_chart / update_chart.
    let rows: Vec<ChartRow> = sqlx::query_as(&format!(
        "SELECT {CHART_COLS} FROM project_files
         WHERE file_type = 'chart'
           AND project_redpash_id IN (
             SELECT redpash_id FROM projects WHERE owner_id = $1)
         ORDER BY updated_at DESC"
    ))
    .bind(owner)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn find_chart(pool: &PgPool, rid: &str) -> sqlx::Result<Option<Chart>> {
    let row: Option<ChartRow> = sqlx::query_as(&format!(
        "SELECT {CHART_COLS} FROM project_files
         WHERE redpash_id = $1 AND file_type = 'chart'"
    ))
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

pub async fn insert_chart(
    pool:    &PgPool,
    rid:     &str,
    project: &str,
    source:  &str,
    title:   &str,
    spec:    &serde_json::Value,
) -> sqlx::Result<Chart> {
    let row: ChartRow = sqlx::query_as(&format!(
        "INSERT INTO project_files
            (redpash_id, project_redpash_id, filename, display_name,
             file_type, source_file_id, storage_path, spec)
         VALUES ($1, $2, $3, $3, 'chart', $4, '', $5)
         RETURNING {CHART_COLS}"
    ))
    .bind(rid)
    .bind(project)
    .bind(title)
    .bind(source)
    .bind(spec)
    .fetch_one(pool)
    .await?;
    Ok(row.into())
}

pub async fn update_chart(
    pool:  &PgPool,
    rid:   &str,
    title: &str,
    spec:  &serde_json::Value,
) -> sqlx::Result<Option<Chart>> {
    let row: Option<ChartRow> = sqlx::query_as(&format!(
        "UPDATE project_files
         SET filename = $1, display_name = $1, spec = $2, updated_at = now()
         WHERE redpash_id = $3 AND file_type = 'chart'
         RETURNING {CHART_COLS}"
    ))
    .bind(title)
    .bind(spec)
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

pub async fn delete_chart(pool: &PgPool, rid: &str) -> sqlx::Result<bool> {
    let n = sqlx::query("DELETE FROM project_files WHERE redpash_id = $1 AND file_type = 'chart'")
        .bind(rid)
        .execute(pool)
        .await?;
    Ok(n.rows_affected() > 0)
}

pub async fn chart_owner(pool: &PgPool, rid: &str) -> sqlx::Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT p.owner_id FROM project_files pf
         JOIN projects p ON p.redpash_id = pf.project_redpash_id
         WHERE pf.redpash_id = $1 AND pf.file_type = 'chart'",
    )
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(o,)| o))
}

// ─── dashboards ─────────────────────────────────────────────────

#[derive(FromRow)]
struct DashboardRow {
    redpash_id:         String,
    project_redpash_id: String,
    title:              String,
    description:        Option<String>,
    spec:               serde_json::Value,
    is_favorite:        bool,
    is_public:          bool,
    folder:             Option<String>,
    created_at:         DateTime<Utc>,
    updated_at:         DateTime<Utc>,
    // Owner join — only present in list_dashboards' SELECT. #[sqlx(default)]
    // keeps single-row fetchers (find / update / patch / set_favorite)
    // working without the join.
    #[sqlx(default)] owner_id:           Option<String>,
    #[sqlx(default)] owner_display_name: Option<String>,
    #[sqlx(default)] owner_username:     Option<String>,
}
impl From<DashboardRow> for Dashboard {
    fn from(r: DashboardRow) -> Self {
        Self {
            redpash_id:         r.redpash_id,
            project_redpash_id: r.project_redpash_id,
            title:              r.title,
            description:        r.description,
            spec:               serde_json::from_value(r.spec).unwrap_or_default(),
            is_favorite:        r.is_favorite,
            is_public:          r.is_public,
            folder:             r.folder,
            owner_id:           r.owner_id,
            owner_display_name: r.owner_display_name,
            owner_username:     r.owner_username,
            created_at:         r.created_at,
            updated_at:         r.updated_at,
        }
    }
}

// A dashboard is a project_files row with file_type='dashboard'.
// `title` is COALESCE(display_name, filename) — both hold the title.
const DASHBOARD_COLS: &str = "redpash_id, project_redpash_id,
                              COALESCE(display_name, filename) AS title,
                              description, spec, is_favorite, is_public,
                              folder, created_at, updated_at";

pub async fn list_dashboards(pool: &PgPool, owner: &str) -> sqlx::Result<Vec<Dashboard>> {
    let rows: Vec<DashboardRow> = sqlx::query_as(
        "SELECT d.redpash_id, d.project_redpash_id,
                COALESCE(d.display_name, d.filename) AS title,
                d.description, d.spec,
                d.is_favorite, d.is_public, d.folder, d.created_at, d.updated_at,
                p.owner_id AS owner_id,
                u.display_name AS owner_display_name,
                u.username AS owner_username
         FROM project_files d
         JOIN projects p ON p.redpash_id = d.project_redpash_id
         JOIN users    u ON u.redpash_id = p.owner_id
         WHERE d.file_type = 'dashboard' AND p.owner_id = $1
         ORDER BY d.folder ASC NULLS LAST, d.is_favorite DESC, d.updated_at DESC",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn find_dashboard(pool: &PgPool, rid: &str) -> sqlx::Result<Option<Dashboard>> {
    let row: Option<DashboardRow> = sqlx::query_as(&format!(
        "SELECT {DASHBOARD_COLS} FROM project_files
         WHERE redpash_id = $1 AND file_type = 'dashboard'"
    ))
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

pub async fn insert_dashboard(
    pool:    &PgPool,
    rid:     &str,
    project: &str,
    title:   &str,
    spec:    &DashboardSpec,
    folder:  Option<&str>,
    description: Option<&str>,
) -> sqlx::Result<Dashboard> {
    let spec_json = serde_json::to_value(spec).unwrap_or(serde_json::json!({}));
    let row: DashboardRow = sqlx::query_as(&format!(
        "INSERT INTO project_files
            (redpash_id, project_redpash_id, filename, display_name,
             file_type, storage_path, spec, description, folder)
         VALUES ($1, $2, $3, $3, 'dashboard', '', $5, $4, $6)
         RETURNING {DASHBOARD_COLS}"
    ))
    .bind(rid)
    .bind(project)
    .bind(title)
    .bind(description)
    .bind(spec_json)
    .bind(folder)
    .fetch_one(pool)
    .await?;
    Ok(row.into())
}

pub async fn update_dashboard(
    pool:    &PgPool,
    rid:     &str,
    title:   &str,
    spec:    &DashboardSpec,
    folder:  Option<&str>,
    description: Option<&str>,
) -> sqlx::Result<Option<Dashboard>> {
    let spec_json = serde_json::to_value(spec).unwrap_or(serde_json::json!({}));
    let row: Option<DashboardRow> = sqlx::query_as(&format!(
        "UPDATE project_files
         SET filename = $1, display_name = $1, description = $2,
             spec = $3, folder = $4, updated_at = now()
         WHERE redpash_id = $5 AND file_type = 'dashboard'
         RETURNING {DASHBOARD_COLS}"
    ))
    .bind(title)
    .bind(description)
    .bind(spec_json)
    .bind(folder)
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

pub async fn delete_dashboard(pool: &PgPool, rid: &str) -> sqlx::Result<bool> {
    let n = sqlx::query("DELETE FROM project_files WHERE redpash_id = $1 AND file_type = 'dashboard'")
        .bind(rid)
        .execute(pool)
        .await?;
    Ok(n.rows_affected() > 0)
}

/// Sparse metadata update for the Dashboards-tab inline editor.
/// `None` keeps the existing column value (COALESCE).
pub async fn patch_dashboard_meta(
    pool:        &PgPool,
    rid:         &str,
    title:       Option<&str>,
    description: Option<&str>,
    folder:      Option<&str>,
    is_favorite: Option<bool>,
    is_public:   Option<bool>,
) -> sqlx::Result<Option<Dashboard>> {
    let row: Option<DashboardRow> = sqlx::query_as(&format!(
        "UPDATE project_files
         SET filename     = COALESCE($2, filename),
             display_name = COALESCE($2, display_name),
             description  = COALESCE($3, description),
             folder       = COALESCE($4, folder),
             is_favorite  = COALESCE($5, is_favorite),
             is_public    = COALESCE($6, is_public),
             updated_at   = now()
         WHERE redpash_id = $1 AND file_type = 'dashboard'
         RETURNING {DASHBOARD_COLS}"
    ))
    .bind(rid)
    .bind(title)
    .bind(description)
    .bind(folder)
    .bind(is_favorite)
    .bind(is_public)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

pub async fn set_dashboard_favorite(
    pool:  &PgPool,
    rid:   &str,
    value: bool,
) -> sqlx::Result<Option<Dashboard>> {
    let row: Option<DashboardRow> = sqlx::query_as(&format!(
        "UPDATE project_files SET is_favorite = $1, updated_at = now()
         WHERE redpash_id = $2 AND file_type = 'dashboard'
         RETURNING {DASHBOARD_COLS}"
    ))
    .bind(value)
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

// ─── project_steps ──────────────────────────────────────────────

#[derive(FromRow)]
struct StepRow {
    redpash_id:      String,
    file_redpash_id: String,
    ordinal:         i32,
    kind:            String,
    params:          serde_json::Value,
    applied:         bool,
    created_at:      DateTime<Utc>,
}
impl From<StepRow> for ProjectStep {
    fn from(r: StepRow) -> Self {
        Self {
            redpash_id:      r.redpash_id,
            file_redpash_id: r.file_redpash_id,
            ordinal:         r.ordinal,
            kind:            r.kind,
            params:          r.params,
            applied:         r.applied,
            created_at:      r.created_at,
        }
    }
}

/// All steps for a file in ordinal order — applied AND undone.
/// Frontend uses the full list to draw the Applied panel (with greyed
/// undone entries) and to enable/disable Undo + Redo buttons.
pub async fn list_steps(pool: &PgPool, file_rid: &str) -> sqlx::Result<Vec<ProjectStep>> {
    let rows: Vec<StepRow> = sqlx::query_as(
        "SELECT redpash_id, file_redpash_id, ordinal, kind, params, applied, created_at
         FROM project_steps WHERE file_redpash_id = $1 ORDER BY ordinal ASC",
    )
    .bind(file_rid)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

/// Append a new step. Clears the redo stack (deletes any undone rows
/// for the file) so the new step branches from the live cursor.
pub async fn insert_step(
    pool:     &PgPool,
    rid:      &str,
    file_rid: &str,
    kind:     &str,
    params:   &serde_json::Value,
) -> sqlx::Result<ProjectStep> {
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM project_steps WHERE file_redpash_id = $1 AND applied = false")
        .bind(file_rid).execute(&mut *tx).await?;

    let next_ord: i32 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(ordinal), 0) + 1 FROM project_steps WHERE file_redpash_id = $1",
    )
    .bind(file_rid)
    .fetch_one(&mut *tx)
    .await?;

    let row: StepRow = sqlx::query_as(
        "INSERT INTO project_steps (redpash_id, file_redpash_id, ordinal, kind, params)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING redpash_id, file_redpash_id, ordinal, kind, params, applied, created_at",
    )
    .bind(rid)
    .bind(file_rid)
    .bind(next_ord)
    .bind(kind)
    .bind(params)
    .fetch_one(&mut *tx)
    .await?;

    // Implicit unarchive: any cleaning activity on a file inside an
    // archived project means the user is no longer "done with it" —
    // flip the parent project's status back to 'draft' so the Objects
    // page derived status (archived > active > draft) re-evaluates and
    // shows it as Active (since opening the cleaner puts it in the
    // user's open-projects set). No-op when the project isn't
    // archived. Runs in-tx so the step + the unarchive land together.
    sqlx::query(
        "UPDATE projects
         SET status = 'draft', updated_at = now()
         WHERE redpash_id = (
             SELECT project_redpash_id FROM project_files WHERE redpash_id = $1
         )
         AND status = 'archived'",
    )
    .bind(file_rid)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(row.into())
}

/// Flip the highest-ordinal applied step to `applied = false`.
/// Returns whether anything changed.
pub async fn undo_last(pool: &PgPool, file_rid: &str) -> sqlx::Result<bool> {
    let n = sqlx::query(
        "UPDATE project_steps SET applied = false
         WHERE redpash_id = (
             SELECT redpash_id FROM project_steps
             WHERE file_redpash_id = $1 AND applied = true
             ORDER BY ordinal DESC LIMIT 1
         )",
    )
    .bind(file_rid)
    .execute(pool)
    .await?;
    Ok(n.rows_affected() > 0)
}

/// Surgically un-apply every step of a given kind on a file. Unlike
/// `undo_last` (LIFO) this flips `applied = false` for ALL matching
/// rows regardless of position, so a buried filter_rows step can be
/// cleared without disturbing the steps applied on top of it. Returns
/// the number of rows touched (caller may surface a "Cleared N" toast).
///
/// Rows aren't deleted — they just leave the applied chain. Redo
/// won't pick them back up either (redo picks the LOWEST-ordinal
/// undone step, which is fine: these become permanently undone unless
/// the user re-applies them via the panel).
pub async fn clear_steps_of_kind(pool: &PgPool, file_rid: &str, kind: &str)
    -> sqlx::Result<u64>
{
    let n = sqlx::query(
        "UPDATE project_steps SET applied = false
         WHERE file_redpash_id = $1 AND kind = $2 AND applied = true",
    )
    .bind(file_rid)
    .bind(kind)
    .execute(pool)
    .await?;
    Ok(n.rows_affected())
}

/// Flip the lowest-ordinal undone step back to `applied = true`.
pub async fn redo_next(pool: &PgPool, file_rid: &str) -> sqlx::Result<bool> {
    let n = sqlx::query(
        "UPDATE project_steps SET applied = true
         WHERE redpash_id = (
             SELECT redpash_id FROM project_steps
             WHERE file_redpash_id = $1 AND applied = false
             ORDER BY ordinal ASC LIMIT 1
         )",
    )
    .bind(file_rid)
    .execute(pool)
    .await?;
    Ok(n.rows_affected() > 0)
}

// ─── Phase 4c: ownership-scoped lookups ──────────────────────────
//
// Each helper resolves the owner user RID for a given resource by
// following the FK chain to `projects.owner_id`. Returns `None` when
// the resource doesn't exist — handlers map both "doesn't exist" and
// "exists but not yours" to the same 404 `not_found` so existence
// isn't leaked.

pub async fn project_owner(pool: &PgPool, rid: &str) -> sqlx::Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT owner_id FROM projects WHERE redpash_id = $1",
    )
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(o,)| o))
}

pub async fn dashboard_owner(pool: &PgPool, rid: &str) -> sqlx::Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT p.owner_id FROM project_files pf
         JOIN projects p ON p.redpash_id = pf.project_redpash_id
         WHERE pf.redpash_id = $1 AND pf.file_type = 'dashboard'",
    )
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(o,)| o))
}

pub async fn file_owner(pool: &PgPool, rid: &str) -> sqlx::Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT p.owner_id FROM project_files f
         JOIN projects p ON p.redpash_id = f.project_redpash_id
         WHERE f.redpash_id = $1",
    )
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(o,)| o))
}

// ─── companies ──────────────────────────────────────────────────
//
// A company is the multi-tenancy boundary. `company_memberships` is a
// pure join table — composite PK `(company_id, user_redpash_id)`, no
// redpash_id — and it doubles as the access-control check: a user with
// no membership row simply can't see the company.

#[derive(FromRow)]
struct CompanyRow {
    redpash_id: String,
    name:       String,
    slug:       String,
    avatar_url: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
impl From<CompanyRow> for Company {
    fn from(r: CompanyRow) -> Self {
        Self {
            redpash_id: r.redpash_id,
            name:       r.name,
            slug:       r.slug,
            avatar_url: r.avatar_url,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

const COMPANY_COLS: &str = "redpash_id, name, slug, avatar_url, created_at, updated_at";

/// Companies the user belongs to, each carrying the caller's own role
/// and the total member count.
/// Returns every company. `my_role` is the caller's role when they
/// belong to the company, or `None` when they don't — the Companies
/// tab surfaces non-member companies too so the user can discover and
/// request to join. Caller-scoped writes (member CRUD, company edits)
/// still enforce `company_role()` checks at the route layer.
pub async fn list_companies(pool: &PgPool, user_rid: &str) -> sqlx::Result<Vec<CompanySummary>> {
    let rows = sqlx::query(
        "SELECT c.redpash_id, c.name, c.slug, c.avatar_url, c.created_at, c.updated_at,
                m.role AS my_role,
                (SELECT COUNT(*) FROM company_memberships cm
                 WHERE cm.company_id = c.redpash_id) AS member_count
         FROM companies c
         LEFT JOIN company_memberships m
                ON m.company_id = c.redpash_id AND m.user_redpash_id = $1
         ORDER BY c.name ASC",
    )
    .bind(user_rid)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| CompanySummary {
            company: Company {
                redpash_id: r.get("redpash_id"),
                name:       r.get("name"),
                slug:       r.get("slug"),
                avatar_url: r.get("avatar_url"),
                created_at: r.get("created_at"),
                updated_at: r.get("updated_at"),
            },
            member_count: r.try_get::<i64, _>("member_count").unwrap_or(0) as u32,
            my_role:      r.try_get("my_role").ok(),
        })
        .collect())
}

pub async fn get_company(pool: &PgPool, rid: &str) -> sqlx::Result<Option<Company>> {
    let row: Option<CompanyRow> = sqlx::query_as(&format!(
        "SELECT {COMPANY_COLS} FROM companies WHERE redpash_id = $1"
    ))
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

/// The caller's role in a company, or `None` when they aren't a member.
/// Handlers treat `None` the same as "company doesn't exist" (404) so
/// existence isn't leaked.
pub async fn company_role(
    pool:        &PgPool,
    company_rid: &str,
    user_rid:    &str,
) -> sqlx::Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT role FROM company_memberships
         WHERE company_id = $1 AND user_redpash_id = $2",
    )
    .bind(company_rid)
    .bind(user_rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(r,)| r))
}

/// Count of owners — guards the "can't strand a company without an
/// owner" rule on member removal / demotion.
pub async fn company_owner_count(pool: &PgPool, company_rid: &str) -> sqlx::Result<i64> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM company_memberships
         WHERE company_id = $1 AND role = 'owner'",
    )
    .bind(company_rid)
    .fetch_one(pool)
    .await?;
    Ok(n)
}

/// Create a company and seat the creator as its owner — both writes in
/// one transaction so a company never exists without an owner.
pub async fn create_company(
    pool:      &PgPool,
    rid:       &str,
    name:      &str,
    slug:      &str,
    owner_rid: &str,
) -> sqlx::Result<Company> {
    let mut tx = pool.begin().await?;
    let row: CompanyRow = sqlx::query_as(&format!(
        "INSERT INTO companies (redpash_id, name, slug)
         VALUES ($1, $2, $3)
         RETURNING {COMPANY_COLS}"
    ))
    .bind(rid)
    .bind(name)
    .bind(slug)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO company_memberships (company_id, user_redpash_id, role)
         VALUES ($1, $2, 'owner')",
    )
    .bind(rid)
    .bind(owner_rid)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(row.into())
}

/// Sparse update — `name` / `avatar_url` only. `slug` is immutable.
/// Returns the refreshed record, or `None` when the company is gone.
pub async fn update_company(
    pool:       &PgPool,
    rid:        &str,
    name:       Option<&str>,
    slug:       Option<String>,
    avatar_url: Option<&str>,
) -> sqlx::Result<Option<Company>> {
    let row: Option<CompanyRow> = sqlx::query_as(&format!(
        "UPDATE companies
         SET name       = COALESCE($2, name),
             slug       = COALESCE($3, slug),
             avatar_url = COALESCE($4, avatar_url),
             updated_at = now()
         WHERE redpash_id = $1
         RETURNING {COMPANY_COLS}"
    ))
    .bind(rid)
    .bind(name)
    .bind(slug)
    .bind(avatar_url)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

/// Delete a company. `company_memberships` cascades; `projects.company_id`
/// is `SET NULL` so company projects survive as personal projects.
pub async fn delete_company(pool: &PgPool, rid: &str) -> sqlx::Result<bool> {
    let n = sqlx::query("DELETE FROM companies WHERE redpash_id = $1")
        .bind(rid)
        .execute(pool)
        .await?;
    Ok(n.rows_affected() > 0)
}

pub async fn list_company_members(
    pool:        &PgPool,
    company_rid: &str,
) -> sqlx::Result<Vec<CompanyMember>> {
    let rows = sqlx::query(
        "SELECT m.user_redpash_id, m.role, m.joined_at,
                u.display_name, u.username, u.avatar_url
         FROM company_memberships m
         JOIN users u ON u.redpash_id = m.user_redpash_id
         WHERE m.company_id = $1
         ORDER BY m.joined_at ASC",
    )
    .bind(company_rid)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| CompanyMember {
            user_redpash_id: r.get("user_redpash_id"),
            display_name:    r.get("display_name"),
            username:        r.get("username"),
            avatar_url:      r.get("avatar_url"),
            role:            r.get("role"),
            joined_at:       r.get("joined_at"),
        })
        .collect())
}

/// Add a member, or update their role if they're already in the company
/// — the composite PK makes this an upsert.
pub async fn add_company_member(
    pool:        &PgPool,
    company_rid: &str,
    user_rid:    &str,
    role:        &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO company_memberships (company_id, user_redpash_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (company_id, user_redpash_id)
         DO UPDATE SET role = EXCLUDED.role",
    )
    .bind(company_rid)
    .bind(user_rid)
    .bind(role)
    .execute(pool)
    .await?;
    Ok(())
}

/// Strict UPDATE — used by `PATCH /:rid/members/:user_id`. Returns
/// whether the membership existed; the route handler `?`s into a
/// 404 when it didn't. Distinct from `add_company_member`'s upsert
/// path so a client that thinks it's editing an existing member
/// doesn't silently create one when the FK isn't there.
pub async fn update_company_member_role(
    pool:        &PgPool,
    company_rid: &str,
    user_rid:    &str,
    role:        &str,
) -> sqlx::Result<bool> {
    let n = sqlx::query(
        "UPDATE company_memberships SET role = $3
          WHERE company_id = $1 AND user_redpash_id = $2",
    )
    .bind(company_rid)
    .bind(user_rid)
    .bind(role)
    .execute(pool)
    .await?;
    Ok(n.rows_affected() > 0)
}

pub async fn remove_company_member(
    pool:        &PgPool,
    company_rid: &str,
    user_rid:    &str,
) -> sqlx::Result<bool> {
    let n = sqlx::query(
        "DELETE FROM company_memberships
         WHERE company_id = $1 AND user_redpash_id = $2",
    )
    .bind(company_rid)
    .bind(user_rid)
    .execute(pool)
    .await?;
    Ok(n.rows_affected() > 0)
}

// ─── events ─────────────────────────────────────────────────────
//
// Read side only — the INSERT lives in `crate::event::record`, which
// runs fire-and-forget off a detached task (the request path must
// never block on, or fail because of, event logging).

#[derive(FromRow)]
struct EventRow {
    redpash_id:      String,
    occurred_at:     DateTime<Utc>,
    origin:          String,
    level:           String,
    kind:            String,
    message:         String,
    source:          Option<String>,
    user_redpash_id: Option<String>,
    session_id:      Option<String>,
    request_id:      Option<String>,
    http_method:     Option<String>,
    http_path:       Option<String>,
    http_status:     Option<i32>,
    duration_ms:     Option<i32>,
    context:         serde_json::Value,
}
impl From<EventRow> for Event {
    fn from(r: EventRow) -> Self {
        Self {
            redpash_id:      r.redpash_id,
            occurred_at:     r.occurred_at,
            origin:          r.origin,
            level:           r.level,
            kind:            r.kind,
            message:         r.message,
            source:          r.source,
            user_redpash_id: r.user_redpash_id,
            session_id:      r.session_id,
            request_id:      r.request_id,
            http_method:     r.http_method,
            http_path:       r.http_path,
            http_status:     r.http_status,
            duration_ms:     r.duration_ms,
            context:         r.context,
        }
    }
}

const EVENT_COLS: &str =
    "redpash_id, occurred_at, origin, level, kind, message, source,
     user_redpash_id, session_id, request_id, http_method, http_path,
     http_status, duration_ms, context";

/// Recent events, newest first. `level` / `kind` are optional exact-match
/// filters — the `$n::text IS NULL OR …` form means a `None` bind skips
/// that filter without dynamic SQL. `limit` is clamped by the caller.
pub async fn list_events(
    pool:  &PgPool,
    level: Option<&str>,
    kind:  Option<&str>,
    limit: i64,
) -> sqlx::Result<Vec<Event>> {
    let rows: Vec<EventRow> = sqlx::query_as(&format!(
        "SELECT {EVENT_COLS} FROM events
         WHERE ($1::text IS NULL OR level = $1)
           AND ($2::text IS NULL OR kind  = $2)
         ORDER BY occurred_at DESC
         LIMIT $3"
    ))
    .bind(level)
    .bind(kind)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn find_event(pool: &PgPool, rid: &str) -> sqlx::Result<Option<Event>> {
    let row: Option<EventRow> = sqlx::query_as(&format!(
        "SELECT {EVENT_COLS} FROM events WHERE redpash_id = $1"
    ))
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}
