---
title: Connectors
section: API
order: 20
last modified date: 2026-06-04
---

# `/api/connectors/*`

A **connector** is a persisted connection (Kafka today; S3 / DB-CDC later) that
holds the **user's chosen destination project**, so a data load lands where the
user picked — not in a hardcoded project. It's the framework half of
connector-through-framework: the connector behaves like a UI upload, and a UI
upload asks which project (Em 2026-06-04).

A connector is a first-class entity in the polymorphic registry (`type =
'connection'`). The cluster SASL creds stay in the connector's `.env` for the RC;
this resource carries only the user-facing config (name / topic / destination
project / as_user). RBAC on the destination is enforced at create time here and
again at load time by [`pipeline::upload_csv`](../../backend/crates/api/src/pipeline.rs) —
the same write-reach check a file upload uses.

**Route file:** [`crates/api/src/routes/connectors.rs`](../../backend/crates/api/src/routes/connectors.rs)
**DB:** [`crates/api/src/db/connectors.rs`](../../backend/crates/api/src/db/connectors.rs)
**Loader seam:** [`kafka_loader::Cfg::from_connection`](../../backend/crates/api/src/kafka_loader.rs)

---

## `GET /api/connectors`

List the connectors the caller can reach — same reach as `GET /api/projects`
(platform admin → all; direct project membership → that project's connectors;
company owner/admin cascade → that company's projects' connectors). Caller
resolved via [`resolve_user_rid`](me.md).

### Response

```jsonc
200 OK
{
  "items": [
    {
      "redpash_id": "CON_73D2F0B49297425B95B58B36AF262F7B",
      "project_id": "PRJ_D32D474BB899488B84CBB1F49A418F17", // the chosen destination
      "name":       "account-events",
      "kind":       "kafka",
      "topic":      "topic_account_jlr",                     // nullable
      "as_user":    "USR_3CA4706BE20F427DB165B448A673D59E",  // load runs as this user
      "created_by": "USR_3CA4706BE20F427DB165B448A673D59E",
      "created_at": "2026-06-04T18:44:57.296124Z"
    }
  ]
}
```

## `POST /api/connectors`

Create a connector pointing at a **destination project the caller can write to**.
The project must exist *and* the caller must have **≥Member write-reach** on it —
the same gate the upload pipeline enforces. A missing or unreachable project
returns `404` (leak-free: "exists but not yours" is indistinguishable from
"doesn't exist"). `as_user` + `created_by` are set to the caller; the load runs
as them (RBAC-checked again at load time, no platform-admin bypass).

### Body

```jsonc
{
  "name":       "account-events",      // required, non-empty
  "project_id": "PRJ_…",               // required — the destination the user picked
  "topic":      "topic_account_jlr",   // optional (falls back to the connector's .env)
  "kind":       "kafka"                // optional, default "kafka"
}
```

### Response

```jsonc
201 Created
{ "redpash_id": "CON_…", "project_id": "PRJ_…", "name": "…", "kind": "kafka",
  "topic": "…", "as_user": "USR_…", "created_by": "USR_…", "created_at": "…" }

400 invalid        — name or project_id empty
404 not_found      — project missing OR caller lacks write-reach (leak-free)
401 unauthenticated — no session
```

## `GET /api/connectors/:rid`

Fetch one connector summary. Gated by **view-reach on the destination project**
(an unreachable connector reads as `404`, leak-free). Same row shape as the
`list` items.

### Response

```jsonc
200 OK
{ "redpash_id": "CON_…", "project_id": "PRJ_…", "name": "…", "kind": "kafka",
  "topic": "…", "as_user": "USR_…", "created_by": "USR_…", "created_at": "…" }

404 not_found — connector missing or its project unreachable
```
