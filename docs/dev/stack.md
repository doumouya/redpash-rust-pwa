---
title: Tech stack
section: Dev
order: 1
last modified date: 2026-05-22
---

# Tech stack

Every component RedPash runs on, with its pinned version. **Snapshot:
2026-05-22** — versions drift; see *Refreshing this table* at the
bottom to regenerate.

## Toolchain & runtime

| Component | Version | Notes |
|-----------|---------|-------|
| Rust (`rustc`) | 1.95.0 | The workspace is **edition 2021**, resolver 2. |
| Cargo | 1.95.0 | |
| PostgreSQL | 14.22 | Server + `psql` client (Ubuntu package). The only database. |
| Node.js — system | **12.22.9** | ⚠️ On the shell `PATH` — this is the **trap**. Rejects `??`, optional chaining, ES modules; never `node --check` app JS with it. |
| Node.js — nvm | 22.13.0 | The real one: `~/.nvm/versions/node/v22.13.0/bin/node`. Use for any JS tooling. |
| npm | 8.5.1 | |
| OS | Ubuntu 22.04.5 LTS | WSL2, kernel 6.6.114.1-microsoft-standard. Windows interop disabled — can't launch `.exe`. |

## Backend — Rust workspace

Three crates: **`api`** (Axum HTTP server), **`data`** (Polars
compute), **`shared`** (wire DTOs). Edition 2021. Versions are pinned
in `backend/Cargo.toml` → `[workspace.dependencies]`; the *Resolved*
column is what `Cargo.lock` actually locked.

| Crate | Pinned | Resolved | Role |
|-------|--------|----------|------|
| `axum` | 0.7 | 0.7.9 | HTTP server (`macros`, `multipart`) |
| `tokio` | 1 | 1.52.3 | async runtime (`full`) |
| `tower` / `tower-http` | 0.5 / 0.6 | 0.5.3 | middleware (cors, trace, fs, br, limit) |
| `hyper` | — | 1.9.0 | HTTP implementation (transitive via axum) |
| `sqlx` | 0.8 | 0.8.6 | Postgres driver + migrations |
| `polars` | 0.43 | 0.43.1 | dataframe compute engine |
| `hashbrown` | 0.14 | — | pinned with the `raw` feature — packaging workaround for polars 0.43.1; drop when polars > 0.43 ships |
| `calamine` | 0.26 | 0.26.1 | xlsx / xls / xlsm / xlsb / ods reader (upload) |
| `rust_xlsxwriter` | 0.95 | 0.95.0 | xlsx writer (export) |
| `csv` | 1.3 | — | CSV parse |
| `chardetng` | 0.1 | 0.1.17 | encoding detection |
| `encoding_rs` | 0.8 | — | encoding transcode |
| `pulldown-cmark` | 0.12 | 0.12.2 | Markdown → HTML (`/docs`) |
| `syntect` | 5 | — | code highlighting |
| `gray_matter` | 0.2 | — | doc frontmatter parsing |
| `maud` | 0.26 | — | HTML templating |
| `serde` / `serde_json` | 1 | 1.0.228 | (de)serialization |
| `reqwest` | 0.12 | — | OAuth HTTP client (rustls-tls, no OpenSSL) |
| `chrono` · `uuid` · `anyhow` · `thiserror` · `tracing` · `dotenvy` · `dashmap` | 0.4 · 1 · 1 · 1 · 0.1 · 0.15 · 6 | — | dates · ids · errors · errors · logging · env · concurrent map |

## Frontend

Vanilla JavaScript PWA — **no framework, no bundler, no build step.**
Static files are served by the `api` binary; the browser runs the code
exactly as authored.

| Aspect | Value | Notes |
|--------|-------|-------|
| Language | JavaScript — **ES2020+ (ES11+)** | Uses `??` and `?.` (ES2020), `async` / `await` (ES2017), ES modules (ES2015). **Not ES5, not ES6 / ES2015.** No transpilation — targets evergreen browsers. |
| Modules | ES modules | Entry `scripts/main.js` is `type="module"`; ~43 script files use `import` / `export`. Three legacy classic `defer` scripts remain (`include.js`, `controls.js`, `file-review.js`). |
| PWA | service worker | `frontend/service-worker.js`; `CACHE_VERSION` currently `v588` (bump on breaking asset changes). |
| Charts | ECharts 6 | chart rendering (CDN). |
| Fonts | Google Fonts — Savate | CDN. |
| npm | none | the frontend has no `package.json` / dependency tree. |

## Dev tooling

| Tool | Runtime | Notes |
|------|---------|-------|
| `tools/css-audit/audit.js` | Node (use v22) | CSS conflict / duplication analyzer; bare Node, no npm deps. |
| `tools/csv-to-xlsx-rs` | Rust (standalone crate) | CSV → xlsx fixture converter for the edge-case corpus. |

## Refreshing this table

```
rustc --version && cargo --version
psql --version
node --version                                  # system Node (the v12 trap)
ls ~/.nvm/versions/node/                         # the real Node
sed -n '/\[workspace.dependencies\]/,/\[profile/p' backend/Cargo.toml
grep -E '^(name|version) = ' backend/Cargo.lock  # resolved versions
```
