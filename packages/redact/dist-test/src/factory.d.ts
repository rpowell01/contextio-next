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
 * - REDACT_DETECTOR_MODEL_NAME: HuggingFace model ID for Presidio TS (default: "Xenova/bert-base-NER")
 * - REDACT_DETECTOR_MODEL_DIR: (deprecated) path to model directory, kept for backward compatibility
 * - REDACT_DETECTOR_THRESHOLD: number 0-1 (default: 0.5)
 * - CONTEXTIO_ENABLE_REDACT: "true" | "false" (default: "true") - Enable/disable redact plugin
 */
import type { ProxyPlugin } from "@contextio/core";
/** Factory function for redact plugin (enabled via CONTEXTIO_ENABLE_REDACT env var). */
export default function createRedactPluginFactory(): Promise<ProxyPlugin | null>;
/** Named export for alternative import style. */
export { createRedactPluginFactory };
//# sourceMappingURL=factory.d.ts.map