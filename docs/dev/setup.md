---
title: Local setup
section: Dev
order: 0
last modified date: 2026-05-16
---

# RedPash — Local development setup

> Platform: Linux / WSL2
> Rust: 1.76+ (`rustup default stable`)
> PostgreSQL: 14+

The backend is a Rust workspace; the frontend is vanilla JS served by
the api crate's `ServeDir` mount. `cargo run -p api` brings the
entire app up on one port — no separate frontend build step in dev.

---

## 1. Prerequisites

| Tool | Min version | Install (Ubuntu / WSL2) |
|---|---|---|
| **Rust** | 1.76 | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **PostgreSQL** | 14 | `sudo apt install postgresql` |
| **Git** | any | `sudo apt install git` |
| `cargo-watch` *(optional)* | any | `cargo install cargo-watch` — auto-rebuilds on file change |
| `sqlx-cli` *(optional)* | 0.8 | `cargo install sqlx-cli --features postgres,native-tls` — only needed if you author migrations manually; the api crate runs them at startup automatically |
| **ngrok** *(optional)* | any | Only needed for Google OAuth redirect-URI testing from WSL2 |

**Node is not required.** The frontend has no build step in dev — the
api crate serves `../frontend/` directly. JS modules load over native
`import`; CSS via `<link>`; chart libraries are lazy-loaded from CDN.

**WSL2 note:** PostgreSQL doesn't auto-start after a WSL2 restart.
Run `sudo service postgresql start` if you see connection errors.

---

## 2. Clone and build

```bash
git clone <repo> redpash-app
cd redpash-app/backend
cargo build --workspace
```

First build pulls ~250 crates and takes 3–5 minutes. Incrementals
after that are seconds.

---

## 3. Database setup

### 3.1 Create the database

```bash
sudo -u postgres psql

-- Inside psql:
CREATE USER mansa WITH PASSWORD 'mansa';
CREATE DATABASE redpash_app_dev OWNER mansa;
GRANT ALL PRIVILEGES ON DATABASE redpash_app_dev TO mansa;
\q
```

> **No `uuid-ossp` extension needed.** The Rust app generates IDs
> with the `uuid` crate (random in-process), not `uuid_generate_v4()`
> on the server. The schema's `users.id` columns are TEXT, not UUID.
> See [`db/redpash-id.md`](../db/redpash-id.md).

### 3.2 Migrations run on boot

The api crate calls `sqlx::migrate!("../../migrations")` during
`AppState::init` — schema migrations are applied automatically the
first time you `cargo run`. No `sqlx migrate run` command is needed.

If you want to apply migrations against a freshly created DB before
running the binary (e.g. in CI):

```bash
sqlx migrate run --database-url postgres://mansa:mansa@localhost:5432/redpash_app_dev
```

### 3.3 Bootstrap user + default project

The first time `cargo run -p api` boots against an empty DB,
[`bootstrap.rs`](../../backend/crates/api/src/bootstrap.rs) creates:

- One user with `username = "dev"`, `redpash_id = USR_…`.
- One project named `"Workspace"`, `is_default = TRUE`.

This is the `dev_user` fallback identity — used when Google OAuth
isn't configured.

There is no separate `seed_projects` command (the Django app had
one); the dev user just uploads a CSV from the cleaner page to
populate.

---

## 4. Environment

`backend/.env` (gitignored) — copy from `.env.example`:

```bash
cp backend/.env.example backend/.env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | **yes** | — | Postgres connection string, e.g. `postgres://mansa:mansa@localhost:5432/redpash_app_dev` |
| `REDPASH_BIND` | no | `0.0.0.0:8080` | Host:port for the HTTP server |
| `REDPASH_DATA_DIR` | no | `./data` | Root for on-disk file storage. Uploaded CSV bytes live in `<data_dir>/files/<rid>.bin` |
| `RUST_LOG` | no | `info,sqlx=warn,hyper=warn` | `tracing-subscriber` filter — bump to `debug,sqlx=info` for query logs |
| `GOOGLE_OAUTH_CLIENT_ID` | for OAuth | — | Leave blank to keep the dev_user fallback. All three vars below must be set together to enable `/api/auth/google/*` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | for OAuth | — | |
| `GOOGLE_OAUTH_REDIRECT_URI` | for OAuth | `http://localhost:8080/api/auth/google/callback` | Must exactly match an Authorized Redirect URI registered in Google Cloud Console |

**Minimal `.env` for local dev without Google OAuth:**

```env
DATABASE_URL=postgres://mansa:mansa@localhost:5432/redpash_app_dev
REDPASH_BIND=0.0.0.0:8080
REDPASH_DATA_DIR=./data
RUST_LOG=info,sqlx=warn,hyper=warn
```

With this config, every request resolves to the bootstrap dev_user.
See [`auth/google.md`](../auth/google.md) for the OAuth setup.

---

## 5. Run the dev server

```bash
cd backend
cargo run -p api
```

You should see:

```
INFO  redpash_api: bootstrap ready user=USR_… project=PRJ_…
INFO  redpash_api: google oauth not configured — running in dev_user mode
INFO  redpash_api: listening on 0.0.0.0:8080
```

Open <http://localhost:8080>. The hash-router lands on `#/landing`;
without OAuth configured, clicking around still works because
`/api/me` falls back to dev_user.

`GET /api/health` → `{"status":"ok"}` is the first thing to verify.

---

## 6. Watch loop

```bash
cargo install cargo-watch
cargo watch -x 'run -p api'
```

Backend changes auto-rebuild. **Frontend changes don't need a
rebuild** — just refresh the browser. The service worker is install-only
and caches nothing, so there's no stale-shell problem and no
`CACHE_VERSION` to bump.

---

## 7. Tests

```bash
cargo test --workspace
```

There's no `pytest-django` equivalent setup — Rust tests run with
`cargo test`. The `data` crate has unit tests for the cleaning
operations and group-by engine.

---

## 8. Common issues

### Postgres connection refused

**Symptom:** `Error: error returned from database: connection refused`.

**Fix (WSL2):** `sudo service postgresql start`. Postgres doesn't
auto-start after WSL2 shutdown.

### `DATABASE_URL is not set`

The api crate refuses to boot without `DATABASE_URL`. Copy
`.env.example` to `.env`.

### `polars-core` build error mentioning `raw_table_mut`

**Symptom:** Compilation fails inside
`polars-core-0.43.1/src/chunked_array/builder/list/categorical.rs`
with `method not found in HashMap<KeyWrapper, …>`.

**Cause:** A `hashbrown` version mismatch — the workspace
`Cargo.lock` should pin `hashbrown` to 0.14.5 for polars-core. If
this is happening, your Cargo.lock has drifted (e.g. after `cargo
update`).

**Fix:** Run `cargo build --workspace` from the repo root — the
workspace Cargo.lock takes precedence. If it persists,
`cargo update -p hashbrown@0.15.5 --precise 0.14.5`.

### Frontend serving stale code after upload

**Symptom:** Hard-refreshing the browser doesn't pick up changes to
JS / CSS files.

**Cause:** A legacy service-worker cache from before the SW went
install-only.

**Fix:** The current `frontend/service-worker.js` caches nothing and
deletes old caches on activate, so a normal refresh suffices. If a stale
cache lingers from an old build: DevTools → Application → Service Workers
→ "Unregister", then refresh once.

### Google OAuth callback says "redirect_uri_mismatch"

**Cause:** The `GOOGLE_OAUTH_REDIRECT_URI` value in `.env` does not
exactly match any Authorized Redirect URI in Google Cloud Console.
Schemes, ports, and trailing slashes must match exactly.

**Fix:** Either add the missing URI in Google Cloud Console
(`http://localhost:8080/api/auth/google/callback` for local dev), or
change the env var to match an existing one.

### Browser stuck on landing after sign-in succeeds

**Cause:** Cookie domain mismatch — usually because the user signed in
via an ngrok URL but is now visiting `localhost`, or vice versa.

**Fix:** Clear cookies for `localhost` and `*.ngrok-free.app`, then
retry.

---

## 9. Useful one-liners

```bash
# Reset the DB (drops everything; re-run cargo to recreate via migrations)
psql -U mansa -d postgres -c 'DROP DATABASE redpash_app_dev'
createdb -U mansa redpash_app_dev

# Tail the api logs at debug level
RUST_LOG=debug,sqlx=info cargo run -p api 2>&1 | tee api.log

# Inspect the runtime DB while the server is running
psql -U mansa -d redpash_app_dev -c '\dt'

# Drop the in-memory file cache (no API for this — just restart the binary)
# Cache miss re-parses from <data_dir>/files/<rid>.bin

# Check what's in users without OAuth
psql -U mansa -d redpash_app_dev -c 'SELECT redpash_id, username, google_sub FROM users;'

# Count rows in your biggest cached file
ls -lh data/files/ | sort -k5 -h | tail
```

---

## 10. Layout cheatsheet

```
redpash-app/
├── backend/
│   ├── Cargo.toml                      workspace
│   ├── .env / .env.example             config
│   ├── crates/{api,data,shared}/       Rust source
│   └── migrations/*.sql                schema (auto-applied at boot)
├── frontend/
│   ├── index.html
│   ├── service-worker.js               install-only (PWA); caches nothing
│   ├── partials/                       HTML per route
│   ├── styles/                         CSS tokens + components + pages
│   └── scripts/                        modules
└── docs/
    ├── REDMAP.md                       read this first
    ├── INDEX.md, getting-started.md, VISION.md
    ├── features/, objects/, api/, auth/, db/, dev/, frontend/
```

[REDMAP.md](../REDMAP.md) is the fastest way to find anything.
