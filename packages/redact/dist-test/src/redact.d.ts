/**
 * Redaction engine.
 *
 * Recursively walks a JSON value, applying redaction rules to string
 * leaves. Supports context-word gating and JSON path filtering.
 * Preserves structure; does not mutate the original.
 */
import type { ReplacementMap } from "./mapping.js";
import type { CompiledPolicy } from "./policy.js";
import type { RedactionRule } from "./rules.js";
/**
 * A single redaction match record captured at write time.
 */
export interface MatchEntry {
    /** Canonical rule ID/name token (e.g. `SSN_4`). */
    ruleId: string;
    /** Original raw value before replacement. */
    preValue: string;
    /** Replacement value written into the capture. */
    postValue: string;
    /** JSON path to the affected leaf, dot-delimited. */
    path: string;
}
/**
 * Internal statistics accumulator used during a single redact pass.
 */
export interface RedactionStats {
    /** Total number of replacements made across all rules. */
    totalReplacements: number;
    /** Per-rule replacement counts. Only includes rules that matched. */
    byRule: Record<string, number>;
    /** Match payload captured for the metadata. */
    matches?: MatchEntry[];
}
export declare function createStats(): RedactionStats;
export declare function recordMatch(stats: RedactionStats, ruleId: string, preValue: string, postValue: string, path: string[]): void;
export declare function buildRedactMetaPayload(stats: RedactionStats): {
    totalRedactions: number;
    byRule: Readonly<Record<string, number>>;
    matches?: MatchEntry[];
};
/**
 * Full redaction metadata for direct SQLite persistence.
 * This matches the RedactionMetadata type from @contextio/core/db.
 */
export interface RedactionMetadata {
    captureId: string;
    sessionId: string | null;
    ruleCounts: Record<string, number>;
    totalRedactions: number;
    encrypted: boolean;
    createdAt: number;
    updatedAt: number;
    source?: string | null;
    provider?: string | null;
    targetUrl?: string | null;
    requestBytes?: number;
    responseBytes?: number;
    timings?: {
        send_ms?: number;
        wait_ms?: number;
        receive_ms?: number;
        total_ms?: number;
    };
    totalInputTokens?: number;
    totalOutputTokens?: number;
    tokensPerSecond?: number;
    successCount?: number;
    errorCount?: number;
    model?: string | null;
    matches?: MatchEntry[];
}
/**
 * Build a complete RedactionMetadata record for SQLite persistence.
 * The redact plugin has all the context needed to build this.
 */
export declare function buildFullRedactionMetadata(captureId: string, ctx: {
    provider?: string | null;
    sessionId?: string | null;
    targetUrl?: string;
    source?: string | null;
}, stats: RedactionStats): RedactionMetadata;
/**
 * Check if a JSON path matches a path matcher pattern.
 */
/**
 * Check if a JSON path matches a path matcher pattern.
 */
export declare function pathMatches(segments: string[], matcher: string[]): boolean;
export declare function shouldRedactPath(path: string[], onlyMatchers: {
    segments: string[];
}[] | null, skipMatchers: {
    segments: string[];
}[]): boolean;
/**
 * Apply redaction rules to a single string, respecting context words
 * and allowlists.
 */
export declare function redactString(input: string, rules: RedactionRule[], allowlistStrings: Set<string>, allowlistPatterns: RegExp[], placeholderAllowlist: Set<string>, stats: RedactionStats, map: ReplacementMap | null, currentPath?: string[]): string;
/**
 * Recursively walk a JSON value and apply redaction rules to string leaves.
 */
export declare function redactWithPolicy(value: unknown, policy: CompiledPolicy, stats: RedactionStats, currentPath?: string[], map?: ReplacementMap | null): unknown;
/**
 * Simple redaction without path filtering or context words.
 */
export declare function redactValue(value: unknown, rules: RedactionRule[], allowlist: Set<string>, stats: RedactionStats, _depth?: string[]): unknown;
//# sourceMappingURL=redact.d.ts.map