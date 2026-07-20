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
import { RedactionHighlight } from "@/components/ui/redaction-highlight";
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

function renderLine(item: DiffChunk, side: "left" | "right") {
  const isLeft = side === "left";
  const showLine = isLeft ? item.type !== "insert" : item.type !== "delete";

  if (!showLine) {
    return <div style={{ height: "1.25rem" }} />;
  }

  const lineNum = isLeft ? item.oldLineNum : item.newLineNum;
  const lineClass = `font-mono text-xs whitespace-pre-wrap ${
    isLeft
      ? item.type === "delete"
        ? "bg-red-50"
        : item.type === "insert"
        ? "bg-green-50"
        : "bg-transparent"
      : item.type === "delete"
      ? "bg-red-50"
      : item.type === "insert"
      ? "bg-green-50"
      : "bg-transparent"
  }`;

  // For right pane (post-redaction), use RedactionHighlight to highlight placeholders
  // For left pane (pre-redaction), render plain text since it's the original content
  const renderValue = isLeft
    ? <span>{item.value}</span>
    : <RedactionHighlight value={item.value} />;

  return (
    <div className={lineClass} style={{ padding: "2px 8px", borderRadius: "4px", minHeight: "1.25rem" }}>
      <span className="text-muted-foreground mr-2 select-none" style={{ width: "3rem", display: "inline-block", textAlign: "right" }}>
        {lineNum ?? ""}
      </span>
      {renderValue}
    </div>
  );
}

// Validate JSON content properly
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
        <DialogTitle id="diff-dialog-title" className="sr-only">
          {title}
        </DialogTitle>
        <DialogDescription id="diff-dialog-description" className="sr-only">
          Side-by-side diff showing pre-redaction and post-redaction content
        </DialogDescription>

        <div className="flex items-center justify-between p-4 border-b border-border flex-shrink-0">
          <div>
            <h3 className="text-lg font-semibold">{title}</h3>
            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground mt-1">
              <span>
                Type: <span className="font-mono capitalize">{redactionType.replace(/_/g, " ")}</span>
              </span>
              <span>
                Capture: <span className="font-mono">{captureId}</span>
              </span>
              {provider && (
                <span>
                  Provider: <span className="font-mono">{provider}</span>
                </span>
              )}
              {targetUrl && (
                <span>
                  Target: <span className="font-mono truncate max-w-[200px]">{targetUrl}</span>
                </span>
              )}
              {timestamp && (
                <span>
                  Time: <span className="font-mono">{new Date(timestamp).toLocaleString()}</span>
                </span>
              )}
            </div>
          </div>
          {hasHiddenLines && (
            <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
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
          <DialogClose
            className="p-1 rounded hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
            aria-label="Close diff dialog"
          >
            <X className="h-5 w-5" />
          </DialogClose>
        </div>
        <div className="flex flex-col md:flex-row overflow-hidden flex-1 min-h-0">
          {/* Diff View Panels (shown when viewMode === "diff") */}
          <div hidden={viewMode !== "diff"} className="w-full md:w-1/2 min-w-0 border-r border-border flex flex-col min-h-0">
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
          <div hidden={viewMode !== "diff"} className="w-full md:w-1/2 min-w-0 flex flex-col min-h-0">
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

          {/* Syntax Highlighted Panels (shown when viewMode === "syntax") */}
          <div hidden={viewMode !== "syntax"} className="w-full md:w-1/2 min-w-0 border-r border-border flex flex-col min-h-0">
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
          <div hidden={viewMode !== "syntax"} className="w-full md:w-1/2 min-w-0 flex flex-col min-h-0">
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
      </DialogContent>
    </Dialog>
  );
}