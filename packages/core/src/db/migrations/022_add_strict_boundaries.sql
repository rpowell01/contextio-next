-- Migration 022: Add strict_boundaries column to settings
-- Enables strict word boundary checking for Presidio LLM detector
-- Prevents substring matches (e.g., 10-digit phone in 25-digit string)

ALTER TABLE settings ADD COLUMN strict_boundaries INTEGER NOT NULL DEFAULT 0;