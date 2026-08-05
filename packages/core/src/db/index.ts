/**
 * Database core module for @contextio/core.
 * Provides SQLite connection management, migrations, and schema initialization.
 */

import { runMigrations as runMigrationsFn } from "./migrations.js";
import {
	ensureDefaultProviders,
	importProvidersFromJson,
} from "./provider-repo.js";
import { importRedactionMetaFromFiles } from "./redaction-repo.js";

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
	ensureDefaultProviders,
	importProvidersFromJson,
	type ProviderRow,
	type MergedProvider,
	type ProviderConfigWithMeta,
} from "./provider-repo.js";

export {
	upsertCapture,
	upsertCaptures,
	getCaptureById,
	getCapturesBySession,
	getRecentCaptures,
	getCapturesByDateRange,
	deleteCapture,
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
	type RedactionMetadataRow,
	type SessionRedactionAggregate,
} from "./redaction-repo.js";

/**
 * Initialize the database: open connection and run all pending migrations.
 * Call this once at application startup.
 */
export function initDb(decryptFn?: (encryptedJson: string, keyMaterial: string) => Promise<string>): void {
	// Run all pending migrations (initConnection is called internally)
	runMigrationsFn();
	
	// Ensure default providers are seeded in the database
	ensureDefaultProviders();
	
	// Import providers from providers.json for backward compatibility
	// This allows existing providers.json configurations to be migrated to SQLite
	importProvidersFromJson();
	
	// Import existing .redact-meta.json sidecar files into SQLite
	// This allows existing redaction metadata to be migrated to SQLite
	importRedactionMetaFromFiles(getCaptureDirForRedactionImport(), decryptFn);
}

/**
 * Get the capture directory for redaction metadata import.
 * Uses the same resolution logic as the proxy/web packages.
 */
function getCaptureDirForRedactionImport(): string {
	const envPath = process.env.LOGGER_CAPTURE_DIR;
	if (envPath) {
		return envPath;
	}
	const { homedir } = require("os");
	const home = homedir();
	return `${home}/.contextio/captures`;
}

/**
 * Re-export the Database class from better-sqlite3 for advanced usage.
 */
export { Database } from "./connection.js";

