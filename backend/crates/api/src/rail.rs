//! Purpose: GET /api/rail/:view — the SERVER-DRIVEN navigation rail. ONE
//! resolver builds every page's left rail from a tiny server-side descriptor
//! map (`view -> RailView`), reach-filtered against the SAME principal closure
//! every list uses (projects.rs / files / objects.rs builtin_list, verbatim):
//! `viewer = None` ⇒ platform admin (no filter), else the caller's principals
//! threaded as a `$N::text[]` bind into the membership reach clause. Any authed
//! Caller — extraction IS the gate (mirrors types.rs / projects.rs); the rail
//! shows only what the caller can reach, so it never leaks foreign structure.
//!
//! Two descriptor modes (the "framework, not product" thesis — new pages add a
//! match arm, not a handler):
//!   - InstanceTree: groups = the caller's reach-filtered instances of a
//!     group_type; each group's tabs = reach-filtered leaf instances nested
//!     under it by scope_parent (project → its csv files). group.count = the
//!     number of reachable leaves under it; tab.kind = the leaf type.
//!   - TypeList: ONE "objects" group whose tabs ARE the types, each with a
//!     reach-scoped instance count (entity_data for custom types, the typed
//!     table for org builtins — reusing the objects.rs reach shapes).
//!
//! Today the only built InstanceTree is project → project_files; it is
//! special-cased here (the parent FK is project_id) while the descriptor stays
//! generic so the second tree (designer: chart/dashboard) is just a leaf_where.

use axum::{
    extract::{Path, State},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};

use crate::{
    error::AppError,
    rbac::{self, Caller},
    state::AppState,
};

pub fn routes() -> Router<AppState> {
    Router::new().route("/:view", get(rail))
}

// ─── the descriptor map ──────────────────────────────────────────────────────

/// A view's rail shape. The few STABLE views map to one of these; an unmapped
/// view falls through to the workspace InstanceTree (so pages light up with the
/// Browse rail before their own descriptor lands).
enum RailView {
    /// groups = reach-filtered instances of `group_type`; each group's tabs =
    /// reach-filtered `leaf_type` instances nested under it (scope_parent).
    /// `leaf_where` is an extra static predicate on the leaf table (e.g.
    /// `file_type = 'csv'`) — our own text, never user input.
    InstanceTree {
        group_type: &'static str,
        leaf_type: &'static str,
        leaf_where: Option<&'static str>,
    },
    /// ONE "objects" group whose tabs are the listed types (each a reach-scoped
    /// instance count). `OrgDynamic` = the org builtins + every custom type.
    TypeList(TypeListSpec),
    /// ONE "settings" group whose tabs are the DISTINCT field_group sections of
    /// the `preference` type's user-scope fields (the Settings page chrome,
    /// generated from the schema). No reach filter — prefs are the caller's own.
    PrefGroups,
    /// A STATIC list of the page's own sections (page chrome — not reach-filtered
    /// data, not schema-derived). ONE group (named `group`) whose tabs are the
    /// sections; the page's onRailTab scrolls the surface to the matching section
    /// (kind = "section"). For pages whose sections are heterogeneous (the
    /// Console: a role matrix, a field matrix, a policy form; Home: a launcher +
    /// recents) and so can't be schema-derived the way PrefGroups is. `items`
    /// tuples are (section_key, name, icon).
    Sections {
        group: &'static str,
        items: &'static [(&'static str, &'static str, &'static str)],
    },
}

enum TypeListSpec {
    /// The org builtins (user/company/team) PLUS every non-builtin type, in
    /// ordinal order (mirrors apps/admin/org/org.js's current filter).
    OrgDynamic,
    /// The data registry: OrgDynamic's set PLUS the data builtins (file/project),
    /// so the admin can browse + filter + delete the registry on the redtable.
    RegistryDynamic,
}

/// The org builtins that lead the org TypeList (matches org.js ORG_BUILTINS).
const ORG_BUILTINS: [&str; 3] = ["user", "company", "team"];

/// The data builtins the registry view adds on top of the org set.
const REGISTRY_EXTRA: [&str; 2] = ["file", "project"];

/// The Console's sections (key, name, icon). The keys MATCH console.js's
/// assemblePage `sections` so the rail's onRailTab can scroll the surface to
/// each. Declared here because the rail (R1) owns each view's shape.
const CONSOLE_SECTIONS: [(&str, &str, &str); 3] = [
    ("visibility", "App visibility", "bi-toggles2"),
    ("fields", "Objects & fields", "bi-table"),
    ("policies", "Policies", "bi-shield-lock"),
];

/// The Cases rail: workflow-stage filters (the kanban columns of the internal
/// workflow). "all" clears the filter; each other tab scopes the table to that
/// status, client-side (the page's onRailTab applies it). Static chrome (kind
/// "section"); Phase B's board reads the same stages. `id` MATCHES the status
/// enum value so the page can filter on it directly.
const CASE_STATUS_SECTIONS: [(&str, &str, &str); 6] = [
    ("all", "All cases", "bi-collection"),
    ("backlog", "Backlog", "bi-inbox"),
    ("todo", "To do", "bi-circle"),
    ("in_progress", "In progress", "bi-arrow-repeat"),
    ("in_review", "In review", "bi-eye"),
    ("done", "Done", "bi-check2-circle"),
];

/// `view -> RailView`. DEFAULT (any unmapped view) → the workspace InstanceTree,
/// so unmapped pages still get the Browse rail until their own descriptor lands.
fn descriptor(view: &str) -> RailView {
    match view {
        // The Browse data tree: projects → their CSV files.
        "workspace" => RailView::InstanceTree {
            group_type: "project",
            leaf_type: "file",
            leaf_where: Some("file_type = 'csv'"),
        },
        // The org admin surface: org builtins + custom types.
        "org" => RailView::TypeList(TypeListSpec::OrgDynamic),
        // The data registry: org set + file/project, browse/filter/delete.
        "registry" => RailView::TypeList(TypeListSpec::RegistryDynamic),
        // The Settings surface: one group, tabs = the preference type's
        // user-scope field_group sections (generated from the schema).
        "settings" => RailView::PrefGroups,
        // The Console: its own (heterogeneous) policy sections — static chrome.
        "console" => RailView::Sections { group: "Console", items: &CONSOLE_SECTIONS },
        // Cases: workflow-stage filter tabs (the kanban columns); the page scopes
        // the table to the clicked status client-side.
        "cases" => RailView::Sections { group: "Status", items: &CASE_STATUS_SECTIONS },
        // Designer (page not built yet) — projects → chart/dashboard files.
        "designer" => RailView::InstanceTree {
            group_type: "project",
            leaf_type: "chart", // tab.kind for the leaf family; see leaf_where
            leaf_where: Some("file_type IN ('chart', 'dashboard')"),
        },
        // Unmapped → the Browse rail.
        _ => RailView::InstanceTree {
            group_type: "project",
            leaf_type: "file",
            leaf_where: Some("file_type = 'csv'"),
        },
    }
}

// ─── the handler ─────────────────────────────────────────────────────────────

/// GET /api/rail/:view — the reach-filtered navigation tree for `view`. Any
/// authed caller; platform admin sees the unfiltered tree (viewer = None).
async fn rail(
    State(state): State<AppState>,
    caller: Caller,
    Path(view): Path<String>,
) -> Result<Json<Value>, AppError> {
    // viewer = None → admin (no reach filter); else the principal closure —
    // VERBATIM the projects.rs / files / objects.rs shape.
    let viewer: Option<Vec<String>> = if caller.is_platform_admin {
        None
    } else {
        Some(rbac::principals(&state.db, &caller.rid).await?)
    };

    let groups = match descriptor(&view) {
        RailView::InstanceTree { group_type, leaf_type, leaf_where } => {
            instance_tree(&state, viewer.as_deref(), group_type, leaf_type, leaf_where).await?
        }
        RailView::TypeList(spec) => type_list(&state, viewer.as_deref(), spec).await?,
        // Prefs are the caller's own — any authed Caller, no reach filter.
        RailView::PrefGroups => pref_groups(&state.db).await?,
        // Static page chrome — no DB, no reach filter.
        RailView::Sections { group, items } => sections_group(group, items),
    };

    Ok(Json(json!({ "groups": groups })))
}

/// The workspace (Browse) InstanceTree groups, built straight from a pool +
/// viewer closure — `pub` so the live-DB reach test exercises the EXACT SQL the
/// handler runs without booting HTTP (same posture as types::payload). `viewer`
/// = None ⇒ platform admin (no filter); Some(principals) ⇒ reach-filtered.
pub async fn workspace_tree_for(
    pool: &sqlx::PgPool,
    viewer: Option<&[String]>,
) -> Result<Vec<Value>, AppError> {
    instance_tree_inner(pool, viewer, "file", Some("file_type = 'csv'")).await
}

// ─── InstanceTree (project → project_files) ──────────────────────────────────

/// Handler-facing instance tree: guard the (only) built pairing, then delegate
/// to the pool-level builder. Today the only group_type is `project` and the
/// only leaf store is `project_files` (the parent FK is project_id), so that
/// pairing is special-cased; the descriptor stays generic so designer is just a
/// different `leaf_where`.
async fn instance_tree(
    state: &AppState,
    viewer: Option<&[String]>,
    group_type: &str,
    leaf_type: &str,
    leaf_where: Option<&str>,
) -> Result<Vec<Value>, AppError> {
    // The only built tree. Anything else is a not-yet-built descriptor — fail
    // loud rather than silently emit an empty rail.
    if group_type != "project" {
        return Err(AppError::internal(
            "rail",
            format!("instance tree group_type {group_type} not implemented"),
        ));
    }
    instance_tree_inner(&state.db, viewer, leaf_type, leaf_where).await
}

/// The project → project_files tree, built straight from a pool. Reach mirrors
/// files/mod.rs `list` EXACTLY — a leaf is reachable on membership of the file,
/// its project, or the project's company; a group (project) on the project or
/// its company (projects.rs `list`). group.count = the number of reachable
/// leaves under it.
async fn instance_tree_inner(
    pool: &sqlx::PgPool,
    viewer: Option<&[String]>,
    leaf_type: &str,
    leaf_where: Option<&str>,
) -> Result<Vec<Value>, AppError> {
    // The leaf predicate is OUR descriptor text (never user input), but
    // belt-and-braces it before it reaches SQL — the same posture type_cache /
    // objects.rs take with interpolated identifiers.
    let leaf_pred = match leaf_where {
        Some(w) => {
            assert!(
                w.chars().all(|c| c.is_ascii_alphanumeric()
                    || matches!(c, ' ' | '_' | '=' | '\'' | ',' | '(' | ')')),
                "unsafe leaf_where in rail descriptor: {w:?}"
            );
            format!("AND {w}")
        }
        None => String::new(),
    };

    // The leaf icon comes from the leaf TYPE's rail_icon (the descriptor's
    // declared leaf_type), with the type_definitions default fallback.
    let leaf_icon = rail_icon(pool, leaf_type).await?;

    // Projects reachable by the caller (reach = membership on the project or
    // its company — projects.rs `list`), each carrying the count of reachable
    // leaves under it. We also pull the project's rail_icon for the group.
    let group_icon = rail_icon(pool, "project").await?;
    let projects: Vec<(String, String)> = sqlx::query_as(
        "SELECT p.redpash_id, p.name
           FROM projects p
          WHERE ($1::text[] IS NULL OR EXISTS (
                    SELECT 1 FROM memberships m
                    WHERE m.member_redpash_id = ANY($1)
                      AND m.object_redpash_id IN (p.redpash_id, p.company_id)))
          ORDER BY p.created_at DESC",
    )
    .bind(viewer)
    .fetch_all(pool)
    .await?;

    let mut groups = Vec::with_capacity(projects.len());
    for (project_id, name) in projects {
        // Reachable leaves nested under THIS project. Reach mirrors files
        // `list` exactly (file / project / company membership), with the
        // descriptor's static leaf predicate.
        let leaves: Vec<(String, String, Option<f32>)> = sqlx::query_as(&format!(
            "SELECT pf.redpash_id, pf.filename, pf.cleanness_pct
               FROM project_files pf
               JOIN projects p ON p.redpash_id = pf.project_id
              WHERE pf.project_id = $1 {leaf_pred}
                AND ($2::text[] IS NULL OR EXISTS (
                        SELECT 1 FROM memberships m
                        WHERE m.member_redpash_id = ANY($2)
                          AND m.object_redpash_id IN (pf.redpash_id, pf.project_id, p.company_id)))
              ORDER BY pf.created_at DESC"
        ))
        .bind(&project_id)
        .bind(viewer)
        .fetch_all(pool)
        .await?;

        let tabs: Vec<Value> = leaves
            .into_iter()
            .map(|(rid, filename, c)| {
                // The cleanliness dot mirrors the score-badge tone; renamable +
                // hidable arm the rail's inline file actions. Omit "dot" (don't
                // emit null) when cleanness is unknown.
                let dot = dot_for(c);
                let mut tab = json!({
                    "id": rid,
                    "name": filename,
                    "icon": leaf_icon,
                    "kind": leaf_type,
                    "renamable": true,
                    "hidable": true,
                });
                if let Some(d) = dot {
                    tab["dot"] = json!(d);
                }
                tab
            })
            .collect();

        groups.push(json!({
            "id": project_id,
            "name": name,
            "icon": group_icon,
            "count": tabs.len(),
            "collapsed": false,
            "renamable": true,
            "hidable": true,
            "tabs": tabs,
        }));
    }

    Ok(groups)
}

// ─── TypeList (org: builtins + custom) ───────────────────────────────────────

/// Build the single-group type list. Tabs are the resolved types in ordinal
/// order, each with display_name_plural + rail_icon (from type_definitions) and
/// a reach-scoped instance count.
async fn type_list(
    state: &AppState,
    viewer: Option<&[String]>,
    spec: TypeListSpec,
) -> Result<Vec<Value>, AppError> {
    // type metadata in ordinal order (mirrors types.rs reading type_definitions
    // live; we add rail_icon to the SELECT here).
    let defs: Vec<(String, String, String, bool)> = sqlx::query_as(
        "SELECT type_id, display_name_plural, rail_icon, is_builtin
           FROM type_definitions ORDER BY ordinal",
    )
    .fetch_all(&state.db)
    .await?;

    let wanted: Vec<(String, String, String)> = match spec {
        // org builtins (user/company/team) + every custom (non-builtin) type,
        // ordinal order — exactly org.js's `ORG_BUILTINS.includes(t) || !t.is_builtin`.
        TypeListSpec::OrgDynamic => defs
            .into_iter()
            .filter(|(type_id, _, _, is_builtin)| {
                ORG_BUILTINS.contains(&type_id.as_str()) || !*is_builtin
            })
            .map(|(type_id, plural, icon, _)| (type_id, plural, icon))
            .collect(),
        // org set + the data builtins (file/project) — the registry superset.
        TypeListSpec::RegistryDynamic => defs
            .into_iter()
            .filter(|(type_id, _, _, is_builtin)| {
                ORG_BUILTINS.contains(&type_id.as_str())
                    || REGISTRY_EXTRA.contains(&type_id.as_str())
                    || !*is_builtin
            })
            .map(|(type_id, plural, icon, _)| (type_id, plural, icon))
            .collect(),
    };

    let mut tabs = Vec::with_capacity(wanted.len());
    for (type_id, plural, icon) in wanted {
        let count = type_count(state, viewer, &type_id).await?;
        tabs.push(json!({
            "id": type_id,
            "name": plural,
            "icon": icon,
            "kind": "type",
            "count": count,
        }));
    }

    Ok(vec![json!({
        "id": "objects",
        "name": "Objects",
        "collapsed": false,
        "tabs": tabs,
    })])
}

/// Reach-scoped instance count for one type. Org builtins (user/company/team)
/// count their TYPED table with the objects.rs builtin_list reach; every other
/// type counts entity_data with the objects.rs `list` reach (object_id /
/// scope_parent_id). Both are `$1::text[] IS NULL ⇒ admin, no filter`.
async fn type_count(
    state: &AppState,
    viewer: Option<&[String]>,
    type_id: &str,
) -> Result<i64, AppError> {
    let (table, reach) = match type_id {
        // VERBATIM the objects.rs org_builtin reach clauses (typed tables).
        "user" => (
            "users",
            "($1::text[] IS NULL OR t.redpash_id = ANY($1) OR EXISTS (
                SELECT 1 FROM memberships m
                WHERE m.member_redpash_id = ANY($1)
                  AND m.object_redpash_id = t.redpash_id))",
        ),
        "company" => (
            "companies",
            "($1::text[] IS NULL OR EXISTS (
                SELECT 1 FROM memberships m
                WHERE m.member_redpash_id = ANY($1)
                  AND m.object_redpash_id = t.redpash_id))",
        ),
        "team" => (
            "teams",
            "($1::text[] IS NULL OR EXISTS (
                SELECT 1 FROM memberships m
                WHERE m.member_redpash_id = ANY($1)
                  AND m.object_redpash_id IN (t.redpash_id, t.company_id)))",
        ),
        // Registry data builtins — VERBATIM the objects.rs org_builtin reaches.
        "file" => (
            "project_files",
            "(t.file_type = 'csv' AND ($1::text[] IS NULL OR EXISTS (
                SELECT 1 FROM memberships m
                WHERE m.member_redpash_id = ANY($1)
                  AND m.object_redpash_id IN (t.redpash_id, t.project_id,
                        (SELECT company_id FROM projects WHERE redpash_id = t.project_id)))))",
        ),
        "project" => (
            "projects",
            "($1::text[] IS NULL OR EXISTS (
                SELECT 1 FROM memberships m
                WHERE m.member_redpash_id = ANY($1)
                  AND m.object_redpash_id IN (t.redpash_id, t.company_id)))",
        ),
        // Custom types live in entity_data — the objects.rs `list` REACH.
        _ => {
            let count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*)::BIGINT FROM entity_data ed
                  WHERE ed.type_id = $2
                    AND ($1::text[] IS NULL OR EXISTS (
                            SELECT 1 FROM memberships m
                            WHERE m.member_redpash_id = ANY($1)
                              AND m.object_redpash_id IN (ed.object_id, ed.scope_parent_id)))",
            )
            .bind(viewer)
            .bind(type_id)
            .fetch_one(&state.db)
            .await?;
            return Ok(count);
        }
    };

    let count: i64 =
        sqlx::query_scalar(&format!("SELECT COUNT(*)::BIGINT FROM {table} t WHERE {reach}"))
            .bind(viewer)
            .fetch_one(&state.db)
            .await?;
    Ok(count)
}

// ─── PrefGroups (settings: the preference type's user-scope sections) ────────

/// Build the single "settings" group. Tabs are the DISTINCT `field_group`
/// values of the `preference` type's user-scope fields, in ordinal order —
/// the Settings page sections, generated from the schema. No reach filter:
/// prefs are the caller's own, so any authed Caller sees the same sections.
/// `pub` so a live-DB test can exercise the exact query without booting HTTP.
pub async fn pref_groups(pool: &sqlx::PgPool) -> Result<Vec<Value>, AppError> {
    // DISTINCT field_group in ordinal order. MIN(ordinal) orders each section
    // by its first field, so the section order tracks the field catalog.
    let groups: Vec<(String,)> = sqlx::query_as(
        "SELECT field_group
           FROM type_fields
          WHERE type_id = 'preference' AND scope = 'user'
          GROUP BY field_group
          ORDER BY MIN(ordinal)",
    )
    .fetch_all(pool)
    .await?;

    let tabs: Vec<Value> = groups
        .into_iter()
        .map(|(group,)| {
            json!({
                "id": group,
                "name": group,
                "kind": "prefgroup",
                "icon": "bi-sliders",
            })
        })
        .collect();

    Ok(vec![json!({
        "id": "settings",
        "name": "Settings",
        "collapsed": false,
        "tabs": tabs,
    })])
}

// ─── Sections (static page chrome — e.g. the Console) ────────────────────────

/// Build the single section-list group for a `Sections` view. No DB: the list
/// is static chrome from the descriptor. kind = "section" so the page's
/// onRailTab scrolls the surface to the matching section. The group is named
/// after the page (mirrors PrefGroups' "Settings"); the rail title already
/// carries the page name above it.
fn sections_group(
    group: &str,
    items: &'static [(&'static str, &'static str, &'static str)],
) -> Vec<Value> {
    let tabs: Vec<Value> = items
        .iter()
        .map(|(id, name, icon)| {
            json!({ "id": id, "name": name, "icon": icon, "kind": "section" })
        })
        .collect();

    vec![json!({
        "id": "sections",
        "name": group,
        "collapsed": false,
        "tabs": tabs,
    })]
}

/// The cleanliness dot token for a file leaf, matching the score-badge tone
/// thresholds exactly: >= 90 clean, >= 70 warn, else dirty. None (no score yet)
/// ⇒ None — the caller OMITS the "dot" key rather than emitting a null.
fn dot_for(pct: Option<f32>) -> Option<&'static str> {
    pct.map(|c| {
        if c >= 90.0 {
            "clean"
        } else if c >= 70.0 {
            "warn"
        } else {
            "dirty"
        }
    })
}

/// A type's rail_icon from type_definitions, with a sane fallback if the seed
/// left it blank (the column DEFAULTs to '').
async fn rail_icon(pool: &sqlx::PgPool, type_id: &str) -> Result<String, AppError> {
    let icon: Option<String> =
        sqlx::query_scalar("SELECT rail_icon FROM type_definitions WHERE type_id = $1")
            .bind(type_id)
            .fetch_optional(pool)
            .await?;
    Ok(icon.filter(|s| !s.is_empty()).unwrap_or_else(|| "bi-file-earmark".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unmapped_view_falls_through_to_workspace_tree() {
        // Any unknown view gets the Browse InstanceTree (org/settings/console
        // are now mapped — see mapped_views_pick_their_mode).
        for v in ["totally-unknown", "monitoring", ""] {
            match descriptor(v) {
                RailView::InstanceTree { group_type, leaf_type, leaf_where } => {
                    assert_eq!(group_type, "project");
                    assert_eq!(leaf_type, "file");
                    assert_eq!(leaf_where, Some("file_type = 'csv'"));
                }
                _ => panic!("{v} should fall through to the workspace InstanceTree"),
            }
        }
    }

    #[test]
    fn mapped_views_pick_their_mode() {
        assert!(matches!(descriptor("org"), RailView::TypeList(TypeListSpec::OrgDynamic)));
        assert!(matches!(descriptor("settings"), RailView::PrefGroups));
        assert!(matches!(
            descriptor("workspace"),
            RailView::InstanceTree { leaf_type: "file", .. }
        ));
        assert!(matches!(
            descriptor("designer"),
            RailView::InstanceTree { leaf_where: Some("file_type IN ('chart', 'dashboard')"), .. }
        ));
        // Console maps to its static section list (the three policy sections).
        match descriptor("console") {
            RailView::Sections { group, items } => {
                assert_eq!(group, "Console");
                assert_eq!(items.iter().map(|s| s.0).collect::<Vec<_>>(),
                    ["visibility", "fields", "policies"]);
            }
            _ => panic!("console should map to Sections"),
        }
    }

    #[test]
    fn dot_for_thresholds_track_the_score_badge_tone() {
        // Spot scores per band, plus the exact boundaries (>= 90 clean,
        // >= 70 warn, below warn → dirty) and the no-score → no-dot rule.
        assert_eq!(dot_for(Some(95.0)), Some("clean"));
        assert_eq!(dot_for(Some(75.0)), Some("warn"));
        assert_eq!(dot_for(Some(10.0)), Some("dirty"));
        assert_eq!(dot_for(Some(90.0)), Some("clean"));
        assert_eq!(dot_for(Some(70.0)), Some("warn"));
        assert_eq!(dot_for(Some(69.9)), Some("dirty"));
        assert_eq!(dot_for(None), None);
    }

    #[test]
    fn org_dynamic_keeps_builtins_and_drops_non_org_builtins() {
        // Mirror of the org.js filter on the seeded registry shape: org
        // builtins kept, project/file/chart/dashboard/case/connection dropped
        // (all builtin, none in ORG_BUILTINS); a custom type would be kept.
        let seeded = [
            ("user", true),
            ("company", true),
            ("team", true),
            ("project", true),
            ("file", true),
            ("chart", true),
            ("dashboard", true),
            ("case", true),
            ("connection", true),
            ("widget", false), // a hypothetical custom type
        ];
        let kept: Vec<&str> = seeded
            .iter()
            .filter(|(t, is_builtin)| ORG_BUILTINS.contains(t) || !*is_builtin)
            .map(|(t, _)| *t)
            .collect();
        assert_eq!(kept, ["user", "company", "team", "widget"]);
    }
}
