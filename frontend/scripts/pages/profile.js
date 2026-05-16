// Profile + Settings — full-bleed 2-step page mirroring page-home's
// scroll-snap pattern. Content ported from clarna-django #page-profile
// (step 1) and #page-settings (step 2); composition uses the
// redpash-components library glass aesthetic.
//
// Inline-onclick handlers wired here:
//   profileGoTo(step)            scroll to step 1 or 2
//   profilePhotoSelected(input)  avatar upload (stub)
//   profileUpgrade()             billing upgrade (stub)
//   profileDelete()              delete account (stub)
//
// Globals owned by main.js (shell): rpToggleTheme, rpSetTheme,
// openModal, closeModal, installPWA. doLogout is defined on /home,
// re-stubbed here so /profile works on cold-load too.

import { api }   from "/scripts/api.js";
import { toast } from "/scripts/ui/toast.js";
import { normalizeObjectTabs } from "/scripts/objects-catalog.js";

export default async function mount(root) {
  // ── Scroll-snap nav ─────────────────────────────────────────────
  window.profileGoTo = (step) => {
    const card = root.querySelector(`.hs-card[data-step="${step}"]`);
    card?.scrollIntoView({ behavior: "smooth", block: "start", inline: "start" });
  };

  // ── Stubs for bits without backend endpoints yet ────────────────
  window.profilePhotoSelected = (input) => {
    if (input.files?.length) input.value = "";
    toast.info("Avatar upload lands with Phase 6 (Stripe + billing).");
  };
  window.profileUpgrade = () => toast.info("Upgrade flow lands with Phase 6.");
  window.profileDelete  = () => toast.info("Account deletion lands with Phase 4c+.");
  window.profileCopyId  = async () => {
    const rid = root.querySelector("#profile-rid")?.value ?? "";
    if (!rid) return;
    try {
      await navigator.clipboard.writeText(rid);
      toast.success("Account ID copied.");
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access.");
    }
  };

  // Edit-mode toggle — the form starts locked. Click the pencil to
  // unlock; Save commits + re-locks; clicking the pencil again
  // discards anything not yet saved.
  window.profileToggleEdit = () => {
    const form = root.querySelector("#profile-form");
    const wasEditing = form.classList.contains("is-editing");
    setEditMode(root, !wasEditing);
  };

  // Defensive doLogout if main.js hasn't registered yet.
  if (!window.doLogout) {
    window.doLogout = async () => {
      try { await api.post("/auth/logout"); } catch {}
      location.hash = "#/landing";
      location.reload();
    };
  }
  if (!window.doContact) {
    window.doContact = () => toast.info("Contact form isn't wired yet — email hello@redpash.com.");
  }

  // ── Step-dot ↔ scroll-snap sync ────────────────────────────────
  const steps = root.querySelector("#profile-steps");
  const dots  = root.querySelectorAll(".rp-page-dot");
  const cards = root.querySelectorAll(".hs-card[data-step]");
  if (steps && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      const step = +visible.target.dataset.step;
      dots.forEach((d) => d.classList.toggle("active", +d.dataset.step === step));
    }, { root: steps, threshold: 0.5 });
    cards.forEach((c) => io.observe(c));
  }

  // ── Load /me + populate Step 1 ─────────────────────────────────
  let me;
  try { me = await api.get("/me"); }
  catch (err) { toast.error("Failed to load profile."); return; }

  populateIdentity(root, me);
  populateForm(root, me);
  populateConnections(root, me);

  // Form starts locked — user must click the pencil toggle to edit.
  setEditMode(root, false);

  // ── Use-case option pills ──────────────────────────────────────
  root.querySelectorAll("#profile-use-case .rp-set-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      root.querySelectorAll("#profile-use-case .rp-set-opt").forEach((p) => {
        p.classList.toggle("active", p === btn);
      });
    });
  });

  // ── Save (PATCH /me) ───────────────────────────────────────────
  const form = root.querySelector("#profile-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ucEl = root.querySelector("#profile-use-case .rp-set-opt.active");
    const body = {
      display_name: root.querySelector("#profile-display-name").value.trim() || null,
      job_title:    root.querySelector("#profile-job-title").value.trim()    || null,
      organisation: root.querySelector("#profile-organisation").value.trim() || null,
      use_case:     ucEl?.dataset.value ?? null,
    };
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const updated = await api.patch("/me", body);
      // Refresh identity header inline so name changes show without remount.
      root.querySelector("#profile-id-name").textContent  = updated.display_name ?? updated.username ?? "—";
      toast.success("Profile saved.");
      // Re-lock the form on success so the user can see the saved
      // state without accidentally typing into a "live" form.
      setEditMode(root, false);
    } catch (err) {
      toast.error(`Save failed: ${err.body?.error ?? err.message}`);
      btn.disabled = false;
    }
  });

  // ── Settings step — theme buttons active state ─────────────────
  syncThemeActive(root);
  // Watch <html data-theme> changes (e.g. via the float-bar toggle)
  // and re-sync the 3-state switcher.
  new MutationObserver(() => syncThemeActive(root))
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // ── Settings step — language pills ─────────────────────────────
  // localStorage is seeded from the account at login (see main.js
  // seedPrefsToLocalStorage), so reading it here gives the saved
  // choice; rpSavePref writes both localStorage AND the account.
  const lang = localStorage.getItem("redpash-lang") || "en";
  root.querySelectorAll("#settings-lang .rp-set-opt").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === lang);
    btn.addEventListener("click", () => {
      const choice = btn.dataset.lang;
      window.rpSavePref?.("language", choice);
      root.querySelectorAll("#settings-lang .rp-set-opt").forEach((p) => {
        p.classList.toggle("active", p === btn);
      });
      toast.info(`Language set to ${choice.toUpperCase()} — refresh /landing to see translations apply.`);
    });
  });

  // ── Settings step — Object tabs (multi-select) ─────────────────
  // Which object types appear as tabs on the Objects page — same pref
  // (prefs.objects_tabs) as the inline ×/+/drag on the Objects page,
  // so both surfaces stay in sync. MULTI-select: toggle each pill
  // independently; at least one tab must stay on. Active pills are
  // ALSO draggable — order maps to the visual order of the tabs on
  // the Objects page.
  wireObjectTabsPicker(root, me).catch(() => {});

  // ── Settings step — option pill groups (delimiter / encoding /
  //    export format). Each group persists its chosen `data-value`
  //    to the account via rpSavePref (which also mirrors to
  //    localStorage). localStorage is seeded from the account at
  //    login, so the restore read below reflects the saved choice on
  //    any browser. The actual delimiter / encoding / export pipeline
  //    reads these keys when those features wire up. ──
  const PREF_GROUPS = [
    { sel: "#settings-delimiter",     key: "rp-default-delimiter", pref: "default_delimiter" },
    { sel: "#settings-encoding",      key: "rp-default-encoding",  pref: "default_encoding"  },
    { sel: "#settings-export-format", key: "rp-export-format",     pref: "export_format"     },
  ];
  PREF_GROUPS.forEach(({ sel, key, pref }) => {
    const opts = root.querySelectorAll(`${sel} .rp-set-opt`);
    if (!opts.length) return;
    // Restore saved choice (or keep the partial's default-active pill).
    let saved = null;
    try { saved = localStorage.getItem(key); } catch {}
    if (saved) {
      opts.forEach((p) => p.classList.toggle("active", p.dataset.value === saved));
    }
    opts.forEach((btn) => {
      btn.addEventListener("click", () => {
        opts.forEach((p) => p.classList.toggle("active", p === btn));
        window.rpSavePref?.(pref, btn.dataset.value);
      });
    });
  });

  // ── Float-bar position pickers (topbar + footer) ───────────────
  // The actual class swap + persistence lives in main.js
  // (rpSetBarPos / rpRestoreBarPositions); profile.js just toggles
  // the active state on the pill buttons + dispatches to the shell.
  const wirePosPicker = (groupSel, rail, fallback) => {
    const saved = (() => {
      try { return localStorage.getItem(`rp-${rail}bar-pos`) ?? fallback; }
      catch { return fallback; }
    })();
    root.querySelectorAll(`${groupSel} .rp-set-opt`).forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.pos === saved);
      btn.addEventListener("click", () => {
        root.querySelectorAll(`${groupSel} .rp-set-opt`)
          .forEach((p) => p.classList.toggle("active", p === btn));
        window.rpSetBarPos?.(rail, btn.dataset.pos);
      });
    });
  };
  wirePosPicker("#settings-topbar-pos", "top",    "r");
  wirePosPicker("#settings-footer-pos", "bottom", "l");

  // ── Cleanness vocabulary — personal sentinel list + share toggle ──
  // Mirror of the Cleaner Fix-invalid modal's two prefs:
  //   prefs.learned_sentinels (canonical string[])
  //   prefs.share_sentinels   (bool | null)
  // Plus the cross-user `global_sentinels` set (read-only here) so we
  // can render the right provenance chip per row.
  wireSentinelSettings(root, me).catch(() => {});

  // ── Background palette preview ─────────────────────────────────
  // The toggle + 4 swatches in the Theme row are wired via inline
  // onclick handlers (rpToggleBgPreview / rpSetBgPalette in main.js).
  // Sync their visual state from localStorage now that the DOM is here.
  window.rpRestoreBgPreview?.();

  // ── Usage stats (fire-and-forget) ──────────────────────────────
  loadUsage(root).catch(() => {});
}

// Cleanness vocabulary card — chip list of personal sentinels + a
// share-with-everyone toggle. Both write `prefs.learned_sentinels` /
// `prefs.share_sentinels` via rpSavePref (the same PATCH /api/me path
// the Cleaner Fix-invalid modal uses), so the two surfaces stay in
// sync on every paint.
// Object-tabs picker — keeps order visible by reordering pills so the
// user's active set comes first in their preferred order, then the
// inactive ones in catalog order. Active pills are draggable; drop
// re-splices the order array and persists via rpSavePref. Clicking a
// pill toggles its active state without reordering.
async function wireObjectTabsPicker(root, me) {
  const grp = root.querySelector("#settings-object-tabs");
  if (!grp) return;
  const allOpts = [...grp.querySelectorAll(".rp-set-opt")];
  if (!allOpts.length) return;

  // Source of truth: a single array of active keys in display order.
  // Bootstrapped from prefs.objects_tabs.
  let order = normalizeObjectTabs(me.prefs?.objects_tabs);

  const reorderDom = () => {
    const activeSet = new Set(order);
    // Sort: active pills in `order` first, then inactive in catalog order.
    const sorted = [...allOpts].sort((a, b) => {
      const ai = order.indexOf(a.dataset.key);
      const bi = order.indexOf(b.dataset.key);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return allOpts.indexOf(a) - allOpts.indexOf(b);
    });
    // Re-attach in the new order + flip .active.
    sorted.forEach((el) => grp.appendChild(el));
    allOpts.forEach((b) => b.classList.toggle("active", activeSet.has(b.dataset.key)));
  };

  // Click → toggle on/off (min-1 guard). New activations land at the
  // END of the order; deactivations splice from wherever they were.
  allOpts.forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      // Drag end fires a click on some browsers — skip if we just dragged.
      if (btn.dataset.justDragged === "1") { delete btn.dataset.justDragged; return; }
      const key = btn.dataset.key;
      const isOn = order.includes(key);
      if (isOn && order.length === 1) {
        toast.info("Keep at least one object tab.");
        return;
      }
      if (isOn) order = order.filter((k) => k !== key);
      else      order.push(key);
      window.rpSavePref?.("objects_tabs", order);
      reorderDom();
    });
  });

  // Drag-to-reorder among active pills. Inactive pills aren't
  // draggable — they don't have a position in the order yet.
  let _dragKey = null;
  const setDraggable = () => {
    const activeSet = new Set(order);
    allOpts.forEach((b) => {
      const isActive = activeSet.has(b.dataset.key);
      b.draggable = isActive;
      if (!isActive) return;
      // Idempotent wire — addEventListener with the same fn dedupes.
      b.addEventListener("dragstart", onStart);
      b.addEventListener("dragover",  onOver);
      b.addEventListener("dragleave", onLeave);
      b.addEventListener("drop",      onDrop);
      b.addEventListener("dragend",   onEnd);
    });
  };
  const onStart = (e) => {
    const b = e.currentTarget;
    _dragKey = b.dataset.key;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", _dragKey); } catch {}
    b.classList.add("obj-tab-drag");
    // Mark so the synthetic click that fires on dragend doesn't toggle.
    b.dataset.justDragged = "1";
  };
  const onOver = (e) => {
    if (!_dragKey) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const b = e.currentTarget;
    if (b.dataset.key !== _dragKey) b.classList.add("obj-tab-drop");
  };
  const onLeave = (e) => e.currentTarget.classList.remove("obj-tab-drop");
  const onEnd = () => {
    grp.querySelectorAll(".obj-tab-drag, .obj-tab-drop")
       .forEach((el) => el.classList.remove("obj-tab-drag", "obj-tab-drop"));
    _dragKey = null;
  };
  const onDrop = (e) => {
    e.preventDefault();
    const targetKey = e.currentTarget.dataset.key;
    const sourceKey = _dragKey;
    onEnd();
    if (!sourceKey || !targetKey || sourceKey === targetKey) return;
    if (!order.includes(targetKey)) return;
    order = order.filter((k) => k !== sourceKey);
    const insertAt = order.indexOf(targetKey);
    order.splice(insertAt, 0, sourceKey);
    window.rpSavePref?.("objects_tabs", order);
    reorderDom();
    setDraggable();   // wiring is per-pill; new active pills don't auto-rewire
  };

  reorderDom();
  setDraggable();
}

async function wireSentinelSettings(root, me) {
  const list  = root.querySelector("#settings-sentinels-list");
  const share = root.querySelector("#settings-share-sentinels");
  if (!list || !share) return;

  // Working sets — mutated in-place by the chip-remove / share-toggle
  // handlers. Canonical (trim + lowercase) since the backend matches
  // case-insensitively.
  const learned = new Set(
    (Array.isArray(me.prefs?.learned_sentinels) ? me.prefs.learned_sentinels : [])
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean),
  );
  const global = new Set(
    (Array.isArray(me.global_sentinels) ? me.global_sentinels : [])
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean),
  );
  let consent = me.prefs?.share_sentinels;
  if (consent !== true && consent !== false) consent = null;

  const provenance = (canon) => {
    if (global.has(canon)) return ["global", "rp-sent-chip-prov--global"];
    if (consent === true)  return ["submitted", "rp-sent-chip-prov--submitted"];
    return ["learned", "rp-sent-chip-prov--learned"];
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));

  const renderList = () => {
    if (!learned.size) {
      list.innerHTML = `<div class="rp-sentinels-empty" style="font-size:0.75rem;color:var(--muted)">No personal sentinels yet — add them via the Cleaner's Fix invalid values modal.</div>`;
      return;
    }
    list.innerHTML = [...learned].sort().map((canon) => {
      const [provLbl, provCls] = provenance(canon);
      const title = provLbl === "global"
        ? "In the global vocabulary (≥2 users flagged it)"
        : provLbl === "submitted"
          ? "Submitted — will join the global vocabulary after 1 more user flags it"
          : "Personal-only — sharing is off";
      return `<span class="rp-sent-chip">
        <span class="rp-sent-chip-val">${esc(canon)}</span>
        <span class="rp-sent-chip-prov rp-sent-chip-prov--${provLbl}" title="${esc(title)}">${provLbl}</span>
        <button type="button" class="rp-sent-chip-rm" data-canon="${esc(canon)}" title="Remove from your personal list" aria-label="Remove ${esc(canon)}">×</button>
      </span>`;
    }).join("");
    list.querySelectorAll(".rp-sent-chip-rm").forEach((btn) => {
      btn.addEventListener("click", () => {
        const canon = btn.dataset.canon;
        if (!canon || !learned.delete(canon)) return;
        window.rpSavePref?.("learned_sentinels", [...learned]);
        renderList();
      });
    });
  };
  renderList();

  // Share toggle — three-state pref reduced to a two-button pill (On /
  // Off). The `null` "not yet asked" state is irrelevant once the user
  // lands here: clicking either button records an explicit choice and
  // the Cleaner's consent modal is bypassed forever after.
  const setActive = () => {
    share.querySelectorAll(".rp-set-opt").forEach((b) => {
      const matches = (b.dataset.value === "true"  && consent === true)
                   || (b.dataset.value === "false" && consent === false);
      b.classList.toggle("active", matches);
    });
  };
  setActive();
  share.querySelectorAll(".rp-set-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.value === "true";
      if (next === consent) return;
      consent = next;
      setActive();
      window.rpSavePref?.("share_sentinels", consent);
      // Provenance chips depend on the consent flag — re-paint.
      renderList();
    });
  });
}

function populateIdentity(root, me) {
  const av = root.querySelector("#profile-avatar");
  const initials = initialsFrom(me.display_name ?? me.username);
  if (me.avatar_url) {
    av.style.backgroundImage = `url("${me.avatar_url}")`;
    av.textContent = "";
  } else {
    av.textContent = initials;
  }
  root.querySelector("#profile-id-name").textContent  = me.display_name ?? me.username ?? "—";
  root.querySelector("#profile-id-email").textContent = me.email ?? "—";
  root.querySelector("#profile-plan-pill").textContent = labelForPlan(me.plan);
  root.querySelector("#profile-plan-name").textContent = labelForPlan(me.plan);
}

function populateForm(root, me) {
  root.querySelector("#profile-display-name").value = me.display_name ?? "";
  root.querySelector("#profile-username").value     = me.username ?? "";
  root.querySelector("#profile-email").value        = me.email ?? "";
  root.querySelector("#profile-job-title").value    = me.job_title ?? "";
  root.querySelector("#profile-organisation").value = me.organisation ?? "";
  root.querySelector("#profile-rid").value          = me.redpash_id ?? "";
  if (me.use_case) {
    root.querySelectorAll("#profile-use-case .rp-set-opt").forEach((p) => {
      p.classList.toggle("active", p.dataset.value === me.use_case);
    });
  }
}

function populateConnections(root, me) {
  const email   = me.email;
  const gEmail  = root.querySelector("#profile-google-email");
  const gState  = root.querySelector("#profile-google-state");
  if (email) {
    gEmail.textContent = email;
    gState.textContent = "Connected";
  } else {
    gEmail.textContent = "Not connected";
    gState.textContent = "Not connected";
    gState.style.cssText = ""; // drop the green styling
  }
  root.querySelector("#profile-billing-email").textContent = email ?? "—";
}

function syncThemeActive(root) {
  const cur = document.documentElement.getAttribute("data-theme") || "system";
  root.querySelectorAll(".rp-theme-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.theme === cur);
  });
}

async function loadUsage(root) {
  const [projects, reports, dashboards] = await Promise.allSettled([
    api.get("/projects"),
    api.get("/reports"),
    api.get("/dashboards"),
  ]);
  const proj  = projects.value?.items   ?? [];
  const rep   = reports.value?.items    ?? [];
  const dash  = dashboards.value?.items ?? [];
  const fileCount = proj.reduce((s, p) => s + (p.file_count ?? 0), 0);
  animateNumber(root.querySelector("#profile-usage-projects"),   proj.length);
  animateNumber(root.querySelector("#profile-usage-files"),      fileCount);
  animateNumber(root.querySelector("#profile-usage-reports"),    rep.length);
  animateNumber(root.querySelector("#profile-usage-dashboards"), dash.length);
}

// Lock / unlock the personal-info card.
//   editing = true  → editable inputs lose `readonly`, use-case pills
//                     become interactive, Save button enables, the
//                     toggle button reads "active" (accent fill +
//                     aria-pressed="true").
//   editing = false → reverse. Permanent-readonly inputs (username /
//                     email / redpash_id) are skipped because they
//                     don't have a `name` attribute.
function setEditMode(root, editing) {
  const form   = root.querySelector("#profile-form");
  const toggle = root.querySelector("#profile-edit-toggle");
  const save   = root.querySelector("#profile-save-btn");
  if (!form) return;

  form.classList.toggle("is-editing", editing);
  // Inputs with a `name` are the editable ones; readonly meta inputs
  // (username / email / Account ID) have no name and are skipped.
  form.querySelectorAll("input[name]").forEach((inp) => { inp.readOnly = !editing; });
  // Use-case pill group — disable interaction when locked.
  const grp = form.querySelector("#profile-use-case");
  if (grp) {
    grp.style.pointerEvents = editing ? "" : "none";
    grp.style.opacity       = editing ? "" : "0.55";
  }
  if (toggle) {
    toggle.classList.toggle("is-active", editing);
    toggle.setAttribute("aria-pressed", String(editing));
    toggle.title = editing ? "Lock fields" : "Edit mode";
  }
  if (save) save.disabled = !editing;
}

function initialsFrom(label) {
  return (label ?? "")
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase() || "··";
}
function labelForPlan(plan) {
  return plan === "pro" ? "Pro" : plan === "trial" ? "30-day trial" : "Free";
}
function animateNumber(el, to) {
  if (!el) return;
  const dur = 900;
  const start = performance.now();
  function step(now) {
    const p = Math.min((now - start) / dur, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(eased * to).toString();
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
