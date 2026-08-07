/**
 * CLI commands for database migrations.
 * Provides `contextio migrate captures|providers|all` commands.
 */

import { Command } from "commander";

import { 
	migrateCaptures, 
	migrateCapturesSync, 
	type MigrateCapturesOptions,
	type MigrateCapturesResult,
	migrateProviders, 
	previewProvidersMigration, 
	type MigrateProvidersOptions,
	type MigrateProvidersResult,
	initDb
} from "@contextio/core/db";

import { decrypt } from "@contextio/logger";

/**
 * Common migration options.
 */
interface BaseMigrationOptions {
	dryRun?: boolean;
	force?: boolean;
}

/**
 * Capture migration options.
 */
interface CaptureMigrationOptions extends BaseMigrationOptions {
	captureDir?: string;
	keyMaterial?: string;
	maxFiles?: number;
}

/**
 * Provider migration options.
 */
interface ProviderMigrationOptions extends BaseMigrationOptions {
	providersFile?: string;
	noBackup?: boolean;
}

/**
 * Run capture migration.
 */
export async function runMigrateCaptures(options: CaptureMigrationOptions): Promise<void> {
	console.log("[migrate] Starting capture migration...");

	const migrateOptions: MigrateCapturesOptions = {
		captureDir: options.captureDir,
		force: options.force,
		dryRun: options.dryRun,
		keyMaterial: options.keyMaterial,
		maxFiles: options.maxFiles,
	};

	// Use decrypt from logger when keyMaterial is provided
	const decryptFn = options.keyMaterial ? decrypt : undefined;
	
	const result = decryptFn
		? await migrateCaptures({ ...migrateOptions, decryptFn })
		: migrateCapturesSync(migrateOptions);

	printMigrationResult("Capture", result);

	if (result.failed > 0) {
		console.error("[migrate] Some captures failed to migrate:");
		for (const error of result.errors) {
			console.error(`  - ${error.file}: ${error.error}`);
		}
		process.exit(1);
	}
}

/**
 * Run provider migration.
 */
export async function runMigrateProviders(options: ProviderMigrationOptions): Promise<void> {
	console.log("[migrate] Starting provider migration...");

	const migrateOptions: MigrateProvidersOptions = {
		providersFile: options.providersFile,
		force: options.force,
		dryRun: options.dryRun,
		createBackup: !options.noBackup,
	};

	const result = options.dryRun
		? previewProvidersMigration(migrateOptions)
		: migrateProviders(migrateOptions);

	printMigrationResult("Provider", result);

	if (result.failed > 0) {
		console.error("[migrate] Some providers failed to migrate:");
		for (const error of result.errors) {
			console.error(`  - ${error.provider}: ${error.error}`);
		}
		process.exit(1);
	}

	if (result.backupPath) {
		console.log(`[migrate] Backup created at: ${result.backupPath}`);
	}
}

/**
 * Run both migrations.
 */
export async function runMigrateAll(captureOptions: CaptureMigrationOptions, providerOptions: ProviderMigrationOptions): Promise<void> {
	console.log("[migrate] Running all migrations...\n");

	await runMigrateCaptures(captureOptions);
	console.log("");
	await runMigrateProviders(providerOptions);
}

/**
 * Print migration result summary.
 */
function printMigrationResult(type: string, result: MigrateCapturesResult | MigrateProvidersResult): void {
	console.log(`\n[migrate] ${type} migration complete:`);
	console.log(`  ${type === "Capture" ? "Files" : "Providers"} scanned: ${result.totalFiles ?? result.totalProviders}`);
	console.log(`  ${type === "Capture" ? "Indexed" : "Imported"}: ${result.indexed ?? result.imported}`);
	if (result.updated !== undefined) console.log(`  Updated: ${result.updated}`);
	console.log(`  Skipped: ${result.skipped}`);
	console.log(`  Failed: ${result.failed}`);
}

/**
 * Initialize database and run auto-migration if needed.
 * This is called on startup by the proxy.
 */
export function runAutoMigration(): void {
	console.log("[migrate] Checking for auto-migration...");

	// Initialize database (runs migrations and imports)
	initDb();

	console.log("[migrate] Auto-migration check complete");
}