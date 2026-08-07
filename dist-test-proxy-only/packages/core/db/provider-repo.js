/**
 * Provider repository for SQLite-backed provider storage.
 * Replaces file-based providers.json with database operations.
 */
import { getDb } from "./connection.js";
import { validateProviderConfig } from "../types.js";
import fs from "node:fs";
/**
 * Default provider configurations (matching DEFAULT_PROVIDERS in web/lib/providers.ts)
 */
const DEFAULT_PROVIDER_CONFIGS = [
    { id: "openai", name: "OpenAI", upstreamUrl: "https://api.openai.com", apiFormat: "chat-completions", authType: "bearer", allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-openai-baseurl" },
    { id: "anthropic", name: "Anthropic", upstreamUrl: "https://api.anthropic.com", apiFormat: "anthropic-messages", authType: "bearer", allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-anthropic-baseurl" },
    { id: "chatgpt", name: "ChatGPT", upstreamUrl: "https://chatgpt.com", apiFormat: "chatgpt-backend", authType: "bearer", allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-chatgpt-baseurl" },
    { id: "gemini", name: "Gemini", upstreamUrl: "https://generativelanguage.googleapis.com", apiFormat: "gemini", authType: "api-key", allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-gemini-baseurl" },
    { id: "vertex", name: "Vertex AI", upstreamUrl: "https://us-central1-aiplatform.googleapis.com", apiFormat: "gemini", authType: "api-key", allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-vertex-baseurl" },
    { id: "nvidia", name: "NVIDIA", upstreamUrl: "https://integrate.api.nvidia.com", apiFormat: "chat-completions", authType: "bearer", allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-nvidia-baseurl" },
    { id: "openrouter", name: "OpenRouter", upstreamUrl: "https://openrouter.ai/api", apiFormat: "chat-completions", authType: "bearer", allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-openrouter-baseurl" },
    { id: "kilo", name: "Kilo", upstreamUrl: "https://api.kilo.ai/api/gateway", apiFormat: "chat-completions", authType: "bearer", allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-kilo-baseurl" },
    { id: "geminiCodeAssist", name: "Gemini Code Assist", upstreamUrl: "https://generativelanguage.googleapis.com", apiFormat: "gemini", authType: "api-key", allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-gemini-code-assist-baseurl" },
    { id: "unknown", name: "Unknown", upstreamUrl: "https://unknown.provider", apiFormat: "unknown", authType: "none", allowBaseUrlOverride: false, baseUrlOverrideHeader: "x-unknown-baseurl" },
];
/**
 * Default rate limit and retry configs
 */
const DEFAULT_RATE_LIMIT = { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 };
const DEFAULT_RETRY = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2, maxStreamRetries: 3, maxResponseBufferSize: 10 * 1024 * 1024, enabled: true };
const DEFAULT_AUTH_TYPE = "none";
const DEFAULT_API_FORMAT = "unknown";
/**
 * Convert a database row to a ProviderConfig object.
 */
function rowToProviderConfig(row) {
    // Helper to safely parse JSON columns
    function safeJsonParse(value, fallback) {
        if (!value)
            return fallback;
        try {
            return JSON.parse(value);
        }
        catch {
            return fallback;
        }
    }
    return {
        id: row.id,
        name: row.name,
        upstreamUrl: row.upstream_url,
        apiFormat: row.api_format,
        authType: row.auth_type,
        enabled: row.enabled === 1,
        rateLimit: {
            maxRequests: row.rate_limit_max_requests ?? DEFAULT_RATE_LIMIT.maxRequests,
            windowMs: row.rate_limit_window_ms ?? DEFAULT_RATE_LIMIT.windowMs,
            bufferCapacity: row.rate_limit_buffer_capacity ?? DEFAULT_RATE_LIMIT.bufferCapacity,
        },
        retry: {
            maxRetries: row.retry_max_retries ?? DEFAULT_RETRY.maxRetries,
            baseDelayMs: row.retry_base_delay_ms ?? DEFAULT_RETRY.baseDelayMs,
            maxDelayMs: row.retry_max_delay_ms ?? DEFAULT_RETRY.maxDelayMs,
            retryableStatuses: safeJsonParse(row.retry_retryable_statuses, DEFAULT_RETRY.retryableStatuses),
            jitterFactor: row.retry_jitter_factor ?? DEFAULT_RETRY.jitterFactor,
            maxStreamRetries: row.retry_max_stream_retries ?? DEFAULT_RETRY.maxStreamRetries,
            maxResponseBufferSize: row.retry_max_response_buffer_size ?? DEFAULT_RETRY.maxResponseBufferSize,
            enabled: row.retry_enabled !== null ? row.retry_enabled === 1 : DEFAULT_RETRY.enabled,
        },
        customHeaders: safeJsonParse(row.custom_headers, {}),
        allowBaseUrlOverride: row.allow_base_url_override === 1,
        baseUrlOverrideHeader: row.base_url_override_header ?? `x-${row.id}-baseurl`,
        source: row.source,
        dynamic: row.dynamic === 1,
    };
}
/**
 * Convert a ProviderConfig to database column values for insert/update.
 */
function providerConfigToRow(config) {
    return {
        name: config.name,
        upstream_url: config.upstreamUrl,
        api_format: config.apiFormat,
        auth_type: config.authType,
        enabled: config.enabled ? 1 : 0,
        rate_limit_max_requests: config.rateLimit.maxRequests,
        rate_limit_window_ms: config.rateLimit.windowMs,
        rate_limit_buffer_capacity: config.rateLimit.bufferCapacity,
        retry_max_retries: config.retry.maxRetries,
        retry_base_delay_ms: config.retry.baseDelayMs,
        retry_max_delay_ms: config.retry.maxDelayMs,
        retry_retryable_statuses: JSON.stringify(config.retry.retryableStatuses),
        retry_jitter_factor: config.retry.jitterFactor,
        retry_max_stream_retries: config.retry.maxStreamRetries,
        retry_max_response_buffer_size: config.retry.maxResponseBufferSize,
        retry_enabled: config.retry.enabled ? 1 : 0,
        custom_headers: JSON.stringify(config.customHeaders),
        allow_base_url_override: config.allowBaseUrlOverride ? 1 : 0,
        base_url_override_header: config.baseUrlOverrideHeader,
        source: "file",
        dynamic: 1,
    };
}
/**
 * Create a new provider in the database.
 * @throws {Error} If provider with the same ID already exists.
 */
export function createProvider(config) {
    const db = getDb();
    const row = providerConfigToRow(config);
    const stmt = db.prepare(`
		INSERT INTO providers (
			id, name, upstream_url, api_format, auth_type, enabled,
			rate_limit_max_requests, rate_limit_window_ms, rate_limit_buffer_capacity,
			retry_max_retries, retry_base_delay_ms, retry_max_delay_ms,
			retry_retryable_statuses, retry_jitter_factor, retry_max_stream_retries, retry_max_response_buffer_size, retry_enabled, custom_headers,
			allow_base_url_override, base_url_override_header, source, dynamic
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
    try {
        stmt.run(config.id, row.name, row.upstream_url, row.api_format, row.auth_type, row.enabled, row.rate_limit_max_requests, row.rate_limit_window_ms, row.rate_limit_buffer_capacity, row.retry_max_retries, row.retry_base_delay_ms, row.retry_max_delay_ms, row.retry_retryable_statuses, row.retry_jitter_factor, row.retry_max_stream_retries, row.retry_max_response_buffer_size, row.retry_enabled, row.custom_headers, row.allow_base_url_override, row.base_url_override_header, row.source, row.dynamic);
    }
    catch (err) {
        if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
            throw new Error(`Provider with id "${config.id}" already exists`);
        }
        throw err;
    }
    return config;
}
/**
 * Get a provider by ID from the database.
 * Returns null if not found.
 */
export function getProviderById(id) {
    const db = getDb();
    const row = db.prepare("SELECT * FROM providers WHERE id = ?").get(id);
    return row ? rowToProviderConfig(row) : null;
}
/**
 * Get all providers from the database.
 * Returns a map keyed by provider ID.
 */
export function getAllProvidersFromDb() {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM providers").all();
    const map = new Map();
    for (const row of rows) {
        map.set(row.id, rowToProviderConfig(row));
    }
    return map;
}
/**
 * Update an existing provider in the database.
 * @throws {Error} If provider with the given ID does not exist.
 */
export function updateProvider(id, config) {
    if (config.id !== id) {
        throw new Error(`Provider id mismatch: URL has "${id}", body has "${config.id}"`);
    }
    const db = getDb();
    // Fetch existing provider to preserve source and dynamic fields
    const existingRow = db.prepare("SELECT source, dynamic FROM providers WHERE id = ?").get(id);
    if (!existingRow) {
        throw new Error(`Provider with id "${id}" not found`);
    }
    const row = providerConfigToRow(config);
    const stmt = db.prepare(`
		UPDATE providers SET
			name = ?,
			upstream_url = ?,
			api_format = ?,
			auth_type = ?,
			enabled = ?,
			rate_limit_max_requests = ?,
			rate_limit_window_ms = ?,
			rate_limit_buffer_capacity = ?,
			retry_max_retries = ?,
			retry_base_delay_ms = ?,
			retry_max_delay_ms = ?,
			retry_retryable_statuses = ?,
			retry_jitter_factor = ?,
			retry_max_stream_retries = ?,
			retry_max_response_buffer_size = ?,
			retry_enabled = ?,
			custom_headers = ?,
			allow_base_url_override = ?,
			base_url_override_header = ?,
			source = ?,
			dynamic = ?
		WHERE id = ?
	`);
    const result = stmt.run(row.name, row.upstream_url, row.api_format, row.auth_type, row.enabled, row.rate_limit_max_requests, row.rate_limit_window_ms, row.rate_limit_buffer_capacity, row.retry_max_retries, row.retry_base_delay_ms, row.retry_max_delay_ms, row.retry_retryable_statuses, row.retry_jitter_factor, row.retry_max_stream_retries, row.retry_max_response_buffer_size, row.retry_enabled, row.custom_headers, row.allow_base_url_override, row.base_url_override_header, existingRow.source, // Preserve original source
    existingRow.dynamic, // Preserve original dynamic
    id);
    if (result.changes === 0) {
        throw new Error(`Provider with id "${id}" not found`);
    }
    return config;
}
/**
 * Delete a provider from the database.
 * @throws {Error} If provider with the given ID does not exist.
 */
export function deleteProvider(id) {
    const db = getDb();
    const result = db.prepare("DELETE FROM providers WHERE id = ?").run(id);
    if (result.changes === 0) {
        throw new Error(`Provider with id "${id}" not found`);
    }
}
/**
 * Check if a provider exists in the database.
 */
export function providerExists(id) {
    const db = getDb();
    const row = db.prepare("SELECT 1 FROM providers WHERE id = ?").get(id);
    return row !== undefined;
}
const ENV_PROVIDER_MAP = {
    openai: "UPSTREAM_OPENAI_URL",
    anthropic: "UPSTREAM_ANTHROPIC_URL",
    chatgpt: "UPSTREAM_CHATGPT_URL",
    gemini: "UPSTREAM_GEMINI_URL",
    geminiCodeAssist: "UPSTREAM_GEMINI_CODE_ASSIST_URL",
    vertex: "UPSTREAM_VERTEX_URL",
    nvidia: "UPSTREAM_NVIDIA_URL",
    openrouter: "UPSTREAM_OPENROUTER_URL",
    kilo: "UPSTREAM_KILO_URL",
};
function getEnvProviders() {
    const providers = [];
    for (const [id, envVar] of Object.entries(ENV_PROVIDER_MAP)) {
        const url = process.env[envVar];
        if (url) {
            providers.push({
                id,
                name: id.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase()).trim(),
                upstreamUrl: url.replace(/\/v1$/, ""),
                apiFormat: DEFAULT_API_FORMAT,
                authType: DEFAULT_AUTH_TYPE,
                enabled: true,
                rateLimit: DEFAULT_RATE_LIMIT,
                retry: DEFAULT_RETRY,
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: `x-${id}-baseurl`,
                source: "env",
                dynamic: false,
            });
        }
    }
    return providers;
}
export function getAllMergedProviders() {
    const dbProviders = getAllProvidersFromDb();
    const merged = new Map();
    // 1. Default providers (lowest priority) - hardcoded defaults with provider-specific apiFormat/authType
    for (const def of DEFAULT_PROVIDER_CONFIGS) {
        merged.set(def.id, {
            ...def,
            enabled: true,
            rateLimit: DEFAULT_RATE_LIMIT,
            retry: DEFAULT_RETRY,
            customHeaders: {},
            source: "default",
            dynamic: false,
        });
    }
    // 2. Environment variable providers (medium priority) - override defaults
    for (const env of getEnvProviders()) {
        merged.set(env.id, env);
    }
    // 3. Database/file providers (highest priority) - only user-created providers override env
    // Default providers from DB (source="default") should NOT override env vars
    for (const [id, config] of dbProviders) {
        // Only user-created (file) providers override env/default
        if (config.source === "file" && config.dynamic) {
            merged.set(id, {
                ...config,
                source: config.source,
                dynamic: config.dynamic,
            });
        }
        // For default providers from DB, they're already covered by hardcoded defaults
        // Env providers already override them in step 2
    }
    return Array.from(merged.values());
}
/**
 * Import providers from a providers.json file into the database.
 * This is used for one-time migration from file-based to SQLite storage.
 *
 * @param filePath - Path to the providers.json file (defaults to PROVIDERS_FILE env var or /app/custom-policy/providers.json)
 * @returns Number of providers imported
 */
export function importProvidersFromJson(filePath) {
    const providersFile = filePath || process.env.PROVIDERS_FILE || "/app/custom-policy/providers.json";
    if (!fs.existsSync(providersFile)) {
        console.log(`[provider-repo] No providers.json found at ${providersFile}, skipping import`);
        return 0;
    }
    try {
        const raw = fs.readFileSync(providersFile, "utf8");
        const parsed = JSON.parse(raw);
        let imported = 0;
        // Handle both array and object formats
        const entries = Array.isArray(parsed)
            ? parsed.map((item, index) => [String(index), item])
            : Object.entries(parsed);
        for (const [key, value] of entries) {
            if (typeof value !== "object" || value === null)
                continue;
            const config = value;
            const providerId = config.id;
            const finalKey = Array.isArray(parsed) ? providerId : key;
            if (!providerId)
                continue;
            // Build ProviderConfig from JSON
            const providerConfig = {
                id: finalKey,
                name: config.name || finalKey,
                upstreamUrl: config.upstreamUrl || "",
                apiFormat: config.apiFormat || DEFAULT_API_FORMAT,
                authType: config.authType || DEFAULT_AUTH_TYPE,
                enabled: config.enabled !== false,
                rateLimit: config.rateLimit || DEFAULT_RATE_LIMIT,
                retry: config.retry || DEFAULT_RETRY,
                customHeaders: config.customHeaders || {},
                allowBaseUrlOverride: config.allowBaseUrlOverride ?? true,
                baseUrlOverrideHeader: config.baseUrlOverrideHeader || `x-${finalKey}-baseurl`,
            };
            // Validate the provider config
            try {
                validateProviderConfig(providerConfig);
            }
            catch (validationError) {
                console.warn(`[provider-repo] Skipping provider "${finalKey}": validation failed - ${validationError instanceof Error ? validationError.message : String(validationError)}`);
                continue;
            }
            // Validate required fields
            if (!providerConfig.upstreamUrl) {
                console.warn(`[provider-repo] Skipping provider "${finalKey}": missing upstreamUrl`);
                continue;
            }
            // Check if already exists
            const existingProvider = getProviderById(finalKey);
            if (existingProvider) {
                // If provider exists with source='default', update it with providers.json values
                // (changing source to 'file' and dynamic to 1)
                // If source is 'file', it's already user-configured, so skip
                // (env providers are never persisted to the database; they're generated in-memory)
                if (existingProvider.source === "default") {
                    console.log(`[provider-repo] Provider "${finalKey}" exists as default, updating with providers.json values`);
                    try {
                        const db = getDb();
                        // Wrap both updateProvider and reclassify UPDATE in a transaction for atomicity
                        db.transaction(() => {
                            updateProvider(finalKey, providerConfig);
                            // updateProvider preserves source/dynamic, so we need a direct UPDATE to reclassify
                            db.prepare("UPDATE providers SET source = 'file', dynamic = 1 WHERE id = ?").run(finalKey);
                        })();
                        imported++;
                        console.log(`[provider-repo] Updated provider "${finalKey}" from providers.json`);
                    }
                    catch (err) {
                        console.warn(`[provider-repo] Failed to update provider "${finalKey}": ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
                else {
                    console.log(`[provider-repo] Provider "${finalKey}" already exists with source="${existingProvider.source}", skipping`);
                }
                continue;
            }
            try {
                createProvider(providerConfig);
                imported++;
                console.log(`[provider-repo] Imported provider "${finalKey}" from providers.json`);
            }
            catch (err) {
                console.warn(`[provider-repo] Failed to import provider "${finalKey}": ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return imported;
    }
    catch (err) {
        console.error(`[provider-repo] Failed to read/parse providers.json at ${providersFile}: ${err instanceof Error ? err.message : String(err)}`);
        return 0;
    }
}
//# sourceMappingURL=provider-repo.js.map