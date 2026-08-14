-- False positive feedback table for redact plugin
-- Stores user-reported false positive redactions to improve detection accuracy

CREATE TABLE IF NOT EXISTS redaction_false_positives (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	value TEXT NOT NULL,
	rule_id TEXT NOT NULL,
	label TEXT NOT NULL,
	path TEXT NOT NULL,
	timestamp INTEGER NOT NULL,
	session_id TEXT,
	match_mode TEXT NOT NULL DEFAULT 'exact',
	pattern TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- Index for fast lookups by value and rule_id (most common query pattern)
CREATE INDEX IF NOT EXISTS idx_false_positives_value_rule ON redaction_false_positives (value, rule_id);

-- Index for session-based queries
CREATE INDEX IF NOT EXISTS idx_false_positives_session ON redaction_false_positives (session_id);

-- Index for timestamp-based queries (cleanup, analytics)
CREATE INDEX IF NOT EXISTS idx_false_positives_timestamp ON redaction_false_positives (timestamp);