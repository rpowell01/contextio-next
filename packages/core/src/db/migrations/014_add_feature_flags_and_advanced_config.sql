-- Migration 014: Add feature flags and advanced configuration settings
-- Adds columns for feature toggles, advanced rate limiter/retry config, and proxy settings

ALTER TABLE settings ADD COLUMN enable_logger INTEGER NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN enable_redact INTEGER NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN enable_rate_limiter INTEGER NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN log_traffic INTEGER NOT NULL DEFAULT 0;

-- Advanced rate limiter cache configuration
ALTER TABLE settings ADD COLUMN rate_limiter_max_entries INTEGER NOT NULL DEFAULT 2000;
ALTER TABLE settings ADD COLUMN rate_limiter_cleanup_interval_ms INTEGER NOT NULL DEFAULT 60000;
ALTER TABLE settings ADD COLUMN rate_limiter_entry_ttl_ms INTEGER NOT NULL DEFAULT 300000;

-- Advanced streaming retry cache configuration
ALTER TABLE settings ADD COLUMN retry_max_entries INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE settings ADD COLUMN retry_entry_ttl_ms INTEGER NOT NULL DEFAULT 300000;
ALTER TABLE settings ADD COLUMN retry_cleanup_interval_ms INTEGER NOT NULL DEFAULT 30000;
ALTER TABLE settings ADD COLUMN retry_max_buffer_size INTEGER NOT NULL DEFAULT 5242880;
ALTER TABLE settings ADD COLUMN retry_max_stream_retries INTEGER NOT NULL DEFAULT 3;

-- Proxy configuration
ALTER TABLE settings ADD COLUMN proxy_bind_host TEXT NOT NULL DEFAULT '0.0.0.0';
ALTER TABLE settings ADD COLUMN proxy_port INTEGER NOT NULL DEFAULT 4040;
ALTER TABLE settings ADD COLUMN proxy_allow_target_override INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN strict_url_forwarding INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN upstream_openrouter_url TEXT NOT NULL DEFAULT '';

-- Update the default row with default values (in case it already exists with NULLs)
UPDATE settings
SET
    enable_logger = COALESCE(enable_logger, 1),
    enable_redact = COALESCE(enable_redact, 1),
    enable_rate_limiter = COALESCE(enable_rate_limiter, 1),
    log_traffic = COALESCE(log_traffic, 0),
    rate_limiter_max_entries = COALESCE(rate_limiter_max_entries, 2000),
    rate_limiter_cleanup_interval_ms = COALESCE(rate_limiter_cleanup_interval_ms, 60000),
    rate_limiter_entry_ttl_ms = COALESCE(rate_limiter_entry_ttl_ms, 300000),
    retry_max_entries = COALESCE(retry_max_entries, 1000),
    retry_entry_ttl_ms = COALESCE(retry_entry_ttl_ms, 300000),
    retry_cleanup_interval_ms = COALESCE(retry_cleanup_interval_ms, 30000),
    retry_max_buffer_size = COALESCE(retry_max_buffer_size, 5242880),
    retry_max_stream_retries = COALESCE(retry_max_stream_retries, 3),
    proxy_bind_host = COALESCE(proxy_bind_host, '0.0.0.0'),
    proxy_port = COALESCE(proxy_port, 4040),
    proxy_allow_target_override = COALESCE(proxy_allow_target_override, 0),
    strict_url_forwarding = COALESCE(strict_url_forwarding, 0),
    upstream_openrouter_url = COALESCE(upstream_openrouter_url, '')
WHERE id = 'default';