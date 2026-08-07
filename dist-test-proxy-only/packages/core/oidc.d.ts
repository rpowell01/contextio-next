/**
 * OpenID Connect utilities for @contextio/core.
 *
 * Provides OIDC discovery and ID token validation using only
 * Node.js built-in modules (crypto, fetch). No external dependencies.
 */
/**
 * OIDC Provider Metadata returned from the discovery endpoint.
 */
export interface OidcProviderMetadata {
    /** OAuth 2.0 Authorization Endpoint URL. */
    authorization_endpoint: string;
    /** OAuth 2.0 Token Endpoint URL. */
    token_endpoint: string;
    /** JSON Web Key Set (JWKS) URL. */
    jwks_uri: string;
    /** UserInfo Endpoint URL. */
    userinfo_endpoint: string;
    /** OIDC Issuer URL. */
    issuer: string;
    /** Optional: End session endpoint for RP-initiated logout. */
    end_session_endpoint?: string;
}
/**
 * Decoded JWT payload (claims).
 */
export interface JwtPayload {
    /** Issuer identifier. */
    iss: string;
    /** Subject identifier. */
    sub: string;
    /** Audience(s). */
    aud: string | string[];
    /** Expiration time (Unix timestamp). */
    exp: number;
    /** Issued at time (Unix timestamp). */
    iat: number;
    /** Optional: User's email address. */
    email?: string;
    /** Optional: User's full name. */
    name?: string;
    /** Optional: User's picture URL. */
    picture?: string;
    /** Optional: Nonce for ID token validation. */
    nonce?: string;
    /** Additional claims. */
    [key: string]: unknown;
}
/**
 * Fetches OpenID Connect provider metadata from the discovery endpoint.
 *
 * @param issuer - The OIDC issuer URL (e.g., "https://accounts.google.com")
 * @returns Parsed provider metadata with authorization_endpoint, token_endpoint, jwks_uri, userinfo_endpoint, and issuer
 * @throws {Error} If discovery fails or required fields are missing
 */
export declare function fetchProviderMetadata(issuer: string): Promise<OidcProviderMetadata>;
/**
 * Validates an OIDC ID token.
 *
 * Verifies the JWT signature using the JWKS endpoint, validates the
 * aud, iss, exp, and iat claims, and returns the decoded payload.
 *
 * @param idToken - The raw ID token (JWT string)
 * @param jwksUri - The JWKS URI from provider metadata
 * @param expectedAud - Expected audience (client ID)
 * @param expectedIss - Expected issuer URL
 * @returns Decoded JWT payload with claims
 * @throws {Error} If validation fails (invalid signature, expired, wrong audience/issuer, etc.)
 */
export declare function validateIdToken(idToken: string, jwksUri: string, expectedAud: string, expectedIss: string): Promise<JwtPayload>;
//# sourceMappingURL=oidc.d.ts.map