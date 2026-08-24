// Environment Variables Panel Component
// Displays container environment variables with search, filter, and export capabilities

"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { RefreshCw, Search, ChevronLeft, ChevronRight, Lock, EyeOff, ShieldAlert } from "lucide-react";
import { apiClient } from "@/lib/api";
import type { ContainerEnvVar } from "@/types/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface EnvironmentVariablesPanelProps {
  containerId: string;
}

const ITEMS_PER_PAGE = 20;
const DEBOUNCE_DELAY = 300;

export function EnvironmentVariablesPanel({ containerId }: EnvironmentVariablesPanelProps) {
  const [envVars, setEnvVars] = useState<ContainerEnvVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterSource, setFilterSource] = useState<string>("all");
  const [currentPage, setCurrentPage] = useState(1);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchEnvVars = async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.getContainerEnvVars(containerId, signal);
      setEnvVars(data);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        // Request was cancelled, don't set error
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to fetch environment variables");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Cancel any in-flight request when containerId changes
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    fetchEnvVars(abortControllerRef.current.signal);
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [containerId]);

  // Cleanup debounce timeout on unmount
  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
      // Cancel any in-flight request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const sources = useMemo(() => {
    const allSources = new Set<string>();
    envVars.forEach((v) => v.source && allSources.add(v.source));
    return ["all", ...Array.from(allSources)];
  }, [envVars]);

  // Sort environment variables by key (alphabetically) for consistent ordering
  const sortedEnvVars = useMemo(() => {
    return [...envVars].sort((a, b) => a.key.localeCompare(b.key));
  }, [envVars]);

  // Separate regular and blacklisted variables
  const regularEnvVars = useMemo(() => {
    return sortedEnvVars.filter((v) => v.source !== "blacklisted");
  }, [sortedEnvVars]);

  const blacklistedEnvVars = useMemo(() => {
    return sortedEnvVars.filter((v) => v.source === "blacklisted");
  }, [sortedEnvVars]);

  const filteredRegularEnvVars = useMemo(() => {
    return regularEnvVars.filter((v) => {
      const matchesSearch =
        v.key.toLowerCase().includes(searchTerm.toLowerCase()) ||
        v.value.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesSource = filterSource === "all" || v.source === filterSource;
      return matchesSearch && matchesSource;
    });
  }, [regularEnvVars, searchTerm, filterSource]);

  const paginatedRegularEnvVars = filteredRegularEnvVars.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  const copyToClipboard = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Silently fail
    }
  };

  const handleRefresh = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    fetchEnvVars(abortControllerRef.current.signal);
  };

  if (loading) {
    return (
      <div className="rounded-lg border p-4">
        <h3 className="font-semibold mb-3">Container Environment Variables</h3>
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border p-4">
        <h3 className="font-semibold mb-3">Container Environment Variables</h3>
        <div className="text-center py-8 text-destructive">{error}</div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Container Environment Variables</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            className="inline-flex items-center gap-1 px-2 py-1 text-sm rounded hover:bg-muted"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1">
          <label htmlFor="env-var-search" className="sr-only">
            Search environment variables
          </label>
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            id="env-var-search"
            type="text"
            placeholder="Search variables..."
            value={searchTerm}
            onChange={(e) => {
              const value = e.target.value;
              // Clear existing timeout
              if (debounceTimeoutRef.current) {
                clearTimeout(debounceTimeoutRef.current);
              }
              // Set new timeout
              debounceTimeoutRef.current = setTimeout(() => {
                setSearchTerm(value);
                setCurrentPage(1);
              }, DEBOUNCE_DELAY);
            }}
            className="pl-8 pr-3 py-2 text-sm border rounded-md w-full"
          />
        </div>
        <div>
          <label htmlFor="env-var-filter" className="sr-only">
            Filter by source
          </label>
          <Select value={filterSource} onValueChange={(value) => {
            setFilterSource(value);
            setCurrentPage(1);
          }}>
            <SelectTrigger className="px-3 py-2 text-sm border rounded-md">
              <SelectValue placeholder="Filter by source" />
            </SelectTrigger>
            <SelectContent>
              {sources.map((source) => (
                <SelectItem key={source} value={source}>
                  {source === "all" ? "All Sources" : source}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="text-sm text-muted-foreground mb-2">
        Showing {paginatedRegularEnvVars.length} of {filteredRegularEnvVars.length} variables
      </div>

      <div className="max-h-96 overflow-y-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th scope="col" className="text-left py-2 font-medium">Key</th>
              <th scope="col" className="text-left py-2 font-medium">Value</th>
              <th scope="col" className="text-left py-2 font-medium">Source</th>
              <th scope="col" className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {paginatedRegularEnvVars.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-8 text-center text-muted-foreground">
                  No environment variables found
                </td>
              </tr>
            ) : (
              paginatedRegularEnvVars.map((envVar) => (
                <tr key={envVar.key} className="border-b">
                  <td className="py-2 font-mono text-sm">{envVar.key}</td>
                  <td className="py-2">
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-sm max-w-[200px] truncate">
                        {envVar.value}
                      </code>
                      {envVar.value && envVar.value !== "[REDACTED]" && (
                        <button
                          onClick={() => copyToClipboard(envVar.value)}
                          className="opacity-50 hover:opacity-100"
                          aria-label={`Copy ${envVar.key} value`}
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="h-4 w-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            strokeWidth={2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                            />
                          </svg>
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="py-2 text-muted-foreground">
                    {envVar.source || "-"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Controls for regular variables */}
      {(() => {
        const totalPages = Math.ceil(filteredRegularEnvVars.length / ITEMS_PER_PAGE);
        if (totalPages <= 1) return null;

        return (
          <div className="flex items-center justify-between mt-4 pt-4 border-t">
            <div className="text-sm text-muted-foreground">
              Page {currentPage} of {totalPages} (showing {paginatedRegularEnvVars.length} of {filteredRegularEnvVars.length} variables)
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="inline-flex items-center gap-1 px-2 py-1 text-sm border rounded hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Previous page"
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </button>
              <button
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="inline-flex items-center gap-1 px-2 py-1 text-sm border rounded hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Next page"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        );
      })()}

      {/* Blacklisted/Hidden Variables Section */}
      {blacklistedEnvVars.length > 0 && (
        <div className="mt-6 pt-4 border-t">
          <div className="flex items-center gap-2 mb-3 text-sm text-muted-foreground">
            <ShieldAlert className="h-5 w-5 text-primary" />
            <span className="font-medium text-foreground">Hidden Variables ({blacklistedEnvVars.length})</span>
          </div>
          <p className="text-sm text-muted-foreground mb-3">
            The following environment variables exist but their values are hidden for security reasons.
            These keys match sensitive patterns (passwords, secrets, tokens, API keys, etc.).
          </p>
          <div className="max-h-48 overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th scope="col" className="text-left py-2 font-medium">Key</th>
                  <th scope="col" className="text-left py-2 font-medium">Value</th>
                  <th scope="col" className="text-left py-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {blacklistedEnvVars.map((envVar) => (
                  <tr key={envVar.key} className="border-b">
                    <td className="py-2 font-mono text-sm">{envVar.key}</td>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-sm max-w-[200px] truncate text-muted-foreground">
                          [REDACTED]
                        </code>
                        <Lock className="h-4 w-4 text-muted-foreground" />
                        <EyeOff className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </td>
                    <td className="py-2 text-muted-foreground">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary">
                        <ShieldAlert className="h-3 w-3" />
                        Hidden (Security)
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
