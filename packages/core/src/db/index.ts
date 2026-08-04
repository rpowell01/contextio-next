/**
 * Database core module for @contextio/core.
 * Provides SQLite connection management, migrations, and schema initialization.
 */

import { runMigrations as runMigrationsFn } from "./migrations.js";

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

/**
 * Initialize the database: open connection and run all pending migrations.
 * Call this once at application startup.
 */
export function initDb(): void {
  // Run all pending migrations (initConnection is called internally)
  runMigrationsFn();
}

/**
 * Re-export the Database class from better-sqlite3 for advanced usage.
 */
export { Database } from "./connection.js";

