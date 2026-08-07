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
import { createCipheriv, createDecipheriv, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { fetchProviderMetadata, validateIdToken } from "@contextio/core/server";
import { SERVICE_IDENTIFIER } from "@contextio/core";
/** In-memory session store (in production, use Redis or similar). */
const sessionStore = new Map();
/** Session cookie settings. */
const SESSION_COOKIE_NAME = "contextio_session";
const SESSION_COOKIE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_COOKIE_OPTIONS = "HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=" + SESSION_COOKIE_MAX_AGE / 1000;
/** In-memory state store for PKCE state parameter (short-lived, 10 min TTL). */
const stateStore = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;
/** OIDC provider metadata cache. */
let providerMetadataCache = null;
let providerMetadataCacheTime = 0;
const PROVIDER_METADATA_TTL_MS = 5 * 60 * 1000; // 5 minutes
/**
 * Derives encryption and HMAC keys from session secret using PBKDF2.
 * Matches packages/web/lib/auth/session.ts EXACTLY for cross-package compatibility.
 * Web uses two separate PBKDF2 calls with fixed salts "encryption-key" and "hmac-key".
 */
function deriveEncryptionKey(sessionSecret, salt) {
    // Matches web: PBKDF2(sessionSecret, "encryption-key", 100000, 32, SHA-256)
    return pbkdf2Sync(sessionSecret, "encryption-key", 100000, 32, "sha256");
}
function deriveHmacKey(sessionSecret) {
    // Matches web: PBKDF2(sessionSecret, "hmac-key", 100000, 32, SHA-256)
    return pbkdf2Sync(sessionSecret, "hmac-key", 100000, 32, "sha256");
}
/**
 * Encrypts session data using AES-256-GCM with PBKDF2 key derivation.
 * Matches packages/web/lib/auth/session.ts for cross-package compatibility.
 */
function encryptSession(session, sessionSecret) {
    const salt = randomBytes(16); // Random salt for encryption key only
    const encryptionKey = deriveEncryptionKey(sessionSecret, salt);
    const hmacKey = deriveHmacKey(sessionSecret); // Fixed salt, no random salt
    const iv = randomBytes(12); // 96-bit IV for GCM
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    const data = JSON.stringify(session);
    const encrypted = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Combine encrypted data + auth tag
    const encryptedWithTag = Buffer.concat([encrypted, authTag]);
    const hmac = createHmac("sha256", hmacKey).update(encryptedWithTag).digest();
    return {
        data: encryptedWithTag.toString("base64url"),
        hmac: hmac.toString("base64url"),
        iv: iv.toString("base64url"),
        salt: salt.toString("base64url"),
    };
}
/**
 * Decrypts and validates session cookie.
 * Matches packages/web/lib/auth/session.ts for cross-package compatibility.
 */
function decryptSession(cookie, sessionSecret) {
    try {
        const salt = Buffer.from(cookie.salt, "base64url");
        const encryptionKey = deriveEncryptionKey(sessionSecret, salt);
        const hmacKey = deriveHmacKey(sessionSecret);
        // Verify HMAC
        const encryptedWithTag = Buffer.from(cookie.data, "base64url");
        const expectedHmac = createHmac("sha256", hmacKey).update(encryptedWithTag).digest();
        const providedHmac = Buffer.from(cookie.hmac, "base64url");
        if (!timingSafeEqual(expectedHmac, providedHmac)) {
            return null;
        }
        // Split encrypted data and auth tag (last 16 bytes)
        const authTag = encryptedWithTag.subarray(-16);
        const encrypted = encryptedWithTag.subarray(0, -16);
        const iv = Buffer.from(cookie.iv, "base64url");
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        const session = JSON.parse(decrypted.toString("utf8"));
        // Check expiration
        const now = Math.floor(Date.now() / 1000);
        if (session.expiresAt < now) {
            return null;
        }
        return session;
    }
    catch {
        return null;
    }
}
/**
 * Generates a secure random state parameter for OIDC flow.
 */
function generateState() {
    return randomBytes(32).toString("base64url");
}
/**
 * Generates a secure random nonce for OIDC flow.
 */
function generateNonce() {
    return randomBytes(32).toString("base64url");
}
/**
 * Stores state/nonce for OIDC flow with TTL.
 */
function storeState(state, nonce) {
    stateStore.set(state, { nonce, expiresAt: Date.now() + STATE_TTL_MS });
}
/**
 * Retrieves and consumes state/nonce for OIDC flow.
 */
function consumeState(state) {
    const entry = stateStore.get(state);
    if (!entry)
        return null;
    if (Date.now() > entry.expiresAt) {
        stateStore.delete(state);
        return null;
    }
    stateStore.delete(state);
    return entry.nonce;
}
/**
 * Cleans up expired state entries.
 */
function cleanupStateStore() {
    const now = Date.now();
    for (const [state, entry] of stateStore.entries()) {
        if (now > entry.expiresAt) {
            stateStore.delete(state);
        }
    }
}
/**
 * Fetches and caches OIDC provider metadata.
 */
async function getProviderMetadata(issuer) {
    const now = Date.now();
    if (providerMetadataCache && now - providerMetadataCacheTime < PROVIDER_METADATA_TTL_MS) {
        return providerMetadataCache;
    }
    const metadata = await fetchProviderMetadata(issuer);
    providerMetadataCache = metadata;
    providerMetadataCacheTime = now;
    return metadata;
}
/**
 * Parses cookies from request headers.
 */
function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader)
        return cookies;
    for (const cookie of cookieHeader.split(";")) {
        const [name, ...rest] = cookie.trim().split("=");
        if (name && rest.length > 0) {
            cookies[name] = rest.join("=");
        }
    }
    return cookies;
}
/**
 * Sets a session cookie on the response.
 */
function setSessionCookie(res, cookie) {
    const cookieValue = `${SESSION_COOKIE_NAME}=${JSON.stringify(cookie)}; ${SESSION_COOKIE_OPTIONS}`;
    res.setHeader("Set-Cookie", cookieValue);
}
/**
 * Clears the session cookie.
 */
function clearSessionCookie(res) {
    res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; ${SESSION_COOKIE_OPTIONS}; Max-Age=0`);
}
/**
 * Validates session from request cookies.
 * Returns session if valid, null if invalid/missing.
 */
export function validateSession(req, sessionSecret) {
    const cookies = parseCookies(req.headers.cookie);
    const sessionCookie = cookies[SESSION_COOKIE_NAME];
    if (!sessionCookie)
        return null;
    try {
        const cookie = JSON.parse(sessionCookie);
        return decryptSession(cookie, sessionSecret);
    }
    catch {
        return null;
    }
}
/**
 * Extracts session ID from request (for logging/debugging).
 */
export function getSessionId(req, sessionSecret) {
    const session = validateSession(req, sessionSecret);
    return session?.sub ?? null;
}
/**
 * Creates the auth handler for OIDC endpoints.
 */
export function createAuthHandler(options) {
    const { oidc, baseUrl } = options;
    const callbackUrl = `${baseUrl}/auth/callback`;
    return async (req, res) => {
        const url = new URL(req.url || "", `http://${req.headers.host}`);
        const path = url.pathname;
        // CORS headers for web UI
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Cookie");
        res.setHeader("Access-Control-Allow-Credentials", "true");
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        cleanupStateStore();
        try {
            if (path === "/auth/login" && req.method === "GET") {
                await handleLogin(req, res, oidc, callbackUrl);
            }
            else if (path === "/auth/callback" && req.method === "GET") {
                await handleCallback(req, res, oidc, callbackUrl);
            }
            else if (path === "/auth/logout" && (req.method === "GET" || req.method === "POST")) {
                await handleLogout(req, res, oidc);
            }
            else if (path === "/auth/logged-out" && req.method === "GET") {
                await handleLoggedOut(req, res);
            }
            else if (path === "/auth/session" && req.method === "GET") {
                await handleSession(req, res, oidc);
            }
            else {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Not found", service: SERVICE_IDENTIFIER }));
            }
        }
        catch (error) {
            console.error("Auth handler error:", error);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error", service: SERVICE_IDENTIFIER }));
        }
    };
}
/**
 * Handles /auth/login - redirects to OIDC provider authorization endpoint.
 */
async function handleLogin(req, res, oidc, callbackUrl) {
    try {
        const metadata = await getProviderMetadata(oidc.issuer);
        const state = generateState();
        const nonce = generateNonce();
        storeState(state, nonce);
        // Store redirect URL in a cookie for post-login redirect (optional)
        const redirectUrl = new URL(req.url || "", `http://${req.headers.host}`).searchParams.get("redirect") || "/";
        const params = new URLSearchParams({
            response_type: "code",
            client_id: oidc.clientId,
            redirect_uri: callbackUrl,
            scope: oidc.scope.join(" "),
            state,
            nonce,
        });
        const authUrl = `${metadata.authorization_endpoint}?${params.toString()}`;
        console.log("[auth] Generated authorize URL:", authUrl);
        console.log("[auth] clientId:", oidc.clientId);
        console.log("[auth] callbackUrl:", callbackUrl);
        console.log("[auth] metadata.authorization_endpoint:", metadata.authorization_endpoint);
        // Set a cookie to remember where to redirect after login
        res.setHeader("Set-Cookie", `contextio_login_redirect=${encodeURIComponent(redirectUrl)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300`);
        // 302 redirect - browser follows automatically
        res.writeHead(302, { Location: authUrl });
        res.end();
    }
    catch (error) {
        console.error("Login error:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to initiate login", service: SERVICE_IDENTIFIER }));
    }
}
/**
 * Handles /auth/callback - processes OIDC callback, validates ID token, creates session.
 */
async function handleCallback(req, res, oidc, callbackUrl) {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");
    console.log("[auth] Callback received:", { code: !!code, state: !!state, error, errorDescription });
    // Handle OAuth2 error response
    if (error) {
        console.error("OIDC callback error:", error, errorDescription);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errorDescription || "Authentication failed", service: SERVICE_IDENTIFIER }));
        return;
    }
    if (!code || !state) {
        console.error("[auth] Missing code or state");
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing code or state parameter", service: SERVICE_IDENTIFIER }));
        return;
    }
    // Verify state and get nonce
    const nonce = consumeState(state);
    if (!nonce) {
        console.error("[auth] Invalid or expired state");
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or expired state parameter", service: SERVICE_IDENTIFIER }));
        return;
    }
    console.log("[auth] State validated, nonce:", nonce);
    try {
        // Exchange code for tokens
        const metadata = await getProviderMetadata(oidc.issuer);
        console.log("[auth] Token endpoint:", metadata.token_endpoint);
        const tokenResponse = await fetch(metadata.token_endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
            },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code,
                redirect_uri: callbackUrl,
                client_id: oidc.clientId,
                client_secret: oidc.clientSecret,
            }),
        });
        console.log("[auth] Token response status:", tokenResponse.status);
        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            console.error("Token exchange failed:", tokenResponse.status, errorText);
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Failed to exchange authorization code", service: SERVICE_IDENTIFIER }));
            return;
        }
        const tokens = (await tokenResponse.json());
        console.log("[auth] Tokens received:", { id_token: !!tokens.id_token, access_token: !!tokens.access_token });
        if (!tokens.id_token) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "No ID token in response", service: SERVICE_IDENTIFIER }));
            return;
        }
        // Validate ID token
        const payload = await validateIdToken(tokens.id_token, metadata.jwks_uri, oidc.clientId, oidc.issuer);
        console.log("[auth] ID token validated, payload:", { sub: payload.sub, email: payload.email, nonce: payload.nonce });
        // Verify nonce matches
        if (payload.nonce !== nonce) {
            console.error("[auth] Nonce mismatch:", { expected: nonce, actual: payload.nonce });
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid nonce in ID token", service: SERVICE_IDENTIFIER }));
            return;
        }
        // Create session
        const now = Math.floor(Date.now() / 1000);
        const session = {
            sub: payload.sub,
            email: payload.email,
            name: payload.name,
            picture: payload.picture,
            iss: payload.iss,
            createdAt: now,
            expiresAt: now + 24 * 60 * 60, // 24 hours
        };
        // Encrypt and set session cookie
        const cookie = encryptSession(session, oidc.sessionSecret);
        setSessionCookie(res, cookie);
        console.log("[auth] Session cookie set for user:", payload.sub);
        // Get redirect URL from cookie or default to home
        const cookies = parseCookies(req.headers.cookie);
        const redirectUrl = cookies.contextio_login_redirect
            ? decodeURIComponent(cookies.contextio_login_redirect)
            : "/";
        console.log("[auth] Redirect URL from cookie:", redirectUrl);
        // Clear the redirect cookie - append to existing Set-Cookie header
        const existingCookies = res.getHeader("Set-Cookie");
        const cookieArray = Array.isArray(existingCookies)
            ? [...existingCookies]
            : existingCookies
                ? [String(existingCookies)]
                : [];
        cookieArray.push("contextio_login_redirect=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
        res.setHeader("Set-Cookie", cookieArray);
        console.log("[auth] Final Set-Cookie headers:", res.getHeader("Set-Cookie"));
        console.log("[auth] Redirecting to:", redirectUrl);
        res.writeHead(302, { Location: redirectUrl });
        res.end();
    }
    catch (error) {
        console.error("Callback error:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Authentication failed", service: SERVICE_IDENTIFIER }));
    }
}
/**
 * Handles /auth/logout - clears session and optionally redirects to provider logout.
 */
async function handleLogout(req, res, oidc) {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const redirectUrl = url.searchParams.get("redirect") || "/auth/logged-out";
    // Clear session cookie
    clearSessionCookie(res);
    // If provider supports RP-initiated logout, redirect there
    try {
        const metadata = await getProviderMetadata(oidc.issuer);
        if (metadata.end_session_endpoint) {
            const logoutUrl = new URL(metadata.end_session_endpoint);
            // Redirect to a public "logged out" page on this proxy after provider logout
            const postLogoutUrl = new URL(redirectUrl, `http://${req.headers.host}`).href;
            logoutUrl.searchParams.set("post_logout_redirect_uri", postLogoutUrl);
            logoutUrl.searchParams.set("client_id", oidc.clientId);
            res.writeHead(302, { Location: logoutUrl.toString() });
            res.end();
            return;
        }
    }
    catch {
        // Ignore metadata fetch errors, fall through to local logout
    }
    // Local logout only - redirect to logged-out page
    res.writeHead(302, { Location: redirectUrl });
    res.end();
}
/**
 * Handles /auth/session - returns current session info (for UI).
 */
async function handleSession(req, res, oidc) {
    const session = validateSession(req, oidc.sessionSecret);
    if (!session) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ authenticated: false, service: SERVICE_IDENTIFIER }));
        return;
    }
    // Check if token is still valid (not expired)
    const now = Math.floor(Date.now() / 1000);
    if (session.expiresAt < now) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ authenticated: false, service: SERVICE_IDENTIFIER }));
        return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
        authenticated: true,
        service: SERVICE_IDENTIFIER,
        user: {
            sub: session.sub,
            email: session.email,
            name: session.name,
            picture: session.picture,
            iss: session.iss,
        },
        expiresAt: session.expiresAt,
    }));
}
/**
 * Handles /auth/logged-out - shows a simple logout confirmation page.
 */
async function handleLoggedOut(req, res) {
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Logged Out</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, sans-serif; max-width: 400px; margin: 4rem auto; padding: 2rem; text-align: center; }
    h1 { color: #333; }
    p { color: #666; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>You have been logged out</h1>
  <p>Your session has been ended successfully.</p>
  <p><a href="/auth/login">Sign in again</a></p>
</body>
</html>
  `;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
}
/**
 * Middleware to require authentication.
 * Returns session if authenticated, otherwise sends 401 and returns null.
 */
export function requireAuth(req, res, sessionSecret) {
    const session = validateSession(req, sessionSecret);
    if (!session) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized", loginUrl: "/auth/login", service: SERVICE_IDENTIFIER }));
        return null;
    }
    const now = Math.floor(Date.now() / 1000);
    if (session.expiresAt < now) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session expired", loginUrl: "/auth/login", service: SERVICE_IDENTIFIER }));
        return null;
    }
    return session;
}
//# sourceMappingURL=auth.js.map