-- Migration 017: Add redact_policy_enabled column to settings
-- Controls whether a custom policy file should be used (overrides preset)
-- Default: true (enabled) - if a policy file path is set, it will be used

ALTER TABLE settings ADD COLUMN redact_policy_enabled INTEGER NOT NULL DEFAULT 1;

-- Update the default row with default value
UPDATE settings
SET redact_policy_enabled = COALESCE(redact_policy_enabled, 1)
WHERE id = 'default';