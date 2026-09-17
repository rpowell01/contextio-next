-- Migration 023: Add first_token_time_ms column to providers table
-- Stores the configured first token time threshold in milliseconds for retry logic

ALTER TABLE providers
  ADD COLUMN first_token_time_ms INTEGER DEFAULT 1000;

-- Update existing rows with default value
UPDATE providers SET first_token_time_ms = 1000 WHERE first_token_time_ms IS NULL;