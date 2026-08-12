/**
 * Redaction engine.
 *
 * Recursively walks a JSON value, applying redaction rules to string
 * leaves. Supports context-word gating and JSON path filtering.
 * Preserves structure; does not mutate the original.
 */
import { shannonEntropy } from "@contextio/core";
export function createStats() {
    return { totalReplacements: 0, byRule: {} };
}
export function recordMatch(stats, ruleId, preValue, postValue, path) {
    if (!stats.matches)
        stats.matches = [];
    stats.matches.push({ ruleId, preValue, postValue, path: path.join(".") });
}
export function buildRedactMetaPayload(stats) {
    // Limit matches stored in metadata to first 20 to keep memory manageable.
    // Full match details are available on-demand from the capture file via the detail API.
    const MATCHES_LIMIT = 20;
    const limitedMatches = stats.matches && stats.matches.length > 0
        ? stats.matches.slice(0, MATCHES_LIMIT)
        : undefined;
    return {
        totalRedactions: stats.totalReplacements,
        byRule: { ...stats.byRule },
        ...(limitedMatches ? { matches: limitedMatches } : {}),
    };
}
/**
 * Build a complete RedactionMetadata record for SQLite persistence.
 * The redact plugin has all the context needed to build this.
 */
export function buildFullRedactionMetadata(captureId, ctx, stats) {
    const now = Date.now();
    return {
        captureId: captureId.endsWith(".json") ? captureId.slice(0, -5) : captureId,
        sessionId: ctx.sessionId ?? null,
        ruleCounts: stats.byRule,
        totalRedactions: stats.totalReplacements,
        encrypted: false,
        createdAt: now,
        updatedAt: now,
        source: ctx.source ?? null,
        provider: ctx.provider ?? null,
        targetUrl: ctx.targetUrl ?? null,
        requestBytes: 0,
        responseBytes: 0,
        timings: { send_ms: 0, wait_ms: 0, receive_ms: 0, total_ms: 0 },
        totalInputTokens: 0,
        totalOutputTokens: 0,
        tokensPerSecond: 0,
        successCount: 1,
        errorCount: 0,
        model: null,
        matches: stats.matches,
    };
}
// --- Context word matching ---
/**
 * Check if any context word appears within `window` characters of a match.
 */
function hasContextNearby(text, start, end, contextWords, window) {
    const windowStart = Math.max(0, start - window);
    const windowEnd = Math.min(text.length, end + window);
    const region = text.slice(windowStart, windowEnd).toLowerCase();
    for (const word of contextWords) {
        if (region.includes(word))
            return true;
    }
    return false;
}
/**
 * Check if a matched value is in the allowlist.
 */
function isAllowlisted(match, allowlistStrings, allowlistPatterns) {
    if (allowlistStrings.has(match))
        return true;
    for (const pat of allowlistPatterns) {
        pat.lastIndex = 0;
        if (pat.test(match))
            return true;
    }
    return false;
}
/**
 * Check the per-rule allowlist from a CredentialPattern.
 */
function isRuleAllowlisted(fullMatch, capturedGroup, ruleAllowlist) {
    for (const al of ruleAllowlist) {
        al.lastIndex = 0;
        const target = al.source.startsWith("^") ? (capturedGroup ?? fullMatch) : fullMatch;
        if (al.test(target))
            return true;
    }
    return false;
}
// --- JSON path matching ---
/**
 * Check if a JSON path matches a path matcher pattern.
 */
/**
 * Check if a JSON path matches a path matcher pattern.
 */
export function pathMatches(segments, matcher) {
    if (matcher.length > segments.length)
        return false;
    for (let i = 0; i < matcher.length; i++) {
        if (matcher[i] === "*")
            continue;
        if (segments[i] !== matcher[i])
            return false;
    }
    return true;
}
export function shouldRedactPath(path, onlyMatchers, skipMatchers) {
    for (const m of skipMatchers) {
        if (pathMatches(path, m.segments))
            return false;
    }
    if (onlyMatchers !== null) {
        for (const m of onlyMatchers) {
            if (pathMatches(path, m.segments))
                return true;
        }
        return false;
    }
    return true;
}
// --- String redaction ---
/**
 * Resolve the replacement string for a matched value.
 */
function resolveReplacement(match, rule, map) {
    if (map)
        return map.getOrCreate(match, rule.name);
    return rule.replacement;
}
/**
 * Apply redaction rules to a single string, respecting context words
 * and allowlists.
 */
export function redactString(input, rules, allowlistStrings, allowlistPatterns, placeholderAllowlist, stats, map, currentPath = []) {
    let result = input;
    for (const rule of rules) {
        rule.pattern.lastIndex = 0;
        if (rule.context && rule.context.length > 0) {
            // Context-gated: use exec loop to check context per match
            const window = rule.contextWindow ?? 100;
            const matches = [];
            rule.pattern.lastIndex = 0;
            let m;
            while ((m = rule.pattern.exec(result)) !== null) {
                matches.push({ start: m.index, end: m.index + m[0].length, match: m[0], captured: m[1] });
            }
            // Apply replacements in reverse order to preserve indices
            for (let i = matches.length - 1; i >= 0; i--) {
                const { start, end, match, captured } = matches[i];
                // Skip if match is a known placeholder token (prevent re-redaction)
                if (placeholderAllowlist.has(match))
                    continue;
                if (isAllowlisted(match, allowlistStrings, allowlistPatterns))
                    continue;
                if (rule.allowlist && isRuleAllowlisted(match, captured, rule.allowlist))
                    continue;
                if (rule.minEntropy !== undefined && shannonEntropy(captured ?? match) < rule.minEntropy)
                    continue;
                if (!hasContextNearby(result, start, end, rule.context, window))
                    continue;
                const replacement = resolveReplacement(match, rule, map);
                stats.totalReplacements++;
                stats.byRule[rule.name] = (stats.byRule[rule.name] || 0) + 1;
                recordMatch(stats, rule.name, match, replacement, currentPath);
                result = result.slice(0, start) + replacement + result.slice(end);
            }
        }
        else {
            // No context gating: simple replace
            result = result.replace(rule.pattern, (matchArg, ...args) => {
                const captured = typeof args[0] === "string" ? args[0] : undefined;
                // Skip if match is a known placeholder token (prevent re-redaction)
                if (placeholderAllowlist.has(matchArg))
                    return matchArg;
                if (isAllowlisted(matchArg, allowlistStrings, allowlistPatterns))
                    return matchArg;
                if (rule.allowlist && isRuleAllowlisted(matchArg, captured, rule.allowlist))
                    return matchArg;
                if (rule.minEntropy !== undefined && shannonEntropy(captured ?? matchArg) < rule.minEntropy)
                    return matchArg;
                const replacement = resolveReplacement(matchArg, rule, map);
                stats.totalReplacements++;
                stats.byRule[rule.name] = (stats.byRule[rule.name] || 0) + 1;
                recordMatch(stats, rule.name, matchArg, replacement, currentPath);
                return replacement;
            });
        }
    }
    return result;
}
// --- Recursive walker ---
/**
 * Recursively walk a JSON value and apply redaction rules to string leaves.
 */
export function redactWithPolicy(value, policy, stats, currentPath = [], map = null) {
    if (typeof value === "string") {
        if (policy.paths.only !== null || policy.paths.skip.length > 0) {
            if (!shouldRedactPath(currentPath, policy.paths.only, policy.paths.skip)) {
                return value;
            }
        }
        return redactString(value, policy.rules, policy.allowlist.strings, policy.allowlist.patterns, policy.placeholderAllowlist, stats, map, currentPath);
    }
    if (Array.isArray(value)) {
        return value.map((item) => redactWithPolicy(item, policy, stats, [...currentPath, "*"], map));
    }
    if (value !== null && typeof value === "object") {
        const result = {};
        for (const [key, val] of Object.entries(value)) {
            result[key] = redactWithPolicy(val, policy, stats, [...currentPath, key], map);
        }
        return result;
    }
    // Numbers, booleans, null: pass through
    return value;
}
// --- Legacy API (backward compatible) ---
/**
 * Simple redaction without path filtering or context words.
 */
export function redactValue(value, rules, allowlist, stats, _depth = []) {
    if (typeof value === "string") {
        return redactString(value, rules, allowlist, [], new Set(), stats, null, []);
    }
    if (Array.isArray(value)) {
        return value.map((item) => redactValue(item, rules, allowlist, stats));
    }
    if (value !== null && typeof value === "object") {
        const result = {};
        for (const [key, val] of Object.entries(value)) {
            result[key] = redactValue(val, rules, allowlist, stats);
        }
        return result;
    }
    return value;
}
//# sourceMappingURL=redact.js.map