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
  CaptureData,
  HeaderMap,
  JsonValue,
  ProxyPlugin,
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
    // Priority: x-session-affinity (generic), x-claude-code-session-id (Anthropic/Claude Code), URL-embedded
    let sessionId: string | null =
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
        let forwardBuffer: Buffer;
        let bodyWasModified = false;
        if (ctx.body && ctx.body !== bodyJson) {
          forwardBuffer = Buffer.from(JSON.stringify(ctx.body), "utf8");
          bodyWasModified = true;
        } else {
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

            // Buffer the full response only when response plugins are active
            // AND the response is not streaming. Streaming responses must be
            // forwarded chunk by chunk; buffering them would break SSE clients.
            const shouldBufferResponse = hasResponsePlugins && !isStreaming;

            if (!shouldBufferResponse) {
              // Stream directly to client
              res.writeHead(proxyRes.statusCode!, proxyRes.headers);
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
                // Ensure JSON objects are separated to avoid concatenation errors
                let outBuffer: Buffer = chunk;
                if (hasStreamPlugins && isStreaming) {
                  // Convert to string for safe splitting
                  const text = outBuffer.toString("utf8");
                  // Prepend any leftover partial JSON from previous chunks
                  const fullText = jsonBuffer ? jsonBuffer + text : text;
                  jsonBuffer = "";
                  // Split where a JSON object ends and another begins without a delimiter
                  const parts = fullText.split(/(?<=})\s*(?={)/);
                  const processedParts: Buffer[] = [];
                  for (let i = 0; i < parts.length; i++) {
                    const part = parts[i];
                    let buf = Buffer.from(part, "utf8");
                    // Run plugins on each part individually
                    if (hasStreamPlugins) {
                      for (const plugin of plugins) {
                        if (!plugin.onStreamChunk) continue;
                        try {
                          let ret: unknown = plugin.onStreamChunk(
                            buf,
                            sessionId,
                          );
  if (ret instanceof SharedArrayBuffer) {
  ret = Buffer.from(
    Buffer.from(ret as ArrayBufferLike),
  );
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
                      jsonBuffer = part;
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
                  outBuffer = Buffer.concat(processedParts);
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
                      res.write(flushed);
                    }
                  } catch (err: unknown) {
                    console.error(
                      `Plugin "${plugin.name}" onStreamEnd error:`,
                      err instanceof Error ? err.message : String(err),
                    );
                  }
                }
              }

              const respBody = Buffer.concat(respChunks).toString("utf8");

              // finishResponse is called once the response body is final:
              // either immediately after the upstream ends (non-buffered path)
              // or after response plugins have run (buffered path). It writes
              // headers+body to the client, then fires capture plugins.
              const finishResponse = (
                finalBody: string,
                finalHeaders: HeaderMap,
                finalStatus: number,
              ): void => {
                if (shouldBufferResponse && !res.headersSent) {
                  const outBuf = Buffer.from(finalBody, "utf8");
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
    const capture = buildCaptureData({
      sessionId,
      req,
      cleanPath,
      source,
      provider,
      apiFormat,
      targetUrl,
      ctx,
      originalBody: bodyJson,
      reqBytes,
      proxyRes,
      finalBody,
      isStreaming: !!isStreaming,
      respBytes,
      timings,
    });

    runCapturePlugins(plugins, capture);
  }
                }
              };

              if (shouldBufferResponse) {
                const retryId = currentCtx.headers["x-retry-id"];
                const respCtx: ResponseContext = {
                  status: proxyRes.statusCode || 0,
                  headers: {
                    ...((proxyRes.headers as HeaderMap) || {}),
                    ...(retryId ? { "x-retry-id": retryId } : {}),
                  },
                  body: respBody,
                  isStreaming: false,
                  sessionId,
                };
                runResponsePlugins(plugins, respCtx)
                  .then((finalCtx) => {
                    // Retry signal from retry plugin (status 599)
                    if (finalCtx.status === 599) {
                      // Re-issue the upstream request with the same request context
                      try {
                        doForward(currentCtx);
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

      // Run request plugins, then forward
      let currentCtx: RequestContext = reqCtx;
      if (hasRequestPlugins) {
        runRequestPlugins(plugins, reqCtx)
          .then((processedCtx) => {
            currentCtx = processedCtx;
            doForward(currentCtx);
          })
          .catch((err: unknown) => {
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
