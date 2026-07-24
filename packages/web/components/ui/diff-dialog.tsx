"use client";

import { useMemo, useRef, useCallback, useState } from "react";
import { X, Code } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import { computeDiff, type DiffChunk, filterDiffWithContext } from "@/lib/diff";
import { SyntaxHighlighter } from "@/components/ui/syntax-highlighter";

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
}

type ViewMode = "diff" | "syntax";

const lineStyle = {
  padding: "2px 8px",
  borderRadius: "4px",
  minHeight: "1.25rem",
} as const;

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
}: DiffDialogProps) {
  // Use full body content for diff if available, otherwise use match snippets
  const diffPreContent = fullOriginal ?? preContent;
  const diffPostContent = fullRedacted ?? postContent;
  const fullDiff = useMemo(() => computeDiff(diffPreContent, diffPostContent), [diffPreContent, diffPostContent]);

  // Filter diff to show only changes with context
  const { chunks: diff, hasHiddenLines } = useMemo(
    () => filterDiffWithContext(fullDiff, 3),
    [fullDiff]
  );

  // Detect if content is valid JSON for syntax highlighting
  const isJsonContent = useMemo(() => {
    return isValidJson(diffPreContent) || isValidJson(diffPostContent);
  }, [diffPreContent, diffPostContent]);

  // View mode state - default to diff view, allow switching to syntax highlighted view for JSON
  const [viewMode, setViewMode] = useState<ViewMode>("diff");

  // Synchronized scrolling state - separate refs for each view mode
  const leftPaneDiffRef = useRef<HTMLDivElement>(null);
  const rightPaneDiffRef = useRef<HTMLDivElement>(null);
  const leftPaneSyntaxRef = useRef<HTMLDivElement>(null);
  const rightPaneSyntaxRef = useRef<HTMLDivElement>(null);
  const isScrollingRef = useRef(false);

  // Parse redaction types from the comma-separated string like "[RULE_REDACTED] (count), [RULE2_REDACTED] (count)"
  // Supports hyphens in rule names like "API-KEY-PREFIXED_REDACTED"
  const rawRedactionTypes = useMemo(() => {
    if (!redactionType) return [];
    const matches = redactionType.match(/\[([A-Z][A-Z0-9_-]*_REDACTED)\]\s*\((\d+)\)/g);
    if (!matches) return [];
    return matches.map((m) => {
      const ruleMatch = m.match(/\[([A-Z][A-Z0-9_-]*_REDACTED)\]/);
      const countMatch = m.match(/\((\d+)\)/);
      return {
        apiType: ruleMatch ? ruleMatch[1] : "",
        count: countMatch ? parseInt(countMatch[1], 10) : 0,
        display: m,
      };
    }).filter(r => r.apiType);
  }, [redactionType]);

  // Extract actual placeholder types (e.g., [API_KEY_REDACTED]) from post-redaction content
  const placeholderTypes = useMemo(() => {
    const types = new Set<string>();
    // Check both pre and post content for placeholders
    const allContent = [diffPreContent, diffPostContent].filter(Boolean).join("\n");
    const matches = allContent.match(/\[([A-Z][A-Z0-9_]*_REDACTED)\]/g);
    if (matches) {
      matches.forEach(m => {
        const t = m.match(/\[([A-Z][A-Z0-9_]*_REDACTED)\]/);
        if (t) types.add(t[1]);
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

  // Scroll to a specific redaction type in both panes
  const scrollToRedactionType = useCallback((apiType: string) => {
    const panes = viewMode === "diff"
      ? [leftPaneDiffRef.current, rightPaneDiffRef.current]
      : [leftPaneSyntaxRef.current, rightPaneSyntaxRef.current];

    // Look up the placeholder type for this API type
    const placeholderType = apiToPlaceholderMap.get(apiType) || apiType;
    const kebabType = placeholderType.toLowerCase().replace(/_/g, "-");

    // Search in right pane first (where placeholders actually appear)
    // Then fall back to left pane
    const searchOrder = [1, 0]; // right pane first, then left pane

    for (const paneIndex of searchOrder) {
      const pane = panes[paneIndex];
      if (!pane) continue;

      // Try to find element with data attribute on the mark (placeholder) elements
      const target = pane.querySelector(`mark[data-redaction="${kebabType}"]`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        // Add a brief highlight animation
        target.classList.add("scroll-target-highlight");
        setTimeout(() => target.classList.remove("scroll-target-highlight"), 2000);
        break;
      }
    }
  }, [viewMode, apiToPlaceholderMap]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>, source: "left" | "right") => {
    if (isScrollingRef.current) return;
    isScrollingRef.current = true;

    const sourcePane = e.currentTarget;
    let targetPane: HTMLDivElement | null = null;

    if (viewMode === "diff") {
      targetPane = source === "left" ? rightPaneDiffRef.current : leftPaneDiffRef.current;
    } else {
      targetPane = source === "left" ? rightPaneSyntaxRef.current : leftPaneSyntaxRef.current;
    }

    if (targetPane) {
      targetPane.scrollTop = sourcePane.scrollTop;
      targetPane.scrollLeft = sourcePane.scrollLeft;
    }

    requestAnimationFrame(() => {
      isScrollingRef.current = false;
    });
  }, [viewMode]);

  // Highlights redaction placeholders in text.
  // For pre-redaction (isPre=true): highlights text that matches PII patterns
  // For post-redaction (isPre=false): highlights the [RULE_REDACTED] placeholders
  const RedactionHighlight = useCallback(({
    value,
    isPre = false,
  }: {
    value: string | undefined | null;
    isPre?: boolean;
  }) => {
    const placeholderPattern = /\[[A-Z][A-Z0-9_]*_REDACTED\]/g;
    const safeValue = String(value || "");

    if (isPre) {
      const piiPatterns = [
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, // email
        /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
        /\b(SK|AK|RK|sk|ak|rk)_[A-Za-z0-9]{32,}\b/g, // API keys
        /\bBearer\s+[A-Za-z0-9._-]+\b/g, // Bearer tokens
        /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, // phone
        /\b(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD)[_-]?[=:]\s*["']?[A-Za-z0-9+/=_-]{20,}["']?/gi, // key=value patterns
      ];

      const parts: (string | React.ReactElement)[] = [safeValue];
      for (const pattern of piiPatterns) {
        const newParts: (string | React.ReactElement)[] = [];
        for (const part of parts) {
          if (typeof part === "string") {
            const split = part.split(pattern);
            const matches = part.match(pattern) || [];
            split.forEach((segment, i) => {
              if (segment) newParts.push(segment);
              if (i < matches.length) {
                newParts.push(
                  <mark key={`pii-${i}-${Date.now()}`} className="redaction-placeholder pre-redaction-highlight">
                    {matches[i]}
                  </mark>
                );
              }
            });
          } else {
            newParts.push(part);
          }
        }
        parts.length = 0;
        parts.push(...newParts);
      }

      return <code className="font-mono text-xs">{parts}</code>;
    }

    // For post-redaction, highlight the [RULE_REDACTED] placeholders
    const partsPost = safeValue.split(placeholderPattern);
    const matches = safeValue.match(placeholderPattern);

    if (!matches || matches.length === 0) {
      return <code className="font-mono text-xs">{value}</code>;
    }

    return (
      <code className="font-mono text-xs">
        {partsPost.map((part, i) => (
          <span key={i}>
            {part}
            {i < matches.length && (
              <mark
                key={`placeholder-${i}-${matches[i]}`}
                className="redaction-placeholder"
                data-redaction={matches[i].replace(/[\[\]]/g, "").toLowerCase().replace(/_/g, "-")}
              >
                {matches[i]}
              </mark>
            )}
          </span>
        ))}
      </code>
    );
  }, []);

  // Render a single diff line with redaction highlighting and data attributes for navigation
  const renderLine = (item: DiffChunk, side: "left" | "right") => {
    const isLeft = side === "left";
    const showLine = isLeft ? item.type !== "insert" : item.type !== "delete";

    if (!showLine) {
      return <div style={lineStyle} />;
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

    // For right pane (post-redaction), use RedactionHighlight to highlight placeholders
    // For left pane (pre-redaction), also use RedactionHighlight with isPre=true to highlight likely PII
    const renderValue = isLeft
      ? <RedactionHighlight value={item.value} isPre />
      : <RedactionHighlight value={item.value} />;

    return (
      <div
        className={lineClass}
        style={lineStyle}
      >
        <span className="text-muted-foreground mr-2 select-none" style={{ width: "3rem", display: "inline-block", textAlign: "right" }}>
          {lineNum ?? ""}
        </span>
        {renderValue}
      </div>
    );
  };

  const renderDiffPane = (diffChunks: typeof diff, side: "left" | "right") => (
    <div className="font-mono text-xs">
      {diffChunks.map((chunk, idx) => (
        <div key={idx}>{renderLine(chunk, side)}</div>
      ))}
    </div>
  );

  const renderSyntaxPane = (content: string) => (
    <SyntaxHighlighter code={content} lang="json" />
  );

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        className="max-w-6xl max-h-[85vh] mx-4 flex flex-col"
        aria-labelledby="diff-dialog-title"
        aria-describedby="diff-dialog-description"
      >
        {/* Header bar - fixed at top with close button on right */}
        <div className="flex items-start justify-between gap-4 p-4 border-b border-border flex-shrink-0">
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
                    setViewMode("syntax");
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
                aria-selected={viewMode === "syntax"}
                aria-controls="left-panel-syntax right-panel-syntax"
                id="syntax-tab"
                onClick={() => setViewMode("syntax")}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    setViewMode("diff");
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
          {/* Diff View Panels (shown when viewMode === "diff") */}
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