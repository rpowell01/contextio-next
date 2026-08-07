/**
 * Database core module for @contextio/core.
 * Provides SQLite connection management, migrations, and schema initialization.
 */
import { homedir } from "os";
import { runMigrations as runMigrationsFn } from "./migrations.js";
import { importProvidersFromJson, } from "./provider-repo.js";
import { importRedactionMetaFromFiles } from "./redaction-repo.js";
export { getDb, initConnection, closeDb, isDbInitialized, getDbPath, } from "./connection.js";
export { runMigrations, getSchemaVersion, getAppliedMigrations, getPendingMigrations, } from "./migrations.js";
export { createProvider, getProviderById, getAllProvidersFromDb, updateProvider, deleteProvider, providerExists, getAllMergedProviders, importProvidersFromJson, } from "./provider-repo.js";
export { upsertCapture, upsertCaptures, getCaptureById, getCapturesBySession, getRecentCaptures, getCapturesByDateRange, deleteCapture, getCaptureCount, getStats, searchCaptures, } from "./capture-repo.js";
export { upsertRedactionMetadata, upsertRedactionMetadataBulk, getRedactionMetadataByCaptureId, getRedactionMetadataBySessionId, aggregateRedactionMetadataBySession, deleteRedactionMetadataByCaptureId, getRedactionAggregateStats, importRedactionMetaFromFiles, redactionMetadataExists, } from "./redaction-repo.js";
/**
 * Initialize the database: open connection and run all pending migrations.
 * Call this once at application startup.
 */
export function initDb(decryptFn) {
    // Run all pending migrations (initConnection is called internally)
    runMigrationsFn();
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
function getCaptureDirForRedactionImport() {
    const envPath = process.env.LOGGER_CAPTURE_DIR;
    if (envPath) {
        return envPath;
    }
    const home = homedir();
    return `${home}/.contextio/captures`;
}
/**
 * Re-export the Database class from better-sqlite3 for advanced usage.
 */
export { Database } from "./connection.js";
//# sourceMappingURL=index.js.map