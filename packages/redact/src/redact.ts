/**
 * Redaction engine.
 *
 * Recursively walks a JSON value, applying redaction rules to string
 * leaves. Supports context-word gating and JSON path filtering.
 * Preserves structure; does not mutate the original.
 */

import fs from "node:fs";
import { join } from "node:path";
import { shannonEntropy } from "@contextio/core";

import type { ReplacementMap } from "./mapping.js";
import type { CompiledPolicy } from "./policy.js";
import type { RedactionRule } from "./rules.js";

export interface RedactionStats {
  /** Total number of replacements made across all rules. */
  totalReplacements: number;
  /** Per-rule replacement counts. Only includes rules that matched. */
  byRule: Record<string, number>;
  /** First-10 match payload captured for the sidecar meta file. */
  matches?: MatchEntry[];
}

export interface MatchEntry {
  rule: string;
  original: string;
  path: string;
}

export function createStats(): RedactionStats {
  return { totalReplacements: 0, byRule: {} };
}

function recordMatch(
  stats: RedactionStats,
  rule: RedactionRule,
  originalValue: string,
  path: string[],
): void {
  if (!stats.matches) stats.matches = [];
  if (stats.matches.length >= 10) return;
  stats.matches.push({ rule: rule.name, original: originalValue, path: path.join(".") });
}

export function buildRedactMetaPayload(
  stats: RedactionStats,
): { totalRedactions: number; byRule: Readonly<Record<string, number>>; matches?: MatchEntry[] } {
  return {
    totalRedactions: stats.totalReplacements,
    byRule: { ...stats.byRule },
    ...(stats.matches && stats.matches.length > 0 ? { matches: stats.matches } : {}),
  };
}

export function writeRedactionMeta(
  captureDir: string,
  captureId: string | undefined,
  payload: { totalRedactions: number; byRule: Readonly<Record<string, number>>; matches?: MatchEntry[] },
): boolean {
  if (!captureId) return false;
  const filePath = join(captureDir, `${captureId}.redact-meta.json`);
  const tmpPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload));
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err: unknown) {
    console.error("[redact] meta write error:", err instanceof Error ? err.message : String(err));
    try { fs.unlinkSync(tmpPath); } catch { /* may not exist */ }
    return false;
  }
}

// --- Context word matching ---

/**
 * Check if any context word appears within `window` characters of a match.
 */
function hasContextNearby(
  text: string,
  start: number,
  end: number,
  contextWords: string[],
  window: number,
): boolean {
  const windowStart = Math.max(0, start - window);
  const windowEnd = Math.min(text.length, end + window);
  const region = text.slice(windowStart, windowEnd).toLowerCase();
  for (const word of contextWords) {
    if (region.includes(word)) return true;
  }
  return false;
}

/**
 * Check if a matched value is in the allowlist.
 */
function isAllowlisted(
  match: string,
  allowlistStrings: Set<string>,
  allowlistPatterns: RegExp[],
): boolean {
  if (allowlistStrings.has(match)) return true;
  for (const pat of allowlistPatterns) {
    pat.lastIndex = 0;
    if (pat.test(match)) return true;
  }
  return false;
}

/**
 * Check the per-rule allowlist from a CredentialPattern.
 */
function isRuleAllowlisted(fullMatch: string, capturedGroup: string | undefined, ruleAllowlist: RegExp[]): boolean {
  for (const al of ruleAllowlist) {
    al.lastIndex = 0;
    const target = al.source.startsWith("^") ? (capturedGroup ?? fullMatch) : fullMatch;
    if (al.test(target)) return true;
  }
  return false;
}

// --- JSON path matching ---

/**
 * Check if a JSON path matches a path matcher pattern.
 */
function pathMatches(segments: string[], matcher: string[]): boolean {
  if (matcher.length > segments.length) return false;
  for (let i = 0; i < matcher.length; i++) {
    if (matcher[i] === "*") continue;
    if (segments[i] !== matcher[i]) return false;
  }
  return true;
}

function shouldRedactPath(
  path: string[],
  onlyMatchers: { segments: string[] }[] | null,
  skipMatchers: { segments: string[] }[],
): boolean {
  for (const m of skipMatchers) {
    if (pathMatches(path, m.segments)) return false;
  }
  if (onlyMatchers !== null) {
    for (const m of onlyMatchers) {
      if (pathMatches(path, m.segments)) return true;
    }
    return false;
  }
  return true;
}

// --- String redaction ---

/**
 * Resolve the replacement string for a matched value.
 */
function resolveReplacement(match: string, rule: RedactionRule, map: ReplacementMap | null): string {
  if (map) return map.getOrCreate(match, rule.name);
  return rule.replacement;
}

/**
 * Apply redaction rules to a single string, respecting context words
 * and allowlists.
 */
function redactString(
  input: string,
  rules: RedactionRule[],
  allowlistStrings: Set<string>,
  allowlistPatterns: RegExp[],
  stats: RedactionStats,
  map: ReplacementMap | null,
  currentPath: string[] = [],
): string {
  let result = input;
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;

    if (rule.context && rule.context.length > 0) {
      // Context-gated: use exec loop to check context per match
      const window = rule.contextWindow ?? 100;
      const matches: { start: number; end: number; match: string; captured: string | undefined }[] = [];
      rule.pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.pattern.exec(result)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length, match: m[0], captured: m[1] });
      }

      // Apply replacements in reverse order to preserve indices
      for (let i = matches.length - 1; i >= 0; i--) {
        const { start, end, match, captured } = matches[i];
        if (isAllowlisted(match, allowlistStrings, allowlistPatterns)) continue;
        if (rule.allowlist && isRuleAllowlisted(match, captured, rule.allowlist)) continue;
        if (rule.minEntropy !== undefined && shannonEntropy(captured ?? match) < rule.minEntropy) continue;
        if (!hasContextNearby(result, start, end, rule.context, window)) continue;
        stats.totalReplacements++;
        stats.byRule[rule.name] = (stats.byRule[rule.name] || 0) + 1;
        recordMatch(stats, rule, match, currentPath);
        const replacement = resolveReplacement(match, rule, map);
        result = result.slice(0, start) + replacement + result.slice(end);
      }
    } else {
      // No context gating: simple replace
      result = result.replace(rule.pattern, (matchArg, ...args) => {
        const captured = typeof args[0] === "string" ? args[0] : undefined;
        if (isAllowlisted(matchArg, allowlistStrings, allowlistPatterns)) return matchArg;
        if (rule.allowlist && isRuleAllowlisted(matchArg, captured, rule.allowlist)) return matchArg;
        if (rule.minEntropy !== undefined && shannonEntropy(captured ?? matchArg) < rule.minEntropy) return matchArg;
        stats.totalReplacements++;
        stats.byRule[rule.name] = (stats.byRule[rule.name] || 0) + 1;
        recordMatch(stats, rule, matchArg, currentPath);
        return resolveReplacement(matchArg, rule, map);
      });
    }
  }
  return result;
}

// --- Recursive walker ---

/**
 * Recursively walk a JSON value and apply redaction rules to string leaves.
 */
export function redactWithPolicy(
  value: unknown,
  policy: CompiledPolicy,
  stats: RedactionStats,
  currentPath: string[] = [],
  map: ReplacementMap | null = null,
): unknown {
  if (typeof value === "string") {
    if (policy.paths.only !== null || policy.paths.skip.length > 0) {
      if (!shouldRedactPath(currentPath, policy.paths.only, policy.paths.skip)) {
        return value;
      }
    }
    return redactString(
      value,
      policy.rules,
      policy.allowlist.strings,
      policy.allowlist.patterns,
      stats,
      map,
      currentPath,
    );
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactWithPolicy(item, policy, stats, [...currentPath, "*"], map));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
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
export function redactValue(
  value: unknown,
  rules: RedactionRule[],
  allowlist: Set<string>,
  stats: RedactionStats,
  _depth: string[] = [],
): unknown {
  if (typeof value === "string") {
    return redactString(value, rules, allowlist, [], stats, null, []);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, rules, allowlist, stats));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactValue(val, rules, allowlist, stats);
    }
    return result;
  }

  return value;
}
