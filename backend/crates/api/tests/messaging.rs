//! Messaging backend — the reach/privacy bar + the cascade + the DM/unread SQL the
//! handlers run, against real Postgres. Exercised through the SAME `require_action`
//! gate the handlers call (the dev_user fake-green trap avoided — real seeded
//! callers). Needs DATABASE_URL; skips when unset.
//!
//! Proves: a channel member reaches the channel + its messages (View/Edit), a
//! NON-member is denied leak-free 404 (a DM is invisible to outsiders — the whole
//! point); message-reach cascades from channel membership (message.scope_parents=
//! ["channel_id"]); the DM get-or-create finds the existing 1:1 channel; unread =
//! messages newer than the caller's last read.

use api::{
    db, id,
    rbac::{self, Action, Caller},
    type_cache::TypeDefCache,
};
use sqlx::PgPool;

async fn seed_user(pool: &PgPool, name: &str) -> String {
    let rid = id::new("USR");
    let mut tx = pool.begin().await.unwrap();
    db::register_entity(&mut tx, &rid, "user").await.unwrap();
    sqlx::query("INSERT INTO users (redpash_id, username, display_name) VALUES ($1,$2,$2)")
        .bind(&rid)
        .bind(format!("{name}-{}", &rid[4..10]))
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    rid
}

/// Create a channel owned by `owner`, with `members` added as `member`.
async fn seed_channel(pool: &PgPool, kind: &str, name: &str, owner: &str, members: &[&str]) -> String {
    let rid = id::new("CHN");
    let mut tx = pool.begin().await.unwrap();
    db::register_entity(&mut tx, &rid, "channel").await.unwrap();
    sqlx::query("INSERT INTO channels (redpash_id, name, kind) VALUES ($1,$2,$3)")
        .bind(&rid)
        .bind(name)
        .bind(kind)
        .execute(&mut *tx)
        .await
        .unwrap();
    db::grant_owner(&mut tx, &rid, owner).await.unwrap();
    for m in members {
        sqlx::query(
            "INSERT INTO memberships (object_redpash_id, member_redpash_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING",
        )
        .bind(&rid)
        .bind(m)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    rid
}

async fn seed_message(pool: &PgPool, channel: &str, author: &str, body: &str) -> String {
    let rid = id::new("MSG");
    let mut tx = pool.begin().await.unwrap();
    db::register_entity(&mut tx, &rid, "message").await.unwrap();
    sqlx::query("INSERT INTO messages (redpash_id, channel_id, author_id, body) VALUES ($1,$2,$3,$4)")
        .bind(&rid)
        .bind(channel)
        .bind(author)
        .bind(body)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    rid
}

#[tokio::test]
async fn channel_reach_message_cascade_and_dm_unread() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("messaging: DATABASE_URL unset — skipped");
        return;
    };
    let pool = PgPool::connect(&url).await.expect("connect");
    sqlx::migrate!("../../migrations").run(&pool).await.expect("migrate");
    let cache = TypeDefCache::load(&pool).await.expect("cache");

    let alice = Caller { rid: seed_user(&pool, "msg-alice").await, is_platform_admin: false };
    let bob = Caller { rid: seed_user(&pool, "msg-bob").await, is_platform_admin: false };
    let carol = Caller { rid: seed_user(&pool, "msg-carol").await, is_platform_admin: false };

    // a channel: alice owns, bob is a member, carol is NOT.
    let chan = seed_channel(&pool, "channel", "general", &alice.rid, &[&bob.rid]).await;
    let msg = seed_message(&pool, &chan, &alice.rid, "hello").await;

    // ── reach + the privacy bar ──
    assert!(view_ok(&pool, &cache, &alice, &chan).await, "owner reaches the channel");
    assert!(edit_ok(&pool, &cache, &alice, &chan).await, "owner can post");
    assert!(view_ok(&pool, &cache, &bob, &chan).await, "member reaches the channel");
    assert!(edit_ok(&pool, &cache, &bob, &chan).await, "member can post");
    // the load-bearing assertion: a non-member is denied leak-free 404 (NOT 403).
    let denied = rbac::require_action(&pool, &cache, &carol, &chan, Action::View).await;
    assert_eq!(
        denied.err().map(|e| e.status),
        Some(axum::http::StatusCode::NOT_FOUND),
        "a non-member must not even see the channel exists"
    );

    // ── message-reach CASCADES from channel membership ──
    assert!(view_ok(&pool, &cache, &bob, &msg).await, "a channel member reaches its messages");
    let msg_denied = rbac::require_action(&pool, &cache, &carol, &msg, Action::View).await;
    assert_eq!(
        msg_denied.err().map(|e| e.status),
        Some(axum::http::StatusCode::NOT_FOUND),
        "a non-member can't reach the channel's messages either"
    );

    // ── DM get-or-create: the existing 1:1 channel is found by the member pair ──
    let dm = seed_channel(&pool, "dm", "", &alice.rid, &[&bob.rid]).await;
    let found: Option<String> = sqlx::query_scalar(
        "SELECT c.redpash_id FROM channels c
          WHERE c.kind = 'dm'
            AND EXISTS (SELECT 1 FROM memberships m WHERE m.object_redpash_id = c.redpash_id AND m.member_redpash_id = $1)
            AND EXISTS (SELECT 1 FROM memberships m WHERE m.object_redpash_id = c.redpash_id AND m.member_redpash_id = $2)
            AND (SELECT COUNT(DISTINCT m.member_redpash_id) FROM memberships m WHERE m.object_redpash_id = c.redpash_id) = 2
          LIMIT 1",
    )
    .bind(&alice.rid)
    .bind(&bob.rid)
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert_eq!(found.as_deref(), Some(dm.as_str()), "get-or-create finds the existing dm for the pair");
    // a pair that has no dm finds nothing.
    let none: Option<String> = sqlx::query_scalar(
        "SELECT c.redpash_id FROM channels c
          WHERE c.kind = 'dm'
            AND EXISTS (SELECT 1 FROM memberships m WHERE m.object_redpash_id = c.redpash_id AND m.member_redpash_id = $1)
            AND EXISTS (SELECT 1 FROM memberships m WHERE m.object_redpash_id = c.redpash_id AND m.member_redpash_id = $2)
            AND (SELECT COUNT(DISTINCT m.member_redpash_id) FROM memberships m WHERE m.object_redpash_id = c.redpash_id) = 2
          LIMIT 1",
    )
    .bind(&alice.rid)
    .bind(&carol.rid)
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert_eq!(none, None, "no dm exists for alice+carol");

    // ── unread = messages newer than the caller's last read ──
    // bob hasn't read `chan` → the 1 message is unread.
    assert_eq!(unread(&pool, &chan, &bob.rid).await, 1, "unread before any read");
    sqlx::query(
        "INSERT INTO channel_reads (channel_id, user_id, last_read_at) VALUES ($1,$2, now())
         ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at",
    )
    .bind(&chan)
    .bind(&bob.rid)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(unread(&pool, &chan, &bob.rid).await, 0, "read clears unread");
    seed_message(&pool, &chan, &alice.rid, "after read").await;
    assert_eq!(unread(&pool, &chan, &bob.rid).await, 1, "a newer message is unread again");

    // teardown (cascade clears messages/reads/memberships).
    for rid in [&dm, &chan, &alice.rid, &bob.rid, &carol.rid] {
        let _ = db::delete_entity(&pool, rid).await;
    }
}

async fn view_ok(pool: &PgPool, cache: &TypeDefCache, c: &Caller, rid: &str) -> bool {
    rbac::require_action(pool, cache, c, rid, Action::View).await.is_ok()
}
async fn edit_ok(pool: &PgPool, cache: &TypeDefCache, c: &Caller, rid: &str) -> bool {
    rbac::require_action(pool, cache, c, rid, Action::Edit).await.is_ok()
}

/// The exact unread expression the handlers run.
async fn unread(pool: &PgPool, channel: &str, user: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM messages m
          WHERE m.channel_id = $1
            AND m.created_at > COALESCE(
                (SELECT r.last_read_at FROM channel_reads r WHERE r.channel_id = $1 AND r.user_id = $2),
                'epoch'::timestamptz)",
    )
    .bind(channel)
    .bind(user)
    .fetch_one(pool)
    .await
    .unwrap()
}
