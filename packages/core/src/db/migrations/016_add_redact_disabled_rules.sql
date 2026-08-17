-- Migration 016: Add redact_disabled_rules column to settings
-- Stores JSON array of disabled redaction rule IDs (e.g., ["URL", "ORGANIZATION"])

ALTER TABLE settings ADD COLUMN redact_disabled_rules TEXT NOT NULL DEFAULT '[]';

-- Update the default row with default value
UPDATE settings
SET redact_disabled_rules = COALESCE(redact_disabled_rules, '[]')
WHERE id = 'default';