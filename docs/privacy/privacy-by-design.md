# Privacy by Design — the standing register

RedPash's living privacy record. It states **how** the system embodies the 7
Privacy-by-Design principles (Art. 25), **what** personal data it touches, and **where**
the enforcement lives. Point-in-time reviews are dated files alongside this one
(latest: [`assessment-2026-06-16.md`](assessment-2026-06-16.md)); the machine-checked
floor is [`tools/privacy-audit/`](../../tools/privacy-audit/audit.js), ratcheted by
`ci-audit` (`baseline.json: "privacy"`).

> **Locked-decision note:** the privacy posture itself lives in
> [`decisions/registry-redundancy.md`](../decisions/registry-redundancy.md) — *registry
> (ids/metadata) server-side, customer data client-side*. Changing it is an Em-level
> decision, not a refactor.

## Roles

- **Controller** for RedPash's own users (OAuth identity, cases, comments).
- **Processor** for customer-uploaded data (CSV rows, attachments) — processed on the
  uploader's instruction; a Data Processing Agreement is required per third-party org.

## Lawful basis (intended)

- User identity: necessary for the service / legitimate interest (OAuth `openid email
  profile` only).
- Uploaded data: processed on behalf of the controlling user; RedPash adds no secondary
  use (no analytics, no profiling, no third-party sharing — verified: only Google OAuth
  egress leaves the box).

## Data inventory

| Data | Location | Persistence | At-rest protection |
|---|---|---|---|
| User identity (email, name, avatar, `google_sub`) | `users` (PG) | until scrub | none (app-level) |
| Case title/description/comments | `cases`,`case_comments` | until delete | none; body raw plaintext (F-L) |
| Attachment files | `<data_dir>/attachments/*.bin` | until delete (orphans on case-delete, F-A) | none |
| Uploaded CSV bytes | `<data_dir>/files/*.bin` | until delete (orphans, F-A) | none |
| Column sample cell | `project_files.columns_meta` | until delete | none — **accepted exception** (F-J) |
| Chart/dashboard aggregates | `project_files.spec` | until delete | none — **to fix recipe-only** (F-E) |
| Customer working rows | client wasm memory; GlueSQL-idb (staged) | ephemeral / device | n/a |
| Audit events (incl. `user_id`) | `events` (partitioned) | **unbounded** (F-C) | none |
| Connector secrets | `connectors.config` | persistent | **plaintext** (F-F) |

## Data flows / egress

Only **Google OAuth identity exchange** leaves the server. No analytics, trackers, CDNs,
or LLM calls. Customer rows are computed client-side (Polars wasm); the server holds the
registry (ids/shape) plus the accepted/known exceptions above.

## The 7 principles — commitments & current state

1. **Proactive not Reactive** — privacy reviewed pre-ship; this register + the audit tool
   are the proactive controls. *Gap: no DPIA, no privacy tests.*
2. **Privacy as the Default** — compute-to-data is the default; *gap: no PII-class default
   (F-G), retention defaults to keep-forever (F-C), no consent default.*
3. **Embedded into Design** — RBAC, metadata-only stores, registry/data split are
   structural. *Defect: F-E/F-J store customer-derived data in the registry.*
4. **Full Functionality (Positive-Sum)** — privacy and capability coexist (client-side at
   scale). ✅
5. **End-to-End Security / Lifecycle** — strong entry/transit (SSRF gate, TLS-required,
   leak-free RBAC); *gap: at-rest encryption (F-F/F-J), erasure (F-A/F-B), retention
   (F-C), logout wipe (F-K).*
6. **Visibility & Transparency** — *gap: no notice/consent/RoPA (F-D).*
7. **Respect for User Privacy** — scrub anonymises + refuses orphaning; *gap: no
   self-service export (F-H), no notice.*

## Risk register

The open items are the findings in [`assessment-2026-06-16.md`](assessment-2026-06-16.md)
§5 (F-A…F-L), each enforced as a check in `tools/privacy-audit/`. Closing a finding =
the check flips green and the `ci-audit` baseline drops — the register stays honest
because the floor is machine-checked, not asserted.

## Go-live workstream (pre-production gate)

RedPash runs on localhost today — no real external users — so the user-facing and
production-hardening items below are a **deliberate pre-launch workstream**, not
skipped. They are MANDATORY before the app processes real users' personal data
online (Em decision, 2026-06-17).

**Required before go-live:**
- **Privacy notice + consent surface (F-D)** — Art. 12-14 transparency: a
  user-facing notice (controller identity, data inventory, lawful basis, the
  on-device posture, subject rights incl. `/api/me/export`, retention, no
  trackers) surfaced pre-auth, plus any consent capture. The technical content is
  known; the legal specifics (entity, contact, jurisdiction / DPA) are Em's.
- **Observability retention via partition rotation (F-C)** — convert
  `events`/`request_log`/`db_query_log` to monthly partitions and extend
  `redpash-retention` to DETACH/DROP old ones (the session-GC + orphan-blob reaper
  already ship). Decide convert-existing vs future-only.
- **At-rest encryption of the accepted registry exceptions (F-J)** — encrypt
  `columns_meta.sample` + the `.bin` recovery blobs under `REDPASH_MASTER_KEY`
  (the mitigation named in `decisions/registry-redundancy.md`). The crypto +
  rotation primitives already exist (`crypto.rs`).

**Hardening / completeness follow-ups:**
- **Connector-write encryption adoption (F-F)** — when the connector-create route
  lands, call `crypto::encrypt_secret` on write (the read path + rotation are done).
- **data_class-keyed log redaction (F-I)** — strip personal context from event
  payloads by `data_class` (today's access events log ids only, so low risk).
- **Derived-field classification (F-G)** — classify uncataloged/derived columns
  (`google_sub` is denylisted; `avatar_url` is uncataloged).

## How to keep this current

- A new personal-data store, egress, or client-side persistence ⇒ add a row to the data
  inventory **and** a check to `tools/privacy-audit/`.
- A new dated review ⇒ a new `assessment-YYYY-MM-DD.md`; update the verdict here if the
  maturity level moves.
