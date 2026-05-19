-- ──────────── 012 mtime cascade (project = folder) ────────────
-- A project is conceptually a folder: files live at the root, with
-- reports and dashboards in two sub-directories. Unix dir mtime
-- semantics — any change to an immediate child bumps the parent's
-- mtime. These triggers keep projects.updated_at honest so the
-- Objects page "Modified" column reflects the latest activity on
-- any file / report / dashboard inside the project — without every
-- Rust write site having to remember to UPDATE projects.
--
-- Chain:
--   project_steps INSERT/UPDATE/DELETE
--     → project_files.updated_at = now()   (bump_file_mtime_from_step)
--     → projects.updated_at      = now()   (bump_project_mtime_from_file)
--
--   project_files INSERT/UPDATE/DELETE
--     → projects.updated_at      = now()   (bump_project_mtime_from_file)
--
--   reports / dashboards INSERT/UPDATE/DELETE
--     → projects.updated_at      = now()   (bump_project_mtime_from_child)
--
-- DELETE triggers expose only OLD; INSERT/UPDATE expose NEW. Branch on
-- TG_OP so the parent RID resolves in all three cases. AFTER triggers
-- ignore the return value, so RETURN NULL.

-- Steps → file
CREATE OR REPLACE FUNCTION bump_file_mtime_from_step()
RETURNS TRIGGER AS $$
DECLARE
    fid TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        fid := OLD.file_redpash_id;
    ELSE
        fid := NEW.file_redpash_id;
    END IF;
    IF fid IS NOT NULL THEN
        UPDATE project_files SET updated_at = now() WHERE redpash_id = fid;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS project_steps_bump_file ON project_steps;
CREATE TRIGGER project_steps_bump_file
AFTER INSERT OR UPDATE OR DELETE ON project_steps
FOR EACH ROW EXECUTE FUNCTION bump_file_mtime_from_step();

-- Files → project
CREATE OR REPLACE FUNCTION bump_project_mtime_from_file()
RETURNS TRIGGER AS $$
DECLARE
    pid TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        pid := OLD.project_redpash_id;
    ELSE
        pid := NEW.project_redpash_id;
    END IF;
    IF pid IS NOT NULL THEN
        UPDATE projects SET updated_at = now() WHERE redpash_id = pid;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS project_files_bump_project ON project_files;
CREATE TRIGGER project_files_bump_project
AFTER INSERT OR UPDATE OR DELETE ON project_files
FOR EACH ROW EXECUTE FUNCTION bump_project_mtime_from_file();

-- Reports / Dashboards → project (same function — both tables carry
-- project_redpash_id at the same column name).
CREATE OR REPLACE FUNCTION bump_project_mtime_from_child()
RETURNS TRIGGER AS $$
DECLARE
    pid TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        pid := OLD.project_redpash_id;
    ELSE
        pid := NEW.project_redpash_id;
    END IF;
    IF pid IS NOT NULL THEN
        UPDATE projects SET updated_at = now() WHERE redpash_id = pid;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reports_bump_project ON reports;
CREATE TRIGGER reports_bump_project
AFTER INSERT OR UPDATE OR DELETE ON reports
FOR EACH ROW EXECUTE FUNCTION bump_project_mtime_from_child();

DROP TRIGGER IF EXISTS dashboards_bump_project ON dashboards;
CREATE TRIGGER dashboards_bump_project
AFTER INSERT OR UPDATE OR DELETE ON dashboards
FOR EACH ROW EXECUTE FUNCTION bump_project_mtime_from_child();
