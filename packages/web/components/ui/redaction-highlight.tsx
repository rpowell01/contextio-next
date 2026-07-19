"use client";

import { useMemo } from "react";

/**
 * Shared redaction placeholder highlighting component.
 * Highlights [RULE_REDACTED] placeholders in post-redaction content.
 */
export function RedactionHighlight({
  value,
  isPreRedaction = false,
}: {
  value: string | undefined | null;
  isPreRedaction?: boolean;
}) {
  // The placeholder format: [RULE_REDACTED] where RULE is uppercase with underscores
  const redactionPattern = useMemo(
    () => /\[[A-Z][A-Z0-9_]*_REDACTED\]/g,
    []
  );

  if (isPreRedaction) {
    // For pre-redaction, the value IS the original string that was replaced.
    // Display it plainly (the dialog already isolates this substring).
    return <code className="font-mono text-xs">{value || ""}</code>;
  }

  // For post-redaction, highlight the redaction placeholders
  const safeValue = String(value || "");
  const parts = safeValue.split(redactionPattern);
  const matches = safeValue.match(redactionPattern);

  if (!matches || matches.length === 0) {
    return <code className="font-mono text-xs">{value}</code>;
  }

  return (
    <code className="font-mono text-xs">
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < matches.length && (
            <mark
              style={{
                backgroundColor: "#fef2f2",
                color: "#991b1b",
                fontWeight: "700",
                padding: "2px 6px",
                borderRadius: "4px",
                fontFamily: "inherit",
              }}
            >
              {matches[i]}
            </mark>
          )}
        </span>
      ))}
    </code>
  );
}