"use client";

import { useMemo, useRef, useCallback } from "react";
import { X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import { computeDiff, type DiffChunk, filterDiffWithContext } from "@/lib/diff";
import { RedactionHighlight } from "@/components/ui/redaction-highlight";

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
      ? "bg-red-50 line-through"
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

  // Synchronized scrolling state
  const leftPaneRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);
  const isScrollingRef = useRef(false);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>, source: "left" | "right") => {
    if (isScrollingRef.current) return;
    isScrollingRef.current = true;

    const sourcePane = e.currentTarget;
    const targetPane = source === "left" ? rightPaneRef.current : leftPaneRef.current;

    if (targetPane) {
      targetPane.scrollTop = sourcePane.scrollTop;
      targetPane.scrollLeft = sourcePane.scrollLeft;
    }

    requestAnimationFrame(() => {
      isScrollingRef.current = false;
    });
  }, []);

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
          <DialogClose
            className="p-1 rounded hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
            aria-label="Close diff dialog"
          >
            <X className="h-5 w-5" />
          </DialogClose>
        </div>
        <div className="flex flex-col md:flex-row overflow-hidden flex-1 min-h-0">
          {/* Left pane - Pre-redaction (Original) */}
          <div className="flex-1 min-w-0 border-r border-border flex flex-col min-h-0">
            <div className="p-2 bg-muted/50 border-b border-border flex-shrink-0">
              <h4 className="text-xs font-semibold text-muted-foreground">Pre-Redaction (Original)</h4>
            </div>
            <div
              ref={leftPaneRef}
              className="flex-1 overflow-auto p-4 min-h-0"
              onScroll={(e) => handleScroll(e, "left")}
            >
              <div className="font-mono text-xs">
                {diff.map((chunk, idx) => (
                  <div key={idx}>{renderLine(chunk, "left")}</div>
                ))}
              </div>
            </div>
          </div>

          {/* Right pane - Post-redaction (Redacted) */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            <div className="p-2 bg-muted/50 border-b border-border flex-shrink-0">
              <h4 className="text-xs font-semibold text-muted-foreground">Post-Redaction (Redacted)</h4>
            </div>
            <div
              ref={rightPaneRef}
              className="flex-1 overflow-auto p-4 min-h-0"
              onScroll={(e) => handleScroll(e, "right")}
            >
              <div className="font-mono text-xs">
                {diff.map((chunk, idx) => (
                  <div key={idx}>{renderLine(chunk, "right")}</div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}