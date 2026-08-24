"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { apiClient } from "@/lib/api";
import type { CaptureDetail, RedactionDetails } from "@/types/api";

interface RedactionCapture extends CaptureDetail {
  redaction?: RedactionDetails;
}

interface RedactionPanelProps {
  captureId: string | null;
  className?: string;
}

function renderJson(data: unknown): string {
  if (typeof data === "string") {
    try {
      return JSON.stringify(JSON.parse(data), null, 2);
    } catch {
      return data;
    }
  }
  if (data === null || data === undefined) {
    return "{}";
  }
  return JSON.stringify(data, null, 2);
}

export function RedactionPanel({ captureId, className }: RedactionPanelProps) {
  const [capture, setCapture] = useState<RedactionCapture | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [redactLoading, setRedactLoading] = useState(false);
  const [redactError, setRedactError] = useState<string | null>(null);
  const [newRules, setNewRules] = useState<Array<{ id: string; pattern: string; replacement: string }>>([
    { id: "", pattern: "", replacement: "[REDACTED]" },
  ]);

  useEffect(() => {
    if (!captureId) {
      setCapture(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    apiClient
      .getCapture(captureId)
      .then((data) => {
        if (!cancelled) {
          setCapture(data as RedactionCapture);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unknown error");
          setCapture(null);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [captureId]);

  const copyToClipboard = async (value: string, path: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedPath(path);
    setTimeout(() => setCopiedPath(null), 1500);
  };

  const handleRedact = async () => {
    const validRules = newRules.filter((r) => r.id && r.pattern);
    if (validRules.length === 0) {
      setRedactError("At least one rule with ID and pattern is required");
      return;
    }

    if (!captureId) return;

    setRedactLoading(true);
    setRedactError(null);

    try {
      const result = await apiClient.redactCapture(captureId, validRules);
      setCapture(result as RedactionCapture);
    } catch (err) {
      setRedactError(err instanceof Error ? err.message : "Redaction failed");
    } finally {
      setRedactLoading(false);
    }
  };

  const addRule = () => {
    setNewRules([...newRules, { id: "", pattern: "", replacement: "[REDACTED]" }]);
  };

  const removeRule = (index: number) => {
    setNewRules(newRules.filter((_, i) => i !== index));
  };

  const updateRule = (index: number, field: "id" | "pattern" | "replacement", value: string) => {
    setNewRules(
      newRules.map((rule, i) =>
        i === index ? { ...rule, [field]: value } : rule,
      ),
    );
  };

  if (!captureId) {
    return (
      <div className={cn("rounded-lg border p-6 text-center text-muted-foreground", className)}>
        Select a capture to inspect request, response, and redactions.
      </div>
    );
  }

  if (loading) {
    return (
      <div className={cn("space-y-4", className)}>
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-lg border p-4">
            <div className="h-4 bg-muted-foreground/20 rounded mb-2" style={{ width: "200px" }} />
            <div className="h-64 bg-muted/20 rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
        <p className="text-destructive">Error: {error}</p>
        <p className="text-sm text-muted-foreground mt-2">
          Please try again or contact support if the problem persists.
        </p>
      </div>
    );
  }

  if (!capture) {
    return (
      <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
        <p className="text-destructive">Capture not found</p>
      </div>
    );
  }

  const matches = capture.redaction?.matches ?? [];

  return (
    <div className={cn("space-y-6", className)}>
      <div>
        <Link
          href={`/sessions/${capture.sessionId ?? ""}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to session
        </Link>
        <h2 className="text-3xl font-bold tracking-tight mt-2">
          Capture: #{captureId}
        </h2>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-lg border p-4">
          <h3 className="font-semibold mb-3">Request Details</h3>
          <div className="space-y-2 text-sm">
            <div>
              <span className="text-muted-foreground">Provider:</span>{" "}
              {capture.provider}
            </div>
            <div>
              <span className="text-muted-foreground">Method:</span>{" "}
              {capture.method}
            </div>
            <div>
              <span className="text-muted-foreground">Target:</span>{" "}
              {capture.targetUrl}
            </div>
            <div>
              <span className="text-muted-foreground">Request Size:</span>{" "}
              {capture.requestBytes.toLocaleString()} bytes
            </div>
            <div>
              <span className="text-muted-foreground">Timestamp:</span>{" "}
              {new Date(capture.timestamp).toLocaleString()}
            </div>
          </div>
        </div>

        <div className="rounded-lg border p-4">
          <h3 className="font-semibold mb-3">Response Details</h3>
          <div className="space-y-2 text-sm">
            <div>
              <span className="text-muted-foreground">Status:</span>{" "}
              {capture.responseStatus}
            </div>
            <div>
              <span className="text-muted-foreground">Streaming:</span>{" "}
              {capture.responseIsStreaming ? "Yes" : "No"}
            </div>
            <div>
              <span className="text-muted-foreground">Response Size:</span>{" "}
              {capture.responseBytes.toLocaleString()} bytes
            </div>
            <div>
              <span className="text-muted-foreground">Total Time:</span>{" "}
              {capture.timings.total_ms.toLocaleString()} ms
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border p-4">
        <h3 className="font-semibold mb-3">Request Body</h3>
        <pre className="rounded bg-muted p-4 text-xs overflow-x-auto max-h-96 whitespace-pre-wrap break-words">
          {renderJson(capture.requestBody)}
        </pre>
      </div>

      <div className="rounded-lg border p-4">
        <h3 className="font-semibold mb-3">Response Body</h3>
        <pre className="rounded bg-muted p-4 text-xs overflow-x-auto max-h-96 whitespace-pre-wrap break-words">
          {renderJson(capture.responseBody)}
        </pre>
      </div>

      {matches.length > 0 && (
        <div className="rounded-lg border p-4">
          <h3 className="font-semibold mb-3">Redaction Details</h3>
          <p className="text-sm text-muted-foreground mb-4">
            {capture.redaction?.totalRedactions ?? 0} redaction
            {((capture.redaction?.totalRedactions ?? 0) === 1 ? "" : "s")} found across{" "}
            {Object.keys(capture.redaction?.byRule ?? {}).length} rule
            {(Object.keys(capture.redaction?.byRule ?? {}).length === 1 ? "" : "s")}.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2">Path</th>
                  <th className="text-left py-2">Rule</th>
                  <th className="text-left py-2">Pre-Redaction</th>
                  <th className="text-left py-2">Post-Redaction</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((match, idx) => {
                  const key = `${match.path}-${match.ruleId}-${idx}`;
                  return (
                    <tr key={key} className="border-b">
                      <td className="py-2 font-mono text-xs">{match.path || "—"}</td>
                      <td className="py-2 text-xs capitalize">
                        {match.ruleId.replace(/_/g, " ")}
                      </td>
                      <td className="py-2 font-mono text-xs">
                        <button
                          type="button"
                          onClick={() => copyToClipboard(match.original, key + "-orig")}
                          className={cn(
                            "rounded border px-2 py-1 transition-colors",
                            copiedPath === key + "-orig"
                              ? "border-success bg-success/10 text-success"
                              : "border-border hover:bg-accent"
                          )}
                          title="Copy pre-redaction value"
                        >
                          {match.original}
                        </button>
                      </td>
                      <td className="py-2 font-mono text-xs text-destructive">
                        {match.placeholder}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Redact/Rerun Action */}
      <div className="rounded-lg border p-4">
        <h3 className="font-semibold mb-3">Redact / Rerun</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Apply custom redaction rules to the capture. Each rule replaces matches of a regex pattern with the specified replacement.
        </p>
        {redactError && (
          <div className="mb-4 p-3 rounded bg-destructive/10 border border-destructive/20 text-destructive text-sm">
            {redactError}
          </div>
        )}
        <div className="space-y-2 mb-4">
          {newRules.map((rule, index) => (
            <div key={index} className="flex gap-2 items-start">
              <input
                type="text"
                placeholder="Rule ID (e.g., email, ssn)"
                value={rule.id}
                onChange={(e) => updateRule(index, "id", e.target.value)}
                className="flex-1 rounded border border-input bg-background px-3 py-2 text-sm"
              />
              <input
                type="text"
                placeholder="Regex pattern"
                value={rule.pattern}
                onChange={(e) => updateRule(index, "pattern", e.target.value)}
                className="flex-1 rounded border border-input bg-background px-3 py-2 text-sm font-mono"
              />
              <input
                type="text"
                placeholder="Replacement"
                value={rule.replacement}
                onChange={(e) => updateRule(index, "replacement", e.target.value)}
                className="flex-1 rounded border border-input bg-background px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => removeRule(index)}
                disabled={newRules.length === 1}
                className="rounded border border-input bg-background px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
                title="Remove rule"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={addRule}
            className="rounded border border-input bg-background px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            + Add Rule
          </button>
          <button
            type="button"
            onClick={handleRedact}
            disabled={redactLoading}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {redactLoading ? "Applying..." : "Apply Redaction"}
          </button>
        </div>
      </div>
    </div>
  );
}