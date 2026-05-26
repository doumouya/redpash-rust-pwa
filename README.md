# RedPash

Clean, explore, and report on CSVs in your browser. Rust backend
(Axum + Polars), vanilla JS frontend, PWA-capable.

## Layout

```
redpash-rust-pwa/
├── backend/                  Rust workspace
│   ├── Cargo.toml            workspace + pinned deps
│   ├── .env.example          DATABASE_URL, REDPASH_BIND, RUST_LOG
│   ├── migrations/           sqlx-cli migrations
│   └── crates/
│       ├── shared/           DTOs over the wire (no I/O)
│       ├── data/             Polars-backed pure compute (+ wasm binding)
│       └── api/              Axum HTTP server (binary: redpash-api)
├── frontend/                 Vanilla JS, no bundler in dev
│   ├── index.html            app shell
│   ├── manifest.json         PWA manifest
│   ├── service-worker.js     cache-first assets, network-first /api
│   ├── icons/                logo + favicons
│   ├── styles/               one .css per UI concern + main.css + tokens.css
│   ├── partials/             HTML loaded by the router (one per route)
│   ├── wasm/                 wasm-bindgen output (regenerated, untracked)
│   └── scripts/              flat module tier — see below
│       ├── main.js           hash router + session bootstrap
│       ├── api.js            fetch wrapper around /api (SWR cache + prewarm)
│       ├── events.js         frontend error capture + /api/events POSTer
│       ├── prefs.js          SWR cache over server user_preferences
│       ├── topbar.js         shared chrome — brand · omnibox · nav
│       ├── list-page.js      shared rail-page renderer (Home + Monitoring)
│       ├── dom.js / format.js / theme.js / dropdown.js / …  primitives
│       ├── designer.js / joins.js / report.js / autocomplete.js / wasm-engine.js / page-row.js / column-index.js / echarts-* / sw-update.js / tools.js
│       └── pages/            one module per route — home / workspace / cases /
│                             monitoring / profile / settings / docs / login
├── tools/                    audit harnesses + install scripts + RS utilities
│   ├── audit.sh              runs every tools/*-audit/audit.js
│   ├── install-stack.sh      idempotent OS+toolchain provisioning
│   ├── stack-version.sh      matched version probe
│   ├── package.json          npm deps for the JS audits (acorn)
│   └── <X>-audit/audit.js    static analyzers — css, js, html, rs,
│                             crossing, auth, css-parallel, css-usage,
│                             css-tab-compare, css-cross-page,
│                             observability, redtable
└── docs/                     public /docs site (markdown → HTML)
```

## Quick start

```bash
createdb redpash_dev          # Postgres up
cd backend
cp .env.example .env          # adjust DATABASE_URL if you must
cargo run -p api              # → 0.0.0.0:8080
```

Open <http://localhost:8080>. `GET /api/health` should return
`{"status":"ok"}`.

## Phases

| # | Theme                | Status |
|---|----------------------|--------|
| 1 | Foundation           | ✅ shell, router, /api/health, page stubs |
| 2 | Cleaner              | parse / dtype / dedup / joins, redtable |
| 3 | Reports & Dashboards | group_by, Maud, ECharts, exports |
| 4 | Auth & Settings      | Google OAuth, profile, prefs |
| 5 | Polish & deploy      | embed assets, brotli, systemd |

## Commands

```bash
# Dev loop
cargo install cargo-watch
cargo watch -x 'run -p api'

# Lint + test
cargo fmt --all
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

See [`docs/getting-started.md`](docs/getting-started.md) and
[`docs/INDEX.md`](docs/INDEX.md) for more.
