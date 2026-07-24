/**
 * @contextio/core/server
 *
 * Server-only exports for @contextio/core.
 * This module contains Node.js-specific functionality that should not be bundled for the browser.
 */

// OIDC utilities (uses node:crypto)
export {
  fetchProviderMetadata,
  validateIdToken,
  type OidcProviderMetadata,
  type JwtPayload,
} from "./oidc.js";

// Default OIDC scopes
export { DEFAULT_OIDC_SCOPE } from "./types.js";