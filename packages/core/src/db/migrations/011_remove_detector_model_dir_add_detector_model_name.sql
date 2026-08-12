-- Remove detector_model_dir and add detector_model_name
-- Safe no-op on fresh databases that already have detector_model_name

BEGIN TRANSACTION;

-- Drop the deprecated directory column if it exists
-- SQLite does not support DROP COLUMN IF EXISTS directly, so guard with PRAGMA
PRAGMA legacy_alter_column = ON;

ALTER TABLE settings DROP COLUMN detector_model_dir;

-- Add the new name column if it does not already exist
ALTER TABLE settings ADD COLUMN detector_model_name TEXT NOT NULL DEFAULT 'Xenova/bert-base-NER';

COMMIT;
