/**
 * OpenID Connect utilities for @contextio/core.
 *
 * Provides OIDC discovery and ID token validation using only
 * Node.js built-in modules (crypto, fetch). No external dependencies.
 */
import { createPublicKey, createVerify } from "node:crypto";
/**
 * Fetches OpenID Connect provider metadata from the discovery endpoint.
 *
 * @param issuer - The OIDC issuer URL (e.g., "https://accounts.google.com")
 * @returns Parsed provider metadata with authorization_endpoint, token_endpoint, jwks_uri, userinfo_endpoint, and issuer
 * @throws {Error} If discovery fails or required fields are missing
 */
export async function fetchProviderMetadata(issuer) {
    // Normalize issuer: remove trailing slash
    const normalizedIssuer = issuer.replace(/\/+$/, "");
    const discoveryUrl = `${normalizedIssuer}/.well-known/openid-configuration`;
    const response = await fetch(discoveryUrl);
    if (!response.ok) {
        throw new Error(`OIDC discovery failed: ${response.status} ${response.statusText}`);
    }
    let metadata;
    try {
        metadata = (await response.json());
    }
    catch (e) {
        throw new Error("OIDC discovery response is not valid JSON");
    }
    // Validate required fields
    const requiredFields = [
        "authorization_endpoint",
        "token_endpoint",
        "jwks_uri",
        "userinfo_endpoint",
        "issuer",
    ];
    for (const field of requiredFields) {
        if (!metadata[field] || typeof metadata[field] !== "string") {
            throw new Error(`OIDC discovery response missing required field: ${field}`);
        }
    }
    return {
        authorization_endpoint: metadata.authorization_endpoint,
        token_endpoint: metadata.token_endpoint,
        jwks_uri: metadata.jwks_uri,
        userinfo_endpoint: metadata.userinfo_endpoint,
        issuer: metadata.issuer,
    };
}
/**
 * Decodes a JWT header or payload from base64url encoding.
 *
 * @param part - The base64url-encoded JWT part
 * @returns Parsed JSON object
 * @throws {Error} If the part is not valid base64url or JSON
 */
function decodeJwtPart(part) {
    // Add padding if needed
    const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
    // Replace URL-safe chars
    const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
    let json;
    try {
        json = Buffer.from(base64, "base64").toString("utf-8");
    }
    catch (e) {
        throw new Error(`Invalid JWT encoding`);
    }
    try {
        return JSON.parse(json);
    }
    catch (e) {
        throw new Error(`Invalid JWT JSON`);
    }
}
/**
 * Converts a JWK (JSON Web Key) to a Node.js KeyObject for verification.
 *
 * @param jwk - The JWK containing RSA public key parameters
 * @returns Node.js KeyObject for crypto operations
 */
function jwkToKeyObject(jwk) {
    // Use Node.js built-in JWK import format
    return createPublicKey({ key: jwk, format: "jwk" });
}
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
export async function validateIdToken(idToken, jwksUri, expectedAud, expectedIss) {
    // Split JWT into parts
    const parts = idToken.split(".");
    if (parts.length !== 3) {
        throw new Error("Invalid JWT format: expected 3 parts");
    }
    const [headerB64, payloadB64, signatureB64] = parts;
    // Decode header and payload
    let header;
    let payload;
    try {
        header = decodeJwtPart(headerB64);
        payload = decodeJwtPart(payloadB64);
    }
    catch (e) {
        throw new Error(e instanceof Error ? e.message : "Invalid JWT encoding");
    }
    // Validate algorithm
    if (header.alg !== "RS256") {
        throw new Error(`Unsupported algorithm: ${header.alg}`);
    }
    // Validate audience
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(expectedAud)) {
        throw new Error(`Invalid audience: expected "${expectedAud}", got "${payload.aud}"`);
    }
    // Validate issuer
    if (payload.iss !== expectedIss) {
        throw new Error(`Invalid issuer: expected "${expectedIss}", got "${payload.iss}"`);
    }
    // Validate expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
        throw new Error("Token expired");
    }
    // Validate issued at (with small clock skew tolerance of 60 seconds)
    if (payload.iat > now + 60) {
        throw new Error("Token issued in the future");
    }
    // Fetch JWKS
    const jwksResponse = await fetch(jwksUri);
    if (!jwksResponse.ok) {
        throw new Error(`Failed to fetch JWKS: ${jwksResponse.status} ${jwksResponse.statusText}`);
    }
    let jwks;
    try {
        jwks = (await jwksResponse.json());
    }
    catch (e) {
        throw new Error("JWKS response is not valid JSON");
    }
    // Find matching key by kid
    const kid = header.kid;
    const jwk = kid
        ? jwks.keys.find((k) => k.kid === kid)
        : jwks.keys.find((k) => k.use === "sig" && k.kty === "RSA");
    if (!jwk) {
        throw new Error(kid
            ? `No matching JWK found for kid: ${kid}`
            : "No suitable signing key found in JWKS");
    }
    // Verify signature
    const keyObject = jwkToKeyObject(jwk);
    const signingInput = `${headerB64}.${payloadB64}`;
    // Convert signature from base64url to Buffer
    const signatureB64Padded = signatureB64 + "=".repeat((4 - (signatureB64.length % 4)) % 4);
    const signature = Buffer.from(signatureB64Padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingInput);
    verifier.end();
    const isValid = verifier.verify(keyObject, signature);
    if (!isValid) {
        throw new Error("JWT signature verification failed");
    }
    return payload;
}
//# sourceMappingURL=oidc.js.map