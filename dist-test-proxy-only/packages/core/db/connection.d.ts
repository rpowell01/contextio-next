/**
 * Database connection wrapper using better-sqlite3.
 * Singleton pattern with configurable path, WAL mode, and graceful shutdown.
 */
import Database from "better-sqlite3";
/**
 * Get the database file path.
 * Uses CONTEXTIO_DB_PATH env var, or defaults to ~/.contextio/contextio.db
 */
export declare function getDbPath(): string;
/**
 * Get the singleton database instance.
 * Creates and configures the connection on first call.
 */
export declare function getDb(): Database.Database;
/**
 * Check if the database has been initialized.
 */
export declare function isDbInitialized(): boolean;
/**
 * Close the database connection gracefully.
 * Should be called on process exit.
 */
export declare function closeDb(): void;
/**
 * Initialize the database connection.
 * This is a convenience function that ensures the connection is established.
 */
export declare function initConnection(): Database.Database;
export { Database };
//# sourceMappingURL=connection.d.ts.map