/* ─────────────────── SpreadSheet Paper — controls.js ───────────────────
 *
 * Minimal interactive behaviors for the sandbox. Loaded after include.js
 * with `defer`. Exposes a handful of window-level helpers wired into the
 * partials via inline onclick — keeps the fragments self-documenting
 * (you can read a tab's HTML and see exactly what each button does).
 *
 *   spToggle(id|el, cls?)        — toggle a class (default "open") on a node
 *   spSetMode(btn, group?)       — mode triplet: one of N buttons active at
 *                                  a time inside its containing toolbar;
 *                                  click again to deactivate
 *   spToggleActive(btn, cls?)    — flip .is-active on a single toggle
 *                                  button (row-num, open-links, link-sync)
 *   spToggleSection(headerEl)    — collapse / expand a tools-panel section
 *                                  (rotates chevron, slides body)
 *   openModal(id)  / closeModal  — show / hide a .rp-modal-overlay
 *   spOnDocClickClosePanels()    — wired once on load; click outside a
 *                                  panel/modal trigger to close it
 *
 * No bundler, no module — straight ES5-ish so it parses in any browser
 * without ceremony. State lives in the DOM (classes / aria-pressed) so
 * the controls survive a fragment re-mount without bookkeeping.
 * ───────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  // ── Generic toggle ─────────────────────────────────────────────
  function spToggle(target, cls) {
    cls = cls || "open";
    var el = (typeof target === "string")
      ? (document.getElementById(target) || document.querySelector(target))
      : target;
    if (!el) return;
    el.classList.toggle(cls);
  }
  window.spToggle = spToggle;

  // ── Undo / Redo — 1-step in-memory stack (mockup) ──────────────
  // Per-panel slot for the most recent reversible action. The live
  // app keeps at least 3 steps client-side (see memory: RedPash undo
  // history cache); the demo collapses to one so the wiring is
  // visible end-to-end without a stack-management layer. WeakMap
  // keys by panel so multiple projects on one page each get their
  // own undo / redo independently.
  var _spUndoMap = new WeakMap();
  var _spRedoMap = new WeakMap();

  // Repaint the pager's data-total + visible-range label. Used by
  // both the delete action (decrement) and undo (restore). Centralised
  // so the rendering stays consistent.
  function _spSetPagerTotal(pager, total) {
    if (!pager) return;
    pager.setAttribute("data-total", total);
    var info = pager.querySelector(".rp-rt-rows-info");
    if (!info) return;
    var perPage = parseInt(pager.getAttribute("data-per-page"), 10) || 50;
    var visible = Math.min(perPage, total);
    info.textContent = (total > 0 ? "1-" + visible : "0") + " of " + total;
  }

  // Sync the header's Undo / Redo buttons' disabled state to the
  // stacks. Buttons are scoped by panel — each project's header has
  // its own pair. Memory says: disable when nothing to undo/redo so
  // the affordance never sits "always active".
  function _spSyncUndoRedoButtons(panel) {
    if (!panel) return;
    var undoBtn = panel.querySelector('[data-sp-undo]');
    var redoBtn = panel.querySelector('[data-sp-redo]');
    if (undoBtn) undoBtn.disabled = !_spUndoMap.has(panel);
    if (redoBtn) redoBtn.disabled = !_spRedoMap.has(panel);
  }

  // Push a new reversible action onto the panel's undo slot. New
  // action invalidates any pending redo (standard undo/redo semantics
  // — once you do something new, the redo path is dropped).
  window.spPushUndo = function (panel, entry) {
    if (!panel) return;
    _spUndoMap.set(panel, entry);
    _spRedoMap.delete(panel);
    _spSyncUndoRedoButtons(panel);
  };

  window.spUndo = function (btn) {
    var panel = btn && btn.closest(".rp-rt-panel");
    if (!panel) return;
    var entry = _spUndoMap.get(panel);
    if (!entry) return;
    if (entry.type === "deleteRows") {
      // Resurrect: clear .is-removed so they're back in layout, then
      // peel .is-removing on the next frame so the cells fade in.
      entry.rows.forEach(function (r) {
        r.classList.remove("is-removed");
        void r.offsetWidth;
        r.classList.remove("is-removing");
      });
      _spSetPagerTotal(entry.pager, entry.prevTotal);
    } else if (entry.type === "updateField") {
      entry.el.textContent = entry.prevText;
    }
    _spUndoMap.delete(panel);
    _spRedoMap.set(panel, entry);
    _spSyncUndoRedoButtons(panel);
  };

  window.spRedo = function (btn) {
    var panel = btn && btn.closest(".rp-rt-panel");
    if (!panel) return;
    var entry = _spRedoMap.get(panel);
    if (!entry) return;
    if (entry.type === "deleteRows") {
      entry.rows.forEach(function (r) {
        r.classList.add("is-removing");
        setTimeout(function () { r.classList.add("is-removed"); }, 180);
      });
      _spSetPagerTotal(entry.pager, entry.nextTotal);
    } else if (entry.type === "updateField") {
      entry.el.textContent = entry.nextText;
    }
    _spRedoMap.delete(panel);
    _spUndoMap.set(panel, entry);
    _spSyncUndoRedoButtons(panel);
  };

  // Track edits on any field marked contenteditable. The set of
  // editable surfaces varies by page (cleaner: file names + CSV
  // cells; reports + dashboard will mark their own per-standard-
  // object fields) and can change at runtime when modes flip — so
  // we listen on the general [contenteditable="true"] attribute
  // rather than a hardcoded selector list. Whatever the live app
  // marks editable becomes undoable for free.
  //
  // focusin captures the text before the user edits it; focusout
  // pushes the change onto the undo stack if anything actually
  // changed. focusout checks dataset (not the selector) so an
  // edit that started while editable still resolves cleanly even
  // if contenteditable was flipped off mid-edit.
  document.addEventListener("focusin", function (e) {
    var el = e.target;
    if (!el || !el.matches || !el.matches('[contenteditable="true"]')) return;
    el.dataset.spPrevText = el.textContent;
  });
  document.addEventListener("focusout", function (e) {
    var el = e.target;
    if (!el || el.dataset == null || el.dataset.spPrevText == null) return;
    var prev = el.dataset.spPrevText;
    delete el.dataset.spPrevText;
    var next = el.textContent;
    if (prev === next) return;
    var panel = el.closest(".rp-rt-panel");
    if (!panel) return;
    window.spPushUndo(panel, {
      type:     "updateField",
      el:       el,
      prevText: prev,
      nextText: next,
    });
  });

  // ── Mode triplet (edit / select / delete) ──────────────────────
  // Walks the clicked button's containing toolbar for siblings carrying
  // [data-sp-mode] and clears their is-active before flipping ours.
  // Re-clicking the active mode turns it off entirely (single-active
  // group with a "no mode" state).
  //
  // Side-effect: drops `.is-mode-{value}` on the .rp-rt-panel so CSS
  // can gate mode-specific chrome — checkboxes only visible in
  // select/delete, sel-chip + bulk-delete only in select, etc. Mode
  // value comes from data-sp-mode-value on the button.
  window.spSetMode = function (btn) {
    if (!btn) return;
    var bar = btn.closest(".rp-rt-toolbar") || document;
    var panel = btn.closest(".rp-rt-panel");
    var wasActive = btn.classList.contains("is-active");
    var mode = btn.getAttribute("data-sp-mode-value") || "";
    // Delete + an existing selection = batch delete. Clicking the
    // trash with rows already checked IS the delete action — no
    // separate "delete selected" button. Doesn't enter delete mode
    // (the user's intent is "remove these now"); stays in whatever
    // mode they came from so the chip recounts to 0 and they can keep
    // selecting. Pager total decrements; the action is pushed to the
    // undo stack so the header's Undo button can reverse it. Rows
    // are hidden (display:none via .is-removed) rather than removed
    // from the DOM so undo can resurrect them in-place.
    if (mode === "delete" && !wasActive && panel) {
      // Pull selection from whichever table is currently painted —
      // file CSV when a file tab is active, Overview file list when
      // Overview is active. The other body's hidden rows are ignored.
      var delBase = _activeTableSel(panel);
      var sel = panel.querySelectorAll(delBase + " tbody tr.rp-rt-row-sel");
      if (sel.length > 0) {
        var rowsArr = Array.prototype.slice.call(sel);
        rowsArr.forEach(function (r) {
          r.classList.add("is-removing");
          setTimeout(function () {
            r.classList.add("is-removed");
            // Clear selection state so the chip + master CB recount
            // correctly; undo restores visibility, not selection.
            r.classList.remove("rp-rt-row-sel");
            var cb = r.querySelector('input[type="checkbox"]');
            if (cb) cb.checked = false;
          }, 180);
        });
        // Pager belongs to the file table only — null when deleting
        // on Overview so we don't corrupt the CSV's total count.
        // _spSetPagerTotal + the undo branch both no-op on null.
        var pager = panel.classList.contains("is-overview-active")
          ? null
          : panel.querySelector(".rp-rt-pager");
        var prevTotal = pager
          ? (parseInt(pager.getAttribute("data-total"), 10) || 0)
          : 0;
        var nextTotal = pager
          ? Math.max(0, prevTotal - rowsArr.length)
          : 0;
        if (pager) _spSetPagerTotal(pager, nextTotal);
        setTimeout(function () { _updateSelCount(panel); }, 200);
        window.spPushUndo(panel, {
          type:      "deleteRows",
          rows:      rowsArr,
          pager:     pager,
          prevTotal: prevTotal,
          nextTotal: nextTotal,
        });
        return;
      }
    }
    bar.querySelectorAll("[data-sp-mode]").forEach(function (b) {
      b.classList.remove("is-active");
      b.setAttribute("aria-pressed", "false");
    });
    if (panel) {
      panel.classList.remove("is-mode-edit", "is-mode-select", "is-mode-delete");
    }
    if (!wasActive) {
      btn.classList.add("is-active");
      btn.setAttribute("aria-pressed", "true");
      if (panel && mode) panel.classList.add("is-mode-" + mode);
    }
    // Edit mode flips contenteditable on editable cells. On a File
    // object only the name is editable, so only .rp-rt-ov-name (in
    // the Overview file list) opts in. Off-mode resets to "false"
    // so the cells go back to plain text + the row's click-to-open
    // behaviour resumes.
    var on = panel
      && !wasActive
      && (mode === "edit");
    if (panel) {
      panel.querySelectorAll(".rp-rt-ov-name").forEach(function (el) {
        el.setAttribute("contenteditable", on ? "true" : "false");
      });
      // File tab labels — same logic: each file tab represents a File
      // object whose only editable field is its name. Overview tab
      // (data-is-overview) is excluded since it isn't a file.
      panel.querySelectorAll(".rp-rtp-tab:not([data-is-overview]) .rp-rtp-tab-name")
        .forEach(function (el) {
          el.setAttribute("contenteditable", on ? "true" : "false");
        });
      // Header title — the file name on the right of the H2 mirrors
      // what's in the active tab + the Overview row. Editing it is
      // the same File-object name edit. Project name on the left is
      // not in this set.
      panel.querySelectorAll(".rp-rt-title-fname").forEach(function (el) {
        el.setAttribute("contenteditable", on ? "true" : "false");
      });
      // CSV data cells — each row is a Record object whose values
      // are user-mutable. All data columns opt in; the row-number
      // gutter and the mode-checkbox col (first td) stay non-editable
      // because they're table chrome, not record fields.
      //
      // SKIPPED on the Objects page (detected via the per-type
      // [data-object-type] wrapper). Objects has a column-level
      // `edit` spec — each row is a heterogeneous object, not a
      // homogeneous record, so most cells (badges, counts, dates,
      // computed values) shouldn't be free-text editable. Per-cell
      // ondblclick="objectsCellEdit(this)" handles the editable
      // subset; this avoids the live-app diff where typing into a
      // badge cell looks like a save but goes nowhere.
      var isObjectsPanel = !!panel.querySelector("[data-object-type]");
      if (!isObjectsPanel) {
        panel.querySelectorAll(
          ".rp-rt-table-wrap .rp-rt-table tbody td:not(.rp-rt-rownum-td):not(:first-child)"
        ).forEach(function (el) {
          el.setAttribute("contenteditable", on ? "true" : "false");
        });
      }
    }
  };

  // Row selection — Select-mode only. Toggles .rp-rt-row-sel on the
  // clicked row, syncs its checkbox, and re-counts the selected rows
  // for the toolbar's sel-chip. No-op when select mode isn't active
  // so the table cells still respond to dblclick / row-click in
  // future modes.
  window.spToggleRowSel = function (row) {
    if (!row) return;
    var panel = row.closest(".rp-rt-panel");
    if (!panel) return;
    // Delete mode without a prior selection — click any row to drop
    // it. The single-row path shares spDeleteRow's animation + undo
    // wiring with batch delete, so Undo restores the row the same
    // way regardless of how it was removed.
    if (panel.classList.contains("is-mode-delete")) {
      window.spDeleteRow(row);
      return;
    }
    if (!panel.classList.contains("is-mode-select")) return;
    row.classList.toggle("rp-rt-row-sel");
    var cb = row.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = row.classList.contains("rp-rt-row-sel");
    _updateSelCount(panel);
  };

  // Master trash — analogue of the master checkbox. Clicking it in
  // delete mode wipes every visible row in the active view (file
  // table page or Overview file list). One undo entry covers the
  // whole batch so a single Ctrl+Z brings them all back.
  window.spDeleteAllRows = function (icon) {
    if (!icon) return;
    var panel = icon.closest(".rp-rt-panel");
    if (!panel || !panel.classList.contains("is-mode-delete")) return;
    var base = _activeTableSel(panel);
    var rows = panel.querySelectorAll(base + " tbody tr:not(.is-removed)");
    if (!rows.length) return;
    var rowsArr = Array.prototype.slice.call(rows);
    rowsArr.forEach(function (r) {
      r.classList.add("is-removing");
      setTimeout(function () {
        r.classList.add("is-removed");
        r.classList.remove("rp-rt-row-sel");
        var cb = r.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = false;
      }, 180);
    });
    var pager = panel.classList.contains("is-overview-active")
      ? null
      : panel.querySelector(".rp-rt-pager");
    var prevTotal = pager
      ? (parseInt(pager.getAttribute("data-total"), 10) || 0)
      : 0;
    var nextTotal = pager ? Math.max(0, prevTotal - rowsArr.length) : 0;
    if (pager) _spSetPagerTotal(pager, nextTotal);
    setTimeout(function () { _updateSelCount(panel); }, 200);
    window.spPushUndo(panel, {
      type:      "deleteRows",
      rows:      rowsArr,
      pager:     pager,
      prevTotal: prevTotal,
      nextTotal: nextTotal,
    });
  };

  // Single-row delete — same animation + undo entry as batch delete,
  // just one row. Used by delete mode's row-click path. Pager only
  // updates when deleting on the file table (Overview has no pager).
  window.spDeleteRow = function (row) {
    if (!row) return;
    var panel = row.closest(".rp-rt-panel");
    if (!panel) return;
    var rowsArr = [row];
    row.classList.add("is-removing");
    setTimeout(function () {
      row.classList.add("is-removed");
      row.classList.remove("rp-rt-row-sel");
      var cb = row.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = false;
    }, 180);
    var pager = panel.classList.contains("is-overview-active")
      ? null
      : panel.querySelector(".rp-rt-pager");
    var prevTotal = pager
      ? (parseInt(pager.getAttribute("data-total"), 10) || 0)
      : 0;
    var nextTotal = pager ? Math.max(0, prevTotal - 1) : 0;
    if (pager) _spSetPagerTotal(pager, nextTotal);
    setTimeout(function () { _updateSelCount(panel); }, 200);
    window.spPushUndo(panel, {
      type:      "deleteRows",
      rows:      rowsArr,
      pager:     pager,
      prevTotal: prevTotal,
      nextTotal: nextTotal,
    });
  };
  // Scope helper — whichever body is currently painted (overview when
  // .is-overview-active is on the panel, file table otherwise). The
  // inactive table's rows stay in the DOM, so we filter by wrapper
  // class instead of doing :visible queries.
  function _activeTableSel(panel) {
    return panel.classList.contains("is-overview-active")
      ? ".rp-rt-overview-wrap .rp-rt-table"
      : ".rp-rt-table-wrap .rp-rt-table";
  }
  function _updateSelCount(panel) {
    var base = _activeTableSel(panel);
    var rows = panel.querySelectorAll(base + " tbody tr");
    var sel  = panel.querySelectorAll(base + " tbody tr.rp-rt-row-sel");
    var n    = sel.length;
    var chip = panel.querySelector(".rp-rt-sel-chip");
    if (chip) {
      chip.setAttribute("data-count", n);
      chip.innerHTML = '<i class="bi bi-check2-square"></i> ' + n + ' selected';
    }
    // Master header checkbox state — checked when ALL rows are picked,
    // indeterminate while some are, unchecked when none. Browsers
    // paint the indeterminate state as a small dash, distinct from
    // both fully on + fully off.
    var headerCb = panel.querySelector(base + ' thead input[type="checkbox"]');
    if (headerCb && rows.length) {
      headerCb.checked       = (n === rows.length);
      headerCb.indeterminate = (n > 0 && n < rows.length);
    }
  }

  // Master checkbox in the table head — toggles every body row in
  // one click. The intent is computed from the CURRENT row-selection
  // state, not from headerCb.checked after the browser flipped it:
  //   • all rows already selected → deselect everything
  //   • otherwise (none OR partial)  → select everything
  // This way an indeterminate master always resolves to "select all"
  // on click, which matches the user's mental model and dodges
  // cross-browser quirks where clicking an indeterminate checkbox
  // makes the post-click .checked value unreliable.
  window.spSelectAllRows = function (headerCb) {
    if (!headerCb) return;
    var panel = headerCb.closest(".rp-rt-panel");
    if (!panel) return;
    // Scope to the currently-visible body (overview or file table)
    // so toggling the master in one view doesn't sweep rows in the
    // other (which would silently mark hidden rows as selected).
    var base = _activeTableSel(panel);
    var rows = panel.querySelectorAll(base + " tbody tr");
    var sel  = panel.querySelectorAll(base + " tbody tr.rp-rt-row-sel");
    var on   = (sel.length !== rows.length);
    rows.forEach(function (row) {
      row.classList.toggle("rp-rt-row-sel", on);
      var cb = row.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = on;
    });
    headerCb.checked       = on;
    headerCb.indeterminate = false;
    _updateSelCount(panel);
  };

  // ── Tab activation — single-active among sibling tabs ─────────
  // Used by both .rp-rt-proj-tab and .rp-rtp-tab. Walks the clicked
  // tab's siblings sharing the same class, clears their .active, then
  // sets .active on the clicked one. CSS transitions on the tab's
  // background / color / box-shadow handle the visual switch.
  function _tabMarker(tab) {
    return tab.classList.contains("rp-rt-proj-tab") ? "rp-rt-proj-tab"
         : tab.classList.contains("rp-rtp-tab")     ? "rp-rtp-tab"
         : null;
  }
  window.spActivateTab = function (btn) {
    if (!btn) return;
    var marker = _tabMarker(btn);
    if (!marker) return;
    // In edit mode, clicking a file tab (other than Overview) focuses
    // the editable name instead of switching tabs — same pattern as
    // the Overview's name cell. Clicks land at end of the current
    // name so the user can keep typing. Project tabs are unaffected
    // (the feature scopes to File objects, not projects).
    if (marker === "rp-rtp-tab" && !btn.hasAttribute("data-is-overview")) {
      var pPanel = btn.closest(".rp-rt-panel");
      if (pPanel && pPanel.classList.contains("is-mode-edit")) {
        var nm = btn.querySelector(".rp-rtp-tab-name");
        if (nm) {
          nm.focus();
          var rng = document.createRange();
          rng.selectNodeContents(nm);
          rng.collapse(false);
          var sl = window.getSelection();
          sl.removeAllRanges();
          sl.addRange(rng);
        }
        return;
      }
    }
    var parent = btn.parentElement;
    if (!parent) return;
    parent.querySelectorAll("." + marker).forEach(function (t) {
      t.classList.remove("active");
    });
    btn.classList.add("active");
    // File-tab activation also drives an `.is-overview-active` flag on
    // the panel — Overview tab is project-scope, so the file-scoped
    // chrome (cleanness bar, Save button, etc.) hides while it's the
    // active tab. data-is-overview marks the Overview tab in markup.
    if (marker === "rp-rtp-tab") {
      var panel = btn.closest(".rp-rt-panel");
      if (panel) {
        panel.classList.toggle("is-overview-active", btn.hasAttribute("data-is-overview"));
      }
      // Drive the cleanness widget — label switches between "File
      // cleanness" (file tab active, value = that tab's data-cleanness)
      // and "Project cleanness" (Overview active, value computed on the
      // fly as the mean of the sibling file tabs' data-cleanness so
      // it stays in sync if files are added or removed). Widget lives
      // in the same [data-project] block as the tab.
      var projBlock = btn.closest("[data-project]");
      var overall = projBlock && projBlock.querySelector(".rp-rtp-overall");
      var isOv = btn.hasAttribute("data-is-overview");
      var pct = null;
      if (isOv) {
        var strip = btn.closest(".rp-rtp-tabs-inner");
        var fileTabs = strip
          ? strip.querySelectorAll(".rp-rtp-tab:not([data-is-overview])[data-cleanness]")
          : [];
        var sum = 0, n = 0;
        fileTabs.forEach(function (t) {
          var v = parseFloat(t.getAttribute("data-cleanness"));
          if (!isNaN(v)) { sum += v; n++; }
        });
        if (n) pct = Math.round(sum / n);
      } else {
        pct = btn.getAttribute("data-cleanness");
      }
      if (overall && pct !== null) {
        var lbl  = overall.querySelector(".rp-rtp-overall-lbl");
        var fill = overall.querySelector(".rp-rtp-overall-fill");
        var pctE = overall.querySelector(".rp-rtp-overall-pct");
        if (lbl)  lbl.textContent  = isOv ? "Project cleanness" : "File cleanness";
        if (fill) fill.style.width = pct + "%";
        if (pctE) pctE.textContent = pct + "%";
      }
    }
    // Project-tab activation swaps the per-project chrome blocks. Each
    // tab carries data-sp-project-key matching a sibling
    // [data-project="<key>"] wrapper inside the panel (header +
    // file-tabs + table all use the same key). Toggle `hidden` so the
    // inactive project is fully out of layout — no overlap, no double-
    // included tables fighting for the same scroll container.
    if (marker === "rp-rt-proj-tab") {
      var projKey = btn.getAttribute("data-sp-project-key");
      var ppanel = btn.closest(".rp-rt-panel");
      if (projKey && ppanel) {
        ppanel.querySelectorAll("[data-project]").forEach(function (b) {
          b.hidden = (b.getAttribute("data-project") !== projKey);
        });
        // Objects page uses [data-object-type] wrappers instead of
        // [data-project]. The two are mutually exclusive in practice
        // (cleaner has the first, objects has the second), so toggling
        // both is safe — the no-match side is a no-op.
        ppanel.querySelectorAll("[data-object-type]").forEach(function (b) {
          b.hidden = (b.getAttribute("data-object-type") !== projKey);
        });
      }
    }
  };

  // ── Objects page customizable tab strip ───────────────────────────
  // State-driven; mirrors frontend/scripts/pages/objects.js in the
  // live app. The DOM under #obj-tabs is throw-away — spRenderObjectTabs
  // rebuilds it from spObjectTabs (ordered array of visible keys) on
  // every add / remove / drop / activate. Persistence stand-in is
  // localStorage (the live app PATCHes /api/me with prefs.objects_tabs).

  // Catalog of all object types the app knows about. Shared with any
  // future Profile-Settings "Object tabs" picker, exactly like the
  // live app's objects-catalog.js.
  window.OBJECT_TAB_CATALOG = [
    { key: "projects",   label: "Projects",   icon: "bi-folder2" },
    { key: "files",      label: "Files",      icon: "bi-file-earmark-text" },
    { key: "reports",    label: "Reports",    icon: "bi-bar-chart-line" },
    { key: "dashboards", label: "Dashboards", icon: "bi-layout-wtf" },
    { key: "companies",  label: "Companies",  icon: "bi-buildings" },
    { key: "users",      label: "Users",      icon: "bi-people" },
  ];
  var OBJECT_TAB_KEYS = window.OBJECT_TAB_CATALOG.map(function (c) { return c.key; });
  var OBJECT_TABS_LS_KEY = "rp-objects-tabs";

  // Live ordered list of visible tabs. Source of truth. Defaults to
  // every catalog key (catalog order) when localStorage is empty.
  window.spObjectTabs = OBJECT_TAB_KEYS.slice();
  var _spActiveObjectKey = window.spObjectTabs[0];
  var _spObjectTabsLoaded = false;

  // Drop unknown keys (catalog may have shrunk), de-dupe, preserve user
  // order. Empty result falls back to the full catalog. Direct port of
  // the live app's normalizeObjectTabs.
  function _spNormalizeObjectTabs(raw) {
    if (Array.isArray(raw)) {
      var seen = {};
      var valid = [];
      raw.forEach(function (k) {
        if (OBJECT_TAB_KEYS.indexOf(k) !== -1 && !seen[k]) {
          seen[k] = true;
          valid.push(k);
        }
      });
      if (valid.length) return valid;
    }
    return OBJECT_TAB_KEYS.slice();
  }
  function _spLoadObjectTabs() {
    // When the live app has pre-seeded spObjectTabs from server-side
    // prefs (objects.js sets window.spObjectTabsFromPrefs before
    // rpInclude → spInit fires), trust that and skip the localStorage
    // read. The localStorage store is the sandbox-only fallback and
    // goes stale the moment the user drags pills on the Profile
    // /Settings page (which writes prefs, not localStorage).
    if (window.spObjectTabsFromPrefs && Array.isArray(window.spObjectTabs)) {
      if (window.spObjectTabs.indexOf(_spActiveObjectKey) === -1) {
        _spActiveObjectKey = window.spObjectTabs[0];
      }
      return;
    }
    var raw = null;
    try {
      var s = localStorage.getItem(OBJECT_TABS_LS_KEY);
      if (s) raw = JSON.parse(s);
    } catch (_) {}
    window.spObjectTabs = _spNormalizeObjectTabs(raw);
    if (window.spObjectTabs.indexOf(_spActiveObjectKey) === -1) {
      _spActiveObjectKey = window.spObjectTabs[0];
    }
  }
  // Persist the current tab order. When the live app is loaded, route
  // through rpSavePref so the user's account (and in-memory session)
  // sees the same array Profile/Settings reads from. localStorage is
  // a fallback for the standalone sandbox where rpSavePref isn't
  // defined. Either path also fires window.objOnTabsChanged so the
  // live objects.js module can mirror its own `objTabs` reference and
  // stay aligned with the sandbox state.
  function _spSaveObjectTabs() {
    var snapshot = window.spObjectTabs.slice();
    if (typeof window.rpSavePref === "function") {
      window.rpSavePref("objects_tabs", snapshot);
    } else {
      try {
        localStorage.setItem(OBJECT_TABS_LS_KEY, JSON.stringify(snapshot));
      } catch (_) {}
    }
    if (typeof window.objOnTabsChanged === "function") {
      try { window.objOnTabsChanged(snapshot); } catch (_) {}
    }
  }

  // Render the strip from spObjectTabs. Each tab carries inline drag
  // handlers (sp{Start,Over,Leave,End,Drop}ObjectTab) — the array
  // mutation + re-render flow stays single-source-of-truth (no
  // DOM-to-array sync needed). Min-1: when there's only one tab, the
  // × is omitted entirely so the user can't end up with zero tabs.
  window.spRenderObjectTabs = function (root) {
    var host = (root || document).querySelector("#obj-tabs");
    if (!host) return;
    var canRemove = window.spObjectTabs.length > 1;
    var html = "";
    window.spObjectTabs.forEach(function (key) {
      var entry = _spCatalogEntry(key);
      if (!entry) return;
      var isActive = key === _spActiveObjectKey;
      html +=
          '<button class="rp-rt-proj-tab' + (isActive ? ' active' : '') + '" type="button"'
        + ' data-sp-project-key="' + entry.key + '"'
        + ' draggable="true"'
        + ' onclick="spActivateObjectType(\'' + entry.key + '\')"'
        + ' ondragstart="spStartObjectTabDrag(event)"'
        + ' ondragover="spOverObjectTabDrag(event)"'
        + ' ondragleave="spLeaveObjectTabDrag(event)"'
        + ' ondrop="spDropObjectTab(event)"'
        + ' ondragend="spEndObjectTabDrag(event)">'
        +   '<i class="bi ' + entry.icon + '"></i>'
        +   '<span class="rp-rt-proj-tab-name">' + entry.label + '</span>'
        +   (canRemove
              ? '<span class="rp-rt-proj-tab-x" title="Remove tab"'
              + ' onclick="event.stopPropagation();spRemoveObjectTab(\'' + entry.key + '\')">'
              +    '<i class="bi bi-x"></i>'
              + '</span>'
              : "")
        + '</button>';
    });
    // Trailing + with hidden dropdown — uses the file-tabs add-menu class
    // system (rp-tab-add-*) since the project-tabs + was retired to
    // a modal. Disabled when every catalog type is already visible.
    var hiddenTypes = window.OBJECT_TAB_CATALOG.filter(function (c) {
      return window.spObjectTabs.indexOf(c.key) === -1;
    });
    var menuItems = hiddenTypes.length
      ? hiddenTypes.map(function (c) {
          return '<div class="rp-tab-add-item"'
               + ' onclick="event.stopPropagation();spAddObjectTab(\'' + c.key + '\')">'
               +   '<i class="bi ' + c.icon + '"></i>' + c.label
               + '</div>';
        }).join("")
      : '<div class="rp-form-meta" style="padding:0.5rem;font-style:italic">'
      +   'All object types are already shown.'
      + '</div>';
    html +=
        '<span class="rp-tab-add-wrap">'
      +   '<button class="rp-tab-add" type="button"'
      +     ' aria-label="Add object type" title="Add hidden type back"'
      +     (hiddenTypes.length ? ' onclick="spToggleTabAddMenu(this)"' : ' disabled')
      +     '>'
      +     '<i class="bi bi-plus-lg"></i>'
      +   '</button>'
      +   '<div class="rp-tab-add-menu" role="menu">'
      +     '<div class="rp-tab-add-hdr">Hidden object types</div>'
      +     '<div class="rp-tab-add-items">' + menuItems + '</div>'
      +   '</div>'
      + '</span>';
    host.innerHTML = html;
  };
  function _spCatalogEntry(key) {
    for (var i = 0; i < window.OBJECT_TAB_CATALOG.length; i++) {
      if (window.OBJECT_TAB_CATALOG[i].key === key) return window.OBJECT_TAB_CATALOG[i];
    }
    return null;
  }

  // Activate an object tab + swap the matching [data-object-type]
  // wrappers (header + table). Accepts a key string OR a button element
  // (back-compat with the old inline onclick="spActivateObjectType(this)"
  // markup, in case any partial still uses it).
  window.spActivateObjectType = function (kindOrBtn) {
    var key = (typeof kindOrBtn === "string")
      ? kindOrBtn
      : (kindOrBtn && kindOrBtn.getAttribute && kindOrBtn.getAttribute("data-sp-project-key"));
    if (!key) return;
    // Stale deep-link guard — fall back to the first visible tab if the
    // requested key isn't currently in the strip.
    if (window.spObjectTabs.indexOf(key) === -1) {
      key = window.spObjectTabs[0];
      if (!key) return;
    }
    _spActiveObjectKey = key;
    window.spRenderObjectTabs(document);
    document.querySelectorAll("[data-object-type]").forEach(function (el) {
      el.hidden = el.getAttribute("data-object-type") !== key;
    });
  };

  // Add a hidden type back as a tab and switch to it. De-dupes silently.
  window.spAddObjectTab = function (kind) {
    if (!kind || OBJECT_TAB_KEYS.indexOf(kind) === -1) return;
    if (window.spObjectTabs.indexOf(kind) !== -1) return;
    window.spObjectTabs.push(kind);
    _spSaveObjectTabs();
    // Close the add menu before re-render (the menu is part of the
    // throw-away DOM, so closing avoids a visible flash).
    document.querySelectorAll(".rp-tab-add-menu.open").forEach(function (m) {
      m.classList.remove("open");
    });
    window.spActivateObjectType(kind);
  };

  // Remove a tab from the strip. Min-1 — refuses the last one. If
  // the active tab is removed, the nearest neighbour becomes active.
  window.spRemoveObjectTab = function (kind) {
    var idx = window.spObjectTabs.indexOf(kind);
    if (idx === -1 || window.spObjectTabs.length <= 1) return;
    window.spObjectTabs.splice(idx, 1);
    _spSaveObjectTabs();
    if (_spActiveObjectKey === kind) {
      var nextIdx = Math.min(idx, window.spObjectTabs.length - 1);
      window.spActivateObjectType(window.spObjectTabs[nextIdx]);
    } else {
      window.spRenderObjectTabs(document);
    }
  };

  // ── Object-tab drag handlers. Source/target classes (.is-drag /
  // .is-drop) drive the visual cues. Drop splices spObjectTabs
  // (source inserted BEFORE target), persists, re-renders. No
  // fallback to _bindDragReorder — object tabs own their drag flow
  // so the array stays the single source of truth.
  var _spDragObjectKey = null;
  window.spStartObjectTabDrag = function (e) {
    var tab = e.currentTarget;
    _spDragObjectKey = tab && tab.getAttribute("data-sp-project-key");
    if (!_spDragObjectKey) return;
    try { e.dataTransfer.effectAllowed = "move"; } catch (_) {}
    try { e.dataTransfer.setData("text/plain", _spDragObjectKey); } catch (_) {}
    tab.classList.add("is-drag");
  };
  window.spOverObjectTabDrag = function (e) {
    if (!_spDragObjectKey) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "move"; } catch (_) {}
    var tab = e.currentTarget;
    if (tab && tab.getAttribute("data-sp-project-key") !== _spDragObjectKey) {
      tab.classList.add("is-drop");
    }
  };
  window.spLeaveObjectTabDrag = function (e) {
    if (e.currentTarget) e.currentTarget.classList.remove("is-drop");
  };
  window.spEndObjectTabDrag = function () {
    document.querySelectorAll(".rp-rt-proj-tab.is-drag, .rp-rt-proj-tab.is-drop")
      .forEach(function (t) { t.classList.remove("is-drag", "is-drop"); });
    _spDragObjectKey = null;
  };
  window.spDropObjectTab = function (e) {
    e.preventDefault();
    var target = e.currentTarget && e.currentTarget.getAttribute("data-sp-project-key");
    var source = _spDragObjectKey;
    window.spEndObjectTabDrag();
    if (!source || !target || source === target) return;
    var from = window.spObjectTabs.indexOf(source);
    if (from < 0) return;
    window.spObjectTabs.splice(from, 1);
    var insertAt = window.spObjectTabs.indexOf(target);
    if (insertAt < 0) return;
    window.spObjectTabs.splice(insertAt, 0, source);
    _spSaveObjectTabs();
    window.spRenderObjectTabs(document);
  };

  // Init hook — called from spInit on every mount. Loads the saved
  // tab set on first sight of the #obj-tabs container, then renders.
  // Idempotent via _spObjectTabsLoaded flag.
  function _spInitObjectTabs(root) {
    var host = (root || document).querySelector("#obj-tabs");
    if (!host) return;
    if (!_spObjectTabsLoaded) {
      _spLoadObjectTabs();
      _spObjectTabsLoaded = true;
    }
    window.spRenderObjectTabs(document);
    // Sync the visible [data-object-type] wrapper with the active key.
    document.querySelectorAll("[data-object-type]").forEach(function (el) {
      el.hidden = el.getAttribute("data-object-type") !== _spActiveObjectKey;
    });
  }

  // Remove a tab (animated). Called from the inline × button:
  // `<span class="rp-rt-proj-tab-x" onclick="event.stopPropagation();
  //   spDeleteTab(this)">…</span>`. The × stops propagation so the
  // click doesn't also fire spActivateTab on the parent tab. If the
  // tab being removed was active, we activate the next or previous
  // sibling (same class) so the strip never lands in a no-active
  // state. The 180ms timeout matches the .is-removing CSS transition.
  window.spDeleteTab = function (xEl) {
    if (!xEl) return;
    var tab = xEl.closest(".rp-rt-proj-tab, .rp-rtp-tab");
    if (!tab) return;
    var marker = _tabMarker(tab);
    if (!marker) return;
    var siblings = Array.prototype.slice.call(
      tab.parentElement.querySelectorAll("." + marker),
    );
    var i = siblings.indexOf(tab);
    var wasActive = tab.classList.contains("active");
    var nextActive = wasActive ? (siblings[i + 1] || siblings[i - 1] || null) : null;
    tab.classList.add("is-removing");
    setTimeout(function () {
      tab.remove();
      if (nextActive) window.spActivateTab(nextActive);
    }, 180);
  };

  // Position an add-menu against its trigger wrap. Only the objects-page
  // tab strip uses the inline dropdown (.rp-tab-add-menu) — the cleaner
  // project + and file + both open rp-modals (no positional math).
  // Pins the menu's right edge to the trigger's right edge, top just
  // below. Pixel math is unavoidable because getBoundingClientRect
  // returns viewport pixels — the no-px CSS discipline doesn't apply
  // to JS-computed coords.
  function _positionAddMenu(wrap, menu) {
    var r = wrap.getBoundingClientRect();
    menu.style.top   = (r.bottom + 4) + "px";
    menu.style.right = (window.innerWidth - r.right) + "px";
    menu.style.left  = "auto";
  }

  // File-tab counterpart to spAddProjectTab. Inserts a fresh tab into
  // the active project's file strip; called from open-file.html's pick
  // cards via `spAddFileTab(this, "<filename>")` then `closeModal`.
  // De-dupes — picking an already-open file just activates that tab.
  window.spAddFileTab = function (trigger, name) {
    var strip = trigger.closest(".rp-rtp-tabs-inner")
             || document.querySelector(".rp-rtp-tabs-inner");
    if (!strip) return;
    var addWrap = strip.querySelector(".rp-tab-add-wrap");
    var existing = strip.querySelectorAll(".rp-rtp-tab");
    var label = (name || "").trim()
             || ("new_file_" + (existing.length + 1) + ".csv");
    var dupe = null;
    existing.forEach(function (t) {
      var n = t.querySelector(".rp-rtp-tab-name");
      if (n && n.textContent.trim() === label) dupe = t;
    });
    var menu = strip.querySelector(".rp-tab-add-menu.open");
    if (menu) menu.classList.remove("open");
    if (dupe) { window.spActivateTab(dupe); return; }
    var tab = document.createElement("button");
    tab.type = "button";
    tab.className = "rp-rtp-tab is-entering";
    tab.setAttribute("onclick", "spActivateTab(this)");
    tab.innerHTML =
        '<i class="bi bi-file-earmark-text"></i>'
      + '<span class="rp-rtp-tab-name"></span>'
      + '<span class="rp-rtp-tab-x" title="Close"'
      + ' onclick="event.stopPropagation();spDeleteTab(this)">'
      +   '<i class="bi bi-x"></i>'
      + '</span>';
    tab.querySelector(".rp-rtp-tab-name").textContent = label;
    strip.insertBefore(tab, addWrap);
    void tab.offsetWidth;
    requestAnimationFrame(function () {
      tab.classList.remove("is-entering");
      window.spActivateTab(tab);
    });
  };
  window.spAddFileFromInput = function (input) {
    if (!input) return;
    var name = (input.value || "").trim();
    if (!name) return;
    window.spAddFileTab(input, name);
    input.value = "";
    input.blur();
  };

  // Toggle the tab-strip + picker dropdown. Only the objects-page
  // tab strip uses the inline dropdown form (cleaner project + and
  // file + both open rp-modals). Click-only — no hover-open. Closes
  // any other open add-menu so only one is on-screen at a time.
  window.spToggleTabAddMenu = function (btn) {
    var wrap = btn.closest(".rp-tab-add-wrap");
    var menu = wrap && wrap.querySelector(".rp-tab-add-menu");
    if (!menu) return;
    document.querySelectorAll(".rp-tab-add-menu.open").forEach(function (m) {
      if (m !== menu) m.classList.remove("open");
    });
    if (!menu.classList.contains("open")) _positionAddMenu(wrap, menu);
    menu.classList.toggle("open");
  };

  // ── Generic toolbar dropdown (.rp-dd-*) ──────────────────────────
  // Click-to-toggle for mid-strip controls (rows-per-page, columns,
  // future date-format, etc.). Centred-under-trigger positioning —
  // the tab-end pickers (proj/file +) stay right-anchored via their
  // own helpers. Outside-click closer dismisses; scroll on the
  // strip closes (so coords don't go stale).
  function _positionDdCenter(trigger, menu) {
    var r = trigger.getBoundingClientRect();
    var mw = menu.offsetWidth || 0;
    // Clamp so the menu never spills off-screen — if the centred
    // edge would clip, slide it in just enough to fit. 8px gutter.
    var left = Math.max(8, Math.min(window.innerWidth - mw - 8,
                                     r.left + r.width / 2 - mw / 2));
    menu.style.top   = (r.bottom + 4) + "px";
    menu.style.left  = left + "px";
    menu.style.right = "auto";
  }
  window.spDdToggle = function (btn) {
    var wrap = btn.closest(".rp-dd-wrap");
    var menu = wrap && wrap.querySelector(".rp-dd-menu");
    if (!menu) return;
    // Close any other open .rp-dd-menu (single-active among generics).
    document.querySelectorAll(".rp-dd-menu.open").forEach(function (m) {
      if (m !== menu) m.classList.remove("open");
    });
    if (!menu.classList.contains("open")) _positionDdCenter(wrap, menu);
    menu.classList.toggle("open");
  };

  // Hover-open with a 180ms grace timer for the generic .rp-dd-wrap
  // dropdowns (rows-per-page, columns picker). Mirrors the proj/file
  // add-menu pattern: pointer can cross the gap from trigger to menu
  // without the menu closing. Click toggle stays as the touch /
  // keyboard fallback. dataset guard prevents double-binding when
  // spInit re-runs after include.js mounts a fresh fragment.
  function _bindDdHover(root) {
    (root || document).querySelectorAll(".rp-dd-wrap").forEach(function (wrap) {
      if (wrap.dataset.spDdHoverBound) return;
      wrap.dataset.spDdHoverBound = "1";
      var trigger = wrap.querySelector("button");
      var menu = wrap.querySelector(".rp-dd-menu");
      if (!trigger || !menu) return;
      var timer = null;
      var open  = function () {
        if (timer) { clearTimeout(timer); timer = null; }
        // Close other open dd menus so only one paints at a time.
        document.querySelectorAll(".rp-dd-menu.open").forEach(function (m) {
          if (m !== menu) m.classList.remove("open");
        });
        if (!menu.classList.contains("open")) _positionDdCenter(wrap, menu);
        menu.classList.add("open");
      };
      var close = function () {
        timer = setTimeout(function () {
          menu.classList.remove("open"); timer = null;
        }, 180);
      };
      wrap.addEventListener("mouseenter", open);
      wrap.addEventListener("mouseleave", close);
      menu.addEventListener("mouseenter", open);
      menu.addEventListener("mouseleave", close);
    });
  }

  // Switch the visible table tbody — pager buttons call this with
  // their page number. Hides every other [data-page] tbody, paints
  // the active page button, and updates the "X–Y of N" rows-info.
  // For the mockup all rows are pre-rendered in N tbodies; the
  // live app would refetch + repaint per-page instead.
  window.spGoToPage = function (btn, page) {
    if (!btn) return;
    var wrap = btn.closest(".rp-rt-table-wrap, .rp-rt-body, .rp-rt-panel");
    var table = wrap && wrap.querySelector(".rp-rt-table");
    if (!table) return;
    table.querySelectorAll("tbody[data-page]").forEach(function (t) {
      t.hidden = (String(t.dataset.page) !== String(page));
    });
    var pager = btn.closest(".rp-rt-pager");
    if (pager) {
      pager.querySelectorAll(".rp-rt-pg").forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      var info = pager.querySelector(".rp-rt-rows-info");
      var per  = parseInt(pager.getAttribute("data-per-page"),  10) || 50;
      var tot  = parseInt(pager.getAttribute("data-total"),     10) || 0;
      if (info) {
        var start = (page - 1) * per + 1;
        var end   = Math.min(page * per, tot);
        info.textContent = start + "–" + end + " of " + tot;
      }
    }
  };

  // Rows-per-page item click — flips .is-selected to the clicked
  // option and updates the trigger pill's number label. Mockup
  // (no real page reload); the pattern is what graduates to Pass D.
  window.spDdSelectRows = function (item, n) {
    var menu = item.closest(".rp-dd-menu");
    if (menu) {
      menu.querySelectorAll(".rp-dd-item").forEach(function (i) {
        i.classList.remove("is-selected");
      });
      item.classList.add("is-selected");
    }
    var wrap = item.closest(".rp-dd-wrap");
    var lbl  = wrap && wrap.querySelector("[data-sp-rows-label]");
    if (lbl) lbl.textContent = n;
    if (menu) menu.classList.remove("open");
  };

  // Open-project modal search — filters .rp-pick-card rows by the
  // name text as the user types. Cards with no match are hidden.
  window.spFilterPicks = function (input) {
    var q = input.value.trim().toLowerCase();
    var grid = input.closest(".rp-modal") && input.closest(".rp-modal").querySelector(".rp-pick-grid");
    if (!grid) return;
    grid.querySelectorAll(".rp-pick-card").forEach(function (card) {
      var name = (card.querySelector(".rp-pick-name") || {}).textContent || "";
      card.style.display = (!q || name.toLowerCase().includes(q)) ? "" : "none";
    });
  };

  // ── Theme toggle ─────────────────────────────────────────────
  // The topbar carries a single Sun/Moon button (data-sp-theme-icon)
  // that flips html[data-theme] between light + dark. The early-boot
  // inline script in cleaner.html sets the initial theme from
  // localStorage; this just toggles and re-syncs the icon. Icon
  // shows the CURRENT theme (sun = light, moon = dark) — the
  // destination-icon pattern read backwards and tricked users into
  // thinking they were in the opposite mode.
  // Resolve the effective theme — explicit "dark" / "light" win,
  // "system" (or unset) falls back to prefers-color-scheme. The icon
  // sync and the toggle both need this: with data-theme="system" the
  // rendered theme depends on the OS preference, not the attribute.
  function _resolvedTheme() {
    var cur = document.documentElement.dataset.theme || "light";
    if (cur === "dark" || cur === "light") return cur;
    return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches)
      ? "dark" : "light";
  }

  window.spToggleTheme = function () {
    // Toggle from the EFFECTIVE theme, not the attribute. Starting
    // from "system" with prefers-dark, we want one click to flip to
    // "light" (the visible opposite) — without this the cycle goes
    // system → dark (no visible change if prefers-dark) → light.
    var cur  = _resolvedTheme();
    var next = (cur === "dark") ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("rp-theme", next); } catch (e) {}
    _syncThemeIcon();
  };
  function _syncThemeIcon(root) {
    // Icon shows the CURRENT theme (sun = light, moon = dark) — match
    // it to what's actually rendered, not just the data-theme attribute.
    var to = (_resolvedTheme() === "dark") ? "bi-moon" : "bi-sun";
    (root || document).querySelectorAll("[data-sp-theme-icon]").forEach(function (el) {
      el.className = "bi " + to;
    });
  }

  // Init hook — controls.js exposes spInit so include.js can call it
  // after each fragment lands (fresh DOM nodes need re-binding).
  // Idempotent thanks to the dataset guards inside each binder.
  window.spInit = function (root) {
    _bindDdHover(root);     // hover-open for .rp-dd-wrap generics
    _syncThemeIcon(root);   // sync icon for any newly-included topbar
    _bindDragReorder(root); // cleaner project tabs + column headers
    _spInitObjectTabs(root); // load + render the objects strip from state
    // Undo/redo buttons paint disabled on mount until the user does
    // a reversible action — re-sync per panel found under root.
    (root || document).querySelectorAll(".rp-rt-panel")
      .forEach(_spSyncUndoRedoButtons);
    // Tool-modal preview slots pre-paint at final height so opening
    // + clicking Compute doesn't resize the modal.
    (root || document).querySelectorAll("[data-sp-preview]")
      .forEach(_spFillPreviewPlaceholder);
  };
  document.addEventListener("DOMContentLoaded", function () { window.spInit(); });

  // Add a new project tab (animated). Inserted right before the
  // trailing + button so the strip's add-affordance always stays on
  // the right. If a tab with the same name already exists, activate
  // it instead of duplicating. Called from a picker item in the
  // "Open project" rp-modal (`spAddProjectTab(this, "Project Name")`).
  window.spAddProjectTab = function (trigger, name) {
    var strip = trigger.closest(".rp-rt-proj-tabs-inner")
             || document.querySelector(".rp-rt-proj-tabs-inner");
    if (!strip) return;
    var addWrap = strip.querySelector(".rp-tab-add-wrap");
    var existing = strip.querySelectorAll(".rp-rt-proj-tab");
    var label = (name || "").trim()
             || ("New project " + (existing.length + 1));
    // De-dupe — if a tab with that label is already open, activate it.
    var dupe = null;
    existing.forEach(function (t) {
      var n = t.querySelector(".rp-rt-proj-tab-name");
      if (n && n.textContent.trim() === label) dupe = t;
    });
    if (dupe) { window.spActivateTab(dupe); return; }
    var tab = document.createElement("button");
    tab.type = "button";
    tab.className = "rp-rt-proj-tab is-entering";
    tab.setAttribute("onclick", "spActivateTab(this)");
    tab.innerHTML =
        '<i class="bi bi-folder2-open"></i>'
      + '<span class="rp-rt-proj-tab-name"></span>'
      + '<span class="rp-rt-proj-tab-x" title="Close"'
      + ' onclick="event.stopPropagation();spDeleteTab(this)">'
      +   '<i class="bi bi-x"></i>'
      + '</span>';
    tab.querySelector(".rp-rt-proj-tab-name").textContent = label;
    strip.insertBefore(tab, addWrap);
    void tab.offsetWidth;
    requestAnimationFrame(function () {
      tab.classList.remove("is-entering");
      window.spActivateTab(tab);
    });
  };

  // Click on the file-name CELL of an Overview row. In edit mode this
  // drops the caret into the editable name span — anywhere inside the
  // cell (icon, whitespace, the text itself) works, not just the text.
  // Outside edit mode the click bubbles to the row so the file opens
  // as a tab as usual.
  window.spOvNameCellClick = function (cell, event) {
    if (!cell) return;
    var panel = cell.closest(".rp-rt-panel");
    if (!(panel && panel.classList.contains("is-mode-edit"))) return;
    if (event) event.stopPropagation();
    var span = cell.querySelector(".rp-rt-ov-name");
    if (!span) return;
    span.focus();
    var range = document.createRange();
    range.selectNodeContents(span);
    range.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };

  // Reset the Columns picker to DB order:
  //   1. re-check every checkbox so all columns are visible
  //   2. re-sort every .rp-rt-table back to its original column order
  //      using the data-sp-orig-idx stamps laid down by _bindDragReorder
  //
  // The picker itself is rendered in DB order in the markup and we
  // never reorder it client-side in this mockup, so it doesn't need
  // re-sorting — only visibility + the table do.
  window.spColsReset = function (btn) {
    if (!btn) return;
    var menu = btn.closest(".rp-dd-menu");
    if (menu) {
      menu.querySelectorAll('.rp-dd-checkbox input[type="checkbox"]')
        .forEach(function (cb) { cb.checked = true; });
    }
    document.querySelectorAll(".rp-rt-table").forEach(function (table) {
      var headRow = table.tHead && table.tHead.rows[0];
      if (!headRow) return;
      // Build the desired order: ths sorted by their original idx.
      var ths = Array.prototype.slice.call(headRow.children);
      var sorted = ths.slice().sort(function (a, b) {
        var ai = parseInt(a.dataset.spOrigIdx, 10);
        var bi = parseInt(b.dataset.spOrigIdx, 10);
        if (isNaN(ai)) ai = 0;
        if (isNaN(bi)) bi = 0;
        return ai - bi;
      });
      // Move each th to its sorted position; mirror the move in every
      // body row by tracking the th's CURRENT index before each step.
      sorted.forEach(function (th, targetIdx) {
        var current = Array.prototype.indexOf.call(headRow.children, th);
        if (current === targetIdx) return;
        var refTh = headRow.children[targetIdx] || null;
        headRow.insertBefore(th, refTh);
        Array.prototype.forEach.call(table.tBodies, function (tbody) {
          Array.prototype.forEach.call(tbody.rows, function (tr) {
            if (tr.children.length <= Math.max(current, targetIdx)) return;
            var td = tr.children[current];
            var ref = tr.children[targetIdx] || null;
            if (td) tr.insertBefore(td, ref);
          });
        });
      });
    });
  };

  // Click on an Overview row. Edit mode is handled by the name cell's
  // own onclick (spOvNameCellClick); this row-level handler is a
  // no-op in edit mode so clicks on other cells don't trigger
  // navigation while the user is renaming files.
  //
  // Outside edit mode the click opens the file as a tab: the row's
  // data-file-name matches a .rp-rtp-tab-name in the project's file-
  // tabs strip; scoped by project key so identically-named files
  // across projects don't collide. No-op if no matching tab exists.
  window.spOpenFileFromOverview = function (row) {
    if (!row) return;
    var panel = row.closest(".rp-rt-panel");
    if (panel && panel.classList.contains("is-mode-edit")) return;
    // Select mode on Overview — the row click toggles selection
    // instead of navigating. Same pattern as the file table.
    if (panel && panel.classList.contains("is-mode-select")) {
      window.spToggleRowSel(row);
      return;
    }
    // Delete mode on Overview — click any row to drop it. Same
    // animation + undo entry as batch delete.
    if (panel && panel.classList.contains("is-mode-delete")) {
      window.spDeleteRow(row);
      return;
    }
    var name = row.getAttribute("data-file-name");
    if (!name) return;
    var projBlock = row.closest("[data-project]");
    if (!projBlock) return;
    var key = projBlock.getAttribute("data-project");
    if (!key) return;
    // file-tabs live in a SEPARATE [data-project] block (the header
    // cluster), not this body block — query the document by key.
    var strip = document.querySelector(
      '[data-project="' + key + '"] .rp-rtp-tabs-inner');
    if (!strip) return;
    var tabs = strip.querySelectorAll(".rp-rtp-tab");
    for (var i = 0; i < tabs.length; i++) {
      var lbl = tabs[i].querySelector(".rp-rtp-tab-name");
      if (lbl && lbl.textContent.trim() === name) {
        window.spActivateTab(tabs[i]);
        return;
      }
    }
  };

  // Sync toggle — links search + rows-per-page across the project's
  // file tabs. Flips the button's is-active/aria-pressed AND drops
  // .is-sync-on on the panel so CSS can outline the synced fields
  // (visual indicator of which controls are linked). Live app will
  // observe the same flag to actually propagate value changes
  // across tabs.
  window.spToggleSync = function (btn) {
    if (!btn) return;
    var nowActive = !btn.classList.contains("is-active");
    btn.classList.toggle("is-active", nowActive);
    btn.setAttribute("aria-pressed", nowActive ? "true" : "false");
    var panel = btn.closest(".rp-rt-panel");
    if (panel) panel.classList.toggle("is-sync-on", nowActive);
  };

  // Row-numbers toggle — flips the button's is-active + aria-pressed
  // the same way spToggleActive does, then drops .is-hide-rownums on
  // the panel so CSS can collapse the # gutter column. File table
  // only; the Overview has no rownum column so the rule is a no-op
  // there.
  window.spToggleRowNums = function (btn) {
    if (!btn) return;
    var nowActive = !btn.classList.contains("is-active");
    btn.classList.toggle("is-active", nowActive);
    btn.setAttribute("aria-pressed", nowActive ? "true" : "false");
    var panel = btn.closest(".rp-rt-panel");
    if (panel) panel.classList.toggle("is-hide-rownums", !nowActive);
  };

  // Filter panel — add a fresh predicate row by cloning the first
   // one and clearing its inputs. The form always keeps at least one
   // row (the "scaffold"); see spFbRmPredicate.
  window.spFbAddPredicate = function (btn) {
    if (!btn) return;
    var panel = btn.closest(".rp-rt-filter-panel");
    var rows  = panel && panel.querySelector(".rp-rt-fb-rows");
    var seed  = rows && rows.querySelector(".rp-rt-fb-row");
    if (!rows || !seed) return;
    var clone = seed.cloneNode(true);
    clone.querySelectorAll("input").forEach(function (i) { i.value = ""; });
    clone.querySelectorAll("select").forEach(function (s) { s.selectedIndex = 0; });
    rows.appendChild(clone);
  };

  // Filter panel — remove a predicate row (the row containing the
  // clicked × button). If only one row remains it stays as the empty
  // scaffold; its inputs are cleared instead of disappearing.
  window.spFbRmPredicate = function (btn) {
    if (!btn) return;
    var row = btn.closest(".rp-rt-fb-row");
    if (!row) return;
    var rows = row.parentElement;
    if (rows.querySelectorAll(".rp-rt-fb-row").length <= 1) {
      row.querySelectorAll("input").forEach(function (i) { i.value = ""; });
      row.querySelectorAll("select").forEach(function (s) { s.selectedIndex = 0; });
      return;
    }
    row.remove();
  };

  // ── Demo data + live preview helpers ─────────────────────────────
  // Sentinel CSV columns + a map of distinct values per column so the
  // cleaning-tool modals can render real before/after previews on
  // client-side compute (Polars-WASM in the live app — plain JS here).
  // Lives as constants so previews work offline; the live app pulls
  // from STATE.columns + a /api/files/:rid/distinct endpoint.
  var SP_DEMO_COLS = [
    "Numero_dossier_ID", "Client", "Formule",
    "date.ouverture", "heure.ouverture", "Matricule.de.traitement",
    "Cause.intervention", "date.de.survenance", "Type.d.energie",
    "Outil.d.assistance", "Assistance.ou.Administratif",
    "TOP.D.R", "TOP.VR", "TOP.Rappat.valide",
    "TOP.Poursuite", "TOP.Recup", "TOP.Autres.Garanties"
  ];
  var SP_DEMO_DISTINCT = {
    "Cause.intervention": ["Fuite chaudière","Tableau HS","Fuite de gaz","Surtension","Câble sectionné","Fuite compteur","Disjoncteur HS","Coupure d'eau","Pas de chauffage","Odeur de gaz","#??!","N/A"],
    "Type.d.energie":     ["Fioul","Gaz","Eau","Électricité","Mixte","GPL","#??!"],
    "Client":             ["EDF","Eni","Air Liquide","Vattenfall","GRDF","ENGIE","Direct Energie","TotalEnergies","Enedis","Saur","Suez","#??!"],
    "Formule":            ["Formule Eco","Formule Essentiel","Formule Standard","Formule Premium","Formule Confort","Formule Pro","Formule Sérénité","#??!"],
    "Outil.d.assistance": ["Web Portal","Téléphone","Outil Legacy","Mobile App","Tablette terrain","SAV-Tool","#??!"]
  };

  function _spSnakeCase(s) {
    return String(s)
      .replace(/[.\-\s]+/g, "_")
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");
  }
  function _spTitleCase(s) {
    return String(s).toLowerCase().replace(/(^|\s|')(\S)/g,
      function (m, p, c) { return p + c.toUpperCase(); });
  }
  function _spEscHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c];
    });
  }

  // Render preview pairs into a host element. Structure:
  //   chip (always visible)
  //   .rp-preview-scroll (capped to ~6 lines, scrolls if more)
  //   unchanged trailing line (always visible)
  // Splitting like this keeps the rp-modal a fixed height regardless of
  // how many pairs are returned — popover-positioned modals near the
  // bottom of the viewport stop growing past the screen edge after
  // Compute fills the preview in.
  function _spRenderPreview(host, pairs, opts) {
    if (!host) return;
    opts = opts || {};
    var maxShow = opts.maxShow || 50;   // upper safety bound, scroll handles the rest
    var changed = pairs.filter(function (p) { return p.before !== p.after; });
    var unchanged = pairs.filter(function (p) { return p.before === p.after; });

    var html = '';
    html += '<div class="rp-form-meta" style="margin-bottom:0.375rem">' +
      '<span class="rp-view-chip"><i class="bi bi-arrow-left-right"></i>' +
      changed.length + ' of ' + pairs.length + ' affected</span></div>';

    var lines = [];
    changed.slice(0, maxShow).forEach(function (p) {
      lines.push('<div class="rp-preview-line"><code>' +
        _spEscHtml(p.before) + '</code> → <code>' +
        _spEscHtml(p.after) + '</code></div>');
    });
    if (changed.length > maxShow) {
      lines.push('<div class="rp-preview-line rp-form-meta">…' +
        (changed.length - maxShow) + ' more</div>');
    }
    html += '<div class="rp-preview-scroll">' + lines.join("") + '</div>';

    if (unchanged.length) {
      html += '<div class="rp-preview-line rp-form-meta" style="margin-top:0.25rem">Unchanged: ' +
        unchanged.slice(0, 6).map(function (p) { return _spEscHtml(p.before); }).join(" · ") +
        (unchanged.length > 6 ? " · …" : "") + '</div>';
    }
    host.innerHTML = html;
  }

  // Pre-fill a [data-sp-preview] host with the same structure that
  // _spRenderPreview produces (chip + scroll wrap with 6 lines +
  // trailing line), but with placeholder content. Locks the rp-modal
  // to its final height on open — Compute only swaps content, no
  // resize after the fact. Guarded with dataset.spPrefilled so it
  // doesn't overwrite a computed preview when spInit re-runs.
  function _spFillPreviewPlaceholder(host) {
    if (!host || host.dataset.spPrefilled) return;
    host.dataset.spPrefilled = "1";
    var rows = [];
    for (var i = 0; i < 6; i++) {
      rows.push('<div class="rp-preview-line rp-form-meta">—</div>');
    }
    host.innerHTML =
      '<div class="rp-form-meta" style="margin-bottom:0.375rem">' +
        '<span class="rp-view-chip" style="opacity:0.55"><i class="bi bi-arrow-left-right"></i>Click Compute to preview</span>' +
      '</div>' +
      '<div class="rp-preview-scroll">' + rows.join("") + '</div>' +
      '<div class="rp-preview-line rp-form-meta" style="margin-top:0.25rem">—</div>';
  }

  // Per-tool preview triggers. Each reads its modal's inputs, runs
  // the transform locally, and renders into the [data-sp-preview]
  // host. Live app will swap in Polars-WASM for the actual file's
  // data; the function shape stays the same.
  window.spPreviewSnake = function (btn) {
    var modal = btn.closest(".rp-modal");
    var host = modal && modal.querySelector("[data-sp-preview]");
    _spRenderPreview(host, SP_DEMO_COLS.map(function (c) {
      return { before: c, after: _spSnakeCase(c) };
    }));
  };
  window.spPreviewReplaceNames = function (btn) {
    var modal = btn.closest(".rp-modal");
    if (!modal) return;
    var host = modal.querySelector("[data-sp-preview]");
    var find = (modal.querySelector("[data-sp-find]") || {}).value || "";
    var repl = (modal.querySelector("[data-sp-replace]") || {}).value || "";
    _spRenderPreview(host, SP_DEMO_COLS.map(function (c) {
      return { before: c, after: find === "" ? c : c.split(find).join(repl) };
    }));
  };
  window.spPreviewRename = function (btn) {
    var modal = btn.closest(".rp-modal");
    if (!modal) return;
    var host = modal.querySelector("[data-sp-preview]");
    var col  = (modal.querySelector("[data-sp-col]")      || {}).value || "";
    var to   = (modal.querySelector("[data-sp-new-name]") || {}).value || "";
    _spRenderPreview(host, [{ before: col, after: to || col }]);
  };
  window.spPreviewChangeCase = function (btn) {
    var modal = btn.closest(".rp-modal");
    if (!modal) return;
    var host = modal.querySelector("[data-sp-preview]");
    var col  = (modal.querySelector("[data-sp-col]") || {}).value || "";
    var mode = (modal.querySelector("[data-sp-case-mode]") || {}).value || "title";
    var fn   = mode === "lower" ? function (s) { return String(s).toLowerCase(); }
             : mode === "upper" ? function (s) { return String(s).toUpperCase(); }
             :                    _spTitleCase;
    var values = SP_DEMO_DISTINCT[col] || [];
    if (!values.length) {
      host.innerHTML = '<div class="rp-preview-line rp-form-meta">No sample values cached for this column in the demo.</div>';
      return;
    }
    _spRenderPreview(host, values.map(function (v) {
      return { before: v, after: fn(v) };
    }));
  };

  // Per-row demo data for the String Ops previews. Each entry is a
  // few real values pulled from the sentinel CSV — enough to make
  // the split / join / remove / replace previews look real.
  var SP_DEMO_ROWS = [
    { Client:"EDF",        Formule:"Formule Eco",      "date.ouverture":"14/06/2024", "Cause.intervention":"Fuite chaudière",  "Type.d.energie":"Fioul" },
    { Client:"Eni",        Formule:"Formule Essentiel","date.ouverture":"19/11/2022", "Cause.intervention":"Tableau HS",       "Type.d.energie":"Gaz" },
    { Client:"Air Liquide",Formule:"Formule Standard", "date.ouverture":"07/08/2024", "Cause.intervention":"Fuite chaudière",  "Type.d.energie":"Gaz" },
    { Client:"GRDF",       Formule:"Formule Essentiel","date.ouverture":"13/04/2025", "Cause.intervention":"Fuite compteur",   "Type.d.energie":"Mixte" },
    { Client:"ENGIE",      Formule:"Formule Standard", "date.ouverture":"#??!",       "Cause.intervention":"Surtension",       "Type.d.energie":"Électricité" },
    { Client:"#??!",       Formule:"Formule Premium",  "date.ouverture":"05/03/2025", "Cause.intervention":"N/A",              "Type.d.energie":"Fioul" }
  ];

  // String Ops previews — each reads its modal's inputs, runs the
  // transform on the demo rows, and paints the before/after list.
  window.spPreviewSplit = function (btn) {
    var modal = btn.closest(".rp-modal");
    if (!modal) return;
    var host = modal.querySelector("[data-sp-preview]");
    var col  = (modal.querySelector("[data-sp-col]") || {}).value || "";
    var sep  = (modal.querySelector("[data-sp-sep]") || {}).value || "/";
    var rows = SP_DEMO_ROWS.map(function (r) { return r[col]; }).filter(Boolean);
    var pairs = rows.map(function (v) {
      var parts = String(v).split(sep);
      return {
        before: v,
        after:  parts.length > 1 ? "[ " + parts.join(" │ ") + " ]" : "(separator not found)"
      };
    });
    _spRenderPreview(host, pairs);
  };
  window.spPreviewJoinCo = function (btn) {
    var modal = btn.closest(".rp-modal");
    if (!modal) return;
    var host = modal.querySelector("[data-sp-preview]");
    var aSel = modal.querySelector("[data-sp-col-a]");
    var bSel = modal.querySelector("[data-sp-col-b]");
    var sep  = (modal.querySelector("[data-sp-sep]") || {}).value || " - ";
    var a = aSel ? aSel.value : ""; var b = bSel ? bSel.value : "";
    var pairs = SP_DEMO_ROWS.map(function (r) {
      var va = r[a] || ""; var vb = r[b] || "";
      return { before: va + "  +  " + vb, after: va + sep + vb };
    });
    _spRenderPreview(host, pairs);
  };
  window.spPreviewRemoveText = function (btn) {
    var modal = btn.closest(".rp-modal");
    if (!modal) return;
    var host = modal.querySelector("[data-sp-preview]");
    var col  = (modal.querySelector("[data-sp-col]") || {}).value || "";
    var pat  = (modal.querySelector("[data-sp-find]") || {}).value || "";
    var values = SP_DEMO_DISTINCT[col] || [];
    if (!pat) {
      host.innerHTML = '<div class="rp-preview-line rp-form-meta">Type a pattern to preview the removal.</div>';
      return;
    }
    var pairs = values.map(function (v) {
      return { before: v, after: String(v).split(pat).join("") };
    });
    _spRenderPreview(host, pairs);
  };
  window.spPreviewFind = function (btn) {
    var modal = btn.closest(".rp-modal");
    if (!modal) return;
    var host = modal.querySelector("[data-sp-preview]");
    var col  = (modal.querySelector("[data-sp-col]") || {}).value || "";
    var q    = (modal.querySelector("[data-sp-find]") || {}).value || "";
    if (!q) {
      host.innerHTML = '<div class="rp-preview-line rp-form-meta">Type a search term to see matches.</div>';
      return;
    }
    var cols = col === "All columns"
      ? Object.keys(SP_DEMO_DISTINCT)
      : [col];
    var matches = [];
    cols.forEach(function (c) {
      (SP_DEMO_DISTINCT[c] || []).forEach(function (v) {
        if (String(v).toLowerCase().indexOf(q.toLowerCase()) !== -1) {
          matches.push({ col: c, value: v });
        }
      });
    });
    if (!matches.length) {
      host.innerHTML = '<div class="rp-preview-line rp-form-meta">No matches in the cached sample values.</div>';
      return;
    }
    var lines = matches.slice(0, 50).map(function (m) {
      return '<div class="rp-preview-line"><code>' + _spEscHtml(m.value) + '</code> <span class="rp-form-meta">in ' + _spEscHtml(m.col) + '</span></div>';
    }).join("");
    if (matches.length > 50) {
      lines += '<div class="rp-preview-line rp-form-meta">…' + (matches.length - 50) + ' more</div>';
    }
    host.innerHTML =
      '<div class="rp-form-meta" style="margin-bottom:0.375rem">' +
        '<span class="rp-view-chip"><i class="bi bi-search"></i>' + matches.length + ' matching distinct values</span>' +
      '</div>' +
      '<div class="rp-preview-scroll">' + lines + '</div>';
  };
  window.spPreviewReplaceText = function (btn) {
    var modal = btn.closest(".rp-modal");
    if (!modal) return;
    var host = modal.querySelector("[data-sp-preview]");
    var col  = (modal.querySelector("[data-sp-col]") || {}).value || "";
    var find = (modal.querySelector("[data-sp-find]")    || {}).value || "";
    var repl = (modal.querySelector("[data-sp-replace]") || {}).value || "";
    var values = SP_DEMO_DISTINCT[col] || [];
    if (!find) {
      host.innerHTML = '<div class="rp-preview-line rp-form-meta">Type a search term to preview the replacement.</div>';
      return;
    }
    var pairs = values.map(function (v) {
      return { before: v, after: String(v).split(find).join(repl) };
    });
    _spRenderPreview(host, pairs);
  };

  // Generic click feedback — adds .rp-clicked for ~160ms so CSS can
  // run a small press-pulse. Use anywhere a button has no other
  // visible state change but the user needs the "yes, the click
  // registered" cue (eraser / save / apply in the filter panel
  // were the first cases). Removes + re-adds the class so repeat
  // clicks always replay the animation.
  window.spClickFx = function (btn) {
    if (!btn) return;
    btn.classList.remove("rp-clicked");
    void btn.offsetWidth;   // force reflow so the animation restarts
    btn.classList.add("rp-clicked");
    setTimeout(function () { btn.classList.remove("rp-clicked"); }, 160);
  };

  // ── Drag-to-reorder ─────────────────────────────────────────────
  // Client-side reorder for tabs (project + file) and file-table
  // column headers. The live app persists the new order to the
  // backend on drop; here we just rearrange the DOM. Optimistic UI
  // by default — no spinner, no round-trip.
  //
  // What's draggable:
  //   - .rp-rt-proj-tab (project tabs)
  //   - .rp-rtp-tab without data-is-overview (file tabs; Overview
  //     is a fixed leading tab)
  //   - th:not(.rp-rt-th-mode):not(.rp-rt-rownum-th):not(.rp-rt-th-del) (CSV data columns; mode + rownum stay
  //     fixed at the left)
  //
  // For tabs we move the dragged element via insertBefore on its
  // parent. For columns we also move the matching <td> at the same
  // index in every body row so the data follows its header.
  var _spDragHooked = false;
  var _spDragged = null;
  var _spDraggedKind = null;
  function _bindDragReorder(root) {
    // Every data <th> is draggable EXCEPT chrome columns (mode rail,
    // rownum gutter, optional delete column). Catches both the file
    // table (whose data headers carry .rp-rt-th-sortable) AND the
    // Overview (whose plain <th>Name</th> etc. don't).
    // Object-strip tabs (#obj-tabs) own their drag flow (inline
    // spStartObjectTabDrag etc. so the array stays source-of-truth) —
    // skip them here to avoid the generic dragover-reorder fighting
    // the state-driven render.
    (root || document)
      .querySelectorAll(
        ".rp-rt-proj-tab, .rp-rtp-tab:not([data-is-overview]), " +
        ".rp-rt-table thead th:not(.rp-rt-th-mode):not(.rp-rt-rownum-th):not(.rp-rt-th-del)"
      )
      .forEach(function (el) {
        if (el.closest("#obj-tabs")) return;
        if (el.dataset.spDragBound) return;
        el.dataset.spDragBound = "1";
        el.setAttribute("draggable", "true");
      });
    // Stamp each data <th> with its original sibling index so the
    // Columns-picker "Reset to DB order" button can put the columns
    // back. Done once per table — first bind wins; later drags don't
    // overwrite. Body <td>s aren't stamped: they piggy-back on whatever
    // their parent th's order becomes (we restore by re-walking the th
    // order and moving the td at the same index in every row).
    (root || document)
      .querySelectorAll(".rp-rt-table")
      .forEach(function (table) {
        if (table.dataset.spOrigStamped) return;
        var headRow = table.tHead && table.tHead.rows[0];
        if (!headRow) return;
        Array.prototype.forEach.call(headRow.children, function (th, idx) {
          if (!th.dataset.spOrigIdx) th.dataset.spOrigIdx = String(idx);
        });
        table.dataset.spOrigStamped = "1";
      });
    if (_spDragHooked) return;
    _spDragHooked = true;
    // Module-scoped state — `dragged` / `draggedKind` aliased so the
    // existing handler bodies don't need rewriting.
    var dragged, draggedKind;
    document.addEventListener("dragstart", function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      // dragstart's target can be an inner span / icon depending on
      // the browser; walk up to the actual draggable source.
      var src = t.closest(
        ".rp-rt-proj-tab, .rp-rtp-tab, th:not(.rp-rt-th-mode):not(.rp-rt-rownum-th):not(.rp-rt-th-del)"
      );
      if (!src) return;
      // Object-strip tabs have their own inline drag handlers.
      if (src.closest("#obj-tabs")) return;
      if (src.tagName === "TH") {
        dragged = src; draggedKind = "th";
      } else {
        if (src.hasAttribute("data-is-overview")) return;
        dragged = src; draggedKind = "tab";
      }
      e.dataTransfer.effectAllowed = "move";
      // Non-empty payload — some browsers cancel the drag if
      // setData isn't called with actual content.
      try { e.dataTransfer.setData("text/plain", "rp-drag"); } catch (_) {}
      dragged.classList.add("rp-drag-source");
    });
    // dragenter mirror — Firefox in particular insists on
    // preventDefault on BOTH enter and over inside the drop zone
    // for the drop event to fire and the reorder to "stick".
    document.addEventListener("dragenter", function (e) {
      if (!dragged) return;
      var container = dragged.parentElement;
      if (!container || !container.contains(e.target)) return;
      e.preventDefault();
    });
    document.addEventListener("dragover", function (e) {
      if (!dragged) return;
      var t = e.target;
      if (!t || !t.closest) return;
      // preventDefault on ANY hover inside the source's container so
      // the cursor stops painting the "no drop" slash. The actual
      // reorder only runs when the cursor is over a valid peer.
      var container = dragged.parentElement;
      if (!container || !container.contains(t)) return;
      e.preventDefault();
      var sel = draggedKind === "tab"
        ? ".rp-rt-proj-tab, .rp-rtp-tab"
        : "th:not(.rp-rt-th-mode):not(.rp-rt-rownum-th):not(.rp-rt-th-del)";
      var over = t.closest(sel);
      if (!over || over === dragged) return;
      if (draggedKind === "tab" && over.hasAttribute("data-is-overview")) return;
      if (over.parentElement !== container) return;
      var rect = over.getBoundingClientRect();
      var before = e.clientX < rect.left + rect.width / 2;
      if (draggedKind === "tab") {
        container.insertBefore(dragged, before ? over : over.nextSibling);
      } else {
        _moveTableColumn(dragged, over, before);
      }
    });
    // drop — actual reorder already happened during dragover; just
    // suppress the browser's default drop behaviour (which can
    // navigate or open the payload).
    document.addEventListener("drop", function (e) {
      if (!dragged) return;
      e.preventDefault();
    });
    document.addEventListener("dragend", function () {
      if (dragged) dragged.classList.remove("rp-drag-source");
      dragged = null; draggedKind = null;
    });
  }
  // Reorder a CSV column: move the dragged <th> in the thead AND
  // shift the matching <td> in every body row to the same new
  // position. Indices captured BEFORE the th moves so the body
  // shift uses the unchanged row layout.
  function _moveTableColumn(draggedTh, overTh, before) {
    var thRow = draggedTh.parentElement;
    var fromIdx = Array.prototype.indexOf.call(thRow.children, draggedTh);
    var toIdx   = Array.prototype.indexOf.call(thRow.children, overTh);
    thRow.insertBefore(draggedTh, before ? overTh : overTh.nextSibling);
    var table = thRow.closest("table");
    if (!table) return;
    Array.prototype.forEach.call(table.tBodies, function (tbody) {
      Array.prototype.forEach.call(tbody.rows, function (tr) {
        if (tr.children.length <= Math.max(fromIdx, toIdx)) return;
        var td = tr.children[fromIdx];
        var target = tr.children[toIdx];
        if (!td || !target) return;
        tr.insertBefore(td, before ? target : target.nextSibling);
      });
    });
  }

  // Refresh button — spin the icon for ~600ms (a single 360° rotation)
  // to acknowledge the click. No data refresh in this mockup; the live
  // app will swap the handler for the actual refetch + repaint. Guard
  // against spamming so the animation always completes one cycle.
  window.spRefresh = function (btn) {
    if (!btn || btn.classList.contains("is-refreshing")) return;
    btn.classList.add("is-refreshing");
    setTimeout(function () { btn.classList.remove("is-refreshing"); }, 600);
  };

  // Compute-cleanness button — same single-spin pattern as refresh.
  // Just visual feedback; live app will swap for the real pipeline
  // call. Guard against re-trigger mid-spin so the animation
  // always completes one cycle (no infinite loop — explicit choice).
  window.spClean = function (btn) {
    if (!btn || btn.classList.contains("is-cleaning")) return;
    btn.classList.add("is-cleaning");
    setTimeout(function () { btn.classList.remove("is-cleaning"); }, 600);
  };

  // ── Single-button toggle (row-num, open-links, link-sync) ──────
  window.spToggleActive = function (btn, cls) {
    if (!btn) return;
    cls = cls || "is-active";
    var nowActive = !btn.classList.contains(cls);
    btn.classList.toggle(cls, nowActive);
    btn.setAttribute("aria-pressed", nowActive ? "true" : "false");
  };

  // ── Tools-panel section collapse ───────────────────────────────
  // Header carries the "open" state; its IMMEDIATE NEXT sibling is the
  // body. Keeping the structure markup-driven (no IDs) means a fragment
  // can paste-and-go without renaming targets.
  window.spToggleSection = function (header) {
    if (!header) return;
    header.classList.toggle("open");
    var body = header.nextElementSibling;
    if (body && body.classList.contains("rp-rt-panel-sect-body")) {
      body.classList.toggle("open");
    }
  };

  // ── Modal show / hide ──────────────────────────────────────────
  // Convention mirrors the live app — id="rp-modal-<key>"; openModal("key")
  // resolves "modal-key". A second-call to openModal closes any other
  // open rp-modal first (one-at-a-time).
  // Position a popover-style rp-modal next to the trigger button. Mirrors
  // the live app's _positionToolModal (redpash-app cleaner.js):
  // prefers the LEFT of the button so the rp-modal opens toward the data
  // table (tools panel is on the right); falls back to the right side
  // if there isn't enough room. Clamps to the viewport with a 12px
  // gutter. rAF wait so offsetWidth/Height are post-layout.
  function _positionPopoverModal(modal, btn) {
    if (!modal || !btn) return;
    var rect = btn.getBoundingClientRect();
    var gap = 12;
    modal.style.position = "fixed";
    modal.style.margin   = "0";
    requestAnimationFrame(function () {
      var vpW = window.innerWidth, vpH = window.innerHeight;
      var mw  = modal.offsetWidth  || 400;
      var mh  = modal.offsetHeight || 300;
      var left = rect.left - mw - gap;
      if (left < gap) left = rect.right + gap;
      left = Math.max(gap, Math.min(left, vpW - mw - gap));
      var top  = rect.top;
      if (top + mh > vpH - gap) top = Math.max(gap, vpH - mh - gap);
      modal.style.left = left + "px";
      modal.style.top  = top + "px";
    });
  }
  function _resetPopoverModal(modal) {
    if (!modal) return;
    modal.style.position = "";
    modal.style.margin   = "";
    modal.style.left     = "";
    modal.style.top      = "";
  }

  // openModal(key, btn?) — when a trigger button is passed, the rp-modal
  // opens popover-style: overlay is transparent (page stays visible)
  // and the rp-modal floats next to the button. Without a btn, the
  // rp-modal centers like a regular dialog with the dim backdrop.
  // Marker class .is-popover on the overlay drives the CSS swap.
  window.openModal = function (key, btn) {
    document.querySelectorAll(".rp-modal-overlay.open").forEach(function (o) {
      o.classList.remove("open");
      o.classList.remove("is-popover");
      _resetPopoverModal(o.querySelector(".rp-modal"));
    });
    var ov = document.getElementById("rp-modal-" + key);
    if (!ov) return;
    if (btn) {
      ov.classList.add("is-popover");
      _positionPopoverModal(ov.querySelector(".rp-modal"), btn);
    }
    ov.classList.add("open");
  };
  window.closeModal = function (key) {
    var els = key
      ? [document.getElementById("rp-modal-" + key)].filter(Boolean)
      : Array.prototype.slice.call(document.querySelectorAll(".rp-modal-overlay.open"));
    els.forEach(function (ov) {
      ov.classList.remove("open");
      ov.classList.remove("is-popover");
      _resetPopoverModal(ov.querySelector(".rp-modal"));
    });
  };

  // Esc closes any open rp-modal — universal "get me out" affordance.
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") window.closeModal();
  });

  // Strip scroll or viewport resize would leave a fixed-position
  // add-menu pinned to stale coords — easier to just close it. Uses
  // capture phase so we catch scroll events from the overflow strips
  // (scroll doesn't bubble). Skips the close when the scroll fires
  // INSIDE an open menu — the user scrolling the items list shouldn't
  // dismiss the menu they're scrolling.
  function _closeAddMenus(e) {
    document.querySelectorAll(".rp-tab-add-menu.open, .rp-dd-menu.open")
      .forEach(function (m) {
        if (e && e.target && m.contains(e.target)) return;
        m.classList.remove("open");
      });
  }
  document.addEventListener("scroll", _closeAddMenus, true);
  window.addEventListener("resize", _closeAddMenus);

  // Outside-click closer — dismisses anything floating when the user
  // clicks outside it. Two targets:
  //   • Side panels (.rp-rt-filter-panel.open / .rp-rtp-tools.open)
  //     — close unless the click was inside the panel or on the panel's
  //       own toggle trigger (data-sp-panel-trigger="<panel-id>").
  //   • Tab-strip add-menu (.rp-tab-add-menu.open) — close unless the
  //     click was inside the menu's wrapping .rp-tab-add-wrap (so the
  //     + trigger and the menu items both keep ownership).
  // Click bubbles after the inline onclick handlers fire, so triggers
  // see their state changes before this handler runs.
  document.addEventListener("click", function (e) {
    // Clicks on a rp-modal overlay handle their own dismiss via the
    // overlay's inline onclick=closeModal. They should never close
    // an underlying side panel — without this guard, clicking a
    // popover modal's overlay would also close the tools / filter
    // panel that was open behind it.
    if (e.target.closest && e.target.closest(".rp-modal-overlay")) return;
    var panels = document.querySelectorAll(
      ".rp-rt-filter-panel.open, .rp-rtp-tools.open"
    );
    panels.forEach(function (panel) {
      if (panel.contains(e.target)) return;
      var trig = e.target.closest && e.target.closest("[data-sp-panel-trigger]");
      if (trig && trig.getAttribute("data-sp-panel-trigger") === panel.id) return;
      panel.classList.remove("open");
    });
    document.querySelectorAll(".rp-tab-add-menu.open, .rp-dd-menu.open").forEach(function (menu) {
      var wrap = menu.closest(".rp-tab-add-wrap, .rp-dd-wrap");
      if (wrap && wrap.contains(e.target)) return;
      // Generic .rp-dd-menu may have been moved out of its wrap into
      // body via position:fixed; if click is inside the menu itself,
      // keep it open.
      if (menu.contains(e.target)) return;
      menu.classList.remove("open");
    });
  });

})();
