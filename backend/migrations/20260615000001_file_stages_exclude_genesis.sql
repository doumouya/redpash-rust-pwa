-- Exclude the genesis step from the file_stages "clean" test.
-- 20260615000000 gave every uploaded file an applied ordinal-0 "original" genesis
-- step. file_stages derives stage='clean' from EXISTS(project_steps WHERE applied),
-- so the genesis flipped EVERY fresh, untouched file from 'new' to 'clean'. A file
-- is only 'clean' once it has a REAL cleaning step (kind <> 'original').
-- CREATE OR REPLACE keeps the column list, so the dependent project_stages view is
-- untouched. Only the 'clean' EXISTS gains `AND s.kind <> 'original'`.
CREATE OR REPLACE VIEW file_stages AS
SELECT f.redpash_id AS file_id,
       CASE
         WHEN EXISTS (                                  -- a chart built on f sits on a public dashboard
           SELECT 1
           FROM project_files c
           JOIN project_files d ON d.file_type = 'dashboard' AND d.is_public
           CROSS JOIN LATERAL jsonb_array_elements(coalesce(d.spec->'widgets','[]'::jsonb)) w
           WHERE c.file_type = 'chart' AND c.source_file_id = f.redpash_id
             AND w->'spec'->>'chart_id' = c.redpash_id
         ) THEN 'publish'
         WHEN EXISTS (
           SELECT 1 FROM project_files c
           WHERE c.file_type = 'chart' AND c.source_file_id = f.redpash_id
         ) THEN 'design'
         WHEN EXISTS (
           SELECT 1 FROM project_steps s
           WHERE s.file_id = f.redpash_id AND s.applied AND s.kind <> 'original'
         ) THEN 'clean'
         ELSE 'new'
       END AS stage
FROM project_files f
WHERE f.file_type = 'csv';
