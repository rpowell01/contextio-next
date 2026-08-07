/**
 * High-level proxy API.
 *
 * Creates an HTTP server with the plugin pipeline wired up.
 * This is the main entry point for programmatic use.
 */
import type { ProxyConfig } from "@contextio/core";
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
export declare function createProxy(config?: ProxyConfig & {
    logTraffic?: boolean;
}): ProxyInstance;
//# sourceMappingURL=proxy.d.ts.map