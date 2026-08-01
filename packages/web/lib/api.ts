import type { Session, ProxyStatus, SessionStats, SessionSummary, SessionMetrics, Capture, CaptureWithRedaction, CaptureDetail, APIResponse, ContainerEnvVar, LogEntry, LogsFilter, ProxyEnvVar, RedactionDetails, MetricsData, RateLimiterMetrics } from "@/types/api";
import type { Settings, SettingMeta } from "@/lib/settings";

// API routes are served by the same web server that serves the frontend
// In Docker: web server on port 4041, API routes are internal (/api/*)
// In development: Next.js dev server handles both frontend and API routes
// Use relative URLs for browser requests (same-origin), absolute for server-side
const NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || "";
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:4041";
const PROXY_ADMIN_URL = process.env.NEXT_PUBLIC_PROXY_ADMIN_URL || "http://localhost:4040";

// Get the base URL for web API requests based on context
// In browser: use relative URLs for same-origin requests
// In server-side rendering (SSR): use SITE_URL for absolute URLs
function getApiBaseUrl(): string {
  // If NEXT_PUBLIC_API_URL is explicitly set (non-empty), use it
  // This handles Docker environments where the web UI is served separately
  if (NEXT_PUBLIC_API_URL) return NEXT_PUBLIC_API_URL;
  // For browser requests: empty string means same-origin (relative URLs work)
  // For server-side requests (SSR): use SITE_URL to construct absolute URL
  if (typeof window !== "undefined") {
    return ""; // Browser context - use relative URLs
  }
  return SITE_URL; // Server context - use absolute URL
}

// Get the base URL for proxy admin API requests
// In Docker/combined server: proxy admin API is on the same origin as the web UI
// In development: proxy may run on a different port or host
function getProxyAdminBaseUrl(): string {
  // If explicitly configured, use it (handles dev mode with separate proxy)
  if (PROXY_ADMIN_URL !== "http://localhost:4040") return PROXY_ADMIN_URL;
  // For browser requests in combined server: use relative URLs (same origin)
  if (typeof window !== "undefined") {
    return "";
  }
  // For server-side requests: use absolute URL to localhost
  return PROXY_ADMIN_URL;
}
const DEFAULT_TIMEOUT = 300000; // 5 minutes

interface RetryConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  backoffFactor: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelay: 300,
  maxDelay: 10000,
  backoffFactor: 2,
};

// Type for the metadata sidecar content
export interface CaptureMetadataSidecar {
  captureId?: string;
  totalRedactions: number;
  byRule: Record<string, number>;
  sessionId?: string | null;
  provider?: string;
  targetUrl?: string;
  timestamp?: string;
  generatedAt?: string;
  source?: string | null;
  matches?: Array<{
    ruleId: string;
    preValue: string;
    postValue: string;
    path: string;
  }>;
  requestBytes?: number;
  responseBytes?: number;
  timings?: {
    send_ms?: number;
    wait_ms?: number;
    receive_ms?: number;
    total_ms?: number;
  };
  totalInputTokens?: number;
  totalOutputTokens?: number;
  tokensPerSecond?: number;
  successCount?: number;
  errorCount?: number;
  model?: string | null;
};

/**
 * Determines if an error is transient and should be retried.
 */
function isTransientError(error: unknown, status?: number): boolean {
  if (status) {
    return status === 429 || (status >= 500 && status < 600);
  }
  if (error instanceof Error) {
    // Network errors and timeouts are transient, but AbortError is intentional cancellation
    const msg = error.message.toLowerCase();
    return msg.includes("timeout") || msg.includes("network error") || msg.includes("networkerror") || msg.includes("failed to fetch");
  }
  return false;
}

/**
 * Sleeps for a specified duration in milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class APIClient {
  // CSRF token supplied by the server and refreshed on every API response.
  // Must be echoed back as x-csrf-token on sensitive mutation requests.
  private csrfToken: string | null = null;

  private updateCsrfToken(response: Response): void {
    const token = response.headers.get("x-csrf-token");
    if (token) this.csrfToken = token;
  }

  private csrfHeaders(): HeadersInit {
    if (!this.csrfToken) return {};
    return { "x-csrf-token": this.csrfToken };
  }

  /**
   * Get CSRF headers for external use (e.g., direct fetch calls)
   */
  public getCsrfHeaders(): HeadersInit {
    return this.csrfHeaders();
  }

  /**
   * Combines multiple AbortSignals into a single signal.
   * Aborts when any of the provided signals abort.
   * Returns the combined signal and a cleanup function.
   */
  private combineSignals(signals: AbortSignal[]): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();

    const abortHandler = () => {
      controller.abort();
    };

    const cleanup = () => {
      signals.forEach(signal => {
        signal.removeEventListener("abort", abortHandler);
      });
      controller.signal.removeEventListener("abort", cleanup);
    };

    signals.forEach(signal => {
      signal.addEventListener("abort", abortHandler);
    });

    // Clean up listeners when our controller is aborted
    controller.signal.addEventListener("abort", cleanup);

    return { signal: controller.signal, cleanup };
  }

  private async request<T>(endpoint: string, options?: RequestInit, retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG): Promise<T> {
    let lastError: Error | undefined;
    let retryDelay = retryConfig.initialDelay;

    // Build the full URL - use getApiBaseUrl() for proper context handling
    const baseUrl = getApiBaseUrl();

    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

      // Combine provided signal with timeout controller signal
      const providedSignal = options?.signal;
      const { signal, cleanup } = providedSignal
        ? this.combineSignals([providedSignal, controller.signal])
        : { signal: controller.signal, cleanup: () => {} };

      // Check if already aborted before making request
      if (signal.aborted) {
        clearTimeout(timeoutId);
        cleanup();
        throw new Error("Request aborted");
      }

      try {
        const response = await fetch(`${baseUrl}${endpoint}`, {
          ...options,
          signal,
          headers: {
            "Content-Type": "application/json",
            ...this.csrfHeaders(),
            ...(options?.headers || {}),
          },
        });

        this.updateCsrfToken(response);

        clearTimeout(timeoutId);
        cleanup();

        if (!response.ok) {
          let errorMessage = response.statusText;
          try {
            const errorData = await response.json();
            errorMessage = errorData.error || response.statusText;
          } catch {
            // Response body is not JSON or empty
          }
          const error = new Error(`API request failed: ${response.status} ${errorMessage}`);

          // Check if we should retry for transient errors
          if (attempt < retryConfig.maxRetries && isTransientError(error, response.status)) {
            // Check signal before sleeping
            if (signal.aborted) {
              throw new Error("Request aborted");
            }
            // Add jitter to prevent thundering herd
            const jitter = Math.random() * 100;
            await sleep(retryDelay + jitter);
            retryDelay = Math.min(retryDelay * retryConfig.backoffFactor, retryConfig.maxDelay);
            lastError = error;
            continue;
          }
          throw error;
        }

        let data: T;
        try {
          data = await response.json();
        } catch {
		let bodySnippet = "";
		try {
			const text = await response.clone().text();
			bodySnippet = text.slice(0, 500);
		} catch {}
		throw new Error(
			`Response body could not be parsed as JSON (HTTP ${response.status})\nBody preview: ${bodySnippet}`,
		);
        }
        return data;
      } catch (error) {
        clearTimeout(timeoutId);
        cleanup();

        if (error instanceof Error) {
          if (error.name === "AbortError") {
            throw new Error("Request aborted");
          }

          // Check if we should retry for transient network errors
          if (attempt < retryConfig.maxRetries && isTransientError(error)) {
            // Check signal before sleeping
            if (signal.aborted) {
              throw new Error("Request aborted");
            }
            // Add jitter to prevent thundering herd
            const jitter = Math.random() * 100;
            await sleep(retryDelay + jitter);
            retryDelay = Math.min(retryDelay * retryConfig.backoffFactor, retryConfig.maxDelay);
            lastError = error;
            continue;
          }
          throw error;
        }
        throw new Error("Network error");
      }
    }

    throw lastError || new Error("Request failed");
  }

  async getSessions(page?: number, pageSize?: number): Promise<{ sessions: Session[]; pagination?: { page: number; pageSize: number; totalPages: number; totalItems: number } }> {
    const params = new URLSearchParams();
    if (page !== undefined && page > 0) params.set("page", String(page));
    if (pageSize !== undefined && pageSize > 0) params.set("pageSize", String(pageSize));
    const query = params.toString();
    return this.request(`/api/sessions${query ? `?${query}` : ""}`);
  }

  async getGroupedSessions(page?: number, pageSize?: number): Promise<{
    sessions: Session[];
    summaries: SessionSummary[];
    metrics: Record<string, SessionMetrics>;
    pagination?: {
      page: number;
      pageSize: number;
      totalPages: number;
      totalItems: number;
    };
  }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minutes for grouped sessions
    try {
      const params = new URLSearchParams();
      params.set("groupBySourceDest", "true");
      if (page !== undefined && page > 0) params.set("page", String(page));
      if (pageSize !== undefined && pageSize > 0) params.set("pageSize", String(pageSize));
      return await this.request(`/api/sessions?${params.toString()}`, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getSession(id: string): Promise<Session> {
    return this.request(`/api/sessions/${id}`);
  }

  async getSessionStream(
    id: string,
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<{
    type: "progress" | "complete" | "error";
    current?: number;
    total?: number;
    message?: string;
    data?: {
      session: any;
      metrics: any;
      captures: any[];
    };
    error?: string;
  }>> {
    const response = await fetch(`${getApiBaseUrl()}/api/sessions/${id}/stream`, {
      signal,
      headers: {
        "Content-Type": "application/json",
        ...this.csrfHeaders(),
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error("Session not found");
      }
      throw new Error("Failed to stream session");
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No reader available");

    const decoder = new TextDecoder();
    let buffer = "";

    return (async function* () {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                yield JSON.parse(line.slice(6));
              } catch {
                // Skip malformed lines
              }
            }
          }
        }

        if (buffer.trim()) {
          for (const line of buffer.trim().split("\n")) {
            if (line.startsWith("data: ")) {
              try {
                yield JSON.parse(line.slice(6));
              } catch {
                // Skip malformed lines
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    })();
  }

  async getSessionStats(sessionId: string): Promise<SessionStats> {
    return this.request(`/api/sessions/${sessionId}/stats`);
  }

  async restartProxy(): Promise<{ success: boolean }> {
    return this.request("/api/restart", { method: "POST" });
  }

  async getContainerEnvVars(containerId: string, signal?: AbortSignal): Promise<ContainerEnvVar[]> {
    return this.request(`/api/containers/${containerId}/env`, { signal });
  }

  // Logs API
  async getLogs(containerId: string, filter?: LogsFilter): Promise<LogEntry[]> {
    const params = new URLSearchParams();
    params.set("containerId", encodeURIComponent(containerId));
    if (filter?.levels && filter.levels.length > 0) {
      params.set("levels", filter.levels.join(","));
    }
    if (filter?.search) {
      params.set("search", encodeURIComponent(filter.search));
    }
    const data = await this.request<{ logs: LogEntry[] }>(`/api/logs?${params.toString()}`);
    return data.logs;
  }

  async streamLogs(
    containerId: string,
    onChunk: (log: LogEntry) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const params = new URLSearchParams();
    params.set("containerId", encodeURIComponent(containerId));
    params.set("stream", "true");

    const controller = new AbortController();

    // Combine provided signal with controller signal
    const { signal: combinedSignal, cleanup: cleanupSignal } = signal
      ? this.combineSignals([signal, controller.signal])
      : { signal: controller.signal, cleanup: () => {} };

    const responsePromise = fetch(`${getApiBaseUrl()}/api/logs?${params.toString()}`, {
      signal: combinedSignal,
    });

    try {
      const response = await responsePromise;
      if (!response.ok) throw new Error("Failed to stream logs");

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No reader available");

      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Process any remaining buffer content before exiting
            if (buffer.trim()) {
              try {
                const log: LogEntry = JSON.parse(buffer.trim());
                onChunk(log);
              } catch {
                // Skip malformed final line
              }
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          // Process complete lines, keep incomplete line in buffer
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // Keep the last (possibly incomplete) line
          for (const line of lines) {
            if (line.trim()) {
              try {
                const log: LogEntry = JSON.parse(line);
                onChunk(log);
              } catch {
                // Skip malformed lines
              }
            }
          }
        }
      } finally {
          reader.releaseLock();
          cleanupSignal();
        }
    } catch (error) {
      cleanupSignal();
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Request aborted");
      }
      throw error;
    }
  }

  async clearLogs(containerId: string): Promise<{ success: boolean }> {
    return this.request("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ containerId }),
    });
  }

  async exportLogs(containerId: string, format: "json" | "text" | "csv", filter: LogsFilter): Promise<string> {
    const logs = await this.getLogs(containerId, filter);

    switch (format) {
    case "json":
      return JSON.stringify(logs, null, 2);
    case "csv":
      return this.logsToCsv(logs);
    case "text":
      return logs.map(l => `[${l.timestamp}] [${l.level.toUpperCase()}] [${l.source}] ${l.message}`).join("\n");
    default:
      return JSON.stringify(logs, null, 2);
    }
  }

  private logsToCsv(logs: LogEntry[]): string {
    const header = "id,timestamp,level,source,message,sessionId";
    const rows = logs.map(l =>
      `${l.id},${l.timestamp},${l.level},${l.source},"${l.message.replace(/"/g, '""')}",${l.sessionId || ""}`
    );
    return [header, ...rows].join("\n");
  }

  async getCaptures(filters?: {
    sessionId?: string;
    source?: string;
    status?: string;
    from?: string;
    to?: string;
    redactionType?: string;
    includeRedaction?: boolean;
    page?: number;
    pageSize?: number;
  }): Promise<APIResponse<(Capture | CaptureWithRedaction)[]>> {
    const params = new URLSearchParams();
    if (filters?.sessionId) params.set("sessionId", filters.sessionId);
    if (filters?.source) params.set("source", filters.source);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.from) params.set("from", filters.from);
    if (filters?.to) params.set("to", filters.to);
    if (filters?.redactionType) params.set("redactionType", filters.redactionType);
    if (filters?.includeRedaction) params.set("includeRedaction", "true");
    if (filters?.page) params.set("page", String(filters.page));
    if (filters?.pageSize) params.set("pageSize", String(filters.pageSize));

    const query = params.toString();
    return this.request(`/api/captures${query ? `?${query}` : ""}`);
  }

  async getCapture(id: string): Promise<CaptureDetail> {
  return this.request(`/api/captures/${id}`);
}

  async getCaptureMetadata(id: string): Promise<CaptureMetadataSidecar> {
    return this.request(`/api/captures/${id}/metadata`);
  }

  async redactCapture(
  id: string,
  rules: Array<{ id: string; pattern: string; replacement: string }> = []
): Promise<Capture & { requestBody: Record<string, unknown>; responseBody: string | null; redaction?: RedactionDetails }> {
  return this.request(`/api/captures/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "redact", rules }),
  });
}

async clearCaptures(): Promise<{ success: boolean; deleted: number; errors: number; message: string }> {
    return this.request("/api/captures?action=clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "DELETE_ALL_CAPTURES" }),
    });
  }

  async getSettings(): Promise<{ settings: Settings; metadata: Record<keyof Settings, SettingMeta> }> {
    return this.request("/api/settings");
  }

  async saveSettings(settings: Settings): Promise<{ success: boolean; settings: Settings; metadata: Record<keyof Settings, SettingMeta> }> {
    return this.request("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  }

  // Proxy Admin API methods
  // These connect to the proxy service on port 4040

  async getProxyStatus(signal?: AbortSignal): Promise<ProxyStatus> {
    const baseUrl = getProxyAdminBaseUrl();
    return this.requestWithBase(baseUrl, "/admin/status", { signal });
  }

  async getProxyEnvVars(signal?: AbortSignal): Promise<ProxyEnvVar[]> {
    const baseUrl = getProxyAdminBaseUrl();
    return this.requestWithBase(baseUrl, "/admin/env", { signal });
  }

  async getProxyLogs(filter?: LogsFilter, signal?: AbortSignal): Promise<LogEntry[]> {
    const baseUrl = getProxyAdminBaseUrl();
    const params = new URLSearchParams();
    if (filter?.levels && filter.levels.length > 0) {
      params.set("levels", filter.levels.join(","));
    }
    if (filter?.search) {
      params.set("search", encodeURIComponent(filter.search));
    }
    const data = await this.requestWithBase<{ logs: LogEntry[] }>(baseUrl, `/admin/logs?${params.toString()}`, { signal });
    return data.logs;
  }

  async getRateLimiterMetrics(signal?: AbortSignal): Promise<RateLimiterMetrics> {
    return this.request("/api/admin/rate-limiter", { signal });
  }

  async getMetrics(hours: number = 24, maxPoints?: number, page?: number, pageSize?: number, signal?: AbortSignal): Promise<MetricsData> {
    const params = new URLSearchParams();
    params.set("hours", String(hours));
    if (maxPoints !== undefined && maxPoints > 0) {
      params.set("maxPoints", String(maxPoints));
    }
    if (page !== undefined && page > 0) {
      params.set("page", String(page));
    }
    if (pageSize !== undefined && pageSize > 0) {
      params.set("pageSize", String(pageSize));
    }
    return this.request(`/api/metrics?${params.toString()}`, { signal });
  }

  async getMetricsStream(
    hours: number = 24,
    maxPoints?: number,
    page?: number,
    pageSize?: number,
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<{
    type: "progress" | "complete" | "error";
    current?: number;
    total?: number;
    message?: string;
    data?: MetricsData & { pagination?: { page: number; pageSize: number; totalPages: number; totalItems: number } };
    error?: string;
  }>> {
    const params = new URLSearchParams();
    params.set("hours", String(hours));
    if (maxPoints !== undefined && maxPoints > 0) {
      params.set("maxPoints", String(maxPoints));
    }
    if (page !== undefined && page > 0) {
      params.set("page", String(page));
    }
    if (pageSize !== undefined && pageSize > 0) {
      params.set("pageSize", String(pageSize));
    }

    const response = await fetch(`${getApiBaseUrl()}/api/metrics/stream?${params.toString()}`, {
      signal,
      headers: {
        "Content-Type": "application/json",
        ...this.csrfHeaders(),
      },
    });

    if (!response.ok) {
      throw new Error("Failed to stream metrics");
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No reader available");

    const decoder = new TextDecoder();
    let buffer = "";

    return (async function* () {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                yield JSON.parse(line.slice(6));
              } catch {
                // Skip malformed lines
              }
            }
          }
        }

        if (buffer.trim()) {
          for (const line of buffer.trim().split("\n")) {
            if (line.startsWith("data: ")) {
              try {
                yield JSON.parse(line.slice(6));
              } catch {
                // Skip malformed lines
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    })();
  }

  async streamProxyLogs(
    onChunk: (log: LogEntry) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const baseUrl = getProxyAdminBaseUrl();
    const params = new URLSearchParams();
    params.set("stream", "true");

    const controller = new AbortController();

    // Combine provided signal with controller signal
    const { signal: combinedSignal, cleanup: cleanupSignal } = signal
      ? this.combineSignals([signal, controller.signal])
      : { signal: controller.signal, cleanup: () => {} };

    const responsePromise = fetch(`${baseUrl}/admin/logs?${params.toString()}`, {
      signal: combinedSignal,
    });

    try {
      const response = await responsePromise;
      if (!response.ok) throw new Error("Failed to stream proxy logs");

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No reader available");

      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Process any remaining buffer content before exiting
            if (buffer.trim()) {
              try {
                const log: LogEntry = JSON.parse(buffer.trim());
                onChunk(log);
              } catch {
                // Skip malformed final line
              }
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          // Process complete lines, keep incomplete line in buffer
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // Keep the last (possibly incomplete) line
          for (const line of lines) {
            if (line.trim()) {
              try {
                const log: LogEntry = JSON.parse(line);
                onChunk(log);
              } catch {
                // Skip malformed lines
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
        cleanupSignal();
      }
    } catch (error) {
      cleanupSignal();
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Request aborted");
      }
      throw error;
    }
  }

  /**
   * Make a request with a custom base URL (for proxy admin API)
   */
  private async requestWithBase<T>(
    baseUrl: string,
    endpoint: string,
    options?: RequestInit,
    retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
  ): Promise<T> {
    let lastError: Error | undefined;
    let retryDelay = retryConfig.initialDelay;

    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

      // Combine provided signal with timeout controller signal
      const providedSignal = options?.signal;
      const combined = providedSignal
        ? this.combineSignals([providedSignal, controller.signal])
        : { signal: controller.signal, cleanup: () => {} };
      const { signal, cleanup } = combined;

      // Check if already aborted before making request
      if (signal.aborted) {
        clearTimeout(timeoutId);
        cleanup();
        throw new Error("Request aborted");
      }

      try {
        const response = await fetch(`${baseUrl}${endpoint}`, {
          ...options,
          signal,
          headers: {
            "Content-Type": "application/json",
            ...this.csrfHeaders(),
            ...(options?.headers || {}),
          },
        });

        this.updateCsrfToken(response);

        clearTimeout(timeoutId);

        if (!response.ok) {
          let errorMessage = response.statusText;
          try {
            const errorData = await response.json();
            errorMessage = errorData.error || response.statusText;
          } catch {
            // Response body is not JSON or empty
          }
          const error = new Error(`API request failed: ${response.status} ${errorMessage}`);

          // Check if we should retry for transient errors
          if (attempt < retryConfig.maxRetries && isTransientError(error, response.status)) {
            // Check signal before sleeping
            if (signal.aborted) {
              throw new Error("Request aborted");
            }
            // Add jitter to prevent thundering herd
            const jitter = Math.random() * 100;
            await sleep(retryDelay + jitter);
            retryDelay = Math.min(retryDelay * retryConfig.backoffFactor, retryConfig.maxDelay);
            lastError = error;
            continue;
          }
          throw error;
        }

        let data: T;
        try {
          data = await response.json();
        } catch {
		let bodySnippet = "";
		try {
			const text = await response.clone().text();
			bodySnippet = text.slice(0, 500);
		} catch {}
		throw new Error(
			`Response body could not be parsed as JSON (HTTP ${response.status})\nBody preview: ${bodySnippet}`,
		);
        }
        cleanup();
        return data;
      } catch (error) {
        clearTimeout(timeoutId);
        cleanup();

        if (error instanceof Error) {
          if (error.name === "AbortError") {
            throw new Error("Request aborted");
          }

          // Check if we should retry for transient network errors
          if (attempt < retryConfig.maxRetries && isTransientError(error)) {
            // Check signal before sleeping
            if (signal.aborted) {
              throw new Error("Request aborted");
            }
            // Add jitter to prevent thundering herd
            const jitter = Math.random() * 100;
            await sleep(retryDelay + jitter);
            retryDelay = Math.min(retryDelay * retryConfig.backoffFactor, retryConfig.maxDelay);
            lastError = error;
            continue;
          }
          throw error;
        }
        throw new Error("Network error");
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  async clearProxyLogs(): Promise<{ success: boolean }> {
    const baseUrl = getProxyAdminBaseUrl();
    return this.requestWithBase(baseUrl, "/admin/clear-logs", {
      method: "POST",
    });
  }
}

export const apiClient = new APIClient();
