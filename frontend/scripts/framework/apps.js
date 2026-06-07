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
  // Home — the launcher landing ("My Services" grid) + the org hub. No page-nav
  // of its own (the grid IS the page); the topbar there is just the launcher.
  { id: "home", name: "Home", icon: "bi-house-door", landing: "#/home", pages: [] },

  // Studio — the data-work app. (Dashboard lands here as its own page in Slice D.)
  {
    id: "studio", name: "Studio", icon: "bi-easel", landing: "#/workspace",
    pages: [
      { id: "workspace", hash: "#/workspace", icon: "bi-stars",    label: "Workspace" },
      { id: "dashboard", hash: "#/dashboard", icon: "bi-bar-chart", label: "Dashboard" },
      { id: "sheetwise", hash: "#/sheetwise", icon: "bi-database",  label: "SheetWise" },
    ],
  },

  // Admin — platform-admin only (one RBAC boundary for the whole app). Monitoring
  // splits into Monitoring + Admin Console, and Database lands, in Slice B.
  {
    id: "admin", name: "Admin", icon: "bi-shield-lock", landing: "#/monitoring", admin: true,
    pages: [
      { id: "monitoring",    hash: "#/monitoring",    icon: "bi-activity",   label: "Monitoring" },
      { id: "admin-console", hash: "#/admin-console", icon: "bi-sliders",    label: "Admin Console" },
      { id: "database",      hash: "#/database",      icon: "bi-hdd-stack",  label: "Database" },
    ],
  },

  // Support & Docs — the help surfaces.
  {
    id: "support", name: "Support & Docs", icon: "bi-life-preserver", landing: "#/docs",
    pages: [
      { id: "docs",  hash: "#/docs",  icon: "bi-book-half", label: "Docs" },
      { id: "cases", hash: "#/cases", icon: "bi-kanban",    label: "Cases" },
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
    || APPS.find((a) => a.id === "home")
    || APPS[0]; // TOTAL by construction — the topbar reads `.id`/`.pages` on the
                // result on EVERY page, so never return undefined (a future
                // registry edit that drops the home entry can't blank every page).
}

/**
 * The apps a session may enter — admin apps require `is_platform_admin`.
 * @param {object|null} session
 * @returns {App[]}
 */
export function appsFor(session) {
  return APPS.filter((a) => !a.admin || session?.is_platform_admin);
}
