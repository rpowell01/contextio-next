/**
 * Mapping from redaction rule names to placeholder names.
 *
 * The redaction engine stores counts by rule name (e.g., "api-key-prefixed")
 * but the actual content uses placeholders (e.g., "[API_KEY_REDACTED]").
 * This module provides a consistent way to convert between them using the
 * same preset definitions that the redaction engine uses.
 */

import { PRESETS } from "@contextio/redact";

/** Build a map from rule name -> placeholder (without brackets) */
function buildRuleToPlaceholderMap(): Map<string, string> {
  const map = new Map<string, string>();

  for (const preset of Object.values(PRESETS)) {
    for (const rule of preset) {
      // Rule replacement is like "[API_KEY_REDACTED]"
      // Extract the placeholder name: "API_KEY_REDACTED"
      const placeholder = rule.replacement.replace(/^\[|\]$/g, "");
      map.set(rule.name, placeholder);
    }
  }

  return map;
}

/** Singleton map for performance */
const ruleToPlaceholderMap = buildRuleToPlaceholderMap();

/**
 * Convert a rule name to its corresponding placeholder name.
 * Returns the rule name in uppercase with _REDACTED suffix if not found in map.
 */
export function ruleNameToPlaceholder(ruleName: string): string {
  const placeholder = ruleToPlaceholderMap.get(ruleName);
  if (placeholder) return placeholder;

  // Fallback: normalize rule name to placeholder format
  // e.g., "api-key-prefixed" -> "API_KEY_PREFIXED_REDACTED"
  return ruleName
    .toUpperCase()
    .replace(/-/g, "_")
    .replace(/_?$/, "_REDACTED")
    .replace(/_REDACTED_REDACTED$/, "_REDACTED");
}

/**
 * Convert a byRule object (keyed by rule names) to byPlaceholder object.
 */
export function convertByRuleToByPlaceholder(
  byRule: Record<string, number>
): Record<string, number> {
  const byPlaceholder: Record<string, number> = {};
  for (const [rule, count] of Object.entries(byRule)) {
    const placeholder = ruleNameToPlaceholder(rule);
    byPlaceholder[placeholder] = (byPlaceholder[placeholder] ?? 0) + count;
  }
  return byPlaceholder;
}

/**
 * Compute placeholder counts from an array of matches (from meta.matches).
 * This uses the actual placeholder strings found in content.
 * Supports both formats:
 * - { ruleId, placeholder, ... } (from redact-meta.json with placeholder field)
 * - { ruleId, preValue, postValue, ... } (from loadRedactionMeta return type)
 */
export function computePlaceholderCounts(
  matches: Array<{ ruleId: string; placeholder?: string; postValue?: string }>
): Record<string, number> {
  const byPlaceholder: Record<string, number> = {};
  for (const m of matches) {
    // postValue contains the placeholder (e.g., "[API_KEY_REDACTED]")
    const rawPlaceholder = m.placeholder ?? m.postValue ?? "UNKNOWN_REDACTED";
    // Extract placeholder name from "[PLACEHOLDER_REDACTED]" -> "PLACEHOLDER_REDACTED"
    const placeholder = rawPlaceholder?.replace(/^\[|\]$/g, "") ?? "UNKNOWN_REDACTED";
    byPlaceholder[placeholder] = (byPlaceholder[placeholder] ?? 0) + 1;
  }
  return byPlaceholder;
}

/**
 * Get all known placeholders from presets (for validation/display).
 */
export function getAllKnownPlaceholders(): string[] {
  const placeholders = new Set<string>();
  for (const preset of Object.values(PRESETS)) {
    for (const rule of preset) {
      const placeholder = rule.replacement.replace(/^\[|\]$/g, "");
      placeholders.add(placeholder);
    }
  }
  return Array.from(placeholders).sort();
}