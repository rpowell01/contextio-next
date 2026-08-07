/**
 * Provider repository for SQLite-backed provider storage.
 * Replaces file-based providers.json with database operations.
 */
import type { ProviderConfig, AuthType, ApiFormat, RateLimitConfig, RetryConfig } from "../types.js";
/**
 * Database row type for providers table.
 * Matches the schema in 001_initial_schema.sql
 */
export interface ProviderRow {
    id: string;
    name: string;
    upstream_url: string;
    api_format: string;
    auth_type: string;
    enabled: number;
    rate_limit_max_requests: number | null;
    rate_limit_window_ms: number | null;
    rate_limit_buffer_capacity: number | null;
    retry_max_retries: number | null;
    retry_base_delay_ms: number | null;
    retry_max_delay_ms: number | null;
    retry_retryable_statuses: string | null;
    retry_jitter_factor: number | null;
    retry_max_stream_retries: number | null;
    retry_max_response_buffer_size: number | null;
    retry_enabled: number | null;
    custom_headers: string | null;
    allow_base_url_override: number;
    base_url_override_header: string | null;
    source: string;
    dynamic: number;
    created_at: number;
    updated_at: number;
}
/**
 * Create a new provider in the database.
 * @throws {Error} If provider with the same ID already exists.
 */
export declare function createProvider(config: ProviderConfig): ProviderConfig;
/**
 * Get a provider by ID from the database.
 * Returns null if not found.
 */
export declare function getProviderById(id: string): ProviderConfigWithMeta | null;
/**
 * ProviderConfig with source and dynamic fields from database.
 */
export interface ProviderConfigWithMeta extends ProviderConfig {
    source: string;
    dynamic: boolean;
}
/**
 * Get all providers from the database.
 * Returns a map keyed by provider ID.
 */
export declare function getAllProvidersFromDb(): Map<string, ProviderConfigWithMeta>;
/**
 * Update an existing provider in the database.
 * @throws {Error} If provider with the given ID does not exist.
 */
export declare function updateProvider(id: string, config: ProviderConfig): ProviderConfig;
/**
 * Delete a provider from the database.
 * @throws {Error} If provider with the given ID does not exist.
 */
export declare function deleteProvider(id: string): void;
/**
 * Check if a provider exists in the database.
 */
export declare function providerExists(id: string): boolean;
/**
 * Get all providers merged with defaults and environment variables.
 * This mirrors the logic in packages/web/lib/providers.ts getAllProviders().
 */
export interface MergedProvider {
    id: string;
    name: string;
    upstreamUrl: string;
    apiFormat: ApiFormat;
    authType: AuthType;
    enabled: boolean;
    rateLimit: RateLimitConfig;
    retry: RetryConfig;
    customHeaders: Record<string, string>;
    allowBaseUrlOverride: boolean;
    baseUrlOverrideHeader: string;
    source: "default" | "env" | "file";
    dynamic: boolean;
    models?: string[];
}
export declare function getAllMergedProviders(): MergedProvider[];
/**
 * Import providers from a providers.json file into the database.
 * This is used for one-time migration from file-based to SQLite storage.
 *
 * @param filePath - Path to the providers.json file (defaults to PROVIDERS_FILE env var or /app/custom-policy/providers.json)
 * @returns Number of providers imported
 */
export declare function importProvidersFromJson(filePath?: string): number;
//# sourceMappingURL=provider-repo.d.ts.map