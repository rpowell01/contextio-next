/**
 * Redaction counting utilities shared across API routes.
 *
 * Provides functions to recursively detect redacted placeholders in
 * JSON structures and raw strings. Both the captures API and the session
 * detail API use these so redaction counts stay consistent.
 */

/** One redaction match found by the helper functions. */
export interface RedactionMatch {
  ruleId: string;
  original: string;
  placeholder: string;
  path: string;
}

/** Aggregate redaction counts per rule. */
export interface RedactionCounts {
  totalRedactions: number;
  byRule: Record<string, number>;
  matches: RedactionMatch[];
}

// Matches redacted placeholders: [RULE_REDACTED] where RULE is uppercase with underscores.
// Also matches bare SSN without brackets.
const PLACEHOLDER_REGEX =
  /\[([A-Z][A-Z0-9_]*)_REDACTED\]|\b\d{3}-\d{2}-\d{4}\b/g;

/**
 * Canonical capture-level redaction stats written by the redact plugin.
 *
 * shape: { totalRedactions: number; byRule: Record<string, number> }
 */
export interface CaptureRedactionStats {
  totalRedactions: number;
  byRule: Record<string, number>;
}

/**
 * Read the canonical `capture.redactionStats` field when present.
 *
 * This path is primary: the redact plugin produces these counts once
 * during capture so other layers do not need to re-scan raw bodies.
 * Returns null when the field is absent or the shape is unexpected
 * (legacy captures, etc.), signaling the caller to fall back to
 * recomputation.
 */
export function getCaptureRedactionStats(
  capture: Record<string, unknown>,
): CaptureRedactionStats | null {
  const raw = capture.redactionStats;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const total =
    typeof obj.totalRedactions === "number"
      ? obj.totalRedactions
      : typeof obj.total === "number"
        ? obj.total
        : null;
  const byRule =
    typeof obj.byRule === "object" && obj.byRule !== null
      ? (obj.byRule as Record<string, unknown>)
      : null;

  if (total === null || byRule === null) {
    return null;
  }

  const normalizedByRule: Record<string, number> = {};
  for (const [rule, count] of Object.entries(byRule)) {
    if (typeof count === "number") {
      normalizedByRule[rule] = count;
    } else if (typeof count === "string") {
      const parsed = Number(count);
      if (Number.isFinite(parsed)) {
        normalizedByRule[rule] = parsed;
      }
    }
  }

  return { totalRedactions: total, byRule: normalizedByRule };
}

export function incrementRuleCount(
  byRule: Record<string, number>,
  ruleId: string,
): void {
  byRule[ruleId] = (byRule[ruleId] ?? 0) + 1;
}

/**
 * Find all redacted placeholders in a string.
 */
export function findRedactedValuesInString(
  text: string,
  matches: RedactionMatch[],
  byRule: Record<string, number>,
  path = "",
): void {
  PLACEHOLDER_REGEX.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_REGEX.exec(text)) !== null) {
    const placeholder = m[0];
    if (m[1]) {
      // [RULE_REDACTED]
      const ruleId = m[1].toLowerCase();
      // We don't have original value, but we can set placeholder as original for display.
      matches.push({ ruleId, original: placeholder, placeholder, path });
      incrementRuleCount(byRule, ruleId);
    } else if (m[0] && /\d{3}-\d{2}-\d{4}/.test(m[0])) {
      // SSN format (bare digits, no brackets)
      matches.push({
        ruleId: "ssn",
        original: m[0],
        placeholder: `[SSN_REDACTED]`,
        path,
      });
      incrementRuleCount(byRule, "ssn");
    }
  }
}

/**
 * Recursively walk a JSON object tree and find all redacted placeholders.
 *
 * @param obj - The object to traverse
 * @param currentPath - Current JSON path (empty string for root)
 * @param matches - Array to collect match details (mutated in place)
 * @param byRule - Record to collect per-rule counts (mutated in place)
 */
export function findRedactedValues(
  obj: Record<string, unknown>,
  currentPath: string,
  matches: RedactionMatch[],
  byRule: Record<string, number>,
): void {
  for (const [key, value] of Object.entries(obj)) {
    const path = currentPath ? `${currentPath}.${key}` : key;

    if (typeof value === "string") {
      findRedactedValuesInString(value, matches, byRule, path);
    } else if (value !== null && typeof value === "object") {
      if (Array.isArray(value)) {
        value.forEach((item, i) => {
          const itemPath = `${path}[${i}]`;
          if (typeof item === "string") {
            findRedactedValuesInString(item, matches, byRule, itemPath);
          } else if (item !== null && typeof item === "object") {
            findRedactedValues(
              item as Record<string, unknown>,
              itemPath,
              matches,
              byRule,
            );
          }
        });
      } else {
        findRedactedValues(
          value as Record<string, unknown>,
          path,
          matches,
          byRule,
        );
      }
    }
    // null and undefined values are skipped
  }
}

/**
 * Compute redaction counts for a single capture's raw data.
 * Scans the request body for matches. When `persistedStats` is provided,
 * aggregate totals come from the persisted capture stats; otherwise they
 * are derived from the scanned request body. Response body is never scanned
 * by this helper.
 */
export function computeCaptureRedactionCounts(
  rawData: Record<string, unknown>,
  _countResponseBody = false,
  persistedStats?: CaptureRedactionStats,
): RedactionCounts {
  const requestBody = rawData.requestBody;

  const matches: RedactionMatch[] = [];
  const byRule: Record<string, number> = {};

  if (requestBody && typeof requestBody === "object") {
    const reqCounts = countRedactionsInResponse(undefined, requestBody, false);
    matches.push(...reqCounts.matches);
    for (const [rule, count] of Object.entries(reqCounts.byRule)) {
      byRule[rule] = count;
    }
  }

  const totalRedactions = persistedStats
    ? persistedStats.totalRedactions
    : matches.length;

  if (persistedStats) {
    for (const [rule, count] of Object.entries(persistedStats.byRule)) {
      byRule[rule] = count;
    }
  }

  const requestBody = rawData.requestBody;
  const reqCounts = countRedactionsInResponse(undefined, requestBody, false);
  return {
    totalRedactions: reqCounts.totalRedactions,
    byRule: { ...reqCounts.byRule },
    matches: [...reqCounts.matches],
  };
}

/**
 * Count redactions in both the request and response bodies.
 */
export function countRedactionsInResponse(
  responseBody: string | null | undefined,
  requestBody?: unknown,
  countResponseBody = true,
): RedactionCounts {
  const matches: RedactionMatch[] = [];
  const byRule: Record<string, number> = {};

  // Matches [RULE_REDACTED] where RULE is uppercase with underscores.
  // Also matches bare SSN without brackets.
  const placeholderRegex = /\[([A-Z][A-Z0-9_]*)_REDACTED\]/g;
  const ssnRegex = /\b\d{3}-\d{2}-\d{4}\b/g;

  const searchText = (text: string): void => {
    try {
      placeholderRegex.lastIndex = 0;
      ssnRegex.lastIndex = 0;

      const allMatches: { result: string; type: string; ruleName?: string }[] =
        [];

      let m: RegExpExecArray | null;
      while ((m = placeholderRegex.exec(text)) !== null) {
        // m[0] = full match e.g. "[SSN_REDACTED]"
        // m[1] = rule name
        allMatches.push({
          result: m[0],
          type: "placeholder",
          ruleName: m[1]?.toLowerCase(),
        });
      }
      while ((m = ssnRegex.exec(text)) !== null) {
        allMatches.push({ result: m[0], type: "ssn" });
      }

      for (const match of allMatches) {
        if (match.type === "placeholder" && match.ruleName) {
          matches.push({
            ruleId: match.ruleName,
            original: match.result,
            placeholder: match.result,
            path: "",
          });
          incrementRuleCount(byRule, match.ruleName);
        } else if (match.type === "ssn") {
          matches.push({
            ruleId: "ssn",
            original: match.result,
            placeholder: `[SSN_REDACTED]`,
            path: "",
          });
          incrementRuleCount(byRule, "ssn");
        }
      }
    } catch (innerError) {
      console.error("Error searching text for redactions:", innerError);
    }
  };

  try {
    if (requestBody !== null && requestBody !== undefined) {
      searchText(JSON.stringify(requestBody));
    }
    if (responseBody && countResponseBody) {
      searchText(responseBody);
    }
  } catch (error) {
    console.error("Error counting redactions:", error);
  }

  return { totalRedactions: matches.length, byRule, matches };
}
