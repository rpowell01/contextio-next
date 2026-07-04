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
  total: number;
  byRule: Record<string, number>;
  matches: RedactionMatch[];
}

// Matches patterns like [EMAIL_REDACTED], [AWS_KEY_REDACTED], [SSN_REDACTED], etc.
// Format: [UPPERCASE_WITH_UNDERSCORES_REDACTED]  OR  bare SSN without brackets.
const PLACEHOLDER_REGEX =
  /\[([A-Z][A-Z0-9_]*)_REDACTED\]|\b\d{3}-\d{2}-\d{4}\b/g;

/**
 * Increment a counter in the byRule record.
 */
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
    const ruleId = m[1]?.toLowerCase();

    if (ruleId) {
      // Bracketed placeholder: [RULE_NAME_REDACTED]
      matches.push({
        ruleId,
        original: `[REDACTED_${ruleId.toUpperCase()}]`,
        placeholder,
        path,
      });
      incrementRuleCount(byRule, ruleId);
    } else if (m[0] && /\d{3}-\d{2}-\d{4}/.test(m[0])) {
      // SSN format (bare digits, no brackets)
      matches.push({
        ruleId: "ssn",
        original: m[0],
        placeholder: `[SSN_REDACTED_${m[0]}]`,
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
 * Counts redactions in both request and response bodies.
 */
export function computeCaptureRedactionCounts(
  rawData: Record<string, unknown>,
): RedactionCounts {
  const matches: RedactionMatch[] = [];
  const byRule: Record<string, number> = {};

  try {
    const requestBody = rawData.requestBody;
    if (requestBody && typeof requestBody === "object") {
      findRedactedValues(
        requestBody as Record<string, unknown>,
        "",
        matches,
        byRule,
      );
    }

    const responseBody = rawData.responseBody;
    if (typeof responseBody === "string") {
      try {
        const parsed = JSON.parse(responseBody);
        if (parsed && typeof parsed === "object") {
          findRedactedValues(
            parsed as Record<string, unknown>,
            "",
            matches,
            byRule,
          );
        }
      } catch {
        // Response is not valid JSON - search raw string
        findRedactedValuesInString(responseBody, matches, byRule);
      }
    }
  } catch (error) {
    console.error("Error computing redaction counts:", error);
  }

  return {
    total: matches.length,
    byRule,
    matches,
  };
}

/** Redaction counts for a capture. Counts placeholders in both the request
 * body (where redaction typically happens) and the response body. Returns
 * canonical per-rule and total counts used by the sessions API routes.
 */
export function countRedactionsInResponse(
  responseBody: string | null | undefined,
  requestBody?: unknown,
): RedactionCounts {
  const matches: RedactionMatch[] = [];
  const byRule: Record<string, number> = {};

  // Matches [RULE_NAME_REDACTED] format (e.g., [EMAIL_REDACTED], [SSN_REDACTED])
  const placeholderRegex = /\[[A-Z][A-Z0-9_]*_REDACTED\]/g;
  const ssnRegex = /\b\d{3}-\d{2}-\d{4}\b/g;

  const searchText = (text: string): void => {
    try {
      placeholderRegex.lastIndex = 0;
      ssnRegex.lastIndex = 0;

      const allMatches: { result: string; type: string }[] = [];

      let m: RegExpExecArray | null;
      while ((m = placeholderRegex.exec(text)) !== null) {
        allMatches.push({ result: m[0], type: "placeholder" });
      }
      while ((m = ssnRegex.exec(text)) !== null) {
        allMatches.push({ result: m[0], type: "ssn" });
      }

      for (const match of allMatches) {
        if (match.type === "placeholder") {
          const matchClean = match.result.replace(/[\[\]\s]/g, "");
          // Format: RULE_NAME_REDACTED
          const parts = matchClean.split("_REDACTED");
          if (parts.length === 2) {
            const ruleName = parts[0];
            if (/^[A-Z][A-Z0-9_]*$/.test(ruleName)) {
              matches.push({
                ruleId: ruleName.toLowerCase(),
                original: `[REDACTED_${ruleName.toUpperCase()}]`,
                placeholder: match.result,
                path: "",
              });
              incrementRuleCount(byRule, ruleName.toLowerCase());
            }
          }
        } else if (match.type === "ssn") {
          matches.push({
            ruleId: "ssn",
            original: match.result,
            placeholder: `[SSN_REDACTED_${match.result}]`,
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
    if (responseBody) {
      searchText(responseBody);
    }
  } catch (error) {
    console.error("Error counting redactions:", error);
  }

  return {
    total: matches.length,
    byRule,
    matches,
  };
}

