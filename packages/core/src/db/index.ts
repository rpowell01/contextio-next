/**
 * Database core module for @contextio/core.
 * Provides SQLite connection management, migrations, and schema initialization.
 */

import { homedir } from "os";
import fs from "node:fs";
import { runMigrations as runMigrationsFn } from "./migrations.js";
import {
	importProvidersFromJson,
} from "./provider-repo.js";
import { importRedactionMetaFromFiles } from "./redaction-repo.js";
import { migrateCapturesSync, getDefaultCaptureDir, migrateCaptures } from "./migrate-captures.js";
import { migrateProviders, getDefaultProvidersFile } from "./migrate-providers.js";
import { importSettingsFromJson, getDefaultSettingsFile } from "./settings-repo.js";
import { getDb } from "./connection.js";

export {
	getDb,
	initConnection,
	closeDb,
	isDbInitialized,
	getDbPath,
} from "./connection.js";

export {
	runMigrations,
	getSchemaVersion,
	getAppliedMigrations,
	getPendingMigrations,
	type Migration,
} from "./migrations.js";

export {
	createProvider,
	getProviderById,
	getAllProvidersFromDb,
	updateProvider,
	deleteProvider,
	providerExists,
	getAllMergedProviders,
	importProvidersFromJson,
	type ProviderRow,
	type MergedProvider,
	type ProviderConfigWithMeta,
} from "./provider-repo.js";

export {
	getSettings,
	upsertSettings,
	getSettingsWithMeta,
	importSettingsFromJson,
	getDefaultSettingsFile,
	type Settings,
	type SettingsRow,
	type SettingMeta,
	type SettingSource,
	type ImportSettingsResult,
	type RateLimitConfig,
	type StreamingRetryConfig,
} from "./settings-repo.js";

export {
	upsertCapture,
	upsertCaptures,
	getCaptureById,
	getCapturesBySession,
	getRecentCaptures,
	getCapturesByDateRange,
	deleteCapture,
	deleteCaptureByFilepath,
	deleteCapturesByFilepaths,
	getCaptureCount,
	getStats,
	searchCaptures,
	type CaptureMetadata,
} from "./capture-repo.js";

export {
	upsertRedactionMetadata,
	upsertRedactionMetadataBulk,
	getRedactionMetadataByCaptureId,
	getRedactionMetadataBySessionId,
	aggregateRedactionMetadataBySession,
	deleteRedactionMetadataByCaptureId,
	getRedactionAggregateStats,
	importRedactionMetaFromFiles,
	redactionMetadataExists,
	type RedactionMetadata,
	type RedactionMatch,
	type RedactionMetadataRow,
	type SessionRedactionAggregate,
} from "./redaction-repo.js";

export {
	migrateCaptures,
	migrateCapturesSync,
	getDefaultCaptureDir,
	type MigrateCapturesOptions,
	type MigrateCapturesResult,
} from "./migrate-captures.js";

export {
	migrateProviders,
	previewProvidersMigration,
	getDefaultProvidersFile,
	type MigrateProvidersOptions,
	type MigrateProvidersResult,
} from "./migrate-providers.js";

/**
 * Check if the database has been initialized (schema_version table has entries).
 * This indicates whether this is a fresh database that needs auto-migration.
 */
function isDatabaseInitialized(): boolean {
	const db = getDb();
	try {
		const row = db.prepare("SELECT COUNT(*) as count FROM schema_version").get() as { count: number } | undefined;
		return (row?.count ?? 0) > 0;
	} catch {
		// Table doesn't exist or other error - treat as not initialized
		return false;
	}
}

/**
 * Initialize the database: open connection and run all pending migrations.
 * Call this once at application startup.
 * 
 * If this is a fresh database (schema_version is empty), automatically:
 * - Import providers from providers.json if it exists
 * - Index existing capture files if capture directory exists (runs in background)
 */
export function initDb(
	decryptFn?: (encryptedJson: string, keyMaterial: string) => Promise<string>,
	keyMaterial?: string
): void {
	// Check if this is a fresh database that needs auto-migration
	// Must check BEFORE running migrations since migrations populate schema_version
	const isFreshDb = !isDatabaseInitialized();
	
	// Run all pending migrations (initConnection is called internally)
	runMigrationsFn();
	
	if (isFreshDb) {
			console.log("[initDb] Fresh database detected, running auto-migration...");
			
			// Auto-migrate providers if providers.json exists
			const providersFile = getDefaultProvidersFile();
			if (fs.existsSync(providersFile)) {
				console.log("[initDb] Found providers.json, running provider migration...");
				try {
					migrateProviders({ dryRun: false, createBackup: true });
				} catch (err) {
					console.warn(`[initDb] Provider auto-migration failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			
			// Auto-migrate settings if settings.json exists
			const settingsFile = getDefaultSettingsFile();
			if (fs.existsSync(settingsFile)) {
				console.log("[initDb] Found settings.json, running settings migration...");
				try {
					const result = importSettingsFromJson(settingsFile);
					if (result.imported) {
						console.log("[initDb] Settings auto-migration completed successfully");
					} else if (result.skipped) {
						console.log("[initDb] Settings auto-migration skipped");
					} else {
						console.warn(`[initDb] Settings auto-migration failed: ${result.error}`);
					}
				} catch (err) {
					console.warn(`[initDb] Settings auto-migration failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			
			// Auto-migrate captures if capture directory exists (run in background)
			const captureDir = getDefaultCaptureDir();
			if (fs.existsSync(captureDir)) {
				console.log("[initDb] Found capture directory, scheduling capture indexing in background...");
				// Run capture indexing asynchronously (non-blocking)
				// Pass decryptFn and keyMaterial for encrypted captures
				setImmediate(() => {
					(async () => {
						try {
							if (decryptFn && keyMaterial) {
								// Use async version with decryption support
								await migrateCaptures({ dryRun: false, decryptFn, keyMaterial });
							} else {
								migrateCapturesSync({ dryRun: false });
							}
						} catch (err) {
							console.warn(`[initDb] Capture auto-migration failed: ${err instanceof Error ? err.message : String(err)}`);
						}
					})().catch((err) => {
						// Handle any promise rejection that escapes the async IIFE
						console.warn(`[initDb] Capture auto-migration failed: ${err instanceof Error ? err.message : String(err)}`);
					});
				});
			}
	}
	
	// Import existing .redact-meta.json sidecar files into SQLite
	// This allows existing redaction metadata to be migrated to SQLite
	importRedactionMetaFromFiles(getDefaultCaptureDir(), decryptFn);
}

/**
 * Re-export the Database class from better-sqlite3 for advanced usage.
 */
export { Database } from "./connection.js";

