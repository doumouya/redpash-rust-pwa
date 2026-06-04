---
title: frontend/scripts/framework/connection-setup.js
source: ../../../../../../frontend/scripts/framework/connection-setup.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/connection-setup.js — New Kafka connection flow

## Purpose

The "New Kafka connection" create flow — the FE half of finishing
connector-through-framework. The Kafka loader used to land data in a hardcoded
project (`load.sh` PRJ/USR); this lets the user **choose the destination project
at connection-setup time**, the same project-picker mental model as a UI file
upload (Em 2026-06-04: "ask the user which project he wants to add the file").

It is **not a new component** — it ASSEMBLES the existing `openModal`
([modal.js](modal.md)) + a destination-project `<select>` populated from
`GET /api/projects` (the same source the upload flow reads) + `POST /api/connectors`.
The chosen project persists on the connector; the loader reads it
(`kafka_loader::Cfg::from_connection`).

## Public surface

- `openConnectionModal(opts) → Promise<{ el, close } | null>` — fetches the
  caller's projects, opens the modal (name / topic / destination-project select),
  and `POST`s `/api/connectors` on submit.
  - `opts.projects` — optional pre-supplied `[{ redpash_id, name }]` (skips the
    fetch; used by the sandbox render-proof + tests).
  - `opts.afterCreate(connector)` — fired on a successful create (e.g. refresh a
    connections list).

## How it works

- **Project source**: `GET /api/projects` → `{ items: [{ redpash_id, name }] }`,
  mapped to `<select>` options. A leading empty `— Choose a project —` prompt
  forces a deliberate pick. On a fetch failure (e.g. an unauthenticated sandbox)
  the list is empty and submit is blocked by the guard.
- **Submit**: the `novalidate` modal form means HTML5 `required` is off, so the
  `onSubmit` guard throws "Pick a destination project" when `project_id` is empty
  (the error surfaces in `.rp-modal-error`); otherwise it `POST`s
  `{ name, topic?, project_id }`. The BE re-checks ≥Member write-reach on the
  project and 404s if the caller can't write there — the same gate as upload.
- **Composition only**: imports `openModal` (the dialog + its `rp-modal-*` /
  `rp-btn` atoms) + the shared `api` client. No `rp-*` class or component is
  defined here.

## Drift-prone areas

- **Endpoint contract**: posts `{ name, topic, project_id }` to `/api/connectors`;
  the field `key`s (`name`/`topic`/`project_id`) must match the route's
  `CreateConnectorBody`. Change one, change both.
- **Empty-prompt + novalidate**: the destination guard lives in `onSubmit`, NOT
  HTML5 `required` (the modal form is `novalidate`). If the modal ever drops
  `novalidate`, the guard is still correct but becomes belt-and-suspenders.
- **Live entry pending**: today this flow is render-proven in the sandbox; the
  live "New connection" button (a rail create slot or a connections surface)
  lands with the shell cutover, when the framework modal goes live in the app.
- **`/api/projects` not `/api/connectors` for the list**: the select reuses the
  *project* roster (the upload's source), not a connectors list — don't confuse
  the two fetches.

## Related

- [framework/modal.js](modal.md) — the dialog this composes (`openModal`).
- [backend routes/connectors.rs](../../../backend/api/routes/connectors.md) — the `POST /api/connectors` endpoint.
- [backend kafka_loader.rs](../../../backend/api/kafka_loader.md) — `Cfg::from_connection` reads the chosen destination.
- [component-registry](component-registry.md) · [framework index](index.md).
