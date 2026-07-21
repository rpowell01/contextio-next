/**
 * High-level proxy API.
 *
 * Creates an HTTP server with the plugin pipeline wired up.
 * This is the main entry point for programmatic use.
 */

import http from "node:http";
import fs from "node:fs/promises";
import { join } from "node:path";

import type { ProxyConfig, ProxyPlugin } from "@contextio/core";

import { resolveConfig } from "./config.js";
import { createProxyHandler } from "./forward.js";
import { createAdminHandler, enableLogCapture } from "./admin.js";
import { createAuthHandler } from "./auth.js";
import { createRedactionMetaWatcher } from "./redaction-meta-watcher.js";

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

  // Run an initial pass at startup as well.
  cleanupCaptureFiles(config).catch((error) =>
    console.error("Initial capture cleanup failed:", error),
  );

  return timer as NodeJS.Timeout;
}

export interface ProxyInstance {
  /** Start listening. Resolves when the server is ready. */
  start: () => Promise<void>;
  /** Stop the server. Resolves when all connections are closed. */
  stop: () => Promise<void>;
  /** The bound port (useful when port 0 is passed for auto-assignment). */
  port: number;
}

/**
 * Create a proxy instance.
 *
 * ```typescript
 * import { createProxy } from '@contextio/proxy';
 *
 * const proxy = createProxy({
 *   port: 4040,
 *   plugins: [myPlugin],
 * });
 * await proxy.start();
 * ```
 */
export function createProxy(
  config?: ProxyConfig & { logTraffic?: boolean },
): ProxyInstance {
  const resolved = resolveConfig(config);
  const plugins: ProxyPlugin[] = config?.plugins ?? [];
  const logTraffic = !!config?.logTraffic;

  const startTime = Date.now();

  // Start background redaction metadata watcher. Runs independently and
  // never touches the hot request/response path.
  const redactionMetaWatcher = createRedactionMetaWatcher({
    captureDir: resolved.loggerCaptureDir,
    encryption: resolved.loggerEncryption,
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

  const authHandler = resolved.oidc
    ? createAuthHandler({
        oidc: resolved.oidc,
        baseUrl: resolved.publicUrl || `http://${resolved.bindHost}:${resolved.port}`,
      })
    : null;

  // Combined handler that routes /admin/* to admin handler, /auth/* to auth handler
  const combinedHandler: http.RequestListener = (req, res) => {
    const url = req.url || "";
    if (url.startsWith("/admin/")) {
      adminHandler(req, res);
    } else if (url.startsWith("/auth/") && authHandler) {
      authHandler(req, res);
    } else {
      proxyHandler(req, res);
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

    start() {
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
            `@contextio/proxy running on http://${resolved.bindHost}:${boundPort}`,
          );
          resolve();
        });
      });
    },

  stop() {
    if (!started) return Promise.resolve();
    redactionMetaWatcher.stop();
    return new Promise<void>((resolve) => {
      // Force resolve after a short grace period. server.close() waits
      // for active connections to drain, which may never happen with
      // long-lived streaming or SSE connections.
      const forceTimer = setTimeout(() => resolve(), 500);
      server.close(() => {
        clearTimeout(forceTimer);
        resolve();
      });
    });
  },
  };
}
