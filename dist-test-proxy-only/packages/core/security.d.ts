/**
 * Input security scanning for prompt injection and suspicious patterns.
 *
 * Two tiers of detection:
 *
 * **Tier 1 (pattern matching):** Known injection phrases like "ignore previous
 * instructions", jailbreak templates (DAN, developer mode), and chat template
 * tokens that should never appear in user content.
 *
 * **Tier 2 (heuristic):** Role confusion in tool results (AI instructions
 * embedded in tool output), suspicious Unicode characters (zero-width,
 * RTL overrides) that could hide content from human review.
 *
 * Zero external dependencies.
 */
import type { AlertSeverity } from "./security-patterns.js";
export type { AlertSeverity } from "./security-patterns.js";
/** A single security finding from scanning input content. */
export interface SecurityAlert {
    /** Message index in the conversation (0-based). */
    index: number;
    /** Message role ("user", "assistant", "tool"), or null if unknown. */
    role: string | null;
    /** Tool name if this alert came from tool output content. */
    toolName: string | null;
    severity: AlertSeverity;
    /** Machine-readable pattern ID (matches a TIER1_PATTERNS id or "role_confusion"/"suspicious_unicode"). */
    pattern: string;
    /** The matched text snippet, truncated to ~120 chars. */
    match: string;
    /** Character offset where the match starts in the scanned text. */
    offset: number;
    /** Length of the matched region in characters. */
    length: number;
}
export interface SecuritySummary {
    high: number;
    medium: number;
    info: number;
}
export interface SecurityResult {
    alerts: SecurityAlert[];
    summary: SecuritySummary;
}
/**
 * Scan a single text string for prompt injection patterns.
 *
 * Runs both tier 1 (known phrases) and tier 2 (heuristic) checks.
 * Tier 2 role confusion checks only run when the content role is "tool".
 *
 * Note: `index` on all returned alerts is always 0. When scanning individual
 * messages from a conversation, use {@link scanRequestMessages} instead, or
 * overwrite `alert.index` after this call.
 *
 * @param text - The text to scan.
 * @param options - Optional: role, tool name, and whether to skip system messages.
 * @returns Alerts found, plus a severity summary.
 */
export declare function scanSecurity(text: string, options?: {
    /** Skip system/developer message scanning (they're trusted) */
    skipSystemMessages?: boolean;
    /** Role of the content being scanned */
    role?: string;
    /** Tool name if this is tool output */
    toolName?: string | null;
}): SecurityResult;
/**
 * Scan a conversation's messages for prompt injection.
 *
 * Iterates over the message array, skipping system/developer messages
 * (those are trusted). Extracts text from various content formats
 * (Anthropic content blocks, Gemini parts, plain strings) and scans each.
 *
 * @param messages - Message array from the request body.
 * @returns Combined alerts from all scanned messages, with per-message indices.
 */
export declare function scanRequestMessages(messages: Array<{
    role: string;
    content?: string | null;
    parts?: Array<{
        text?: string;
    }> | null;
    content_blocks?: Array<{
        type: string;
        text?: string;
        content?: string;
    }> | null;
}>): SecurityResult;
//# sourceMappingURL=security.d.ts.map