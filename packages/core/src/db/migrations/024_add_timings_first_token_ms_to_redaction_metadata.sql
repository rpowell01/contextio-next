-- Migration: Add timings_first_token_ms column to redaction_metadata table
-- Stores the first token time in milliseconds for TTFT metrics

ALTER TABLE redaction_metadata
  ADD COLUMN timings_first_token_ms INTEGER;

-- Update existing rows with NULL (no default needed, it's optional)