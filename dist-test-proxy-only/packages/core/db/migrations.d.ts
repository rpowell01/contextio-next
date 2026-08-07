/**
 * Migration runner for SQLite database.
 * Tracks applied migrations in schema_version table and applies pending migrations in order.
 */
/**
 * Migration interface representing a single migration.
 */
export interface Migration {
    version: number;
    name: string;
    up: string;
    down?: string;
}
/**
 * Get all migrations sorted by version.
 */
export declare function getMigrations(): Migration[];
/**
 * Run all pending migrations.
 * This should be called on application startup.
 */
export declare function runMigrations(): void;
/**
 * Get the current schema version.
 */
export declare function getSchemaVersion(): number;
/**
 * Get list of applied migrations.
 * Returns empty array if the schema_version table doesn't exist yet (fresh database).
 */
export declare function getAppliedMigrations(): Array<{
    version: number;
    applied_at: number;
    description: string;
}>;
/**
 * Get list of pending migrations.
 */
export declare function getPendingMigrations(): Migration[];
//# sourceMappingURL=migrations.d.ts.map