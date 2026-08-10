-- Migration 009: Add matches column to redaction_metadata
-- Stores redaction match details (ruleId, preValue, postValue, path) as JSON
-- This replaces the .redact-meta.json sidecar file's matches array

-- Create new table with matches column
CREATE TABLE IF NOT EXISTS redaction_metadata_new (
    capture_id        TEXT PRIMARY KEY,
    session_id        TEXT,
    rule_counts       TEXT NOT NULL,           -- JSON: rule_name -> count
    total_redactions  INTEGER NOT NULL DEFAULT 0,
    encrypted         INTEGER NOT NULL DEFAULT 0,
    source            TEXT,
    provider          TEXT,
    target_url        TEXT,
    request_bytes     INTEGER,
    response_bytes    INTEGER,
    timings_send_ms   INTEGER,
    timings_wait_ms   INTEGER,
    timings_receive_ms INTEGER,
    timings_total_ms  INTEGER,
    total_input_tokens INTEGER,
    total_output_tokens INTEGER,
    tokens_per_second REAL,
    success_count     INTEGER,
    error_count       INTEGER,
    model             TEXT,
    matches           TEXT,                    -- JSON: array of {ruleId, preValue, postValue, path}
    created_at        INTEGER DEFAULT (strftime('%s','now')*1000),
    updated_at        INTEGER DEFAULT (strftime('%s','now')*1000)
);

-- Copy existing data
INSERT INTO redaction_metadata_new (
    capture_id, session_id, rule_counts, total_redactions, encrypted,
    source, provider, target_url, request_bytes, response_bytes,
    timings_send_ms, timings_wait_ms, timings_receive_ms, timings_total_ms,
    total_input_tokens, total_output_tokens, tokens_per_second,
    success_count, error_count, model,
    created_at, updated_at
)
SELECT
    capture_id, session_id, rule_counts, total_redactions, encrypted,
    source, provider, target_url, request_bytes, response_bytes,
    timings_send_ms, timings_wait_ms, timings_receive_ms, timings_total_ms,
    total_input_tokens, total_output_tokens, tokens_per_second,
    success_count, error_count, model,
    created_at, updated_at
FROM redaction_metadata;

-- Drop old table
DROP TABLE redaction_metadata;

-- Rename new table
ALTER TABLE redaction_metadata_new RENAME TO redaction_metadata;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_redaction_metadata_session_id
    ON redaction_metadata (session_id);

CREATE INDEX IF NOT EXISTS idx_redaction_metadata_capture_id
    ON redaction_metadata (capture_id);

-- Recreate trigger
CREATE TRIGGER IF NOT EXISTS trg_redaction_metadata_updated_at
    AFTER UPDATE ON redaction_metadata
BEGIN
    UPDATE redaction_metadata
       SET updated_at = strftime('%s','now') * 1000
     WHERE rowid = NEW.rowid;
END;