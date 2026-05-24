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
//   POST /api/files/:rid/joins  body:
//     { other_file, this_cols: [], other_cols: [], join_type,
//       filters? } — array-shape from day one (compound joins = N>1,
//     single-key = N=1, paired by position).
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
// Multi-select is markup-bounded to one card at a time (Gus's UX
// take #2): selected pairs live in a per-card map, and the Apply
// button is per-card so the "which other-file is the join target?"
// question is structurally answered by where the button lives.

import { api } from "/scripts/api.js";
import { esc, cssEsc } from "/scripts/dom.js";

const TOP_N = 5;

export function mountJoins(panelBody, ctx) {
  // ctx: { fileRid: () => string|null, activeFilter: () => FilterNode|null,
  //        onApplied: ({ newFileRid, projectRid, envelope }) => void }
  let candidates  = null;     // last fetched payload — { files: [...] } | null
  let loading     = false;
  let errorText   = "";       // non-empty when the last fetch failed
  let lastFileRid = null;     // detect when the active file changes
  let expanded    = {};       // { [other_rid]: true } — which cards show all candidates
  let selected    = {};       // { [other_rid]: Map<"this::other", { this_col, other_col }> }
  let joinType    = {};       // { [other_rid]: "inner" | "left" | "right" | "outer" }
  let applying    = null;     // other_rid being POSTed right now, blocks repeat clicks

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
    const rid    = file.redpash_id;
    const cands  = file.candidates || [];
    const isOpen = !!expanded[rid];
    const shown  = isOpen ? cands : cands.slice(0, TOP_N);
    const hidden = cands.length - shown.length;
    const sel    = selected[rid] || new Map();
    const jt     = joinType[rid] || "inner";
    const nSel   = sel.size;
    const ridAttr = ' data-other-rid="' + esc(rid) + '"';
    const isApplying = applying === rid;
    return ''
      + '<section class="rt-join-card"' + ridAttr + '>'
      +   '<header class="rt-join-card__head">'
      +     '<i class="bi bi-file-earmark-text"></i>'
      +     '<span class="rt-join-card__title">' + esc(file.title || rid) + '</span>'
      +     '<span class="rt-join-card__count">'
      +       cands.length + ' candidate' + (cands.length === 1 ? '' : 's')
      +     '</span>'
      +   '</header>'
      +   '<table class="rt-join-table">'
      +     '<thead><tr>'
      +       '<th class="is-pick"></th>'
      +       '<th class="is-strength" title="Overlap coefficient bucket"></th>'
      +       '<th>This file</th>'
      +       '<th>Other file</th>'
      +       '<th class="is-matches">Match</th>'
      +       '<th class="is-samples">Samples</th>'
      +     '</tr></thead>'
      +     '<tbody>' + shown.map((c) => renderCandRow(c, sel)).join("") + '</tbody>'
      +   '</table>'
      +   (hidden > 0
          ? '<button class="rt-btn rt-btn--text rt-join-card__more" type="button">'
            + 'Show ' + hidden + ' more</button>'
          : '')
      +   (isOpen && cands.length > TOP_N
          ? '<button class="rt-btn rt-btn--text rt-join-card__less" type="button">'
            + 'Show top ' + TOP_N + ' only</button>'
          : '')
      +   '<footer class="rt-join-card__foot">'
      +     '<span class="rt-join-card__hint">'
      +       (nSel === 0
            ? 'Tick a row to join · multiple = compound key'
            : nSel === 1
              ? '1 key selected'
              : nSel + ' keys selected (compound join)')
      +     '</span>'
      +     '<select class="rt-input rt-join-card__type" '
      +       (isApplying ? 'disabled ' : '') + 'aria-label="Join type">'
      +       renderJoinTypeOption("inner", "Inner", jt)
      +       renderJoinTypeOption("left",  "Left",  jt)
      +       renderJoinTypeOption("right", "Right", jt)
      +       renderJoinTypeOption("outer", "Outer", jt)
      +     '</select>'
      +     '<button class="rt-btn rt-btn--accent rt-join-card__apply" type="button"'
      +       ((nSel === 0 || isApplying) ? ' disabled' : '') + '>'
      +       (isApplying
            ? '<i class="bi bi-arrow-repeat"></i> Joining…'
            : '<i class="bi bi-link-45deg"></i> Apply join')
      +     '</button>'
      +   '</footer>'
      + '</section>';
  }

  function renderJoinTypeOption(value, label, active) {
    return '<option value="' + value + '"' + (active === value ? ' selected' : '') + '>' + label + '</option>';
  }

  function renderCandRow(c, sel) {
    // Score → dot-meter bucket. Overlap coefficient is in [0, 1].
    const dots = c.score >= 0.66 ? '●●●' : c.score >= 0.33 ? '●●○' : '●○○';
    const dotsClass = c.score >= 0.66 ? 'is-strong' : c.score >= 0.33 ? 'is-medium' : 'is-weak';
    const samples = (c.samples || []).slice(0, 3).map(esc).join(', ');
    const key = c.this_col + "::" + c.other_col;
    const isChecked = sel && sel.has(key);
    return ''
      + '<tr' + (isChecked ? ' class="is-picked"' : '') + '>'
      +   '<td class="is-pick">'
      +     '<input type="checkbox" class="rt-join-pick" '
      +       'data-this-col="' + esc(c.this_col) + '" '
      +       'data-other-col="' + esc(c.other_col) + '"'
      +       (isChecked ? ' checked' : '') + '>'
      +   '</td>'
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

  function cardRid(node) {
    return node?.closest(".rt-join-card")?.dataset.otherRid || null;
  }

  // Click delegate — show more/less + Apply.
  panelBody.addEventListener("click", (e) => {
    const moreBtn  = e.target.closest(".rt-join-card__more");
    const lessBtn  = e.target.closest(".rt-join-card__less");
    const applyBtn = e.target.closest(".rt-join-card__apply");
    if (moreBtn || lessBtn) {
      const rid = cardRid(moreBtn || lessBtn);
      if (!rid) return;
      expanded[rid] = !!moreBtn;
      render();
      return;
    }
    if (applyBtn && !applyBtn.disabled) {
      const rid = cardRid(applyBtn);
      if (rid) applyJoin(rid);
    }
  });

  // Change delegate — row checkboxes update the selected map, join-type
  // dropdown updates the per-card type. Local DOM tweak (toggle row
  // is-picked + foot hint) instead of a full re-render so checkboxes
  // stay focused / responsive on rapid toggling.
  panelBody.addEventListener("change", (e) => {
    const cb = e.target.closest(".rt-join-pick");
    if (cb) {
      const rid = cardRid(cb);
      if (!rid) return;
      const key = cb.dataset.thisCol + "::" + cb.dataset.otherCol;
      const sel = selected[rid] || (selected[rid] = new Map());
      if (cb.checked) sel.set(key, { this_col: cb.dataset.thisCol, other_col: cb.dataset.otherCol });
      else            sel.delete(key);
      // Row visual + foot hint update without a re-render.
      cb.closest("tr")?.classList.toggle("is-picked", cb.checked);
      updateCardFoot(rid);
      return;
    }
    const sel = e.target.closest(".rt-join-card__type");
    if (sel) {
      const rid = cardRid(sel);
      if (rid) joinType[rid] = sel.value;
    }
  });

  // In-place foot refresh — keeps checkbox state intact on toggle.
  function updateCardFoot(rid) {
    const card = panelBody.querySelector('.rt-join-card[data-other-rid="' + cssEsc(rid) + '"]');
    if (!card) return;
    const sel = selected[rid];
    const nSel = sel ? sel.size : 0;
    const hint = card.querySelector(".rt-join-card__hint");
    const apply = card.querySelector(".rt-join-card__apply");
    if (hint) {
      hint.textContent = nSel === 0
        ? "Tick a row to join · multiple = compound key"
        : nSel === 1 ? "1 key selected"
        : nSel + " keys selected (compound join)";
    }
    if (apply) apply.disabled = nSel === 0 || applying === rid;
  }

  async function applyJoin(rid) {
    if (applying) return;
    const baseRid = ctx.fileRid?.();
    if (!baseRid) return;
    const sel = selected[rid];
    if (!sel || sel.size === 0) return;
    const pairs = Array.from(sel.values());
    const body = {
      other_file: rid,
      this_cols:  pairs.map((p) => p.this_col),
      other_cols: pairs.map((p) => p.other_col),
      join_type:  joinType[rid] || "inner",
    };
    const filter = ctx.activeFilter?.();
    if (filter) body.filters = filter;

    applying = rid;
    render();
    try {
      const envelope = await api.post("/files/" + encodeURIComponent(baseRid) + "/joins", body);
      // Reset card state — the new file is now in the project, the user
      // will see it in the rail; cards re-fetch to pick up any new
      // cross-file candidate that includes the new join's columns.
      selected[rid] = new Map();
      joinType[rid] = "inner";
      applying = null;
      ctx.onApplied?.({
        newFileRid: envelope?.summary?.redpash_id || null,
        projectRid: envelope?.summary?.project_redpash_id || null,
        envelope,
      });
      // Re-fetch — sibling list now includes the new file (it can join
      // back against itself), and the active filter may have shifted.
      await loadCandidates({ force: true });
    } catch (err) {
      applying = null;
      errorText = "Join failed: " + (err?.message || "request failed");
      render();
    }
  }

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
