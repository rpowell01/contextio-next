-- Migration 020: Add redact_providers column to settings
-- Stores per-provider redaction toggle (JSON map of provider -> boolean)

ALTER TABLE settings ADD COLUMN redact_providers TEXT NOT NULL DEFAULT '{"anthropic":true,"openai":true,"chatgpt":true,"gemini":true,"geminiCodeAssist":true,"vertex":true,"nvidia":true,"openrouter":true,"kilo":true}';
