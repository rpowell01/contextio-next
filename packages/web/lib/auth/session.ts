/**
 * Session validation and user helpers for the web package.
 *
 * Provides server-side session validation using the same encrypted cookie
 * format as the proxy. Reads the session secret from OIDC_SESSION_SECRET env var.
 * Uses Web Crypto API (available in Edge runtime).
 */

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

// Crypto operations using Web Crypto API
async function deriveKey(sessionSecret: string, purpose: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(sessionSecret),
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(purpose),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function deriveHmacKey(sessionSecret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(sessionSecret),
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("hmac-key"),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"]
  );
}

function getSessionSecret(): string {
  const secret = process.env.CONTEXTIO_OIDC_SESSION_SECRET || process.env.OIDC_SESSION_SECRET;
  if (!secret) {
    throw new Error("CONTEXTIO_OIDC_SESSION_SECRET (or OIDC_SESSION_SECRET) environment variable is not set");
  }
  return secret;
}

async function decryptSession(cookie: SessionCookie, sessionSecret: string): Promise<AuthSession | null> {
  try {
    const encryptionKey = await deriveKey(sessionSecret, "encryption-key");
    const hmacKey = await deriveHmacKey(sessionSecret);

    // Verify HMAC
    const encryptedWithTag = Uint8Array.from(atob(cookie.data.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const expectedHmac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, encryptedWithTag));
    const providedHmac = Uint8Array.from(atob(cookie.hmac.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

    if (expectedHmac.length !== providedHmac.length) return null;
    let equal = true;
    for (let i = 0; i < expectedHmac.length; i++) {
      if (expectedHmac[i] !== providedHmac[i]) {
        equal = false;
        break;
      }
    }
    if (!equal) return null;

    // Split encrypted data and auth tag (last 16 bytes)
    const authTag = encryptedWithTag.slice(-16);
    const encrypted = encryptedWithTag.slice(0, -16);

    const iv = Uint8Array.from(atob(cookie.iv.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      encryptionKey,
      new Uint8Array([...encrypted, ...authTag])
    );

    const session = JSON.parse(new TextDecoder().decode(decrypted)) as AuthSession;

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
  const { cookies } = await import("next/headers");
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

/**
 * Clears the session cookie (for logout).
 * Note: This only clears the local cookie. For full logout,
 * redirect to /auth/logout which also clears the proxy session
 * and optionally redirects to the OIDC provider's logout endpoint.
 */
export async function clearSession(): Promise<void> {
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}