-- Migration 007: Create settings table
-- Stores global application settings as a single row (id = 'default')

CREATE TABLE IF NOT EXISTS settings (
    id                        TEXT PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
    log_dir                   TEXT NOT NULL DEFAULT '',
    max_sessions              INTEGER NOT NULL DEFAULT 0,
    redact_preset             TEXT NOT NULL DEFAULT 'pii',
    redact_reversible         INTEGER NOT NULL DEFAULT 0,
    redact_policy_file        TEXT NOT NULL DEFAULT '',
    encryption_at_rest        INTEGER NOT NULL DEFAULT 0,
    capture_cleanup_enabled   INTEGER NOT NULL DEFAULT 1,
    capture_cleanup_interval_hours INTEGER NOT NULL DEFAULT 24,
    capture_cleanup_max_age_days   INTEGER NOT NULL DEFAULT 30,
    theme                     TEXT NOT NULL DEFAULT 'system',
    oidc_enabled              INTEGER NOT NULL DEFAULT 0,
    oidc_public_url           TEXT NOT NULL DEFAULT '',
    show_page_load_time       INTEGER NOT NULL DEFAULT 0,
    detector_mode             TEXT NOT NULL DEFAULT 'rules',
    detector_model_dir        TEXT NOT NULL DEFAULT '',
    detector_threshold        REAL NOT NULL DEFAULT 0.5,
    rate_limiter              TEXT NOT NULL DEFAULT '{"anthropic":{"maxRequests":60,"windowMs":60000,"bufferCapacity":10},"openai":{"maxRequests":60,"windowMs":60000,"bufferCapacity":10},"chatgpt":{"maxRequests":60,"windowMs":60000,"bufferCapacity":10},"gemini":{"maxRequests":60,"windowMs":60000,"bufferCapacity":10},"geminiCodeAssist":{"maxRequests":60,"windowMs":60000,"bufferCapacity":10},"vertex":{"maxRequests":60,"windowMs":60000,"bufferCapacity":10},"nvidia":{"maxRequests":60,"windowMs":60000,"bufferCapacity":10},"openrouter":{"maxRequests":60,"windowMs":60000,"bufferCapacity":10},"kilo":{"maxRequests":60,"windowMs":60000,"bufferCapacity":10}}',
    streaming_retry           TEXT NOT NULL DEFAULT '{"anthropic":{"enabled":true,"maxRetries":3,"maxBufferSizeMB":10},"openai":{"enabled":true,"maxRetries":3,"maxBufferSizeMB":10},"chatgpt":{"enabled":true,"maxRetries":3,"maxBufferSizeMB":10},"gemini":{"enabled":true,"maxRetries":3,"maxBufferSizeMB":10},"geminiCodeAssist":{"enabled":true,"maxRetries":3,"maxBufferSizeMB":10},"vertex":{"enabled":true,"maxRetries":3,"maxBufferSizeMB":10},"nvidia":{"enabled":true,"maxRetries":3,"maxBufferSizeMB":10},"openrouter":{"enabled":true,"maxRetries":3,"maxBufferSizeMB":10},"kilo":{"enabled":true,"maxRetries":3,"maxBufferSizeMB":10}}',
    created_at                INTEGER DEFAULT (strftime('%s','now')*1000),
    updated_at                INTEGER DEFAULT (strftime('%s','now')*1000)
);

-- Trigger to auto-update updated_at on row changes
CREATE TRIGGER IF NOT EXISTS trg_settings_updated_at
    AFTER UPDATE ON settings
BEGIN
    UPDATE settings
       SET updated_at = strftime('%s','now') * 1000
     WHERE rowid = NEW.rowid;
END;

-- Insert default settings row if not exists
INSERT OR IGNORE INTO settings (id) VALUES ('default');