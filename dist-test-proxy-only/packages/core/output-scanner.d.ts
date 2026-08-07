/**
 * Output security scanning for model responses.
 *
 * Scans LLM output for:
 * - Jailbreak indicators (DAN mode markers, EICAR test strings)
 * - Dangerous code patterns (eval+atob, child_process, fs writes to /etc/)
 * - Suspicious URLs (known malicious domains)
 * - Custom regex patterns (user-configurable)
 *
 * Each scanner can run independently or combined via `scanOutput()`.
 *
 * Zero external dependencies.
 */
import { extractUrls, scanUrls } from "./output-urls.js";
/** A single finding from output scanning. */
export interface OutputAlert {
    /** Index of the matched rule or pattern within its scanner. */
    index: number;
    severity: "high" | "medium" | "low";
    /** Scanner-specific pattern identifier (e.g. "ban_substring", "shell_exec"). */
    pattern: string;
    /** The matched text, truncated to ~120 chars. */
    match: string;
    /** Character offset in the scanned text. */
    offset: number;
    /** Length of the matched region. */
    length: number;
}
/** Result from any output scanner. */
export interface OutputScanResult {
    /** True if no alerts were found. */
    isSafe: boolean;
    alerts: OutputAlert[];
    /** The input text with matches replaced by "[REDACTED]", if redaction was enabled. */
    redactedOutput?: string;
}
/**
 * Substrings that indicate a compromised or jailbroken model response.
 *
 * Includes DAN/jailbreak output markers, the EICAR antivirus test string,
 * GTUBE anti-spam test, GTPHISH anti-phishing test, and markdown image
 * injection (`![http`) which can exfiltrate data via image URLs.
 */
export declare const OUTPUT_BAN_SUBSTRINGS: string[];
/**
 * Scan text for banned substrings.
 *
 * Each substring is compiled into a regex (with special chars escaped) so
 * multi-line and Unicode text is handled correctly. All matches for all
 * substrings are collected; a single piece of text can trigger multiple alerts.
 *
 * @param text - The text to scan.
 * @param substrings - Substrings to ban. Defaults to {@link OUTPUT_BAN_SUBSTRINGS}.
 * @param caseSensitive - When false (default), matching is case-insensitive.
 * @returns Scan result; `isSafe` is true only if zero substrings matched.
 */
export declare function scanBanSubstrings(text: string, substrings?: string[], caseSensitive?: boolean): OutputScanResult;
/**
 * Scan text against a list of custom regex patterns.
 *
 * Supports two modes:
 * - **Blocked mode** (`isBlocked = true`, the default): each match triggers an alert.
 *   Use this to flag output that contains forbidden content.
 * - **Required mode** (`isBlocked = false`): each *absent* pattern triggers an alert.
 *   Use this to enforce that output contains required content (e.g. a disclaimer).
 *   `isSafe` is true when every required pattern was found (zero alerts).
 *
 * @param text - The text to scan.
 * @param patterns - Regex pattern strings, compiled with "gi" flags.
 * @param isBlocked - `true` = alert on matches; `false` = alert on missing matches.
 * @param redact - When `true` and in blocked mode, replace matched text with "[REDACTED]".
 * @returns Scan result with alerts and optionally `redactedOutput`.
 */
export declare function scanRegex(text: string, patterns: string[], isBlocked?: boolean, redact?: boolean): OutputScanResult;
/**
 * Scan text for dangerous code patterns from {@link DANGEROUS_CODE_PATTERNS}.
 *
 * Resets `lastIndex` before each pattern because all patterns use the global
 * flag, and re-using a global regex without resetting it will skip matches
 * after the first call.
 *
 * @param text - The text or code snippet to scan.
 * @returns Scan result; `isSafe` is true only if no patterns matched.
 */
export declare function scanDangerousCode(text: string): OutputScanResult;
/**
 * Run all output scanners on a piece of text.
 *
 * By default all four scanners are active: banned substrings, URL checking,
 * dangerous code patterns, and custom regex. Disable individual scanners by
 * passing `false` for their option; enable redaction by passing `redact: true`.
 *
 * @param text - The LLM response text to scan.
 * @param options.banSubstrings - Override the default ban list. Pass an empty
 *   array to disable banned-substring scanning entirely.
 * @param options.regexPatterns - Additional regex pattern strings to check
 *   (compiled with "gi" flags). Only runs when this array is non-empty.
 * @param options.scanUrls - Set to `false` to skip URL domain checking.
 * @param options.scanCode - Set to `false` to skip dangerous code detection.
 * @param options.redact - When `true`, replace matched regex patterns with
 *   "[REDACTED]" in `redactedOutput`. Does not affect other scanners.
 * @returns Combined alerts from all enabled scanners, plus `isSafe` and
 *   optionally `redactedOutput`.
 */
export declare function scanOutput(text: string, options?: {
    banSubstrings?: string[];
    regexPatterns?: string[];
    scanUrls?: boolean;
    scanCode?: boolean;
    redact?: boolean;
}): OutputScanResult;
export { extractUrls, scanUrls };
//# sourceMappingURL=output-scanner.d.ts.map