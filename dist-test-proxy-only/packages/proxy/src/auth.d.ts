/**
 * OIDC Authentication handler for the proxy.
 *
 * Provides session cookie management and OIDC flow endpoints:
 * - /auth/login      → Redirect to OIDC provider authorization endpoint
 * - /auth/callback   → Handle OIDC callback, validate ID token, create session
 * - /auth/logout     → Clear session, redirect to provider logout
 * - Session validation middleware
 *
 * Uses AES-GCM for session cookie encryption and HMAC-SHA256 for integrity.
 * All crypto uses Node.js built-in modules.
 */
import http from "node:http";
import type { OidcProviderConfig } from "@contextio/core";
export interface AuthSession {
    /** User's subject identifier from the ID token. */
    sub: string;
    /** User's email from the ID token. */
    email?: string;
    /** User's name from the ID token. */
    name?: string;
    /** User's picture URL from the ID token. */
    picture?: string;
    /** Issuer of the ID token. */
    iss: string;
    /** Timestamp when the session was created (Unix seconds). */
    createdAt: number;
    /** Timestamp when the session expires (Unix seconds). */
    expiresAt: number;
}
export interface AuthOptions {
    /** OIDC provider configuration. */
    oidc: OidcProviderConfig;
    /** Proxy base URL (e.g., "https://proxy.example.com"). Used for callback URL construction. */
    baseUrl: string;
}
/**
 * Validates session from request cookies.
 * Returns session if valid, null if invalid/missing.
 */
export declare function validateSession(req: http.IncomingMessage, sessionSecret: string): AuthSession | null;
/**
 * Extracts session ID from request (for logging/debugging).
 */
export declare function getSessionId(req: http.IncomingMessage, sessionSecret: string): string | null;
/**
 * Creates the auth handler for OIDC endpoints.
 */
export declare function createAuthHandler(options: AuthOptions): http.RequestListener;
/**
 * Middleware to require authentication.
 * Returns session if authenticated, otherwise sends 401 and returns null.
 */
export declare function requireAuth(req: http.IncomingMessage, res: http.ServerResponse, sessionSecret: string): AuthSession | null;
//# sourceMappingURL=auth.d.ts.map