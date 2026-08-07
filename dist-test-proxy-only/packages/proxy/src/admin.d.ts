/**
 * Admin API handler for the proxy.
 *
 * Exposes management endpoints for the web UI to query proxy status,
 * environment variables, and logs.
 */
import http from "node:http";
import type { ProxyPlugin } from "@contextio/core";
export interface AdminOptions {
    plugins: ProxyPlugin[];
    logTraffic: boolean;
    startTime: number;
}
export interface ProxyStatus {
    running: boolean;
    pid: number;
    port: number;
    uptime: string;
    sessions: number;
    plugins: string[];
    logTraffic: boolean;
}
export interface ProxyEnvVar {
    key: string;
    value: string;
    source: "process" | "default" | "blacklisted";
}
export interface RateLimiterInternal {
    getAllBucketStates: () => Array<{
        key: string;
        tokens: number;
        maxTokens: number;
        bufferCapacity: number;
        queueLength: number;
        requestsInWindow: number;
        provider?: string;
        sessionId?: string;
    }>;
    getConfigSummary: () => {
        maxRequests: number;
        windowMs: number;
        bufferCapacity: number;
        maxEntries: number;
        enabled: boolean;
    };
}
/** Response format for provider data in admin API. */
export interface ProviderResponse {
    id: string;
    name: string;
    upstreamUrl: string;
    apiFormat: string;
    authType: string;
    enabled: boolean;
    rateLimit: {
        maxRequests: number;
        windowMs: number;
        bufferCapacity: number;
    };
    retry: {
        maxRetries: number;
        baseDelayMs: number;
        maxDelayMs: number;
        retryableStatuses: number[];
        jitterFactor: number;
    };
    customHeaders: Record<string, string>;
    allowBaseUrlOverride: boolean;
    baseUrlOverrideHeader: string;
    source: "default" | "env" | "file";
    dynamic: boolean;
    models: string[] | undefined;
}
export interface LogEntry {
    id: string;
    timestamp: string;
    level: "error" | "warn" | "info" | "debug";
    message: string;
    source: "stdout" | "stderr";
    sessionId?: string;
}
export declare function enableLogCapture(): void;
export declare function getLogs(filter?: {
    levels?: LogEntry["level"][];
    search?: string;
}, limit?: number): LogEntry[];
export declare function clearLogs(): void;
export declare function createAdminHandler(options: AdminOptions): http.RequestListener;
//# sourceMappingURL=admin.d.ts.map