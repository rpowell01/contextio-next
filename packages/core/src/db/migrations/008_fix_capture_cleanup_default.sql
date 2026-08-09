-- Migration 008: Fix capture_cleanup_enabled default
-- The original migration 007 had DEFAULT 0 for capture_cleanup_enabled,
-- but the intended default is true (1). This migration updates existing
-- rows that still have the old default value.

UPDATE settings
   SET capture_cleanup_enabled = 1
 WHERE capture_cleanup_enabled = 0;
