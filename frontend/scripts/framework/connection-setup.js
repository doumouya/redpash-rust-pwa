/* Purpose: "New Kafka connection" flow — ASSEMBLES the existing openModal + a
   destination-project <select> (from GET /api/projects) + POST /api/connectors.
   Em: "ask the user which project he wants to add the file." NOT a new component
   — it composes modal.js (the dialog) + the api client; the project list is the
   same source the upload flow reads.
   Doc: docs/internal/code/frontend/scripts/framework/connection-setup.md */
// ── Connection setup (framework flow, CAS_37B2E1BF / connector-through-framework) ──
// The connector used to land data in a hardcoded project (load.sh PRJ/USR). This
// flow lets the user CHOOSE the destination at connection-setup time — the same
// project-picker mental model as a UI file upload, for a Kafka source. The chosen
// project persists on the connector (POST /api/connectors); the loader reads it
// (kafka_loader::Cfg::from_connection). Reuses openModal's select field — no new UI.
"use strict";

import { openModal } from "/scripts/framework/modal.js";
import { api } from "/scripts/api.js";

/**
 * Open the "New Kafka connection" modal. Fetches the caller's projects → a
 * destination <select> → POST /api/connectors on submit. Returns the openModal
 * handle ({ el, close }) — or null if the dialog couldn't open.
 *
 *   opts.projects    — optional pre-supplied [{ redpash_id, name }] (skips the
 *                      fetch; used by the sandbox render-proof / tests).
 *   opts.afterCreate — (connector) => void, fired on a successful create.
 */
export async function openConnectionModal(opts = {}) {
  let projects = opts.projects;
  if (!projects) {
    // Same source the upload flow reads; on failure (e.g. unauth) the select is
    // empty and submit is blocked by the "choose a project" guard below.
    try { projects = (await api.get("/projects"))?.items || []; }
    catch { projects = []; }
  }

  // A leading empty prompt forces a DELIBERATE pick (the form is novalidate, so
  // the onSubmit guard — not HTML5 required — enforces it).
  const options = [{ value: "", label: "— Choose a project —" }].concat(
    projects.map((p) => ({ value: p.redpash_id, label: p.name || "(untitled)" })),
  );

  return openModal({
    title: "New Kafka connection",
    submitLabel: "Create connection",
    submitIcon: "bi-plug",
    fields: [
      { key: "name",  label: "Connection name", required: true,
        placeholder: "e.g. account-events", autocomplete: "off" },
      { key: "topic", label: "Topic", placeholder: "e.g. topic_account_jlr",
        hint: "Kafka topic to consume (optional — falls back to the connector's .env)." },
      { key: "project_id", label: "Destination project", type: "select", required: true,
        options,
        hint: "Where this connection's records land — the project you pick is RBAC-checked, exactly like a file upload." },
    ],
    onSubmit: async (values) => {
      if (!values.project_id) throw new Error("Pick a destination project.");
      const connector = await api.post("/connectors", {
        name:       (values.name || "").trim(),
        topic:      (values.topic || "").trim() || undefined,
        project_id: values.project_id,
      });
      if (typeof opts.afterCreate === "function") opts.afterCreate(connector);
    },
  });
}
