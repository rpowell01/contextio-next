import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { migrateProvidersArray } from "./providers.js";

describe("migrateProvidersArray", () => {
	it("returns empty object for empty array", () => {
		const result = migrateProvidersArray([]);
		assert.deepEqual(result, {});
	});

	it("migrates a single valid provider entry", () => {
		const input = [
			{
				id: "openai",
				name: "OpenAI",
				baseUrl: "https://api.openai.com",
				models: ["gpt-4"],
				allowBaseUrlOverride: true,
				baseUrlOverrideHeader: "x-openai-baseurl",
				apiFormat: "chat-completions",
				authType: "bearer",
				enabled: true,
				rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500], jitterFactor: 0.2 },
				customHeaders: {},
			},
		];
		const result = migrateProvidersArray(input);
		assert.equal(Object.keys(result).length, 1);
		assert.ok(result["openai"], "should be keyed by provider id");
		// Field mapping: baseUrl -> upstreamUrl
		assert.equal(result["openai"].upstreamUrl, "https://api.openai.com");
		assert.equal(result["openai"].name, "OpenAI");
		assert.equal(result["openai"].apiFormat, "chat-completions");
		assert.equal(result["openai"].authType, "bearer");
		assert.equal(result["openai"].enabled, true);
		assert.equal(result["openai"].rateLimit.maxRequests, 60);
		assert.equal(result["openai"].retry.maxRetries, 3);
		assert.deepEqual(result["openai"].customHeaders, {});
		assert.equal(result["openai"].allowBaseUrlOverride, true);
		assert.equal(result["openai"].baseUrlOverrideHeader, "x-openai-baseurl");
	});

	it("migrates multiple valid provider entries", () => {
		const input = [
			{
				id: "openai",
				name: "OpenAI",
				baseUrl: "https://api.openai.com",
				models: [],
				allowBaseUrlOverride: true,
				baseUrlOverrideHeader: "x-openai-baseurl",
				apiFormat: "chat-completions",
				authType: "bearer",
				enabled: true,
				rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500], jitterFactor: 0.2 },
				customHeaders: {},
			},
			{
				id: "anthropic",
				name: "Anthropic",
				baseUrl: "https://api.anthropic.com",
				models: [],
				allowBaseUrlOverride: true,
				baseUrlOverrideHeader: "x-anthropic-baseurl",
				apiFormat: "anthropic-messages",
				authType: "bearer",
				enabled: true,
				rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500], jitterFactor: 0.2 },
				customHeaders: {},
			},
		];
		const result = migrateProvidersArray(input);
		assert.equal(Object.keys(result).length, 2);
		assert.ok(result["openai"], "should contain openai");
		assert.ok(result["anthropic"], "should contain anthropic");
		assert.equal(result["openai"].upstreamUrl, "https://api.openai.com");
		assert.equal(result["anthropic"].upstreamUrl, "https://api.anthropic.com");
	});

	it("skips invalid entries with missing id", () => {
		const input = [
			{
				id: "openai",
				name: "OpenAI",
				baseUrl: "https://api.openai.com",
				models: [],
				allowBaseUrlOverride: true,
				baseUrlOverrideHeader: "x-openai-baseurl",
				apiFormat: "chat-completions",
				authType: "bearer",
				enabled: true,
				rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500], jitterFactor: 0.2 },
				customHeaders: {},
			},
			{
				// Missing id
				name: "Invalid Provider",
				baseUrl: "https://example.com",
				models: [],
				allowBaseUrlOverride: true,
				baseUrlOverrideHeader: "x-invalid-baseurl",
				apiFormat: "chat-completions",
				authType: "bearer",
				enabled: true,
				rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500], jitterFactor: 0.2 },
				customHeaders: {},
			},
		];
		const result = migrateProvidersArray(input);
		assert.equal(Object.keys(result).length, 1);
		assert.ok(result["openai"], "should only contain the valid entry");
	});

	it("skips entries with invalid apiFormat", () => {
		const input = [
			{
				id: "openai",
				name: "OpenAI",
				baseUrl: "https://api.openai.com",
				models: [],
				allowBaseUrlOverride: true,
				baseUrlOverrideHeader: "x-openai-baseurl",
				apiFormat: "invalid-format",
				authType: "bearer",
				enabled: true,
				rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500], jitterFactor: 0.2 },
				customHeaders: {},
			},
		];
		const result = migrateProvidersArray(input);
		assert.equal(Object.keys(result).length, 0);
	});

	it("is idempotent: produces same output for same input", () => {
		const input = [
			{
				id: "openai",
				name: "OpenAI",
				baseUrl: "https://api.openai.com",
				models: ["gpt-4"],
				allowBaseUrlOverride: true,
				baseUrlOverrideHeader: "x-openai-baseurl",
				apiFormat: "chat-completions",
				authType: "bearer",
				enabled: true,
				rateLimit: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
				retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryableStatuses: [429, 500], jitterFactor: 0.2 },
				customHeaders: { "X-Custom": "value" },
			},
		];
		const result1 = migrateProvidersArray(input);
		const result2 = migrateProvidersArray(input);
		assert.deepEqual(result1, result2);
	});

	it("handles entries with default values for optional fields", () => {
		const input = [
			{
				id: "openai",
				name: "OpenAI",
				baseUrl: "https://api.openai.com",
				models: [],
				allowBaseUrlOverride: true,
				baseUrlOverrideHeader: "x-openai-baseurl",
				apiFormat: "chat-completions",
				authType: "api-key",
				enabled: false,
				rateLimit: { maxRequests: 20, windowMs: 60000, bufferCapacity: 5 },
				retry: { maxRetries: 1, baseDelayMs: 500, maxDelayMs: 5000, retryableStatuses: [502], jitterFactor: 0.5 },
				customHeaders: { Authorization: "Bearer test" },
			},
		];
		const result = migrateProvidersArray(input);
		assert.equal(Object.keys(result).length, 1);
		assert.equal(result["openai"].enabled, false);
		assert.equal(result["openai"].authType, "api-key");
		assert.equal(result["openai"].customHeaders["Authorization"], "Bearer test");
		assert.equal(result["openai"].baseUrlOverrideHeader, "x-openai-baseurl");
	});
});
