/**
 * Rule-based detector adapter.
 *
 * Wraps the existing RedactionRule system as a Detector implementation,
 * enabling the rule engine to participate in the detector pipeline.
 */
import type { RedactionRule } from "./rules.js";
import type { Detector, DetectorConfig, DetectionResult } from "./detector.js";
/**
 * Configuration for the rule-based detector.
 */
export interface RuleDetectorConfig extends DetectorConfig {
    /** Rules to apply. */
    rules: RedactionRule[];
    /** Exact strings that should never be flagged. */
    allowlistStrings?: string[];
    /** Regex patterns that should never be flagged. */
    allowlistPatterns?: string[];
    /** Placeholder tokens to skip (prevent re-redaction). */
    placeholderAllowlist?: string[];
}
/**
 * Rule-based PII/secret detector.
 *
 * Implements the Detector interface by applying RedactionRules to text.
 * This is a lightweight, fast detector with zero external dependencies.
 */
export declare class RuleDetector implements Detector {
    readonly name: string;
    readonly description = "Rule-based PII and secret detection using regex patterns with context gating";
    readonly labels: readonly string[];
    private rules;
    private allowlistStrings;
    private allowlistPatterns;
    private placeholderAllowlist;
    private initialized;
    constructor(config?: Partial<RuleDetectorConfig>);
    initialize(config?: DetectorConfig): Promise<void>;
    private threshold;
    isReady(): boolean;
    shutdown(): Promise<void>;
    detect(text: string, config?: DetectorConfig): Promise<DetectionResult>;
}
/**
 * Factory for creating RuleDetector instances.
 */
export declare function createRuleDetector(config?: RuleDetectorConfig): Promise<RuleDetector>;
//# sourceMappingURL=ruleDetector.d.ts.map