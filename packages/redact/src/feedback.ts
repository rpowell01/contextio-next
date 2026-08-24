/**
 * False Positive Feedback System for @contextio/redact
 * 
 * Provides interfaces and implementations for tracking user-reported false positives
 * to improve redaction accuracy over time.
 */

import { getDb } from "@contextio/core/db";

/**
 * Match mode for false positive matching.
 * - 'exact': Exact string match
 * - 'pattern': Regex pattern match (auto-generated from value)
 */
export type MatchMode = "exact" | "pattern";

/**
 * Represents a single false positive entry reported by a user.
 * 
 * @interface FalsePositiveEntry
 * @property value - The original value that was incorrectly redacted
 * @property ruleId - The rule ID that triggered the false positive
 * @property label - The label/category of the detection (e.g., "EMAIL", "PHONE", "CREDIT_CARD")
 * @property path - The JSON path where the value was found (e.g., "$.messages[0].content")
 * @property timestamp - Unix timestamp (ms) when the false positive was reported
 * @property sessionId - Optional session ID for scoping
 * @property matchMode - How to match this entry: 'exact' or 'pattern'
 * @property pattern - Regex pattern string (auto-generated when matchMode='pattern')
 */
export interface FalsePositiveEntry {
	value: string;
	ruleId: string;
	label: string;
	path: string;
	timestamp: number;
	sessionId?: string;
	matchMode: MatchMode;
	pattern: string;
}

/**
 * Database row type for redaction_false_positives table.
 */
interface FalsePositiveRow {
	id: number;
	value: string;
	rule_id: string;
	label: string;
	path: string;
	timestamp: number;
	session_id: string | null;
	match_mode: string;
	pattern: string;
	created_at: number;
}

/**
 * Interface for a feedback store that tracks false positive redactions.
 * Implementations can use SQLite, in-memory, or other backends.
 */
export interface FeedbackStore {
	/**
	 * Record a new false positive entry.
	 * @param entry - The false positive entry to record. If matchMode is "pattern" and no pattern is provided, one is auto-generated.
	 * @returns The created entry with the final pattern
	 */
	recordFalsePositive(entry: Omit<FalsePositiveEntry, "pattern"> & { pattern?: string }): Promise<FalsePositiveEntry>;

	/**
	 * Check if a value matches any recorded false positive for a given rule.
	 * @param value - The value to check
	 * @param ruleId - The rule ID to check against
	 * @param sessionId - Optional session ID for scoped matching
	 * @returns True if the value matches a recorded false positive
	 */
	isFalsePositive(value: string, ruleId: string, sessionId?: string): Promise<boolean>;

	/**
	 * Get all recorded false positives.
	 * @param ruleId - Optional filter by rule ID
	 * @param sessionId - Optional filter by session ID
	 * @returns Array of all false positive entries
	 */
	getAllFalsePositives(ruleId?: string, sessionId?: string): Promise<FalsePositiveEntry[]>;

	/**
	 * Remove a specific false positive entry.
	 * @param value - The value of the entry to remove
	 * @param ruleId - The rule ID of the entry to remove
	 * @param sessionId - Optional session ID for scoped removal
	 * @returns True if an entry was removed
	 */
	removeFalsePositive(value: string, ruleId: string, sessionId?: string): Promise<boolean>;

	/**
	 * Clear all false positive entries.
	 * @param ruleId - Optional filter by rule ID
	 * @param sessionId - Optional filter by session ID
	 * @returns Number of entries cleared
	 */
	clear(ruleId?: string, sessionId?: string): Promise<number>;
}

/**
 * Convert a database row to a FalsePositiveEntry object.
 */
function rowToEntry(row: FalsePositiveRow): FalsePositiveEntry {
	return {
		value: row.value,
		ruleId: row.rule_id,
		label: row.label,
		path: row.path,
		timestamp: row.timestamp,
		sessionId: row.session_id ?? undefined,
		matchMode: row.match_mode as MatchMode,
		pattern: row.pattern,
	};
}

/**
 * Auto-generate a regex pattern from a value for pattern-based matching.
 * Escapes special regex characters and replaces digit sequences with \d+.
 * 
 * @param value - The value to convert to a pattern
 * @returns A regex pattern string
 */
export function generatePatternFromValue(value: string): string {
	// Escape special regex characters
	let pattern = value
		.replace(/[.+*?^${}()|[\]\\]/g, "\\$&") // Escape regex metacharacters
		.replace(/\d+/g, "\\d+") // Replace digit sequences with \d+
		.replace(/\s+/g, "\\s+"); // Replace whitespace sequences with \s+
	
	// Anchor the pattern
	pattern = `^${pattern}$`;
	
	return pattern;
}

/**
 * SQLite-backed implementation of FeedbackStore.
 * Uses the @contextio/core/db connection for persistence.
 */
export class SqliteFeedbackStore implements FeedbackStore {
	private db = getDb();

	// Prepared statements for performance
	private insertStmt = this.db.prepare(`
		INSERT INTO redaction_false_positives (value, rule_id, label, path, timestamp, session_id, match_mode, pattern)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`);

	private selectByValueRuleStmt = this.db.prepare(`
		SELECT * FROM redaction_false_positives
		WHERE value = ? AND rule_id = ? AND (session_id = ? OR session_id IS NULL)
	`);

	private selectAllStmt = this.db.prepare(`
		SELECT * FROM redaction_false_positives
		WHERE (? IS NULL OR rule_id = ?) AND (? IS NULL OR session_id = ? OR session_id IS NULL)
		ORDER BY timestamp DESC
	`);

	private deleteStmt = this.db.prepare(`
		DELETE FROM redaction_false_positives
		WHERE value = ? AND rule_id = ? AND (session_id = ? OR session_id IS NULL)
	`);

	private clearStmt = this.db.prepare(`
		DELETE FROM redaction_false_positives
		WHERE (? IS NULL OR rule_id = ?) AND (? IS NULL OR session_id = ? OR session_id IS NULL)
	`);

	async recordFalsePositive(entry: Omit<FalsePositiveEntry, "pattern"> & { pattern?: string }): Promise<FalsePositiveEntry> {
		const pattern = entry.pattern ?? (entry.matchMode === "pattern"
			? generatePatternFromValue(entry.value)
			: entry.value); // For exact mode, pattern is just the value

		const fullEntry: FalsePositiveEntry = {
			...entry,
			pattern,
		};

		this.insertStmt.run(
			fullEntry.value,
			fullEntry.ruleId,
			fullEntry.label,
			fullEntry.path,
			fullEntry.timestamp,
			fullEntry.sessionId ?? null,
			fullEntry.matchMode,
			fullEntry.pattern,
		);

		return fullEntry;
	}

	async isFalsePositive(value: string, ruleId: string, sessionId?: string): Promise<boolean> {
		// Check exact matches (both exact and pattern mode entries with this exact value)
		const exactRows = this.selectByValueRuleStmt.all(value, ruleId, sessionId ?? null) as FalsePositiveRow[];
		
		for (const row of exactRows) {
			const entry = rowToEntry(row);
			if (entry.matchMode === "exact" && entry.value === value) {
				return true;
			}
			if (entry.matchMode === "pattern") {
				try {
					const regex = new RegExp(entry.pattern);
					if (regex.test(value)) {
						return true;
					}
				} catch {
					// Invalid regex, skip
				}
			}
		}

		// Also check pattern-mode entries that might match this value (different value but pattern matches)
		// Need to respect session scoping: global (null) + specific session
		const patternStmt = this.db.prepare(`
			SELECT * FROM redaction_false_positives
			WHERE rule_id = ? AND match_mode = 'pattern' 
			AND (session_id IS NULL OR session_id = ?)
		`);
		const patternRows = patternStmt.all(ruleId, sessionId ?? null) as FalsePositiveRow[];

		for (const row of patternRows) {
			const entry = rowToEntry(row);
			// Skip if already checked in exact match (value matches exactly)
			if (entry.value === value) continue;
			// Session scoping is handled by the query above
			try {
				const regex = new RegExp(entry.pattern);
				if (regex.test(value)) {
					return true;
				}
			} catch {
				// Invalid regex, skip
			}
		}

		return false;
	}

	async getAllFalsePositives(ruleId?: string, sessionId?: string): Promise<FalsePositiveEntry[]> {
		const rows = this.selectAllStmt.all(ruleId ?? null, ruleId ?? null, sessionId ?? null, sessionId ?? null) as FalsePositiveRow[];
		return rows.map(rowToEntry);
	}

	async removeFalsePositive(value: string, ruleId: string, sessionId?: string): Promise<boolean> {
		const result = this.deleteStmt.run(value, ruleId, sessionId ?? null);
		return result.changes > 0;
	}

	async clear(ruleId?: string, sessionId?: string): Promise<number> {
		const result = this.clearStmt.run(ruleId ?? null, ruleId ?? null, sessionId ?? null, sessionId ?? null);
		return result.changes;
	}
}

/**
 * In-memory implementation of FeedbackStore for testing.
 * Does not persist across restarts.
 */
export class MemoryFeedbackStore implements FeedbackStore {
	private entries: FalsePositiveEntry[] = [];

	async recordFalsePositive(entry: Omit<FalsePositiveEntry, "pattern"> & { pattern?: string }): Promise<FalsePositiveEntry> {
		const pattern = entry.pattern ?? (entry.matchMode === "pattern"
			? generatePatternFromValue(entry.value)
			: entry.value);

		const fullEntry: FalsePositiveEntry = {
			...entry,
			pattern,
		};

		this.entries.push(fullEntry);
		return fullEntry;
	}

	async isFalsePositive(value: string, ruleId: string, sessionId?: string): Promise<boolean> {
		for (const entry of this.entries) {
			if (entry.ruleId !== ruleId) continue;
			// Match SQLite behavior: include session-specific entries AND global entries (sessionId is null/undefined)
			if (entry.sessionId && entry.sessionId !== sessionId) continue;
			// If entry has no sessionId (global), it matches regardless of whether sessionId is provided

			if (entry.matchMode === "exact" && entry.value === value) {
				return true;
			}
			if (entry.matchMode === "pattern") {
				try {
					const regex = new RegExp(entry.pattern);
					if (regex.test(value)) {
						return true;
					}
				} catch {
					// Invalid regex, skip
				}
			}
		}
		return false;
	}

	async getAllFalsePositives(ruleId?: string, sessionId?: string): Promise<FalsePositiveEntry[]> {
		return this.entries
			.filter((entry) => {
				if (ruleId && entry.ruleId !== ruleId) return false;
				// Include session-specific entries AND global entries (sessionId is null/undefined)
				if (sessionId && entry.sessionId && entry.sessionId !== sessionId) return false;
				return true;
			})
			.sort((a, b) => b.timestamp - a.timestamp);
	}

	async removeFalsePositive(value: string, ruleId: string, sessionId?: string): Promise<boolean> {
		const index = this.entries.findIndex(
			(entry) =>
				entry.value === value &&
				entry.ruleId === ruleId &&
				// Match SQLite behavior: include session-specific entries AND global entries (sessionId is null/undefined)
				(!entry.sessionId || !sessionId || entry.sessionId === sessionId)
		);

		if (index >= 0) {
			this.entries.splice(index, 1);
			return true;
		}
		return false;
	}

	async clear(ruleId?: string, sessionId?: string): Promise<number> {
		const initialLength = this.entries.length;
		this.entries = this.entries.filter((entry) => {
			if (ruleId && entry.ruleId !== ruleId) return true;
			// Include session-specific entries AND global entries (sessionId is null/undefined)
			if (sessionId && entry.sessionId && entry.sessionId !== sessionId) return true;
			return false;
		});
		return initialLength - this.entries.length;
	}
}

/**
 * Create a FeedbackStore instance based on configuration.
 * @param type - 'sqlite' for persistent storage, 'memory' for testing
 * @returns FeedbackStore instance
 */
export function createFeedbackStore(type: "sqlite" | "memory" = "sqlite"): FeedbackStore {
	switch (type) {
		case "sqlite":
			return new SqliteFeedbackStore();
		case "memory":
			return new MemoryFeedbackStore();
		default:
			throw new Error(`Unknown FeedbackStore type: ${type}`);
	}
}