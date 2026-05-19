-- ──────────── 011 filename stem ────────────
-- Stop storing the upload extension inside `project_files.filename`.
-- The redundancy with `project_files.file_type` was the root of the
-- frontend's "strip the .csv everywhere on display" workaround —
-- every new label site had to remember the trick or the wrong thing
-- showed. Fix it at the schema layer: `filename` is the user-facing
-- stem, `file_type` is the extension. Reassemble for download names
-- in route handlers when needed.
--
-- This migration only backfills existing rows; new inserts land
-- already-stripped via the upload / snapshot / join handlers
-- (routes/files.rs).
--
-- `storage_path` (line 53 of init) is decoupled — files on disk are
-- named `<rid>.bin` regardless of the original upload extension, so
-- this migration never touches the filesystem.
--
-- Regex scope is the seven upload-accepted extensions (csv / tsv +
-- the Excel family + ods, see is_excel_filename in data/src/parse.rs).
-- Names without one of those endings pass through untouched.

UPDATE project_files
SET filename = regexp_replace(filename, '\.(csv|tsv|xlsx|xls|xlsm|xlsb|ods)$', '', 'i')
WHERE filename ~* '\.(csv|tsv|xlsx|xls|xlsm|xlsb|ods)$';

UPDATE project_files
SET display_name = regexp_replace(display_name, '\.(csv|tsv|xlsx|xls|xlsm|xlsb|ods)$', '', 'i')
WHERE display_name IS NOT NULL
  AND display_name ~* '\.(csv|tsv|xlsx|xls|xlsm|xlsb|ods)$';
