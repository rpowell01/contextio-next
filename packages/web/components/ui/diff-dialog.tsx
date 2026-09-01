"use client";

import { useMemo, useRef, useCallback, useState, useEffect } from "react";
import { X, Code } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import { computeDiff, filterDiffWithContext, type DiffChunk } from "@/lib/diff";
import { SyntaxHighlighter } from "@/components/ui/syntax-highlighter";

const Spinner = ({ size = 24, className = "" }: { size?: number; className?: string }) => (
  <svg
    className={`animate-spin ${className}`}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle
      className="opacity-25"
      cx="12"
      cy="12"
      r="10"
      stroke="currentColor"
      strokeWidth="4"
    />
    <path
      className="opacity-75"
      fill="currentColor"
      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
    />
  </svg>
);

interface DiffDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  preContent: string;
  postContent: string;
  fullOriginal?: string;
  fullRedacted?: string;
  captureId: string;
  redactionType: string;
  provider: string;
  targetUrl: string;
  timestamp: string;
  // All matches for precise highlighting in the diff view
  matches?: Array<{
    ruleId: string;
    preValue: string;
    postValue: string;
    path: string;
    lineNumber?: number;
    startCharIndex?: number;
    endCharIndex?: number;
  }>;
  // Callback when user clicks on a redaction to add as false positive
  onAddFalsePositive?: (data: {
    value: string;
    ruleId: string;
    label: string;
    path: string;
  }) => void;
  // Optional loading state - show spinner while computing diff
  isLoading?: boolean;
  // Called when dialog is fully rendered and diff computation is complete
  onReady?: () => void;
}

type ViewMode = "diff" | "segments" | "syntax";

// Default to segments view as it's the primary view for redaction validation
const DEFAULT_VIEW_MODE: ViewMode = "segments";

function isValidJson(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function DiffDialog({
  isOpen,
  onClose,
  title,
  preContent,
  postContent,
  fullOriginal,
  fullRedacted,
  captureId,
  redactionType,
  provider,
  targetUrl,
  timestamp,
  matches,
  onAddFalsePositive,
  isLoading = false,
  onReady,
}: DiffDialogProps) {
  // Internal loading state - true while heavy computations are running
  const [isComputing, setIsComputing] = useState(false);
  const hasCalledReady = useRef(false);

  // Trigger computation state when dialog opens or content changes
  useEffect(() => {
    if (isOpen) {
      hasCalledReady.current = false;
      setIsComputing(true);
      // Allow time for the dialog to render and heavy useMemo computations to complete
      const timer = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsComputing(false);
          if (!hasCalledReady.current && onReady) {
            hasCalledReady.current = true;
            onReady();
          }
        });
      });
      return () => cancelAnimationFrame(timer);
    }
  }, [isOpen, preContent, postContent, fullOriginal, fullRedacted, matches, onReady]);

  // Use full body content for diff view if available, otherwise use match snippets
  // For segments view, we use the match snippets directly (preContent/postContent)
  // to avoid searching in full JSON bodies which gives wrong context
  const diffPreContent = fullOriginal ?? preContent;
  const diffPostContent = fullRedacted ?? postContent;
  
  // For segments view: use the individual match snippets as the base content
  // This avoids searching for match values in full JSON bodies
  const segmentsPreContent = preContent;
  const segmentsPostContent = postContent;

  // Helper to extract rule info from postValue placeholder
  // Defined as a regular function (not a hook) to avoid TDZ issues when called from useMemo
  const extractRuleInfo = (postValue: string) => {
    const redactedMatch = postValue.match(/\[([A-Z][A-Z0-9_-]*)_REDACTED\]/);
    if (redactedMatch) {
      const ruleType = redactedMatch[1];
      return {
        ruleId: ruleType.toLowerCase().replace(/-/g, "-"),
        label: ruleType.replace(/_/g, " "),
      };
    }
    const pipelineMatch = postValue.match(/\[([A-Z][A-Z0-9_-]*)_\d+\]/);
    if (pipelineMatch) {
      const ruleType = pipelineMatch[1];
      return {
        ruleId: ruleType.toLowerCase().replace(/-/g, "-"),
        label: ruleType.replace(/_/g, " "),
      };
    }
    return {
      ruleId: "unknown",
      label: postValue.replace(/[\[\]]/g, ""),
    };
  };

  // Build focused view segments around each redaction
  // Each segment shows ~100 chars context around the redaction position.
  // Uses robust position finding: first tries exact match at the correct occurrence,
  // then falls back to finding all occurrences and picking by index, then placeholder matching.
  const redactionSegments = useMemo((): Array<{
    preContext: string;
    postContext: string;
    preValue: string;
    postValue: string;
    ruleId: string;
    label: string;
    path: string;
  }> => {
    if (!matches || matches.length === 0) return [];

    const CONTEXT_LENGTH = 100;
    const segments: Array<{
      preContext: string;
      postContext: string;
      preValue: string;
      postValue: string;
      ruleId: string;
      label: string;
      path: string;
    }> = [];

    // Helper: find ALL occurrences of a substring in a string, returning start/end positions
    const findAllOccurrences = (
      str: string,
      substr: string
    ): Array<{ start: number; end: number }> => {
      const positions: Array<{ start: number; end: number }> = [];
      let start = 0;
      while (true) {
        const found = str.indexOf(substr, start);
        if (found === -1) break;
        positions.push({ start: found, end: found + substr.length });
        start = found + substr.length;
      }
      return positions;
    };

    // Helper: find all placeholder positions in post-content
    const findPlaceholderPositions = (str: string): Array<{ start: number; end: number; placeholder: string }> => {
      const positions: Array<{ start: number; end: number; placeholder: string }> = [];
      const pattern = new RegExp(`\\[[A-Z][A-Z0-9_-]*(?:_REDACTED|_\\d+)\\]`, 'g');
      let match;
      while ((match = pattern.exec(str)) !== null) {
        positions.push({ start: match.index, end: match.index + match[0].length, placeholder: match[0] });
      }
      return positions;
    };

    // Pre-compute all occurrences for each match's preValue and postValue
    // This avoids re-scanning the content for each match
    // Use segmentsPreContent/segmentsPostContent (match snippets) instead of full bodies
    const preValuePositions = new Map<string, Array<{ start: number; end: number }>>();
    const postValuePositions = new Map<string, Array<{ start: number; end: number }>>();

    for (let matchIdx = 0; matchIdx < matches.length; matchIdx++) {
      const match = matches[matchIdx];
      if (match.preValue && !preValuePositions.has(match.preValue)) {
        preValuePositions.set(match.preValue, findAllOccurrences(segmentsPreContent, match.preValue));
      }
      if (match.postValue && !postValuePositions.has(match.postValue)) {
        postValuePositions.set(match.postValue, findAllOccurrences(segmentsPostContent, match.postValue));
      }
    }

    // Pre-compute all placeholder positions in post-content
    const placeholderPositions = findPlaceholderPositions(segmentsPostContent);

    for (let matchIdx = 0; matchIdx < matches.length; matchIdx++) {
      const match = matches[matchIdx];
      if (!match.preValue || !match.postValue) continue;

      // Find position in pre-content: use the matchIdx-th occurrence of this preValue
      const prePositions = preValuePositions.get(match.preValue) || [];
      let prePos = prePositions[matchIdx];

      // If exact preValue not found at this index, try case-insensitive search for first occurrence
      if (!prePos) {
        const safePreContent = segmentsPreContent.toLowerCase();
        const safePreValue = match.preValue.toLowerCase();
        const fallbackPositions = findAllOccurrences(safePreContent, safePreValue);
        if (fallbackPositions.length > matchIdx) {
          prePos = fallbackPositions[matchIdx];
          console.debug("Using case-insensitive fallback for preValue position", {
            matchIdx,
            preValue: match.preValue?.slice(0, 50),
            fallbackIndex: prePos.start,
            preContentLen: segmentsPreContent.length
          });
        } else if (fallbackPositions.length > 0) {
          // Fall back to first occurrence if index out of bounds
          prePos = fallbackPositions[0];
        }
      }

      if (!prePos) {
        console.debug("Skipping match - couldn't find preValue position", {
          matchIdx,
          preValue: match.preValue?.slice(0, 50),
          occurrence: matchIdx + 1,
          preContentLen: segmentsPreContent.length,
          totalOccurrences: prePositions.length
        });
        continue;
      }

      // Find position in post-content: use the matchIdx-th occurrence of this postValue
      const postPositions = postValuePositions.get(match.postValue) || [];
      let postPos = postPositions[matchIdx];

      // If exact postValue not found, fall back to placeholder position matching
      if (!postPos) {
        // Use placeholder at the same match index
        if (placeholderPositions.length > matchIdx) {
          postPos = { start: placeholderPositions[matchIdx].start, end: placeholderPositions[matchIdx].end };
        } else if (placeholderPositions.length > 0) {
          // Fall back to last placeholder if index out of bounds
          postPos = { start: placeholderPositions[placeholderPositions.length - 1].start, end: placeholderPositions[placeholderPositions.length - 1].end };
        }
      }

      // If we still can't find post position, skip this match
      if (!postPos) {
        console.debug("Skipping match - couldn't find postValue/placeholder position", {
          matchIdx,
          preValue: match.preValue?.slice(0, 50),
          postValue: match.postValue?.slice(0, 50),
          placeholderCount: placeholderPositions.length
        });
        continue;
      }

      // Extract context around the redaction
      const preStart = Math.max(0, prePos.start - CONTEXT_LENGTH);
      const preEnd = Math.min(segmentsPreContent.length, prePos.end + CONTEXT_LENGTH);
      const postStart = Math.max(0, postPos.start - CONTEXT_LENGTH);
      const postEnd = Math.min(segmentsPostContent.length, postPos.end + CONTEXT_LENGTH);

      const ruleInfo = extractRuleInfo(match.postValue);

      segments.push({
        preContext: segmentsPreContent.slice(preStart, preEnd),
        postContext: segmentsPostContent.slice(postStart, postEnd),
        preValue: match.preValue,
        postValue: match.postValue,
        ruleId: match.ruleId ?? ruleInfo.ruleId,
        label: ruleInfo.label,
        path: match.path ?? "",
      });
    }

    return segments;
  }, [segmentsPreContent, segmentsPostContent, matches]);

  // Normalize post-content by replacing redaction placeholders with their pre-values.
  // This ensures the diff algorithm treats redactions as "equal" chunks instead of
  // delete+insert pairs, so both panes show the same structure with highlights.
  const normalizedPostContent = useMemo(() => {
    if (!matches || matches.length === 0) return diffPostContent;
    
    // Safety: limit total normalized content size to prevent "Invalid string length" errors
    const MAX_NORMALIZED_LENGTH = 500000; // ~500KB max
    let normalized = diffPostContent;
    
    // Early exit if content is already too large
    if (normalized.length > MAX_NORMALIZED_LENGTH) {
      console.warn("Post content too large for normalization, skipping");
      return diffPostContent;
    }

    // Sort matches by postValue length descending to avoid partial replacements
    const sortedMatches = [...matches].sort((a, b) => 
      (b.postValue?.length ?? 0) - (a.postValue?.length ?? 0)
    );

    for (const match of sortedMatches) {
      if (!match.postValue || !match.preValue) continue;

      // Safety: skip if preValue is excessively large (would bloat normalized string)
      if (match.preValue.length > 10000) {
        console.debug("Skipping large preValue normalization", { preValueLength: match.preValue.length });
        continue;
      }

      const escapedPostValue = match.postValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escapedPostValue, 'g');

      // Perform replacement with safety check
      const beforeLength = normalized.length;
      normalized = normalized.replace(regex, match.preValue);

      // Safety: abort if string grows too large
      if (normalized.length > MAX_NORMALIZED_LENGTH) {
        console.warn("Normalized content exceeded max length, reverting to original");
        return diffPostContent;
      }

      // Safety: prevent infinite replacement loops
      if (normalized.length === beforeLength && match.preValue.includes(match.postValue)) {
        console.warn("Replacement would cause infinite loop, skipping");
        continue;
      }
    }

    return normalized;
  }, [diffPostContent, matches]);

  // Also compute full diff for overview (optional, for non-redaction changes)
  const fullDiff = useMemo(() => computeDiff(diffPreContent, normalizedPostContent), [diffPreContent, normalizedPostContent]);

  // Filter diff to show only changes with context
  const { chunks: diff, hasHiddenLines } = useMemo(
    () => {
      const { chunks, hasHiddenLines } = filterDiffWithContext(fullDiff, 3);
      
      // Enrich diff chunks with redaction metadata for highlighting
      // This maps redaction positions from matches to diff chunks
      const enrichedChunks = chunks.map((chunk) => {
        if (!matches || matches.length === 0) return chunk;
        
        // Check if any match falls within this chunk's content
        const chunkMatches = matches.filter((match) => {
          if (!match.preValue || !match.postValue) return false;
          // Check if this chunk's value contains the preValue (left) or postValue (right)
          return chunk.value.includes(match.preValue) || chunk.value.includes(match.postValue);
        });
        
        if (chunkMatches.length > 0) {
          return {
            ...chunk,
            _redactionMatches: chunkMatches,
          };
        }
        return chunk;
      });
      
      return { chunks: enrichedChunks, hasHiddenLines };
    },
    [fullDiff, matches],
  );

  // Line rendering constants and helpers for full diff view
  const lineStyle = {
    padding: "2px 8px",
    borderRadius: "4px",
    minHeight: "1.25rem",
  } as const;

  // Threshold for truncating long lines (chars)
  const TRUNCATE_THRESHOLD = 500;
  // Context to show around redactions (chars)
  const CONTEXT_CHARS = 200;

  // Pre-split content into lines for efficient line extraction
  const preContentLines = useMemo(() => diffPreContent.split("\n"), [diffPreContent]);
  const postContentLines = useMemo(() => diffPostContent.split("\n"), [diffPostContent]);

  // Get the actual line content for a pane from the original (non-normalized) content
  // Uses line numbers from diff chunks (oldLineNum for left/pre, newLineNum for right/post)
  function getActualLineContent(chunk: DiffChunk, isLeft: boolean): string {
    const lines = isLeft ? preContentLines : postContentLines;
    const lineNum = isLeft ? chunk.oldLineNum : chunk.newLineNum;
    if (lineNum !== undefined && lineNum > 0 && lineNum <= lines.length) {
      return lines[lineNum - 1]; // Convert 1-indexed to 0-indexed
    }
    // Fallback to chunk value if line number not available
    return chunk.value ?? "";
  }

  // Truncate a long line to show context around redactions
  // Returns { value: truncated string, isTruncated: boolean }
  function truncateLongLine(
    value: string,
    isPre: boolean,
    matches: Array<{ preValue: string; postValue: string }> | undefined
  ): { value: string; isTruncated: boolean } {
    // Only truncate if longer than threshold
    if (value.length <= TRUNCATE_THRESHOLD) {
      return { value, isTruncated: false };
    }

    // Find all redaction positions in the value
    const positions: Array<{ start: number; end: number }> = [];

    if (isPre && matches && matches.length > 0) {
      // For left pane: find exact preValues
      for (const match of matches) {
        if (match.preValue) {
          let searchStart = 0;
          const preValue = match.preValue;
          while (true) {
            const idx = value.indexOf(preValue, searchStart);
            if (idx === -1) break;
            positions.push({ start: idx, end: idx + preValue.length });
            // Fix: advance past the matched substring to avoid overlapping/infinite loops
            searchStart = idx + preValue.length;
          }
        }
      }

      // If no exact preValue matches found (common when preValue is the entire
      // original leaf string rather than just the matched substring), fall back
      // to searching for common sensitive patterns that correspond to the
      // placeholder types in postValue.
      if (positions.length === 0) {
        for (const match of matches) {
          if (match.postValue) {
            // Extract rule type from placeholder (e.g., "API_KEY" from "[API_KEY_REDACTED]")
            const ruleMatch = match.postValue.match(/\[([A-Z][A-Z0-9_]*)_REDACTED\]/);
            if (ruleMatch) {
              const ruleType = ruleMatch[1];
              // Search for patterns associated with this rule type
              const patterns = getPatternsForRuleType(ruleType);
              for (const pattern of patterns) {
                let searchStart = 0;
                while (true) {
                  const idx = value.indexOf(pattern, searchStart);
                  if (idx === -1) break;
                  positions.push({ start: idx, end: idx + pattern.length });
                  searchStart = idx + pattern.length;
                }
              }
            }
          }
        }
      }
    } else if (!isPre && matches && matches.length > 0) {
      // For right pane: find postValues (placeholders)
      for (const match of matches) {
        if (match.postValue) {
          let searchStart = 0;
          const postValue = match.postValue;
          while (true) {
            const idx = value.indexOf(postValue, searchStart);
            if (idx === -1) break;
            positions.push({ start: idx, end: idx + postValue.length });
            searchStart = idx + postValue.length;
          }
        }
      }
    } else {
      // Fallback: find [PLACEHOLDER] patterns in either pane (both [RULE_REDACTED] and [RULE_N] formats)
      const placeholderPattern = /\[[A-Z][A-Z0-9_]*(?:_REDACTED|_\d+)\]/g;
      let match;
      while ((match = placeholderPattern.exec(value)) !== null) {
        positions.push({ start: match.index, end: match.index + match[0].length });
      }
    }

    // If no redaction positions found, use symmetric fallback for both panes
    // Show first and last CONTEXT_CHARS to keep pane sizes consistent
    if (positions.length === 0) {
      const trunc = CONTEXT_CHARS;
      let truncated = value.slice(0, trunc) + "…" + value.slice(-trunc);
      return { value: truncated, isTruncated: true };
    }

    // Sort positions by start
    positions.sort((a, b) => a.start - b.start);

    // Calculate truncation bounds
    const firstRedactionStart = positions[0].start;
    const lastRedactionEnd = positions[positions.length - 1].end;

    const truncateStart = Math.max(0, firstRedactionStart - CONTEXT_CHARS);
    const truncateEnd = Math.min(value.length, lastRedactionEnd + CONTEXT_CHARS);

    // If the truncation window covers most of the string, don't truncate
    if (truncateStart === 0 && truncateEnd === value.length) {
      return { value, isTruncated: false };
    }

    let truncated = "";
    if (truncateStart > 0) {
      truncated += "…";
    }
    truncated += value.slice(truncateStart, truncateEnd);
    if (truncateEnd < value.length) {
      truncated += "…";
    }

    return { value: truncated, isTruncated: true };
  }

  // Return common sensitive patterns for a given rule type
  function getPatternsForRuleType(ruleType: string): string[] {
    const patterns: Record<string, string[]> = {
      // Rule-based redaction patterns (from presets)
      API_KEY: ["sk_", "pk_", "rk_", "ak_", "sk-", "pk-", "rk-", "ak-", "Bearer ", "token="],
      API_KEY_PREFIXED: ["sk_", "pk_", "rk_", "ak_", "sk-", "pk-", "rk-", "ak-", "api-", "key-", "token-"],
      AUTH: ["Bearer ", "Authorization", "auth", "password", "secret", "token"],
      AUTH_HEADER: ["authorization:", "bearer "],
      BEARER_TOKEN: ["bearer "],
      SECRET: ["secret", "password", "key", "token"],
      TOKEN: ["token", "Bearer ", "access_token", "refresh_token"],
      PASSWORD: ["password", "passwd", "pwd"],
      PRIVATE_KEY: ["-----BEGIN", "PRIVATE KEY-----"],
      AWS_KEY: ["AKIA", "aws_key", "aws_secret"],
      AWS_SECRET: ["aws_secret", "secret_key"],
      GITHUB_TOKEN: ["ghp_", "ghs_", "github"],
      ANTHROPIC_KEY: ["sk-ant-", "anthropic"],
      OPENAI_KEY: ["sk-", "openai"],
      GCP_API_KEY: ["gcp", "google"],
      GCP_SERVICE_ACCOUNT: ["service_account", "gcp"],
      GITLAB_TOKEN: ["glpat-", "gitlab"],
      JWT: ["eyJ", "jwt"],
      STRIPE_KEY: ["sk_live_", "rk_live_", "stripe"],
      SLACK_TOKEN: ["xoxb-", "xoxp-", "slack"],
      HUGGINGFACE_TOKEN: ["hf_", "huggingface"],
      DATABRICKS_TOKEN: ["dapi", "databricks"],
      NPM_TOKEN: ["npm_", "npm"],
      PYPI_TOKEN: ["pypi-", "pypi"],
      VAULT_TOKEN: ["vault", "hvs."],
      SENDGRID_TOKEN: ["SG.", "sendgrid"],
      NVIDIA_KEY: ["nvapi-", "nvidia"],
      OPENROUTER_KEY: ["sk-or-", "openrouter"],
      KILO_KEY: ["kilo", "kilo_"],
      GENERIC_SECRET: ["secret", "api_key", "token"],

      // PII preset patterns
      EMAIL: ["@", ".com", ".org", ".net", ".io", ".co", ".edu", ".gov"],
      SSN: [],
      // CREDIT_CARD: [] - defined below with Presidio entity type patterns
      PHONE_US: ["tel:", "phone", "+1", "(", "mobile", "cell"],
      PHONE_EU: ["tel:", "phone", "+", "mobile", "cell"],
      IBAN: ["iban", "bank", "account"],

      // Strict preset patterns
      IPV4: ["ip", "address", "ipv4"],
      IPV6: ["ip", "address", "ipv6"],
      DOB: ["birth", "birthday", "dob", "born", "age"],
      BSN_DUTCH: ["bsn", "burgerservice", "sofinummer", "dutch", "netherlands"],
      NI_NUMBER_UK: ["ni number", "national insurance", "nino", "uk", "british"],
      PASSPORT_NUMBER: ["passport", "paspoort", "passeport", "reisepass"],

      // Presidio detector entity types (from @siddicky/anonymizerts)
      // These are the entity types detected by Presidio when using "llm", "hybrid", or "auto" modes
      PERSON: ["person", "name", "mr.", "mrs.", "ms.", "dr.", "prof."],
      LOCATION: ["location", "address", "city", "street", "avenue", "blvd", "road", "drive", "lane", "court", "place"],
      ORGANIZATION: ["organization", "company", "corp", "inc", "llc", "ltd", "gmbh", "org", "institution", "university", "hospital", "bank"],
      EMAIL_ADDRESS: ["@", ".com", ".org", ".net", ".io", "email", "e-mail", "mail"],
      PHONE_NUMBER: ["tel:", "phone", "+1", "(", "mobile", "cell", "fax", "contact", "number"],
      CREDIT_CARD: ["credit", "card", "visa", "mastercard", "amex", "discover", "payment", "billing", "cc"],
      US_SSN: ["ssn", "social security", "social-security", "tax", "taxpayer"],
      IP_ADDRESS: ["ip", "address", "ipv4", "ipv6"],
      URL: ["http://", "https://", "url", "link", "www."],
      DATE_TIME: ["date", "time", "datetime", "timestamp", "born", "birth", "schedule", "meeting", "appointment"],

      // Pipeline detector (hybrid mode) - when ruleId is "pipeline", we infer from postValue
      // Include all Presidio entity type patterns since pipeline can detect any of them
      PIPELINE: [
        "person", "name", "mr.", "mrs.", "ms.", "dr.", "prof.", // PERSON
        "location", "address", "city", "street", "avenue", "blvd", "road", "drive", "lane", "court", "place", // LOCATION
        "organization", "company", "corp", "inc", "llc", "ltd", "gmbh", "org", "institution", "university", "hospital", "bank", // ORGANIZATION
        "@", ".com", ".org", ".net", ".io", "email", "e-mail", "mail", // EMAIL_ADDRESS
        "tel:", "phone", "+1", "(", "mobile", "cell", "fax", "contact", "number", // PHONE_NUMBER
        "credit", "card", "visa", "mastercard", "amex", "discover", "payment", "billing", "cc", // CREDIT_CARD
        "ssn", "social security", "social-security", "tax", "taxpayer", // US_SSN
        "ip", "address", "ipv4", "ipv6", // IP_ADDRESS
        "http://", "https://", "url", "link", "www.", // URL
        "date", "time", "datetime", "timestamp", "born", "birth", "schedule", "meeting", "appointment", // DATE_TIME
      ],
    };
    return patterns[ruleType] ?? [];
  }

  // Render a single diff line with redaction highlighting and data attributes for navigation
  const renderLine = useCallback((item: DiffChunk, side: "left" | "right", diffIndex: number) => {
    const isLeft = side === "left";
    const showLine = isLeft ? item.type !== "insert" : item.type !== "delete";

    if (!showLine) {
      return <div style={lineStyle} data-diff-index={diffIndex} />;
    }

    const lineNum = isLeft ? item.oldLineNum : item.newLineNum;
    const lineClass = `font-mono text-xs whitespace-pre-wrap ${
      isLeft
        ? item.type === "delete"
          ? "diff-line-delete"
          : item.type === "insert"
          ? "diff-line-insert"
          : "bg-transparent"
        : item.type === "delete"
        ? "diff-line-delete"
        : item.type === "insert"
        ? "diff-line-insert"
        : "bg-transparent"
    }`;

    // For right pane (post-redaction), use RedactionHighlight without isPre to highlight placeholders
    // For left pane (pre-redaction), use RedactionHighlight with isPre=true to highlight exact pre-values
    // Both modes now pass unified data to onAddFalsePositive: {value, ruleId, label, path}
    // Truncate very long lines to show context around redactions
    // Use actual content from original/redacted bodies (not normalized) for correct display
    const rawValue = getActualLineContent(item, isLeft);
    const { value: displayValue } = truncateLongLine(rawValue, isLeft, matches ?? []);

    // Convert matches to include ruleId and path for the click handler
    const enhancedMatches = (matches ?? []).map(m => ({
      preValue: m.preValue,
      postValue: m.postValue,
      ruleId: m.ruleId,
      path: m.path,
    }));

    // Use enriched chunk's redaction matches if available, otherwise fall back to all matches
    const chunkRedactionMatches = (item as any)._redactionMatches || [];
    const effectiveMatches = chunkRedactionMatches.length > 0 ? chunkRedactionMatches : enhancedMatches;

    const renderValue = isLeft
      ? <RedactionHighlight value={displayValue} isPre matches={effectiveMatches} onAddFalsePositive={onAddFalsePositive} />
      : <RedactionHighlight value={displayValue} isPre={false} matches={effectiveMatches} onAddFalsePositive={onAddFalsePositive} />;

    return (
      <div
        className={lineClass}
        style={lineStyle}
        data-diff-index={diffIndex}
      >
        <span className="text-muted-foreground mr-2 select-none" style={{ width: "3rem", display: "inline-block", textAlign: "right" }}>
          {lineNum ?? ""}
        </span>
        {renderValue}
      </div>
    );
  }, [matches, onAddFalsePositive]);

  const renderDiffPane = useCallback((diffChunks: typeof diff, side: "left" | "right") => (
    <div className="font-mono text-xs">
      {diffChunks.map((chunk, idx) => (
        <div key={idx}>{renderLine(chunk, side, idx)}</div>
      ))}
    </div>
  ), [diff, renderLine]);

  // Detect if content is valid JSON for syntax highlighting
  const isJsonContent = useMemo(() => {
    return isValidJson(diffPreContent) || isValidJson(diffPostContent);
  }, [diffPreContent, diffPostContent]);

  // View mode state - default to segments view (focused redaction segments)
  const [viewMode, setViewMode] = useState<ViewMode>(DEFAULT_VIEW_MODE);

  // Synchronized scrolling state - separate refs for each view mode
  const leftPaneDiffRef = useRef<HTMLDivElement>(null);
  const rightPaneDiffRef = useRef<HTMLDivElement>(null);
  const leftPaneSyntaxRef = useRef<HTMLDivElement>(null);
  const rightPaneSyntaxRef = useRef<HTMLDivElement>(null);
  const isScrollingRef = useRef(false);

  // Parse redaction types from the comma-separated string like "[RULE_REDACTED] (count), [RULE2_REDACTED] (count)"
  // Also handles pipeline detector format "[RULE_N] (count)" where N is a sequence number
  // Supports hyphens in rule names like "API-KEY-PREFIXED_REDACTED"
  const rawRedactionTypes = useMemo(() => {
    if (!redactionType) return [];
    // Match both [RULE_REDACTED] (count) and [RULE_N] (count) formats
    const matches = redactionType.match(/\[([A-Z][A-Z0-9_-]*(?:_REDACTED|_\d+))\]\s*\((\d+)\)/g);
    if (!matches) return [];
    return matches.map((m) => {
      const ruleMatch = m.match(/\[([A-Z][A-Z0-9_-]*(?:_REDACTED|_\d+))\]/);
      const countMatch = m.match(/\((\d+)\)/);
      let apiType = ruleMatch ? ruleMatch[1] : "";
      // Normalize pipeline format [PIPELINE_N] -> PIPELINE_REDACTED for display consistency
      if (apiType.match(/_\d+$/)) {
        apiType = apiType.replace(/_\d+$/, "_REDACTED");
      }
      return {
        apiType,
        count: countMatch ? parseInt(countMatch[1], 10) : 0,
        display: m,
      };
    }).filter(r => r.apiType);
  }, [redactionType]);

  // Extract actual placeholder types (e.g., [API_KEY_REDACTED], [PIPELINE_1]) from post-redaction content
  const placeholderTypes = useMemo(() => {
    const types = new Set<string>();
    // Check both pre and post content for placeholders
    const allContent = [diffPreContent, diffPostContent].filter(Boolean).join("\n");
    // Match both [RULE_REDACTED] and [RULE_N] formats
    const matches = allContent.match(/\[([A-Z][A-Z0-9_]*(?:_REDACTED|_\d+))\]/g);
    if (matches) {
      matches.forEach(m => {
        const t = m.match(/\[([A-Z][A-Z0-9_]*(?:_REDACTED|_\d+))\]/);
        if (t) {
          let type = t[1];
          // Normalize pipeline format [PIPELINE_N] -> PIPELINE_REDACTED
          if (type.match(/_\d+$/)) {
            type = type.replace(/_\d+$/, "_REDACTED");
          }
          types.add(type);
        }
      });
    }
    return Array.from(types);
  }, [diffPreContent, diffPostContent]);

  // Map API type to placeholder type for scrolling
  // e.g., API-KEY-PREFIXED_REDACTED -> API_KEY_REDACTED
  const apiToPlaceholderMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const apiType of rawRedactionTypes.map(r => r.apiType)) {
      // Try exact match first
      if (placeholderTypes.includes(apiType)) {
        map.set(apiType, apiType);
        continue;
      }
      // Try normalized: remove hyphens, remove suffixes like -PREFIXED, -US, etc.
      const normalized = apiType
        .replace(/-/g, "_")
        .replace(/_PREFIXED(_REDACTED)$/, "$1")
        .replace(/_US(_REDACTED)$/, "$1");
      if (placeholderTypes.includes(normalized)) {
        map.set(apiType, normalized);
        continue;
      }
      // Fallback: find placeholder that starts with the same base (e.g., API_KEY for API-KEY-PREFIXED)
      const base = apiType.split("_")[0].replace(/-/g, "_");
      const match = placeholderTypes.find(p => p.startsWith(base + "_"));
      if (match) {
        map.set(apiType, match);
      } else {
        map.set(apiType, apiType); // fallback to itself
      }
    }
    return map;
  }, [rawRedactionTypes, placeholderTypes]);

  // Build final redaction types with placeholder type for scrolling
  const redactionTypes = useMemo(() => {
    return rawRedactionTypes.map(r => ({
      ...r,
      placeholderType: apiToPlaceholderMap.get(r.apiType) || r.apiType,
    }));
  }, [rawRedactionTypes, apiToPlaceholderMap]);

  // Helper to scroll a pane to center a target element both vertically and horizontally
  const scrollToTarget = useCallback((pane: HTMLDivElement, target: HTMLElement) => {
    if (!pane || !target) return;

    // Get bounding rects
    const paneRect = pane.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();

    // Vertical: use scrollIntoView for smooth block scrolling
    target.scrollIntoView({ behavior: "smooth", block: "center" });

    // Horizontal: manually calculate scrollLeft to center the target
    // targetRect.left is relative to viewport, paneRect.left is viewport-relative
    // We need: pane.scrollLeft + (targetRect.left - paneRect.left) - (paneRect.width - targetRect.width) / 2
    const targetCenterOffset = targetRect.left - paneRect.left;
    const paneCenterOffset = paneRect.width / 2;
    const targetCenterInPane = targetCenterOffset + targetRect.width / 2;
    const desiredScrollLeft = pane.scrollLeft + targetCenterInPane - paneCenterOffset;

    // Apply with smooth animation
    pane.scrollTo({
      left: desiredScrollLeft,
      behavior: "smooth",
    });

    // Highlight animation
    target.classList.add("scroll-target-highlight");
    setTimeout(() => target.classList.remove("scroll-target-highlight"), 2000);
  }, []);

  // Scroll to a specific redaction type in both panes
  const scrollToRedactionType = useCallback((apiType: string) => {
    const panes = viewMode === "diff"
      ? [leftPaneDiffRef.current, rightPaneDiffRef.current]
      : [leftPaneSyntaxRef.current, rightPaneSyntaxRef.current];

    const [leftPane, rightPane] = panes;
    if (!leftPane || !rightPane) return;

    // Look up the placeholder type for this API type
    const placeholderType = apiToPlaceholderMap.get(apiType) || apiType;
    const kebabType = placeholderType.toLowerCase().replace(/_/g, "-");

    // Find the first matching redaction in the RIGHT pane (post-redaction, where placeholders are)
    const rightTarget = rightPane.querySelector(`mark[data-redaction="${kebabType}"]`);
    if (!rightTarget) {
      // Fallback: just find any in left pane
      const leftTarget = leftPane.querySelector(`mark[data-redaction="${kebabType}"]`);
      if (leftTarget) {
        scrollToTarget(leftPane, leftTarget as HTMLElement);
      }
      return;
    }

    // Get the match index from the right pane
    const matchIndex = rightTarget.getAttribute("data-match-index");
    if (matchIndex === null) {
      // No match index, just scroll both to their first found elements
      scrollToTarget(rightPane, rightTarget as HTMLElement);

      const leftTarget = leftPane.querySelector(`mark[data-redaction="${kebabType}"]`);
      if (leftTarget) {
        scrollToTarget(leftPane, leftTarget as HTMLElement);
      }
      return;
    }

    // Scroll RIGHT pane to the found element
    scrollToTarget(rightPane, rightTarget as HTMLElement);

    // Find and scroll LEFT pane to the element with the SAME match index
    const leftTarget = leftPane.querySelector(`mark[data-match-index="${matchIndex}"]`);
    if (leftTarget) {
      scrollToTarget(leftPane, leftTarget as HTMLElement);
    } else {
      // Fallback: try to find by data-redaction in left pane
      const leftFallback = leftPane.querySelector(`mark[data-redaction="${kebabType}"]`);
      if (leftFallback) {
        scrollToTarget(leftPane, leftFallback as HTMLElement);
      }
    }
  }, [viewMode, apiToPlaceholderMap, scrollToTarget]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>, source: "left" | "right") => {
    if (isScrollingRef.current) return;
    isScrollingRef.current = true;

    const sourcePane = e.currentTarget;
    const targetPane = viewMode === "diff"
      ? (source === "left" ? rightPaneDiffRef.current : leftPaneDiffRef.current)
      : (source === "left" ? rightPaneSyntaxRef.current : leftPaneSyntaxRef.current);

    if (!targetPane) {
      requestAnimationFrame(() => { isScrollingRef.current = false; });
      return;
    }

    // Find the first visible line in source pane by checking data-diff-index
    const sourceLines = sourcePane.querySelectorAll('[data-diff-index]');
    let firstVisibleIndex = -1;
    const sourceRect = sourcePane.getBoundingClientRect();

    for (const line of sourceLines) {
      const lineRect = line.getBoundingClientRect();
      // Check if line is visible in the scroll viewport (at least 50% visible or top is at/above viewport top)
      if (lineRect.top < sourceRect.bottom && lineRect.bottom > sourceRect.top) {
        const indexAttr = line.getAttribute('data-diff-index');
        if (indexAttr !== null) {
          firstVisibleIndex = parseInt(indexAttr, 10);
          break;
        }
      }
    }

    if (firstVisibleIndex >= 0) {
      // Find the corresponding line in target pane and scroll to it
      const targetLine = targetPane.querySelector(`[data-diff-index="${firstVisibleIndex}"]`);
      if (targetLine) {
        targetLine.scrollIntoView({ behavior: "auto", block: "start", inline: "nearest" });
      }
    }

    requestAnimationFrame(() => { isScrollingRef.current = false; });
  }, [viewMode]);

  // Highlights redaction placeholders in text.
  // For pre-redaction (isPre=true): highlights the exact original values from matches
  // For post-redaction (isPre=false): highlights the [RULE_REDACTED] placeholders
  const RedactionHighlight = useCallback(({
    value,
    isPre = false,
    matches = [],
    onAddFalsePositive,
  }: {
    value: string | undefined | null;
    isPre?: boolean;
    matches?: Array<{ preValue: string; postValue: string; ruleId?: string; path?: string }>;
    onAddFalsePositive?: (data: { value: string; ruleId: string; label: string; path: string }) => void;
  }) => {
    // Match both [RULE_REDACTED] and [RULE_N] formats (pipeline detector)
    const placeholderPattern = /\[[A-Z][A-Z0-9_]*(?:_REDACTED|_\d+)\]/g;
    const safeValue = String(value || "");

  if (isPre && matches.length > 0) {
      // Left pane: highlight pre-values using exact string matching.
      // Each match's preValue is highlighted, and clicking passes the original
      // pre-redaction value to onAddFalsePositive for unified false positive handling.

      const result: (string | React.ReactElement)[] = [];
      let lastIndex = 0;

      for (let matchIdx = 0; matchIdx < matches.length; matchIdx++) {
        const correspondingMatch = matches[matchIdx];
        const preValue = correspondingMatch?.preValue ?? "";
        const postValue = correspondingMatch?.postValue ?? "";

        if (!preValue || preValue.length === 0) continue;

        // Find this preValue in the left pane content starting from lastIndex
        // Try exact match first, then fall back to case-insensitive search
        let matchIndex = safeValue.indexOf(preValue, lastIndex);
        if (matchIndex === -1) {
          // Fall back to case-insensitive search
          const safeLowerValue = safeValue.toLowerCase();
          const safeLowerPreValue = preValue.toLowerCase();
          const fallbackIndex = safeLowerValue.indexOf(safeLowerPreValue, lastIndex);
          if (fallbackIndex !== -1) {
            matchIndex = fallbackIndex;
            console.debug("Using case-insensitive fallback for preValue highlighting", {
              matchIdx: matchIdx,
              preValue: preValue?.slice(0, 50),
              fallbackIndex
            });
          }
        }

        if (matchIndex === -1) {
          // PreValue not found in this fragment
          // Skip to next match
          continue;
        }

        if (matchIndex > lastIndex) {
          result.push(safeValue.slice(lastIndex, matchIndex));
        }

        const ruleInfo = extractRuleInfo(postValue);
        const ruleId = correspondingMatch?.ruleId ?? ruleInfo.ruleId;
        const path = correspondingMatch?.path ?? "";

        const handleClick = () => {
          if (onAddFalsePositive) {
            onAddFalsePositive({ value: preValue, ruleId, label: ruleInfo.label, path });
          }
        };

        result.push(
          <mark
            key={`exact-${matchIdx}`}
            className="redaction-placeholder pre-redaction-highlight cursor-pointer hover:bg-primary/10"
            data-redaction={postValue.replace(/[\[\]]/g, "").toLowerCase().replace(/_/g, "-").replace(/-\d+$/, "-redacted")}
            data-match-index={matchIdx}
            onClick={handleClick}
            title="Click to add as false positive"
          >
            {preValue}
          </mark>
        );

        lastIndex = matchIndex + preValue.length;
      }

      if (lastIndex < safeValue.length) {
        result.push(safeValue.slice(lastIndex));
      }

      // Only return highlighted content if we found at least one match
      if (result.some(r => typeof r === 'object')) {
        return <code className="font-mono text-xs">{result}</code>;
      }
    }

    // Right pane (post-redaction, isPre=false): render [RULE_REDACTED] placeholder tokens
    // with click handlers so users can add them as false positives.
    if (!isPre) {
      // Reset global regex state before using it
      placeholderPattern.lastIndex = 0;
      const partsPost = safeValue.split(placeholderPattern);
      placeholderPattern.lastIndex = 0;
      const placeholderMatches = safeValue.match(placeholderPattern);

      if (placeholderMatches && placeholderMatches.length > 0) {
        const placeholderOccurrenceCount = new Map<string, number>();

        function normalizePlaceholderForDataAttr(placeholder: string): string {
          let n = placeholder.replace(/[\[\]]/g, "").toLowerCase().replace(/_/g, "-");
          return n.replace(/-\d+$/, "-redacted");
        }

        return (
          <code className="font-mono text-xs">
            {partsPost.map((part, i) => (
              <span key={i}>
                {part}
                {i < placeholderMatches.length && (() => {
                  const placeholder = placeholderMatches[i];
                  const normalizedPlaceholder = normalizePlaceholderForDataAttr(placeholder);
                  // Compute occurrence index for this placeholder type (0, 1, 2...)
                  const occurrenceCount = placeholderOccurrenceCount.get(placeholder) || 0;
                  placeholderOccurrenceCount.set(placeholder, occurrenceCount + 1);
                  const matchIdx = occurrenceCount;

                  // Find the corresponding match from the matches array using matchIdx
                  const correspondingMatch = matches?.[matchIdx];
                  const ruleInfo = extractRuleInfo(placeholder);
                  const ruleId = correspondingMatch?.ruleId ?? ruleInfo.ruleId;
                  const path = correspondingMatch?.path ?? "";
                  // Use the original pre-value (actual content from the redaction metadata)
                  const value = correspondingMatch?.preValue ?? placeholder.replace(/[\[\]]/g, "");

                  return (
                    <mark
                      key={`ph-${i}`}
                      className="redaction-placeholder cursor-pointer hover:bg-primary/10"
                      data-redaction={normalizedPlaceholder}
                      data-match-index={matchIdx}
                      onClick={() => {
                        if (onAddFalsePositive) {
                          onAddFalsePositive({ value, ruleId, label: ruleInfo.label, path });
                        }
                      }}
                      title="Click to add as false positive"
                    >
                      {placeholder}
                    </mark>
                  );
                })()}
              </span>
            ))}
          </code>
        );
      }
    }

    // Fallback: generic PII patterns for both panes
    // Includes patterns for both rule-based redaction and Presidio detector entity types
    const piiPatterns = [
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, // email
      /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
      /\b(?:SK|AK|RK|sk|ak|rk)_[A-Za-z0-9]{32,}\b/g, // API keys
      /\b(?:sk|pk|api|key|token)[-_][A-Za-z0-9_-]{20,}\b/g, // API key prefixed
      /\bBearer\s+[A-Za-z0-9._-]+\b/g, // Bearer tokens
      /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._-]+\b/gi, // Authorization header
      /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, // phone US
      /\+\d{1,3}[\s\-\.]?(?:\d[\s\-\.]?){8,11}\b/g, // phone EU
      /\b(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD)[_-]?[=:]\s*["']?[A-Za-z0-9+/=_-]{20,}["']?/gi, // key=value
      /\b[A-Z]{2}\d{2}(?:[\s]?[A-Z0-9]){11,26}\b/g, // IBAN
      /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{1,7}\b/g, // credit card
      /\b\d{9}\b/g, // BSN
      /\b[A-CEGHJ-PR-TW-Z]{2}[\s]?\d{2}[\s]?\d{2}[\s]?\d{2}[\s]?[A-D\s]\b/g, // NI number
      /\b[A-Z]{1,2}\d{6,9}\b/g, // Passport
      /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, // IPv4
      /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g, // IPv6
      /\b(?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\d|3[01])[-/](?:19|20)\d{2}\b/g, // Date of birth
      /\b(?:https?:\/\/|www\.)[^\s]+\b/g, // URL
      /\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b/g, // Date
      /\b\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}\b/g, // ISO datetime
    ];

    const parts: (string | React.ReactElement)[] = [safeValue];
    let piiMatchIdx = 0;
    for (const pattern of piiPatterns) {
      const newParts: (string | React.ReactElement)[] = [];
      for (const part of parts) {
        if (typeof part === "string") {
          const matches = [...part.matchAll(pattern)];
          if (matches.length === 0) {
            newParts.push(part);
            continue;
          }
          let lastIndex = 0;
          for (const match of matches) {
            const matchIndex = match.index ?? 0;
            if (matchIndex > lastIndex) {
              newParts.push(part.slice(lastIndex, matchIndex));
            }
            let ruleId = "unknown";
            let label = "Unknown";
            const matchStr = match[0];
            if (matchStr.includes("@")) { ruleId = "email"; label = "Email"; }
            else if (/^\d{3}-\d{2}-\d{4}$/.test(matchStr)) { ruleId = "ssn"; label = "SSN"; }
            else if (/^(?:SK|AK|RK|sk|ak|rk)_/.test(matchStr)) { ruleId = "api-key-prefixed"; label = "API Key"; }
            else if (/^(?:sk|pk|api|key|token)[-_]/.test(matchStr)) { ruleId = "api-key-prefixed"; label = "API Key"; }
            else if (/^Bearer\s+/.test(matchStr)) { ruleId = "bearer-token"; label = "Bearer Token"; }
            else if (/^Authorization\s*:\s*Bearer\s+/i.test(matchStr)) { ruleId = "authorization-header"; label = "Auth Header"; }
            else if (/\d{3}[-.]?\d{3}[-.]?\d{4}/.test(matchStr)) { ruleId = "phone-us"; label = "Phone"; }
            else if (/\+\d{1,3}[\s\-\.]?/.test(matchStr)) { ruleId = "phone-eu"; label = "Phone"; }
            else if (/(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD)[_-]?[=:]\s*["']?[A-Za-z0-9+/=_-]{20,}["']?/i.test(matchStr)) { ruleId = "credential_generic"; label = "Secret"; }
            else if (/^[A-Z]{2}\d{2}/.test(matchStr)) { ruleId = "iban"; label = "IBAN"; }
            else if (/^(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))/.test(matchStr)) { ruleId = "credit-card"; label = "Credit Card"; }
            else if (/^\d{9}$/.test(matchStr)) { ruleId = "bsn-dutch"; label = "BSN"; }
            else if (/^[A-CEGHJ-PR-TW-Z]{2}[\s]?\d{2}/.test(matchStr)) { ruleId = "ni-number-uk"; label = "NI Number"; }
            else if (/^[A-Z]{1,2}\d{6,9}$/.test(matchStr)) { ruleId = "passport-number"; label = "Passport"; }
            else if (/^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}/.test(matchStr)) { ruleId = "ipv4"; label = "IPv4"; }
            else if (/^(?:[0-9a-fA-F]{1,4}:){7}/.test(matchStr)) { ruleId = "ipv6"; label = "IPv6"; }
            else if (/^(?:0[1-9]|1[0-2])[-/]/.test(matchStr)) { ruleId = "date-of-birth"; label = "Date of Birth"; }
            else if (/^(?:https?:\/\/|www\.)/.test(matchStr)) { ruleId = "url"; label = "URL"; }
            else if (/^\d{4}-\d{2}-\d{2}[T\s]/.test(matchStr)) { ruleId = "date-time"; label = "Date Time"; }

            const handleClick = () => {
              if (onAddFalsePositive) {
                onAddFalsePositive({
                  value: matchStr,
                  ruleId: ruleId,
                  label: label,
                  path: "",
                });
              }
            };

            newParts.push(
              <mark key={`pii-${piiMatchIdx}-${matchIndex}`} className="redaction-placeholder pre-redaction-highlight cursor-pointer hover:bg-primary/10" data-match-index={piiMatchIdx} onClick={handleClick} title="Click to add as false positive">
                {matchStr}
              </mark>
            );
            piiMatchIdx++;
            lastIndex = matchIndex + matchStr.length;
          }
          if (lastIndex < part.length) {
            newParts.push(part.slice(lastIndex));
          }
        } else {
          newParts.push(part);
        }
      }
      parts.length = 0;
      parts.push(...newParts);
    }

    return <code className="font-mono text-xs">{parts}</code>;
  }, []);

  const renderSyntaxPane = (content: string) => (
    <SyntaxHighlighter code={content} lang="json" />
  );

  // Render focused redaction segments - each shows ~100 chars context around the redaction
  const renderRedactionSegments = (side: "left" | "right") => {
    if (!redactionSegments || redactionSegments.length === 0) {
      return (
        <div className="p-4 text-center text-muted-foreground">
          No redactions found in this capture.
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {redactionSegments.map((segment, index) => (
          <div key={index} className="border border-border rounded-lg bg-background p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-mono text-primary">
                {segment.ruleId}
              </span>
              <span className="text-xs text-muted-foreground">
                {segment.path && <span className="font-mono">{segment.path}</span>}
              </span>
            </div>
            <div className="font-mono text-xs bg-muted/50 rounded p-3 overflow-x-auto">
              {side === "left" ? (
                <RedactionHighlight
                  value={segment.preContext}
                  isPre
                  matches={[{ preValue: segment.preValue, postValue: segment.postValue, ruleId: segment.ruleId, path: segment.path }]}
                  onAddFalsePositive={onAddFalsePositive}
                />
              ) : (
                <RedactionHighlight
                  value={segment.postContext}
                  isPre={false}
                  matches={[{ preValue: segment.preValue, postValue: segment.postValue, ruleId: segment.ruleId, path: segment.path }]}
                  onAddFalsePositive={onAddFalsePositive}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        className="max-w-6xl max-h-[85vh] mx-4 flex flex-col"
        aria-labelledby="diff-dialog-title"
        aria-describedby="diff-dialog-description"
      >
        {/* Loading overlay - shows while computing diff or when isLoading prop is true */}
        {(isLoading || isComputing) && (
          <div className="absolute inset-0 bg-background/80 flex items-center justify-center z-50" style={{ top: 0, left: 0, right: 0, bottom: 0 }}>
            <div className="flex flex-col items-center gap-3 p-6">
              <Spinner size={32} className="text-primary" />
              <span className="text-muted-foreground text-sm">
                {isLoading ? "Loading redaction details..." : "Computing diff..."}
              </span>
            </div>
          </div>
        )}

        {/* Header bar - fixed at top with close button on right */}
        <div className="flex items-start justify-between gap-4 p-4 border-b border-border flex-shrink-0 relative">
          <div className="flex-1 min-w-0">
            <DialogTitle id="diff-dialog-title" className="text-lg font-semibold">
              {title}
            </DialogTitle>
            <DialogDescription id="diff-dialog-description" className="sr-only">
              Side-by-side diff showing pre-redaction and post-redaction content
            </DialogDescription>
          </div>
          <DialogClose
            className="p-1 rounded hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background flex-shrink-0"
            aria-label="Close diff dialog"
          >
            <X className="h-5 w-5" />
          </DialogClose>
        </div>

        {/* Metadata table - fixed height, no scroll */}
        <div className="flex flex-col gap-3 p-4 border-b border-border flex-shrink-0">
          {/* Metadata table */}
          <table className="w-full text-xs text-muted-foreground border-collapse">
            <tbody>
              <tr>
                <td className="font-medium text-foreground w-24 pb-2">Type</td>
                <td className="pb-2">
                  {redactionTypes.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {redactionTypes.map((r) => (
                        <button
                          key={r.apiType}
                          type="button"
                          onClick={() => scrollToRedactionType(r.apiType)}
                          className="px-2 py-1 text-xs rounded transition-colors text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                          aria-label={`Scroll to ${r.apiType} (${r.count} occurrences)`}
                        >
                          {r.apiType} ({r.count})
                        </button>
                      ))}
                    </span>
                  ) : (
                    <span className="font-mono capitalize">{redactionType.replace(/_/g, " ")}</span>
                  )}
                </td>
              </tr>
              <tr>
                <td className="font-medium text-foreground w-24 pb-2">Provider</td>
                <td className="pb-2 font-mono">{provider}</td>
              </tr>
              {targetUrl && (
                <tr>
                  <td className="font-medium text-foreground w-24 pb-2">Target</td>
                  <td className="pb-2 font-mono truncate max-w-[300px]">{targetUrl}</td>
                </tr>
              )}
              {timestamp && (
                <tr>
                  <td className="font-medium text-foreground w-24 pb-2">Time</td>
                  <td className="pb-2 font-mono">{new Date(timestamp).toLocaleString()}</td>
                </tr>
              )}
              <tr>
                <td className="font-medium text-foreground w-24 pb-2">Capture</td>
                <td className="pb-2 font-mono">{captureId}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Fixed header bar above panes - shows context info and view mode toggle */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 p-4 border-b border-border flex-shrink-0 bg-muted/30">
          {hasHiddenLines && (
            <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded flex-shrink-0">
              Showing changes with context ({diff.length} lines of {fullDiff.length})
            </span>
          )}
          {/* View mode toggle for JSON content */}
          {isJsonContent && (
            <div className="flex items-center gap-2" role="tablist" aria-label="View mode">
              <button
                role="tab"
                aria-selected={viewMode === "diff"}
                aria-controls="left-panel-diff right-panel-diff"
                id="diff-tab"
                onClick={() => setViewMode("diff")}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight") {
                    e.preventDefault();
                    setViewMode("segments");
                  }
                }}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  viewMode === "diff"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                }`}
              >
                Diff View
              </button>
              <button
                role="tab"
                aria-selected={viewMode === "segments"}
                aria-controls="left-panel-segments right-panel-segments"
                id="segments-tab"
                onClick={() => setViewMode("segments")}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    setViewMode("diff");
                  } else if (e.key === "ArrowRight") {
                    e.preventDefault();
                    setViewMode("syntax");
                  }
                }}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  viewMode === "segments"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                }`}
              >
                Focused Segments
              </button>
              <button
                role="tab"
                aria-selected={viewMode === "syntax"}
                aria-controls="left-panel-syntax right-panel-syntax"
                id="syntax-tab"
                onClick={() => setViewMode("syntax")}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    setViewMode("segments");
                  }
                }}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  viewMode === "syntax"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                }`}
              >
                <Code className="h-3 w-3 mr-1" />
                Syntax Highlighted
              </button>
            </div>
          )}
        </div>

        {/* Diff/Syntax panels - flex-1 to fill remaining space */}
        <div className="flex-1 min-h-0 flex flex-col">
          {/* Diff View Panels (shown when viewMode === "diff") - Full diff with line numbers */}
          {viewMode === "diff" && (
            <div className="flex flex-col md:flex-row flex-1 min-h-0">
              <div className="w-full md:w-1/2 min-w-0 border-r border-border flex flex-col min-h-0">
                <div className="p-2 bg-muted/50 border-b border-border flex-shrink-0">
                  <h4 className="text-xs font-semibold text-muted-foreground">Pre-Redaction (Original)</h4>
                </div>
                <div
                  ref={leftPaneDiffRef}
                  className="flex-1 overflow-auto p-4 min-h-0"
                  onScroll={(e) => handleScroll(e, "left")}
                  role="tabpanel"
                  id="left-panel-diff"
                  aria-labelledby="diff-tab"
                >
                  {renderDiffPane(diff, "left")}
                </div>
              </div>
              <div className="w-full md:w-1/2 min-w-0 flex flex-col min-h-0">
                <div className="p-2 bg-muted/50 border-b border-border flex-shrink-0">
                  <h4 className="text-xs font-semibold text-muted-foreground">Post-Redaction (Redacted)</h4>
                </div>
                <div
                  ref={rightPaneDiffRef}
                  className="flex-1 overflow-auto p-4 min-h-0"
                  onScroll={(e) => handleScroll(e, "right")}
                  role="tabpanel"
                  id="right-panel-diff"
                  aria-labelledby="diff-tab"
                >
                  {renderDiffPane(diff, "right")}
                </div>
              </div>
            </div>
          )}

          {/* Focused Segments View (shown when viewMode === "segments") - Redaction-focused context segments */}
          {viewMode === "segments" && (
            <div className="flex flex-col md:flex-row flex-1 min-h-0">
              <div className="w-full md:w-1/2 min-w-0 border-r border-border flex flex-col min-h-0">
                <div className="p-2 bg-muted/50 border-b border-border flex-shrink-0">
                  <h4 className="text-xs font-semibold text-muted-foreground">Pre-Redaction (Original)</h4>
                </div>
                <div
                  ref={leftPaneDiffRef}
                  className="flex-1 overflow-auto p-4 min-h-0"
                  onScroll={(e) => handleScroll(e, "left")}
                  role="tabpanel"
                  id="left-panel-segments"
                  aria-labelledby="segments-tab"
                >
                  {renderRedactionSegments("left")}
                </div>
              </div>
              <div className="w-full md:w-1/2 min-w-0 flex flex-col min-h-0">
                <div className="p-2 bg-muted/50 border-b border-border flex-shrink-0">
                  <h4 className="text-xs font-semibold text-muted-foreground">Post-Redaction (Redacted)</h4>
                </div>
                <div
                  ref={rightPaneDiffRef}
                  className="flex-1 overflow-auto p-4 min-h-0"
                  onScroll={(e) => handleScroll(e, "right")}
                  role="tabpanel"
                  id="right-panel-segments"
                  aria-labelledby="segments-tab"
                >
                  {renderRedactionSegments("right")}
                </div>
              </div>
            </div>
          )}

          {/* Syntax Highlighted Panels (shown when viewMode === "syntax") */}
          {viewMode === "syntax" && (
            <div className="flex flex-col md:flex-row overflow-hidden flex-1 min-h-0">
              <div className="w-full md:w-1/2 min-w-0 border-r border-border flex flex-col min-h-0">
                <div className="p-2 bg-muted/50 border-b border-border flex-shrink-0">
                  <h4 className="text-xs font-semibold text-muted-foreground">Pre-Redaction (Original)</h4>
                </div>
                <div
                  ref={leftPaneSyntaxRef}
                  className="flex-1 overflow-auto p-4 min-h-0"
                  onScroll={(e) => handleScroll(e, "left")}
                  role="tabpanel"
                  id="left-panel-syntax"
                  aria-labelledby="syntax-tab"
                >
                  {renderSyntaxPane(diffPreContent)}
                </div>
              </div>
              <div className="w-full md:w-1/2 min-w-0 flex flex-col min-h-0">
                <div className="p-2 bg-muted/50 border-b border-border flex-shrink-0">
                  <h4 className="text-xs font-semibold text-muted-foreground">Post-Redaction (Redacted)</h4>
                </div>
                <div
                  ref={rightPaneSyntaxRef}
                  className="flex-1 overflow-auto p-4 min-h-0"
                  onScroll={(e) => handleScroll(e, "right")}
                  role="tabpanel"
                  id="right-panel-syntax"
                  aria-labelledby="syntax-tab"
                >
                  {renderSyntaxPane(diffPostContent)}
                </div>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}