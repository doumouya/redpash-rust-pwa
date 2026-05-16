# RedPash

Clean, explore, and report on CSVs in your browser. Rust backend
(Axum + Polars), vanilla JS frontend, PWA-capable.

## Layout

```
redpash-app/
├── backend/                  Rust workspace
│   ├── Cargo.toml            workspace + pinned deps
│   ├── .env.example          DATABASE_URL, REDPASH_BIND, RUST_LOG
│   ├── migrations/           sqlx-cli migrations (Phase 2)
│   └── crates/
│       ├── shared/           DTOs over the wire (no I/O)
│       ├── data/             Polars-backed pure compute
│       └── api/              Axum HTTP server (binary: redpash-api)
├── frontend/                 Vanilla JS, no bundler in dev
│   ├── index.html            app shell
│   ├── manifest.json         PWA manifest
│   ├── service-worker.js     cache-first assets, network-first /api
│   ├── icons/                logo + favicons
│   ├── styles/               main.css + tokens, components/, pages/
│   ├── scripts/
│   │   ├── main.js           hash router + session bootstrap
│   │   ├── api.js            fetch wrapper around /api
│   │   ├── ui/               toast, modal, …
│   │   ├── pages/            one module per route
│   │   ├── redtable/         table engine (Phase 2)
│   │   ├── cleaner/          cleaning tools (Phase 2)
│   │   ├── reports/          report builder (Phase 3)
│   │   ├── dashboards/       grid + ECharts widgets (Phase 3)
│   │   └── settings/         prefs editor (Phase 4)
│   └── partials/             HTML loaded by the router
└── docs/                     Public /docs site (markdown → HTML)
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
