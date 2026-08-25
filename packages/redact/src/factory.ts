/**
 * Redact plugin factory for proxy integration.
 *
 * This module exports a factory function that creates a redact plugin
 * configured from environment variables and the web UI settings (stored in SQLite database).
 * The redact plugin is enabled via CONTEXTIO_ENABLE_REDACT environment variable (default: true).
 *
 * Environment variables (web UI settings take precedence if set):
 * - REDACT_PRESET: "secrets" | "pii" | "strict" (default: "pii")
 * - REDACT_REVERSIBLE: "true" | "false" (default: "false")
 * - REDACT_POLICY_FILE: path to policy JSON file
 * - REDACT_PATHS_ONLY: JSON array of paths where redaction applies (default: ["messages[*].content"])
 * - REDACT_PATHS_SKIP: JSON array of paths to skip redaction (default: tool calls, functions, etc.)
 * - REDACT_DETECTOR_MODE: "rules" | "llm" | "hybrid" | "auto" (default: "rules")
 * - REDACT_DETECTOR_MODEL_NAME: HuggingFace model ID for Presidio TS (default: "Xenova/bert-base-NER")
 * - REDACT_DETECTOR_THRESHOLD: number 0-1 (default: 0.5)
 * - CONTEXTIO_ENABLE_REDACT: "true" | "false" (default: "true") - Enable/disable redact plugin
 */

import { createRedactPlugin, type RedactPluginConfig, type RedactionMetadata, type RedactPlugin } from "./index.js";
import type { ProxyPlugin, Provider } from "@contextio/core";
import { upsertRedactionMetadata, getSettings } from "@contextio/core/db";

interface WebUISettings {
	redactPreset?: string;
	redactReversible?: boolean;
	redactPolicyFile?: string;
	redactPolicyEnabled?: boolean;
	redactPathsOnly?: string[];
	redactPathsSkip?: string[];
	redactDisabledRules?: string[];
	redactProviders?: Record<string, boolean>;
	detectorMode?: "rules" | "llm" | "hybrid" | "auto";
	detectorModelName?: string;
	detectorThreshold?: number;
	feedbackStoreEnabled?: boolean;
	feedbackStoreType?: "sqlite" | "memory";
	feedbackStorePath?: string;
}

/** Read web UI settings from SQLite database (with JSON file fallback for backward compatibility). */
async function readWebUISettings(): Promise<WebUISettings> {
	// First, try to read from the database
	try {
		const dbSettings = getSettings();
		if (dbSettings) {
			return {
				redactPreset: dbSettings.redactPreset,
				redactReversible: dbSettings.redactReversible,
				redactPolicyFile: dbSettings.redactPolicyFile,
				redactPolicyEnabled: dbSettings.redactPolicyEnabled,
				redactPathsOnly: dbSettings.redactPathsOnly,
				redactPathsSkip: dbSettings.redactPathsSkip,
				redactDisabledRules: dbSettings.redactDisabledRules,
				redactProviders: dbSettings.redactProviders,
				detectorMode: dbSettings.detectorMode,
				detectorModelName: dbSettings.detectorModelName,
				detectorThreshold: dbSettings.detectorThreshold,
				feedbackStoreEnabled: dbSettings.feedbackStoreEnabled,
				feedbackStoreType: dbSettings.feedbackStoreType,
				feedbackStorePath: dbSettings.feedbackStorePath,
			};
		}
	} catch (err) {
		console.log(`[redact-factory] failed to read settings from database, falling back to JSON file: ${err instanceof Error ? err.message : String(err)}`);
	}

	// Fallback to JSON file for backward compatibility (legacy migrations)
	const fs = await import("node:fs");
	const WEB_UI_SETTINGS_PATH = "/app/custom-policy/settings.json";
	try {
		const data = fs.readFileSync(WEB_UI_SETTINGS_PATH, "utf8");
		const parsed = JSON.parse(data);
		return {
			redactPreset: parsed.redactPreset,
			redactReversible: parsed.redactReversible,
			redactPolicyFile: parsed.redactPolicyFile,
			redactPolicyEnabled: parsed.redactPolicyEnabled,
			redactPathsOnly: parsed.redactPathsOnly,
			redactPathsSkip: parsed.redactPathsSkip,
			redactDisabledRules: parsed.redactDisabledRules,
			redactProviders: parsed.redactProviders,
			detectorMode: parsed.detectorMode,
			detectorModelName: parsed.detectorModelName ?? parsed.detectorModelDir,
			detectorThreshold: parsed.detectorThreshold,
			feedbackStoreEnabled: parsed.feedbackStoreEnabled,
			feedbackStoreType: parsed.feedbackStoreType,
			feedbackStorePath: parsed.feedbackStorePath,
		};
	} catch {
		return {};
	}
}

/** Build redact plugin config from env vars and web UI settings. */
async function buildRedactConfig(): Promise<RedactPluginConfig | null> {
	const settings = await readWebUISettings();

	// Check if redaction is enabled via env or settings
	const redactEnabled =
		process.env.CONTEXTIO_ENABLE_REDACT !== "false" || settings.redactPreset !== undefined;

	if (!redactEnabled) {
		return null;
	}

	const detectorConfig: RedactPluginConfig["detectorConfig"] = {};

	const modelName = settings.detectorModelName || process.env.REDACT_DETECTOR_MODEL_NAME;
	if (modelName) {
		detectorConfig.modelName = modelName;
	}
	if (settings.detectorThreshold !== undefined || process.env.REDACT_DETECTOR_THRESHOLD) {
		const val = settings.detectorThreshold ?? Number.parseFloat(process.env.REDACT_DETECTOR_THRESHOLD || "0.5");
		if (Number.isFinite(val) && val >= 0 && val <= 1) {
			detectorConfig.llmThreshold = val;
		}
	}

const config: RedactPluginConfig = {
		preset: (settings.redactPreset || process.env.REDACT_PRESET || "pii") as "secrets" | "pii" | "strict",
		reversible: settings.redactReversible ?? process.env.REDACT_REVERSIBLE === "true",
		// Only use policy file if explicitly enabled (default true for backward compatibility)
		policyFile: (settings.redactPolicyEnabled !== false) ? (settings.redactPolicyFile || process.env.REDACT_POLICY_FILE) : undefined,
		detectorMode: settings.detectorMode || (process.env.REDACT_DETECTOR_MODE as "rules" | "llm" | "hybrid" | "auto") || "rules",
		detectorConfig: Object.keys(detectorConfig).length > 0 ? detectorConfig : undefined,
		verbose: process.env.REDACT_VERBOSE === "true",
		sessionTtlMs: Number.parseInt(process.env.REDACT_SESSION_TTL_MS || "900000", 10),
		// Feedback store for false positive filtering
		feedbackStore: settings.feedbackStoreEnabled !== false ? (settings.feedbackStoreType || "sqlite") : undefined,
		disabledRules: settings.redactDisabledRules,
		// Compute disabled providers from per-provider redact toggle
		disabledProviders: (() => {
			const providers = settings.redactProviders;
			if (!providers) return undefined;
			return Object.entries(providers)
				.filter(([, enabled]) => !enabled)
				.map(([provider]) => provider as Provider);
		})(),
		onRedactionMetadata: (metadata: RedactionMetadata) => {
			// Only persist redaction metadata when the capture session metadata is fully populated.
			// If source, provider, or targetUrl are null/undefined, the capture session is still
			// being written and the metadata would have incomplete data, which would cause the
			// redaction diff dialog to show invalid data in the left and right panes.
			// buildFullRedactionMetadata converts undefined to null, so we check for null here.
			if (metadata.source !== null && metadata.provider !== null && metadata.targetUrl !== null) {
				upsertRedactionMetadata(metadata);
			}
		},
		// Path filtering: use settings from database, env vars as fallback, then hardcoded defaults
		paths: {
			only: settings.redactPathsOnly ?? (process.env.REDACT_PATHS_ONLY ? process.env.REDACT_PATHS_ONLY.split(",") : ["messages[*].content"]),
			skip: settings.redactPathsSkip ?? (process.env.REDACT_PATHS_SKIP ? process.env.REDACT_PATHS_SKIP.split(",") : [
				"tools",
				"tool_calls",
				"toolChoice",
				"tool_choice",
				"functions",
				"function_call",
				// Skip tool call IDs and function arguments to prevent NER false positives
				// Full paths from root (path matching is prefix-based)
				"messages[*].tool_calls[*].id",
				"messages[*].tool_calls[*].function.name",
				"messages[*].tool_calls[*].function.arguments",
				"messages[*].tools[*].id",
				"messages[*].tools[*].function.name",
				"messages[*].tools[*].function.arguments",
				"messages[*].function_call.id",
				"messages[*].function_call.name",
				"messages[*].function_call.arguments",
				// Also handle top-level tool_calls (non-standard but possible)
				"tool_calls[*].id",
				"tool_calls[*].function.name",
				"tool_calls[*].function.arguments",
				"tools[*].id",
				"tools[*].function.name",
				"tools[*].function.arguments",
				"function_call.id",
				"function_call.name",
				"function_call.arguments",
				// Anthropic/Claude format: messages[*].content[*] with type="tool_use"
				"messages[*].content[*].id",
				"messages[*].content[*].name",
				"messages[*].content[*].input",
				// Anthropic/Claude tool_result blocks (response from tool calls)
				"messages[*].content[*].tool_use_id",
				"messages[*].content[*].content",
				// Anthropic/Claude thinking blocks
				"messages[*].content[*].thinking",
				"messages[*].content[*].signature",
				// Block type discriminator (present on all content blocks)
				"messages[*].content[*].type",
				// Also handle top-level content arrays
				"content[*].id",
				"content[*].name",
				"content[*].input",
				"content[*].tool_use_id",
				"content[*].content",
				"content[*].thinking",
				"content[*].signature",
				"content[*].type",
			]),
		},
	};

	// Only enable if explicitly configured
	const hasRedactionConfig =
		config.preset ||
		config.policyFile ||
		config.detectorMode !== "rules";

	if (!hasRedactionConfig) return null;

	return config;
}

/** Factory function for redact plugin (enabled via CONTEXTIO_ENABLE_REDACT env var). */
export default async function createRedactPluginFactory(): Promise<RedactPlugin | null> {
	// Check if redact is explicitly disabled via env var
	const redactEnabled = process.env.CONTEXTIO_ENABLE_REDACT !== "false";
	if (!redactEnabled) {
		return null;
	}
	const config = await buildRedactConfig();
	if (!config) return null;
	return createRedactPlugin(config);
}

/** Named export for alternative import style. */
export { createRedactPluginFactory, type RedactPlugin };