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
import { upsertRedactionMetadata } from "@contextio/core/db";

import { resolveConfig } from "./config.js";
import { createProxyHandler } from "./forward.js";
import { createAdminHandler, enableLogCapture } from "./admin.js";
import { createAuthHandler, validateSession } from "./auth.js";
import { createRedactionMetaWatcher } from "./redaction-meta-watcher.js";
// Import plugin factories from their respective packages
import { createLoggerPlugin } from "@contextio/logger";
import { createRedactPlugin } from "@contextio/redact";
import { createRateLimiterPlugin } from "./rate-limiter.js";
import { createRetryPlugin } from "./retry-plugin.js";

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
  /** The upstream URLs (mutable for testing). */
  upstreams: Record<string, string>;
  /** The provider configs (mutable for testing). */
  providers: Record<string, any>;
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
   const logTraffic = !!config?.logTraffic;

   // Build plugins array from enabled flags and user-provided plugins
   const effectivePlugins: ProxyPlugin[] = [];
   if (resolved.plugins.loggerEnabled) {
     effectivePlugins.push(
       createLoggerPlugin({
         captureDir: resolved.loggerCaptureDir,
         encryption: resolved.loggerEncryption,
       })
     );
   }
   if (resolved.plugins.redactEnabled) {
     effectivePlugins.push(
       createRedactPlugin({
         // Use preset from config or environment
         policyFile: process.env.REDACT_POLICY_FILE || "/app/custom-policy/custom-policy.json",
       })
     );
   }
   if (resolved.plugins.rateLimiterEnabled) {
     effectivePlugins.push(
       createRateLimiterPlugin({
         defaults: { maxRequests: 60, windowMs: 60000, bufferCapacity: 10 },
         providers: resolved.rateLimiter,
       })
     );
   }
   if (resolved.plugins.retryEnabled) {
     effectivePlugins.push(
       createRetryPlugin({
         providers: resolved.retry,
       })
     );
   }
   // Add any user-provided plugins after built-ins
   if (config?.plugins) effectivePlugins.push(...config.plugins);

  const startTime = Date.now();

  // Start background redaction metadata watcher. Runs independently and
  // never touches the hot request/response path.
  const encryptionKey =
    resolved.loggerEncryption.staticKey ??
    process.env[resolved.loggerEncryption.keyEnvVar ?? "CONTEXTIO_LOGGER_ENCRYPTION_KEY"];
  const redactionMetaWatcher = createRedactionMetaWatcher({
    captureDir: resolved.loggerCaptureDir,
    persistToSqlite: upsertRedactionMetadata,
    encryptionKey,
  });

  // Enable log capture for admin API
  enableLogCapture();

  const upstreams = { ...resolved.upstreams };
  const providers = { ...resolved.providers };

   const proxyHandler = createProxyHandler({
     upstreams,
     allowTargetOverride: resolved.allowTargetOverride,
     strictUrlForwarding: resolved.strictUrlForwarding,
     plugins: effectivePlugins,
     logTraffic,
     providers,
   });

   const adminHandler = createAdminHandler({ plugins: effectivePlugins, logTraffic, startTime });

  const authHandler = resolved.oidc
    ? createAuthHandler({
        oidc: resolved.oidc,
        baseUrl: resolved.publicUrl || `http://${resolved.bindHost}:${resolved.port}`,
      })
    : null;

  if (resolved.oidc) {
    const authBaseUrl = (resolved.publicUrl || `http://${resolved.bindHost}:${resolved.port}`).replace(/\/+$/, "");
    console.log(`[startup] OIDC callback URL: ${authBaseUrl}/auth/callback`);
  }

  // Combined handler that routes /admin/* to admin handler, /auth/* to auth handler
  const combinedHandler: http.RequestListener = (req, res) => {
    const url = req.url || "";

    // OIDC authentication check for protected routes only
    // Do NOT protect proxy API routes (/v1/*, /chat/*) - AI tools need unauthenticated access
    // Do NOT protect /auth/ (public auth endpoints) or /admin/* (admin API)
    if (resolved.oidc && !url.startsWith("/auth/") && !url.startsWith("/admin/") && !url.startsWith("/v1/") && !url.startsWith("/chat/")) {
      const session = validateSession(req, resolved.oidc.sessionSecret);
      if (!session) {
        // Redirect to login with return URL
        const loginUrl = `/auth/login?redirect=${encodeURIComponent(url)}`;
        res.writeHead(302, { Location: loginUrl });
        res.end();
        return;
      }
    }

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
    upstreams,
    providers,
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
    // Clear capture cleanup timer
    if (cleanupTimer) {
      clearInterval(cleanupTimer as unknown as NodeJS.Timeout);
    }
    // Shutdown all plugins to release resources (timers, models, caches)
    for (const plugin of effectivePlugins) {
      if (plugin.shutdown) {
        try {
          const result = plugin.shutdown();
          if (result && typeof result.then === "function") {
            // Fire and forget - we don't wait for async shutdown
            result.catch((err: unknown) => {
              console.error(`Plugin "${plugin.name}" shutdown error:`, err);
            });
          }
        } catch (err: unknown) {
          console.error(`Plugin "${plugin.name}" shutdown error:`, err);
        }
      }
    }
    return new Promise<void>((resolve) => {
      // Force resolve after a short grace period. server.close() waits
      // for active connections to drain, which may never happen with
      // long-lived streaming or SSE connections.
      const forceTimer = setTimeout(() => resolve(), 500);
      server.close(() => {
        clearTimeout(forceTimer);
        started = false;
        resolve();
      });
    });
  },
  };
}
