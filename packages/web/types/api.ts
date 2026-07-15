/**
 * API type definitions for the web package.
 * 
 * This file contains all TypeScript interfaces and types used for API
 * request/response handling, session management, provider configurations,
 * logging, and metrics.
 */

/**
 * Represents an API session with request/response details.
 */
export interface Session {
  /** Unique identifier for the session */
  id: string;
  /** Session identifier from the API */
  sessionId: string;
  /** Source of the session (e.g., provider name) */
  source: string;
  /** API provider name */
  provider: string;
  /** API format (e.g., 'openai', 'anthropic') */
  apiFormat: string;
  /** Target URL for the API request */
  targetUrl: string;
  /** Request body as key-value pairs (omitted from list endpoints for size) */
  requestBody?: Record<string, unknown>;
  /** HTTP response status code */
  responseStatus: number;
  /** Whether the response is streaming */
  responseIsStreaming: boolean;
  /** Raw response body as string, or null if not available. Optional. */
  responseBody?: string | null;
  /** ISO timestamp of when the session was created */
  timestamp: string;
  /** Timing information in milliseconds */
  timings: {
    /**
     * Total duration in milliseconds for the entire API session.
     * Represents the complete elapsed time from session initiation to completion,
     * including request preparation, network latency, API processing, and response handling.
     */
    total_ms: number;
  };
}

/**
 * Statistics for an API session including token usage.
 */
export interface SessionStats {
  /** Session identifier */
  sessionId: string;
  /** Total number of requests in the session */
  totalRequests: number;
  /** Token usage breakdown */
  totalTokens: {
    /** Input tokens */
    input: number;
    /** Output tokens */
    output: number;
    /** Total tokens */
    total: number;
  };
  /** First message in the session */
  firstMessage: string;
  /** Optional system prompt */
  systemPrompt?: string;
  /** Optional array of tool definitions */
  toolDefinitions?: string[];
}

/**
 * Aggregated metrics for a session group.
 */
export interface SessionMetrics {
  /** Total inbound source bytes */
  totalInboundBytes: number;
  /** Total outbound destination bytes */
  totalOutboundBytes: number;
  /** Inbound performance metrics (bytes/sec) */
  inboundThroughput: number;
  /** Outbound performance metrics (bytes/sec) */
  outboundThroughput: number;
  /**
   * Total count of scalar (string/number/boolean) leaf values extracted from
   * the request bodies in this session. Scanned over the first two levels of
   * nesting — top-level keys plus one level of nested keys (object properties
   * or array indices, flattened to dotted-path keys like "messages.0").
   * Null values are skipped at every level. This count matches the row count
   * in the "Context Values" table.
   */
  totalContextValues: number;
  /** Total input tokens across all captures */
  totalInputTokens?: number;
  /** Total output tokens across all captures */
  totalOutputTokens?: number;
  /**
   * Total output token rate across captured turns, in tokens per second.
   * Derived from total output tokens divided by capture count; returns 0 when
   * the session has no captures or no token data.
   */
  tokensPerSecond?: number;
  /** Number of successful (2xx) captures */
  successCount?: number;
  /** Number of failed (non-2xx) captures */
  errorCount?: number;
  /** Percentage of failed captures (0-1) */
  errorRate?: number;
  /** Redaction statistics */
  redactionStats: {
    totalRedactions: number;
    byRule: Record<string, number>;
  };
}

export interface CaptureMetrics {
  /** Whether this capture was successful (2xx) */
  successCount: number;
  /** Whether this capture failed (non-2xx) */
  errorCount: number;
  /** Error rate for this capture (0 or 1) */
  errorRate: number;
  /** Total context values in this capture's request */
  totalContextValues: number;
  /** Input tokens for this capture */
  totalInputTokens: number;
  /** Output tokens for this capture */
  totalOutputTokens: number;
  /** Output token rate for this capture (tokens/second) */
  tokensPerSecond: number;
  /** Total redactions in this capture */
  totalRedactions: number;
  /** Model name detected from response, if available */
  model?: string | null;
}

/**
 * Detailed session information including metrics and context values.
 */
export interface SessionDetail extends Session {
  /** Aggregated metrics for this session */
  metrics?: SessionMetrics;
  /** Context values captured during the session */
  contextValues?: Record<string, unknown>;
  /** Redaction statistics for the session */
  redactionStats?: {
    totalRedactions: number;
    byRule: Record<string, number>;
  };
/** Breakdown of individual captures within the session */
  captures?: Array<{
    id: string;
    timestamp: string;
    targetUrl: string;
    requestBytes: number;
    responseBytes: number;
    responseStatus?: number;
    responseIsStreaming?: boolean;
    timings: {
      total_ms: number;
    };
    source?: string | null;
    metrics?: CaptureMetrics;
    redactionStats?: {
      totalRedactions: number;
      byRule: Record<string, number>;
    };
  }>;
}

/**
 * A session summary for list views.
 */
export interface SessionSummary {
  /** Session identifier */
  sessionId: string;
  /** Source system name */
  source: string;
  /** Destination provider */
  destination: string;
  /** Total number of captures in this session */
  captureCount: number;
  /** Total request bytes across all captures */
  totalRequestBytes: number;
  /** Total response bytes across all captures */
  totalResponseBytes: number;
  /** Total time across all captures (ms) */
  totalTimeMs: number;
  /** Timestamp of the first capture */
  firstTimestamp: string;
  /** Timestamp of the last capture */
  lastTimestamp: string;
  /** Token usage summary */
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
}

/**
 * Configuration for an API provider.
 */
export interface ProviderConfig {
  /** Unique provider identifier */
  id: string;
  /** Human-readable provider name */
  name: string;
  /** Base URL for the provider's API */
  baseUrl: string;
  /** List of available model names */
  models: string[];
}

/**
 * Status of the proxy server.
 */
export interface ProxyStatus {
  /** Whether the proxy is currently running */
  running: boolean;
  /** Process ID of the proxy */
  pid: number;
  /** Port the proxy is listening on */
  port: number;
  /** Human-readable uptime string */
  uptime: string;
  /** Number of active sessions */
  sessions: number;
  /** List of loaded plugin names */
  plugins: string[];
  /** Whether traffic logging is enabled */
  logTraffic: boolean;
  /** Container identifier */
  containerId?: string;
}

/**
 * Redaction policy defining rules for sensitive data filtering.
 */
export interface RedactionPolicy {
  /** Unique policy identifier */
  id?: string;
  /** Human-readable policy name */
  name?: string;
  /** Description of the policy's purpose */
  description?: string;
  /** Base policy to extend (e.g., 'secrets') */
  extends?: string;
  /** Array of redaction rules */
  rules?: RedactionRule[];
  /** Allowlist patterns */
  allowlist?: Allowlist;
  /** Path filtering configuration */
  paths?: Paths;
}

/**
 * A single redaction rule with pattern matching.
 */
export interface RedactionRule {
  /** Unique rule identifier */
  id: string;
  /** Regex pattern to match sensitive data */
  pattern: string;
  /** Replacement string or placeholder */
  replacement: string;
  /**
   * Optional context strings for rule matching.
   * When provided, the redaction rule will only apply when the content
   * contains at least one of the specified context strings within
   * the contextWindow range.
   */
  context?: string[];
  /**
   * Optional window size for context matching, in characters.
   * Defines how many characters before and after a pattern match
   * to search for context strings. Must be a positive number.
   * Defaults to 0 when context is specified without a window.
   */
  contextWindow?: number;
}

/**
 * List of allowed strings and patterns for filtering.
 */
export interface Allowlist {
  /** Optional array of strings to always allow */
  strings?: string[];
  /** Optional array of regex patterns to always allow */
  patterns?: string[];
}

/**
 * Path filtering configuration for including or excluding specific routes.
 */
export interface Paths {
  /** Optional array of paths to exclusively include */
  only?: string[];
  /** Optional array of paths to skip/exclude */
  skip?: string[];
}

/**
 * A capture file from the logger plugin containing API request/response data.
 */
export interface Capture {
  /** Unique identifier (filename) for the capture */
  id: string;
  /** Session identifier this capture belongs to, if any */
  sessionId: string | null;
  /** Source system that generated the capture */
  source: string | null;
  /** API provider name */
  provider: string;
  /** API format (e.g., 'openai', 'anthropic') */
  apiFormat: string;
  /** Target URL for the API request */
  targetUrl: string;
  /** HTTP method used (GET, POST, etc.) */
  method: string;
  /** Size of request body in bytes */
  requestBytes: number;
  /** Size of response body in bytes */
  responseBytes: number;
  /** HTTP response status code */
  responseStatus: number;
  /** Whether the response is streaming */
  responseIsStreaming: boolean;
  /** ISO timestamp of when the capture was made */
  timestamp: string;
  /** Timing information in milliseconds */
  timings: {
    /** Time in milliseconds to send the request */
    send_ms: number;
    /** Time in milliseconds to wait for response */
    wait_ms: number;
    /** Time in milliseconds to receive the response */
    receive_ms: number;
    /** Total time in milliseconds for the capture */
    total_ms: number;
  };
}

/**
 * Redaction detail for a specific rule match found in captured data.
 */
export interface RedactionMatch {
  /** Identifier of the redaction rule that matched */
  ruleId: string;
  /** Original sensitive value (placeholder) */
  original: string;
  /** The redacted placeholder string (e.g., [EMAIL_1]) */
  placeholder: string;
  /** JSON path where the match was found */
  path: string;
}

/**
 * Redaction information for a capture including counts and matches.
 */
export interface RedactionDetails {
  /** Total number of redactions in this capture */
  totalRedactions: number;
  /** Count of redactions grouped by rule ID */
  byRule: Record<string, number>;
  /** Individual redaction matches with details */
  matches: RedactionMatch[];
}

/**
 * Redaction summary surfaced at the top level of capture detail responses.
 */
export interface CaptureRedactionSummary {
  /** Total number of redactions in this capture */
  totalRedactions: number;
  /** Count of redactions grouped by rule ID */
  byRule: Record<string, number>;
  /** Individual redaction matches with details */
  matches: RedactionMatch[];
}

/**
 * A capture with full details including request/response body and redaction info.
 */
export interface CaptureDetail extends Capture {
  /** Request body as key-value pairs */
  requestBody: Record<string, unknown>;
  /** Response body as string, or null if not available */
  responseBody: string | null;
  /** Redaction details (computed on read) */
  redaction?: RedactionDetails;
  /** Persisted redaction metadata from sidecar */
  redactionMeta?: {
    captureId: string;
    totalRedactions: number;
    byRule: Record<string, number>;
    generatedAt?: string;
  };
  /** Redaction summary */
  totalRedactions: number;
  /** Count of redactions grouped by rule ID */
  byRule: Record<string, number>;
  /** Individual redaction matches with details */
  matches: RedactionMatch[];
  /** Alias for redaction (returned by API for compatibility) */
  redactions?: RedactionDetails;
}

/**
 * A capture with redaction information.
 */
export interface CaptureWithRedaction extends Capture {
  /** Redaction details for this capture */
  redaction: RedactionDetails;
}

/**
 * Pagination metadata for API responses.
 */
export interface PaginationMeta {
  /** Current page number (1-indexed) */
  page: number;
  /** Number of items per page */
  pageSize: number;
  /** Total number of items available */
  total: number;
  /** Total number of pages */
  totalPages: number;
}

/**
 * Generic API response wrapper with optional pagination.
 */
export type APIResponse<T> = {
  /** Response data */
  data: T;
  /** Optional total count for paginated results */
  total?: number;
  /** Optional pagination metadata */
  pagination?: PaginationMeta;
  /** Error message if request failed (optional) */
  error?: string;
};

// --- Metrics ---

/**
 * Aggregated metrics data for API usage and system activity.
 */
export type MetricsData = {
  /** Traffic metrics over time */
  traffic: TrafficMetric[];
  /** Provider usage statistics */
  providers: ProviderUsage[];
  /** Redaction activity metrics */
  redactions: RedactionMetric[];
  /** Total bytes sent in requests */
  totalRequestBytes: number;
  /** Total bytes received in responses */
  totalResponseBytes: number;
  /** Total input tokens across all requests */
  totalInputTokens?: number;
  /** Total output tokens across all responses */
  totalOutputTokens?: number;
  /** Pagination information */
  pagination?: {
    page: number;
    pageSize: number;
    totalPages: number;
    totalItems: number;
  };
};

/**
 * Usage statistics for a specific API provider.
 */
export type ProviderUsage = {
  /** Provider identifier */
  provider: string;
  /** Number of requests made to this provider */
  requestCount: number;
  /** Total input tokens consumed */
  totalInputTokens: number;
  /** Total output tokens generated */
  totalOutputTokens: number;
};

/**
 * Redaction activity metric for a point in time.
 */
export type RedactionMetric = {
  /** ISO timestamp of the metric */
  timestamp: string;
  /** Number of redactions at this time */
  count: number;
};

/**
 * Time range configuration for metrics queries.
 */
export type TimeRange = {
  /** Value identifier for the time range */
  value: string;
  /** Human-readable label for display */
  label: string;
  /** Number of hours in the range */
  hours: number;
};

/**
 * Traffic metric for a point in time.
 */
export type TrafficMetric = {
  /** ISO timestamp of the metric */
  timestamp: string;
  /** Bytes sent in requests */
  requestBytes: number;
  /** Bytes received in responses */
  responseBytes: number;
};

// --- Container Environment Variables ---

/**
 * Environment variable configuration for a container.
 */
export interface ContainerEnvVar {
  /** The environment variable name/key */
  key: string;
  /** The environment variable value */
  value: string;
  /** Optional source identifier for where this variable originated */
  source?: string;
}

// --- Container Logs ---

/**
 * Log level severity types.
 */
export type LogLevel = "error" | "warn" | "info" | "debug";

/**
 * A single log entry from container output.
 */
export interface LogEntry {
  /** Unique identifier for the log entry */
  id: string;
  /** ISO timestamp when the log was recorded */
  timestamp: string;
  /** Log severity level */
  level: LogLevel;
  /** The log message content */
  message: string;
  /** Output stream source (stdout or stderr) */
  source: "stdout" | "stderr";
  /** Associated session ID if the log relates to a specific session */
  sessionId?: string;
}

/**
 * Container runtime information.
 */
export interface ContainerInfo {
  /** Unique container identifier */
  id: string;
  /** Human-readable container name */
  name: string;
  /** Current container status (e.g., 'running', 'stopped', 'exited') */
  status: string;
}

/**
 * Filter criteria for querying log entries.
 */
export interface LogsFilter {
  /** Array of log levels to include */
  levels: LogLevel[];
  /** Search string to filter log messages */
  search: string;
}

/**
 * Options for exporting logs in various formats.
 */
export interface LogsExportOptions {
  /** Output format for the exported logs */
  format: "json" | "text" | "csv";
  /** Filter criteria to apply to the export */
  filter: LogsFilter;
}

// --- Proxy Admin API ---

/**
 * Environment variable configuration for the proxy container.
 */
export interface ProxyEnvVar {
  /** The environment variable name/key */
  key: string;
  /** The environment variable value */
  value: string;
  /** Source of the environment variable */
  source: "process" | "default" | "blacklisted";
}

/**
 * A single log entry from proxy output.
 */
export interface ProxyLogEntry {
  /** Unique identifier for the log entry */
  id: string;
  /** ISO timestamp when the log was recorded */
  timestamp: string;
  /** Log severity level */
  level: LogLevel;
  /** The log message content */
  message: string;
  /** Output stream source (stdout or stderr) */
  source: "stdout" | "stderr";
  /** Associated session ID if the log relates to a specific session */
  sessionId?: string;
}
