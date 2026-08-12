/**
 * @contextio/redact - Privacy and redaction layer for LLM API calls.
 *
 * Proxy plugin that strips PII, secrets, and API keys from request
 * bodies before they reach the LLM provider.
 *
 * Supports built-in presets (secrets, pii, strict), custom rules,
 * context-word gating, allowlists, and JSON path filtering.
 *
 * When `reversible` is enabled, the plugin tracks redacted values per
 * session and restores them in the LLM response, making redaction fully
 * transparent to the client.
 *
 * ```typescript
 * import { createRedactPlugin } from '@contextio/redact';
 *
 * // One-way: strip and forget
 * const redact = createRedactPlugin({ preset: "pii" });
 *
 * // Reversible: strip on request, restore on response
 * const redact = createRedactPlugin({ preset: "pii", reversible: true });
 * ```
 */
import type { ProxyPlugin } from "@contextio/core";
import type { CompiledPolicy } from "./policy.js";
import type { PresetName } from "./presets.js";
import { type RedactionMetadata } from "./redact.js";
import type { DetectorMode, RedactDetectorConfig } from "./detector.js";
/** Configuration for {@link createRedactPlugin}. */
export interface RedactPluginConfig {
    /** Built-in preset to use. Default: "pii". */
    preset?: PresetName;
    /** Path to a policy JSON(C) file. Overrides `preset`. */
    policyFile?: string;
    /** Pre-compiled policy object. Overrides both `preset` and `policyFile`. */
    policy?: CompiledPolicy;
    /**
     * Detection mode:
     * - "rules": rule-based only (default, fast, deterministic)
     * - "llm": LLM-based only (semantic understanding, slower)
     * - "hybrid": rules first for high-confidence patterns, LLM for ambiguous PII
     * - "auto": automatically choose based on content characteristics
     * Default: "rules"
     */
    detectorMode?: DetectorMode;
    /**
     * LLM detector configuration. Used when detectorMode is "llm", "hybrid", or "auto".
     */
    detectorConfig?: RedactDetectorConfig;
    /**
     * Enable reversible redaction. When true, the plugin tracks
     * original values per session and restores them in LLM responses.
     * The LLM sees `[EMAIL_1]`; the client sees the original.
     *
     * Requires session IDs in the URL path (set automatically by the CLI).
     * Default: false (one-way, strip and forget).
     */
    reversible?: boolean;
    /**
     * How long to keep a session's replacement map after its last request,
     * in milliseconds. Only used when `reversible` is true.
     * Default: 30 minutes.
     */
    sessionTtlMs?: number;
    /** Log redaction stats to stderr after each request. */
    verbose?: boolean;
    /**
     * Optional callback invoked after each redaction pass with the complete
     * metadata record. The plugin computes all fields and passes them here
     * instead of writing .redact-meta.json sidecar files.
     * The callback is responsible for persisting metadata (e.g., to SQLite).
     */
    onRedactionMetadata?: (metadata: RedactionMetadata) => void;
}
/**
 * Create a redact plugin.
 *
 * The plugin's onRequest hook walks the JSON request body and applies
 * the policy's redaction rules. The body sent to the upstream provider
 * will have sensitive data replaced with placeholder tokens.
 *
 * When `reversible` is true, the plugin also hooks onResponse and
 * onStreamChunk to replace placeholders back with the original values.
 * Each session (identified by the session ID in the URL path) gets its
 * own replacement map.
 */
export declare function createRedactPlugin(config?: RedactPluginConfig): ProxyPlugin;
export type { RedactionRule } from "./rules.js";
export type { PresetName } from "./presets.js";
export { PRESETS, getAllPlaceholderTokens, getPlaceholderPatterns } from "./presets.js";
export type { PolicyJson, PolicyRuleJson, CompiledPolicy } from "./policy.js";
export { compilePolicy, loadPolicyFile, fromPreset } from "./policy.js";
export type { RedactionStats, RedactionMetadata, MatchEntry } from "./redact.js";
export { redactWithPolicy, redactValue, createStats, redactString, buildFullRedactionMetadata } from "./redact.js";
export type { MappingEntry } from "./mapping.js";
export { ReplacementMap } from "./mapping.js";
export type { Detector, DetectorConfig, DetectionResult, DetectedSpan, DetectorMode, RedactDetectorConfig, DetectorPipelineConfig, DetectorFactory, } from "./detector.js";
export { detectorRegistry, registerDetector, createDetector } from "./detector.js";
export type { RuleDetectorConfig } from "./ruleDetector.js";
export { RuleDetector, createRuleDetector } from "./ruleDetector.js";
export type { PresidioTsConfig } from "./presidioTsDetector.js";
export { PresidioTsDetector, createPresidioTsDetector } from "./presidioTsDetector.js";
export { DetectorPipeline, createDetectorPipeline, createHybridDetector, mergeDetectionResults } from "./detectorPipeline.js";
export { createRedactPluginFactory } from "./factory.js";
//# sourceMappingURL=index.d.ts.map