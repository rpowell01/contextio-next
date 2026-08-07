/**
 * Database core module for @contextio/core.
 * Provides SQLite connection management, migrations, and schema initialization.
 */
export { getDb, initConnection, closeDb, isDbInitialized, getDbPath, } from "./connection.js";
export { runMigrations, getSchemaVersion, getAppliedMigrations, getPendingMigrations, type Migration, } from "./migrations.js";
export { createProvider, getProviderById, getAllProvidersFromDb, updateProvider, deleteProvider, providerExists, getAllMergedProviders, importProvidersFromJson, type ProviderRow, type MergedProvider, type ProviderConfigWithMeta, } from "./provider-repo.js";
export { upsertCapture, upsertCaptures, getCaptureById, getCapturesBySession, getRecentCaptures, getCapturesByDateRange, deleteCapture, getCaptureCount, getStats, searchCaptures, type CaptureMetadata, } from "./capture-repo.js";
export { upsertRedactionMetadata, upsertRedactionMetadataBulk, getRedactionMetadataByCaptureId, getRedactionMetadataBySessionId, aggregateRedactionMetadataBySession, deleteRedactionMetadataByCaptureId, getRedactionAggregateStats, importRedactionMetaFromFiles, redactionMetadataExists, type RedactionMetadata, type RedactionMetadataRow, type SessionRedactionAggregate, } from "./redaction-repo.js";
/**
 * Initialize the database: open connection and run all pending migrations.
 * Call this once at application startup.
 */
export declare function initDb(decryptFn?: (encryptedJson: string, keyMaterial: string) => Promise<string>): void;
/**
 * Re-export the Database class from better-sqlite3 for advanced usage.
 */
export { Database } from "./connection.js";
//# sourceMappingURL=index.d.ts.map