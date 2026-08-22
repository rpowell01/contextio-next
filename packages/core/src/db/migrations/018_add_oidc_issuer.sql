-- Migration 018: Add oidc_issuer column to settings table
-- Stores the OIDC issuer URL for OpenID Connect authentication

ALTER TABLE settings ADD COLUMN IF NOT EXISTS oidc_issuer TEXT NOT NULL DEFAULT '';