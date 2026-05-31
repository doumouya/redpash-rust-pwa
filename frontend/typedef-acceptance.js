/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/typedef-acceptance.md */
import { cellEditor } from "/scripts/framework/cell-editor.js";
import { editorRegistry } from "/scripts/framework/editor-registry.js";

// §6.1 — the fake RealEstateListing TypeDefinition. The framework has
// NEVER seen this; cell-editor must decorate every editable cell
// correctly with zero source changes.
const fakeListing = {
  type: "real_estate_listing",
  rid_prefix: "RES_",
  display_name: "Real Estate Listing",
  display_name_plural: "Real Estate Listings",
  is_builtin: false,
  fields: [
    { key: "address",     label: "Address",     data_type: "string",   editable: true, editor: "text",
      perm_class: "standard", owner: "write", admin: "write", member: "read",  viewer: "read" },
    { key: "list_price",  label: "List price",  data_type: "int",      editable: true, editor: "text",
      perm_class: "standard", owner: "write", admin: "write", member: "read",  viewer: "read" },
    { key: "status",      label: "Status",      data_type: "enum",     editable: true, editor: "chip-enum",
      options: ["active", "pending", "sold"], render: "stageChip",
      perm_class: "standard", owner: "write", admin: "write", member: "read",  viewer: "read" },
    { key: "listed_at",   label: "Listed at",   data_type: "datetime", editable: false,
      perm_class: "readonly", owner: "read",  admin: "read",  member: "read",  viewer: "read" },
    { key: "agent_id",    label: "Agent",       data_type: "rid",      editable: true, editor: "entity-picker",
      rel: { type: "user", multi: false },
      perm_class: "owner_grade", owner: "write", admin: "read", member: "read", viewer: "read" },
    { key: "description", label: "Description", data_type: "markdown", editable: true, editor: "text",
      data_full: true, data_trunc: 40,
      perm_class: "standard", owner: "write", admin: "write", member: "read",  viewer: "read" },
  ],
};

// Two sample rows. data-full carries the source-of-truth value;
// textContent carries the display form (post-trunc for description).
const ROWS = [
  {
    rid: "RES_0000000000000000000000000000ALPHA",
    address:     "742 Evergreen Terrace",
    list_price:  "450000",
    status:      "active",
    listed_at:   "2026-05-15T10:00:00Z",
    agent_id:    "USR_0000000000000000000000000000ALICE",
    description: "Charming 4-bed family home with a wraparound porch and a finished basement studio.",
  },
  {
    rid: "RES_0000000000000000000000000000BRAVO",
    address:     "1600 Sea Cliff Way",
    list_price:  "1850000",
    status:      "pending",
    listed_at:   "2026-05-20T14:30:00Z",
    agent_id:    "USR_0000000000000000000000000000BOB__",
    description: "Ocean-view contemporary with floor-to-ceiling glass and a chef's kitchen.",
  },
];

// Build the redtable shell shape cell-editor.decorate expects (#rp-home-list-tbody +
// tr[data-rid] + td cells). Pure DOM construction — no innerHTML — so the
// harness is safe-by-construction even though the editor-chip-enum buildOff
// contract still uses innerHTML internally via chipRender (the known contract
// CAS_BF208AA8 hardens).
function buildRow(row) {
  const tr = document.createElement("tr");
  tr.dataset.rid = row.rid;

  function td(opts) {
    const el = document.createElement("td");
    if (opts.full !== undefined) el.dataset.full = opts.full;
    if (opts.trunc !== undefined) el.dataset.trunc = String(opts.trunc);
    if (opts.child) el.appendChild(opts.child);
    else if (opts.text !== undefined) el.textContent = opts.text;
    return el;
  }

  // Build the status chip via DOM, not innerHTML (defense-in-depth).
  function statusChipNode(value) {
    const span = document.createElement("span");
    span.className = "rt-mono-pill rt-tone--low";
    span.textContent = value;
    return span;
  }

  // data-full carries the source-of-truth for every editable cell so
  // both buildOn (read into editor) and buildOff (restore on strip)
  // round-trip via the same attribute. listed_at omits data-full since
  // editable:false.
  tr.appendChild(td({ full: row.address,    text: row.address }));
  tr.appendChild(td({ full: row.list_price, text: row.list_price }));
  tr.appendChild(td({ full: row.status, child: statusChipNode(row.status) }));
  tr.appendChild(td({ text: row.listed_at }));
  tr.appendChild(td({ full: row.agent_id, text: row.agent_id }));
  const truncated = row.description.length > 40
    ? row.description.slice(0, 40) : row.description;
  tr.appendChild(td({ full: row.description, trunc: 40, text: truncated }));
  return tr;
}

const tbody = document.getElementById("rp-home-list-tbody");
ROWS.forEach((r) => tbody.appendChild(buildRow(r)));

// Chip vocabulary for the harness. Matches the home.js stageChip
// shape. Stays string-returning per the current cell-editor contract
// (CAS_BF208AA8 will harden later).
function stageChip(value) {
  const v = String(value || "").toLowerCase();
  const tone = v === "active"  ? "rt-tone--low"
             : v === "pending" ? "rt-tone--mid"
             : v === "sold"    ? "rt-tone--high"
             : "";
  return `<span class="rt-mono-pill ${tone}">${value || "—"}</span>`;
}
function chipRender(name) {
  if (name === "stageChip") return stageChip;
  return undefined;
}

// cellEditor.decorate spec — mapped from the fake TypeDefinition's
// fields[] into the same shape pages/home.js builds (col.editKey /
// editor / options / render / requiresAdmin / rel). The framework
// doesn't know about TypeDefinition directly — the consumer adapter
// is what bridges. type-registry.js consumers will use the same
// pattern (resolve a TypeDefinition into a spec.columns shape).
const harnessSpec = {
  endpoint: "/fake/real_estate_listings",
  columns: fakeListing.fields.map((f) => ({
    key: f.key,
    editKey: f.editable ? f.key : undefined,
    editable: f.editable,
    editor: f.editor,
    options: f.options,
    render: f.render,
    rel: f.rel,
    placeholder: f.editor === "entity-picker"
      ? `Search ${f.rel?.type || "entity"}…`
      : undefined,
  })),
};

let editMode = false;
let selectMode = false;

function applyDecorate() {
  cellEditor.decorate({
    view: document,                // harness root
    spec: harnessSpec,
    editMode,
    selectMode,
    isPlatformAdmin: true,
    chipRender,
  });
}

document.getElementById("edit-toggle").addEventListener("click", (e) => {
  editMode = !editMode;
  e.currentTarget.classList.toggle("is-active", editMode);
  applyDecorate();
});
document.getElementById("select-toggle").addEventListener("click", (e) => {
  selectMode = !selectMode;
  e.currentTarget.classList.toggle("is-active", selectMode);
});

// ── §6.2 acceptance bullets (FE-side) ──────────────────────────────
// Each test returns { name, pass: boolean, detail: string }.

function expect(name, pass, detail) {
  return { name, pass, detail };
}

function runAcceptance() {
  const results = [];

  // Ensure decorate ON before the dispatch tests
  editMode = true;
  document.getElementById("edit-toggle").classList.add("is-active");
  applyDecorate();

  const firstRow = tbody.querySelector("tr[data-rid]");
  const tds = firstRow.querySelectorAll("td");
  const cellAddress     = tds[0];
  const cellListPrice   = tds[1];
  const cellStatus      = tds[2];
  const cellListedAt    = tds[3];
  const cellAgentId     = tds[4];
  const cellDescription = tds[5];

  // 1. Editor dispatch — address → text (contenteditable)
  results.push(expect(
    "§6.2 — address dispatches to text editor",
    cellAddress.classList.contains("editable")
      && cellAddress.getAttribute("contenteditable") === "plaintext-only",
    `editable=${cellAddress.classList.contains("editable")} contenteditable=${cellAddress.getAttribute("contenteditable")}`,
  ));

  // 2. Editor dispatch — list_price → text (contenteditable)
  results.push(expect(
    "§6.2 — list_price dispatches to text editor",
    cellListPrice.classList.contains("editable")
      && cellListPrice.getAttribute("contenteditable") === "plaintext-only",
    `contenteditable=${cellListPrice.getAttribute("contenteditable")}`,
  ));

  // 3. Editor dispatch — status → chip-enum (select with 3 options)
  const statusSelect = cellStatus.querySelector("select.rp-cell-edit-select");
  const statusOptions = statusSelect ? [...statusSelect.querySelectorAll("option")].map((o) => o.value) : [];
  results.push(expect(
    "§6.2 — status dispatches to chip-enum with options",
    !!statusSelect
      && JSON.stringify(statusOptions) === JSON.stringify(["active", "pending", "sold"])
      && statusSelect.value === "active",
    `select=${!!statusSelect} options=${JSON.stringify(statusOptions)} current=${statusSelect?.value}`,
  ));

  // 4. listed_at is NOT decorated (editable:false in spec, perm_class readonly)
  results.push(expect(
    "§6.2 — listed_at NOT decorated (editable:false)",
    !cellListedAt.classList.contains("editable")
      && !cellListedAt.querySelector("input, select"),
    `editable=${cellListedAt.classList.contains("editable")}`,
  ));

  // 5. Editor dispatch — agent_id → entity-picker (input with relType)
  const agentInput = cellAgentId.querySelector("input.rp-cell-edit-input");
  results.push(expect(
    "§6.2 — agent_id dispatches to entity-picker with relType=user",
    !!agentInput
      && agentInput.dataset.relType === "user"
      && agentInput.placeholder.includes("user"),
    `input=${!!agentInput} relType=${agentInput?.dataset.relType} placeholder="${agentInput?.placeholder}"`,
  ));

  // 6. data-full pattern — description shows full source-of-truth in edit-mode
  const fullDesc = ROWS[0].description;
  results.push(expect(
    "§6.2 — data_full on description shows full text in edit-mode",
    cellDescription.textContent === fullDesc
      && cellDescription.dataset.full === fullDesc,
    `text matches full=${cellDescription.textContent === fullDesc}`,
  ));

  // 7. STRIP — toggle edit-mode OFF
  editMode = false;
  document.getElementById("edit-toggle").classList.remove("is-active");
  applyDecorate();

  // 8. After STRIP — description re-truncates to data_trunc=40 + chip restored
  const expectedTrunc = fullDesc.slice(0, 40);
  results.push(expect(
    "§6.2 — data_full+data_trunc render rules survive edit-mode toggle",
    cellDescription.textContent === expectedTrunc
      && cellDescription.dataset.full === fullDesc,
    `truncated="${cellDescription.textContent}" full preserved=${cellDescription.dataset.full === fullDesc}`,
  ));

  // 9. After STRIP — status chip restored via chipRender callback
  const statusChip = cellStatus.querySelector("span.rt-mono-pill");
  results.push(expect(
    "§6.2 — chip-enum buildOff restores chip via chipRender callback",
    !!statusChip
      && statusChip.textContent === "active",
    `chip=${statusChip?.outerHTML}`,
  ));

  // 10. After STRIP — agent_id buildOff (entity-picker) renders fallback
  results.push(expect(
    "§6.2 — entity-picker buildOff falls back to raw rid (renderRid not provided)",
    cellAgentId.textContent === ROWS[0].agent_id,
    `rendered="${cellAgentId.textContent}"`,
  ));

  // 11. UNIVERSAL FALLBACK — unknown editor falls back to text (§5.1 disposability rule)
  const fakeSpecWithUnknown = {
    endpoint: "/fake",
    columns: [{ key: "address", editKey: "address", editable: true, editor: "definitely_not_a_real_editor" }],
  };
  editMode = true;
  cellEditor.decorate({
    view: document,
    spec: fakeSpecWithUnknown,
    editMode,
    selectMode: false,
    isPlatformAdmin: true,
    chipRender,
  });
  results.push(expect(
    "§5.1 — unknown editor id silently downgrades to text (universal fallback)",
    cellAddress.classList.contains("editable")
      && cellAddress.getAttribute("contenteditable") === "plaintext-only",
    `text fallback applied=${cellAddress.getAttribute("contenteditable") === "plaintext-only"}`,
  ));

  // 12. CUSTOMER-SUPPLIED CODEC — register a fictional editor + dispatch through it
  let customEditorBuildOnCalled = false;
  editorRegistry.register({
    id: "quantum_state",
    buildOn(td) { customEditorBuildOnCalled = true; td.classList.add("editable"); td.textContent = "ψ"; },
    buildOff(td) { td.classList.remove("editable"); td.textContent = ""; },
    readValue() { return ""; },
  });
  const fakeCustomSpec = {
    endpoint: "/fake",
    columns: [{ key: "address", editKey: "address", editable: true, editor: "quantum_state" }],
  };
  editMode = false;  // strip first
  cellEditor.decorate({ view: document, spec: fakeCustomSpec, editMode, selectMode: false, isPlatformAdmin: true, chipRender });
  editMode = true;
  cellEditor.decorate({ view: document, spec: fakeCustomSpec, editMode, selectMode: false, isPlatformAdmin: true, chipRender });
  results.push(expect(
    "§6.2 — customer-supplied editor (fictional quantum_state) dispatches with zero source changes",
    customEditorBuildOnCalled
      && cellAddress.textContent === "ψ",
    `buildOn called=${customEditorBuildOnCalled} content="${cellAddress.textContent}"`,
  ));

  // Reset harness state for inspection
  editMode = false;
  document.getElementById("edit-toggle").classList.remove("is-active");
  cellEditor.decorate({ view: document, spec: harnessSpec, editMode, selectMode: false, isPlatformAdmin: true, chipRender });

  return results;
}

function renderResults(results) {
  const div = document.getElementById("results");
  while (div.firstChild) div.removeChild(div.firstChild);
  const pass = results.filter((r) => r.pass).length;
  const total = results.length;
  const allPassed = pass === total;

  // Pure-DOM result rendering — name + detail come from this module
  // (controlled) but writing via textContent is the safe default per
  // [[disposability-design-principle]]: the harness is the showcase, so
  // it should model the hardened shape, not the closure-form contract.
  const header = document.createElement("div");
  header.style.cssText = "margin-bottom:12px;font-size:16px;";
  const headerLabel = document.createElement("span");
  headerLabel.className = allPassed ? "pass" : "fail";
  headerLabel.textContent = allPassed ? "PASS" : "FAIL";
  header.appendChild(headerLabel);
  header.appendChild(document.createTextNode(` — ${pass} / ${total} bullets passed`));
  div.appendChild(header);

  results.forEach((r) => {
    const row = document.createElement("div");
    row.style.cssText = "margin-bottom:8px;";

    const mark = document.createElement("span");
    mark.className = r.pass ? "pass" : "fail";
    mark.textContent = r.pass ? "[✓]" : "[✗]";

    row.appendChild(mark);
    row.appendChild(document.createTextNode(" " + r.name));

    const detail = document.createElement("div");
    detail.style.cssText = "margin-left:24px;color:#666;font-size:12px;";
    detail.textContent = r.detail;
    row.appendChild(detail);

    div.appendChild(row);
  });

  // Expose result count for Playwright / CI harness
  window.__acceptanceResult = { pass, total, results };
}

document.getElementById("run-acceptance").addEventListener("click", () => {
  renderResults(runAcceptance());
});

// Initial paint (display mode, no decoration).
applyDecorate();
