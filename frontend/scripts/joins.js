// joins.js — sibling-file join picker for the workspace Tools panel
// (Joins tab — see partials/workspace.html #wsToolsJoinsBody, mounted
// from pages/workspace.js).
//
// Backend contract — both endpoints scoped to the active file's rid:
//   GET  /api/files/:rid/joins?filters=<json>  — returns
//     { files: [{ redpash_id, title, candidates: [...] }] } where each
//     candidate is { this_col, other_col, score, matches,
//     this_uniques, other_uniques, samples }. Sorted desc by score,
//     capped at per_file=20 per sibling file. Filter-aware: narrows
//     the base frame before detection so candidates reflect the
//     visible subset.
//   POST /api/files/:rid/joins  (slice C — multi-select Apply).
//
// User-facing copy is the count form Em locked 2026-05-24 — never a
// percentage:
//   "64 of 103 base values match  (other file has 99 unique)"
//
// Score stays as the *internal* sort key (FK→PK overlap coefficient,
// |A ∩ B| / min(|A|, |B|)); a 3-bucket dot-meter (●●● ≥ 0.66 / ●●○ ≥
// 0.33 / ●○○) is the only score signal the user sees (thresholds
// suggested by Gus 2026-05-24 from dev-DB candidate distribution).
//
// Slice B (this commit) is read-only — accordion of per-sibling-file
// cards, top-5 candidate rows expanded, "show more (N hidden)" reveals
// the rest. Slice C will layer multi-select + join-type dropdown +
// Apply → POST on top of the same markup.

import { api } from "/scripts/api.js";
import { esc } from "/scripts/dom.js";

const TOP_N = 5;

export function mountJoins(panelBody, ctx) {
  // ctx: { fileRid: () => string|null, activeFilter: () => FilterNode|null,
  //        onApplied: (envelope) => void }
  let candidates  = null;     // last fetched payload — { files: [...] } | null
  let loading     = false;
  let errorText   = "";       // non-empty when the last fetch failed
  let lastFileRid = null;     // detect when the active file changes
  let expanded    = {};       // { [other_rid]: true } — which cards show all candidates

  function render() {
    if (loading) {
      panelBody.innerHTML = '<p class="rt-step-state">Detecting joins…</p>';
      return;
    }
    if (errorText) {
      panelBody.innerHTML = '<p class="rt-step-state">' + esc(errorText) + '</p>';
      return;
    }
    if (!candidates) {
      panelBody.innerHTML = '<p class="rt-step-state">Open a file to detect joins with siblings in the project.</p>';
      return;
    }
    const files = candidates.files || [];
    if (!files.length) {
      panelBody.innerHTML = '<p class="rt-step-state">No matching keys found in other files of this project.</p>';
      return;
    }
    panelBody.innerHTML =
      '<p class="rt-join-intro">Join this file with another in the project. '
      + 'Pick a candidate column pair below — pick multiple for a compound key.</p>'
      + files.map(renderFileCard).join("");
  }

  function renderFileCard(file) {
    const cands  = file.candidates || [];
    const isOpen = !!expanded[file.redpash_id];
    const shown  = isOpen ? cands : cands.slice(0, TOP_N);
    const hidden = cands.length - shown.length;
    const ridAttr = ' data-other-rid="' + esc(file.redpash_id) + '"';
    return ''
      + '<section class="rt-join-card"' + ridAttr + '>'
      +   '<header class="rt-join-card__head">'
      +     '<i class="bi bi-file-earmark-text"></i>'
      +     '<span class="rt-join-card__title">' + esc(file.title || file.redpash_id) + '</span>'
      +     '<span class="rt-join-card__count">'
      +       cands.length + ' candidate' + (cands.length === 1 ? '' : 's')
      +     '</span>'
      +   '</header>'
      +   '<table class="rt-join-table">'
      +     '<thead><tr>'
      +       '<th class="is-strength" title="Overlap coefficient bucket"></th>'
      +       '<th>This file</th>'
      +       '<th>Other file</th>'
      +       '<th class="is-matches">Match</th>'
      +       '<th class="is-samples">Samples</th>'
      +     '</tr></thead>'
      +     '<tbody>' + shown.map(renderCandRow).join("") + '</tbody>'
      +   '</table>'
      +   (hidden > 0
          ? '<button class="rt-btn rt-btn--text rt-join-card__more" type="button">'
            + 'Show ' + hidden + ' more</button>'
          : '')
      +   (isOpen && cands.length > TOP_N
          ? '<button class="rt-btn rt-btn--text rt-join-card__less" type="button">'
            + 'Show top ' + TOP_N + ' only</button>'
          : '')
      + '</section>';
  }

  function renderCandRow(c) {
    // Score → dot-meter bucket. Overlap coefficient is in [0, 1].
    const dots = c.score >= 0.66 ? '●●●' : c.score >= 0.33 ? '●●○' : '●○○';
    const dotsClass = c.score >= 0.66 ? 'is-strong' : c.score >= 0.33 ? 'is-medium' : 'is-weak';
    const samples = (c.samples || []).slice(0, 3).map(esc).join(', ');
    return ''
      + '<tr>'
      +   '<td class="is-strength ' + dotsClass + '" '
      +     'title="overlap ' + (c.score || 0).toFixed(2) + '">' + dots + '</td>'
      +   '<td><span class="rt-join-col">' + esc(c.this_col) + '</span></td>'
      +   '<td><span class="rt-join-col">' + esc(c.other_col) + '</span></td>'
      +   '<td class="is-matches">'
      +     c.matches + ' of ' + c.this_uniques + ' base values match'
      +     ' <span class="rt-join-meta">'
      +       '(other file has ' + c.other_uniques + ' unique)'
      +     '</span>'
      +   '</td>'
      +   '<td class="is-samples">' + (samples || '—') + '</td>'
      + '</tr>';
  }

  async function loadCandidates({ force = false } = {}) {
    const rid = ctx.fileRid?.();
    if (!rid) {
      candidates  = null;
      lastFileRid = null;
      errorText   = "";
      render();
      return;
    }
    if (!force && rid === lastFileRid && candidates) {
      render();
      return;
    }
    loading = true;
    errorText = "";
    lastFileRid = rid;
    expanded = {};                  // collapse cards on a fresh fetch
    render();

    // Filter-aware: the GET endpoint accepts a `filters` query param so
    // the candidates reflect what the user has on screen, not the full
    // canonical frame. Mirror what the page table sends.
    const params = new URLSearchParams();
    const filter = ctx.activeFilter?.();
    if (filter) params.set("filters", JSON.stringify(filter));
    const qs = params.toString();
    const url = "/files/" + encodeURIComponent(rid) + "/joins" + (qs ? "?" + qs : "");

    try {
      candidates = await api.get(url);
    } catch (err) {
      candidates = null;
      errorText = "Could not detect joins: " + (err?.message || "request failed");
    } finally {
      loading = false;
      render();
    }
  }

  // Click delegate — show more / show less. (Multi-select + Apply land
  // in slice C against the same markup.)
  panelBody.addEventListener("click", (e) => {
    const moreBtn = e.target.closest(".rt-join-card__more");
    const lessBtn = e.target.closest(".rt-join-card__less");
    if (!moreBtn && !lessBtn) return;
    const card = (moreBtn || lessBtn).closest(".rt-join-card");
    const rid  = card?.dataset.otherRid;
    if (!rid) return;
    expanded[rid] = !!moreBtn;
    render();
  });

  // Kick the first fetch immediately — the lazy-mount caller
  // (workspace.js setToolsPanelTab) only calls mountJoins once the user
  // activates the Joins tab, so by definition we want candidates now.
  loadCandidates();
  return {
    /** Re-fetch candidates from the server. Called by the workspace when
     *  the active file changes (cached rid wins unless { force: true }). */
    refresh: () => loadCandidates({ force: true }),
  };
}
