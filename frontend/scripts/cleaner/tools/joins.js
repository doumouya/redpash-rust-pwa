// Joins tool — surfaces candidate join keys between the current file
// and every OTHER file in the same project, then lets the user create
// the joined dataset as a new project file (saved to disk + registered
// in `project_files`).
//
// Multiple candidates can be checked to build a COMPOUND key (e.g.
// `id` + `date` for exact match). The per-file "+ Create join" button
// uses every checked pair.

import { api } from "/scripts/api.js";

export function mount(ctx) {
  const { host } = ctx;
  let curRid       = ctx.rid;
  let curThisTitle = ctx.summary?.display_name ?? ctx.summary?.filename ?? "";
  // `getFilter()` returns the active table filter (FilterNode tree or
  // null) so detect + create operate on the visible subset, not the
  // full canonical frame.
  let getFilter    = ctx.getFilter ?? (() => null);

  const detect = document.createElement("button");
  detect.className = "rp-btn rp-btn--sm rp-btn--primary";
  detect.textContent = "Find join candidates";

  const out = document.createElement("div");
  out.className = "rp-joins";

  const help = document.createElement("p");
  help.className = "rp-muted rp-tools__hint";
  help.textContent = "Compares string columns across files in this project. Check one or more pairs to build a compound key, then click Create to materialise the joined dataset.";

  detect.addEventListener("click", async () => {
    detect.disabled = true;
    out.innerHTML = `<p class="rp-muted">Scanning…</p>`;
    try {
      const filter = getFilter();
      const qs = filter ? `?filters=${encodeURIComponent(JSON.stringify(filter))}` : "";
      const res = await api.get(`/files/${encodeURIComponent(curRid)}/joins${qs}`);
      render(out, res, curRid, curThisTitle, getFilter);
    } catch (err) {
      console.error("[joins] detect failed", err);
      out.innerHTML = `<p class="rp-muted">Detect failed: ${escapeHtml(err.message ?? String(err))}</p>`;
    } finally {
      detect.disabled = false;
    }
  });

  host.append(detect, out, help);

  return {
    update(ctx2) {
      curRid       = ctx2.rid;
      curThisTitle = ctx2.summary?.display_name ?? ctx2.summary?.filename ?? curThisTitle;
      if (ctx2.getFilter) getFilter = ctx2.getFilter;
      out.innerHTML = "";
    },
  };
}

function render(host, res, thisRid, thisTitle, getFilter) {
  if (!res.files?.length) {
    host.innerHTML = `<p class="rp-muted">No join candidates found. Make sure there are other files in this project sharing string-valued columns.</p>`;
    return;
  }
  host.innerHTML = res.files.map((f, fi) => `
    <article class="rp-joins__file" data-file-idx="${fi}">
      <header>${escapeHtml(f.title)}</header>
      ${f.candidates.map((c, ci) => `
        <label class="rp-joins__row">
          <input type="checkbox" data-pair="${fi}:${ci}"
                 data-this="${escapeAttr(c.this_col)}"
                 data-other="${escapeAttr(c.other_col)}" />
          <div class="rp-joins__row-body">
            <div class="rp-joins__pair">
              <code>${escapeHtml(c.this_col)}</code> ⇄ <code>${escapeHtml(c.other_col)}</code>
            </div>
            <div class="rp-joins__score">
              <strong>${Math.round(c.score * 100)}%</strong>
              <span class="rp-muted">· ${c.matches.toLocaleString()} match${c.matches === 1 ? "" : "es"}</span>
            </div>
            ${c.samples?.length ? `
              <div class="rp-joins__samples">
                ${c.samples.slice(0, 5).map((s) => `<span>${escapeHtml(s)}</span>`).join("")}
              </div>` : ""}
          </div>
        </label>
      `).join("")}
      <footer class="rp-joins__file-actions">
        <button class="rp-btn rp-btn--sm rp-btn--primary"
                data-create
                data-other-rid="${escapeAttr(f.redpash_id)}"
                data-other-title="${escapeAttr(f.title)}"
                disabled>+ Create join</button>
      </footer>
    </article>
  `).join("");

  host.addEventListener("change", (e) => {
    if (!e.target.matches('input[data-pair]')) return;
    const article = e.target.closest(".rp-joins__file");
    const checked = article.querySelectorAll('input[data-pair]:checked');
    const btn = article.querySelector("[data-create]");
    btn.disabled = checked.length === 0;
    btn.textContent = checked.length > 1
      ? `+ Create compound join (${checked.length})`
      : `+ Create join`;
  });

  host.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-create]");
    if (!btn) return;
    const article = btn.closest(".rp-joins__file");
    const checked = Array.from(article.querySelectorAll('input[data-pair]:checked'));
    if (!checked.length) return;
    openCreateDialog({
      thisRid,
      thisTitle,
      otherRid:   btn.dataset.otherRid,
      otherTitle: btn.dataset.otherTitle,
      thisCols:   checked.map((cb) => cb.dataset.this),
      otherCols:  checked.map((cb) => cb.dataset.other),
      filter:     getFilter?.() ?? null,
    });
  });
}

function openCreateDialog({ thisRid, thisTitle, otherRid, otherTitle, thisCols, otherCols, filter }) {
  const dlg = document.createElement("dialog");
  dlg.className = "rp-modal";
  const defaultName = `${stripExt(thisTitle)}__${stripExt(otherTitle)}_join.csv`;
  const keysHtml = thisCols.map((t, i) =>
    `<li><code>${escapeHtml(t)}</code> ⇄ <code>${escapeHtml(otherCols[i])}</code></li>`).join("");
  dlg.innerHTML = `
    <header class="rp-modal__head">
      <h2 class="rp-modal__title">Create join</h2>
      <button class="rp-modal__close" data-close aria-label="Close">×</button>
    </header>
    <div class="rp-modal__body rp-create-join">
      <p class="rp-muted">
        Joining <code>${escapeHtml(thisTitle)}</code> ⇄ <code>${escapeHtml(otherTitle)}</code>
        on ${thisCols.length === 1 ? "key" : `<strong>${thisCols.length} compound keys</strong>`}:
      </p>
      <ul class="rp-create-join__keys">${keysHtml}</ul>
      <label>
        <span>Join type</span>
        <select data-jt>
          <option value="inner">Inner (only matching rows)</option>
          <option value="left">Left (all rows from this file)</option>
          <option value="right">Right (all rows from the other)</option>
          <option value="outer">Outer (all rows from both)</option>
        </select>
      </label>
      <label>
        <span>New file name</span>
        <input class="rp-tools__input" data-name value="${escapeAttr(defaultName)}" />
      </label>
    </div>
    <footer class="rp-modal__actions">
      <button class="rp-btn" data-close>Cancel</button>
      <button class="rp-btn rp-btn--primary" data-submit>Create</button>
    </footer>
  `;
  document.body.appendChild(dlg);
  dlg.showModal();

  dlg.addEventListener("click", async (e) => {
    if (e.target.matches("[data-close]")) { close(); return; }
    if (e.target.matches("[data-submit]")) {
      const submit = dlg.querySelector('[data-submit]');
      submit.disabled = true;
      submit.textContent = "Creating…";
      try {
        const body = {
          other_file: otherRid,
          this_cols:  thisCols,
          other_cols: otherCols,
          join_type:  dlg.querySelector('[data-jt]').value,
          name:       dlg.querySelector('[data-name]').value || undefined,
          filters:    filter ?? undefined,
        };
        const env = await api.post(`/files/${encodeURIComponent(thisRid)}/joins`, body);
        const newRid = env.summary.redpash_id;
        close();
        if (confirm(`Created "${env.summary.filename}" with ${env.summary.row_count?.toLocaleString() ?? "?"} rows. Open it now?`)) {
          location.hash = `#/cleaner?file=${encodeURIComponent(newRid)}`;
          location.reload();
        }
      } catch (err) {
        console.error("[joins] create failed", err);
        submit.disabled = false;
        submit.textContent = "Create";
        alert(`Create join failed: ${err.message ?? err}`);
      }
    }
  });
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  function close() { dlg.close(); dlg.remove(); }
}

function stripExt(name) { return String(name).replace(/\.csv$/i, ""); }
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
