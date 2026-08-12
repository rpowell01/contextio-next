/**
 * Policy system for @contextio/redact.
 *
 * A policy is a JSON document that describes what to redact and how.
 * Policies can extend built-in presets and add custom rules.
 *
 * Policy JSON format:
 * {
 *   "extends": "secrets",           // built-in preset: "secrets" | "pii" | "strict"
 *   "rules": [                      // additional rules (merged with preset)
 *     {
 *       "id": "employee-id",
 *       "pattern": "EMP-\\d{5}",
 *       "replacement": "[EMPLOYEE_ID]",
 *       "context": ["employee", "staff"]
 *     }
 *   ],
 *   "allowlist": {
 *     "strings": ["support@company.com"],
 *     "patterns": ["test-\\d+@example\\.com"]
 *   },
 *   "paths": {
 *     "only": ["messages[*].content", "system"],
 *     "skip": ["model", "metadata"]
 *   }
 * }
 */
import { type PresetName } from "./presets.js";
import type { RedactionRule } from "./rules.js";
export interface PolicyRuleJson {
    /** Unique identifier for this rule. */
    id: string;
    /** Regex pattern as a string. Compiled with the global flag. */
    pattern: string;
    /** Replacement string. */
    replacement: string;
    /**
     * Context words. If provided, the rule only fires when at least one
     * context word appears within a window around the match.
     */
    context?: string[];
    /** Window size in characters to search for context words. Default: 100. */
    contextWindow?: number;
}
export interface PolicyAllowlistJson {
    /** Exact strings that should never be redacted. */
    strings?: string[];
    /** Regex patterns for strings that should never be redacted. */
    patterns?: string[];
}
export interface PolicyPathsJson {
    /**
     * If set, only redact values at these JSON paths.
     * Supports simple dot notation and [*] for array wildcard.
     * Example: ["messages[*].content", "system"]
     */
    only?: string[];
    /**
     * Skip redaction for values at these JSON paths.
     * Checked before "only". Example: ["model", "metadata"]
     */
    skip?: string[];
}
export interface PolicyJson {
    /** Extend a built-in preset. Rules are merged (policy rules come after preset rules). */
    extends?: PresetName;
    /** Additional redaction rules. */
    rules?: PolicyRuleJson[];
    /** Allowlist configuration. */
    allowlist?: PolicyAllowlistJson;
    /** JSON path scoping. */
    paths?: PolicyPathsJson;
    /** Optional detector configuration override. Allows per-policy detector mode and LLM config. */
    detector?: {
        /** Detection mode: rules-only, LLM-only, hybrid (rules priority), or auto. */
        mode?: "rules" | "llm" | "hybrid" | "auto";
        /** LLM detector model to use (e.g., "Xenova/bert-base-NER"). Default: "Xenova/bert-base-NER". */
        llmModel?: string;
        /** HuggingFace model ID for Presidio TS (e.g., "Xenova/bert-base-NER"). Default: "Xenova/bert-base-NER". */
        modelName?: string;
        /** Runtime options for the detector. */
        options?: Record<string, unknown>;
        /** Minimum confidence threshold for LLM detections (0-1). Default: 0.5 */
        llmThreshold?: number;
        /** Entity labels for LLM detector. If empty, uses model's default labels. */
        llmLabels?: string[];
    };
}
export interface CompiledPolicy {
    rules: RedactionRule[];
    allowlist: {
        strings: Set<string>;
        patterns: RegExp[];
    };
    /**
     * Placeholder allowlist: known placeholder tokens (e.g., "API_KEY_REDACTED",
     * "EMAIL_REDACTED") to prevent re-redaction of already-redacted content
     * in captured JSON.
     */
    placeholderAllowlist: Set<string>;
    paths: {
        only: PathMatcher[] | null;
        skip: PathMatcher[];
    };
}
export interface PathMatcher {
    /** Original path string for debugging. */
    source: string;
    /** Segments to match against. "*" matches any array index or key. */
    segments: string[];
}
/**
 * Compile a PolicyJson into a CompiledPolicy.
 *
 * If the policy extends a preset, preset rules are included first (so
 * custom rules run after built-in ones). Allowlists and path matchers
 * are compiled into their runtime forms.
 *
 * @throws If `extends` references an unknown preset name.
 */
export declare function compilePolicy(json: PolicyJson): CompiledPolicy;
/**
 * Load a policy from a JSON file path. Supports // comments and trailing commas.
 * Returns null if the file doesn't exist or can't be read.
 */
export declare function loadPolicyFile(filePath: string): CompiledPolicy | null;
/**
 * Create a compiled policy from a preset name with no customizations.
 */
export declare function fromPreset(preset: PresetName): CompiledPolicy;
//# sourceMappingURL=policy.d.ts.map