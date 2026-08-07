import type { OutputScanResult } from "./output-scanner.js";
/**
 * Extract URLs from text.
 *
 * @param text - The text to extract URLs from
 * @returns Array of URLs found
 */
export declare function extractUrls(text: string): string[];
/**
 * Scan text for URLs whose domain appears in the blocklist.
 *
 * Subdomains are also matched: blocking "evil.com" also blocks "api.evil.com".
 * Invalid or unparseable URLs are silently skipped.
 *
 * Note: `offset` is computed with `indexOf`, so if the same URL appears
 * multiple times the reported offset will always point to the first occurrence.
 * This is a known limitation; for most alerting purposes it is good enough.
 *
 * @param text - The text to scan.
 * @param blockedDomains - Domains to block (defaults to the built-in placeholder list).
 * @returns Scan result with one alert per blocked URL found.
 */
export declare function scanUrls(text: string, blockedDomains?: string[]): OutputScanResult;
//# sourceMappingURL=output-urls.d.ts.map