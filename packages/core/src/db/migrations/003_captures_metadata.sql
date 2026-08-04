-- Migration 003: Add indexes and fix captures_metadata session_id nullability
-- This migration:
--   1. Rebuilds captures_metadata table with nullable session_id (SQLite doesn't support ALTER COLUMN)
--   2. Adds indexes for query performance on timestamp, request_model, response_model, status

-- Rebuild captures_metadata table to allow NULL session_id
-- SQLite doesn't support ALTER TABLE ALTER COLUMN, so we must rebuild the table

CREATE TABLE IF NOT EXISTS captures_metadata_new (
    id                TEXT PRIMARY KEY,
    session_id        TEXT,  -- nullable: not all captures have a session
    filepath          TEXT NOT NULL UNIQUE,
    timestamp         INTEGER NOT NULL,    -- epoch milliseconds
    request_model     TEXT,
    response_model    TEXT,
    tokens_prompt     INTEGER,
    tokens_completion INTEGER,
    duration_ms       INTEGER,
    status            TEXT,
    created_at        INTEGER DEFAULT (strftime('%s','now')*1000)
);

-- Copy existing data
INSERT INTO captures_metadata_new (id, session_id, filepath, timestamp, request_model, response_model, tokens_prompt, tokens_completion, duration_ms, status, created_at)
SELECT id, session_id, filepath, timestamp, request_model, response_model, tokens_prompt, tokens_completion, duration_ms, status, created_at
FROM captures_metadata;

-- Drop old table and rename new one
DROP TABLE captures_metadata;
ALTER TABLE captures_metadata_new RENAME TO captures_metadata;

-- Recreate the composite index from migration 001
CREATE INDEX IF NOT EXISTS idx_captures_metadata_session_timestamp_filepath
    ON captures_metadata (session_id, timestamp, filepath);

-- Add indexes for query performance on common filter columns
CREATE INDEX IF NOT EXISTS idx_captures_metadata_timestamp
    ON captures_metadata (timestamp);

CREATE INDEX IF NOT EXISTS idx_captures_metadata_request_model
    ON captures_metadata (request_model);

CREATE INDEX IF NOT EXISTS idx_captures_metadata_response_model
    ON captures_metadata (response_model);

CREATE INDEX IF NOT EXISTS idx_captures_metadata_status
    ON captures_metadata (status);
