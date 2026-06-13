/* Purpose: App registry — the single source of truth for the multi-app model
   (Informatica "My Services"). Maps each app to its pages (the per-app topbar
   nav) + its RBAC gate. Consumed by topbar.js (per-app nav) and app-switcher.js
   (the launcher menu). One place to add an app or move a page between apps.
   Doc: docs/internal/code/frontend/scripts/framework/apps.md */
// ── App registry ────────────────────────────────────────────────────────────
// RedPash is a set of apps switched from a launcher; an app is both an RBAC
// boundary and a focused topbar (its nav shows only its own pages). This module
// holds the data; topbar.js + app-switcher.js render it.
//
// Slice A maps apps to TODAY's pages (no page-splits yet). Later slices add the
// new pages in place: Admin gets `admin-console` + `database` (Slice B), Studio
// gets `dashboard` (Slice D) — a one-line edit to the relevant `pages` array.
"use strict";

/**
 * @typedef {{ id:string, hash:string, icon:string, label:string }} AppPage
 * @typedef {{ id:string, name:string, icon:string, landing:string,
 *             admin?:boolean, pages:AppPage[] }} App
 */

/** @type {App[]} — ordered as they appear in the launcher. */
export const APPS = [
  // LEAN — one app, the personal data tool. No multi-tenant launcher / RBAC
  // boundary; the four data surfaces are the whole nav.
  {
    id: "studio", name: "RedPash", icon: "bi-easel", landing: "#/workspace",
    pages: [
      { id: "workspace",  hash: "#/workspace",  icon: "bi-stars",     label: "Workspace" },
      { id: "dashboard",  hash: "#/dashboard",  icon: "bi-bar-chart", label: "Dashboard" },
      { id: "sheetwise",  hash: "#/sheetwise",  icon: "bi-database",  label: "SheetWise" },
      { id: "monitoring", hash: "#/monitoring", icon: "bi-activity",  label: "Monitoring" },
    ],
  },
];

/**
 * The app that owns a page id (the `active` value a page passes to mountTopbar).
 * Utility pages (profile / settings) belong to no app → returns the Home app so
 * the topbar there is just the launcher (you jump back into an app from it).
 * @param {string} pageId
 * @returns {App}
 */
export function appForPage(pageId) {
  return APPS.find((a) => a.pages.some((p) => p.id === pageId))
    || APPS[0]; // TOTAL by construction — the topbar reads `.id`/`.pages` on the
                // result on EVERY page, so never return undefined.
}

/**
 * The apps a session may enter — admin apps require `is_platform_admin`.
 * @param {object|null} session
 * @returns {App[]}
 */
export function appsFor(session) {
  return APPS.filter((a) => !a.admin || session?.is_platform_admin);
}
