/**
 * CLI commands for capture management using SQLite index.
 * Provides `contextio captures list|stats|search|reindex` commands.
 */

import {
	listCaptureFilesSqlite,
	findLastSessionIdSqlite,
	loadSessionCapturesSqlite,
	getCaptureStats,
	searchCapturesSqlite,
	reindexCaptures,
	type CaptureMetadata,
	type MigrateCapturesResult,
} from "../captures.js";

interface CaptureListOptions {
	session?: string;
	since?: string;
	limit?: string;
	offset?: string;
	dir?: string;
}

interface CaptureSearchOptions {
	session?: string;
	model?: string;
	status?: string;
	since?: string;
	until?: string;
	limit?: string;
	offset?: string;
	dir?: string;
}

interface CaptureReindexOptions {
	dir?: string;
	keyMaterial?: string;
	force?: boolean;
	dryRun?: boolean;
}

/**
 * Parse date string to epoch milliseconds.
 * Supports ISO dates, relative formats like "1h", "30m", "7d", and epoch ms.
 */
function parseDate(dateStr: string): number {
	// Try ISO date first
	const isoDate = new Date(dateStr);
	if (!isNaN(isoDate.getTime())) {
		return isoDate.getTime();
	}

	// Try relative format: number + unit (s, m, h, d) - case insensitive
	const match = dateStr.match(/^(\d+)([smhd])$/i);
	if (match) {
		const value = parseInt(match[1], 10);
		const unit = match[2].toLowerCase();
		const multipliers: Record<string, number> = {
			s: 1000,
			m: 60 * 1000,
			h: 60 * 60 * 1000,
			d: 24 * 60 * 60 * 1000,
		};
		return Date.now() - value * multipliers[unit];
	}

	// Try epoch milliseconds
	const epoch = parseInt(dateStr, 10);
	if (!isNaN(epoch)) {
		return epoch;
	}

	throw new Error(`Invalid date format: ${dateStr}. Use ISO date, relative (1h, 30m, 7d), or epoch ms.`);
}

/**
 * Format capture metadata for display.
 */
function formatCaptureMetadata(meta: CaptureMetadata): string {
	const date = new Date(meta.timestamp).toISOString().replace("T", " ").substring(0, 19);
	const session = meta.sessionId ?? "no-session";
	const model = meta.requestModel ?? meta.responseModel ?? "unknown";
	const status = meta.status;
	const tokens = meta.tokensPrompt ?? 0;
	const completion = meta.tokensCompletion ?? 0;
	return `${date} | ${session} | ${model} | ${status} | tokens: ${tokens}+${completion} | ${meta.filepath}`;
}

/**
 * Run captures list command.
 */
export async function runCapturesList(options: CaptureListOptions): Promise<void> {
	console.log("[captures] Listing captures...");

	const limit = options.limit ? parseInt(options.limit, 10) : 50;
	const offset = options.offset ? parseInt(options.offset, 10) : 0;

	let dateRange: { start: number; end: number } | undefined;
	if (options.since) {
		dateRange = { start: parseDate(options.since), end: Date.now() };
	}

	const files = await listCaptureFilesSqlite(options.dir, {
		sessionId: options.session,
		dateRange,
		limit,
		offset,
	});

	if (files.length === 0) {
		console.log("No captures found.");
		return;
	}

	console.log(`Found ${files.length} capture(s):`);
	for (const file of files) {
		console.log(`  ${file}`);
	}
}

/**
 * Run captures stats command.
 */
export async function runCapturesStats(): Promise<void> {
	console.log("[captures] Fetching statistics...");

	const stats = await getCaptureStats();

	if (!stats) {
		console.log("Database not initialized. Run 'contextio migrate captures' to index captures first.");
		return;
	}

	console.log("\nCapture Statistics:");
	console.log(`  Total captures: ${stats.totalCaptures}`);
	console.log(`  Total sessions: ${stats.totalSessions}`);
	if (stats.dateRange.earliest > 0 && stats.dateRange.latest > 0) {
		const earliest = new Date(stats.dateRange.earliest).toISOString();
		const latest = new Date(stats.dateRange.latest).toISOString();
		console.log(`  Date range: ${earliest} to ${latest}`);
	} else {
		console.log("  Date range: no captures");
	}
}

/**
 * Run captures search command.
 */
export async function runCapturesSearch(options: CaptureSearchOptions): Promise<void> {
	console.log("[captures] Searching captures...");

	const limit = options.limit ? parseInt(options.limit, 10) : 50;
	const offset = options.offset ? parseInt(options.offset, 10) : 0;

	const query: Parameters<typeof searchCapturesSqlite>[0] = {};

	if (options.session) query.sessionId = options.session;
	if (options.model) query.model = options.model;
	if (options.status) query.status = options.status;
	if (options.since) query.startDate = parseDate(options.since);
	if (options.until) query.endDate = parseDate(options.until);
	query.limit = limit;
	query.offset = offset;

	const results = await searchCapturesSqlite(query);

	if (results.length === 0) {
		console.log("No captures found matching criteria.");
		return;
	}

	console.log(`Found ${results.length} capture(s):`);
	for (const meta of results) {
		console.log(`  ${formatCaptureMetadata(meta)}`);
	}
}

/**
 * Run captures reindex command.
 */
export async function runCapturesReindex(options: CaptureReindexOptions): Promise<void> {
	console.log("[captures] Reindexing captures...");

	if (options.dryRun) {
		console.log("DRY RUN - no changes will be made");
	}

	const result = await reindexCaptures(options.dir, options.keyMaterial, options.force, options.dryRun);

	printReindexResult(result);

	if (result.failed > 0) {
		console.error("[captures] Some captures failed to reindex:");
		for (const error of result.errors) {
			console.error(`  - ${error.file}: ${error.error}`);
		}
		process.exit(1);
	}
}

/**
 * Print reindex result summary (matches migrate captures output).
 */
function printReindexResult(result: MigrateCapturesResult): void {
	console.log(`\n[captures] Reindex complete:`);
	console.log(`  Files scanned: ${result.totalFiles}`);
	console.log(`  Indexed: ${result.indexed}`);
	console.log(`  Skipped: ${result.skipped}`);
	console.log(`  Failed: ${result.failed}`);
}