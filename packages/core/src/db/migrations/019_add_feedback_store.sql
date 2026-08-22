-- Migration 019: Add feedback store columns to settings table
-- Stores configuration for false positive management feedback store

ALTER TABLE settings ADD COLUMN feedback_store_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN feedback_store_type TEXT NOT NULL DEFAULT 'sqlite';
ALTER TABLE settings ADD COLUMN feedback_store_path TEXT NOT NULL DEFAULT '';