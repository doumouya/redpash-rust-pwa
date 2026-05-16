-- ──────────────── 003 report favourites ────────────────
-- A boolean flag per report so users can pin the ones they reach for
-- most often. Sorted to the top of the reports list.

ALTER TABLE reports ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS reports_favorite_idx ON reports(is_favorite) WHERE is_favorite;
