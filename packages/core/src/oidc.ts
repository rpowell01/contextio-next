/**
 * OpenID Connect utilities for @contextio/core.
 *
 * Provides OIDC discovery and ID token validation using only
 * Node.js built-in modules (crypto, fetch). No external dependencies.
 */

import { createPublicKey, createVerify } from "node:crypto";

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
 * JWK (JSON Web Key) for RSA public key.
 */
interface Jwk {
  kty: "RSA";
  use?: "sig";
  kid?: string;
  n: string;
  e: string;
  alg?: "RS256";
  [key: string]: unknown;
}

/**
 * JWK Set response.
 */
interface JwkSet {
  keys: Jwk[];
}

/**
 * Fetches OpenID Connect provider metadata from the discovery endpoint.
 *
 * @param issuer - The OIDC issuer URL (e.g., "https://accounts.google.com")
 * @returns Parsed provider metadata with authorization_endpoint, token_endpoint, jwks_uri, userinfo_endpoint, and issuer
 * @throws {Error} If discovery fails or required fields are missing
 */
export async function fetchProviderMetadata(
  issuer: string,
): Promise<OidcProviderMetadata> {
  // Normalize issuer: remove trailing slash
  const normalizedIssuer = issuer.replace(/\/+$/, "");
  const discoveryUrl = `${normalizedIssuer}/.well-known/openid-configuration`;

  const response = await fetch(discoveryUrl);
  if (!response.ok) {
    throw new Error(
      `OIDC discovery failed: ${response.status} ${response.statusText}`,
    );
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = (await response.json()) as Record<string, unknown>;
  } catch (e) {
    throw new Error("OIDC discovery response is not valid JSON");
  }

  // Validate required fields
  const requiredFields = [
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
    "userinfo_endpoint",
    "issuer",
  ] as const;

  for (const field of requiredFields) {
    if (!metadata[field] || typeof metadata[field] !== "string") {
      throw new Error(
        `OIDC discovery response missing required field: ${field}`,
      );
    }
  }

  return {
    authorization_endpoint: metadata.authorization_endpoint as string,
    token_endpoint: metadata.token_endpoint as string,
    jwks_uri: metadata.jwks_uri as string,
    userinfo_endpoint: metadata.userinfo_endpoint as string,
    issuer: metadata.issuer as string,
  };
}

/**
 * Decodes a JWT header or payload from base64url encoding.
 *
 * @param part - The base64url-encoded JWT part
 * @returns Parsed JSON object
 * @throws {Error} If the part is not valid base64url or JSON
 */
function decodeJwtPart<T>(part: string): T {
  // Add padding if needed
  const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
  // Replace URL-safe chars
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");

  let json: string;
  try {
    json = Buffer.from(base64, "base64").toString("utf-8");
  } catch (e) {
    throw new Error(`Invalid JWT encoding`);
  }

  try {
    return JSON.parse(json) as T;
  } catch (e) {
    throw new Error(`Invalid JWT JSON`);
  }
}

/**
 * Converts a JWK (JSON Web Key) to a Node.js KeyObject for verification.
 *
 * @param jwk - The JWK containing RSA public key parameters
 * @returns Node.js KeyObject for crypto operations
 */
function jwkToKeyObject(jwk: Jwk): import("node:crypto").KeyObject {
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
export async function validateIdToken(
  idToken: string,
  jwksUri: string,
  expectedAud: string,
  expectedIss: string,
): Promise<JwtPayload> {
  // Split JWT into parts
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format: expected 3 parts");
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Decode header and payload
  let header: { alg: string; typ?: string; kid?: string };
  let payload: JwtPayload;

  try {
    header = decodeJwtPart<{ alg: string; typ?: string; kid?: string }>(
      headerB64,
    );
    payload = decodeJwtPart<JwtPayload>(payloadB64);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : "Invalid JWT encoding");
  }

  // Validate algorithm
  if (header.alg !== "RS256") {
    throw new Error(`Unsupported algorithm: ${header.alg}`);
  }

  // Validate audience
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(expectedAud)) {
    throw new Error(
      `Invalid audience: expected "${expectedAud}", got "${payload.aud}"`,
    );
  }

  // Validate issuer
  if (payload.iss !== expectedIss) {
    throw new Error(
      `Invalid issuer: expected "${expectedIss}", got "${payload.iss}"`,
    );
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
    throw new Error(
      `Failed to fetch JWKS: ${jwksResponse.status} ${jwksResponse.statusText}`,
    );
  }

  let jwks: JwkSet;
  try {
    jwks = (await jwksResponse.json()) as JwkSet;
  } catch (e) {
    throw new Error("JWKS response is not valid JSON");
  }

  // Find matching key by kid
  const kid = header.kid;
  const jwk = kid
    ? jwks.keys.find((k) => k.kid === kid)
    : jwks.keys.find((k) => k.use === "sig" && k.kty === "RSA");

  if (!jwk) {
    throw new Error(
      kid
        ? `No matching JWK found for kid: ${kid}`
        : "No suitable signing key found in JWKS",
    );
  }

  // Verify signature
  const keyObject = jwkToKeyObject(jwk);
  const signingInput = `${headerB64}.${payloadB64}`;

  // Convert signature from base64url to Buffer
  const signatureB64Padded =
    signatureB64 + "=".repeat((4 - (signatureB64.length % 4)) % 4);
  const signature = Buffer.from(
    signatureB64Padded.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  );

  const verifier = createVerify("RSA-SHA256");
  verifier.update(signingInput);
  verifier.end();

  const isValid = verifier.verify(keyObject, signature);
  if (!isValid) {
    throw new Error("JWT signature verification failed");
  }

  return payload;
}