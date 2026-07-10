/**
 * Combined server: Proxy + Next.js on single port (4040)
 * 
 * Routes:
 * - /admin/*      → Proxy admin API
 * - /chat/*, /v1/* → Proxy routing
 * - *             → Next.js app (web UI + /api/* endpoints)
 */

import http from "node:http";
import type { ProxyConfig, ProxyPlugin } from "@contextio/core";
import { lookup } from "mime-types";

import { createProxy } from "./proxy.js";
import { resolveConfig } from "./config.js";
import { createProxyHandler } from "./forward.js";
import { createAdminHandler, enableLogCapture } from "./admin.js";
import { createRedactionMetaWatcher } from "./redaction-meta-watcher.js";
import { join } from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

async function cleanupCaptureFiles(config: {
  loggerCaptureDir: string;
  loggerCaptureMaxAgeMs: number;
}): Promise<void> {
  const files = await fs.readdir(config.loggerCaptureDir).catch(() => []);
  const threshold = Date.now() - config.loggerCaptureMaxAgeMs;
  for (const filename of files) {
    if (!filename.endsWith(".json")) continue;
    const filepath = join(config.loggerCaptureDir, filename);
    try {
      const stats = await fs.stat(filepath);
      if (stats.mtimeMs < threshold) {
        await fs.unlink(filepath);
        console.debug(`Removed stale capture: ${filename}`);
      }
    } catch {
      // ignore missing/corrupt files and continue
    }
  }
}

function startCaptureCleanup(config: {
  loggerCaptureDir: string;
  loggerCaptureMaxAgeMs: number;
  loggerCaptureCleanupIntervalMs: number;
  loggerCaptureCleanupEnabled: boolean;
}): NodeJS.Timeout {
  if (!config.loggerCaptureCleanupEnabled || config.loggerCaptureMaxAgeMs <= 0) {
    return setInterval(() => {}, 0) as unknown as NodeJS.Timeout;
  }

  const timer = setInterval(
    () => {
      cleanupCaptureFiles(config).catch((error) =>
        console.error("Capture cleanup failed:", error),
      );
    },
    config.loggerCaptureCleanupIntervalMs,
  );

  cleanupCaptureFiles(config).catch((error) =>
    console.error("Initial capture cleanup failed:", error),
  );

  return timer as NodeJS.Timeout;
}

export interface ProxyInstance {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  port: number;
}

/**
 * Serve static files from Next.js build output (.next/static)
 */
async function serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse, staticRoot: string): Promise<boolean> {
  const url = req.url || "";
  if (!url.startsWith("/_next/static/")) return false;

  try {
    // Remove the /_next/static prefix to get the relative file path
    const relativePath = url.slice("/_next/static/".length);
    // Prevent path traversal
    if (relativePath.includes("..")) return false;
    
    const filePath = join(staticRoot, relativePath);
    const stats = await stat(filePath);
    
    if (!stats.isFile()) return false;

    const contentType = lookup(filePath) || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": stats.size,
    });
    
    const stream = createReadStream(filePath);
    stream.pipe(res);
    
    return new Promise((resolve, reject) => {
      stream.on("end", () => resolve(true));
      stream.on("error", (err) => {
        if (!res.writableEnded) {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
        reject(err);
      });
    });
  } catch {
    return false;
  }
}

/**
 * Create a combined proxy + Next.js server on a single port.
 */
export function createCombinedProxy(
  config?: ProxyConfig & { logTraffic?: boolean },
): ProxyInstance {
  const resolved = resolveConfig(config);
  const plugins: ProxyPlugin[] = config?.plugins ?? [];
  const logTraffic = !!config?.logTraffic;

  const startTime = Date.now();

  // Static file serving for Next.js assets (fallback if Next.js handler fails)
  const staticDir = join(process.cwd(), "packages/web/.next/static");

  async function serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const url = req.url || "";
    if (!url.startsWith("/_next/static/")) return false;
    
    try {
      // Remove query string
      const pathname = url.split("?")[0];
      const filePath = join(staticDir, pathname.replace("/_next/static/", ""));
      
      // Security: ensure path is within staticDir
      const resolvedPath = await fs.realpath(filePath).catch(() => null);
      const resolvedStaticDir = await fs.realpath(staticDir).catch(() => null);
      if (!resolvedPath || !resolvedStaticDir || !resolvedPath.startsWith(resolvedStaticDir)) {
        return false;
      }
      
      const stats = await stat(resolvedPath);
      if (!stats.isFile()) return false;
      
      const mimeType = lookup(resolvedPath) || "application/octet-stream";
      res.writeHead(200, { 
        "Content-Type": mimeType,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      
      createReadStream(resolvedPath).pipe(res);
      return true;
    } catch {
      return false;
    }
  }

  // Start background redaction metadata watcher
  const redactionMetaWatcher = createRedactionMetaWatcher({
    captureDir: resolved.loggerCaptureDir,
  });

  // Enable log capture for admin API
  enableLogCapture();

  const proxyHandler = createProxyHandler({
    upstreams: resolved.upstreams,
    allowTargetOverride: resolved.allowTargetOverride,
    plugins,
    logTraffic,
  });

  const adminHandler = createAdminHandler({ plugins, logTraffic, startTime });

  // Create Next.js server instance and get its request handler
  let nextHandler: http.RequestListener | null = null;

  const initNextJs = async (): Promise<void> => {
    try {
      // Import Next.js dynamically
      const { default: createServer } = await import(
        join(process.cwd(), "packages/web/node_modules/next/dist/server/next.js")
      );
      
      // Create Next.js server instance using the exported createServer function
      const nextServer = await import(
        join(process.cwd(), "packages/web/node_modules/next/dist/server/next.js")
      ).then(mod => mod.default({
        dir: join(process.cwd(), "packages/web"),
        dev: false,
        port: 0,
        hostname: "0.0.0.0",
        customServer: false,
      }));
      
      // Prepare the server (loads routes, compiles, etc.)
      await nextServer.prepare();
      
      // Get the request handler
      nextHandler = nextServer.getRequestHandler();
      console.log("Next.js handler loaded successfully");
    } catch (err) {
      console.warn("Next.js handler not available, web UI will not work:", err instanceof Error ? err.message : String(err));
    }
  };

  // Initialize Next.js immediately
  const initPromise = initNextJs();

// Combined handler: routes based on path
  const combinedHandler: http.RequestListener = async (req, res) => {
    const url = req.url || "";
    
    // Serve Next.js static assets directly (faster, bypasses Next.js handler)
    if (url.startsWith("/_next/static/")) {
      const served = await serveStaticFile(req, res);
      if (served) return;
      // If not found, fall through to Next.js for 404 handling
    }
    
    // Proxy admin API
    if (url.startsWith("/admin/")) {
      adminHandler(req, res);
      return;
    }
    
    // Proxy routing paths
    if (url.startsWith("/chat/") || url.startsWith("/v1/")) {
      proxyHandler(req, res);
      return;
    }
    
    // Everything else → Next.js (web UI, /api/*, etc.)
    if (nextHandler) {
      nextHandler(req, res);
    } else {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Web UI not available" }));
    }
  };

  const server = http.createServer(combinedHandler);
  const cleanupTimer = startCaptureCleanup(resolved);
  let boundPort = resolved.port;
  let started = false;

  return {
    get port() {
      return boundPort;
    },

    async start() {
      // Wait for Next.js to initialize
      await initPromise;
      
      return new Promise<void>((resolve, reject) => {
        server.once("error", (err: NodeJS.ErrnoException) => {
          reject(err);
        });

        server.listen(resolved.port, resolved.bindHost, () => {
          started = true;
          const addr = server.address();
          if (addr && typeof addr === "object") {
            boundPort = addr.port;
          }
          console.log(
            `@contextio/proxy + Next.js running on http://${resolved.bindHost}:${boundPort}`,
          );
          resolve();
        });
      });
    },

    stop() {
      if (!started) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const forceTimer = setTimeout(() => resolve(), 500);
        server.close(() => {
          clearTimeout(forceTimer);
          resolve();
        });
      });
    },
  };
}