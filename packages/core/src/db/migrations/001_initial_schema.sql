-- SQLite schema for capture metadata and provider configurations.
--
-- This schema replaces JSON-based storage (providers.json) for provider
-- configurations while keeping capture files as JSON source of truth.
-- Capture metadata is indexed here for fast querying and lookup.

-- ============================================================================
-- captures_metadata table
--   Stores searchable metadata extracted from capture JSON files.
--   Capture files on disk remain the authoritative source of truth;
--   this table provides an index for efficient querying.
-- ============================================================================

CREATE TABLE IF NOT EXISTS captures_metadata (
    id                TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL,
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

-- Composite index supporting the common query patterns:
--   - filter by session_id
--   - range queries on timestamp
--   - exact lookups on filepath (also covered by UNIQUE, but included
--     so the index serves multi-column predicates efficiently)
CREATE INDEX IF NOT EXISTS idx_captures_metadata_session_timestamp_filepath
    ON captures_metadata (session_id, timestamp, filepath);

-- ============================================================================
-- providers table
--   Replaces providers.json with a SQLite-backed provider registry.
--   Supports multiple sources ('default', 'env', 'file') and dynamic
--   runtime providers that can be added/removed without a restart.
-- ============================================================================

CREATE TABLE IF NOT EXISTS providers (
    id                       TEXT PRIMARY KEY,
    name                     TEXT NOT NULL,
    upstream_url             TEXT NOT NULL,
    api_format               TEXT NOT NULL,
    auth_type                TEXT NOT NULL,
    enabled                  INTEGER NOT NULL DEFAULT 1,
    rate_limit_max_requests  INTEGER,
    rate_limit_window_ms     INTEGER,
    rate_limit_buffer_capacity INTEGER,
    retry_max_retries        INTEGER,
    retry_base_delay_ms      INTEGER,
    retry_max_delay_ms       INTEGER,
    retry_retryable_statuses TEXT,          -- JSON array of integers
    retry_jitter_factor      REAL,
    retry_max_stream_retries INTEGER,
    retry_max_response_buffer_size INTEGER,
    retry_enabled            INTEGER,
    custom_headers           TEXT,          -- JSON object
    allow_base_url_override  INTEGER DEFAULT 1,
    base_url_override_header TEXT,
    source                   TEXT NOT NULL,  -- 'default', 'env', 'file'
    dynamic                  INTEGER NOT NULL DEFAULT 0,
    created_at               INTEGER DEFAULT (strftime('%s','now')*1000),
    updated_at               INTEGER DEFAULT (strftime('%s','now')*1000)
);

-- Keep updated_at in sync whenever a provider row is modified.
-- Without this trigger, updated_at would only be populated on INSERT
-- and would never reflect subsequent edits.
CREATE TRIGGER IF NOT EXISTS trg_providers_updated_at
    AFTER UPDATE ON providers
BEGIN
    UPDATE providers
       SET updated_at = strftime('%s','now') * 1000
     WHERE rowid = NEW.rowid;
END;

-- ============================================================================
-- schema_version table
--   Tracks applied schema migrations so forward-compatible upgrades
--   can detect which version they are starting from.
-- ============================================================================

CREATE TABLE IF NOT EXISTS schema_version (
    version      INTEGER PRIMARY KEY,
    applied_at   INTEGER DEFAULT (strftime('%s','now')*1000),
    description  TEXT
);
