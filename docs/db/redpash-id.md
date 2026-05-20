---
title: RedPash-ID system
section: DB
order: 1
last modified date: 2026-05-16
---

# RedPash-ID system

> Source: `crates/api/src/id.rs`

RedPash-IDs are the primary key on every persisted row. Every API URL,
log line, frontend route fragment, and JSONB cross-reference uses
them. Internal UUID-style PKs do not exist — the RedPash-ID *is* the
primary key.

## 1. Format

```
RPT_5F3C7A21D8E94B6E92A1C0F4B3D7E0A2
^^^ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
│   └─ 32-char UUID v4 (simple, uppercase hex)
└── 3-char object-type prefix + underscore separator
```

| segment | length | character set | purpose |
|---|---|---|---|
| Prefix | 3 | uppercase A–Z | Encodes the object type (`RPT`, `DSH`, …) |
| Separator | 1 | `_` | Visual breakpoint; never appears inside the body |
| Body | 32 | uppercase `0-9A-F` | UUID v4 (`Uuid::new_v4().simple()`) uppercased |

**Total length: 36 characters.** Always uppercase. URL-safe (no
percent-encoding needed). Stable forever — once issued, never reused.

**Example:** `RPT_5F3C7A21D8E94B6E92A1C0F4B3D7E0A2`

## 2. Generation

```rust
// crates/api/src/id.rs
use uuid::Uuid;

pub fn new(prefix: &str) -> String {
    let u   = Uuid::new_v4();
    let raw = u.simple().to_string().to_ascii_uppercase();
    format!("{prefix}_{raw}")
}
```

`Uuid::new_v4()` pulls 122 bits of system randomness via `uuid`'s
default RNG (`getrandom`). The `simple` formatter renders the UUID
as 32 hex chars with no dashes; `.to_ascii_uppercase()` upper-cases.

Usage from any handler:

```rust
let rid = crate::id::new("RPT");   // → "RPT_5F3C7A21…"
```

## 3. Object prefixes

All prefixes are exactly **3 ASCII letters**, uppercase. Adding a new
prefix is a code-only change — no schema migration required since the
PK column is `TEXT`.

| Prefix | Object | Table | Allocated by |
|---|---|---|---|
| `USR` | User | `users` | `bootstrap.rs::run` + `db::upsert_google_user` |
| `SES` | Session | `sessions` | `db::create_session` |
| `PRJ` | Project | `projects` | `db::ensure_default_project` + `db::insert_project` |
| `FIL` | Project file | `project_files` | `routes::files::upload` |
| `STP` | Project step | `project_steps` | `routes::files::add_step` (via the steps insert) |
| `RPT` | Report | `reports` | `routes::reports::create` |
| `DSH` | Dashboard | `dashboards` | `routes::dashboards::create` |
| `EVT` | Event | `events` *(reserved; not yet inserted from any route)* | — |
| `CAS` | Case | `cases` *(reserved; Phase 4+)* | — |
| `CMP` | Company | `companies` *(reserved; Phase 4+)* | — |

## 4. Why a UUID and not Crockford base32?

The historical Django app used a 13-char Crockford-base32 scheme with
an embedded checksum (good for hand-transcription). The Rust app
uses raw UUIDs because:

- IDs are **never typed by humans** — they live in URLs and the UI's
  copy buttons. No transcription = no checksum value.
- UUID v4 collision probability is negligible (2⁻¹²² per insert),
  which removes the need for a uniqueness retry on conflict.
- `Uuid::new_v4()` ships with the `uuid` crate already in the
  workspace deps — no custom generator code, no random-byte handling,
  no alphabet table to maintain.

The trade-off is that IDs are longer (36 chars vs 13). They still fit
in a URL segment without encoding, and the prefix makes the type
visible at a glance in logs.

## 5. Validation

There is **no validation function** (no checksum to verify). Lookups
go directly through SQL — an invalid RID simply misses the index and
returns no row. Handlers map that to a 404 via `AppError::not_found`.

If validation is needed later (e.g. to reject malformed inputs
upfront), the rules are:

- Length must be exactly 36.
- Position 0–2 must be `[A-Z]`.
- Position 3 must be `_`.
- Position 4–35 must be `[0-9A-F]`.

A regex-free check fits in ~10 lines of Rust.

## 6. URL convention

All `:rid` path parameters accept the full RID exactly as issued —
case-sensitive (the column stores uppercase). The frontend never
lowercases or trims; the backend never normalises. If a user pastes
`rpt_5f…` into a URL it 404s.

```
GET /api/reports/RPT_5F3C7A21D8E94B6E92A1C0F4B3D7E0A2
GET /api/files/FIL_9A2D6C71F4814A2C8E3B1D7F0E6A2C95/page
```

The frontend hash routes use the same convention:
`#/reports?id=RPT_…`, `#/cleaner?file=FIL_…`.

## 7. When IDs are assigned

The RID is generated **at the moment the row is inserted** — by the
calling handler, not by a DB default. The migration defines
`redpash_id TEXT PRIMARY KEY` with no default; every `INSERT`
statement supplies the value explicitly.

This means:

- A row cannot exist without a RID — the schema enforces NOT NULL via
  PK.
- The RID never changes after insert (no `UPDATE redpash_id` anywhere).
- `db::insert_*` helpers usually generate the RID themselves
  (`crate::id::new("PFX")`) so callers don't have to.
