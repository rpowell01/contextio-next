-- Migration 021: Add detector_labels column to settings
-- Stores LLM detector entity labels (JSON array of strings)

ALTER TABLE settings ADD COLUMN detector_labels TEXT NOT NULL DEFAULT '["PERSON","ORGANIZATION","LOCATION","EMAIL_ADDRESS","PHONE_NUMBER","CREDIT_CARD","US_SSN","IP_ADDRESS","URL","DATE_TIME"]';