/* ━━━━━━━━━━━━━━━━━━ FILE REVIEW — RedPash Component Library ━━━━━━━━━━━━━━━━━━
 *
 * Client-side analyser + renderer for the post-upload file-review modal.
 * Works against the in-browser File API only — no server round-trip needed
 * for the demo. Companion to components/file-review.css.
 *
 * Two flows:
 *   handleFiles([file])          → single-file panel
 *   handleFiles([f1, f2, f3])    → multi-file tabbed panel
 *
 * Each analysed file becomes a `report` object:
 *   {
 *     filename, size, sizeBytes, rows, cols, cleanness,
 *     columns:    [{ name, null_count, null_pct, complete_pct, sample_unique }],
 *     duplicateRows, mixedDateCols, invalidValues,
 *     preview:    [[cell, cell, …], …],   // first 5 data rows
 *     header:     [colName, …]
 *   }
 *
 * Public API (all attached to window for inline onclick handlers):
 *   handleFiles(fileList)
 *   openFileReview(file)               — single-file shortcut
 *   switchFrTab(btnEl, paneId)         — multi-file tab switcher
 *   closeFileReview()                  — closes either panel
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

(function () {

  /* ───────────────────────── CSV PARSER (RFC-4180-ish) ─────────────────── */

  /**
   * Parse a single CSV line. Handles double-quoted fields and escaped quotes
   * ("" → "). Does NOT handle multi-line quoted fields — adequate for the
   * preview/sampling pass since we only consume "clean" lines.
   */
  function parseCsvLine(line, delim) {
    const cells = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQuotes = false;
        } else cur += ch;
      } else {
        if (ch === delim) { cells.push(cur); cur = ''; }
        else if (ch === '"' && cur === '') inQuotes = true;
        else cur += ch;
      }
    }
    cells.push(cur);
    return cells;
  }

  /** Sniff the most likely column delimiter from the first non-empty line. */
  function detectDelimiter(line) {
    const candidates = [',', ';', '\t', '|'];
    let best = ',', bestCount = -1;
    for (const d of candidates) {
      const n = (line.match(new RegExp('\\' + d, 'g')) || []).length;
      if (n > bestCount) { bestCount = n; best = d; }
    }
    return best;
  }

  /* ───────────────────────── ANALYSER ──────────────────────────────────── */

  const NULL_TOKENS = new Set(['', 'null', 'NULL', 'NaN', 'nan', 'N/A', 'n/a', 'NA', '???', '?', '-']);

  /** Try-parse `value` as a date and return a canonical format hint, or null. */
  function dateFormatHint(value) {
    if (!value) return null;
    if (/^\d{4}[-/]\d{2}[-/]\d{2}/.test(value))    return 'YYYY-MM-DD';
    if (/^\d{2}[-/]\d{2}[-/]\d{4}/.test(value))    return 'DD-MM-YYYY';
    if (/^\d{4}$/.test(value))                       return 'YYYY';
    return null;
  }

  /**
   * Analyse a File — returns a Promise<report>.
   * Reads the entire file (text); for very large files this is a memory cap
   * we accept for the demo. Samples up to 2000 data rows for per-column stats
   * then extrapolates null counts to the full file.
   */
  // Encoding sniff for uploaded bytes — same heuristic as the cleaner's
  // _detectEncoding (BOM first, UTF-8 strict probe, fallback to
  // windows-1252). Surfaced on the report so the file-review modal can
  // show a chip and warn the user when a non-UTF-8 file is detected.
  function detectEncoding(buffer) {
    const b = new Uint8Array(buffer);
    if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return 'utf-8';
    if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE)                  return 'utf-16le';
    if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF)                  return 'utf-16be';
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      return 'utf-8';
    } catch (e) {
      return 'windows-1252';
    }
  }

  async function analyseFile(file) {
    const buffer   = await file.arrayBuffer();
    const encoding = detectEncoding(buffer);
    let text;
    try        { text = new TextDecoder(encoding).decode(buffer); }
    catch (e)  { text = new TextDecoder('utf-8').decode(buffer); }
    const allLines = text.split(/\r?\n/);
    // Trim any trailing empty line from a final newline.
    while (allLines.length && !allLines[allLines.length - 1]) allLines.pop();
    if (allLines.length < 2) throw new Error('File appears empty or header-only');

    const delim    = detectDelimiter(allLines[0]);
    const header   = parseCsvLine(allLines[0], delim).map(h => h.trim());
    const colCount = header.length;
    const rowCount = allLines.length - 1;

    const SAMPLE = Math.min(rowCount, 2000);
    const columns = header.map(name => ({
      name,
      null_count: 0,
      sample_unique: new Set(),
      date_formats: new Set(),
      invalid_count: 0,
    }));

    const seenRowHashes = new Set();
    let duplicateRows = 0;

    for (let i = 1; i <= SAMPLE; i++) {
      const cells = parseCsvLine(allLines[i] || '', delim);

      // Duplicate detection (cheap row hash on the first 500 rows only)
      if (i <= 500) {
        const h = cells.join('');
        if (seenRowHashes.has(h)) duplicateRows++;
        else seenRowHashes.add(h);
      }

      for (let ci = 0; ci < colCount; ci++) {
        const v = (cells[ci] ?? '').trim();
        if (NULL_TOKENS.has(v)) {
          columns[ci].null_count++;
          if (v === '???' || v === '?') columns[ci].invalid_count++;
          continue;
        }
        if (columns[ci].sample_unique.size < 50) columns[ci].sample_unique.add(v);
        const fmt = dateFormatHint(v);
        if (fmt) columns[ci].date_formats.add(fmt);
      }
    }

    // Extrapolate column stats to the full file.
    const scale = rowCount / SAMPLE;
    columns.forEach(col => {
      col.null_count_est = Math.round(col.null_count * scale);
      col.null_pct       = (col.null_count / SAMPLE) * 100;
      col.complete_pct   = 100 - col.null_pct;
      col.mixed_dates    = col.date_formats.size > 1;
      col.invalid_est    = Math.round(col.invalid_count * scale);
      delete col.sample_unique;       // free memory
      delete col.date_formats;
    });

    const totalCells    = rowCount * colCount;
    const totalNullsEst = columns.reduce((s, c) => s + c.null_count_est, 0);
    const cleanness     = totalCells ? Math.round(((totalCells - totalNullsEst) / totalCells) * 100) : 0;
    const mixedDateCols = columns.filter(c => c.mixed_dates).length;
    const invalidValues = columns.reduce((s, c) => s + c.invalid_est, 0);

    const preview = [];
    for (let i = 1; i <= Math.min(5, rowCount); i++) preview.push(parseCsvLine(allLines[i] || '', delim));

    return {
      filename:      file.name,
      size:          formatSize(file.size),
      sizeBytes:     file.size,
      encoding,                                     // detected at upload
      rows:          rowCount,
      cols:          colCount,
      cleanness,
      columns,
      duplicateRows: Math.round(duplicateRows * (rowCount / Math.min(rowCount, 500))),
      mixedDateCols,
      invalidValues,
      preview,
      header,
      delimiter:     delim,
    };
  }

  function formatSize(bytes) {
    if (bytes < 1024)    return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  /* ───────────────────────── COLOR HELPERS ─────────────────────────────── */

  const cleanColor = pct =>
    pct >= 90 ? 'var(--green)' :
    pct >= 70 ? 'var(--yellow)' :
                'var(--red)';

  const scoreClass = pct =>
    pct >= 90 ? 'score-hi' :
    pct >= 70 ? 'score-mid' :
                'score-lo';

  /* ───────────────────────── SVG DONUT MATH ────────────────────────────── */

  /** Update the existing donut SVG (3 circles) to reflect a cleanness %. */
  function paintDonut(panel, pct) {
    const svgCircles = panel.querySelectorAll('.rp-fr-donut-center svg circle');
    if (svgCircles.length < 3) return;
    const circ  = 2 * Math.PI * 42;
    const green = (pct / 100) * circ;
    const rest  = circ - green;
    svgCircles[1].setAttribute('stroke-dasharray',  `${green.toFixed(1)} ${rest.toFixed(1)}`);
    svgCircles[1].setAttribute('stroke-dashoffset', '66');
    svgCircles[2].setAttribute('stroke-dasharray',  `${rest.toFixed(1)} ${green.toFixed(1)}`);
    svgCircles[2].setAttribute('stroke-dashoffset', String((-green + 66).toFixed(1)));

    const pctEl = panel.querySelector('.rp-fr-donut-pct');
    if (pctEl) { pctEl.textContent = pct + '%'; pctEl.style.color = cleanColor(pct); }
  }

  /* ───────────────────────── SINGLE-FILE RENDERER ──────────────────────── */

  /** Derive a friendly project name from a filename: drop the extension,
   *  swap separators for spaces, title-case the first letter of each word. */
  function defaultProjectName(filename) {
    const stem = filename.replace(/\.[^.]+$/, '').replace(/[_\-.]+/g, ' ').trim();
    return stem.replace(/\b([a-z])/g, m => m.toUpperCase());
  }

  /**
   * Mark a required-name input as valid/invalid. Updates the input border
   * (--accent vs --red), toggles the disabled state on the panel's "Open"
   * button, and adds aria-invalid for assistive tech.
   */
  function updateFrNameValidity(input) {
    const panel = input.closest('.rp-fr-panel');
    if (!panel) return;
    const valid = input.value.trim().length > 0;
    input.setAttribute('aria-invalid', String(!valid));
    input.style.borderColor = valid ? '' : 'var(--red)';
    const openBtn = panel.querySelector('.rp-fr-cta-open');
    if (openBtn) {
      openBtn.disabled = !valid;
      openBtn.style.opacity = valid ? '' : '0.5';
      openBtn.style.cursor  = valid ? '' : 'not-allowed';
    }
  }

  /** Render `report` into the single-file panel (#ul-review). */
  function renderSinglePanel(panel, report) {
    panel.style.display = '';

    // File bar
    const fname = panel.querySelector('.rp-fr-fname');
    if (fname) fname.textContent = report.filename;
    const fmeta = panel.querySelector('.rp-fr-fmeta');
    if (fmeta) {
      // Encoding chip — yellow when non-UTF-8 to flag a file the user
      // may want to verify (Latin-1 / CP1252 / UTF-16 etc.).
      const enc = (report.encoding || 'utf-8').toLowerCase();
      const isUtf8 = enc === 'utf-8' || enc === 'utf8';
      const chipBg = isUtf8 ? 'color-mix(in srgb, var(--green) 14%, transparent)'
                            : 'color-mix(in srgb, var(--yellow) 14%, transparent)';
      const chipCol = isUtf8 ? 'var(--green)' : 'var(--yellow)';
      const chipTtl = isUtf8 ? 'Detected encoding'
                             : 'Non-UTF-8 file — accents will be decoded as ' + enc;
      fmeta.innerHTML =
        `${report.rows.toLocaleString()} rows · ${report.cols} columns · ${report.size} · `
        + `<span title="${chipTtl}" style="display:inline-flex;align-items:center;gap:0.25rem;padding:0.0625rem 0.375rem;border-radius:0.625rem;background:${chipBg};color:${chipCol};font-size:0.625rem;font-weight:600">`
        +   `<i class="bi bi-${isUtf8 ? 'check2-circle' : 'exclamation-triangle-fill'}"></i> ${enc}`
        + `</span>`;
    }

    // Auto-fill project name from filename (only if user hasn't typed anything yet)
    const nameInput = panel.querySelector('#fr-project-name');
    if (nameInput && !nameInput.value.trim()) {
      nameInput.value = defaultProjectName(report.filename);
    }
    if (nameInput) updateFrNameValidity(nameInput);

    // Donut
    paintDonut(panel, report.cleanness);

    // Donut legend — replace contents with our analysed numbers
    const legend = panel.querySelector('.rp-fr-legend');
    if (legend) {
      const totalCells = report.rows * report.cols;
      const missing    = report.columns.reduce((s, c) => s + c.null_count_est, 0);
      const complete   = totalCells - missing;
      legend.innerHTML = `
        <div class="rp-fr-leg-item">
          <div class="rp-fr-leg-dot" style="background: var(--green)"></div>
          <span>Complete cells</span>
          <span class="rp-fr-leg-val" style="color: var(--green)">${complete.toLocaleString()}</span>
        </div>
        <div class="rp-fr-leg-item">
          <div class="rp-fr-leg-dot" style="background: var(--red)"></div>
          <span>Missing / invalid</span>
          <span class="rp-fr-leg-val" style="color: var(--red)">${missing.toLocaleString()}</span>
        </div>
        <div class="rp-fr-leg-item">
          <div class="rp-fr-leg-dot" style="background: var(--yellow)"></div>
          <span>Format warnings</span>
          <span class="rp-fr-leg-val" style="color: var(--yellow)">${report.mixedDateCols}</span>
        </div>`;
    }

    // Per-column hbars
    const hbars = panel.querySelector('.rp-fr-hbars');
    if (hbars) {
      hbars.innerHTML = report.columns.map(col => {
        const c   = col.complete_pct;
        const bc  = c >= 95 ? 'var(--green)' : c >= 80 ? 'var(--yellow)' : 'var(--red)';
        return `<div class="rp-fr-hbar-row">
          <span class="rp-fr-hbar-lbl" title="${escapeHtml(col.name)}">${escapeHtml(col.name)}</span>
          <div class="rp-fr-hbar-track"><div class="rp-fr-hbar-fill" style="width: ${c.toFixed(0)}%; background: ${bc}"></div></div>
          <span class="rp-fr-hbar-pct" style="color: ${bc}">${c.toFixed(0)}%</span>
        </div>`;
      }).join('');
    }

    // Issue counters
    const issues = panel.querySelector('.rp-fr-issues');
    if (issues) {
      const totalNulls = report.columns.reduce((s, c) => s + c.null_count_est, 0);
      issues.innerHTML = `
        <div class="rp-fr-issue">
          <i class="bi bi-copy" style="color: ${report.duplicateRows ? 'var(--yellow)' : 'var(--green)'}"></i>
          <div class="rp-fr-issue-body">
            <div class="rp-fr-issue-val" style="color: ${report.duplicateRows ? 'var(--yellow)' : 'var(--green)'}">${report.duplicateRows.toLocaleString()}</div>
            <div class="rp-fr-issue-lbl">Duplicate rows</div>
          </div>
        </div>
        <div class="rp-fr-issue">
          <i class="bi bi-slash-circle" style="color: ${totalNulls ? 'var(--red)' : 'var(--green)'}"></i>
          <div class="rp-fr-issue-body">
            <div class="rp-fr-issue-val" style="color: ${totalNulls ? 'var(--red)' : 'var(--green)'}">${totalNulls.toLocaleString()}</div>
            <div class="rp-fr-issue-lbl">Null / empty values</div>
          </div>
        </div>
        <div class="rp-fr-issue">
          <i class="bi bi-calendar-x" style="color: ${report.mixedDateCols ? 'var(--yellow)' : 'var(--green)'}"></i>
          <div class="rp-fr-issue-body">
            <div class="rp-fr-issue-val" style="color: ${report.mixedDateCols ? 'var(--yellow)' : 'var(--green)'}">${report.mixedDateCols ? 'Mixed' : 'OK'}</div>
            <div class="rp-fr-issue-lbl">Date formats</div>
          </div>
        </div>
        <div class="rp-fr-issue">
          <i class="bi bi-exclamation-diamond" style="color: ${report.invalidValues ? 'var(--yellow)' : 'var(--green)'}"></i>
          <div class="rp-fr-issue-body">
            <div class="rp-fr-issue-val" style="color: ${report.invalidValues ? 'var(--yellow)' : 'var(--green)'}">${report.invalidValues ? report.invalidValues.toLocaleString() : 'None'}</div>
            <div class="rp-fr-issue-lbl">Invalid values</div>
          </div>
        </div>`;
    }

    // Validation block — fill detected counts
    const detRows = panel.querySelector('[data-fr-detected-rows]');
    if (detRows) detRows.textContent = report.rows.toLocaleString();
    const detCols = panel.querySelector('[data-fr-detected-cols]');
    if (detCols) detCols.textContent = String(report.cols);

    // Preview table
    const previewTbl = panel.querySelector('[data-fr-preview]');
    if (previewTbl) {
      const headHtml = report.header.map(h => `<th style="padding:0.375rem 0.5rem;text-align:left;color:var(--text)">${escapeHtml(h)}</th>`).join('');
      const bodyHtml = report.preview.map(row => {
        return '<tr>' + row.map(cell => {
          const v   = cell ?? '';
          const cls = NULL_TOKENS.has(v.trim()) ? ' class="rp-fr-tag--err"' : '';
          return `<td${cls} style="padding:0.375rem 0.5rem">${escapeHtml(v)}</td>`;
        }).join('') + '</tr>';
      }).join('');
      previewTbl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:0.6875rem">
        <thead><tr style="background:var(--over0)">
          <th style="padding:0.375rem 0.5rem;text-align:left;color:var(--muted)">#</th>${headHtml}
        </tr></thead>
        <tbody style="color:var(--sub)">${
          bodyHtml.replace(/<tr>/g, (() => { let n = 0; return () => `<tr><td style="padding:0.375rem 0.5rem">${++n}</td>`; })())
        }</tbody>
      </table>`;
    }

    // Preview meta line
    const pmeta = panel.querySelector('[data-fr-preview-meta]');
    if (pmeta) pmeta.textContent = `Showing ${report.preview.length} of ${report.rows.toLocaleString()} · ${report.cols} columns · "${report.delimiter}" delimiter`;
  }

  /* ───────────────────────── MULTI-FILE RENDERER ──────────────────────── */

  /**
   * Build the multi-file tab bar + empty panes for `files`. Tabs and panes
   * are populated as each file's analysis completes (renderMultiPane).
   */
  function buildMultiModal(panel, files) {
    panel.style.display = '';
    const tabs = panel.querySelector('[data-fr-mf-tabs]');
    const body = panel.querySelector('[data-fr-mf-body]');
    if (!tabs || !body) return;

    const fnameEl = panel.querySelector('.rp-fr-fname');
    if (fnameEl) fnameEl.textContent = `${files.length} files selected`;
    const fmetaEl = panel.querySelector('.rp-fr-fmeta');
    if (fmetaEl) fmetaEl.textContent = 'Analysing…';

    // Auto-fill multi-file project name from the first file
    const nameInput = panel.querySelector('#fr-mf-project-name');
    if (nameInput && !nameInput.value.trim() && files[0]) {
      nameInput.value = defaultProjectName(files[0].name);
    }
    if (nameInput) updateFrNameValidity(nameInput);

    tabs.innerHTML = '<button class="rp-fr-tab active" data-pane="fr-mf-overview"><i class="bi bi-grid bi-sm"></i> Overview</button>'
      + files.map((f, i) =>
          `<button class="rp-fr-tab" data-pane="fr-mf-pane-${i}">
             <i class="bi bi-file-earmark-text bi-sm"></i>
             <span>${escapeHtml(f.name)}</span>
             <span class="rp-fr-tab-dot" data-fr-mf-dot="${i}"></span>
           </button>`
        ).join('');

    body.innerHTML =
      `<div id="fr-mf-overview" class="rp-fr-tab-pane active">
         <div data-fr-mf-overview><div style="color:var(--muted);font-size:0.8125rem"><i class="bi bi-hourglass-split bi-sm"></i> Analysing files…</div></div>
       </div>`
      + files.map((f, i) =>
          `<div id="fr-mf-pane-${i}" class="rp-fr-tab-pane">
             <div style="color:var(--muted);font-size:0.8125rem"><i class="bi bi-hourglass-split bi-sm"></i> Analysing ${escapeHtml(f.name)}…</div>
           </div>`
        ).join('');

    // Wire tab clicks (delegation)
    tabs.querySelectorAll('.rp-fr-tab').forEach(btn => {
      btn.addEventListener('click', () => switchFrTab(btn, btn.dataset.pane));
    });
  }

  /** Render one file's analysis into pane #idx. */
  function renderMultiPane(panel, idx, report) {
    const pane = panel.querySelector(`#fr-mf-pane-${idx}`);
    if (!pane) return;

    const totalNulls = report.columns.reduce((s, c) => s + c.null_count_est, 0);
    const circ  = 2 * Math.PI * 42;
    const green = (report.cleanness / 100) * circ;
    const rest  = circ - green;

    pane.innerHTML = `
      <div class="rp-fr-section-title">File quality report — ${escapeHtml(report.filename)}</div>
      <div class="rp-fr-report-grid">
        <div class="rp-fr-donut-wrap">
          <div class="rp-fr-donut-center">
            <svg viewBox="0 0 110 110" width="110" height="110">
              <circle cx="55" cy="55" r="42" fill="none" stroke="var(--over0)" stroke-width="14"/>
              <circle cx="55" cy="55" r="42" fill="none" stroke="var(--green)" stroke-width="14"
                      stroke-dasharray="${green.toFixed(1)} ${rest.toFixed(1)}" stroke-dashoffset="66"
                      transform="rotate(-90 55 55)"/>
              <circle cx="55" cy="55" r="42" fill="none" stroke="var(--red)" stroke-width="14"
                      stroke-dasharray="${rest.toFixed(1)} ${green.toFixed(1)}"
                      stroke-dashoffset="${(-green + 66).toFixed(1)}" transform="rotate(-90 55 55)"/>
            </svg>
            <div class="rp-fr-donut-label">
              <span class="rp-fr-donut-pct" style="color:${cleanColor(report.cleanness)}">${report.cleanness}%</span>
              <span class="rp-fr-donut-sub">complete</span>
            </div>
          </div>
          <div class="rp-fr-legend">
            <div class="rp-fr-leg-item"><div class="rp-fr-leg-dot" style="background: var(--green)"></div><span>${report.rows.toLocaleString()} rows</span></div>
            <div class="rp-fr-leg-item"><div class="rp-fr-leg-dot" style="background: var(--muted)"></div><span>${report.cols} columns</span></div>
          </div>
        </div>
        <div>
          <div class="rp-fr-section-title">Completeness by column</div>
          <div class="rp-fr-hbars">${report.columns.map(col => {
            const c  = col.complete_pct;
            const bc = c >= 95 ? 'var(--green)' : c >= 80 ? 'var(--yellow)' : 'var(--red)';
            return `<div class="rp-fr-hbar-row">
              <span class="rp-fr-hbar-lbl" title="${escapeHtml(col.name)}">${escapeHtml(col.name)}</span>
              <div class="rp-fr-hbar-track"><div class="rp-fr-hbar-fill" style="width:${c.toFixed(0)}%;background:${bc}"></div></div>
              <span class="rp-fr-hbar-pct" style="color:${bc}">${c.toFixed(0)}%</span>
            </div>`;
          }).join('')}</div>
        </div>
      </div>
      <div class="rp-fr-issues">
        <div class="rp-fr-issue"><i class="bi bi-copy"></i><div class="rp-fr-issue-body"><div class="rp-fr-issue-val">${report.duplicateRows.toLocaleString()}</div><div class="rp-fr-issue-lbl">Duplicate rows</div></div></div>
        <div class="rp-fr-issue"><i class="bi bi-slash-circle"></i><div class="rp-fr-issue-body"><div class="rp-fr-issue-val">${totalNulls.toLocaleString()}</div><div class="rp-fr-issue-lbl">Null / empty values</div></div></div>
      </div>`;

    // Tab dot color reflects cleanness
    const dot = panel.querySelector(`[data-fr-mf-dot="${idx}"]`);
    if (dot) dot.style.background = cleanColor(report.cleanness);
  }

  /** Render the overview pane summarising all analysed files. */
  function renderMultiOverview(panel, files, reports) {
    const ov = panel.querySelector('[data-fr-mf-overview]');
    if (!ov) return;

    const ok        = reports.filter(r => r && !r.error);
    const totalRows = ok.reduce((s, d) => s + d.rows, 0);
    const totalCols = ok.reduce((s, d) => s + d.cols, 0);
    const avgClean  = ok.length ? Math.round(ok.reduce((s, d) => s + d.cleanness, 0) / ok.length) : 0;
    const totalNul  = ok.reduce((s, d) => s + d.columns.reduce((a, c) => a + c.null_count_est, 0), 0);

    ov.innerHTML = `
      <div class="rp-fr-section-title" style="margin-bottom:0.75rem">${ok.length} file${ok.length !== 1 ? 's' : ''} analysed</div>
      <div class="rp-fr-mf-cards">${reports.map((d, i) => {
        const file = files[i];
        if (!d || d.error) {
          return `<div class="rp-fr-mf-card">
            <div class="rp-fr-mf-card-name" style="color:var(--red)"><i class="bi bi-exclamation-circle"></i> ${escapeHtml(file.name)}</div>
            <div class="rp-fr-mf-card-meta">Analysis failed</div>
          </div>`;
        }
        const c    = d.cleanness;
        const col  = cleanColor(c);
        const iss  = d.columns.reduce((s, x) => s + x.null_count_est, 0);
        return `<div class="rp-fr-mf-card">
          <div class="rp-fr-mf-card-name"><i class="bi bi-file-earmark-text" style="color:${col}"></i> ${escapeHtml(d.filename)}</div>
          <div class="rp-fr-mf-card-pct" style="color:${col}">${c}%</div>
          <div class="rp-fr-mf-card-meta">${d.rows.toLocaleString()} rows · ${d.cols} cols · ${d.size}</div>
          <div class="rp-fr-hbar-row" style="margin:0.125rem 0">
            <span class="rp-fr-hbar-lbl">Completeness</span>
            <div class="rp-fr-hbar-track"><div class="rp-fr-hbar-fill" style="width:${c}%;background:${col}"></div></div>
            <span class="rp-fr-hbar-pct" style="color:${col}">${c}%</span>
          </div>
          ${iss > 0
            ? `<span class="rp-fr-tag rp-fr-tag--warn"><i class="bi bi-exclamation-triangle bi-sm"></i> ${iss.toLocaleString()} issues</span>`
            : '<span class="rp-fr-tag rp-fr-tag--ok"><i class="bi bi-check2 bi-sm"></i> Clean</span>'}
        </div>`;
      }).join('')}</div>
      <div class="rp-fr-mf-summary">
        <div class="rp-fr-mf-sum-item"><span class="rp-fr-mf-sum-val">${totalRows.toLocaleString()}</span><span class="rp-fr-mf-sum-lbl">Total rows</span></div>
        <div class="rp-fr-mf-sum-item"><span class="rp-fr-mf-sum-val">${totalCols}</span><span class="rp-fr-mf-sum-lbl">Total columns</span></div>
        <div class="rp-fr-mf-sum-item"><span class="rp-fr-mf-sum-val" style="color:${cleanColor(avgClean)}">${avgClean}%</span><span class="rp-fr-mf-sum-lbl">Avg completeness</span></div>
        <div class="rp-fr-mf-sum-item"><span class="rp-fr-mf-sum-val" style="color:${totalNul > 0 ? 'var(--red)' : 'var(--green)'}">${totalNul.toLocaleString()}</span><span class="rp-fr-mf-sum-lbl">Total nulls</span></div>
      </div>
      ${ok.length > 1
        ? '<div class="rp-fr-mf-join-hint"><i class="bi bi-link-45deg"></i><span>Multiple files detected — RedPash can help link them by a shared key column in the cleaner.</span></div>'
        : ''}
    `;

    const fmetaEl = panel.querySelector('.rp-fr-fmeta');
    if (fmetaEl) fmetaEl.textContent = `${ok.length} of ${reports.length} ready`;
  }

  /* ───────────────────────── TAB SWITCHER ──────────────────────────────── */

  function switchFrTab(btn, paneId) {
    const panel = btn.closest('.rp-fr-panel');
    if (!panel) return;
    panel.querySelectorAll('.rp-fr-tab').forEach(t => t.classList.remove('active'));
    panel.querySelectorAll('.rp-fr-tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const pane = panel.querySelector('#' + paneId);
    if (pane) pane.classList.add('active');
  }

  /* ───────────────────────── PANEL ROUTER ──────────────────────────────── */

  async function handleFiles(files) {
    const list = Array.from(files).filter(f => /\.(csv|tsv)$/i.test(f.name));
    if (!list.length) { alert('Demo: only .csv / .tsv supported'); return; }

    const overlay  = document.getElementById('modal-ul-review');
    const single   = document.getElementById('ul-review');
    const multi    = document.getElementById('ul-review-multi');
    if (!overlay || !single || !multi) return;

    // Show overlay, pick the right panel
    overlay.classList.add('open');
    if (list.length === 1) {
      multi.style.display = 'none';
      single.style.display = '';
      try {
        const report = await analyseFile(list[0]);
        renderSinglePanel(single, report);
      } catch (err) {
        alert('Analysis failed: ' + err.message);
        overlay.classList.remove('open');
      }
    } else {
      single.style.display = 'none';
      buildMultiModal(multi, list);
      const reports = new Array(list.length).fill(null);
      // Analyse in parallel
      await Promise.all(list.map(async (f, i) => {
        try {
          reports[i] = await analyseFile(f);
          renderMultiPane(multi, i, reports[i]);
        } catch (err) {
          reports[i] = { error: err.message };
          const pane = multi.querySelector(`#fr-mf-pane-${i}`);
          if (pane) pane.innerHTML = `<div style="color:var(--red);font-size:0.8125rem"><i class="bi bi-exclamation-circle bi-sm"></i> ${escapeHtml(f.name)}: ${escapeHtml(err.message)}</div>`;
        }
      }));
      renderMultiOverview(multi, list, reports);
    }
  }

  function closeFileReview() {
    const overlay = document.getElementById('modal-ul-review');
    if (overlay) overlay.classList.remove('open');
  }

  /* ───────────────────────── UTILITIES ─────────────────────────────────── */

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  /* ───────────────────────── PUBLIC API ─────────────────────────────────── */

  window.handleFiles            = handleFiles;
  window.switchFrTab            = switchFrTab;
  window.closeFileReview        = closeFileReview;
  window.updateFrNameValidity   = updateFrNameValidity;
})();
