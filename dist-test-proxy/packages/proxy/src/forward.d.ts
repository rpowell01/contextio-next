/**
 * HTTP forwarding logic: the core of the proxy.
 *
 * Request lifecycle:
 * 1. Buffer incoming request body, decompress if needed
 * 2. Parse JSON, build RequestContext
 * 3. Run onRequest plugin pipeline (redaction happens here)
 * 4. Forward to upstream LLM API
 * 5. For streaming: pipe SSE chunks through onStreamChunk plugins to client
 *    For non-streaming: buffer response, run onResponse plugins, send to client
 * 6. Build CaptureData, fire onCapture plugins (logging happens here)
 *
 * Non-POST requests (GET /v1/models, OPTIONS) are passed through without
 * plugin processing or capture.
 *
 * Zero external dependencies beyond @contextio/core.
 */
import http from "node:http";
import type { ProxyPlugin, ProviderConfig, Upstreams } from "@contextio/core";
export interface ForwardOptions {
    upstreams: Upstreams;
    allowTargetOverride: boolean;
    strictUrlForwarding: boolean;
    plugins: ProxyPlugin[];
    logTraffic: boolean;
    providers: Record<string, ProviderConfig>;
}
/**
 * Create the main `(req, res)` handler for the proxy HTTP server.
 *
 * Pre-computes which plugin hook types are present to skip unnecessary
 * work on the hot path. The returned function is compatible with
 * `http.createServer()`.
 */
export declare function createProxyHandler(opts: ForwardOptions): (req: http.IncomingMessage, res: http.ServerResponse) => void;
//# sourceMappingURL=forward.d.ts.map