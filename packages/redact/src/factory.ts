/**
 * Redact plugin factory for proxy integration.
 *
 * This module exports a factory function that creates a redact plugin
 * configured from environment variables and the web UI settings file.
 * It can be loaded via CONTEXT_PROXY_PLUGINS=@contextio/redact/factory.
 *
 * Environment variables (web UI settings take precedence if set):
 * - REDACT_PRESET: "secrets" | "pii" | "strict" (default: "pii")
 * - REDACT_REVERSIBLE: "true" | "false" (default: "false")
 * - REDACT_POLICY_FILE: path to policy JSON file
 * - REDACT_DETECTOR_MODE: "rules" | "llm" | "hybrid" | "auto" (default: "rules")
 * - REDACT_DETECTOR_MODEL_DIR: path to GLiNER ONNX model directory
 * - REDACT_DETECTOR_THRESHOLD: number 0-1 (default: 0.5)
 * - LOGGER_CAPTURE_DIR: capture directory for sidecar writes
 */

import fs from "node:fs";
import { createRedactPlugin, type RedactPluginConfig } from "./index.js";
import type { ProxyPlugin } from "@contextio/core";

const WEB_UI_SETTINGS_PATH = "/app/custom-policy/settings.json";

interface WebUISettings {
	redactPreset?: string;
	redactReversible?: boolean;
	redactPolicyFile?: string;
	detectorMode?: "rules" | "llm" | "hybrid" | "auto";
	detectorModelDir?: string;
	detectorThreshold?: number;
}

/** Read web UI settings from JSON file. */
function readWebUISettings(): WebUISettings {
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
function buildRedactConfig(): RedactPluginConfig | null {
	const settings = readWebUISettings();

	// Check if redaction is enabled via env or settings
	const redactEnabled =
		process.env.REDACT_ENABLED === "true" || settings.redactPreset !== undefined;

	if (!redactEnabled) {
		// Check legacy env vars
		const legacyEnabled =
			process.env.REDACT_PRESET || process.env.REDACT_POLICY_FILE;
		if (!legacyEnabled) return null;
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
		captureDir: process.env.LOGGER_CAPTURE_DIR,
	};

	// Only enable if explicitly configured
	const hasRedactionConfig =
		config.preset ||
		config.policyFile ||
		config.detectorMode !== "rules";

	if (!hasRedactionConfig) return null;

	return config;
}

/** Factory function for CONTEXT_PROXY_PLUGINS. */
export default function createRedactPluginFactory(): ProxyPlugin | null {
	const config = buildRedactConfig();
	if (!config) return null;
	return createRedactPlugin(config);
}

/** Named export for alternative import style. */
export { createRedactPluginFactory };