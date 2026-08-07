/**
 * @contextio/core/server
 *
 * Server-only exports for @contextio/core.
 * This module contains Node.js-specific functionality that should not be bundled for the browser.
 */
export { fetchProviderMetadata, validateIdToken, type OidcProviderMetadata, type JwtPayload, } from "./oidc.js";
export { DEFAULT_OIDC_SCOPE } from "./types.js";
//# sourceMappingURL=server.d.ts.map