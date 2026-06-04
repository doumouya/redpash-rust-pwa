/* Purpose: Profile record view — the User object's record page (rp-head + editable fields + memberships + plan + connections).
   Doc: docs/internal/code/frontend/scripts/framework/profile-record.md */
// ── Profile record (framework page-component, CAS_37B2E1BF) ──────────────────
// The User object's RECORD page — the detail view that opens from a Home Users
// row (Em's reframe). COMPOSES, owns almost no markup:
//   • header = rp-avatar-upload (editable picture) + rp-head (USR_ rid pill +
//     click-to-edit display name).
//   • Details = every UserProfile field as an rp-field row — editable ones an
//     rp-input (commit → onPatch(key,value)), read-only ones a value span.
//   • Memberships = the simple-table related list (company · role) from UserMembership.
//   • Plan = an rp-field whose control is a plan badge + an Upgrade button.
//   • Connections = rp-field rows (Google live + MFA / SSO / Okta as "Soon" badges).
// Render-first: onPatch / onAvatarFile / onUpgrade are the seams the live Profile
// page wires (PATCH /users {field|avatar_url}). CSS: styles/framework/profile-record.css.
//
// SECURITY: every interpolated value is esc()'d; field values are read from live
// inputs; the avatar URL is sanitised by avatar-upload.
"use strict";

import { register, get } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";
import { mountHead } from "/scripts/framework/head.js";
import { mountField } from "/scripts/framework/field.js";
import { mountAvatarUpload } from "/scripts/framework/avatar-upload.js";
import { badgeHTML } from "/scripts/framework/badge.js";

// The editable surface of UserProfile. read-only fields (server-assigned) show a
// value; the rest render an editable rp-input. field_perms is the live authority;
// this mirrors PATCH /users.
const FIELDS = [
  { key: "username",     label: "Handle",       readonly: true },
  { key: "email",        label: "Email",        readonly: true, type: "email" },
  { key: "first_name",   label: "First name" },
  { key: "last_name",    label: "Last name" },
  { key: "job_title",    label: "Job title" },
  { key: "organisation", label: "Organisation" },
  { key: "use_case",     label: "Use case" },
  { key: "locale",       label: "Locale" },
];

const CONNECTIONS = [
  { name: "Google",                detail: "OAuth sign-in",     label: "Connected", tone: "ok" },
  { name: "MFA / Authenticator",   detail: "Two-factor auth",   label: "Soon",      tone: "soon" },
  { name: "Corporate SSO / Okta",  detail: "SAML / OIDC",       label: "Soon",      tone: "soon" },
];

function group(title) {
  return '<div class="rp-field-group"><div class="rp-field-group-title">' + esc(title) + '</div>'
    + '<div data-slot="' + esc(title.toLowerCase()) + '"></div></div>';
}

export function mountProfileRecord(host, opts = {}) {
  if (!host) return null;
  const u = opts.user || {};
  const memberships = Array.isArray(opts.memberships) ? opts.memberships : (u.memberships || []);
  const onPatch = typeof opts.onPatch === "function" ? opts.onPatch : function () {};

  host.classList.add("rp-profile-record");   // preserve any host class (e.g. .rp-surface from the page frame)
  host.innerHTML =
      '<div class="rp-profile-head"><div data-slot="avatar"></div><div data-slot="idtitle"></div></div>'
    + group("Details") + group("Memberships") + group("Plan") + group("Connections");

  // ── header: avatar-upload + rp-head ─────────────────────────────────────────
  mountAvatarUpload(host.querySelector('[data-slot="avatar"]'), {
    name: u.display_name, src: u.avatar_url, size: "lg", onFile: opts.onAvatarFile,
  });
  mountHead(host.querySelector('[data-slot="idtitle"]'), {
    objectId: u.redpash_id, title: u.display_name || "—", editable: true,
    onTitleEdit: (v) => onPatch("display_name", v),
    shortenId: (id) => (id.length > 16 ? id.slice(0, 12) + "…" : id),
  });

  // ── details: every UserProfile field as an rp-field ─────────────────────────
  const details = host.querySelector('[data-slot="details"]');
  FIELDS.forEach((f) => {
    const row = document.createElement("div"); details.appendChild(row);
    const val = u[f.key] != null ? String(u[f.key]) : "";
    mountField(row, {
      label: f.label,
      mount: (slot) => {
        if (f.readonly) { slot.innerHTML = '<span class="rp-field-value">' + esc(val || "—") + '</span>'; return; }
        const inp = document.createElement("input");
        inp.className = "rp-input"; inp.type = f.type || "text"; inp.value = val; inp.placeholder = "—";
        inp.addEventListener("change", () => onPatch(f.key, inp.value));
        slot.appendChild(inp);
      },
    });
  });

  // ── memberships: simple-table related list ──────────────────────────────────
  const memSlot = host.querySelector('[data-slot="memberships"]');
  const mountTable = get("table");
  if (mountTable && memberships.length) {
    mountTable(memSlot, {
      columns: [{ key: "company_name", label: "Company" }, { key: "role", label: "Role", kind: "status" }],
      rows: memberships, empty: "No memberships.",
    });
  } else {
    memSlot.innerHTML = '<p class="rp-empty">No memberships yet.</p>';
  }

  // ── plan: a field whose control is a badge + Upgrade ────────────────────────
  mountField(host.querySelector('[data-slot="plan"]'), {
    label: "Current plan", hint: "Pricing & tiers are still being finalised.",
    mount: (slot) => {
      slot.classList.add("rp-profile-plan-control");
      slot.innerHTML = badgeHTML({ label: u.plan || "Free", tone: "accent" })
        + '<button type="button" class="rp-btn rp-profile-upgrade"><i class="bi bi-arrow-up-circle"></i> Upgrade</button>';
      const up = slot.querySelector(".rp-profile-upgrade");
      if (up) up.addEventListener("click", () => { if (typeof opts.onUpgrade === "function") opts.onUpgrade(); });
    },
  });

  // ── connections: rp-field rows, future-proofed ──────────────────────────────
  const conns = host.querySelector('[data-slot="connections"]');
  CONNECTIONS.forEach((c) => {
    const row = document.createElement("div"); conns.appendChild(row);
    const detail = c.name === "Google" && u.email ? u.email : c.detail;
    mountField(row, { label: c.name, hint: detail, html: badgeHTML({ label: c.label, tone: c.tone }) });
  });

  return { el: host };
}

register("profile-record", mountProfileRecord);
