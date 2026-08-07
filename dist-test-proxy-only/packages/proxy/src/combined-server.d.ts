/**
 * Combined server: Proxy + Next.js on single port (4040)
 *
 * Routes:
 * - /admin/*      → Proxy admin API
 * - /chat/*, /v1/* → Proxy routing
 * - *             → Next.js app (web UI + /api/* endpoints)
 */
import type { ProxyConfig, ProxyPlugin } from "@contextio/core";
export interface ProxyInstance {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    port: number;
}
/**
 * Create a combined proxy + Next.js server on a single port.
 */
export declare function createCombinedProxy(config?: ProxyConfig & {
    logTraffic?: boolean;
    plugins?: ProxyPlugin[];
}): ProxyInstance;
//# sourceMappingURL=combined-server.d.ts.map