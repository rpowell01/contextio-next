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
 * - REDACT_DETECTOR_MODE: "rules" | "llm" | "hybrid" | "auto" (default: "rules")
 * - REDACT_DETECTOR_MODEL_DIR: path to GLiNER ONNX model directory
 * - REDACT_DETECTOR_THRESHOLD: number 0-1 (default: 0.5)
 * - CONTEXTIO_ENABLE_REDACT: "true" | "false" (default: "true") - Enable/disable redact plugin
 */

import { createRedactPlugin, type RedactPluginConfig, type RedactionMetadata } from "./index.js";
import type { ProxyPlugin } from "@contextio/core";
import { upsertRedactionMetadata, getSettings } from "@contextio/core/db";

interface WebUISettings {
	redactPreset?: string;
	redactReversible?: boolean;
	redactPolicyFile?: string;
	detectorMode?: "rules" | "llm" | "hybrid" | "auto";
	detectorModelDir?: string;
	detectorThreshold?: number;
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
				detectorMode: dbSettings.detectorMode,
				detectorModelDir: dbSettings.detectorModelDir,
				detectorThreshold: dbSettings.detectorThreshold,
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
			detectorMode: parsed.detectorMode,
			detectorModelDir: parsed.detectorModelDir,
			detectorThreshold: parsed.detectorThreshold,
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

	if (settings.detectorModelDir || process.env.REDACT_DETECTOR_MODEL_DIR) {
		detectorConfig.modelPath = settings.detectorModelDir || process.env.REDACT_DETECTOR_MODEL_DIR!;
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
		policyFile: settings.redactPolicyFile || process.env.REDACT_POLICY_FILE,
		detectorMode: settings.detectorMode || (process.env.REDACT_DETECTOR_MODE as "rules" | "llm" | "hybrid" | "auto") || "rules",
		detectorConfig: Object.keys(detectorConfig).length > 0 ? detectorConfig : undefined,
		verbose: process.env.REDACT_VERBOSE === "true",
		onRedactionMetadata: (metadata: RedactionMetadata) => {
			upsertRedactionMetadata(metadata);
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
export default async function createRedactPluginFactory(): Promise<ProxyPlugin | null> {
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
export { createRedactPluginFactory };