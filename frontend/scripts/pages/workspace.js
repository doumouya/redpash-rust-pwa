// Workspace page — the redtable as a browser.
//
// Composes the eight components into the unified surface and wires
// their behaviour: rail collapse + project/file tabs, the toolbar
// (search, sort, select / edit / delete modes, dropdowns), the
// grouped filter builder, the side panels, the pager. The table
// carries sample rows — loading a file's real data from /api lands
// when the rail is wired to the file endpoints.

export default function workspace(app, { session }) {
  const $  = (s) => app.querySelector(s);
  const $$ = (s) => Array.from(app.querySelectorAll(s));

  // avatar — the signed-in user's initials
  const avatar = $("#wsAvatar");
  if (avatar) {
    const name = (session?.display_name || session?.username || "").trim();
    avatar.textContent = name
      ? name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()
      : "··";
  }

  // ── rail — collapse to compact ──────────────────────────────────
  const nav = $("#wsNav");
  $("#wsNavCollapse").addEventListener("click", (e) => {
    nav.classList.toggle("compact");
    e.currentTarget.querySelector("i").className = nav.classList.contains("compact")
      ? "bi bi-chevron-double-right" : "bi bi-chevron-double-left";
  });

  // ── rail body — expand groups, switch / close tabs ──────────────
  const navBody = $("#wsNavBody");
  navBody.addEventListener("click", (e) => {
    const head = e.target.closest(".rt-group-head");
    if (head) {
      if (e.target.closest(".rt-group-add")) {
        addFile(head.closest(".rt-group").querySelector(".rt-group-body"));
        return;
      }
      head.closest(".rt-group").classList.toggle("expanded");
      return;
    }
    if (e.target.closest(".rt-tab-close")) { e.target.closest(".rt-tab").remove(); return; }
    const tab = e.target.closest(".rt-tab");
    if (tab) {
      navBody.querySelectorAll(".rt-tab.active").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
    }
  });
  function addFile(body) {
    const t = document.createElement("button");
    t.className = "rt-tab";
    t.type = "button";
    t.innerHTML = '<i class="bi bi-filetype-csv rt-tab-icon"></i>'
      + '<span class="rt-tab-name">untitled.csv</span>'
      + '<span class="rt-tab-dot is-dirty"></span>'
      + '<span class="rt-tab-close" title="Close"><i class="bi bi-x"></i></span>';
    body.appendChild(t);
    body.closest(".rt-group").classList.add("expanded");
  }
  let pn = 0;
  $("#wsNewProject").addEventListener("click", () => {
    const colors = ["blue", "mauve", "teal", "peach"];
    const g = document.createElement("div");
    g.className = "rt-group";
    g.innerHTML = '<button class="rt-group-head" type="button">'
      + '<i class="bi bi-chevron-down rt-group-caret"></i>'
      + '<span class="rt-group-mark" data-c="' + colors[pn++ % 4] + '">NP</span>'
      + '<span class="rt-group-name">New project</span>'
      + '<span class="rt-group-count">0</span>'
      + '<span class="rt-group-add" title="New file"><i class="bi bi-plus"></i></span>'
      + '</button><div class="rt-group-body"></div>';
    navBody.appendChild(g);
    g.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  // ── table — search · filter · sort · select · edit/delete ───────
  const table = $("#wsTable");
  const tbody = table.tBodies[0];
  const rows = () => Array.from(tbody.rows);
  const cellText = (row, col) => (row.cells[col - 1]?.textContent || "").trim();

  let searchQ = "";
  let activeFilter = null;             // { outer:'AND'|'OR', groups:[...] }

  function passSearch(row) {
    if (!searchQ) return true;
    return Array.from(row.cells).some((c) => c.textContent.toLowerCase().includes(searchQ));
  }
  function passFilter(row) {
    if (!activeFilter || !activeFilter.groups.length) return true;
    const testPred = (p) => {
      const v = cellText(row, p.col).toLowerCase();
      const t = (p.val || "").toLowerCase();
      const empty = v === "" || v.startsWith("—");
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
    $("#wsRowsInfo").textContent = shown + " of " + rows().length + " rows";
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

  // sort — click = single key, shift-click = add a key
  let sortKeys = [];
  table.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", (e) => {
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

  // selection
  const selectAll = $("#wsSelectAll");
  const selChip = $("#wsSelChip"), selCount = $("#wsSelCount");
  const deleteBtn = app.querySelector('.rt-mode[data-mode="delete"]');
  const rowChecks = () => Array.from(tbody.querySelectorAll(".rt-chk"));
  function syncSel() {
    const checked = rowChecks().filter((c) => c.checked);
    rowChecks().forEach((c) => c.closest("tr").classList.toggle("is-selected", c.checked));
    selCount.textContent = checked.length;
    selChip.classList.toggle("show", checked.length > 0);
    selectAll.checked = checked.length > 0 && checked.length === rowChecks().length;
    selectAll.indeterminate = checked.length > 0 && checked.length < rowChecks().length;
    const armed = table.classList.contains("mode-select") && checked.length > 0;
    deleteBtn.classList.toggle("armed", armed);
    deleteBtn.title = armed ? "Delete " + checked.length + " selected" : "Delete mode";
  }
  selectAll.addEventListener("change", () => {
    rowChecks().forEach((c) => { c.checked = selectAll.checked; });
    syncSel();
  });
  tbody.addEventListener("change", (e) => {
    if (e.target.classList.contains("rt-chk")) syncSel();
  });
  selChip.addEventListener("click", () => {
    rowChecks().forEach((c) => { c.checked = false; });
    syncSel();
  });

  // edit / select / delete modes (mutually exclusive)
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
    // the delete-mode button doubles as "delete selected" while in
    // select mode — no separate bulk-delete button
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

  // ── filter panel — grouped predicate builder ────────────────────
  const groupList = $("#wsGroupList");
  const COLS = [[3, "Customer"], [4, "Email"], [5, "City"], [6, "Signed up"], [7, "Status"]];
  const OPS = [["contains", "contains"], ["is", "is"], ["not", "is not"],
               ["starts", "starts with"], ["empty", "is empty"], ["filled", "is not empty"]];
  let groupCombo = "AND";

  function predRow() {
    const d = document.createElement("div");
    d.className = "rt-pred";
    d.innerHTML =
      '<select class="rt-pred-col">'
      + COLS.map((c) => '<option value="' + c[0] + '">' + c[1] + "</option>").join("")
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
  addGroup();                          // seed one group

  $("#wsAddGroup").addEventListener("click", addGroup);

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
    addGroup();
    activeFilter = null;
    $("#wsFilterToggle").classList.remove("has-filter");
    refresh();
  });

  // ── side panels ─────────────────────────────────────────────────
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
  bindPanel("#wsToolsToggle", "#wsToolsPanel");

  // ── toolbar — refresh, row numbers ──────────────────────────────
  $("#wsRefresh").addEventListener("click", (e) => {
    const i = e.currentTarget.querySelector("i");
    i.classList.remove("rt-spinning");
    void i.offsetWidth;                // reflow so the animation re-runs
    i.classList.add("rt-spinning");
  });
  $("#wsRownum").addEventListener("click", (e) => {
    const on = e.currentTarget.classList.toggle("is-active");
    table.classList.toggle("no-rownum", !on);
  });

  // ── toolbar — dropdowns (rows-per-page, columns) ────────────────
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
  $("#wsColsDd").querySelectorAll("input[data-col]").forEach((chk) =>
    chk.addEventListener("change", () => {
      const n = chk.dataset.col;
      const show = chk.checked ? "" : "none";
      table.querySelectorAll("thead th:nth-child(" + n + "), tbody td:nth-child(" + n + ")")
        .forEach((c) => { c.style.display = show; });
    }));

  // ── omnibox — Ctrl/Cmd+K focuses the site search ────────────────
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      $("#wsOmni")?.focus();
    }
  });
}
