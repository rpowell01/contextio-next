import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { resolveConfig } from "../dist/config.js";

function makeTempHome(): string {
	return path.join(tmpdir(), `contextio-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

function settingsPathFromHome(home: string): string {
	return path.join(home, ".contextio-next", "settings.json");
}

function writeSettings(home: string, settings: Record<string, unknown>): void {
	const dir = path.join(home, ".contextio-next");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(settingsPathFromHome(home), JSON.stringify(settings, null, 2));
}

function removeSettings(home: string): void {
	try {
		fs.unlinkSync(settingsPathFromHome(home));
	} catch {
		// ignore
	}
}

describe("resolveConfig", () => {
	let tempHome: string | undefined;

	before(() => {
		tempHome = makeTempHome();
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
	});

	after(() => {
		if (tempHome) {
			try {
				fs.rmSync(tempHome, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	});

	before(() => {
		// Per-test env isolation
		delete process.env.LOGGER_CAPTURE_MAX_AGE;
		delete process.env.LOGGER_CAPTURE_CLEANUP_INTERVAL;
		delete process.env.LOGGER_CAPTURE_CLEANUP_ENABLED;
		removeSettings(tempHome!);
	});

	after(() => {
		// cleanup settings that tests may have written
		removeSettings(tempHome!);
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

		assert.equal(
			config.upstreams.openai,
			"https://api.openai.com/v1/chat/completions",
		);
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
		writeSettings(tempHome!, {
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
		writeSettings(tempHome!, {
			captureCleanupEnabled: false,
			captureCleanupMaxAgeDays: 30,
		});
		try {
			const config = resolveConfig();
			assert.equal(config.loggerCaptureCleanupEnabled, false);
			// maxAgeMs is still computed from settings.json even when disabled
			assert.equal(config.loggerCaptureMaxAgeMs, 30 * 24 * 60 * 60 * 1000);
		} finally {
			removeSettings(tempHome!);
		}
	});

	it("environment variables override persisted settings.json", () => {
		writeSettings(tempHome!, {
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
		} finally {
			removeSettings(tempHome!);
			delete process.env.LOGGER_CAPTURE_MAX_AGE;
			delete process.env.LOGGER_CAPTURE_CLEANUP_INTERVAL;
			delete process.env.LOGGER_CAPTURE_CLEANUP_ENABLED;
		}
	});

	it("programmatic overrides override persisted settings.json", () => {
		writeSettings(tempHome!, {
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
		} finally {
			removeSettings(tempHome!);
		}
	});

	it("falls back to defaults when settings.json is missing", () => {
		const config = resolveConfig();
		assert.equal(config.loggerCaptureCleanupEnabled, false);
		assert.equal(config.loggerCaptureMaxAgeMs, 0);
		assert.equal(config.loggerCaptureCleanupIntervalMs, 24 * 60 * 60 * 1000);
	});
});