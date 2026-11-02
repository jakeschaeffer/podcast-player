-- Who wrote each snip title, the model's own title kept when the owner replaces it, and a log of the owner's
-- title edits: each one pairs a span's excerpt with the title the owner chose, ground truth for title evals.

ALTER TABLE snip_revision ADD COLUMN title_source TEXT;    -- 'model' | 'fallback' | 'owner'
ALTER TABLE snip_revision ADD COLUMN generated_title TEXT; -- the summary model's title for this span, kept after the owner rewrites it

UPDATE snip_revision
   SET title_source = CASE WHEN summary_status = 'ready' THEN 'model' ELSE 'fallback' END,
       generated_title = CASE WHEN summary_status = 'ready' THEN title END
 WHERE title IS NOT NULL;

CREATE TABLE title_edit (
  id                     TEXT PRIMARY KEY,
  snip_id                TEXT NOT NULL REFERENCES snip(id),
  revision_id            TEXT NOT NULL REFERENCES snip_revision(id), -- the revision the new title belongs to
  previous_title         TEXT,
  previous_source        TEXT,                                       -- title_source of the title that was replaced
  new_title              TEXT NOT NULL,
  generated_title        TEXT,  -- the model's title for this span; filled in when the summary lands if the edit came first
  summary_model          TEXT,
  summary_prompt_version TEXT,
  start_ms               INTEGER NOT NULL,
  end_ms                 INTEGER NOT NULL,
  excerpt                TEXT,  -- the span's words at the time of the edit
  created_at             INTEGER NOT NULL
);
CREATE INDEX title_edit_snip ON title_edit(snip_id, created_at);
CREATE INDEX title_edit_revision ON title_edit(revision_id);
