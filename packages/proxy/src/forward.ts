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
import https from "node:https";
import url from "node:url";
import zlib from "node:zlib";

import {
  extractSource,
  resolveTargetUrl,
  selectHeaders,
} from "@contextio/core";
import type {
  ApiFormat,
  CaptureData,
  HeaderMap,
  JsonValue,
  ProxyPlugin,
  Provider,
  RequestContext,
  ResponseContext,
  Upstreams,
} from "@contextio/core";

export interface ForwardOptions {
  upstreams: Upstreams;
  allowTargetOverride: boolean;
  plugins: ProxyPlugin[];
  logTraffic: boolean;
}

// --- Plugin pipeline helpers ---

/**
 * Run onRequest hooks as a pipeline: each plugin receives the output of
 * the previous one. If a plugin throws, the error is logged and the
 * pipeline continues with the last successful context (fail-open).
 * Exception: Rate limit errors (statusCode 429) are re-thrown to allow
 * the proxy to return a proper 429 response.
 */
async function runRequestPlugins(
  plugins: ProxyPlugin[],
  ctx: RequestContext,
): Promise<RequestContext> {
  let current = ctx;
  for (const plugin of plugins) {
    if (!plugin.onRequest) continue;
    try {
      current = await plugin.onRequest(current);
    } catch (err: unknown) {
      // Re-throw rate limit errors (429) so the proxy can handle them properly
      if (err instanceof Error && (err as any).statusCode === 429) {
        throw err;
      }
      console.error(
        `Plugin "${plugin.name}" onRequest error:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return current;
}

/** Run onResponse hooks as a pipeline (same fail-open semantics as onRequest). */
async function runResponsePlugins(
  plugins: ProxyPlugin[],
  ctx: ResponseContext,
): Promise<ResponseContext> {
  let current = ctx;
  for (const plugin of plugins) {
    if (!plugin.onResponse) continue;
    try {
      current = await plugin.onResponse(current);
    } catch (err: unknown) {
      console.error(
        `Plugin "${plugin.name}" onResponse error:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return current;
}

/** Fire all onCapture hooks. Errors are logged but never block the response. */
function runCapturePlugins(plugins: ProxyPlugin[], capture: CaptureData): void {
  for (const plugin of plugins) {
    if (!plugin.onCapture) continue;
    try {
      const result = plugin.onCapture(capture);
      // If the hook returns a promise, catch rejections
      if (result && typeof result.catch === "function") {
        result.catch((err: unknown) => {
          console.error(
            `Plugin "${plugin.name}" onCapture async error:`,
            err instanceof Error ? err.message : String(err),
          );
        });
      }
    } catch (err: unknown) {
      console.error(
        `Plugin "${plugin.name}" onCapture error:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Process a stream chunk through onStreamChunk plugins.
 *
 * For SSE (text/event-stream) responses: passes raw chunks to plugins
 * without JSON splitting, since SSE format is "data: {...}\n\n" not
 * concatenated JSON objects. Plugins like retry-plugin handle SSE parsing.
 *
 * For non-streaming responses with concatenated JSON: splits by JSON
 * object boundaries and validates each part.
 */
function processStreamChunk(
  chunk: Buffer,
  sessionId: string | null,
  plugins: ProxyPlugin[],
  hasStreamPlugins: boolean,
  jsonBuffer: string,
  isStreaming: boolean,
): { processedParts: Buffer[]; remainingBuffer: string } {
  const text = chunk.toString("utf8");
  const fullText = jsonBuffer ? jsonBuffer + text : text;

  // For SSE streams, don't split by JSON boundaries - SSE format is
  // "data: {...}\n\n" which doesn't match the }{ pattern.
  // Pass the raw chunk to plugins that handle SSE parsing (e.g., retry-plugin).
  if (isStreaming) {
    let buf = Buffer.from(fullText, "utf8");

    // Run plugins on the raw SSE chunk
    if (hasStreamPlugins) {
      for (const plugin of plugins) {
        if (!plugin.onStreamChunk) continue;
        try {
          let ret: unknown = plugin.onStreamChunk(buf, sessionId);
          if (ret instanceof SharedArrayBuffer) {
            ret = Buffer.from(Buffer.from(ret as ArrayBufferLike));
          }
          if (ret instanceof Buffer) {
            buf = ret;
          }
        } catch (err: unknown) {
          console.error(
            `Plugin "${plugin.name}" onStreamChunk error:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    // For SSE, we don't buffer incomplete parts - each chunk is processed
    // independently by the plugin's internal SSE parser.
    return { processedParts: [buf], remainingBuffer: "" };
  }

  // Non-streaming: split concatenated JSON objects by }{ boundary
  const parts = fullText.split(/(?<=})\s*(?={)/);
  const processedParts: Buffer[] = [];
  let remainingBuffer = "";

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    let buf = Buffer.from(part, "utf8");

    // Run plugins on each part individually
    if (hasStreamPlugins) {
      for (const plugin of plugins) {
        if (!plugin.onStreamChunk) continue;
        try {
          let ret: unknown = plugin.onStreamChunk(buf, sessionId);
          if (ret instanceof SharedArrayBuffer) {
            ret = Buffer.from(Buffer.from(ret as ArrayBufferLike));
          }
          if (ret instanceof Buffer) {
            buf = ret;
          }
        } catch (err: unknown) {
          console.error(
            `Plugin "${plugin.name}" onStreamChunk error:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    // Only process complete JSON objects; save incomplete trailing part
    const isLastPart = i === parts.length - 1;
    const looksComplete = part.trim().endsWith("}");
    if (isLastPart && !looksComplete) {
      // Save incomplete trailing part for next chunk
      remainingBuffer = part;
    } else {
      const trimmed = part.trim();
      const startsObject = trimmed.startsWith("{");
      const endsObject = trimmed.endsWith("}");
      if (startsObject && endsObject) {
        try {
          JSON.parse(trimmed);
        } catch {
          console.error(
            "Malformed JSON in SSE stream, skipping invalid part",
          );
          continue;
        }
      }
      processedParts.push(buf);
    }
  }

  return { processedParts, remainingBuffer: remainingBuffer };
}

// --- Header / lifecycle helpers ---

/**
 * Build headers for the upstream request.
 *
 * Strips proxy-internal headers (x-target-url, host) and removes
 * accept-encoding so upstreams return uncompressed responses. The proxy
 * needs to read and potentially modify response bodies as text;
 * compression between localhost and client is pointless anyway.
 */
function buildForwardHeaders(
   reqHeaders: HeaderMap,
   targetHost: string | null,
   bodyLength?: number,
 ): HeaderMap {
   const forwardHeaders: HeaderMap = { ...reqHeaders };
   delete forwardHeaders["x-target-url"];
   delete forwardHeaders.host;
   delete forwardHeaders["accept-encoding"];
   delete forwardHeaders["x-retry-id"];
   if (targetHost) {
     forwardHeaders.host = targetHost;
   }
   if (bodyLength != null) {
     delete forwardHeaders["transfer-encoding"];
     forwardHeaders["content-length"] = String(bodyLength);
   }
   return forwardHeaders;
 }

/**
 * Assemble a CaptureData record from the completed request/response cycle.
 *
 * Stores both the plugin-processed body (`ctx.body`) and the original
 * unmodified body. The captured `requestBody` is redacted/placeholder
 * text; `originalRequestBody` preserves the real values so the UI can
 * display true pre-redaction values.
 *
 * Security note: `originalRequestBody` contains unredacted sensitive data.
 */
function buildCaptureData(options: {
  sessionId: string | null;
  req: http.IncomingMessage;
  cleanPath: string;
  source: string | null;
  provider: string;
  apiFormat: string;
  targetUrl: string;
  ctx: RequestContext;
  originalBody: JsonValue | null;
  reqBytes: number;
  proxyRes: http.IncomingMessage;
  finalBody: string;
  isStreaming: boolean;
  respBytes: number;
  timings: CaptureData["timings"];
}): CaptureData {
  return {
    timestamp: new Date().toISOString(),
    sessionId: options.sessionId,
    method: options.req.method!,
    path: options.cleanPath,
    source: options.source,
    provider: options.provider,
    apiFormat: options.apiFormat,
    targetUrl: options.targetUrl,
    requestHeaders: selectHeaders(options.ctx.headers),
    requestBody: options.ctx.body,
    originalRequestBody: options.originalBody,
    requestBytes: options.reqBytes,
    captureId: options.ctx.captureId,
    redactionStats: options.ctx.redactionStats,
    responseStatus: options.proxyRes.statusCode || 0,
    responseHeaders: selectHeaders(options.proxyRes.headers as HeaderMap),
    responseBody: options.finalBody,
    responseIsStreaming: options.isStreaming,
    responseBytes: options.respBytes,
    timings: options.timings,
  };
}

/**
 * Reclassify provider based on upstream response headers and body.
 * This provides defense-in-depth when request-based classification was ambiguous.
 */
function reclassifyProviderFromResponse(
  initialProvider: string,
  proxyRes: http.IncomingMessage,
  responseBody: string,
  logTraffic: boolean,
): { provider: string; apiFormat: string; reclassified: boolean } {
  const headers = proxyRes.headers as Record<string, string | undefined>;
  const serverHeader = headers["server"]?.toLowerCase() || "";
  const poweredByHeader = headers["x-powered-by"]?.toLowerCase() || "";
  const viaHeader = headers["via"]?.toLowerCase() || "";

  // Provider detection patterns from response headers
  if (
    serverHeader.includes("nvidia") ||
    poweredByHeader.includes("nvidia") ||
    viaHeader.includes("nvidia")
  ) {
    return { provider: "nvidia", apiFormat: "chat-completions", reclassified: true };
  }

  if (
    serverHeader.includes("openrouter") ||
    poweredByHeader.includes("openrouter") ||
    viaHeader.includes("openrouter")
  ) {
    return { provider: "openrouter", apiFormat: "chat-completions", reclassified: true };
  }

  if (
    serverHeader.includes("kilo") ||
    poweredByHeader.includes("kilo") ||
    viaHeader.includes("kilo")
  ) {
    return { provider: "kilo", apiFormat: "chat-completions", reclassified: true };
  }

  if (
    serverHeader.includes("anthropic") ||
    poweredByHeader.includes("anthropic")
  ) {
    return { provider: "anthropic", apiFormat: "anthropic-messages", reclassified: true };
  }

  if (
    serverHeader.includes("google") ||
    poweredByHeader.includes("google") ||
    poweredByHeader.includes("generativelanguage") ||
    viaHeader.includes("google")
  ) {
    return { provider: "gemini", apiFormat: "gemini", reclassified: true };
  }

  if (
    serverHeader.includes("chatgpt") ||
    poweredByHeader.includes("chatgpt") ||
    serverHeader.includes("openai-chatgpt")
  ) {
    return { provider: "chatgpt", apiFormat: "chatgpt-backend", reclassified: true };
  }

  if (
    serverHeader.includes("openai") ||
    poweredByHeader.includes("openai") ||
    serverHeader.includes("chat.openai.com") ||
    serverHeader.includes("api.openai.com")
  ) {
    return { provider: "openai", apiFormat: "chat-completions", reclassified: true };
  }

  // Check response body for provider-specific patterns
  if (responseBody) {
    try {
      const parsed = JSON.parse(responseBody);

      // OpenAI Responses API format
      if (parsed.object === "chat.completion" || parsed.object === "completion") {
        return { provider: "openai", apiFormat: "chat-completions", reclassified: true };
      }

      // OpenAI chat.completions format
      if (parsed.choices && Array.isArray(parsed.choices) && parsed.choices[0]?.message) {
        return { provider: "openai", apiFormat: "chat-completions", reclassified: true };
      }

      // Anthropic Messages format
      if (parsed.type === "message" && parsed.content && Array.isArray(parsed.content)) {
        return { provider: "anthropic", apiFormat: "anthropic-messages", reclassified: true };
      }

      // Gemini format
      if (parsed.candidates && Array.isArray(parsed.candidates) && parsed.candidates[0]?.content) {
        return { provider: "gemini", apiFormat: "gemini", reclassified: true };
      }

      // NVIDIA may return OpenAI-compatible format, but check for specific fields
      if (parsed.model && typeof parsed.model === "string" && parsed.model.includes("nvidia")) {
        return { provider: "nvidia", apiFormat: "chat-completions", reclassified: true };
      }

      // OpenRouter often includes provider info
      if (parsed.provider && typeof parsed.provider === "string") {
        const providerName = parsed.provider.toLowerCase();
        if (providerName.includes("nvidia")) {
          return { provider: "nvidia", apiFormat: "chat-completions", reclassified: true };
        }
        if (providerName.includes("openrouter")) {
          return { provider: "openrouter", apiFormat: "chat-completions", reclassified: true };
        }
      }
    } catch {
      // Not JSON, ignore
    }
  }

  // No reclassification possible - keep original
  return { provider: initialProvider, apiFormat: "", reclassified: false };
}

/**
 * Wire up error and close handlers between client and upstream.
 *
 * If the client disconnects, destroy the upstream request. If the
 * upstream errors, send a 502 to the client.
 */
function attachLifecycleHandlers(
  res: http.ServerResponse,
  proxyReq: http.ClientRequest,
): void {
  res.on("close", () => {
    if (!proxyReq.destroyed) proxyReq.destroy();
  });

  proxyReq.on("error", (err) => {
    if (res.destroyed) return;
    const detail = err.message || ("code" in err ? err.code : "unknown");
    console.error("Proxy error:", detail);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    if (!res.destroyed) {
      res.end(JSON.stringify({ error: "Proxy error", details: err.message }));
    }
  });
}

/**
 * Prepare headers for route resolution.
 *
 * The `x-target-url` header lets mitmproxy specify the original
 * destination, but is only trusted when `allowTargetOverride` is enabled.
 */
function headersForResolution(
  headers: http.IncomingHttpHeaders,
  allowTargetOverride: boolean,
  logTraffic: boolean,
): Record<string, string | undefined> {
  const h = headers as Record<string, string | undefined>;
  if (logTraffic) {
    console.error(
      `[DEBUG] headersForResolution: allowTargetOverride=${allowTargetOverride}`,
    );
    console.error(`[DEBUG] x-target-url present: ${!!h["x-target-url"]}`);
  }
  if (h["x-target-url"] && !allowTargetOverride) {
    const { "x-target-url": _drop, ...rest } = h;
    return rest;
  }
  return h;
}

// --- Passthrough for non-POST ---

/**
 * Forward a non-POST request (GET /v1/models, OPTIONS, etc.) directly
 * to the upstream. No plugin processing, no capture.
 */
function forwardPassthrough(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetUrl: string,
  body: Buffer | null,
): void {
  const targetParsed = url.parse(targetUrl);
  const forwardHeaders = buildForwardHeaders(
    req.headers as HeaderMap,
    targetParsed.host,
    body ? body.length : undefined,
  );

  const protocol = targetParsed.protocol === "https:" ? https : http;
  const proxyReq = protocol.request(
    {
      hostname: targetParsed.hostname,
      port: targetParsed.port,
      path: targetParsed.path,
      method: req.method,
      headers: forwardHeaders,
    },
    (proxyRes) => {
      if (!res.headersSent)
        res.writeHead(proxyRes.statusCode!, proxyRes.headers);
      proxyRes.pipe(res);
      proxyRes.on("error", (err) => {
        console.error("Upstream response error (forward):", err.message);
        if (!res.destroyed) res.end();
      });
    },
  );

  attachLifecycleHandlers(res, proxyReq);
  if (body) proxyReq.write(body);
  proxyReq.end();
}

// --- Main handler ---

/**
 * Create the main `(req, res)` handler for the proxy HTTP server.
 *
 * Pre-computes which plugin hook types are present to skip unnecessary
 * work on the hot path. The returned function is compatible with
 * `http.createServer()`.
 */
export function createProxyHandler(
  opts: ForwardOptions,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const plugins = opts.plugins;
  const hasRequestPlugins = plugins.some((p) => p.onRequest);
  const hasResponsePlugins = plugins.some((p) => p.onResponse);
  const hasStreamPlugins = plugins.some((p) => p.onStreamChunk);
  const hasCapturePlugins = plugins.some((p) => p.onCapture);

  return function handleProxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const parsedUrl = url.parse(req.url!);
    const {
      source: urlSource,
      sessionId: urlSessionId,
      cleanPath,
    } = extractSource(parsedUrl.pathname!);

    // Extract session ID and source from routing headers
    const headers = req.headers as Record<string, string | undefined>;
    // Priority: provider-specific session headers, x-session-affinity (generic),
    // x-claude-code-session-id (Anthropic/Claude Code), URL-embedded
    let sessionId: string | null =
      headers["x-kilo-session"] ||
      headers["x-session-affinity"] ||
      headers["x-claude-code-session-id"] ||
      urlSessionId;
    // Extract source from headers in priority order, fallback to URL source
    let source: string | null | undefined = headers["x-real-ip"]?.trim();
    if (!source) {
      source = headers["x-forwarded-for"];
      if (source) {
        // X-Forwarded-For can contain multiple IPs, take the first one
        source = source.split(",")[0].trim();
      }
    }
    if (!source) {
      source = headers["x-session-affinity"]?.trim();
    }
    if (!source) {
      source = urlSource;
    }
    if (!source) {
      source = "unknown";
    }

    const search = parsedUrl.search || null;

    if (opts.logTraffic) {
      console.error(
        `[DEBUG] handleProxy: path=${parsedUrl.pathname}, cleanPath=${cleanPath}`,
      );
      console.error(
        `[DEBUG] Raw headers: ${JSON.stringify(req.headers, null, 2)}`,
      );
    }

    const routingHeaders = headersForResolution(
      req.headers,
      opts.allowTargetOverride,
      opts.logTraffic,
    );

    if (opts.logTraffic) {
      console.error(
        `[DEBUG] Routing headers: ${JSON.stringify(routingHeaders, null, 2)}`,
      );
    }

    const { targetUrl, provider, apiFormat } = resolveTargetUrl(
      cleanPath,
      search,
      routingHeaders,
      opts.upstreams,
    );

    if (opts.logTraffic) {
      const hasAuth = !!req.headers.authorization;
      const headerKeys = Object.keys(req.headers);
      console.error(
        `[DEBUG] Routing: provider=${provider}, apiFormat=${apiFormat}, targetUrl=${targetUrl}, auth=${hasAuth}`,
      );
      console.error(
        `[DEBUG] Headers: ${headerKeys.map((k) => `${k}=${req.headers[k]}`).join(", ")}`,
      );
    }

    if (!targetUrl) {
      if (opts.logTraffic) {
        console.error(
          `[DEBUG] Unknown provider for path '${cleanPath}', provider=${provider}`,
        );
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `Unable to route request: unknown provider for path '${cleanPath}'`,
            type: "route_error",
            provider,
          },
        }),
      );
      return;
    }

    if (opts.logTraffic) {
      const hasAuth = !!req.headers.authorization;
      const sourceTag = source ? `[${source}]` : "";
      console.error(
        `${req.method} ${req.url} → ${targetUrl} [${provider}] ${sourceTag} auth=${hasAuth}`,
      );
    }

    // Non-POST requests: pass through without plugins or capturing
    if (req.method !== "POST") {
      forwardPassthrough(req, res, targetUrl, null);
      return;
    }

  // Pre-assign captureId so plugins (redact, logger) can use it.
  // Logger plugin will use this verbatim in its filename; the redact plugin
  // will write {captureId}.redact-meta.json to the same capture dir.
  const captureId: string | null =
    source !== null && source !== undefined
      ? `${source.replace(/[^a-zA-Z0-9_-]/g, "_")}_${sessionId ?? "null"}_${Date.now()}-${String(Math.floor(Math.random() * 999_999)).padStart(6, "0")}.json`
      : null;

  // Buffer the request body (must be declared before the event handlers below)
  const chunks: Buffer[] = [];
  let clientAborted = false;

  req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("error", () => {
      clientAborted = true;
    });

    req.on("end", () => {
      if (clientAborted) return;

      const bodyBuffer = Buffer.concat(chunks);
      const contentEncoding = (
        req.headers["content-encoding"] || ""
      ).toLowerCase();

      // Decompress the body so plugins can inspect/modify it as text.
      // The original compressed buffer is kept; if no plugin modifies
      // the body, we forward the original bytes to avoid re-compression.
      let decompressed: Buffer;
      try {
        if (contentEncoding === "zstd") {
          decompressed = zlib.zstdDecompressSync(bodyBuffer);
        } else if (contentEncoding === "br") {
          decompressed = zlib.brotliDecompressSync(bodyBuffer);
        } else if (
          contentEncoding === "gzip" ||
          contentEncoding === "deflate"
        ) {
          decompressed = zlib.unzipSync(bodyBuffer);
        } else {
          decompressed = bodyBuffer;
        }
      } catch {
        // Decompression failed; use raw bytes
        decompressed = bodyBuffer;
      }

      const bodyText = decompressed.toString("utf8");

      // Try to parse as JSON, but forward regardless
      let bodyJson: JsonValue | null = null;
      try {
        bodyJson = JSON.parse(bodyText) as JsonValue;
      } catch {
        // Not JSON; forward as raw bytes
      }

      // Build the request context for plugins
  const reqCtx: RequestContext = {
  provider,
  apiFormat,
  path: cleanPath,
  source,
  sessionId,
  headers: { ...req.headers } as HeaderMap,
  body: bodyJson,
  rawBody: bodyBuffer,
  captureId: captureId ?? undefined,
  targetUrl,
};

      // Run the async plugin pipeline, then forward.
      // doForward is a closure so it can reference bodyBuffer, bodyJson,
      // contentEncoding, and the timing/capture variables from the outer scope
      // without threading them through as parameters.
      const doForward = (ctx: RequestContext): void => {
        // If a plugin modified the body, re-serialize as plain JSON.
        // Otherwise forward the original bytes (possibly still compressed)
        // to avoid needlessly re-encoding what the upstream already sent.
        //
        // For retries, ctx.rawBody carries the original request body buffer.
        // If provided and different from the outer bodyBuffer, use it directly
        // since it represents the exact bytes that should be retried.
        let forwardBuffer: Buffer;
        let bodyWasModified = false;
        const isRetryWithOriginalBody = ctx.rawBody !== undefined && ctx.rawBody !== bodyBuffer;
        if (isRetryWithOriginalBody) {
          // Retry path: use the original body buffer passed via ctx.rawBody
          forwardBuffer = ctx.rawBody;
        } else if (ctx.body && ctx.body !== bodyJson) {
          // Normal path: plugin modified the body, re-serialize
          forwardBuffer = Buffer.from(JSON.stringify(ctx.body), "utf8");
          bodyWasModified = true;
        } else {
          // Normal path: no modification, use outer bodyBuffer
          forwardBuffer = bodyBuffer;
        }

        // Strip content-encoding when we re-serialized; the new body
        // is plain JSON, not compressed.
        if (bodyWasModified && contentEncoding) {
          delete ctx.headers["content-encoding"];
        }

        const targetParsed = url.parse(targetUrl);
        const forwardHeaders = buildForwardHeaders(
          ctx.headers,
          targetParsed.host,
          forwardBuffer.length,
        );

        const protocol = targetParsed.protocol === "https:" ? https : http;
        const startTime = performance.now();
        let firstByteTime = 0;
        let requestSentTime = 0;
        const reqBytes = forwardBuffer.length;

        const proxyReq = protocol.request(
          {
            hostname: targetParsed.hostname,
            port: targetParsed.port,
            path: targetParsed.path,
            method: req.method,
            headers: forwardHeaders,
          },
          (proxyRes) => {
            if (opts.logTraffic) {
              console.log(
                `  ← ${proxyRes.statusCode} ${proxyRes.statusMessage}`,
              );
            }

            const isStreaming =
              proxyRes.headers["content-type"]?.includes("text/event-stream");
            let respBytes = 0;
            const respChunks: Buffer[] = [];

            // Buffer data to handle partial JSON objects across chunk boundaries
            let jsonBuffer = "";

            // Check if retry plugin is active
            const hasRetryPlugin = plugins.some((p) => p.name === "retry");

            // Buffer the full response when:
            // - response plugins are active AND response is not streaming (existing behavior), OR
            // - retry plugin is active AND response is streaming (new: enable streaming retries)
            const shouldBufferResponse = (hasResponsePlugins && !isStreaming) || (hasRetryPlugin && isStreaming);

            // When buffering streaming for retry, we still need to run onStreamChunk for error detection
            // but we don't write to client until we know no retry is needed
            const shouldBufferStreamForRetry = hasRetryPlugin && isStreaming;
            const streamBufferChunks: Buffer[] = [];

            if (!shouldBufferResponse) {
              // Stream directly to client
              const headers = {
                ...proxyRes.headers,
                ...(captureId ? { "x-contextio-capture-id": captureId } : {}),
              };
              res.writeHead(proxyRes.statusCode!, headers);
            }

            proxyRes.on("data", (chunk: Buffer) => {
              if (!firstByteTime) firstByteTime = performance.now();
              respBytes += chunk.length;
              respChunks.push(chunk);

              // Extract session ID from streaming response (fallback for all providers)
              // Many LLM providers include an "id" field in their streaming responses
              // (e.g., OpenAI: "chatcmpl-...", Anthropic: "msg_...", Kilo: "gen-...")
              // We only use this as a fallback when no session ID was found in headers/URL
              if (!sessionId && isStreaming) {
                try {
                  const text = chunk.toString("utf8");
                  // SSE format: "data: {...}\n\n" or multiple "data: " lines
                  const dataLines = text
                    .split("\n")
                    .filter((line) => line.startsWith("data: "));
                  for (const line of dataLines) {
                    const jsonStr = line.slice(6).trim(); // Remove "data: " prefix
                    if (jsonStr && jsonStr !== "[DONE]") {
                      const parsed = JSON.parse(jsonStr);
                      if (parsed.id && typeof parsed.id === "string") {
                        sessionId = parsed.id;
                        break;
                      }
                    }
                  }
                } catch {
                  // Ignore parse errors, sessionId will remain from headers/URL
                }
              }

              if (!shouldBufferResponse && !res.destroyed) {
                // Normal streaming: process stream plugins and write directly to client
                // Ensure JSON objects are separated to avoid concatenation errors
                let outBuffer: Buffer = chunk;
                if (hasStreamPlugins && isStreaming) {
                  // Use helper to process chunk through stream plugins
                  const result = processStreamChunk(
                    chunk,
                    sessionId,
                    plugins,
                    hasStreamPlugins,
                    jsonBuffer,
                    true, // isStreaming
                  );
                  outBuffer = Buffer.concat(result.processedParts);
                  jsonBuffer = result.remainingBuffer;
                } else if (hasStreamPlugins) {
                  // Non-streaming plugins still operate on whole chunk
                  for (const plugin of plugins) {
                    if (!plugin.onStreamChunk) continue;
                    try {
                      outBuffer = plugin.onStreamChunk(outBuffer, sessionId);
                    } catch (err: unknown) {
                      console.error(
                        `Plugin "${plugin.name}" onStreamChunk error:`,
                        err instanceof Error ? err.message : String(err),
                      );
                    }
                  }
                }
                res.write(outBuffer);
              } else if (shouldBufferStreamForRetry) {
                // We're buffering streaming response for retry - still run stream plugins
                // for error detection, but buffer the processed chunks instead of writing to client
                if (hasStreamPlugins && isStreaming) {
                  // Use helper to process chunk through stream plugins
                  const result = processStreamChunk(
                    chunk,
                    sessionId,
                    plugins,
                    hasStreamPlugins,
                    jsonBuffer,
                    true, // isStreaming
                  );
                  const outBuffer = Buffer.concat(result.processedParts);
                  streamBufferChunks.push(outBuffer);
                  jsonBuffer = result.remainingBuffer;
                } else {
                  // No stream plugins, just buffer the raw chunk
                  streamBufferChunks.push(chunk);
                }
              }
            });

            proxyRes.on("end", () => {
              const endTime = performance.now();
              if (!firstByteTime) firstByteTime = endTime;

              // Flush any buffered data from stream plugins
              if (hasStreamPlugins && isStreaming && !res.destroyed) {
                for (const plugin of plugins) {
                  if (!plugin.onStreamEnd) continue;
                  try {
                    const flushed = plugin.onStreamEnd(sessionId);
                    if (flushed && flushed.length > 0) {
                      if (shouldBufferStreamForRetry) {
                        streamBufferChunks.push(flushed);
                      } else {
                        res.write(flushed);
                      }
                    }
                  } catch (err: unknown) {
                    console.error(
                      `Plugin "${plugin.name}" onStreamEnd error:`,
                      err instanceof Error ? err.message : String(err),
                    );
                  }
                }
              }

              // Check for streaming retry signal from retry plugin
              // This allows retrying SSE responses that ended with an error event
              if (shouldBufferStreamForRetry && !res.destroyed) {
                const retryPlugin = plugins.find((p) => p.name === "retry");
                const pendingRetry =
                  retryPlugin &&
                  typeof (retryPlugin as any)._internal?.getAndConsumePendingStreamRetry === "function"
                    ? (retryPlugin as any)._internal.getAndConsumePendingStreamRetry(sessionId)
                    : null;
                if (pendingRetry) {
                  // Use modified body for NVIDIA retries if available, otherwise use original
                  const bodyBuffer = pendingRetry.modifiedBodyBuffer ?? pendingRetry.originalBodyBuffer;
                  let bodyJson = pendingRetry.originalBodyJson;
                  if (bodyBuffer === pendingRetry.modifiedBodyBuffer && bodyBuffer) {
                    try {
                      bodyJson = JSON.parse(bodyBuffer.toString("utf8"));
                    } catch (parseErr) {
                      console.error("Failed to parse modified body for streaming retry, using original:", parseErr);
                      bodyJson = pendingRetry.originalBodyJson;
                    }
                  }

                  // Don't end the response yet - just re-issue the request
                  // The new response will replace the current one
                  // Apply retry delay before re-issuing request
                  const delayMs = pendingRetry.delayMs;
                  const attemptRetry = () => {
                    if (res.destroyed) {
                      // Client disconnected during delay - clean up and end response
                      console.debug("[forward] Client disconnected during streaming retry delay, ending response");
                      if (!res.headersSent) {
                        res.writeHead(504, { "Content-Type": "application/json" });
                      }
                      res.end(JSON.stringify({ error: { message: "Gateway timeout", type: "gateway_timeout" } }));
                      return;
                    }
                    try {
                      doForward({
                        ...currentCtx,
                        rawBody: bodyBuffer,
                        body: bodyJson ?? currentCtx.body,
                        captureId: pendingRetry.captureId ?? currentCtx.captureId,
                      });
                    } catch (err) {
                      console.error("Streaming retry doForward error:", err);
                      // If doForward throws synchronously, end the response
                      if (!res.headersSent) {
                        res.writeHead(500, { "Content-Type": "application/json" });
                      }
                      res.end(JSON.stringify({ error: { message: "Internal server error", type: "internal_error" } }));
                    }
                  };
                  if (delayMs > 0) {
                    setTimeout(attemptRetry, delayMs);
                  } else {
                    attemptRetry();
                  }
                  return;
                }
              }

              const respBody = Buffer.concat(respChunks).toString("utf8");

              // finishResponse is called once the response body is final:
              // either immediately after the upstream ends (non-buffered path)
              // or after response plugins have run (buffered path). It writes
              // headers+body to the client, then fires capture plugins.
              const finishResponse = (
                finalBody: string | Buffer,
                finalHeaders: HeaderMap,
                finalStatus: number,
              ): void => {
                if (shouldBufferResponse && !res.headersSent && !res.destroyed) {
                  const outBuf = Buffer.isBuffer(finalBody) ? finalBody : Buffer.from(finalBody, "utf8");
                  const outHeaders = { ...finalHeaders };
                  outHeaders["content-length"] = String(outBuf.length);
                  delete outHeaders["transfer-encoding"];
                  res.writeHead(finalStatus, outHeaders);
                  res.end(outBuf);
                } else if (!res.destroyed) {
                  res.end();
                }

                // Build capture and run capture plugins
                if (hasCapturePlugins) {
                  const timings: CaptureData["timings"] = {
                    send_ms: Math.round(
                      Math.max(
                        0,
                        (requestSentTime || firstByteTime) - startTime,
                      ),
                    ),
                    wait_ms: Math.round(
                      Math.max(
                        0,
                        firstByteTime - (requestSentTime || startTime),
                      ),
                    ),
                    receive_ms: Math.round(endTime - firstByteTime),
                    total_ms: Math.round(endTime - startTime),
                  };

                  // Skip capture for title-generation requests (internal UI feature)
                  if (sessionId?.startsWith("title-")) {
                    if (opts.logTraffic) {
                      console.log("[DEBUG] Skipping capture for title-generation request");
                    }
                  } else {
                    // Response-based provider reclassification (defense-in-depth)
                    // This catches cases where request-based classification was ambiguous
                    // but the upstream response identifies the actual provider
                    const finalBodyStr = Buffer.isBuffer(finalBody) ? finalBody.toString("utf8") : finalBody;
                    const reclassified = reclassifyProviderFromResponse(
                      provider,
                      proxyRes,
                      finalBodyStr,
                      opts.logTraffic,
                    );
                    const captureProvider: Provider = reclassified.reclassified
                      ? (reclassified.provider as Provider)
                      : provider;
                    const captureApiFormat: ApiFormat = reclassified.reclassified
                      ? (reclassified.apiFormat as ApiFormat)
                      : apiFormat;
                    if (reclassified.reclassified && opts.logTraffic) {
                      console.error(
                        `[FORWARD] Provider reclassified from ${provider} to ${captureProvider} based on response`,
                      );
                    }

                    const capture = buildCaptureData({
                      sessionId,
                      req,
                      cleanPath,
                      source,
                      provider: captureProvider,
                      apiFormat: captureApiFormat,
                      targetUrl,
                      ctx,
                      originalBody: bodyJson,
                      reqBytes,
                      proxyRes,
                      finalBody: finalBodyStr,
                      isStreaming: !!isStreaming,
                      respBytes,
                      timings,
                    });
                                      runCapturePlugins(plugins, capture);
                  }
                }
              };

              // Handle response based on buffering mode
              if (shouldBufferStreamForRetry) {
                // Streaming response was buffered for retry, but no retry was needed
                // Delegate to finishResponse to write headers/body and run capture
                const streamBody = Buffer.concat(streamBufferChunks);
                const streamHeaders: HeaderMap = {
                  ...(proxyRes.headers as HeaderMap),
                  ...(captureId ? { "x-contextio-capture-id": captureId } : {}),
                };
                finishResponse(streamBody, streamHeaders, proxyRes.statusCode || 0);
              } else if (shouldBufferResponse) {
                const retryId = currentCtx.headers["x-retry-id"];
                const respCtx: ResponseContext = {
                  status: proxyRes.statusCode || 0,
                  headers: {
                    ...((proxyRes.headers as HeaderMap) || {}),
                    ...(retryId ? { "x-retry-id": retryId } : {}),
                    ...(captureId ? { "x-contextio-capture-id": captureId } : {}),
                  },
                  body: respBody,
                  isStreaming: false,
                  sessionId,
                };
                runResponsePlugins(plugins, respCtx)
                  .then((finalCtx) => {
                    // Retry signal from retry plugin (status 599)
                    if (finalCtx.status === 599) {
                      // Re-issue the upstream request with the ORIGINAL request body
                      // (from retry plugin's buffer) to ensure retries send the exact same request
                      try {
                        // Extract retry ID from headers (present in finalCtx.headers from retry plugin's response)
                        const retryIdHeader = finalCtx.headers["x-retry-id"];
                        let retryId: string | null = null;
                        if (retryIdHeader && typeof retryIdHeader === "string") {
                          retryId = retryIdHeader;
                        } else if (Array.isArray(retryIdHeader) && retryIdHeader.length > 0) {
                          retryId = retryIdHeader[0];
                        }

                        // Also extract captureId from headers (used as primary key in retry plugin)
                        // Note: captureId is in finalCtx.headers (ResponseContext from onResponse), not currentCtx.headers (RequestContext)
                        const captureIdHeader = finalCtx.headers["x-contextio-capture-id"];
                        let captureId: string | null = null;
                        if (captureIdHeader && typeof captureIdHeader === "string") {
                          captureId = captureIdHeader;
                        } else if (Array.isArray(captureIdHeader) && captureIdHeader.length > 0) {
                          captureId = captureIdHeader[0];
                        }

                        // Find the retry plugin to get the original request body
                        let retryCtx = currentCtx;
                        if (retryId || captureId) {
                          const retryPlugin = plugins.find((p) => p.name === "retry");
                          if (retryPlugin && (retryPlugin as any)._internal?.getRequestBody) {
                            // Check if this is a NVIDIA ResourceExhausted retry (modified body available)
                            const hasModifiedBodyHeader = finalCtx.headers["x-retry-modified-body"] === "true";
                            let bodyBuffer: Buffer | undefined;
                            let bodyJson: JsonValue | undefined;
                            
                            if (hasModifiedBodyHeader && (retryPlugin as any)._internal?.getModifiedBodyForRetry) {
                              // Use modified body with "continue" message for NVIDIA retry
                              bodyBuffer = (retryPlugin as any)._internal.getModifiedBodyForRetry(retryId || "") ??
                                (captureId ? (retryPlugin as any)._internal.getModifiedBodyForRetry(captureId) : undefined);
                              // Also get the JSON version if available
                              bodyJson = bodyBuffer ? JSON.parse(bodyBuffer.toString("utf8")) : undefined;
                              console.debug(`[forward] Using modified body with "continue" for NVIDIA retry`);
                            } else {
                              // Use original body for standard retries
                              bodyBuffer = (retryPlugin as any)._internal.getRequestBody(retryId || "") ??
                                (captureId ? (retryPlugin as any)._internal.getRequestBody(captureId) : undefined);
                              bodyJson = (retryPlugin as any)._internal.getRequestBodyJson?.(retryId || "") ??
                                (captureId ? (retryPlugin as any)._internal.getRequestBodyJson?.(captureId) : undefined);
                            }
                            
                            if (bodyBuffer) {
                              // Create new context with body for retry
                              // Also ensure captureId is propagated so retry request has it in ctx.captureId
                              retryCtx = {
                                ...currentCtx,
                                rawBody: bodyBuffer,
                                body: bodyJson ?? currentCtx.body,
                                captureId: captureId ?? currentCtx.captureId,
                              };
                            }
                          }
                        }
                        doForward(retryCtx);
                      } catch (err) {
                        console.error("Retry request setup error:", err);
                        finishResponse(
                          JSON.stringify({ error: "Proxy error" }),
                          { "content-type": "application/json" },
                          502
                        );
                      }
                      return;
                    }
                    finishResponse(
                      finalCtx.body,
                      finalCtx.headers,
                      finalCtx.status,
                    );
                  })
                  .catch((err: unknown) => {
                    console.error(
                      "Response plugin pipeline error:",
                      err instanceof Error ? err.message : String(err),
                    );
                    finishResponse(
                      respBody,
                      proxyRes.headers as HeaderMap,
                      proxyRes.statusCode || 0,
                    );
                  });
              } else {
                finishResponse(
                  respBody,
                  proxyRes.headers as HeaderMap,
                  proxyRes.statusCode || 0,
                );
              }
            });

            proxyRes.on("error", (err) => {
              console.error("Upstream response error:", err.message);
              if (!res.destroyed) res.end();
            });
          },
        );

        attachLifecycleHandlers(res, proxyReq);
        proxyReq.on("finish", () => {
          requestSentTime = performance.now();
        });
        proxyReq.write(forwardBuffer);
        proxyReq.end();
      };

      // Helper to check if an error is a rate limit error with statusCode
      function isRateLimitError(err: unknown): err is Error & { statusCode: number; retryAfter?: number; rateLimitInfo?: any } {
        return err instanceof Error && (err as any).statusCode === 429;
      }

      // Run request plugins, then forward
      let currentCtx: RequestContext = reqCtx;
      if (hasRequestPlugins) {
        runRequestPlugins(plugins, reqCtx)
          .then((processedCtx) => {
            currentCtx = processedCtx;
            doForward(currentCtx);
          })
          .catch((err: unknown) => {
            // Check if this is a rate limit error - if so, return the error response instead of forwarding
            if (isRateLimitError(err)) {
              console.debug(`[proxy] Rate limited by plugin: ${err.message}`);
              if (!res.headersSent) {
                const retryAfterMs = err.retryAfter || 0;
                const rateLimitInfo = err.rateLimitInfo || {
                  limit: 0,
                  remaining: 0,
                  reset: Math.ceil((Date.now() + retryAfterMs) / 1000),
                  retryAfter: retryAfterMs,
                };
                res.writeHead(err.statusCode, {
                  "Content-Type": "application/json",
                  "Retry-After": String(Math.ceil(retryAfterMs / 1000) || 1),
                });
                res.end(JSON.stringify({
                  error: {
                    message: err.message || "Rate limit exceeded",
                    type: "rate_limit_exceeded",
                    rateLimitInfo,
                  },
                }));
              }
              return;
            }
            console.error(
              "Request plugin pipeline error:",
              err instanceof Error ? err.message : String(err),
            );
            // Forward the original request on pipeline failure
            doForward(currentCtx);
          });
      } else {
        doForward(currentCtx);
      }
    });
  };
}
