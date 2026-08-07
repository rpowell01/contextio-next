/**
 * Raw pattern data for prompt injection and jailbreak detection.
 *
 * Shared between `security.ts` (input scanning) and kept separate so the
 * pattern lists can be updated without touching scanner logic. Also exports
 * small utilities (`truncateMatch`, `escapeRegex`) that multiple scanners need.
 */
/** Severity level for a security alert. "info" is observational; "high" warrants action. */
export type AlertSeverity = "high" | "medium" | "info";
/** A single pattern rule used by the tier-1 injection scanner. */
interface PatternRule {
    /** Stable identifier used in alert reports and filtering. */
    id: string;
    severity: AlertSeverity;
    /** Must be stateless (no global flag) since `exec` is called once per string. */
    pattern: RegExp;
}
export declare const TIER1_PATTERNS: PatternRule[];
/**
 * Patterns that look like AI system instructions. When these appear in
 * tool results, it suggests an injection attempt trying to override the
 * model's behavior through tool output.
 */
export declare const ROLE_CONFUSION_PATTERNS: RegExp[];
/**
 * Suspicious Unicode characters that can hide content from human review:
 * zero-width spaces/joiners, RTL overrides, invisible separators, soft hyphens.
 */
export declare const SUSPICIOUS_UNICODE: RegExp;
/**
 * Shannon entropy of a string: average bits of information per character.
 * Used to gate credential_generic so low-variety values (all-same-char,
 * sequential digits) don't fire. Same algorithm as gitleaks detect/utils.go.
 */
export declare function shannonEntropy(s: string): number;
/** A credential detection rule. `pattern` must NOT use the global flag. */
export interface CredentialPattern {
    /** Stable identifier used in alert reports. */
    id: string;
    /** Human-readable label shown in UI alerts. */
    label: string;
    /** Detection regex. Stateless — no global flag. */
    pattern: RegExp;
    /**
     * Optional allowlist patterns. If any matches the full regex match string,
     * the finding is suppressed. Ported from gitleaks allowlist rules.
     * Each regex is tested against the entire match (not just the captured group).
     */
    allowlist?: RegExp[];
    /**
     * Minimum Shannon entropy (bits/char) required on the first capture group.
     * Findings where the captured value falls below this threshold are suppressed.
     * Mirrors the `entropy` field in gitleaks rules. Default: no check.
     */
    minEntropy?: number;
}
export declare const CREDENTIAL_PATTERNS: CredentialPattern[];
/**
 * Extract a snippet from `text` at `[start, start+length)`, capped at 120 chars.
 * Used to keep alert `match` fields readable without embedding huge strings.
 */
export declare function truncateMatch(text: string, start: number, length: number): string;
/**
 * Escape special regex characters in a string so it can be embedded
 * in a RegExp pattern without treating any character as a metacharacter.
 */
export declare function escapeRegex(str: string): string;
export {};
//# sourceMappingURL=security-patterns.d.ts.map