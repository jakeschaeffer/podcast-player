-- A title written in the same save as a small boundary move was logged without the model's title: the new revision
-- kept the summary, so no summary job ran to fill the row in. The revision carries what the row lacks.
UPDATE title_edit
   SET generated_title = (SELECT r.generated_title FROM snip_revision r WHERE r.id = title_edit.revision_id),
       summary_model = (SELECT r.summary_model FROM snip_revision r WHERE r.id = title_edit.revision_id),
       summary_prompt_version = (SELECT r.summary_prompt_version FROM snip_revision r WHERE r.id = title_edit.revision_id)
 WHERE generated_title IS NULL
   AND EXISTS (SELECT 1 FROM snip_revision r WHERE r.id = title_edit.revision_id AND r.generated_title IS NOT NULL);
