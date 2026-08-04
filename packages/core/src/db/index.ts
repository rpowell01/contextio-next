/**
 * Database core module for @contextio/core.
 * Provides SQLite connection management, migrations, and schema initialization.
 */

import { runMigrations as runMigrationsFn } from "./migrations.js";
import {
	ensureDefaultProviders,
	importProvidersFromJson,
} from "./provider-repo.js";

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

/**
 * Initialize the database: open connection and run all pending migrations.
 * Call this once at application startup.
 */
export function initDb(): void {
	// Run all pending migrations (initConnection is called internally)
	runMigrationsFn();
	
	// Ensure default providers are seeded in the database
	ensureDefaultProviders();
	
	// Import providers from providers.json for backward compatibility
	// This allows existing providers.json configurations to be migrated to SQLite
	importProvidersFromJson();
}

/**
 * Re-export the Database class from better-sqlite3 for advanced usage.
 */
export { Database } from "./connection.js";

