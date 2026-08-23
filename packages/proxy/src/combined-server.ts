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
import { upsertRedactionMetadata } from "@contextio/core/db";
import { lookup } from "mime-types";
import { resolveConfig } from "./config.js";
import { createProxyHandler } from "./forward.js";
import { createAdminHandler, enableLogCapture } from "./admin.js";
import { createAuthHandler, validateSession } from "./auth.js";
import { getOidcPublicUrl, getOidcCallbackUrl } from "./config.js";
import { createRedactionMetaWatcher } from "./redaction-meta-watcher.js";
import { join } from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { SERVICE_IDENTIFIER } from "@contextio/core";

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
 * Serve public assets from Next.js standalone output (e.g., /site.webmanifest, /favicon.ico)
 */
async function servePublicAsset(req: http.IncomingMessage, res: http.ServerResponse, publicDir: string): Promise<boolean> {
  const url = req.url || "";
  const pathname = url.split("?")[0];

  // Only serve known public assets
  const publicAssets = [
    "/site.webmanifest",
    "/favicon.ico",
    "/contextio-next-brand.png",
  ];

  const isPublicAsset = publicAssets.some(asset => pathname === asset || pathname.startsWith(asset + "?") || pathname.startsWith("/ContextIO-Next-"));
  // Also handle ContextIO-Next- prefixed favicons
  if (!isPublicAsset && !pathname.startsWith("/ContextIO-Next-")) {
    return false;
  }

  try {
    // Prevent path traversal
    if (pathname.includes("..")) return false;

    const filePath = join(publicDir, pathname);

    // Security: ensure path is within publicDir
    const resolvedPath = await fs.realpath(filePath).catch(() => null);
    const resolvedPublicDir = await fs.realpath(publicDir).catch(() => null);
    if (!resolvedPath || !resolvedPublicDir || !resolvedPath.startsWith(resolvedPublicDir)) {
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

/**
 * Create a combined proxy + Next.js server on a single port.
 */
export function createCombinedProxy(
  config?: ProxyConfig & { logTraffic?: boolean; plugins?: ProxyPlugin[] },
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
      // URL-decode to handle encoded brackets like %5Bid%5D -> [id]
      const decodedPathname = decodeURIComponent(pathname);
      const filePath = join(staticDir, decodedPathname.replace("/_next/static/", ""));
      
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

  const proxyHandler = createProxyHandler({
    upstreams: resolved.upstreams,
    allowTargetOverride: resolved.allowTargetOverride,
    strictUrlForwarding: resolved.strictUrlForwarding,
    plugins,
    logTraffic,
    providers: resolved.providers,
  });

  const adminHandler = createAdminHandler({ plugins, logTraffic, startTime, oidc: resolved.oidc });

  const authHandler = resolved.oidc
    ? createAuthHandler({
        oidc: resolved.oidc,
        baseUrl: resolved.publicUrl || getOidcPublicUrl() || ""
      })
    : null;

  if (resolved.oidc) {
    const callbackUrl = getOidcCallbackUrl(resolved.publicUrl || getOidcPublicUrl() || undefined);
    console.log(`[startup] OIDC callback URL: ${callbackUrl}`);
    console.log(`[startup] OIDC baseUrl used: ${getOidcPublicUrl()}`);
    console.log(`[startup] OIDC issuer: ${resolved.oidc.issuer}`);
    console.log(`[startup] OIDC clientId: ${resolved.oidc.clientId}`);
    console.log(`[startup] OIDC scope: ${resolved.oidc.scope.join(" ")}`);
    console.log(`[startup] OIDC sessionSecret length: ${resolved.oidc.sessionSecret.length}`);
    console.log(`[startup] OIDC BUILD TIME: ${new Date().toISOString()}`);
  } else {
    console.log(`[startup] OIDC not enabled (resolved.oidc is ${resolved.oidc})`);
    console.log(`[startup] CONTEXTIO_OIDC_ENABLED=${process.env.CONTEXTIO_OIDC_ENABLED}`);
    console.log(`[startup] CONTEXTIO_OIDC_ISSUER=${process.env.CONTEXTIO_OIDC_ISSUER ? 'SET' : 'NOT SET'}`);
    console.log(`[startup] CONTEXTIO_OIDC_CLIENT_ID=${process.env.CONTEXTIO_OIDC_CLIENT_ID ? 'SET' : 'NOT SET'}`);
    console.log(`[startup] CONTEXTIO_OIDC_CLIENT_SECRET=${process.env.CONTEXTIO_OIDC_CLIENT_SECRET ? 'SET' : 'NOT SET'}`);
    console.log(`[startup] CONTEXTIO_OIDC_SESSION_SECRET=${process.env.CONTEXTIO_OIDC_SESSION_SECRET ? 'SET' : 'NOT SET'}`);
  }

  // Create Next.js server instance and get its request handler
  let nextHandler: http.RequestListener | null = null;

  const initNextJs = async (): Promise<void> => {
    try {
      // Use Next.js standalone output - import next from the root node_modules
      // In production (Docker), next module is at /app/node_modules/next/dist/server/next.js
      // In development, it's in the project's node_modules
      const isProduction = process.env.NODE_ENV === "production";
      const nextPath = isProduction
        ? join("/app", "node_modules/next/dist/server/next.js")
        : join(process.cwd(), "packages/web/node_modules/next/dist/server/next.js");
      const nextModule = await import(nextPath);
      const next = nextModule.default || nextModule;

      // Use the standalone directory for Next.js pages and config
      const standaloneDir = isProduction
        ? join("/app", "packages/web")
        : join(process.cwd(), "packages/web/.next/standalone/packages/web");

      // Create Next.js server with the standalone config
      const nextServer = next({
        dir: standaloneDir,
        dev: false,
        conf: {
          distDir: ".next",
        },
      });

      if (typeof nextServer.prepare === "function") {
        await nextServer.prepare();
        nextHandler = nextServer.getRequestHandler();
        console.log("Next.js handler loaded successfully from standalone output");
      } else {
        console.warn("Next.js server doesn't have prepare method");
      }
    } catch (err) {
      console.warn("Next.js handler not available, web UI will not work:", err instanceof Error ? err.message : String(err));
      console.error(err); // Log full error for debugging
    }
  };

  // Initialize Next.js immediately
  const initPromise = initNextJs();

// Combined handler: routes based on path
  const combinedHandler: http.RequestListener = async (req, res) => {
    const url = req.url || "";
    const parsedUrl = new URL(url, getOidcPublicUrl() || undefined);
    const path = parsedUrl.pathname;

    // Serve Next.js static assets directly (faster, bypasses Next.js handler)
    if (path.startsWith("/_next/static/")) {
      const served = await serveStaticFile(req, res);
      if (served) return;
      // If not found, fall through to Next.js for 404 handling
    }

    // Serve public assets (manifest, favicon, logo) from standalone output
    const publicDir = join(process.cwd(), "packages/web/public");
    const publicServed = await servePublicAsset(req, res, publicDir);
    if (publicServed) return;

    // Proxy admin API
    if (path.startsWith("/admin/")) {
      adminHandler(req, res);
      return;
    }

    // Auth endpoints (public - no auth required)
    if (path.startsWith("/auth/") && authHandler) {
      authHandler(req, res);
      return;
    }

    // Proxy routing paths (public - AI tools need unauthenticated access)
    if (path.startsWith("/chat/") || path.startsWith("/v1/")) {
      proxyHandler(req, res);
      return;
    }

    // Public asset paths that should bypass auth (must match middleware config in packages/web/middleware.ts)
    function isPublicAsset(pathname: string): boolean {
      return (
        pathname === "/site.webmanifest" ||
        pathname === "/contextio-next-brand.png" ||
        pathname.startsWith("/ContextIO-Next-") ||
        pathname === "/favicon.ico"
      );
    }

    // OIDC authentication check for web UI routes only
    // If OIDC is enabled, require valid session for all other routes (Next.js web UI)
    // Do NOT protect /api/* (web API routes) - AI tools need unauthenticated access
    // Also skip public assets (manifest, logos, favicon)
    if (resolved.oidc && !path.startsWith("/api/") && !isPublicAsset(path)) {
      const session = validateSession(req, resolved.oidc.sessionSecret);
      if (!session) {
        // Redirect to login with return URL
        const loginUrl = `/auth/login?redirect=${encodeURIComponent(path + parsedUrl.search)}`;
        res.writeHead(302, { Location: loginUrl });
        res.end();
        return;
      }
    }

    // Everything else → Next.js (web UI, /api/*, etc.)
    if (nextHandler) {
      nextHandler(req, res);
    } else {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Web UI not available", service: SERVICE_IDENTIFIER }));
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
      // Stop background redaction metadata watcher
      redactionMetaWatcher.stop();
      // Clear capture cleanup timer
      if (cleanupTimer) {
        clearInterval(cleanupTimer as unknown as NodeJS.Timeout);
      }
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