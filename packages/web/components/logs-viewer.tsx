"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { LogEntry, LogLevel, LogsFilter } from "@/types/api";
import { apiClient } from "@/lib/api";
import { cn } from "@/lib/utils";

interface LogsViewerProps {
  containerId?: string;
  sessionId?: string;
}

const LOG_LEVELS: LogLevel[] = ["error", "warn", "info", "debug"];

const LEVEL_COLORS: Record<LogLevel, string> = {
  error: "text-destructive bg-destructive/10 border-destructive/20",
  warn: "text-primary bg-primary/10 border-primary/20",
  info: "text-primary bg-primary/10 border-primary/20",
  debug: "text-muted-foreground bg-muted border-border",
};

const LEVEL_ICONS: Record<LogLevel, string> = {
  error: "❌",
  warn: "⚠️",
  info: "ℹ️",
  debug: "🐛",
};

function LogLine({ log }: { log: LogEntry }) {
  const levelStyles = LEVEL_COLORS[log.level];
  const icon = LEVEL_ICONS[log.level];

  return (
    <div
      className={cn(
        "flex items-start gap-3 px-3 py-2 text-xs border-b border-border/50 last:border-0",
        levelStyles
      )}
    >
      <span className="font-mono opacity-60">{icon}</span>
      <span className="font-mono opacity-60 min-w-[80px]">
        {new Date(log.timestamp).toLocaleTimeString()}
      </span>
      <span className="font-mono opacity-60">{log.source}</span>
      <span className="flex-1 whitespace-pre-wrap">{log.message}</span>
    </div>
  );
}


export function LogsViewer({ containerId = "contextio-next" }: LogsViewerProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<LogsFilter>({
    levels: LOG_LEVELS,
    search: "",
  });
  const [autoScroll, setAutoScroll] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExportOptions, setShowExportOptions] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Sort logs oldest to newest (by timestamp)
  const sortedLogs = useMemo(() => {
    return [...logs].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }, [logs]);

  const loadLogs = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const fetchedLogs = await apiClient.getLogs(containerId, filter);
      setLogs(fetchedLogs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load logs");
    } finally {
      setIsLoading(false);
    }
  }, [containerId, filter]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  // Auto-refresh logs every 30 seconds
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      loadLogs();
    }, 30000);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [loadLogs]);

  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [sortedLogs, autoScroll]);

  const handleLevelToggle = (level: LogLevel) => {
    setFilter((prev) => ({
      ...prev,
      levels: prev.levels.includes(level)
        ? prev.levels.filter((l) => l !== level)
        : [...prev.levels, level],
    }));
  };

  const handleSearchChange = (value: string) => {
    setFilter((prev) => ({ ...prev, search: value }));
  };

  const handleClearLogs = async () => {
    try {
      await apiClient.clearLogs(containerId);
      setLogs([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear logs");
    }
  };

  const handleExport = async (format: "json" | "text" | "csv") => {
    try {
      const exported = await apiClient.exportLogs(containerId, format, filter);
      const blob = new Blob([exported], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const extension = format === "json" ? "json" : format === "csv" ? "csv" : "txt";
      a.download = `logs-${new Date().toISOString().slice(0, 10)}.${extension}`;
      a.click();
      URL.revokeObjectURL(url);
      setShowExportOptions(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export logs");
    }
  };

  const filteredLogs = useMemo(() => sortedLogs.filter((log) => {
    if (!filter.levels.includes(log.level)) return false;
    if (filter.search) {
      const searchLower = filter.search.toLowerCase();
      return (
        log.message.toLowerCase().includes(searchLower) ||
        log.source.toLowerCase().includes(searchLower)
      );
    }
    return true;
  }), [sortedLogs, filter.levels, filter.search]);


  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-4 pb-4 border-b">
        <div className="flex items-center gap-4">
          <h3 className="font-semibold">Container Logs</h3>
          <span className="text-xs text-muted-foreground">({filteredLogs.length} entries)</span>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            {LOG_LEVELS.map((level) => (
              <button
                key={level}
                onClick={() => handleLevelToggle(level)}
                className={cn(
                  "px-2 py-1 text-xs rounded border transition-colors",
                  filter.levels.includes(level)
                    ? "opacity-100"
                    : "opacity-50 grayscale"
                )}
                title={level.toUpperCase()}
              >
                {LEVEL_ICONS[level]}
              </button>
            ))}
          </div>

          <div className="relative">
            <input
              type="text"
              placeholder="Search logs..."
              value={filter.search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-8 pr-3 py-1 text-xs border rounded bg-background"
            />
            <svg
              className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4-4" />
            </svg>
          </div>

          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={cn(
              "px-2 py-1 text-xs rounded border",
              autoScroll ? "bg-primary/20 border-primary" : "bg-muted border-border"
            )}
            title={autoScroll ? "Auto-scroll enabled" : "Auto-scroll disabled"}
          >
            {autoScroll ? "Auto" : "Pause"}
          </button>

          <button
            onClick={handleClearLogs}
            className="px-2 py-1 text-xs rounded border bg-destructive/20 border-destructive/20 hover:bg-destructive/30"
            title="Clear all logs"
          >
            Clear
          </button>

          <div className="relative">
            <button
              onClick={() => setShowExportOptions(!showExportOptions)}
              className="px-2 py-1 text-xs rounded border bg-muted"
              title="Export logs"
            >
              Export
            </button>
            {showExportOptions && (
              <div className="absolute right-0 mt-2 bg-popover border rounded-md shadow-lg p-2 min-w-[120px]">
                <button onClick={() => handleExport("json")} className="block w-full text-left px-3 py-1 text-xs hover:bg-accent rounded">
                  JSON
                </button>
                <button onClick={() => handleExport("csv")} className="block w-full text-left px-3 py-1 text-xs hover:bg-accent rounded">
                  CSV
                </button>
                <button onClick={() => handleExport("text")} className="block w-full text-left px-3 py-1 text-xs hover:bg-accent rounded">
                  Text
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="text-center py-4 text-muted-foreground">
            Loading logs...
          </div>
        )}
        {error && (
          <div className="text-center py-4 text-destructive">
            Error: {error}
          </div>
        )}
        {!isLoading && !error && filteredLogs.length === 0 && (
          <div className="text-center py-4 text-muted-foreground">
            No logs found
          </div>
        )}
        <div>
          {filteredLogs.map((log) => (
            <LogLine key={log.id} log={log} />
          ))}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  );
}
