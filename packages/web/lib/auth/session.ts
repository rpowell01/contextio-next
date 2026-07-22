/**
 * Session validation and user helpers for the web package.
 *
 * Provides server-side session validation using the same encrypted cookie
 * format as the proxy. Reads the session secret from OIDC_SESSION_SECRET env var.
 */

import { cookies } from "next/headers";
import { createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";

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

interface SessionCookie {
  /** Encrypted session data. */
  data: string;
  /** HMAC-SHA256 of the encrypted data for integrity. */
  hmac: string;
  /** Initialization vector used for encryption. */
  iv: string;
}

const SESSION_COOKIE_NAME = "contextio_session";

/**
 * Gets the session secret from environment variables.
 * Must match the proxy's CONTEXTIO_OIDC_SESSION_SECRET.
 */
function getSessionSecret(): string {
  const secret = process.env.CONTEXTIO_OIDC_SESSION_SECRET || process.env.OIDC_SESSION_SECRET;
  if (!secret) {
    throw new Error("CONTEXTIO_OIDC_SESSION_SECRET (or OIDC_SESSION_SECRET) environment variable is not set");
  }
  return secret;
}

/**
 * Derives an encryption key from the session secret using HMAC-SHA256.
 * Uses first 32 bytes for AES-256-GCM.
 */
function deriveEncryptionKey(sessionSecret: string): Buffer {
  return createHmac("sha256", sessionSecret).update("encryption-key").digest().subarray(0, 32);
}

/**
 * Derives an HMAC key from the session secret.
 */
function deriveHmacKey(sessionSecret: string): Buffer {
  return createHmac("sha256", sessionSecret).update("hmac-key").digest();
}

/**
 * Decrypts and validates session cookie.
 * Returns session if valid, null if invalid/missing/expired.
 */
function decryptSession(cookie: SessionCookie, sessionSecret: string): AuthSession | null {
  try {
    const key = deriveEncryptionKey(sessionSecret);
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
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const session = JSON.parse(decrypted.toString("utf8")) as AuthSession;

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (session.expiresAt < now) {
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

/**
 * Validates the session from the request cookies.
 * Returns the session if valid, null otherwise.
 */
export async function getSession(): Promise<AuthSession | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);

  if (!sessionCookie?.value) {
    return null;
  }

  try {
    const cookie = JSON.parse(sessionCookie.value) as SessionCookie;
    const sessionSecret = getSessionSecret();
    return decryptSession(cookie, sessionSecret);
  } catch {
    return null;
  }
}

/**
 * Gets the current user from the session.
 * Returns user info if authenticated, null otherwise.
 */
export async function getUser(): Promise<AuthSession | null> {
  return getSession();
}

/**
 * Clears the session cookie (for logout).
 * Note: This only clears the local cookie. For full logout,
 * redirect to /auth/logout which also clears the proxy session
 * and optionally redirects to the OIDC provider's logout endpoint.
 */
export async function clearSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}

/**
 * Checks if the current request has a valid session.
 * Useful for middleware or server components.
 */
export async function isAuthenticated(): Promise<boolean> {
  const session = await getSession();
  return session !== null;
}

/**
 * Gets the user's subject ID (sub) from the session.
 * Convenience method for logging/identification.
 */
export async function getUserId(): Promise<string | null> {
  const session = await getSession();
  return session?.sub ?? null;
}

/**
 * Gets the user's email from the session.
 */
export async function getUserEmail(): Promise<string | null> {
  const session = await getSession();
  return session?.email ?? null;
}

/**
 * Gets the user's name from the session.
 */
export async function getUserName(): Promise<string | null> {
  const session = await getSession();
  return session?.name ?? null;
}

/**
 * Gets the user's picture URL from the session.
 */
export async function getUserPicture(): Promise<string | null> {
  const session = await getSession();
  return session?.picture ?? null;
}