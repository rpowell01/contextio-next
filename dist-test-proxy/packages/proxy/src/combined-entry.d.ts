#!/usr/bin/env node
/**
 * Combined entry point: Proxy + Next.js on single port (4040)
 *
 * This starts both the proxy server and Next.js web UI on a single port.
 * Routes:
 * - /admin/*      → Proxy admin API
 * - /chat/*, /v1/* → Proxy routing
 * - *             → Next.js app (web UI + /api/* endpoints)
 */
export {};
//# sourceMappingURL=combined-entry.d.ts.map