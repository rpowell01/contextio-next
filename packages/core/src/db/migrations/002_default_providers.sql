-- Migration 002: Insert default provider configurations
-- This migration populates the providers table with the canonical default providers
-- from packages/proxy/public/default-providers.json

-- Anthropic
INSERT OR IGNORE INTO providers (
    id, name, upstream_url, api_format, auth_type, enabled,
    rate_limit_max_requests, rate_limit_window_ms, rate_limit_buffer_capacity,
    retry_max_retries, retry_base_delay_ms, retry_max_delay_ms,
    retry_retryable_statuses, retry_jitter_factor, custom_headers,
    allow_base_url_override, base_url_override_header, source, dynamic
) VALUES (
    'anthropic', 'Anthropic', 'https://api.anthropic.com', 'anthropic-messages', 'bearer', 1,
    60, 60000, 10,
    3, 1000, 30000,
    '[429, 500, 502, 503, 504]', 0.2, '{}',
    1, 'x-anthropic-baseurl', 'default', 0
);

-- OpenAI
INSERT OR IGNORE INTO providers (
    id, name, upstream_url, api_format, auth_type, enabled,
    rate_limit_max_requests, rate_limit_window_ms, rate_limit_buffer_capacity,
    retry_max_retries, retry_base_delay_ms, retry_max_delay_ms,
    retry_retryable_statuses, retry_jitter_factor, custom_headers,
    allow_base_url_override, base_url_override_header, source, dynamic
) VALUES (
    'openai', 'OpenAI', 'https://api.openai.com', 'chat-completions', 'bearer', 1,
    60, 60000, 10,
    3, 1000, 30000,
    '[429, 500, 502, 503, 504]', 0.2, '{}',
    1, 'x-openai-baseurl', 'default', 0
);

-- ChatGPT
INSERT OR IGNORE INTO providers (
    id, name, upstream_url, api_format, auth_type, enabled,
    rate_limit_max_requests, rate_limit_window_ms, rate_limit_buffer_capacity,
    retry_max_retries, retry_base_delay_ms, retry_max_delay_ms,
    retry_retryable_statuses, retry_jitter_factor, custom_headers,
    allow_base_url_override, base_url_override_header, source, dynamic
) VALUES (
    'chatgpt', 'ChatGPT', 'https://chatgpt.com', 'chatgpt-backend', 'bearer', 1,
    60, 60000, 10,
    3, 1000, 30000,
    '[429, 500, 502, 503, 504]', 0.2, '{}',
    1, 'x-chatgpt-baseurl', 'default', 0
);

-- Gemini
INSERT OR IGNORE INTO providers (
    id, name, upstream_url, api_format, auth_type, enabled,
    rate_limit_max_requests, rate_limit_window_ms, rate_limit_buffer_capacity,
    retry_max_retries, retry_base_delay_ms, retry_max_delay_ms,
    retry_retryable_statuses, retry_jitter_factor, custom_headers,
    allow_base_url_override, base_url_override_header, source, dynamic
) VALUES (
    'gemini', 'Gemini', 'https://generativelanguage.googleapis.com', 'gemini', 'api-key', 1,
    60, 60000, 10,
    3, 1000, 30000,
    '[429, 500, 502, 503, 504]', 0.2, '{}',
    1, 'x-gemini-baseurl', 'default', 0
);

-- Vertex AI
INSERT OR IGNORE INTO providers (
    id, name, upstream_url, api_format, auth_type, enabled,
    rate_limit_max_requests, rate_limit_window_ms, rate_limit_buffer_capacity,
    retry_max_retries, retry_base_delay_ms, retry_max_delay_ms,
    retry_retryable_statuses, retry_jitter_factor, custom_headers,
    allow_base_url_override, base_url_override_header, source, dynamic
) VALUES (
    'vertex', 'Vertex AI', 'https://us-central1-aiplatform.googleapis.com', 'gemini', 'api-key', 1,
    60, 60000, 10,
    3, 1000, 30000,
    '[429, 500, 502, 503, 504]', 0.2, '{}',
    1, 'x-vertex-baseurl', 'default', 0
);

-- NVIDIA
INSERT OR IGNORE INTO providers (
    id, name, upstream_url, api_format, auth_type, enabled,
    rate_limit_max_requests, rate_limit_window_ms, rate_limit_buffer_capacity,
    retry_max_retries, retry_base_delay_ms, retry_max_delay_ms,
    retry_retryable_statuses, retry_jitter_factor, custom_headers,
    allow_base_url_override, base_url_override_header, source, dynamic
) VALUES (
    'nvidia', 'NVIDIA', 'https://integrate.api.nvidia.com', 'chat-completions', 'bearer', 1,
    20, 60000, 5,
    3, 1000, 30000,
    '[429, 500, 502, 503, 504]', 0.2, '{}',
    1, 'x-nvidia-baseurl', 'default', 0
);

-- OpenRouter
INSERT OR IGNORE INTO providers (
    id, name, upstream_url, api_format, auth_type, enabled,
    rate_limit_max_requests, rate_limit_window_ms, rate_limit_buffer_capacity,
    retry_max_retries, retry_base_delay_ms, retry_max_delay_ms,
    retry_retryable_statuses, retry_jitter_factor, custom_headers,
    allow_base_url_override, base_url_override_header, source, dynamic
) VALUES (
    'openrouter', 'OpenRouter', 'https://openrouter.ai/api', 'chat-completions', 'bearer', 1,
    60, 60000, 10,
    3, 1000, 30000,
    '[429, 500, 502, 503, 504]', 0.2, '{}',
    1, 'x-openrouter-baseurl', 'default', 0
);

-- Kilo
INSERT OR IGNORE INTO providers (
    id, name, upstream_url, api_format, auth_type, enabled,
    rate_limit_max_requests, rate_limit_window_ms, rate_limit_buffer_capacity,
    retry_max_retries, retry_base_delay_ms, retry_max_delay_ms,
    retry_retryable_statuses, retry_jitter_factor, custom_headers,
    allow_base_url_override, base_url_override_header, source, dynamic
) VALUES (
    'kilo', 'Kilo', 'https://api.kilo.ai/api/gateway', 'chat-completions', 'bearer', 1,
    60, 60000, 10,
    3, 1000, 30000,
    '[429, 500, 502, 503, 504]', 0.2, '{}',
    1, 'x-kilo-baseurl', 'default', 0
);

-- Unknown (fallback)
INSERT OR IGNORE INTO providers (
    id, name, upstream_url, api_format, auth_type, enabled,
    rate_limit_max_requests, rate_limit_window_ms, rate_limit_buffer_capacity,
    retry_max_retries, retry_base_delay_ms, retry_max_delay_ms,
    retry_retryable_statuses, retry_jitter_factor, custom_headers,
    allow_base_url_override, base_url_override_header, source, dynamic
) VALUES (
    'unknown', 'Unknown', 'https://unknown.provider', 'unknown', 'none', 1,
    60, 60000, 10,
    3, 1000, 30000,
    '[429, 500, 502, 503, 504]', 0.2, '{}',
    0, 'x-unknown-baseurl', 'default', 0
);

-- Gemini Code Assist
INSERT OR IGNORE INTO providers (
    id, name, upstream_url, api_format, auth_type, enabled,
    rate_limit_max_requests, rate_limit_window_ms, rate_limit_buffer_capacity,
    retry_max_retries, retry_base_delay_ms, retry_max_delay_ms,
    retry_retryable_statuses, retry_jitter_factor, custom_headers,
    allow_base_url_override, base_url_override_header, source, dynamic
) VALUES (
    'geminiCodeAssist', 'Gemini Code Assist', 'https://generativelanguage.googleapis.com', 'gemini', 'api-key', 1,
    60, 60000, 10,
    3, 1000, 30000,
    '[429, 500, 502, 503, 504]', 0.2, '{}',
    1, 'x-gemini-code-assist-baseurl', 'default', 0
);