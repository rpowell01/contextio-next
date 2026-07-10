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

import { createProxy } from "./proxy.js";
import { resolveConfig } from "./config.js";
import { createProxyHandler } from "./forward.js";
import { createAdminHandler, enableLogCapture } from "./admin.js";
import { createRedactionMetaWatcher } from "./redaction-meta-watcher.js";
import { join } from "node:path";
import fs from "node:fs/promises";

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
 * Create a combined proxy + Next.js server on a single port.
 */
export function createCombinedProxy(
  config?: ProxyConfig & { logTraffic?: boolean },
): ProxyInstance {
  const resolved = resolveConfig(config);
  const plugins: ProxyPlugin[] = config?.plugins ?? [];
  const logTraffic = !!config?.logTraffic;

  const startTime = Date.now();

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
  const combinedHandler: http.RequestListener = (req, res) => {
    const url = req.url || "";
    
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
    
    // Everything else → Next.js (web UI, /api/*, static assets, etc.)
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