// Provider CRUD utilities backed by SQLite database.
// Replaces file-based providers.json with database operations.

import { z } from "zod";
import type { ProviderConfig as CoreProviderConfig, Provider, ApiFormat, AuthType } from "@contextio/core";
import { KNOWN_API_FORMATS, KNOWN_AUTH_TYPES, validateProviderConfig } from "@contextio/core";
import type { ProviderMetadata } from "../types/api.ts";
import {
	getAllMergedProviders,
	getAllProvidersFromDb,
	createProvider as dbCreateProvider,
	updateProvider as dbUpdateProvider,
	deleteProvider as dbDeleteProvider,
	initDb,
} from "@contextio/core/db";

// Initialize database on first import (for Next.js API routes)
try {
	initDb();
} catch (err) {
	console.error("[providers] Failed to initialize database:", err instanceof Error ? err.message : String(err));
}

// Web UI schema for provider creation/editing (subset of full ProviderConfig)
export const ProviderConfigSchema = z.object({
	id: z.string().min(1, "Provider id is required"),
	name: z.string().min(1, "Provider name is required"),
	baseUrl: z.string().min(1, "Base URL is required"),
	models: z.array(z.string()),
	allowBaseUrlOverride: z.boolean().default(true),
	baseUrlOverrideHeader: z.string().min(1, "Base URL override header is required").optional(),
	// Proxy-specific fields (optional in web UI, preserved from existing config)
	apiFormat: z.enum(KNOWN_API_FORMATS as unknown as [ApiFormat, ...ApiFormat[]]).optional(),
	authType: z.enum(KNOWN_AUTH_TYPES as unknown as [AuthType, ...AuthType[]]).optional(),
	enabled: z.boolean().optional(),
	rateLimit: z.object({
		maxRequests: z.number().int().min(1).max(10000),
		windowMs: z.number().int().min(100).max(24 * 60 * 60 * 1000),
		bufferCapacity: z.number().int().min(0).max(10000),
	}).optional(),
	retry: z.object({
		maxRetries: z.number().int().min(0),
		baseDelayMs: z.number().int().min(0),
		maxDelayMs: z.number().int().min(0),
		retryableStatuses: z.array(z.number().int().min(100).max(599)),
		jitterFactor: z.number().min(0).max(1),
	}).optional(),
	customHeaders: z.record(z.string()).optional(),
});

export type ProviderConfigInput = z.input<typeof ProviderConfigSchema>;
export type ProviderConfigOutput = z.output<typeof ProviderConfigSchema>;

// Map web UI field names to core field names
function toCoreProviderConfig(input: ProviderConfigOutput, existing?: CoreProviderConfig & { models?: string[] }): CoreProviderConfig & { models?: string[] } {
	const coreConfig: CoreProviderConfig & { models?: string[] } = {
		id: input.id as Provider,
		name: input.name,
		upstreamUrl: input.baseUrl,
		apiFormat: input.apiFormat ?? existing?.apiFormat ?? "unknown",
		authType: input.authType ?? existing?.authType ?? "none",
		enabled: input.enabled ?? existing?.enabled ?? true,
		rateLimit: input.rateLimit ?? existing?.rateLimit ?? { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
		retry: input.retry ?? existing?.retry ?? { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2 },
		customHeaders: input.customHeaders ?? existing?.customHeaders ?? {},
		allowBaseUrlOverride: input.allowBaseUrlOverride ?? existing?.allowBaseUrlOverride ?? true,
		baseUrlOverrideHeader: input.baseUrlOverrideHeader ?? existing?.baseUrlOverrideHeader ?? `x-${input.id}-baseurl`,
	};
	if (input.models !== undefined) {
		coreConfig.models = input.models;
	} else if (existing?.models !== undefined) {
		coreConfig.models = existing.models;
	}
	return coreConfig;
}

function fromCoreProviderConfig(core: CoreProviderConfig & { models?: string[] }): ProviderConfigOutput {
	return {
		id: core.id,
		name: core.name,
		baseUrl: core.upstreamUrl,
		models: core.models ?? [],
		allowBaseUrlOverride: core.allowBaseUrlOverride,
		baseUrlOverrideHeader: core.baseUrlOverrideHeader,
		apiFormat: core.apiFormat,
		authType: core.authType,
		enabled: core.enabled,
		rateLimit: core.rateLimit,
		retry: core.retry,
		customHeaders: core.customHeaders,
	};
}

/**
 * Convert merged provider from database to ProviderMetadata for web UI.
 */
function toProviderMetadata(provider: {
	id: string;
	name: string;
	upstreamUrl: string;
	apiFormat: ApiFormat;
	authType: AuthType;
	enabled: boolean;
	rateLimit: { maxRequests: number; windowMs: number; bufferCapacity: number };
	retry: { maxRetries: number; baseDelayMs: number; maxDelayMs: number; retryableStatuses: number[]; jitterFactor: number };
	customHeaders: Record<string, string>;
	allowBaseUrlOverride: boolean;
	baseUrlOverrideHeader: string;
	source: "default" | "env" | "file";
	dynamic: boolean;
	models?: string[];
}): ProviderMetadata {
	return {
		id: provider.id,
		name: provider.name,
		baseUrl: provider.upstreamUrl,
		models: provider.models ?? [],
		allowBaseUrlOverride: provider.allowBaseUrlOverride,
		baseUrlOverrideHeader: provider.baseUrlOverrideHeader,
		source: provider.source,
		dynamic: provider.dynamic,
	};
}

export async function getAllProviders(): Promise<ProviderMetadata[]> {
	const merged = getAllMergedProviders();
	return merged.map(toProviderMetadata);
}

export async function getProviderById(id: string): Promise<ProviderMetadata | null> {
	const merged = getAllMergedProviders();
	const provider = merged.find((p: typeof merged[0]) => p.id === id);
	return provider ? toProviderMetadata(provider) : null;
}

export async function createProvider(config: ProviderConfigInput): Promise<ProviderMetadata> {
	const validated = ProviderConfigSchema.parse(config);

	const coreConfig = toCoreProviderConfig(validated);
	validateProviderConfig(coreConfig);

	dbCreateProvider(coreConfig);

	return { ...fromCoreProviderConfig(coreConfig), source: "file", dynamic: true };
}

export async function updateProvider(id: string, config: ProviderConfigInput): Promise<ProviderMetadata> {
	const validated = ProviderConfigSchema.parse(config);

	if (validated.id !== id) {
		throw new Error(`Provider id in URL (${id}) does not match id in body (${validated.id})`);
	}

	// Get existing full config from database to preserve proxy-specific fields
	const dbProviders = getAllProvidersFromDb();
	const existingFullConfig = dbProviders.get(id);
	if (!existingFullConfig) {
		throw new Error(`Provider with id "${id}" not found`);
	}

	// Use the full existing config as base to preserve apiFormat, authType, enabled, rateLimit, retry, customHeaders
	const coreConfig = toCoreProviderConfig(validated, existingFullConfig);
	validateProviderConfig(coreConfig);

	dbUpdateProvider(id, coreConfig);

	return { ...fromCoreProviderConfig(coreConfig), source: "file", dynamic: true };
}

export async function deleteProvider(id: string): Promise<void> {
	// Check if provider exists
	const existing = await getProviderById(id);
	if (!existing) {
		throw new Error(`Provider with id "${id}" not found`);
	}

	// Only allow deletion of dynamic (file-based) providers
	if (existing.source !== "file" || !existing.dynamic) {
		throw new Error(`Cannot delete provider "${id}": only user-created providers can be deleted`);
	}

	dbDeleteProvider(id);
}

/**
 * Migrates legacy array-format providers to the object (map) format.
 * Kept for backwards compatibility with any existing code that might call it.
 *
 * @param arr - Parsed JSON array from providers.json
 * @returns Object keyed by provider id
 * @deprecated Use database-backed provider storage instead
 */
export function migrateProvidersArray(
	arr: unknown[],
): Record<string, CoreProviderConfig> {
	const migrated: Record<string, CoreProviderConfig> = {};
	for (const p of arr) {
		try {
			const validated = ProviderConfigSchema.parse(p);
			migrated[validated.id] = toCoreProviderConfig(validated);
		} catch {
			// skip invalid entries
		}
	}
	return migrated;
}
