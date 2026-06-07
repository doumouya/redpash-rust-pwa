-- Object-registry Stage 1·C3: type-level ordering + a grid-served flag.
--
-- `user` (rel-only subject) and `connection` (Stage-2 generic-handler proof)
-- exist in `type_definitions` because they're live `entities.type` values the FK
-- references — but they are NOT grid-served: they must not appear in
-- `/admin/types` or `/admin/fields`, which stay byte-identical to the 7 code-side
-- builtins. `ordinal` preserves the builtin type order (company, project, case,
-- team, file, chart, dashboard) the `/admin` wire is sensitive to, and makes the
-- shared `FIL_` prefix resolve to `file` (lower ordinal) before `dashboard`.

ALTER TABLE type_definitions ADD COLUMN ordinal     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE type_definitions ADD COLUMN grid_served BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE type_definitions SET ordinal = CASE type_id
    WHEN 'company'    THEN 0
    WHEN 'project'    THEN 1
    WHEN 'case'       THEN 2
    WHEN 'team'       THEN 3
    WHEN 'file'       THEN 4
    WHEN 'chart'      THEN 5
    WHEN 'dashboard'  THEN 6
    WHEN 'user'       THEN 7
    WHEN 'connection' THEN 8
    ELSE 99
END;

UPDATE type_definitions SET grid_served = FALSE WHERE type_id IN ('user', 'connection');
