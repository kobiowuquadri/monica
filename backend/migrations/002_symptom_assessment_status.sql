-- Distinguish "no symptoms reported" from "symptoms not assessed" so an empty symptom list is
-- never mistaken for an explicit all-clear.
ALTER TABLE check_ins
  ADD COLUMN symptom_status text NOT NULL DEFAULT 'not_assessed'
  CHECK (symptom_status IN ('reported', 'none_reported', 'not_assessed'));

-- Existing rows with symptom reports are marked as reported.
UPDATE check_ins c SET symptom_status = 'reported'
 WHERE EXISTS (SELECT 1 FROM symptom_reports s WHERE s.check_in_id = c.id);
