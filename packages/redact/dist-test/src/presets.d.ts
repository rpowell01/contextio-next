/**
 * Built-in presets for @contextio/redact.
 *
 * Each preset is an ordered array of RedactionRules.
 * Presets build on each other: pii includes secrets, strict includes pii.
 *
 * Credential patterns (private key, AWS, GitHub, Anthropic, OpenAI, generic
 * secret assignment) are derived from the canonical CREDENTIAL_PATTERNS in
 * @contextio/core/security-patterns so detection and redaction stay in sync.
 */
import type { RedactionRule } from "./rules.js";
export type PresetName = "secrets" | "pii" | "strict";
/**
 * Built-in presets. Each higher tier includes all rules from lower tiers.
 */
export declare const PRESETS: Record<PresetName, RedactionRule[]>;
/**
 * Get all placeholder tokens from all presets.
 * Placeholder tokens are the replacement strings without brackets,
 * e.g., "[API_KEY_REDACTED]" -> "API_KEY_REDACTED".
 * This is used to populate the global placeholder allowlist to prevent
 * re-redaction of already-redacted placeholder tokens in captured JSON.
 */
export declare function getAllPlaceholderTokens(): string[];
/**
 * Get all placeholder tokens as RegExp patterns for the global allowlist.
 * These patterns will prevent re-redaction of any known placeholder token.
 */
export declare function getPlaceholderPatterns(): RegExp[];
//# sourceMappingURL=presets.d.ts.map