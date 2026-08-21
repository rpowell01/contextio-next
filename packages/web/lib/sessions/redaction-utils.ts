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
  /** Line number where the redaction occurs in the capture file (1-indexed). */
  lineNumber?: number;
  /** Index of the first character of the redaction match within the line (0-indexed). */
  startCharIndex?: number;
  /** Index of the last character of the redaction match within the line (0-indexed, inclusive). */
  endCharIndex?: number;
}

/** Aggregate redaction counts per rule. */
export interface RedactionCounts {
  totalRedactions: number;
  byRule: Record<string, number>;
  matches: RedactionMatch[];
}

/**
 * Normalize a rule ID to the canonical form used in redaction placeholders.
 * Replaces non-alphanumeric/underscore chars with underscore, ensures it starts with a letter,
 * and returns lowercase for canonical consistency (scannable placeholders use uppercase).
 */
export function normalizeRuleId(id: string): string {
  let normalized = id.replace(/[^A-Za-z0-9_]/g, "_");
  if (!/^[A-Z]/i.test(normalized)) {
    normalized = "R_" + normalized;
  }
  return normalized.toLowerCase();
}

/**
 * Get the scannable (uppercase) form of a rule ID for use in redaction placeholders.
 */
export function scannableRuleId(id: string): string {
  return normalizeRuleId(id).toUpperCase();
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
 *
 * When `originalText` is provided, the whole original leaf string is used
 * as the recovered pre-redaction value (avoiding positional slicing, which
 * breaks when placeholder length differs from the original value's length).
 * Otherwise the placeholder itself is used as a fallback (legacy / non-JSON
 * bodies).
 */
export function findRedactedValuesInString(
  text: string,
  matches: RedactionMatch[],
  byRule: Record<string, number>,
  path = "",
  originalText?: string,
): void {
  PLACEHOLDER_REGEX.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_REGEX.exec(text)) !== null) {
    const placeholder = m[0];
    const original = originalText ?? placeholder;

    if (m[1]) {
      // [RULE_REDACTED]
      const ruleId = m[1].toLowerCase();
      matches.push({ ruleId, original, placeholder, path });
      incrementRuleCount(byRule, ruleId);
    } else if (placeholder && /\d{3}-\d{2}-\d{4}/.test(placeholder)) {
      // SSN format (bare digits, no brackets)
      matches.push({
        ruleId: "ssn",
        original,
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
 * When `originalObj` is provided, it is walked in parallel with the redacted
 * tree so the real pre-redaction values can be recovered at leaf strings.
 */
export function findRedactedValues(
  obj: Record<string, unknown>,
  currentPath: string,
  matches: RedactionMatch[],
  byRule: Record<string, number>,
  originalObj?: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(obj)) {
    const path = currentPath ? `${currentPath}.${key}` : key;

    if (typeof value === "string") {
      const originalStr = originalObj?.[key];
      findRedactedValuesInString(
        value,
        matches,
        byRule,
        path,
        typeof originalStr === "string" ? originalStr : undefined,
      );
    } else if (value !== null && typeof value === "object") {
      const origChild = originalObj?.[key];
      if (Array.isArray(value)) {
        const origArr = Array.isArray(origChild) ? origChild : [];
        value.forEach((item, i) => {
          const itemPath = `${path}[${i}]`;
          if (typeof item === "string") {
            const oStr = origArr[i];
            findRedactedValuesInString(
              item,
              matches,
              byRule,
              itemPath,
              typeof oStr === "string" ? oStr : undefined,
            );
} else if (item !== null && typeof item === "object") {
        const origItem = origArr[i];
        findRedactedValues(
          item as Record<string, unknown>,
          itemPath,
          matches,
          byRule,
          typeof origItem === "object" && origItem !== null
            ? (origItem as Record<string, unknown>)
            : undefined,
        );
      }
        });
      } else {
        findRedactedValues(
          value as Record<string, unknown>,
          path,
          matches,
          byRule,
          typeof origChild === "object" && origChild !== null
            ? (origChild as unknown as Record<string, unknown>)
            : undefined,
        );
      }
    }
    // null and undefined values are skipped
  }
}

/**
 * Compute redaction counts for a single capture's raw data.
 *
 * Scans the request body and optionally the response body for matches.
 * When `persistedStats` is provided, aggregate totals come from the
 * persisted capture stats; otherwise they are derived from the scanned bodies.
 *
 * When `originalRequestBody` is present, the helper uses it to recover real
 * pre-redaction values for display in the Pre-Redaction column.
 */
export function computeCaptureRedactionCounts(
  rawData: Record<string, unknown>,
  countResponseBody = false,
  persistedStats?: CaptureRedactionStats,
  originalRequestBody?: unknown,
): RedactionCounts {
  const requestBody = rawData.requestBody;
  const responseBody = rawData.responseBody;

  // `originalRequestBody` is only useful for parallel-tree traversal when
  // the body is a plain object (or nested object). Arrays/roots primitives
  // share no parallel key structure, so we fall back to regex-only in that case.
  const originalObj =
    typeof originalRequestBody === "object" &&
    originalRequestBody !== null &&
    !Array.isArray(originalRequestBody)
      ? (originalRequestBody as Record<string, unknown>)
: undefined;
 
  const matches: RedactionMatch[] = [];
  const byRule: Record<string, number> = {};

  // Scan request body
  if (requestBody && typeof requestBody === "object") {
    if (originalObj) {
      // Walk the redacted tree and original tree in parallel so leaf-string
      // matches can recover the un-redacted value from the same path.
      findRedactedValues(
        requestBody as Record<string, unknown>,
        "",
        matches,
        byRule,
        originalObj,
      );
    } else {
      const reqCounts = countRedactionsInResponse(undefined, requestBody, false);
      matches.push(...reqCounts.matches);
      for (const [rule, count] of Object.entries(reqCounts.byRule)) {
        byRule[rule] = count;
      }
    }
  }

  // Capture request-only matches for use when persistedStats is present
  const requestOnlyMatches = [...matches];

  // Scan response body if requested (for response-body matches in detail view)
  // When persistedStats is present, it already includes response body redactions in totals
  // but we still scan to get the match details for the detail view
  let resCounts: RedactionCounts | null = null;
  if (countResponseBody && responseBody && typeof responseBody === "string") {
    resCounts = countRedactionsInResponse(responseBody, undefined, true);
    matches.push(...resCounts.matches);
    // Only add response body counts to byRule if no persisted stats (legacy captures)
    if (!persistedStats) {
      for (const [rule, count] of Object.entries(resCounts.byRule)) {
        byRule[rule] = (byRule[rule] ?? 0) + count;
      }
    }
  }

  // If persisted stats provided, use them as authoritative for totals/byRule
  // but include both request and response body matches for the detail view
  // If persisted stats provided, reconcile totals/byRule with matches
  // to ensure consistency between header counts and detail matches
  if (persistedStats) {
    const allMatches = [...requestOnlyMatches, ...(resCounts?.matches ?? [])];
    const byRule: Record<string, number> = {};
    let total = 0;
    for (const m of allMatches) {
      byRule[m.ruleId] = (byRule[m.ruleId] ?? 0) + 1;
      total++;
    }
    return { totalRedactions: total, byRule, matches: allMatches };
}
  // No persisted stats - use scanned totals
  return { totalRedactions: matches.length, byRule, matches };
}

/**
 * Extract redaction matches from a capture without computing full counts.
 * Returns simplified matches with ruleId, original value, placeholder, and path.
 * Used for the redactions detail API to get individual match data on-demand.
 */
export function extractRedactionMatches(rawData: Record<string, unknown>): Array<{
  ruleId: string;
  original: string;
  placeholder: string;
  path: string;
  lineNumber?: number;
  startCharIndex?: number;
  endCharIndex?: number;
}> {
  const requestBody = rawData.requestBody;
  const responseBody = rawData.responseBody;

  // Use the existing countRedactionsInResponse which handles both request and response
  const reqCounts = countRedactionsInResponse(undefined, requestBody, false);
  const resCounts = countRedactionsInResponse(responseBody as string | undefined, undefined, true);

  return [
    ...reqCounts.matches.map(m => ({ ruleId: m.ruleId, original: m.original, placeholder: m.placeholder, path: m.path, lineNumber: m.lineNumber, startCharIndex: m.startCharIndex, endCharIndex: m.endCharIndex })),
    ...resCounts.matches.map(m => ({ ruleId: m.ruleId, original: m.original, placeholder: m.placeholder, path: m.path, lineNumber: m.lineNumber, startCharIndex: m.startCharIndex, endCharIndex: m.endCharIndex })),
  ];
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
      try {
        searchText(JSON.stringify(requestBody));
      } catch {
        // JSON.stringify threw (likely RangeError), skip
      }
    }
    if (responseBody && countResponseBody) {
      searchText(responseBody);
    }
  } catch (error) {
    console.error("Error counting redactions:", error);
  }

  return { totalRedactions: matches.length, byRule, matches };
}

/**
 * Re-apply redaction to a capture's request and/or response body.
 * This can be used to re-run redaction with different rules.
 * Always emits scannable [RULEID_REDACTED] placeholders for the scanner,
 * but tracks and returns matches with custom replacements for the API.
 */
export function applyRedaction(
  requestBody: unknown,
  responseBody: string | null | undefined,
  rules: Array<{ id: string; pattern: string; replacement: string }>,
): { requestBody: unknown; responseBody: string | null; matches: Array<{ ruleId: string; original: string; replacement: string; path: string }> } {
  const matches: Array<{ ruleId: string; original: string; replacement: string; path: string }> = [];

  // Initialize result object
  const result: { requestBody: unknown; responseBody: string | null } = {
    requestBody,
    responseBody: responseBody ?? null,
  };

  // Normalize rule ID to be scannable: [A-Z][A-Z0-9_]* 
  // Replace non-alphanumeric/underscore with underscore, ensure starts with letter
  // Returns lowercase for canonical consistency with scanner
  const normalizeRuleId = (id: string): string => {
    let normalized = id.replace(/[^A-Za-z0-9_]/g, "_");
    if (!/^[A-Z]/i.test(normalized)) {
      normalized = "R_" + normalized;
    }
    return normalized.toLowerCase();
  };

  // For scannable placeholder in body (must be UPPERCASE for scanner regex)
  const scannableRuleId = (id: string): string => normalizeRuleId(id).toUpperCase();

// Simple implementation: convert to JSON string, apply regex replacements, parse back
  // This is a simplified version - in production you'd want more robust handling
  const applyToValue = (value: unknown, path: string = ""): unknown => {
    if (typeof value === "string") {
      let redacted = value;
      for (const rule of rules) {
        try {
          const regex = new RegExp(rule.pattern, "g");
          const scannablePlaceholder = `[${scannableRuleId(rule.id)}_REDACTED]`;
          // Fixed: use rule.replacement if provided, else scannablePlaceholder
          const bodyReplacement = rule.replacement && rule.replacement.trim() !== ""
            ? rule.replacement
            : scannablePlaceholder;
          
          // Find all matches and track them with custom replacement
          let match: RegExpExecArray | null;
          while ((match = regex.exec(value)) !== null) {
            matches.push({
              ruleId: normalizeRuleId(rule.id),
              original: match[0],
              replacement: bodyReplacement,
              path: path || "root",
            });
            // Zero-width guard: prevent infinite loop on patterns like a*, \s*, ^
            if (match.index === regex.lastIndex) {
              regex.lastIndex++;
            }
          }
          
          // Write custom replacement to body when provided; scannable placeholder as fallback
          redacted = redacted.replace(regex, bodyReplacement);
        } catch {
          // Invalid regex, skip
        }
      }
      return redacted;
    }
    if (Array.isArray(value)) {
      return value.map((v, i) => applyToValue(v, `${path}[${i}]`));
    }
    if (value && typeof value === "object") {
      const obj: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        obj[key] = applyToValue(val, path ? `${path}.${key}` : key);
      }
      return obj;
    }
    return value;
  };

  result.requestBody = applyToValue(requestBody, "requestBody");
  
  if (responseBody && typeof responseBody === "string") {
    let redacted = responseBody;
    for (const rule of rules) {
      try {
        const regex = new RegExp(rule.pattern, "g");
        const scannablePlaceholder = `[${scannableRuleId(rule.id)}_REDACTED]`;
        // If user provides a custom replacement, use it in the body; otherwise use scannable placeholder
        const bodyReplacement = rule.replacement && rule.replacement.trim() !== ""
          ? rule.replacement
          : scannablePlaceholder;
        
        // Track matches with custom replacement
        let match: RegExpExecArray | null;
        while ((match = regex.exec(responseBody)) !== null) {
          matches.push({
            ruleId: normalizeRuleId(rule.id),
            original: match[0],
            replacement: bodyReplacement,
            path: "responseBody",
          });
          // Zero-width guard: prevent infinite loop on patterns like a*, \s*, ^
          if (match.index === regex.lastIndex) {
            regex.lastIndex++;
          }
        }
        
        // Write custom replacement to body when provided; scannable placeholder as fallback
        redacted = redacted.replace(regex, bodyReplacement);
      } catch {
        // Invalid regex, skip
      }
    }
    result.responseBody = redacted;
  }

  return { ...result, matches };
}
