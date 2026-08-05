-- Migration 004: Add redaction_metadata table for storing redaction metadata
-- This replaces .redact-meta.json sidecar files with a SQLite-backed index.

CREATE TABLE IF NOT EXISTS redaction_metadata (
    capture_id        TEXT PRIMARY KEY,
    session_id        TEXT,
    rule_counts       TEXT NOT NULL,           -- JSON: rule_name -> count
    total_redactions  INTEGER NOT NULL DEFAULT 0,
    encrypted         INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER DEFAULT (strftime('%s','now')*1000),
    updated_at        INTEGER DEFAULT (strftime('%s','now')*1000),
    FOREIGN KEY (capture_id) REFERENCES captures_metadata(id) ON DELETE CASCADE
);

-- Index for querying redaction metadata by session
CREATE INDEX IF NOT EXISTS idx_redaction_metadata_session_id
    ON redaction_metadata (session_id);

-- Index for querying redaction metadata by capture_id (already covered by PK, but explicit for clarity)
CREATE INDEX IF NOT EXISTS idx_redaction_metadata_capture_id
    ON redaction_metadata (capture_id);

-- Trigger to keep updated_at in sync whenever a row is modified
CREATE TRIGGER IF NOT EXISTS trg_redaction_metadata_updated_at
    AFTER UPDATE ON redaction_metadata
BEGIN
    UPDATE redaction_metadata
       SET updated_at = strftime('%s','now') * 1000
     WHERE rowid = NEW.rowid;
END;