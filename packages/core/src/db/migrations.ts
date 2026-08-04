/**
 * Migration runner for SQLite database.
 * Tracks applied migrations in schema_version table and applies pending migrations in order.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, initConnection } from "./connection.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

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
 * Get all migration files from the migrations directory.
 * Files should be named like: 001_initial_schema.sql, 002_add_index.sql, etc.
 * Returns empty array if directory doesn't exist.
 */
function getMigrationFiles(): string[] {
  const migrationsDir = join(__dirname, "migrations");
  try {
    if (!statSync(migrationsDir).isDirectory()) {
      return [];
    }
    return readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    // Directory doesn't exist or can't be read
    return [];
  }
}

/**
 * Parse a migration file to extract version, name, and SQL.
 * Expects format: NNN_name.sql
 */
function parseMigrationFile(filename: string): Migration {
  const match = filename.match(/^(\d{3,})_(.+)\.sql$/);
  if (!match) {
    throw new Error(`Invalid migration filename format: ${filename}. Expected NNN_name.sql`);
  }
  const version = parseInt(match[1], 10);
  const name = match[2].replace(/_/g, " ");
  const filepath = join(__dirname, "migrations", filename);
  const sql = readFileSync(filepath, "utf-8");

  // Split into up/down if down migration is provided (separated by -- DOWN)
  const parts = sql.split(/^--\s*DOWN\s*$/m);
  const up = parts[0].trim();
  const down = parts[1]?.trim();

  return {
    version,
    name,
    up,
    down: down || undefined,
  };
}

/**
 * Get all migrations sorted by version.
 */
export function getMigrations(): Migration[] {
  const files = getMigrationFiles();
  return files.map(parseMigrationFile).sort((a, b) => a.version - b.version);
}

/**
 * Get the current schema version from the database.
 * Returns 0 if the schema_version table doesn't exist yet (fresh database).
 */
function getCurrentVersion(db: ReturnType<typeof getDb>): number {
  try {
    const row = db.prepare("SELECT MAX(version) as version FROM schema_version").get() as
      | { version: number | null }
      | undefined;
    return row?.version ?? 0;
  } catch (err) {
    // Table doesn't exist yet (fresh database)
    if (err instanceof Error && err.message.includes("no such table")) {
      return 0;
    }
    throw err;
  }
}

/**
 * Apply a single migration.
 */
function applyMigration(db: ReturnType<typeof getDb>, migration: Migration): void {
  const transaction = db.transaction(() => {
    // Execute the migration SQL
    if (migration.up) {
      db.exec(migration.up);
    }
    // Record the migration
    db.prepare(
      "INSERT INTO schema_version (version, description) VALUES (?, ?)"
    ).run(migration.version, migration.name);
  });
  transaction();
}

/**
 * Run all pending migrations.
 * This should be called on application startup.
 */
export function runMigrations(): void {
  const db = initConnection();
  const migrations = getMigrations();
  const currentVersion = getCurrentVersion(db);

  const pendingMigrations = migrations.filter((m) => m.version > currentVersion);

  if (pendingMigrations.length === 0) {
    return; // No pending migrations
  }

  for (const migration of pendingMigrations) {
    applyMigration(db, migration);
  }
}

/**
 * Get the current schema version.
 */
export function getSchemaVersion(): number {
  const db = getDb();
  return getCurrentVersion(db);
}

/**
 * Get list of applied migrations.
 * Returns empty array if the schema_version table doesn't exist yet (fresh database).
 */
export function getAppliedMigrations(): Array<{ version: number; applied_at: number; description: string }> {
  const db = getDb();
  try {
    return db.prepare("SELECT version, applied_at, description FROM schema_version ORDER BY version").all() as Array<{
      version: number;
      applied_at: number;
      description: string;
    }>;
  } catch (err) {
    // Table doesn't exist yet (fresh database)
    if (err instanceof Error && err.message.includes("no such table")) {
      return [];
    }
    throw err;
  }
}

/**
 * Get list of pending migrations.
 */
export function getPendingMigrations(): Migration[] {
  const db = getDb();
  const currentVersion = getCurrentVersion(db);
  return getMigrations().filter((m) => m.version > currentVersion);
}
