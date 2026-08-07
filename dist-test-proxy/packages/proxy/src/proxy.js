/**
 * High-level proxy API.
 *
 * Creates an HTTP server with the plugin pipeline wired up.
 * This is the main entry point for programmatic use.
 */
import http from "node:http";
import fs from "node:fs/promises";
import { join } from "node:path";
import { upsertRedactionMetadata } from "@contextio/core/db";
import { resolveConfig } from "./config.js";
import { createProxyHandler } from "./forward.js";
import { createAdminHandler, enableLogCapture } from "./admin.js";
import { createAuthHandler, validateSession } from "./auth.js";
import { createRedactionMetaWatcher } from "./redaction-meta-watcher.js";
async function cleanupCaptureFiles(config) {
    const files = await fs.readdir(config.loggerCaptureDir).catch(() => []);
    const threshold = Date.now() - config.loggerCaptureMaxAgeMs;
    for (const filename of files) {
        if (!filename.endsWith(".json"))
            continue;
        const filepath = join(config.loggerCaptureDir, filename);
        try {
            const stats = await fs.stat(filepath);
            if (stats.mtimeMs < threshold) {
                await fs.unlink(filepath);
                console.debug(`Removed stale capture: ${filename}`);
            }
        }
        catch {
            // ignore missing/corrupt files and continue
        }
    }
}
function startCaptureCleanup(config) {
    if (!config.loggerCaptureCleanupEnabled || config.loggerCaptureMaxAgeMs <= 0) {
        return setInterval(() => { }, 0);
    }
    const timer = setInterval(() => {
        cleanupCaptureFiles(config).catch((error) => console.error("Capture cleanup failed:", error));
    }, config.loggerCaptureCleanupIntervalMs);
    // Run an initial pass at startup as well.
    cleanupCaptureFiles(config).catch((error) => console.error("Initial capture cleanup failed:", error));
    return timer;
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
export function createProxy(config) {
    const resolved = resolveConfig(config);
    const plugins = config?.plugins ?? [];
    const logTraffic = !!config?.logTraffic;
    const startTime = Date.now();
    // Start background redaction metadata watcher. Runs independently and
    // never touches the hot request/response path.
    const redactionMetaWatcher = createRedactionMetaWatcher({
        captureDir: resolved.loggerCaptureDir,
        encryption: resolved.loggerEncryption,
        persistToSqlite: upsertRedactionMetadata,
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
    const adminHandler = createAdminHandler({ plugins, logTraffic, startTime });
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
    const combinedHandler = (req, res) => {
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
        }
        else if (url.startsWith("/auth/") && authHandler) {
            authHandler(req, res);
        }
        else {
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
            return new Promise((resolve, reject) => {
                server.once("error", (err) => {
                    reject(err);
                });
                server.listen(resolved.port, resolved.bindHost, () => {
                    started = true;
                    const addr = server.address();
                    if (addr && typeof addr === "object") {
                        boundPort = addr.port;
                    }
                    console.log(`@contextio/proxy running on http://${resolved.bindHost}:${boundPort}`);
                    resolve();
                });
            });
        },
        stop() {
            if (!started)
                return Promise.resolve();
            redactionMetaWatcher.stop();
            return new Promise((resolve) => {
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
//# sourceMappingURL=proxy.js.map