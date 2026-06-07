---
title: backend/crates/api/src/secrets.rs
source: ../../../../../backend/crates/api/src/secrets.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-06-07
---

# secrets.rs

## Purpose

**Connector secret-at-rest** — symmetric AES-256-GCM (ring) under a master key from
`REDPASH_MASTER_KEY`, so a connector credential (Kafka SASL today; the standard every
future connector — S3 / CDC — inherits) is **encrypted in `connectors.config`**. A
`pg_dump`, a backup, or a VIEW-reach read never sees a plaintext cluster key. Introduced
with the Kafka lane: Kafka creds are paid cluster-wide API keys with **no loopback
escape valve** (the bootstrap host is always remote), so the SQL loaders' "localhost-only"
plaintext-`password` compromise doesn't hold here.

Encrypt on the connector **create** path (`routes/connectors.rs`); decrypt in the
loader's `from_connection` (`kafka_loader`). The plaintext secret is **never persisted**.

## Public surface

- `pub fn encrypt(plaintext) -> Result<String>` — `v1:` + base64(`nonce[12] ||
  ciphertext || tag[16]`). Fresh random 96-bit nonce per call (GCM uniqueness). Errors
  (never stores plaintext) when no master key.
- `pub fn decrypt(stored) -> Result<String>` — inverse. A tampered / wrong-key blob
  fails **loudly** on the GCM auth tag, never returns garbage; a present-but-
  undecryptable secret is an error, never a silent skip.
- `pub fn report_startup() -> Result<()>` — boot posture. **Refuses to boot on a
  MALFORMED key** (operator error); **only WARNS when the key is unset** (encryption
  unavailable, env-based creds still work) so an existing deployment keeps booting.
  Called once in `main.rs` after tracing init.

## Drift-prone areas

- **`v1:` prefix = creds_version.** Rotate the algorithm or key by bumping it; old blobs
  decrypt via their own version arm. The format is self-describing — `connectors.config`
  also stores a redundant `creds_version` for queryability, but `decrypt` reads the prefix.
- **Master key = base64 of exactly 32 bytes** from `REDPASH_MASTER_KEY`, cached in a
  `OnceLock`. v1 sourcing is the env var; a sealed-secret file / cloud KMS is the
  documented later option for Africa-first on-prem.
- **Fail-closed is on USE, boot is soft-on-unset** (deliberate deviation from the plan's
  "refuse boot without a key"): refusing to boot when the key is merely unset would break
  an existing deployment that hasn't set it yet. Refuse-boot is reserved for a *malformed*
  key. The dangerous paths (plaintext storage, silent decrypt-skip) are still hard errors.
- **Crypto core is key-explicit** (`seal`/`open` take a `LessSafeKey`) so it's unit-tested
  without env races; `encrypt`/`decrypt` wrap them with the cached master key.
- **`redact.rs` masks `sasl_secret` / `sasl_secret_enc`** — defense-in-depth so neither
  reaches an `events.context` payload (the create event already carries only
  `{connector, project}`, not config).

## Related

- [routes/connectors.rs](routes/connectors.md) — encrypts `config.sasl_secret` →
  `sasl_secret_enc` on the create path.
- [kafka_loader.rs](kafka_loader.md) — `from_connection` decrypts `sasl_secret_enc`
  (else falls back to the `.env` `KAFKA_SECRET`).
- [redact.rs](redact.md) — masks the secret keys in event context.
