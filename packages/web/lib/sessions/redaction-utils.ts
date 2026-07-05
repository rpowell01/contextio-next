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
    if (m[1]) {
      // [RULE_REDACTED]
      const ruleId = m[1].toLowerCase();
      // We don't have original value, but we can set placeholder as original for display.
      matches.push({
        ruleId,
        original: placeholder,
        placeholder,
        path,
      });
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
 * Counts redactions in both request and response bodies.
 */
export function computeCaptureRedactionCounts(
   rawData: Record<string, unknown>,
 ): RedactionCounts {
   const requestBody = rawData.requestBody;
   const responseBody = rawData.responseBody;

   let totalRedactions = 0;
   const byRule: Record<string, number> = {};
   const matches: RedactionMatch[] = [];

   function addCounts(src: RedactionCounts) {
     totalRedactions += src.totalRedactions;
     for (const [rule, count] of Object.entries(src.byRule)) {
       byRule[rule] = (byRule[rule] ?? 0) + count;
     }
     matches.push(...src.matches);
   }

   if (requestBody && typeof requestBody === "object") {
     const reqCounts = countRedactionsInResponse(undefined, requestBody);
     addCounts(reqCounts);
   }
   if (typeof responseBody === "string") {
     const resCounts = countRedactionsInResponse(responseBody, undefined);
     addCounts(resCounts);
   }

   return {
     totalRedactions,
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

// Matches [RULE_REDACTED] where RULE is uppercase with underscores.
// Also matches bare SSN without brackets.
const placeholderRegex = /\[([A-Z][A-Z0-9_]*)_REDACTED\]/g;
const ssnRegex = /\b\d{3}-\d{2}-\d{4}\b/g;

const searchText = (text: string): void => {
    try {
      placeholderRegex.lastIndex = 0;
      ssnRegex.lastIndex = 0;

      const allMatches: { result: string; type: string; ruleName?: string }[] = [];

      let m: RegExpExecArray | null;
      while ((m = placeholderRegex.exec(text)) !== null) {
        // m[0] = full match e.g. "[SSN_REDACTED]"
        // m[1] = rule name
        allMatches.push({ result: m[0], type: "placeholder", ruleName: m[1]?.toLowerCase() });
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
    if (responseBody) {
      searchText(responseBody);
    }
  } catch (error) {
    console.error("Error counting redactions:", error);
  }

  return {
    totalRedactions: matches.length,
    byRule,
    matches,
  };
}

