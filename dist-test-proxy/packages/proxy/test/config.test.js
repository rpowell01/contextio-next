import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readProvidersConfig, resolveConfig } from "../dist/config.js";
import { closeDb, initDb, Database } from "@contextio/core/db";
function makeTempHome() {
    return path.join(tmpdir(), `contextio-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}
// Test database setup for DB isolation
let testDbDir;
let testDbPath;
function setupTestDb() {
    testDbDir = mkdtempSync(join(tmpdir(), "contextio-proxy-test-"));
    testDbPath = join(testDbDir, "test.db");
    process.env.CONTEXTIO_DB_PATH = testDbPath;
    closeDb();
    initDb();
    // Verify providers table exists
    const db = new Database(testDbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providers'").get();
    if (!tables) {
        db.close();
        throw new Error("providers table not created - migrations not applied correctly!");
    }
    db.close();
}
function clearProvidersTable() {
    const db = new Database(testDbPath);
    db.prepare("DELETE FROM providers").run();
    db.close();
}
function teardownTestDb() {
    closeDb();
    if (testDbDir) {
        rmSync(testDbDir, { recursive: true, force: true });
    }
    delete process.env.CONTEXTIO_DB_PATH;
}
function settingsPathFromHome(home) {
    return path.join(home, ".contextio-next", "settings.json");
}
function writeSettings(home, settings) {
    const dir = path.join(home, ".contextio-next");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsPathFromHome(home), JSON.stringify(settings, null, 2));
}
function removeSettings(home) {
    try {
        fs.unlinkSync(settingsPathFromHome(home));
    }
    catch {
        // ignore
    }
}
// Set up required env vars for resolveConfig tests
before(() => {
    process.env.UPSTREAM_OPENAI_URL = "https://api.openai.com";
    process.env.UPSTREAM_ANTHROPIC_URL = "https://api.anthropic.com";
    process.env.UPSTREAM_CHATGPT_URL = "https://chatgpt.com";
    process.env.UPSTREAM_GEMINI_URL = "https://generativelanguage.googleapis.com";
    process.env.UPSTREAM_GEMINI_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com";
    process.env.UPSTREAM_VERTEX_URL = "https://us-central1-aiplatform.googleapis.com";
    process.env.UPSTREAM_NVIDIA_URL = "https://integrate.api.nvidia.com";
    process.env.UPSTREAM_KILO_URL = "https://api.kilo.ai/api/gateway";
    process.env.UPSTREAM_OPENROUTER_URL = "https://openrouter.ai/api";
});
after(() => {
    delete process.env.UPSTREAM_OPENAI_URL;
    delete process.env.UPSTREAM_ANTHROPIC_URL;
    delete process.env.UPSTREAM_CHATGPT_URL;
    delete process.env.UPSTREAM_GEMINI_URL;
    delete process.env.UPSTREAM_GEMINI_CODE_ASSIST_URL;
    delete process.env.UPSTREAM_VERTEX_URL;
    delete process.env.UPSTREAM_NVIDIA_URL;
    delete process.env.UPSTREAM_KILO_URL;
    delete process.env.UPSTREAM_OPENROUTER_URL;
});
describe("resolveConfig", () => {
    let tempHome;
    let providersPath;
    before(() => {
        setupTestDb();
        tempHome = makeTempHome();
        fs.mkdirSync(tempHome, { recursive: true });
        process.env.HOME = tempHome;
        process.env.USERPROFILE = tempHome;
        // Create a providers.json in the temp directory
        providersPath = path.join(tempHome, "providers.json");
        process.env.PROVIDERS_FILE = providersPath;
        const defaultProviders = {
            openai: { id: "openai", name: "OpenAI", upstreamUrl: "https://api.openai.com", apiFormat: "chat-completions", authType: "bearer", enabled: true, rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2 }, customHeaders: {}, allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-openai-baseurl" },
            anthropic: { id: "anthropic", name: "Anthropic", upstreamUrl: "https://api.anthropic.com", apiFormat: "anthropic-messages", authType: "bearer", enabled: true, rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2 }, customHeaders: {}, allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-anthropic-baseurl" },
            chatgpt: { id: "chatgpt", name: "ChatGPT", upstreamUrl: "https://chatgpt.com", apiFormat: "chatgpt-backend", authType: "bearer", enabled: true, rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2 }, customHeaders: {}, allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-chatgpt-baseurl" },
            gemini: { id: "gemini", name: "Gemini", upstreamUrl: "https://generativelanguage.googleapis.com", apiFormat: "gemini", authType: "api-key", enabled: true, rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2 }, customHeaders: {}, allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-gemini-baseurl" },
            vertex: { id: "vertex", name: "Vertex AI", upstreamUrl: "https://us-central1-aiplatform.googleapis.com", apiFormat: "gemini", authType: "api-key", enabled: true, rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2 }, customHeaders: {}, allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-vertex-baseurl" },
            nvidia: { id: "nvidia", name: "NVIDIA", upstreamUrl: "https://integrate.api.nvidia.com", apiFormat: "chat-completions", authType: "bearer", enabled: true, rateLimit: { maxRequests: 20, windowMs: 60000, bufferCapacity: 5 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2 }, customHeaders: {}, allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-nvidia-baseurl" },
            kilo: { id: "kilo", name: "Kilo", upstreamUrl: "https://api.kilo.ai/api/gateway", apiFormat: "chat-completions", authType: "bearer", enabled: true, rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2 }, customHeaders: {}, allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-kilo-baseurl" },
            openrouter: { id: "openrouter", name: "OpenRouter", upstreamUrl: "https://openrouter.ai/api", apiFormat: "chat-completions", authType: "bearer", enabled: true, rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2 }, customHeaders: {}, allowBaseUrlOverride: true, baseUrlOverrideHeader: "x-openrouter-baseurl" },
            unknown: { id: "unknown", name: "Unknown", upstreamUrl: "https://unknown.provider", apiFormat: "unknown", authType: "none", enabled: true, rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 }, retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500, 502, 503, 504], jitterFactor: 0.2 }, customHeaders: {}, allowBaseUrlOverride: false, baseUrlOverrideHeader: "x-unknown-baseurl" },
        };
        fs.writeFileSync(providersPath, JSON.stringify(defaultProviders, null, 2));
    });
    after(() => {
        if (tempHome) {
            try {
                fs.rmSync(tempHome, { recursive: true, force: true });
            }
            catch {
                // best-effort cleanup
            }
        }
        delete process.env.PROVIDERS_FILE;
        teardownTestDb();
    });
    beforeEach(() => {
        // Per-test env isolation
        delete process.env.LOGGER_CAPTURE_MAX_AGE;
        delete process.env.LOGGER_CAPTURE_CLEANUP_INTERVAL;
        delete process.env.LOGGER_CAPTURE_CLEANUP_ENABLED;
        removeSettings(tempHome);
        clearProvidersTable();
    });
    after(() => {
        // cleanup settings that tests may have written
        removeSettings(tempHome);
    });
    it("returns default config with all required fields", () => {
        const config = resolveConfig();
        assert.equal(config.bindHost, "127.0.0.1");
        assert.equal(config.port, 4040);
        assert.equal(config.allowTargetOverride, false);
        assert.equal(config.strictUrlForwarding, false);
        assert.ok(config.upstreams);
    });
    it("applies programmatic overrides", () => {
        const config = resolveConfig({
            port: 9999,
            bindHost: "0.0.0.0",
            allowTargetOverride: true,
            strictUrlForwarding: true,
        });
        assert.equal(config.port, 9999);
        assert.equal(config.bindHost, "0.0.0.0");
        assert.equal(config.allowTargetOverride, true);
        assert.equal(config.strictUrlForwarding, true);
    });
    it("applies upstream overrides", () => {
        const config = resolveConfig({
            upstreams: {
                openai: "https://custom.openai.com",
                nvidia: "https://custom.nvidia.com",
            },
        });
        assert.equal(config.upstreams.openai, "https://custom.openai.com");
        assert.equal(config.upstreams.nvidia, "https://custom.nvidia.com");
    });
    it("normalizes trailing /v1 from NVIDIA URL", () => {
        const config = resolveConfig({
            upstreams: { nvidia: "https://integrate.api.nvidia.com/v1" },
        });
        assert.equal(config.upstreams.nvidia, "https://integrate.api.nvidia.com");
    });
    it("normalizes trailing /v1 from OpenRouter URL", () => {
        const config = resolveConfig({
            upstreams: { openrouter: "https://openrouter.ai/api/v1" },
        });
        assert.equal(config.upstreams.openrouter, "https://openrouter.ai/api");
    });
    it("normalizes trailing /v1 from Kilo URL", () => {
        const config = resolveConfig({
            upstreams: { kilo: "https://api.kilo.ai/api/gateway/v1" },
        });
        assert.equal(config.upstreams.kilo, "https://api.kilo.ai/api/gateway");
    });
    it("normalizes trailing /v1 from OpenAI URL", () => {
        const config = resolveConfig({
            upstreams: { openai: "https://api.openai.com/v1" },
        });
        assert.equal(config.upstreams.openai, "https://api.openai.com");
    });
    it("preserves URLs without trailing /v1", () => {
        const config = resolveConfig({
            upstreams: {
                openai: "https://api.openai.com",
                nvidia: "https://integrate.api.nvidia.com",
                openrouter: "https://openrouter.ai/api",
                kilo: "https://api.kilo.ai/api/gateway",
            },
        });
        assert.equal(config.upstreams.openai, "https://api.openai.com");
        assert.equal(config.upstreams.nvidia, "https://integrate.api.nvidia.com");
        assert.equal(config.upstreams.openrouter, "https://openrouter.ai/api");
        assert.equal(config.upstreams.kilo, "https://api.kilo.ai/api/gateway");
    });
    it("does not modify URLs with /v1 in the middle", () => {
        const config = resolveConfig({
            upstreams: { openai: "https://api.openai.com/v1/chat/completions" },
        });
        assert.equal(config.upstreams.openai, "https://api.openai.com/v1/chat/completions");
    });
    it("reads STRICT_URL_FORWARDING from environment", () => {
        process.env.STRICT_URL_FORWARDING = "true";
        const config = resolveConfig();
        assert.equal(config.strictUrlForwarding, true);
    });
    it("ignores invalid STRICT_URL_FORWARDING values", () => {
        process.env.STRICT_URL_FORWARDING = "1";
        const config = resolveConfig();
        assert.equal(config.strictUrlForwarding, false);
    });
    it("reads capture cleanup settings from persisted settings.json", () => {
        writeSettings(tempHome, {
            captureCleanupEnabled: true,
            captureCleanupMaxAgeDays: 3,
            captureCleanupIntervalHours: 8,
        });
        const config = resolveConfig();
        assert.equal(config.loggerCaptureCleanupEnabled, true);
        assert.equal(config.loggerCaptureMaxAgeMs, 3 * 24 * 60 * 60 * 1000);
        assert.equal(config.loggerCaptureCleanupIntervalMs, 8 * 60 * 60 * 1000);
    });
    it("disables cleanup when persisted captureCleanupEnabled is false even with maxAgeDays set", () => {
        writeSettings(tempHome, {
            captureCleanupEnabled: false,
            captureCleanupMaxAgeDays: 30,
        });
        try {
            const config = resolveConfig();
            assert.equal(config.loggerCaptureCleanupEnabled, false);
            // maxAgeMs is still computed from settings.json even when disabled
            assert.equal(config.loggerCaptureMaxAgeMs, 30 * 24 * 60 * 60 * 1000);
        }
        finally {
            removeSettings(tempHome);
        }
    });
    it("environment variables override persisted settings.json", () => {
        writeSettings(tempHome, {
            captureCleanupEnabled: false,
            captureCleanupMaxAgeDays: 3,
            captureCleanupIntervalHours: 8,
        });
        try {
            process.env.LOGGER_CAPTURE_MAX_AGE = "7";
            process.env.LOGGER_CAPTURE_CLEANUP_INTERVAL = "12";
            process.env.LOGGER_CAPTURE_CLEANUP_ENABLED = "true";
            const config = resolveConfig();
            assert.equal(config.loggerCaptureCleanupEnabled, true);
            assert.equal(config.loggerCaptureMaxAgeMs, 7 * 24 * 60 * 60 * 1000);
            assert.equal(config.loggerCaptureCleanupIntervalMs, 12 * 60 * 60 * 1000);
        }
        finally {
            removeSettings(tempHome);
            delete process.env.LOGGER_CAPTURE_MAX_AGE;
            delete process.env.LOGGER_CAPTURE_CLEANUP_INTERVAL;
            delete process.env.LOGGER_CAPTURE_CLEANUP_ENABLED;
        }
    });
    it("programmatic overrides override persisted settings.json", () => {
        writeSettings(tempHome, {
            captureCleanupEnabled: false,
            captureCleanupMaxAgeDays: 999,
            captureCleanupIntervalHours: 99,
        });
        try {
            const config = resolveConfig({
                loggerCaptureCleanupEnabled: true,
                loggerCaptureMaxAgeMs: 5 * 24 * 60 * 60 * 1000,
                loggerCaptureCleanupIntervalMs: 6 * 60 * 60 * 1000,
            });
            assert.equal(config.loggerCaptureCleanupEnabled, true);
            assert.equal(config.loggerCaptureMaxAgeMs, 5 * 24 * 60 * 60 * 1000);
            assert.equal(config.loggerCaptureCleanupIntervalMs, 6 * 60 * 60 * 1000);
        }
        finally {
            removeSettings(tempHome);
        }
    });
    it("falls back to defaults when settings.json is missing", () => {
        const config = resolveConfig();
        assert.equal(config.loggerCaptureCleanupEnabled, false);
        assert.equal(config.loggerCaptureMaxAgeMs, 0);
        assert.equal(config.loggerCaptureCleanupIntervalMs, 24 * 60 * 60 * 1000);
    });
});
describe("readProvidersConfig", () => {
    let tempDir;
    before(() => {
        setupTestDb();
        tempDir = makeTempHome();
        fs.mkdirSync(tempDir, { recursive: true });
    });
    after(() => {
        if (tempDir) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
            catch {
                // best-effort cleanup
            }
        }
        teardownTestDb();
    });
    beforeEach(() => {
        // Clean env vars that might affect tests
        delete process.env.UPSTREAM_OPENAI_URL;
        delete process.env.CONTEXTIO_RATE_LIMIT_OPENAI_MAX_REQUESTS;
        delete process.env.CONTEXTIO_RETRY_OPENAI_MAX_RETRIES;
        clearProvidersTable();
    });
    it("throws when file is missing", () => {
        // Use a non-existent path in the temp directory to ensure the file is truly absent
        const nonExistentPath = path.join(tempDir, "non-existent-providers.json");
        assert.throws(() => {
            readProvidersConfig(nonExistentPath);
        }, /No valid providers found/);
    });
    it("throws when file is empty", () => {
        const emptyPath = path.join(tempDir, "empty-providers.json");
        fs.writeFileSync(emptyPath, "{}");
        assert.throws(() => {
            readProvidersConfig(emptyPath);
        }, /No valid providers found/);
    });
    it("reads and parses a valid providers.json file with all providers", () => {
        const providersPath = path.join(tempDir, "providers.json");
        const fullConfig = {
            openai: {
                id: "openai",
                name: "OpenAI Custom",
                upstreamUrl: "https://custom.openai.com",
                apiFormat: "chat-completions",
                authType: "bearer",
                enabled: true,
                rateLimit: { maxRequests: 100, windowMs: 120000, bufferCapacity: 20 },
                retry: {
                    maxRetries: 5,
                    baseDelayMs: 500,
                    maxDelayMs: 60000,
                    retryableStatuses: [429, 500],
                    jitterFactor: 0.1,
                },
                customHeaders: { "X-Custom": "value" },
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-openai-baseurl",
            },
            anthropic: {
                id: "anthropic",
                name: "Anthropic Custom",
                upstreamUrl: "https://custom.anthropic.com",
                apiFormat: "anthropic-messages",
                authType: "bearer",
                enabled: true,
                rateLimit: { maxRequests: 100, windowMs: 120000, bufferCapacity: 20 },
                retry: {
                    maxRetries: 5,
                    baseDelayMs: 500,
                    maxDelayMs: 60000,
                    retryableStatuses: [429, 500],
                    jitterFactor: 0.1,
                },
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-anthropic-baseurl",
            },
        };
        fs.writeFileSync(providersPath, JSON.stringify(fullConfig, null, 2));
        const config = readProvidersConfig(providersPath);
        assert.equal(config.openai.upstreamUrl, "https://custom.openai.com");
        assert.equal(config.openai.rateLimit.maxRequests, 100);
        assert.equal(config.openai.retry.maxRetries, 5);
        assert.equal(config.openai.customHeaders["X-Custom"], "value");
        assert.equal(config.anthropic.upstreamUrl, "https://custom.anthropic.com");
        // Only the two providers in the file should be present
        assert.equal(Object.keys(config).length, 2);
    });
    it("throws for invalid entries instead of falling back to defaults", () => {
        const providersPath = path.join(tempDir, "providers.json");
        const mixedConfig = {
            openai: {
                id: "openai",
                name: "OpenAI",
                upstreamUrl: "not-a-url",
                apiFormat: "chat-completions",
                authType: "bearer",
                enabled: true,
                rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-openai-baseurl",
            },
        };
        fs.writeFileSync(providersPath, JSON.stringify(mixedConfig, null, 2));
        assert.throws(() => {
            readProvidersConfig(providersPath);
        }, /No valid providers found/);
    });
    it("throws for invalid nested fields instead of merging with defaults", () => {
        const providersPath = path.join(tempDir, "providers.json");
        const partialConfig = {
            openai: {
                id: "openai",
                name: "OpenAI Custom",
                upstreamUrl: "https://custom.openai.com",
                apiFormat: "chat-completions",
                authType: "bearer",
                enabled: true,
                // Invalid rateLimit.maxRequests (string instead of number)
                rateLimit: { maxRequests: "oops", windowMs: 120000, bufferCapacity: 20 },
                retry: {
                    maxRetries: 5,
                    baseDelayMs: 500,
                    maxDelayMs: 60000,
                    retryableStatuses: [429, 500],
                    jitterFactor: 0.1,
                },
                customHeaders: { "X-Custom": "value" },
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-openai-baseurl",
            },
        };
        fs.writeFileSync(providersPath, JSON.stringify(partialConfig, null, 2));
        assert.throws(() => {
            readProvidersConfig(providersPath);
        }, /No valid providers found/);
    });
    it("env vars override file config when providers.json exists", () => {
        // First create a valid providers.json with all required providers
        const providersPath = path.join(tempDir, "providers.json");
        const baseConfig = {
            openai: {
                id: "openai",
                name: "OpenAI",
                upstreamUrl: "https://file.openai.com",
                apiFormat: "chat-completions",
                authType: "bearer",
                enabled: true,
                rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-openai-baseurl",
            },
            anthropic: {
                id: "anthropic",
                name: "Anthropic",
                upstreamUrl: "https://api.anthropic.com",
                apiFormat: "anthropic-messages",
                authType: "bearer",
                enabled: true,
                rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-anthropic-baseurl",
            },
            chatgpt: {
                id: "chatgpt",
                name: "ChatGPT",
                upstreamUrl: "https://chatgpt.com",
                apiFormat: "chatgpt-backend",
                authType: "bearer",
                enabled: true,
                rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-chatgpt-baseurl",
            },
            gemini: {
                id: "gemini",
                name: "Gemini",
                upstreamUrl: "https://generativelanguage.googleapis.com",
                apiFormat: "gemini",
                authType: "api-key",
                enabled: true,
                rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-gemini-baseurl",
            },
            vertex: {
                id: "vertex",
                name: "Vertex AI",
                upstreamUrl: "https://us-central1-aiplatform.googleapis.com",
                apiFormat: "gemini",
                authType: "api-key",
                enabled: true,
                rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-vertex-baseurl",
            },
            nvidia: {
                id: "nvidia",
                name: "NVIDIA",
                upstreamUrl: "https://integrate.api.nvidia.com",
                apiFormat: "chat-completions",
                authType: "bearer",
                enabled: true,
                rateLimit: { maxRequests: 20, windowMs: 60000, bufferCapacity: 5 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-nvidia-baseurl",
            },
            kilo: {
                id: "kilo",
                name: "Kilo",
                upstreamUrl: "https://api.kilo.ai/api/gateway",
                apiFormat: "chat-completions",
                authType: "bearer",
                enabled: true,
                rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-kilo-baseurl",
            },
            openrouter: {
                id: "openrouter",
                name: "OpenRouter",
                upstreamUrl: "https://openrouter.ai/api",
                apiFormat: "chat-completions",
                authType: "bearer",
                enabled: true,
                rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-openrouter-baseurl",
            },
            unknown: {
                id: "unknown",
                name: "Unknown",
                upstreamUrl: "https://unknown.provider",
                apiFormat: "unknown",
                authType: "none",
                enabled: true,
                rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: false,
                baseUrlOverrideHeader: "x-unknown-baseurl",
            },
        };
        fs.writeFileSync(providersPath, JSON.stringify(baseConfig, null, 2));
        try {
            process.env.PROVIDERS_FILE = providersPath;
            process.env.UPSTREAM_OPENAI_URL = "https://env.openai.com";
            process.env.CONTEXTIO_RATE_LIMIT_OPENAI_MAX_REQUESTS = "200";
            process.env.CONTEXTIO_RETRY_OPENAI_MAX_RETRIES = "7";
            const config = resolveConfig();
            assert.equal(config.upstreams.openai, "https://env.openai.com");
            assert.equal(config.rateLimiter.openai.maxRequests, 200);
            assert.equal(config.retry.openai.maxRetries, 7);
        }
        finally {
            delete process.env.PROVIDERS_FILE;
            delete process.env.UPSTREAM_OPENAI_URL;
            delete process.env.CONTEXTIO_RATE_LIMIT_OPENAI_MAX_REQUESTS;
            delete process.env.CONTEXTIO_RETRY_OPENAI_MAX_RETRIES;
        }
    });
    it("programmatic overrides override env vars and file config", () => {
        // First create a valid providers.json with all required providers
        const providersPath = path.join(tempDir, "providers.json");
        const baseConfig = {
            openai: {
                id: "openai",
                name: "OpenAI",
                upstreamUrl: "https://file.openai.com",
                apiFormat: "chat-completions",
                authType: "bearer",
                enabled: true,
                rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-openai-baseurl",
            },
            anthropic: {
                id: "anthropic",
                name: "Anthropic",
                upstreamUrl: "https://api.anthropic.com",
                apiFormat: "anthropic-messages",
                authType: "bearer",
                enabled: true,
                rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-anthropic-baseurl",
            },
            chatgpt: {
                id: "chatgpt",
                name: "ChatGPT",
                upstreamUrl: "https://chatgpt.com",
                apiFormat: "chatgpt-backend",
                authType: "bearer",
                enabled: true,
                rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-chatgpt-baseurl",
            },
            gemini: {
                id: "gemini",
                name: "Gemini",
                upstreamUrl: "https://generativelanguage.googleapis.com",
                apiFormat: "gemini",
                authType: "api-key",
                enabled: true,
                rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-gemini-baseurl",
            },
            vertex: {
                id: "vertex",
                name: "Vertex AI",
                upstreamUrl: "https://us-central1-aiplatform.googleapis.com",
                apiFormat: "gemini",
                authType: "api-key",
                enabled: true,
                rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-vertex-baseurl",
            },
            nvidia: {
                id: "nvidia",
                name: "NVIDIA",
                upstreamUrl: "https://integrate.api.nvidia.com",
                apiFormat: "chat-completions",
                authType: "bearer",
                enabled: true,
                rateLimit: { maxRequests: 20, windowMs: 60000, bufferCapacity: 5 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-nvidia-baseurl",
            },
            kilo: {
                id: "kilo",
                name: "Kilo",
                upstreamUrl: "https://api.kilo.ai/api/gateway",
                apiFormat: "chat-completions",
                authType: "bearer",
                enabled: true,
                rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-kilo-baseurl",
            },
            openrouter: {
                id: "openrouter",
                name: "OpenRouter",
                upstreamUrl: "https://openrouter.ai/api",
                apiFormat: "chat-completions",
                authType: "bearer",
                enabled: true,
                rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: true,
                baseUrlOverrideHeader: "x-openrouter-baseurl",
            },
            unknown: {
                id: "unknown",
                name: "Unknown",
                upstreamUrl: "https://unknown.provider",
                apiFormat: "unknown",
                authType: "none",
                enabled: true,
                rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
                retry: {
                    maxRetries: 3,
                    baseDelayMs: 1000,
                    maxDelayMs: 30000,
                    retryableStatuses: [429, 500, 502, 503, 504],
                    jitterFactor: 0.2,
                },
                customHeaders: {},
                allowBaseUrlOverride: false,
                baseUrlOverrideHeader: "x-unknown-baseurl",
            },
        };
        fs.writeFileSync(providersPath, JSON.stringify(baseConfig, null, 2));
        try {
            process.env.PROVIDERS_FILE = providersPath;
            process.env.UPSTREAM_OPENAI_URL = "https://env.openai.com";
            const config = resolveConfig({
                upstreams: { openai: "https://override.openai.com" },
            });
            assert.equal(config.upstreams.openai, "https://override.openai.com");
        }
        finally {
            delete process.env.PROVIDERS_FILE;
            delete process.env.UPSTREAM_OPENAI_URL;
        }
    });
});
//# sourceMappingURL=config.test.js.map