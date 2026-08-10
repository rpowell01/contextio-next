-- Migration 010: Add missing retry columns to providers table
-- These columns were in the original schema (001) but the database was created
-- before they were added, so they don't exist in existing databases.
-- This migration adds them with appropriate defaults.

ALTER TABLE providers
  ADD COLUMN retry_max_stream_retries INTEGER DEFAULT 3;

ALTER TABLE providers
  ADD COLUMN retry_max_response_buffer_size INTEGER DEFAULT 10485760; -- 10 MB

ALTER TABLE providers
  ADD COLUMN retry_enabled INTEGER DEFAULT 1;

-- Update existing rows with default values
UPDATE providers SET retry_max_stream_retries = 3 WHERE retry_max_stream_retries IS NULL;
UPDATE providers SET retry_max_response_buffer_size = 10485760 WHERE retry_max_response_buffer_size IS NULL;
UPDATE providers SET retry_enabled = 1 WHERE retry_enabled IS NULL;