/**
 * Migration utility for indexing existing capture files into SQLite.
 * Scans the capture directory, parses each capture file, and upserts
 * metadata into the captures_metadata table.
 */

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CaptureMetadata } from "../types.js";
import { upsertCaptures, getCaptureById } from "./capture-repo.js";

/** Shape of a capture file on disk (written by logger plugin). */
interface CaptureFile {
	timestamp: string | number;
	sessionId?: string | null;
	captureId?: string;
	requestModel?: string | null;
	responseModel?: string | null;
	tokensPrompt?: number | null;
	tokens_prompt?: number | null;
	tokensCompletion?: number | null;
	tokens_completion?: number | null;
	durationMs?: number | null;
	timings?: { total_ms?: number };
	status?: string;
	responseStatus?: number;
	ciphertext?: string;
	salt?: string;
	iv?: string;
	[key: string]: unknown;
}

/** Options for the capture migration. */
export interface MigrateCapturesOptions {
	/** Custom capture directory (defaults to ~/.contextio/captures or LOGGER_CAPTURE_DIR). */
	captureDir?: string;
	/** Decryption function for encrypted captures. */
	decryptFn?: (encryptedJson: string, keyMaterial: string) => Promise<string>;
	/** Encryption key material for decrypting captures. */
	keyMaterial?: string;
	/** Force re-indexing of already-indexed captures. */
	force?: boolean;
	/** Dry run mode - preview changes without writing to database. */
	dryRun?: boolean;
	/** Progress callback (called every 100 files). */
	onProgress?: (processed: number, total: number) => void;
	/** Maximum number of files to process (for testing). */
	maxFiles?: number;
}

/** Result of the capture migration. */
export interface MigrateCapturesResult {
	/** Number of captures indexed (new or updated). */
	indexed: number;
	/** Number of captures skipped (already indexed and not forced). */
	skipped: number;
	/** Number of captures that failed to parse or index. */
	failed: number;
	/** Total files scanned. */
	totalFiles: number;
	/** List of failed files with error messages. */
	errors: Array<{ file: string; error: string }>;
}

/**
 * Get the default capture directory.
 * Uses LOGGER_CAPTURE_DIR env var or falls back to ~/.contextio/captures.
 */
export function getDefaultCaptureDir(): string {
	const envPath = process.env.LOGGER_CAPTURE_DIR;
	if (envPath) return envPath;
	return join(homedir(), ".contextio", "captures");
}

/**
 * Extract metadata from a CaptureFile object.
 */
function extractCaptureMetadata(capture: CaptureFile, filepath: string): CaptureMetadata {
	const timestamp = typeof capture.timestamp === "string"
		? new Date(capture.timestamp).getTime()
		: capture.timestamp;

	return {
		id: capture.captureId || filepath.split("/").pop()?.replace(/\.json$/, "") || "unknown",
		sessionId: capture.sessionId ?? undefined,
		filepath,
		timestamp,
		requestModel: capture.requestModel ?? undefined,
		responseModel: capture.responseModel ?? undefined,
		tokensPrompt: capture.tokensPrompt ?? capture.tokens_prompt ?? undefined,
		tokensCompletion: capture.tokensCompletion ?? capture.tokens_completion ?? undefined,
		durationMs: capture.durationMs ?? capture.timings?.total_ms ?? undefined,
		status: capture.status ?? (capture.responseStatus !== undefined && capture.responseStatus >= 400 ? "error" : "success"),
		createdAt: Date.now(),
	};
}

/**
 * Parse a capture file (handles both plaintext and encrypted).
 */
async function parseCaptureFile(
	filepath: string,
	decryptFn?: (encryptedJson: string, keyMaterial: string) => Promise<string>,
	keyMaterial?: string
): Promise<CaptureFile> {
	try {
		const raw = fs.readFileSync(filepath, "utf8");
		const parsed = JSON.parse(raw) as CaptureFile;

		// Check if encrypted
		const isEncrypted =
			typeof parsed.ciphertext === "string" &&
			typeof parsed.salt === "string" &&
			typeof parsed.iv === "string";

		if (isEncrypted) {
			if (!decryptFn || !keyMaterial) {
				throw new Error("Encrypted capture but no decrypt function or key material provided");
			}
			const plaintext = await decryptFn(raw, keyMaterial);
			return JSON.parse(plaintext);
		}

		return parsed;
	} catch (err) {
		throw new Error(`Failed to parse ${filepath}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Migrate existing capture files to SQLite index.
 * Scans the capture directory for .json files, parses each one,
 * and upserts metadata into the captures_metadata table.
 */
export async function migrateCaptures(options: MigrateCapturesOptions = {}): Promise<MigrateCapturesResult> {
	const captureDir = options.captureDir || getDefaultCaptureDir();
	const force = options.force ?? false;
	const dryRun = options.dryRun ?? false;
	const maxFiles = options.maxFiles;
	const onProgress = options.onProgress;

	const result: MigrateCapturesResult = {
		indexed: 0,
		skipped: 0,
		failed: 0,
		totalFiles: 0,
		errors: [],
	};

	// Check if capture directory exists
	if (!fs.existsSync(captureDir)) {
		console.log(`[migrate-captures] Capture directory does not exist: ${captureDir}`);
		return result;
	}

	// Get all .json files in the capture directory
	const files = fs.readdirSync(captureDir)
		.filter(f => f.endsWith(".json") && !f.endsWith(".tmp"))
		.sort();

	if (maxFiles && maxFiles > 0) {
		files.length = maxFiles;
	}

	result.totalFiles = files.length;
	console.log(`[migrate-captures] Found ${files.length} capture files in ${captureDir}`);

	if (files.length === 0) {
		return result;
	}

	// Process files in batches for better performance
	const BATCH_SIZE = 100;
	const batches: string[][] = [];

	for (let i = 0; i < files.length; i += BATCH_SIZE) {
		batches.push(files.slice(i, i + BATCH_SIZE));
	}

	for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
		const batch = batches[batchIndex];
		const metadataBatch: CaptureMetadata[] = [];

		for (const file of batch) {
			const filepath = join(captureDir, file);

			try {
				// Check if already indexed (unless force)
				if (!force) {
					const existing = getCaptureById(file.replace(/\.json$/, ""));
					if (existing) {
						result.skipped++;
						continue;
					}
				}

				// Parse the capture file
				const capture = await parseCaptureFile(filepath, options.decryptFn, options.keyMaterial);
				
				// Extract metadata
				const metadata = extractCaptureMetadata(capture, file);
				metadataBatch.push(metadata);

			} catch (err) {
				result.failed++;
				result.errors.push({
					file,
					error: err instanceof Error ? err.message : String(err),
				});
				console.warn(`[migrate-captures] Failed to process ${file}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		// Bulk upsert the batch
		if (metadataBatch.length > 0) {
			if (!dryRun) {
				upsertCaptures(metadataBatch);
			}
			result.indexed += metadataBatch.length;
		}

		// Report progress
		const processed = Math.min((batchIndex + 1) * BATCH_SIZE, files.length);
		if (onProgress) {
			onProgress(processed, files.length);
		} else {
			console.log(`[migrate-captures] Processed ${processed}/${files.length} files...`);
		}
	}

	console.log(`[migrate-captures] Complete: ${result.indexed} indexed, ${result.skipped} skipped, ${result.failed} failed`);
	return result;
}

/**
 * Synchronous version for simpler use cases (no encryption).
 * Only works with plaintext captures.
 */
export function migrateCapturesSync(options: Omit<MigrateCapturesOptions, "decryptFn" | "keyMaterial"> = {}): MigrateCapturesResult {
	const captureDir = options.captureDir || getDefaultCaptureDir();
	const force = options.force ?? false;
	const dryRun = options.dryRun ?? false;
	const maxFiles = options.maxFiles;
	const onProgress = options.onProgress;

	const result: MigrateCapturesResult = {
		indexed: 0,
		skipped: 0,
		failed: 0,
		totalFiles: 0,
		errors: [],
	};

	if (!fs.existsSync(captureDir)) {
		console.log(`[migrate-captures] Capture directory does not exist: ${captureDir}`);
		return result;
	}

	const files = fs.readdirSync(captureDir)
		.filter(f => f.endsWith(".json") && !f.endsWith(".tmp"))
		.sort();

	if (maxFiles && maxFiles > 0) {
		files.length = maxFiles;
	}

	result.totalFiles = files.length;
	console.log(`[migrate-captures] Found ${files.length} capture files in ${captureDir}`);

	if (files.length === 0) {
		return result;
	}

	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		const filepath = join(captureDir, file);

		try {
			if (!force) {
				const existing = getCaptureById(file.replace(/\.json$/, ""));
				if (existing) {
					result.skipped++;
					continue;
				}
			}

			const raw = fs.readFileSync(filepath, "utf8");
			const capture = JSON.parse(raw);

			const metadata = extractCaptureMetadata(capture, file);
			
			if (!dryRun) {
				upsertCaptures([metadata]);
			}
			result.indexed++;

		} catch (err) {
			result.failed++;
			result.errors.push({
				file,
				error: err instanceof Error ? err.message : String(err),
			});
			console.warn(`[migrate-captures] Failed to process ${file}: ${err instanceof Error ? err.message : String(err)}`);
		}

		// Report progress every 100 files
		if ((i + 1) % 100 === 0 || i === files.length - 1) {
			if (onProgress) {
				onProgress(i + 1, files.length);
			} else {
				console.log(`[migrate-captures] Processed ${i + 1}/${files.length} files...`);
			}
		}
	}

	console.log(`[migrate-captures] Complete: ${result.indexed} indexed, ${result.skipped} skipped, ${result.failed} failed`);
	return result;
}