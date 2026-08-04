/**
 * Database connection wrapper using better-sqlite3.
 * Singleton pattern with configurable path, WAL mode, and graceful shutdown.
 */

import Database from "better-sqlite3";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";

let dbInstance: Database.Database | null = null;
let isInitialized = false;

/**
 * Get the database file path.
 * Uses CONTEXTIO_DB_PATH env var, or defaults to ~/.contextio/contextio.db
 */
export function getDbPath(): string {
  const envPath = process.env.CONTEXTIO_DB_PATH;
  if (envPath) {
    return resolve(envPath);
  }
  const home = homedir();
  const dir = resolve(home, ".contextio");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return resolve(dir, "contextio.db");
}

/**
 * Configure the database with optimal settings for SQLite.
 * - WAL mode for better concurrency
 * - busy_timeout=5000 for locking resilience
 * - foreign_keys=ON for referential integrity
 */
function configureDatabase(db: Database.Database): void {
  // Enable WAL mode for better concurrent access
  db.pragma("journal_mode = WAL");
  // Set busy timeout to 5 seconds
  db.pragma("busy_timeout = 5000");
  // Enable foreign key constraints
  db.pragma("foreign_keys = ON");
  // Optimize for performance
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -2000"); // 2MB cache
  db.pragma("temp_store = MEMORY");
}

/**
 * Get the singleton database instance.
 * Creates and configures the connection on first call.
 */
export function getDb(): Database.Database {
  if (!dbInstance) {
    const path = getDbPath();
    dbInstance = new Database(path);
    configureDatabase(dbInstance);
    isInitialized = true;
  }
  return dbInstance;
}

/**
 * Check if the database has been initialized.
 */
export function isDbInitialized(): boolean {
  return isInitialized && dbInstance !== null;
}

/**
 * Close the database connection gracefully.
 * Should be called on process exit.
 */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    isInitialized = false;
  }
}

/**
 * Initialize the database connection.
 * This is a convenience function that ensures the connection is established.
 */
export function initConnection(): Database.Database {
  return getDb();
}

// Register graceful shutdown handlers
if (typeof process !== "undefined") {
  // Signal handlers: close DB and exit with correct signal code
  const signalShutdown = (signal: string) => {
    closeDb();
    // Exit with standard signal codes: 128 + signal number
    // SIGINT=2 -> 130, SIGTERM=15 -> 143, SIGHUP=1 -> 129
    const signalMap: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
    process.exit(signalMap[signal] ?? 1);
  };
  // Exit handler: only close DB (exit code is already set by signal handler)
  const exitHandler = () => {
    closeDb();
  };
  process.on("exit", exitHandler);
  process.on("SIGINT", () => signalShutdown("SIGINT"));
  process.on("SIGTERM", () => signalShutdown("SIGTERM"));
  process.on("SIGHUP", () => signalShutdown("SIGHUP"));
}

export { Database };
