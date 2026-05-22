// Workspace page — the redtable as a browser, wired to /api.
//
// On mount: load real projects + lazy-load files per group. A file
// click fetches /api/files/:rid (columns) and /api/files/:rid/page
// (first 25 rows) in parallel and renders the table. The toolbar
// (search, sort, select / edit / delete, columns dropdown, filter
// builder) operates on whatever's loaded; column-indexed state
// (sort keys, filter, cols visibility) resets per file.
//
// What's still stubbed: real pagination + rows-per-page refetch, the
// refresh button, the cleaning tools panel actions, and saving edits
// or deletions back to the server (the cell / row modes are visual
// only). All land in the next pass.

import { api } from "/scripts/api.js";
import { mountTopbar } from "/scripts/topbar.js";

const STAGE_DOT    = { import: "is-dirty", clean: "is-warn", report: "is-clean", publish: "is-clean" };
const MARK_COLORS  = ["blue", "mauve", "teal", "peach"];
const DATE_DTYPES  = new Set(["date"]);

export default function workspace(app, { session }) {
  const $  = (s) => app.querySelector(s);
  const $$ = (s) => Array.from(app.querySelectorAll(s));

  mountTopbar($("#rp-topbar"), { active: "workspace", session });

  // ─── element refs ──────────────────────────────────────────────
  const nav        = $("#wsNav");
  const navBody    = $("#wsNavBody");
  const table      = $("#wsTable");
  const thead      = table.tHead;
  const tbody      = table.tBodies[0];
  const tableState = $("#wsTableState");
  const colsDd     = $("#wsColsDd");
  const rowsInfo   = $("#wsRowsInfo");
  const selChip    = $("#wsSelChip");
  const selCount   = $("#wsSelCount");
  const deleteBtn  = app.querySelector('.rt-mode[data-mode="delete"]');
  const groupList  = $("#wsGroupList");

  // ─── state ─────────────────────────────────────────────────────
  let activeFileRid = null;
  let activeColumns = [];   // ColumnMeta[] for the open file
  let groupColorIdx = 0;
  let sortKeys      = [];   // [{ col, dir, isDate }]
  let searchQ       = "";
  let activeFilter  = null; // { outer:'AND'|'OR', groups:[...] }
  let groupCombo    = "AND";
  let filterCols    = [];   // [[colIndex, name], ...] for the filter builder

  // ─── rail — collapse to compact ────────────────────────────────
  $("#wsNavCollapse").addEventListener("click", (e) => {
    nav.classList.toggle("compact");
    e.currentTarget.querySelector("i").className = nav.classList.contains("compact")
      ? "bi bi-chevron-double-right" : "bi bi-chevron-double-left";
  });

  // ─── rail — load projects + lazy files ─────────────────────────
  loadProjects();

  async function loadProjects() {
    try {
      const data = await api.get("/projects");
      renderRail(data?.items || []);
    } catch (err) {
      navBody.setAttribute("aria-busy", "false");
      navBody.innerHTML = '<div class="rt-nav-state">Couldn’t load projects'
        + (err.status ? " (" + err.status + ")" : "") + ".</div>";
    }
  }

  function renderRail(items) {
    navBody.setAttribute("aria-busy", "false");
    if (!items.length) {
      navBody.innerHTML = '<div class="rt-nav-state">No projects yet.</div>';
      return;
    }
    navBody.innerHTML = items.map(projectGroup).join("");
    // Auto-expand the default project (or the first), load its files.
    const first = navBody.querySelector('.rt-group[data-default="1"]')
               || navBody.querySelector(".rt-group");
    if (first) {
      first.classList.add("expanded");
      loadFilesForGroup(first);
    }
  }

  function projectGroup(p) {
    const c = MARK_COLORS[(groupColorIdx++) % MARK_COLORS.length];
    const initials = ((p.name || "?").trim().split(/\s+/)
      .map((w) => w[0]).join("") || "?").slice(0, 2).toUpperCase();
    return '<div class="rt-group" data-rid="' + esc(p.redpash_id) + '"'
      + (p.is_default ? ' data-default="1"' : '') + '>'
      +   '<button class="rt-group-head" type="button">'
      +     '<i class="bi bi-chevron-down rt-group-caret"></i>'
      +     '<span class="rt-group-mark" data-c="' + c + '">' + esc(initials) + '</span>'
      +     '<span class="rt-group-name">' + esc(p.name) + '</span>'
      +     '<span class="rt-group-count">' + (p.file_count || 0) + '</span>'
      +   '</button>'
      +   '<div class="rt-group-body" aria-busy="false"></div>'
      + '</div>';
  }

  async function loadFilesForGroup(group) {
    if (group.dataset.filesLoaded === "1") return;
    const body = group.querySelector(".rt-group-body");
    const rid  = group.dataset.rid;
    body.setAttribute("aria-busy", "true");
    body.innerHTML = '<div class="rt-nav-state">Loading files…</div>';
    try {
      const data = await api.get("/projects/" + encodeURIComponent(rid) + "/files");
      renderFiles(body, data?.items || []);
      group.dataset.filesLoaded = "1";
      // First load of the default group — auto-open its first file.
      if (!activeFileRid && group.dataset.default === "1") {
        const firstTab = body.querySelector(".rt-tab");
        if (firstTab) {
          navBody.querySelectorAll(".rt-tab.active").forEach((t) => t.classList.remove("active"));
          firstTab.classList.add("active");
          loadFile(firstTab.dataset.rid);
        }
      }
    } catch {
      body.innerHTML = '<div class="rt-nav-state">Couldn’t load files.</div>';
    } finally {
      body.setAttribute("aria-busy", "false");
    }
  }

  function renderFiles(body, items) {
    if (!items.length) {
      body.innerHTML = '<div class="rt-nav-state">No files yet.</div>';
      return;
    }
    body.innerHTML = items.map(fileTab).join("");
  }

  function fileTab(f) {
    const dot = STAGE_DOT[f.stage] || "is-dirty";
    const name = f.display_name || f.filename || "(unnamed)";
    return '<button class="rt-tab" type="button" data-rid="' + esc(f.redpash_id) + '">'
      +   '<i class="bi bi-filetype-csv rt-tab-icon"></i>'
      +   '<span class="rt-tab-name">' + esc(name) + '</span>'
      +   '<span class="rt-tab-dot ' + dot + '" title="' + esc(f.stage || "") + '"></span>'
      +   '<span class="rt-tab-close" title="Close"><i class="bi bi-x"></i></span>'
      + '</button>';
  }

  // ─── rail body — expand groups, switch / close tabs ────────────
  navBody.addEventListener("click", (e) => {
    const head = e.target.closest(".rt-group-head");
    if (head) {
      const group = head.closest(".rt-group");
      const wasExpanded = group.classList.contains("expanded");
      group.classList.toggle("expanded");
      if (!wasExpanded) loadFilesForGroup(group);
      return;
    }
    if (e.target.closest(".rt-tab-close")) {
      e.target.closest(".rt-tab").remove();
      return;
    }
    const tab = e.target.closest(".rt-tab");
    if (tab) {
      navBody.querySelectorAll(".rt-tab.active").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      loadFile(tab.dataset.rid);
    }
  });

  // ─── table — load a file's columns + first page ────────────────
  async function loadFile(rid) {
    if (!rid || rid === activeFileRid) return;
    activeFileRid = rid;
    setTableState("Loading…");
    rowsInfo.textContent = "Loading…";
    try {
      const [envelope, pageData] = await Promise.all([
        api.get("/files/" + encodeURIComponent(rid)),
        api.get("/files/" + encodeURIComponent(rid) + "/page"),
      ]);
      activeColumns = envelope?.columns || [];
      // Reset all column-indexed state — sort keys, filter, search.
      sortKeys = []; activeFilter = null; searchQ = "";
      $("#wsRowSearch").value = "";
      $("#wsFilterToggle").classList.remove("has-filter");
      renderTable(activeColumns, pageData?.rows || []);
      rebuildColsDropdown(activeColumns);
      rebuildFilterCols(activeColumns);
      rowsInfo.textContent = (pageData?.rows?.length || 0) + " of "
        + (pageData?.total || 0) + " rows · parsed in "
        + (pageData?.ms != null ? pageData.ms + " ms" : "—");
      setTableState(null);
    } catch (err) {
      setTableState("Couldn’t load file" + (err.status ? " (" + err.status + ")" : "") + ".");
      rowsInfo.textContent = "Error.";
    }
  }

  function renderTable(columns, rows) {
    thead.innerHTML = '<tr>'
      + '<th class="col-chk"><input type="checkbox" class="rt-chk" id="wsSelectAll" /></th>'
      + '<th class="col-rownum">#</th>'
      + columns.map((c, i) =>
          '<th class="sortable" data-sort="' + (i + 3) + '"'
          + (DATE_DTYPES.has(c.semantic_dtype) ? ' data-type="date"' : '')
          + '>' + esc(c.name) + ' <i class="bi bi-chevron-expand sort"></i></th>'
        ).join("")
      + '</tr>';
    tbody.innerHTML = rows.map((row, i) =>
      '<tr>'
      + '<td class="col-chk"><input type="checkbox" class="rt-chk" /></td>'
      + '<td class="col-n col-rownum">' + (i + 1) + '</td>'
      + columns.map((_, ci) => {
          const v = row[ci];
          const cls = v == null ? 'cell-muted editable' : 'editable';
          return '<td class="' + cls + '">' + esc(v == null ? "—" : v) + '</td>';
        }).join("")
      + '</tr>'
    ).join("");
    syncSel();
  }

  function setTableState(msg) {
    if (msg) {
      tableState.textContent = msg;
      tableState.hidden = false;
      table.hidden = true;
    } else {
      tableState.hidden = true;
      table.hidden = false;
    }
  }

  // ─── columns dropdown — rebuilt per file ───────────────────────
  function rebuildColsDropdown(columns) {
    colsDd.innerHTML = columns.map((c, i) =>
      '<label class="rt-dd-item"><input type="checkbox" class="rt-chk" data-col="'
      + (i + 3) + '" checked /> ' + esc(c.name) + '</label>'
    ).join("");
  }
  // Cols-toggle is delegated to the dropdown — survives rebuilds.
  colsDd.addEventListener("change", (e) => {
    const chk = e.target.closest("input[data-col]");
    if (!chk) return;
    const n = chk.dataset.col;
    const show = chk.checked ? "" : "none";
    table.querySelectorAll("thead th:nth-child(" + n + "), tbody td:nth-child(" + n + ")")
      .forEach((c) => { c.style.display = show; });
  });

  // ─── filter builder — COLS dynamic per file ────────────────────
  const OPS = [["contains", "contains"], ["is", "is"], ["not", "is not"],
               ["starts", "starts with"], ["empty", "is empty"], ["filled", "is not empty"]];

  function rebuildFilterCols(columns) {
    filterCols = columns.map((c, i) => [i + 3, c.name]);
    groupList.innerHTML = "";
    groupCombo = "AND";
    activeFilter = null;
    if (filterCols.length) addGroup();
    refresh();
  }

  function predRow() {
    const d = document.createElement("div");
    d.className = "rt-pred";
    d.innerHTML =
      '<select class="rt-pred-col">'
      + filterCols.map((c) => '<option value="' + c[0] + '">' + esc(c[1]) + "</option>").join("")
      + "</select>"
      + '<select class="rt-pred-op">'
      + OPS.map((o) => '<option value="' + o[0] + '">' + o[1] + "</option>").join("")
      + "</select>"
      + '<input class="rt-pred-val" placeholder="value" />'
      + '<button class="rt-pred-del" type="button" title="Remove condition"><i class="bi bi-x"></i></button>';
    return d;
  }
  function groupCard() {
    const card = document.createElement("div");
    card.className = "rt-group-card";
    card.innerHTML =
      '<div class="rt-group-card-head">'
      + '<div class="rt-seg rt-group-card-combo">'
      + '<button type="button" class="is-active" data-combo="AND">AND</button>'
      + '<button type="button" data-combo="OR">OR</button>'
      + "</div>"
      + '<button class="rt-group-card-del" type="button" title="Remove group"><i class="bi bi-trash3"></i></button>'
      + "</div>"
      + '<div class="rt-pred-list"></div>'
      + '<button class="rt-btn rt-btn--glass rt-btn--block rt-add-pred" type="button">'
      + '<i class="bi bi-plus-lg"></i> Add condition</button>';
    card.querySelector(".rt-pred-list").appendChild(predRow());
    return card;
  }
  function renderSeps() {
    groupList.querySelectorAll(".rt-group-sep").forEach((s) => s.remove());
    const cards = Array.from(groupList.querySelectorAll(".rt-group-card"));
    cards.slice(0, -1).forEach((card) => {
      const sep = document.createElement("div");
      sep.className = "rt-group-sep";
      sep.innerHTML = '<button type="button">' + groupCombo + "</button>";
      card.after(sep);
    });
  }
  function addGroup() { groupList.appendChild(groupCard()); renderSeps(); }

  $("#wsAddGroup").addEventListener("click", () => { if (filterCols.length) addGroup(); });

  groupList.addEventListener("click", (e) => {
    if (e.target.closest(".rt-pred-del")) { e.target.closest(".rt-pred").remove(); return; }
    if (e.target.closest(".rt-add-pred")) {
      e.target.closest(".rt-group-card").querySelector(".rt-pred-list").appendChild(predRow());
      return;
    }
    if (e.target.closest(".rt-group-card-del")) {
      if (groupList.querySelectorAll(".rt-group-card").length > 1)
        e.target.closest(".rt-group-card").remove();
      renderSeps();
      return;
    }
    const gcBtn = e.target.closest(".rt-group-card-combo button");
    if (gcBtn) {
      gcBtn.parentElement.querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
      gcBtn.classList.add("is-active");
      return;
    }
    if (e.target.closest(".rt-group-sep button")) {
      groupCombo = groupCombo === "AND" ? "OR" : "AND";
      groupList.querySelectorAll(".rt-group-sep button").forEach((b) => { b.textContent = groupCombo; });
    }
  });
  groupList.addEventListener("change", (e) => {
    if (e.target.classList.contains("rt-pred-op")) {
      const val = e.target.closest(".rt-pred").querySelector(".rt-pred-val");
      val.disabled = ["empty", "filled"].includes(e.target.value);
      if (val.disabled) val.value = "";
    }
  });
  function readGroup(card) {
    return {
      combo: card.querySelector(".rt-group-card-combo .is-active").dataset.combo,
      preds: Array.from(card.querySelectorAll(".rt-pred")).map((p) => ({
        col: +p.querySelector(".rt-pred-col").value,
        op:  p.querySelector(".rt-pred-op").value,
        val: p.querySelector(".rt-pred-val").value.trim(),
      })),
    };
  }
  $("#wsApplyFilter").addEventListener("click", () => {
    const groups = Array.from(groupList.querySelectorAll(".rt-group-card")).map(readGroup);
    activeFilter = { outer: groupCombo, groups };
    $("#wsFilterToggle").classList.toggle("has-filter", groups.some((g) => g.preds.length));
    refresh();
  });
  $("#wsClearFilter").addEventListener("click", () => {
    groupList.innerHTML = "";
    groupCombo = "AND";
    if (filterCols.length) addGroup();
    activeFilter = null;
    $("#wsFilterToggle").classList.remove("has-filter");
    refresh();
  });

  // ─── table — search · sort (over loaded rows) ──────────────────
  const rows     = () => Array.from(tbody.rows);
  const cellText = (row, col) => (row.cells[col - 1]?.textContent || "").trim();

  function passSearch(row) {
    if (!searchQ) return true;
    return Array.from(row.cells).some((c) => c.textContent.toLowerCase().includes(searchQ));
  }
  function passFilter(row) {
    if (!activeFilter || !activeFilter.groups.length) return true;
    const testPred = (p) => {
      const v = cellText(row, p.col).toLowerCase();
      const t = (p.val || "").toLowerCase();
      const empty = v === "" || v === "—";
      switch (p.op) {
        case "contains": return v.includes(t);
        case "is":       return v === t;
        case "not":      return v !== t;
        case "starts":   return v.startsWith(t);
        case "empty":    return empty;
        case "filled":   return !empty;
      }
      return true;
    };
    const groupPass = (g) => !g.preds.length ? true
      : (g.combo === "AND" ? g.preds.every(testPred) : g.preds.some(testPred));
    return activeFilter.outer === "AND"
      ? activeFilter.groups.every(groupPass)
      : activeFilter.groups.some(groupPass);
  }
  function refresh() {
    let shown = 0;
    rows().forEach((r) => {
      const vis = passSearch(r) && passFilter(r);
      r.hidden = !vis;
      if (vis) shown++;
    });
    if (activeFileRid) rowsInfo.textContent = shown + " of " + rows().length + " rows shown";
  }
  function renumber() {
    rows().forEach((r, i) => {
      const c = r.querySelector(".col-rownum");
      if (c) c.textContent = i + 1;
    });
  }

  $("#wsRowSearch").addEventListener("input", (e) => {
    searchQ = e.target.value.trim().toLowerCase();
    refresh();
  });

  // sort — delegated on thead so it survives a re-render
  thead.addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    const col = +th.dataset.sort, isDate = th.dataset.type === "date";
    const key = sortKeys.find((k) => k.col === col);
    if (e.shiftKey) {
      if (key) key.dir *= -1;
      else sortKeys.push({ col, dir: 1, isDate });
    } else if (sortKeys.length === 1 && sortKeys[0].col === col) {
      sortKeys[0].dir *= -1;
    } else {
      sortKeys = [{ col, dir: 1, isDate }];
    }
    applySort();
  });
  function applySort() {
    rows().sort((a, b) => {
      for (const k of sortKeys) {
        let x = cellText(a, k.col), y = cellText(b, k.col);
        if (k.isDate) { x = Date.parse(x) || 0; y = Date.parse(y) || 0; }
        else { x = x.toLowerCase(); y = y.toLowerCase(); }
        if (x < y) return -k.dir;
        if (x > y) return k.dir;
      }
      return 0;
    }).forEach((r) => tbody.appendChild(r));
    renumber();
    table.querySelectorAll("th.sortable").forEach((h) => {
      const idx = sortKeys.findIndex((k) => k.col === +h.dataset.sort);
      const ic = h.querySelector(".sort");
      let ord = h.querySelector(".sort-ord");
      h.classList.toggle("sorted", idx !== -1);
      if (idx === -1) {
        ic.className = "bi sort bi-chevron-expand";
        if (ord) ord.remove();
      } else {
        ic.className = "bi sort " + (sortKeys[idx].dir > 0 ? "bi-chevron-up" : "bi-chevron-down");
        if (sortKeys.length > 1) {
          if (!ord) { ord = document.createElement("sup"); ord.className = "sort-ord"; h.appendChild(ord); }
          ord.textContent = idx + 1;
        } else if (ord) { ord.remove(); }
      }
    });
  }

  // ─── selection ─────────────────────────────────────────────────
  const rowChecks = () => Array.from(tbody.querySelectorAll(".rt-chk"));
  function syncSel() {
    const selectAll = thead.querySelector("#wsSelectAll");
    const checked = rowChecks().filter((c) => c.checked);
    rowChecks().forEach((c) => c.closest("tr").classList.toggle("is-selected", c.checked));
    selCount.textContent = checked.length;
    selChip.classList.toggle("show", checked.length > 0);
    if (selectAll) {
      selectAll.checked = checked.length > 0 && checked.length === rowChecks().length;
      selectAll.indeterminate = checked.length > 0 && checked.length < rowChecks().length;
    }
    const armed = table.classList.contains("mode-select") && checked.length > 0;
    deleteBtn.classList.toggle("armed", armed);
    deleteBtn.title = armed ? "Delete " + checked.length + " selected" : "Delete mode";
  }
  thead.addEventListener("change", (e) => {
    if (e.target.id === "wsSelectAll") {
      rowChecks().forEach((c) => { c.checked = e.target.checked; });
      syncSel();
    }
  });
  tbody.addEventListener("change", (e) => {
    if (e.target.classList.contains("rt-chk")) syncSel();
  });
  selChip.addEventListener("click", () => {
    rowChecks().forEach((c) => { c.checked = false; });
    syncSel();
  });

  // ─── edit / select / delete modes (visual; save lands next) ────
  const modeBtns = $$(".rt-mode");
  function setMode(btn) {
    const turnOn = !btn.classList.contains("is-active");
    modeBtns.forEach((b) => b.classList.remove("is-active"));
    table.classList.remove("mode-edit", "mode-select", "mode-delete");
    tbody.querySelectorAll("td.editable").forEach((td) => td.removeAttribute("contenteditable"));
    rowChecks().forEach((c) => { c.checked = false; });
    syncSel();
    if (turnOn) {
      btn.classList.add("is-active");
      table.classList.add("mode-" + btn.dataset.mode);
      if (btn.dataset.mode === "edit")
        tbody.querySelectorAll("td.editable").forEach((td) => td.setAttribute("contenteditable", "true"));
    }
  }
  modeBtns.forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.mode === "delete"
        && table.classList.contains("mode-select")
        && rowChecks().some((c) => c.checked)) {
      rowChecks().filter((c) => c.checked).forEach((c) => c.closest("tr").remove());
      syncSel(); renumber(); refresh();
      return;
    }
    setMode(b);
  }));
  tbody.addEventListener("click", (e) => {
    if (!table.classList.contains("mode-delete")) return;
    const tr = e.target.closest("tr");
    if (tr) { tr.remove(); renumber(); refresh(); }
  });
  tbody.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.isContentEditable) {
      e.preventDefault();
      e.target.blur();
    }
  });

  // ─── side panels ───────────────────────────────────────────────
  function bindPanel(btnSel, panelSel) {
    const btn = $(btnSel), panel = $(panelSel);
    const set = (open) => {
      panel.classList.toggle("open", open);
      btn.classList.toggle("is-active", open);
    };
    btn.addEventListener("click", () => set(!panel.classList.contains("open")));
    panel.querySelector(".rt-panel-close").addEventListener("click", () => set(false));
  }
  bindPanel("#wsFilterToggle", "#wsFilterPanel");
  bindPanel("#wsToolsToggle",  "#wsToolsPanel");

  // ─── refresh — re-fetch the open file (or no-op) ───────────────
  $("#wsRefresh").addEventListener("click", (e) => {
    const i = e.currentTarget.querySelector("i");
    i.classList.remove("rt-spinning");
    void i.offsetWidth;
    i.classList.add("rt-spinning");
    if (activeFileRid) {
      const rid = activeFileRid;
      activeFileRid = null;        // force loadFile to re-run
      loadFile(rid);
    }
  });

  // ─── row numbers toggle ────────────────────────────────────────
  $("#wsRownum").addEventListener("click", (e) => {
    const on = e.currentTarget.classList.toggle("is-active");
    table.classList.toggle("no-rownum", !on);
  });

  // ─── dropdowns (rows-per-page, columns) ────────────────────────
  $$("[data-dd]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const dd = $("#" + btn.dataset.dd);
      const wasOpen = dd.classList.contains("open");
      app.querySelectorAll(".rt-dd.open").forEach((d) => d.classList.remove("open"));
      dd.classList.toggle("open", !wasOpen);
    }));
  document.addEventListener("click", () =>
    app.querySelectorAll(".rt-dd.open").forEach((d) => d.classList.remove("open")));

  // Rows-per-page — label only for now; real refetch lands with pagination.
  $("#wsRowsDd").addEventListener("click", (e) => {
    const item = e.target.closest(".rt-dd-item");
    if (!item) return;
    $("#wsRowsDd").querySelectorAll(".rt-dd-item").forEach((i) => {
      i.classList.remove("selected");
      const t = i.querySelector(".tick");
      if (t) t.remove();
    });
    item.classList.add("selected");
    item.insertAdjacentHTML("beforeend", ' <i class="bi bi-check2 tick"></i>');
    $("#wsRowsLabel").textContent =
      item.dataset.rows === "all" ? "All rows" : item.dataset.rows + " rows";
  });
  $("#wsColsDd").addEventListener("click", (e) => e.stopPropagation());

  // ─── escape utility ────────────────────────────────────────────
  function esc(s) {
    return String(s ?? "").replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
}
