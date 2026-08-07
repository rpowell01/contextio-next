/**
 * Header filtering for captures.
 *
 * The proxy logs headers for debugging but must never persist secrets
 * like API keys or auth tokens. This module is the single source of
 * truth for which headers get stripped before writing to disk.
 */
import type { HeaderMap } from "./types.js";
/**
 * Header names (lowercase) that must never be written to capture files.
 * Checked case-insensitively by `selectHeaders()`.
 */
export declare const SENSITIVE_HEADERS: Set<string>;
/**
 * Return a copy of `headers` with sensitive entries removed.
 *
 * Also filters out non-string values; Node's `IncomingHttpHeaders`
 * can represent multi-valued headers as `string[]`, but captures
 * store everything as `Record<string, string>`.
 */
export declare function selectHeaders(headers: HeaderMap): Record<string, string>;
//# sourceMappingURL=headers.d.ts.map