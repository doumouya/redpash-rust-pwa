# Connectors — the server as a CONDUIT, never a store

A connector pulls a table out of a customer's external database and hands the
rows to the user's browser. The server is a **conduit**: it connects to the
source through one reviewed security gate, extracts the table to faithful,
type-aware CSV bytes, and **returns those bytes** so the client's on-device
GlueSQL can ingest a queryable table. The customer's rows pass *through* the
process — they are **never written to disk and never persisted on our servers**.
This is the privacy posture of [[registry-redundancy]] (*bring compute to the
data*) applied to ETL: a connector is the one place we touch a customer's raw
data on the server, so it is built to hold none of it.

> The only change from the predecessor's `mysql_loader` was the **destination**:
> bytes OUT (returned to the caller), not `pipeline::upload_csv` (persisted). The
> calibrated extraction — the type fidelity and the SSRF gate — is the moat and
> was ported verbatim.

**Source:** `backend/crates/api/src/connectors_core.rs` (the shared security
gate) and `backend/crates/api/src/mysql_loader.rs` (the first engine loader).

**Status:** the conduit half is built and tested but **not yet wired to a
route** — both modules carry `#![allow(dead_code)]`. The HTTP endpoint (and the
connector UI) lands in a later slice. The gate landed *first*, deliberately, so
every future loader (Postgres, …) is forced through one reviewed copy instead of
re-deriving the admission rules per engine.

---

## The pull pipeline (one round trip)

```
config (JSONB)  ──Cfg::from_config──▶  Cfg          [host_gate runs HERE, pre-connect]
                                         │
                                         ▼ pull(&cfg)
   connect_pinned ─▶ introspect types ─▶ type-aware SELECT ─▶ CSV bytes
   (utf8mb4/UTC)     (information_schema)  (project_expr)        │
                                                                ▼
                                            Vec<u8>  ──(caller streams)──▶  client GlueSQL.ingest_csv
```

Two public entry points, in order:

1. **`Cfg::from_config(&serde_json::Value) -> Result<Cfg, AppError>`** — parse +
   validate the connector's stored `config` JSONB into a ready connection +
   table spec. **The host admission decision happens here**, before any socket
   is opened.
2. **`pull(&cfg) -> Result<Vec<u8>, AppError>`** — connect, introspect, extract,
   and return the CSV bytes. One-shot, no persistence. v1 buffers the whole
   table via `fetch_all` (row streaming for very large tables is a deferred
   refinement); a full pull only (incremental high-watermark is deferred).

The returned `Vec<u8>` is the entire customer-facing payload. The caller's job
is to stream it to the browser; nothing else on the server retains it.

---

## `Cfg::from_config` — discrete components, never a URL

`config` is the connector's stored JSONB:

```jsonc
{ "host", "port", "user", "password", "database", "table",
  "ssl_mode"?, "ssl_ca"?, "columns"?, "where"? }
```

`Cfg` is built from **discrete components** (`MySqlConnectOptions::new().host(…)
.port(…).username(…)…`), never a `format!`'d connection string. This is
load-bearing, not stylistic:

- **The legacy pre-built `conn` URL is REJECTED.** If `config.conn` is present
  and non-empty, `from_config` errors out. A full URL is a SSRF host-smuggling
  vector — `user:pass@realhost/?…@evil` style userinfo tricks let an attacker
  hide the true target from a naive host check. By forcing discrete fields the
  host we validate is exactly the host sqlx will `connect()` to.
- **`database` and `table` are required**; everything else has a safe default
  (`host` → `127.0.0.1`, `port` → `3306`, `user` → `root`, `password` → empty).
- **`columns`** (optional) is a pull-only-these list; existence is checked
  against the *live* introspection in `pull()`, not here (see below).
- **`where`** (optional) is run through `sanitize_where` (see the WHERE section).

### ssl_mode defaulting

`ssl_mode` resolves to an engine-agnostic `connectors_core::SslMode`:

| `config.ssl_mode` | resolved mode |
|---|---|
| present (parsed via `parse_ssl_mode`) | as given; **unknown string → `Required`** |
| absent **and** host is loopback | `Preferred` |
| absent **and** host is remote | `Required` |

The unknown-string fallback is `Required`, the safe encrypting default, so a typo
in the config never silently downgrades a remote connection to plaintext. Each
loader maps `SslMode` to its own sqlx enum — `mysql_ssl_mode` here maps to
`MySqlSslMode`. `ssl_ca` (a CA bundle path) is applied only when present, for the
`VerifyCa` / `VerifyIdentity` modes.

---

## `connectors_core::host_gate` — the SSRF + must-encrypt admission gate

`host_gate(host, ssl_mode)` is the **single security-load-bearing decision** for
a remote DB target, and the reason `connectors_core` exists as a shared module:
one reviewed copy, not a per-loader divergence. It enforces two rules:

1. **Link-local / cloud-metadata addresses are refused ALWAYS — even over TLS.**
   `169.254.0.0/16` (including the AWS/GCP metadata endpoint `169.254.169.254`),
   `fe80::/10`, and the unspecified address (`0.0.0.0` / `::`, which `connect()`
   routes to the local host). These are never a real customer DB and are the
   classic SSRF pivots, so encryption does not buy them admission.
2. **A remote host MUST encrypt.** Only loopback may use a non-encrypting mode
   (`Disabled` / `Preferred`) — plaintext to `localhost` never leaves the box.
   Any remote host with a mode that doesn't encrypt is rejected, because
   plaintext over the wire would leak both credentials and customer data.
   `SslMode::encrypts()` is true only for `Required | VerifyCa | VerifyIdentity`.

### Classification is on the routed address, not the text

The gate's calibration — *what* to block — is the moat, and it is built to resist
encoding tricks. Classification runs on **the IP the kernel will actually
`connect()` to**, not the textual host, so no wrapper smuggles a blocked address
past a string check:

- **`ip_literal`** strips a trailing FQDN dot and an RFC-4007 zone id (`%eth0`)
  before parsing — `IpAddr` rejects both but `getaddrinfo` accepts them, so a
  zoned/dotted link-local literal would otherwise slip the parse-fails arm.
- **`embedded_ipv4`** resolves the IPv4 an IPv6 literal really routes to —
  IPv4-mapped (`::ffff:a.b.c.d`), IPv4-compatible (`::a.b.c.d`), and NAT64
  (`64:ff9b::/96`, RFC 6052) — so an IPv6 wrapper can't hide a blocked IPv4.
- **`is_loopback_host`** recognizes only *real* loopback (`localhost`,
  `127.0.0.0/8`, `::1`, and IPv6 wrappers of loopback) — **not** a hostname like
  `127.evil.com` that a naive `starts_with("127.")` would wave through.

The gate's test module enumerates the compiler-grounded SSRF bypass vectors the
gate-audit found (every IPv6 wrapper / zone-id / trailing-dot encoding of the
metadata address) and asserts each is blocked even with `VerifyIdentity`. When
adding a new engine loader, **route its host admission through `host_gate`** —
do not re-derive these rules.

---

## Type fidelity — `project_expr`, zero silent loss

A faithful pull means a value's *meaning* survives the trip to UTF-8 CSV text.
`project_expr(col, data_type)` is the **one place** MySQL's type surface is
handled: it picks a render strategy per column from the column's
`INFORMATION_SCHEMA.DATA_TYPE`, so binary, geometry, and bit values never corrupt
the output. Extend this function for new types; never branch type handling
elsewhere.

| source `DATA_TYPE` | projection | why |
|---|---|---|
| spatial (`geometry`, `point`, `polygon`, …) | `CONCAT('SRID=', ST_SRID(c), ';', ST_AsText(c))` → **EWKT** | plain `ST_AsText` drops the SRID; EWKT (`SRID=<n>;<WKT>`) preserves it |
| binary (`binary`, `varbinary`, `*blob`) | `HEX(c)` | lossless ASCII; `CAST AS CHAR` would emit invalid UTF-8 |
| `bit` | `CAST(CAST(c AS UNSIGNED) AS CHAR)` | the unsigned integer value as text |
| `float` (binary32) | `CAST(CAST(c AS DOUBLE) AS CHAR)` | widen first, else `CAST AS CHAR` truncates to ~6 digits; DOUBLE serializes at shortest-round-trippable precision |
| numeric / temporal / char / text / enum / set / json / **unknown** | `CAST(c AS CHAR)` | faithful text under the pinned `utf8mb4` + UTC session |

Three things back the fidelity guarantee:

- **`connect_pinned`** pins a deterministic session before any read —
  `SET NAMES utf8mb4`, `time_zone = '+00:00'`, `sql_mode =
  'NO_ENGINE_SUBSTITUTION'`. **SESSION scope only** (never GLOBAL/PERSIST): the
  source's global state is never touched.
- **`is_recognized`** distinguishes "we have a verified strategy for this type"
  from the `CAST AS CHAR` default. An unrecognized type still *extracts* (it
  doesn't fail the pull) but is logged via `tracing::warn!`, so a new MySQL type
  surfaces structurally instead of being silently mangled.
- **`csv_field`** does RFC-4180 escaping and **strips NUL (`\0`)**. Text stores
  can't hold a NUL, and type-aware projection already routes real binary through
  `HEX`, so a residual NUL in a text value *is* binary leakage — it's dropped
  rather than failing the whole pull.

---

## Column selection + the WHERE pushdown

**Column pushdown (`select_columns`).** The optional `columns` list is applied to
the **live introspected** `(name, data_type)` list, case-insensitively, in
ordinal order. A name that isn't a real column is rejected *here*, against the
introspection — so the SELECT list only ever emits a backtick-quoted (`qi`)
*introspected* name. A bogus or injected entry in `columns` can never reach the
query: it fails the existence check first. An empty `columns` list is an error
(omit the key to pull all columns).

**WHERE pushdown (`sanitize_where` + dry-run).** The optional `where` is an
**operator-trust boundary**: the operator already chose the table and the
credentials, so an arbitrary boolean predicate is the feature, not a hole. It is
guarded defense-in-depth:

- `sanitize_where` trims (empty → `None`), caps length at 4096 chars, rejects
  `;` (single boolean expression only), and rejects SQL comments (`--`, `/*`,
  `*/`).
- `pull()` then **dry-runs** the clause as `SELECT 1 FROM … WHERE (<expr>) LIMIT
  0` *before* the real extract, so a malformed predicate is a clean
  `connector_where` error up front rather than a mid-pull failure.

Identifiers (database, table, every column) are backtick-quoted via `qi`
(doubling embedded backticks); the two `information_schema` lookups bind
`database`/`table` as **values**, not interpolated identifiers.

### HIDDEN_COLUMNS

There is **no denylist of hidden columns** in this loader — every introspected
column is eligible, and what gets pulled is narrowed only by the explicit
`columns` pushdown above. If a future requirement needs to suppress specific
columns unconditionally (e.g. an audit/system column a source exposes), the
natural seam is a `HIDDEN_COLUMNS` filter applied right after introspection in
`pull()`, before `select_columns` — alongside the same place column existence is
already checked. Noted here so the concept has a home; it is not implemented
today.

---

## Where the data goes (and doesn't)

`pull()` returns `Vec<u8>` and closes the source connection. That byte vector is
the complete handoff:

- **On the server:** never written to disk, never inserted into Postgres, never
  routed through `pipeline::upload_csv`. The conduit holds the bytes only for the
  duration of the response.
- **On the client:** the caller streams the CSV to the browser, where GlueSQL
  (the adopted on-device customer-data store, IndexedDB-backed) runs `ingest_csv`
  to land a durable, queryable table. See [[client-data-engines]] — GlueSQL is
  the persistence/light-SQL home; Polars stays the compute/working engine.
- **In Postgres:** only the **registry** entry for the connector + the resulting
  file's metadata (ids, shape, counts) — never the cell values. This is exactly
  the line [[registry-redundancy]] draws: the registry is *about* the data, the
  data itself stays client-side.

A change that makes the conduit persist customer rows server-side — caching the
CSV, spooling to disk, routing the pull through the upload pipeline — contradicts
both decision records and is an Em-level decision, not a refactor.

---

## See also

- [[client-data-engines]] (`docs/decisions/client-data-engines.md`) — why
  GlueSQL is the on-device data store that ingests a connector pull, and why
  Polars remains the compute engine.
- [[registry-redundancy]] (`docs/decisions/registry-redundancy.md`) — the
  customer-data-stays-client / registry-in-Postgres line this conduit upholds.
