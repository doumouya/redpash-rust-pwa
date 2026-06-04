/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/pages/settings-search.md */
// Settings v2 step 3 — behavior-first search affordance.
//
// Renders a sticky search input + tag chip cloud above the section
// view. As the user types, every rendered pref row gets a match check
// against (label + hint + key + tags); non-matching rows pick up
// `.is-dim` (40% opacity, kept in place so the user can see what
// they're filtering past). Rail group badges switch from tab-count
// to hit-count while a query is active.
//
// Tag set is derived from the registry — every distinct value across
// `spec.tags` becomes a chip. Open-ended per [[data-format-open-ended]]:
// register a new tag-bearing pref + the chip appears next render.
//
// Affordances:
//   `/`   focuses the search input (from anywhere on Settings).
//   Esc   clears the query + deselects every tag.
//   Click a tag chip → multi-select, AND with the query.
//
// A11y:
//   role="searchbox" on the input.
//   role="button"  + aria-pressed on each chip.
//   aria-live="polite" on the results readout so SR users hear "N
//   results" when filtering settles.
//   Non-matching rows get aria-hidden="true" so SR skips them.

import { esc } from "/scripts/dom.js";
import { eachPref } from "/scripts/prefs.js";

const DEBOUNCE_MS = 80;

/**
 * Mount the search affordance into #rpSetSearchShell.
 *
 *   app — the page root element.
 *
 * Returns the public API for tests / dev tools:
 *   { focus(), clear(), recompute() }
 */
export function mountSearch(app) {
  const shell = app.querySelector("#rpSetSearchShell");
  if (!shell) return null;

  // Collect every spec that has a section — the only ones that
  // surface as rendered rows. Build a tag set for the chip cloud.
  const tags = new Set();
  eachPref((spec) => {
    if (!spec.section) return;
    if (Array.isArray(spec.tags)) spec.tags.forEach((t) => tags.add(t));
  });
  const allTags = Array.from(tags).sort();

  // Tags-bearing specs are the only ones the chip filter can match;
  // when no tags are registered (e.g. mid-bootstrap, future pages
  // that haven't tagged), the chip row hides itself. Search still
  // works on label / hint / key.
  shell.hidden = false;
  shell.innerHTML = ''
    + '<div class="rp-settings__search">'
    +   '<i class="bi bi-search rp-settings__search-icon" aria-hidden="true"></i>'
    +   '<input id="rpSetSearchInput" type="search" role="searchbox"'
    +     ' class="rp-settings__search-input"'
    +     ' placeholder="Find a setting…" autocomplete="off"'
    +     ' aria-label="Search settings" />'
    +   '<button type="button" class="rp-settings__search-clear" id="rpSetSearchClear"'
    +     ' title="Clear (Esc)" aria-label="Clear search" hidden>×</button>'
    + '</div>'
    + (allTags.length
        ? '<div class="rp-settings-tags" id="rpSetSearchTags" role="group" aria-label="Filter by tag">'
        +   allTags.map((t) =>
            '<button type="button" class="rp-chip"'
            +  ' aria-pressed="false" data-tag="' + esc(t) + '">'
            +  esc(t)
            +  '</button>'
          ).join("")
        + '</div>'
        : '')
    + '<div class="rp-settings__search-readout" aria-live="polite"'
    +   ' id="rpSetSearchReadout"></div>';

  const input    = shell.querySelector("#rpSetSearchInput");
  const clearBtn = shell.querySelector("#rpSetSearchClear");
  const tagsRow  = shell.querySelector("#rpSetSearchTags");
  const readout  = shell.querySelector("#rpSetSearchReadout");

  // Per-row context — built lazily on first compute. Each row is a
  // `.rp-page__row` containing a `[data-pref]` group; we look the
  // spec up by key + cache the searchable haystack.
  let rowCtx = null;
  function ensureRowCtx() {
    if (rowCtx) return rowCtx;
    const groups = app.querySelectorAll("[data-pref]");
    const map = new Map();
    eachPref((spec) => { if (spec.key) map.set(spec.key, spec); });
    rowCtx = [];
    groups.forEach((group) => {
      const row = group.closest(".rp-page__row");
      if (!row) return;
      const key  = group.dataset.pref;
      const spec = map.get(key);
      if (!spec) return;  // non-pref-backed rows (share_sentinels, etc.)
      const haystack = [
        spec.label || "",
        spec.hint  || "",
        spec.key   || "",
        ...(Array.isArray(spec.tags) ? spec.tags : []),
      ].join(" ").toLowerCase();
      rowCtx.push({ row, spec, haystack });
    });
    return rowCtx;
  }

  // Rail tab → owning rail group head. Built once for hit-count
  // badge updates.
  let railIndex = null;
  function ensureRailIndex() {
    if (railIndex) return railIndex;
    railIndex = new Map();  // section-id → group-head element
    app.querySelectorAll("#rpSetNavBody .rt-group").forEach((group) => {
      const head = group.querySelector(".rt-group-head .rt-group-count");
      if (!head) return;
      group.querySelectorAll(".rt-tab").forEach((tab) => {
        railIndex.set(tab.dataset.key, head);
      });
    });
    return railIndex;
  }

  // Selected tag set — chip toggles flip membership.
  const selectedTags = new Set();

  function readQuery() {
    return (input.value || "").trim().toLowerCase();
  }

  function rowMatches(ctx, q) {
    if (q && !ctx.haystack.includes(q)) return false;
    if (selectedTags.size) {
      const rowTags = Array.isArray(ctx.spec.tags) ? ctx.spec.tags : [];
      for (const t of selectedTags) {
        if (!rowTags.includes(t)) return false;
      }
    }
    return true;
  }

  function recompute() {
    const q = readQuery();
    const active = q.length > 0 || selectedTags.size > 0;
    const ctxList = ensureRowCtx();
    const rail = ensureRailIndex();

    // Bucket hit counts by section for the rail badge refresh.
    const hitsBySection = new Map();
    let totalHits = 0;
    let totalRows = ctxList.length;
    for (const ctx of ctxList) {
      const match = active ? rowMatches(ctx, q) : true;
      ctx.row.classList.toggle("is-dim", active && !match);
      ctx.row.classList.toggle("is-match", active && match);
      ctx.row.setAttribute("aria-hidden", active && !match ? "true" : "false");
      if (match) {
        totalHits++;
        const section = ctx.spec.section;
        if (section) {
          hitsBySection.set(section, (hitsBySection.get(section) || 0) + 1);
        }
      }
    }

    // Rail badges: when active, show hit counts; when cleared,
    // restore the static tab count.
    app.querySelectorAll("#rpSetNavBody .rt-group").forEach((group) => {
      const badge = group.querySelector(".rt-group-head .rt-group-count");
      if (!badge) return;
      if (!active) {
        // Restore static count (tabs in this group).
        const tabCount = group.querySelectorAll(".rt-tab").length;
        badge.textContent = String(tabCount);
        badge.classList.remove("is-hits");
        group.classList.remove("is-no-hits");
        return;
      }
      // Sum hits across every tab in this group.
      let groupHits = 0;
      group.querySelectorAll(".rt-tab").forEach((tab) => {
        groupHits += hitsBySection.get(tab.dataset.key) || 0;
      });
      badge.textContent = String(groupHits);
      badge.classList.add("is-hits");
      group.classList.toggle("is-no-hits", groupHits === 0);
    });

    // Clear button visibility.
    clearBtn.hidden = !(q.length > 0 || selectedTags.size > 0);

    // Live region readout. Wording differs by mode so SR users hear
    // "5 settings match" vs "showing all 14 settings".
    if (!active) {
      readout.textContent = "";
    } else {
      readout.textContent =
        totalHits === 0
          ? "No matching settings."
          : (totalHits + " of " + totalRows + " settings match.");
    }
  }

  // ── input + chip handlers ───────────────────────────────────
  let debounceTimer = null;
  input.addEventListener("input", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      recompute();
    }, DEBOUNCE_MS);
  });
  // Synchronous Enter / Esc — the debounce-only path can swallow
  // an Esc/Enter that lands inside the timeout window.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      doClear();
      e.preventDefault();
    }
  });

  if (tagsRow) {
    tagsRow.addEventListener("click", (e) => {
      const chip = e.target.closest(".rp-chip");
      if (!chip) return;
      const tag = chip.dataset.tag;
      if (selectedTags.has(tag)) {
        selectedTags.delete(tag);
        chip.setAttribute("aria-pressed", "false");
        chip.classList.remove("is-active");
      } else {
        selectedTags.add(tag);
        chip.setAttribute("aria-pressed", "true");
        chip.classList.add("is-active");
      }
      recompute();
    });
  }

  function doClear() {
    input.value = "";
    selectedTags.clear();
    if (tagsRow) {
      tagsRow.querySelectorAll(".rp-chip").forEach((chip) => {
        chip.setAttribute("aria-pressed", "false");
        chip.classList.remove("is-active");
      });
    }
    recompute();
    input.focus();
  }
  clearBtn.addEventListener("click", doClear);

  // ── `/` from anywhere in Settings focuses the search ─────────
  // Guard so we don't hijack input typing inside other text fields
  // (e.g. future inline-edit cells).
  function onSlashKey(e) {
    if (e.key !== "/") return;
    const target = e.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA"
                || target.isContentEditable)) {
      return;
    }
    e.preventDefault();
    input.focus();
    input.select();
  }
  document.addEventListener("keydown", onSlashKey);

  // Initial paint — no query, everyone visible.
  recompute();

  return {
    focus()     { input.focus(); },
    clear()     { doClear(); },
    recompute,
  };
}
