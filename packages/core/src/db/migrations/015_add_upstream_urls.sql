-- Migration 015: Add remaining upstream URL columns for all providers
-- Adds columns for OpenAI, Anthropic, ChatGPT, Gemini, Vertex, NVIDIA, Kilo, Gemini Code Assist

ALTER TABLE settings ADD COLUMN upstream_openai_url TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN upstream_anthropic_url TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN upstream_chatgpt_url TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN upstream_gemini_url TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN upstream_vertex_url TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN upstream_nvidia_url TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN upstream_kilo_url TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN upstream_gemini_code_assist_url TEXT NOT NULL DEFAULT '';

-- Update the default row with default values (in case it already exists with NULLs)
UPDATE settings
SET
    upstream_openai_url = COALESCE(upstream_openai_url, ''),
    upstream_anthropic_url = COALESCE(upstream_anthropic_url, ''),
    upstream_chatgpt_url = COALESCE(upstream_chatgpt_url, ''),
    upstream_gemini_url = COALESCE(upstream_gemini_url, ''),
    upstream_vertex_url = COALESCE(upstream_vertex_url, ''),
    upstream_nvidia_url = COALESCE(upstream_nvidia_url, ''),
    upstream_kilo_url = COALESCE(upstream_kilo_url, ''),
    upstream_gemini_code_assist_url = COALESCE(upstream_gemini_code_assist_url, '')
WHERE id = 'default';