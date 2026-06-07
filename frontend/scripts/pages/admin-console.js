/* Purpose: Admin Console page — org management / configuration (Cleanings ·
   Fields · Audit catalog). Split out of monitoring.js (was the "admin" rail-seg
   surface) into its own route in the Admin app (Slice B). Platform-admin gated.
   Doc: docs/internal/code/frontend/scripts/pages/admin-console.md */
// ── Admin Console ───────────────────────────────────────────────────────────
// One of the Admin app's pages (alongside Monitoring + Database). Was the
// "Admin Console" surface of the old combined Monitoring page (the rail-seg);
// now its own page so the Admin app's three surfaces are three routes with a
// per-app topbar, not one page with a hidden rail toggle. The three tabs are
// read-only LIST_VIEWS over /api/admin/* (steps/fields/audit-catalog) — all
// already platform-admin gated server-side (require_platform_admin_mw on the
// /admin nest). This page is LEAN: it composes the framework rail (mountRail)
// + the shared list-page atoms (headHTML / listToolbarHTML / listPanel / pager)
// rather than carrying the monitoring god-object's chart / window / hide-restore
// machinery the admin tabs never used.

import { api } from "/scripts/api.js";
import { mountTopbar } from "/scripts/topbar.js";
import { mountRail } from "/scripts/framework/rail.js";
import { esc, cssEsc } from "/scripts/dom.js";
import { getPref, setPref } from "/scripts/prefs.js";
import {
  headHTML, kpiStripHTML, listToolbarHTML,
  listPanel, setKpi, renderListPager, wireListColumnsExport,
} from "/scripts/list-page.js";

// ── small helpers (moved from monitoring.js with the admin tabs) — MODULE scope
// so the module-scope ADMIN_VIEWS row functions below can reference them. ──
function fmtCount(n) {
  if (n == null) return "—";
  if (n < 1000)    return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1) + "k";
  return (n / 1000000).toFixed(1) + "M";
}
function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return date + ", " + time;
}
// (object × field × tier) access cell — write/read/none, mirror of the backend
// GET /api/admin/fields cell shape.
function accessChip(value) {
  const v = String(value || "none").toLowerCase();
  const tone = v === "write" ? "rp-tone-high" : v === "read" ? "rp-tone-mid" : "rp-meta";
  if (v === "none" || v === "" || v === "—") return '<span class="rp-meta">—</span>';
  return '<span class="rp-mono-pill ' + tone + '">' + esc(v) + '</span>';
}

// ── the three admin tabs (moved verbatim from monitoring.js LIST_VIEWS) ──
const ADMIN_VIEWS = {
  steps: {
    title: "Cleanings", icon: "bi-wrench", endpoint: "/admin/steps",
    columns: [
      { label: "File",    key: "file_filename", sortable: true  },
      { label: "#",       key: "ordinal",       sortable: true  },
      { label: "Kind",    key: "kind",          sortable: true  },
      { label: "Applied", key: "applied",       sortable: true  },
      { label: "When",    key: "created_at",    sortable: true  },
    ],
    row: (s) =>
      '<tr>'
      + '<td>' + esc(s.file_filename) + '</td>'
      + '<td class="is-num">' + s.ordinal + '</td>'
      + '<td><span class="rp-mono-pill">' + esc(s.kind) + '</span></td>'
      + '<td>' + (s.applied ? '<span class="rp-mono-pill rp-tone-low">yes</span>'
                            : '<span class="rp-mono-pill">no</span>') + '</td>'
      + '<td>' + fmtTime(s.created_at) + '</td>'
      + '</tr>',
  },
  fields: {
    title: "Fields", icon: "bi-grid-3x2-gap", endpoint: "/admin/fields",
    columns: [
      { label: "Object",   key: "object",      sortable: true  },
      { label: "Field",    key: "field",       sortable: true  },
      { label: "Editable", key: "is_editable", sortable: true  },
      { label: "Sortable", key: "is_sortable", sortable: true  },
      { label: "Owner",    key: "owner",       sortable: false },
      { label: "Admin",    key: "admin",       sortable: false },
      { label: "Member",   key: "member",      sortable: false },
      { label: "Viewer",   key: "viewer",      sortable: false },
    ],
    row: (f) =>
      '<tr>'
      + '<td>' + esc(f.object || "—") + '</td>'
      + '<td><span class="rp-mono-pill">' + esc(f.field || "—") + '</span></td>'
      + '<td>' + (f.is_editable ? '<span class="rp-mono-pill rp-tone-low">yes</span>'
                                : '<span class="rp-mono-pill">no</span>') + '</td>'
      + '<td>' + (f.is_sortable ? '<span class="rp-mono-pill rp-tone-low">yes</span>'
                                : '<span class="rp-mono-pill">no</span>') + '</td>'
      + '<td>' + accessChip(f.owner)  + '</td>'
      + '<td>' + accessChip(f.admin)  + '</td>'
      + '<td>' + accessChip(f.member) + '</td>'
      + '<td>' + accessChip(f.viewer) + '</td>'
      + '</tr>',
  },
  audit_catalog: {
    title: "Audit catalog", icon: "bi-card-checklist", endpoint: "/admin/audit-catalog",
    // /admin/audit-catalog returns { tools: [...] }, not the standard Page<T>.
    itemsKey: "tools",
    columns: [
      { label: "Tool",        key: "tool",           sortable: true  },
      { label: "Last run",    key: "ran_at",         sortable: true  },
      { label: "Total",       key: "findings_total", sortable: false },
      { label: "High",        key: "findings_high",  sortable: false },
      { label: "Medium",      key: "findings_med",   sortable: false },
      { label: "Low",         key: "findings_low",   sortable: false },
      { label: "Δ new",       key: "diff_new",       sortable: false },
      { label: "Δ regressed", key: "diff_regressed", sortable: false },
      { label: "Δ improved",  key: "diff_improved",  sortable: false },
      { label: "Δ fixed",     key: "diff_fixed",     sortable: false },
    ],
    row: (t) => {
      const sev = (n, tone) => '<td class="is-num">'
        + (n > 0 ? '<span class="rp-mono-pill ' + tone + '">' + n + '</span>' : '—')
        + '</td>';
      const diff = (n) => '<td class="is-num">'
        + (typeof n === 'number' ? (n > 0 ? '+' + n : String(n)) : '—')
        + '</td>';
      const f = t.findings || {};
      const d = t.diff || {};
      return '<tr>'
        + '<td><span class="rp-mono-pill">' + esc(t.tool || "—") + '</span></td>'
        + '<td>' + (t.ran_at ? fmtTime(t.ran_at) : '—') + '</td>'
        + '<td class="is-num">' + (f.total || 0) + '</td>'
        + sev(f.high || 0, 'rp-tone-high')
        + sev(f.med  || 0, 'rp-tone-mid')
        + sev(f.low  || 0, 'rp-tone-low')
        + diff(d.new)
        + diff(d.regressed)
        + diff(d.improved)
        + diff(d.fixed)
        + '</tr>';
    },
  },
};

const ADMIN_TABS = [
  { key: "steps",         label: "Cleanings",     icon: "bi-wrench" },
  { key: "fields",        label: "Fields",        icon: "bi-grid-3x2-gap" },
  { key: "audit_catalog", label: "Audit catalog", icon: "bi-card-checklist" },
];
const DEFAULT_TAB = "steps";

export default function adminConsole(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "admin-console", session });

  const view = app.querySelector("#acView");
  // Defense in depth — the route guard already bounces non-admins (and the
  // backend /admin/* nest is the real auth); render an honest denied surface
  // if this is somehow reached without the claim.
  if (!session?.is_platform_admin) {
    view.innerHTML = '<div class="rp-page__placeholder" style="margin:auto;text-align:center;">'
      + '<h2 class="rp-title">Admin Console</h2>'
      + '<p class="rp-page__sub">Restricted to platform administrators.</p>'
      + '<p style="margin-top:1rem;"><a class="rp-btn rp-btn--glass" href="#/home">Back to home</a></p>'
      + '</div>';
    return;
  }

  const rail = mountRail(app.querySelector("#acRail"), {
    title: "Admin Console",
    collapsible: true,
    groups: [{
      id: "admin", name: "ADMIN", mark: "var(--rp-mauve)",
      tabs: ADMIN_TABS.map((t) => ({ id: t.key, name: t.label, icon: t.icon })),
    }],
    footer: { nav: { active: "", session } },
    on: { tab: (id) => activate(id) },
  });

  // ── list state ──
  let listPage = 1, listTotalPages = 1, listTotal = 0, listShown = 0;
  let listSearch = "", activeKey = null, lastRows = [], colsCtrl = null;

  const pageSize = () => {
    const n = parseInt(getPref("admin-console-rowsPerPage") || "", 10);
    return Number.isFinite(n) && n > 0 ? n : 25;
  };

  function markActive(key) {
    app.querySelectorAll("#acRail .rp-rail-tab.active").forEach((t) => t.classList.remove("active"));
    app.querySelector('#acRail .rp-rail-tab[data-tab-id="' + cssEsc(key) + '"]')?.classList.add("active");
  }

  function activate(key) {
    const spec = ADMIN_VIEWS[key];
    if (!spec) return;
    activeKey = key;
    listPage = 1;
    listSearch = "";
    markActive(key);
    renderListBody(spec);
  }

  function renderListBody(spec) {
    const kpiTiles = [
      { label: "Total",      id: "ac-list-total" },
      { label: "On page",    id: "ac-list-shown" },
      { label: "Page",       id: "ac-list-page"  },
      { label: "Last fetch", id: "ac-list-ms"    },
    ];
    view.innerHTML = ''
      + headHTML(spec.title, "")
      + kpiStripHTML(kpiTiles)
      + listToolbarHTML({ searchPlaceholder: "Search " + spec.title.toLowerCase() + "…", modes: false })
      + listPanel(spec.columns, "ac-list-tbody")
      + '<div class="rp-pager" id="ac-list-pager"></div>';

    view.querySelector("#rp-list-toolbar-refresh")?.addEventListener("click", (e) => {
      const icon = e.currentTarget.querySelector("i");
      if (icon) { icon.classList.remove("rp-toolbar-spin"); void icon.offsetWidth; icon.classList.add("rp-toolbar-spin"); }
      fetchList(spec);
    });

    const rowsDd = view.querySelector("#rp-list-toolbar-rows-dd");
    const syncRowsLabel = () => {
      const raw = getPref("admin-console-rowsPerPage") || "25";
      const lbl = view.querySelector("#rp-list-toolbar-rows-label");
      if (lbl) lbl.textContent = raw + " rows";
      rowsDd?.querySelectorAll(".rp-menu-item").forEach((i) => {
        i.classList.remove("selected");
        i.querySelector(".tick")?.remove();
      });
      const sel = rowsDd?.querySelector('.rp-menu-item[data-rows="' + raw + '"]')
        || rowsDd?.querySelector('.rp-menu-item[data-rows="25"]');
      if (sel) { sel.classList.add("selected"); sel.insertAdjacentHTML("beforeend", ' <i class="bi bi-check2 tick"></i>'); }
    };
    syncRowsLabel();
    rowsDd?.addEventListener("click", (e) => {
      const item = e.target.closest(".rp-menu-item");
      if (!item) return;
      setPref("admin-console-rowsPerPage", item.dataset.rows);
      listPage = 1;
      syncRowsLabel();
      fetchList(spec);
    });

    const searchEl = view.querySelector("#rp-list-toolbar-search");
    if (searchEl) {
      let timer = null;
      searchEl.addEventListener("input", () => {
        const q = searchEl.value.trim();
        if (q === listSearch) return;
        listSearch = q;
        clearTimeout(timer);
        timer = setTimeout(() => { listPage = 1; fetchList(spec); }, 200);
      });
    }

    colsCtrl = wireListColumnsExport(view, {
      columns: spec.columns || [],
      storageKey: activeKey,
      getRows: () => lastRows,
      exportName: activeKey,
    });

    view.querySelector("#ac-list-pager").addEventListener("click", (e) => {
      const btn = e.target.closest(".rp-pg[data-page]");
      if (!btn) return;
      const target = parseInt(btn.dataset.page, 10);
      if (!Number.isFinite(target) || target < 1 || target > listTotalPages || target === listPage) return;
      listPage = target;
      fetchList(spec);
    });

    fetchList(spec);
  }

  async function fetchList(spec) {
    ["ac-list-total", "ac-list-shown", "ac-list-ms"].forEach((id) => setKpi(view, id, "…"));
    setKpi(view, "ac-list-page", String(listPage));
    const tbody = view.querySelector("#ac-list-tbody");
    const colCount = spec.columns.length;
    if (tbody) tbody.innerHTML = '<tr><td colspan="' + colCount + '">Loading…</td></tr>';

    const qs = "?page=" + listPage + "&size=" + pageSize()
      + (listSearch ? "&q=" + encodeURIComponent(listSearch) : "");
    const t0 = performance.now();
    try {
      const data = await api.get(spec.endpoint + qs);
      const rows = (spec.itemsKey && Array.isArray(data?.[spec.itemsKey]))
        ? data[spec.itemsKey]
        : (data?.rows || []);
      listTotalPages = data?.pages || 1;
      listPage = data?.page || listPage;
      listTotal = data?.total ?? rows.length;
      listShown = rows.length;
      const elapsed = Math.round(performance.now() - t0);
      setKpi(view, "ac-list-total", fmtCount(data?.total ?? rows.length));
      setKpi(view, "ac-list-shown", String(rows.length));
      setKpi(view, "ac-list-page",  listPage + " / " + listTotalPages);
      setKpi(view, "ac-list-ms",    elapsed + "ms");
      const head = view.querySelector(".rp-shell-head-count");
      if (head) head.textContent = (data?.total ?? rows.length) + " total";
      if (tbody) {
        tbody.innerHTML = rows.length
          ? rows.map(spec.row).join("")
          : '<tr><td colspan="' + colCount + '">No rows.</td></tr>';
      }
      lastRows = rows;
      colsCtrl?.applyColumnOrder();
      colsCtrl?.applyHiddenColumns();
      renderListPager(view, "ac-list-pager", {
        page: listPage, totalPages: listTotalPages, total: listTotal, shown: listShown, pageSize: pageSize(),
      });
    } catch (err) {
      ["ac-list-total", "ac-list-shown", "ac-list-page", "ac-list-ms"].forEach((id) => setKpi(view, id, "—"));
      if (tbody) tbody.innerHTML = '<tr><td colspan="' + colCount + '">Couldn’t load'
        + (err?.status ? " (" + err.status + ")" : "") + '.</td></tr>';
    }
  }

  // ── boot on the first tab ──
  activate(DEFAULT_TAB);
}
