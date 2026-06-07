---
title: "code/ — navigation back-index"
section: Internal
last modified date: 2026-06-07
---

# `code/` — atomic-doc back-index

The generated index of the per-file survival layer (see [index.md](index.md)
for the source→doc mapping rule + how to author one). Do not hand-edit the
generated block — run `node tools/doc-gen/gen.js --code-nav`.

<!-- doc-gen:code-nav START — generated from the code/ doc tree; do not hand-edit -->
Generated 2026-06-07 — every atomic doc under `code/`, the per-file
survival layer (247 docs). Links are relative to `code/`.

### backend (105)

**backend/api/bin/**
- [audit_distincts.md](backend/api/bin/audit_distincts.md)
- [audit_ingest.md](backend/api/bin/audit_ingest.md)

**backend/api/**
- [bootstrap.md](backend/api/bootstrap.md)
- [codec_avro.md](backend/api/codec_avro.md)
- [codec_registry.md](backend/api/codec_registry.md)

**backend/api/db/**
- [connectors.md](backend/api/db/connectors.md)
- [entities.md](backend/api/db/entities.md)
- [mod.md](backend/api/db/mod.md)
- [projects.md](backend/api/db/projects.md)
- [sentinels.md](backend/api/db/sentinels.md)
- [sessions.md](backend/api/db/sessions.md)
- [users.md](backend/api/db/users.md)

**backend/api/**
- [db_query.md](backend/api/db_query.md)
- [error.md](backend/api/error.md)
- [event.md](backend/api/event.md)
- [field_perms.md](backend/api/field_perms.md)
- [field_validate.md](backend/api/field_validate.md)
- [id.md](backend/api/id.md)
- [kafka_loader.md](backend/api/kafka_loader.md)
- [main.md](backend/api/main.md)
- [mysql_loader.md](backend/api/mysql_loader.md)
- [pipeline.md](backend/api/pipeline.md)
- [rbac.md](backend/api/rbac.md)
- [redact.md](backend/api/redact.md)
- [request_log.md](backend/api/request_log.md)

**backend/api/routes/**
- [admin.md](backend/api/routes/admin.md)
- [auth.md](backend/api/routes/auth.md)
- [cases.md](backend/api/routes/cases.md)
- [charts.md](backend/api/routes/charts.md)
- [companies.md](backend/api/routes/companies.md)
- [connectors.md](backend/api/routes/connectors.md)
- [dashboards.md](backend/api/routes/dashboards.md)
- [demo.md](backend/api/routes/demo.md)
- [docs.md](backend/api/routes/docs.md)
- [events.md](backend/api/routes/events.md)

**backend/api/routes/files/**
- [joins.md](backend/api/routes/files/joins.md)
- [meta.md](backend/api/routes/files/meta.md)
- [mod.md](backend/api/routes/files/mod.md)
- [output.md](backend/api/routes/files/output.md)
- [sql.md](backend/api/routes/files/sql.md)
- [state_ops.md](backend/api/routes/files/state_ops.md)
- [stats.md](backend/api/routes/files/stats.md)

**backend/api/routes/**
- [group.md](backend/api/routes/group.md)
- [health.md](backend/api/routes/health.md)
- [me.md](backend/api/routes/me.md)
- [members.md](backend/api/routes/members.md)
- [metrics.md](backend/api/routes/metrics.md)
- [mod.md](backend/api/routes/mod.md)
- [monitoring.md](backend/api/routes/monitoring.md)
- [objects.md](backend/api/routes/objects.md)
- [pagination.md](backend/api/routes/pagination.md)
- [projects.md](backend/api/routes/projects.md)
- [search.md](backend/api/routes/search.md)
- [teams.md](backend/api/routes/teams.md)
- [users.md](backend/api/routes/users.md)

**backend/api/**
- [state.md](backend/api/state.md)
- [type_cache.md](backend/api/type_cache.md)
- [type_registry.md](backend/api/type_registry.md)
- [validate_expr.md](backend/api/validate_expr.md)
- [validate_rules.md](backend/api/validate_rules.md)

**backend/data/**
- [clean.md](backend/data/clean.md)
- [dedup.md](backend/data/dedup.md)
- [distinct.md](backend/data/distinct.md)
- [dtype.md](backend/data/dtype.md)
- [encoding.md](backend/data/encoding.md)

**backend/data/examples/**
- [clean_dir.md](backend/data/examples/clean_dir.md)
- [score_dir.md](backend/data/examples/score_dir.md)
- [sql_spike.md](backend/data/examples/sql_spike.md)
- [tools_check.md](backend/data/examples/tools_check.md)

**backend/data/**
- [export.md](backend/data/export.md)
- [group_by.md](backend/data/group_by.md)
- [joins.md](backend/data/joins.md)
- [lib.md](backend/data/lib.md)

**backend/data/parse/**
- [filter.md](backend/data/parse/filter.md)
- [mod.md](backend/data/parse/mod.md)
- [sniff.md](backend/data/parse/sniff.md)

**backend/data/**
- [render.md](backend/data/render.md)
- [sql.md](backend/data/sql.md)
- [stats.md](backend/data/stats.md)

**backend/data/steps/**
- [cells.md](backend/data/steps/cells.md)
- [columns.md](backend/data/steps/columns.md)
- [mod.md](backend/data/steps/mod.md)
- [rows.md](backend/data/steps/rows.md)
- [structure.md](backend/data/steps/structure.md)
- [util.md](backend/data/steps/util.md)

**backend/data/**
- [structure.md](backend/data/structure.md)
- [wasm.md](backend/data/wasm.md)

**backend/shared/**
- [admin.md](backend/shared/admin.md)
- [case.md](backend/shared/case.md)
- [chart.md](backend/shared/chart.md)
- [company.md](backend/shared/company.md)
- [dashboard.md](backend/shared/dashboard.md)
- [event.md](backend/shared/event.md)
- [file.md](backend/shared/file.md)
- [filter.md](backend/shared/filter.md)
- [lib.md](backend/shared/lib.md)
- [monitoring.md](backend/shared/monitoring.md)
- [optimization.md](backend/shared/optimization.md)
- [project.md](backend/shared/project.md)
- [report.md](backend/shared/report.md)
- [search.md](backend/shared/search.md)
- [step.md](backend/shared/step.md)
- [team.md](backend/shared/team.md)
- [type_def.md](backend/shared/type_def.md)
- [user.md](backend/shared/user.md)

### frontend (95)

**frontend/scripts/**
- [api.md](frontend/scripts/api.md)

**frontend/scripts/audit/**
- [snapshot.md](frontend/scripts/audit/snapshot.md)

**frontend/scripts/**
- [autocomplete.md](frontend/scripts/autocomplete.md)

**frontend/scripts/charts/**
- [build.md](frontend/scripts/charts/build.md)
- [builder-ui.md](frontend/scripts/charts/builder-ui.md)
- [home-bank.md](frontend/scripts/charts/home-bank.md)
- [monitoring-bank.md](frontend/scripts/charts/monitoring-bank.md)
- [render.md](frontend/scripts/charts/render.md)

**frontend/scripts/**
- [column-index.md](frontend/scripts/column-index.md)
- [designer.md](frontend/scripts/designer.md)
- [dom.md](frontend/scripts/dom.md)
- [dropdown.md](frontend/scripts/dropdown.md)
- [echarts-kpi.md](frontend/scripts/echarts-kpi.md)
- [echarts-theme.md](frontend/scripts/echarts-theme.md)
- [engine.worker.md](frontend/scripts/engine.worker.md)
- [events.md](frontend/scripts/events.md)
- [format.md](frontend/scripts/format.md)

**frontend/scripts/framework/**
- [activity.md](frontend/scripts/framework/activity.md)
- [avatar-upload.md](frontend/scripts/framework/avatar-upload.md)
- [badge.md](frontend/scripts/framework/badge.md)
- [cell-editor.md](frontend/scripts/framework/cell-editor.md)
- [chart.md](frontend/scripts/framework/chart.md)
- [chip-row.md](frontend/scripts/framework/chip-row.md)
- [comments.md](frontend/scripts/framework/comments.md)
- [component-registry.md](frontend/scripts/framework/component-registry.md)
- [connection-setup.md](frontend/scripts/framework/connection-setup.md)
- [create-action.md](frontend/scripts/framework/create-action.md)
- [dashboards.md](frontend/scripts/framework/dashboards.md)
- [editor-chip-enum.md](frontend/scripts/framework/editor-chip-enum.md)
- [editor-code.md](frontend/scripts/framework/editor-code.md)
- [editor-entity-picker.md](frontend/scripts/framework/editor-entity-picker.md)
- [editor-registry.md](frontend/scripts/framework/editor-registry.md)
- [editor-text.md](frontend/scripts/framework/editor-text.md)
- [field.md](frontend/scripts/framework/field.md)
- [filter-panel.md](frontend/scripts/framework/filter-panel.md)
- [head.md](frontend/scripts/framework/head.md)
- [menu.md](frontend/scripts/framework/menu.md)
- [modal.md](frontend/scripts/framework/modal.md)
- [omni.md](frontend/scripts/framework/omni.md)
- [page-assembly.md](frontend/scripts/framework/page-assembly.md)
- [pager.md](frontend/scripts/framework/pager.md)
- [panel.md](frontend/scripts/framework/panel.md)
- [profile-record.md](frontend/scripts/framework/profile-record.md)
- [rail.md](frontend/scripts/framework/rail.md)
- [redtable.md](frontend/scripts/framework/redtable.md)
- [seg.md](frontend/scripts/framework/seg.md)
- [select.md](frontend/scripts/framework/select.md)
- [settings-config.md](frontend/scripts/framework/settings-config.md)
- [stat.md](frontend/scripts/framework/stat.md)
- [surface.md](frontend/scripts/framework/surface.md)
- [table.md](frontend/scripts/framework/table.md)
- [toolbar.md](frontend/scripts/framework/toolbar.md)
- [tools-panel.md](frontend/scripts/framework/tools-panel.md)
- [topbar.md](frontend/scripts/framework/topbar.md)
- [type-registry.md](frontend/scripts/framework/type-registry.md)
- [virtual-rows.md](frontend/scripts/framework/virtual-rows.md)

**frontend/scripts/**
- [joins.md](frontend/scripts/joins.md)
- [list-page.md](frontend/scripts/list-page.md)
- [main.md](frontend/scripts/main.md)
- [page-row.md](frontend/scripts/page-row.md)

**frontend/scripts/pages/**
- [cases.md](frontend/scripts/pages/cases.md)

**frontend/scripts/pages/cases/**
- [labels.md](frontend/scripts/pages/cases/labels.md)

**frontend/scripts/pages/**
- [docs.md](frontend/scripts/pages/docs.md)
- [home.md](frontend/scripts/pages/home.md)

**frontend/scripts/pages/home/**
- [tabs.md](frontend/scripts/pages/home/tabs.md)

**frontend/scripts/pages/**
- [login.md](frontend/scripts/pages/login.md)
- [monitoring.md](frontend/scripts/pages/monitoring.md)

**frontend/scripts/pages/monitoring/**
- [tabs.md](frontend/scripts/pages/monitoring/tabs.md)

**frontend/scripts/pages/**
- [profile.md](frontend/scripts/pages/profile.md)
- [settings-hidden.md](frontend/scripts/pages/settings-hidden.md)
- [settings-search.md](frontend/scripts/pages/settings-search.md)
- [settings.md](frontend/scripts/pages/settings.md)
- [sheetwise.md](frontend/scripts/pages/sheetwise.md)
- [workspace.md](frontend/scripts/pages/workspace.md)

**frontend/scripts/**
- [prefs.md](frontend/scripts/prefs.md)

**frontend/scripts/prefs/controls/**
- [chart-layouts.md](frontend/scripts/prefs/controls/chart-layouts.md)
- [theme-swatch.md](frontend/scripts/prefs/controls/theme-swatch.md)

**frontend/scripts/**
- [rail-controls.md](frontend/scripts/rail-controls.md)
- [rail-footer.md](frontend/scripts/rail-footer.md)
- [report.md](frontend/scripts/report.md)

**frontend/scripts/report/**
- [vocab.md](frontend/scripts/report/vocab.md)

**frontend/scripts/**
- [sw-update.md](frontend/scripts/sw-update.md)
- [theme.md](frontend/scripts/theme.md)
- [tools.md](frontend/scripts/tools.md)

**frontend/scripts/tools/**
- [actions.md](frontend/scripts/tools/actions.md)
- [catalog.md](frontend/scripts/tools/catalog.md)
- [fields.md](frontend/scripts/tools/fields.md)

**frontend/scripts/**
- [topbar.md](frontend/scripts/topbar.md)
- [virtual-rows.md](frontend/scripts/virtual-rows.md)
- [wasm-engine.md](frontend/scripts/wasm-engine.md)

**frontend/styles/framework/**
- [activity.md](frontend/styles/framework/activity.md)
- [redtable.md](frontend/styles/framework/redtable.md)
- [seg.md](frontend/styles/framework/seg.md)

**frontend/styles/**
- [sheetwise.md](frontend/styles/sheetwise.md)

**frontend/**
- [typedef-acceptance.md](frontend/typedef-acceptance.md)

### tools (47)

**tools/audit-suite/**
- [api-doc-audit.md](tools/audit-suite/api-doc-audit.md)
- [auth-audit.md](tools/audit-suite/auth-audit.md)
- [ci-audit.md](tools/audit-suite/ci-audit.md)
- [class-count-audit.md](tools/audit-suite/class-count-audit.md)
- [connectors-audit.md](tools/audit-suite/connectors-audit.md)
- [crossing-audit.md](tools/audit-suite/crossing-audit.md)
- [css-audit.md](tools/audit-suite/css-audit.md)
- [css-cross-page-audit.md](tools/audit-suite/css-cross-page-audit.md)
- [css-tab-compare-audit.md](tools/audit-suite/css-tab-compare-audit.md)
- [doc-coverage-audit.md](tools/audit-suite/doc-coverage-audit.md)
- [fe-framework-audit.md](tools/audit-suite/fe-framework-audit.md)
- [html-audit.md](tools/audit-suite/html-audit.md)
- [js-audit.md](tools/audit-suite/js-audit.md)
- [list-endpoint-rbac-audit.md](tools/audit-suite/list-endpoint-rbac-audit.md)
- [observability-audit.md](tools/audit-suite/observability-audit.md)
- [page-structure-audit.md](tools/audit-suite/page-structure-audit.md)
- [redtable-audit.md](tools/audit-suite/redtable-audit.md)
- [rs-audit.md](tools/audit-suite/rs-audit.md)
- [rs-perf-audit.md](tools/audit-suite/rs-perf-audit.md)
- [ui-doc-audit.md](tools/audit-suite/ui-doc-audit.md)
- [ui-runtime-audit.md](tools/audit-suite/ui-runtime-audit.md)
- [ui-snapshot-audit.md](tools/audit-suite/ui-snapshot-audit.md)

**tools/css-twin-verify/**
- [migrate.md](tools/css-twin-verify/migrate.md)
- [verify.md](tools/css-twin-verify/verify.md)

**tools/doc-gen/**
- [gen.md](tools/doc-gen/gen.md)

**tools/lib/**
- [fe-inventory.md](tools/lib/fe-inventory.md)
- [rust-routes.md](tools/lib/rust-routes.md)

**tools/**
- [mcp-server.md](tools/mcp-server.md)
- [memory-gc.md](tools/memory-gc.md)

**tools/one-off/**
- [css-parallel.md](tools/one-off/css-parallel.md)
- [css-usage.md](tools/one-off/css-usage.md)
- [csv-to-xlsx-rs.md](tools/one-off/csv-to-xlsx-rs.md)

**tools/page-verify/**
- [verify.md](tools/page-verify/verify.md)

**tools/**
- [parse-diag.md](tools/parse-diag.md)

**tools/shell/**
- [audit.md](tools/shell/audit.md)
- [build-wasm.md](tools/shell/build-wasm.md)
- [db-reset.md](tools/shell/db-reset.md)
- [db-setup.md](tools/shell/db-setup.md)
- [dev-setup.md](tools/shell/dev-setup.md)
- [health-check.md](tools/shell/health-check.md)
- [install-stack.md](tools/shell/install-stack.md)
- [port-check.md](tools/shell/port-check.md)
- [seed-rbac-coverage.md](tools/shell/seed-rbac-coverage.md)
- [stack-version.md](tools/shell/stack-version.md)

**tools/**
- [team.md](tools/team.md)

**tools/uniformity-audit/**
- [audit.md](tools/uniformity-audit/audit.md)

**tools/**
- [wasm-bench.md](tools/wasm-bench.md)

<!-- doc-gen:code-nav END -->
