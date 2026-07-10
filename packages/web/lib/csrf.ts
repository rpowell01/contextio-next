/**
 * Stateless CSRF token using Web Crypto API (works in Edge runtime)
 */
const CSRF_SECRET = process.env.CSRF_SECRET;
const CSRF_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

let _ephemeralSecret: string | undefined;

async function getSecret(): Promise<string> {
  if (CSRF_SECRET) return CSRF_SECRET;
  if (process.env.NODE_ENV === "production") {
    throw new Error("CSRF_SECRET environment variable is required in production");
  }
  if (!_ephemeralSecret) {
    // Only in development: use a session-bound ephemeral secret
    // This prevents token forgery across restarts while not requiring config
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    _ephemeralSecret = Array.from(array)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    console.warn(
      "[csrf] CSRF_SECRET not set; using ephemeral development secret (changes on restart)",
    );
  }
  return _ephemeralSecret!;
}

export interface CSRFToken {
  nonce: string;
  timestamp: number;
}

/**
 * Import crypto key for HMAC
 */
async function getHmacKey(): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(await getSecret());
  return crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/**
 * Create a stateless CSRF token with HMAC signature
 */
export async function issueToken(): Promise<string> {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const timestamp = Date.now();
  const payload = `${nonce}.${timestamp}`;
  const key = await getHmacKey();
  const encoder = new TextEncoder();
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const signature = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${payload}.${signature}`;
}

/**
 * Verify a CSRF token and return the parsed payload if valid
 */
export async function verifyToken(token: string): Promise<CSRFToken | null> {
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [nonce, timestampStr, signature] = parts;
  const payload = `${nonce}.${timestampStr}`;
  const key = await getHmacKey();
  const encoder = new TextEncoder();
  const expectedSignatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const expectedSignature = Array.from(new Uint8Array(expectedSignatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Timing-safe comparison
  if (signature.length !== expectedSignature.length) return null;
  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }
  if (result !== 0) return null;

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) return null;

  // Check expiry
  if (Date.now() - timestamp > CSRF_TOKEN_EXPIRY_MS) {
    return null;
  }

  return { nonce, timestamp };
}

/**
 * Consume (verify) a CSRF token
 * In stateless model, we just verify - the token can be reused within expiry window
 * For single-use, we'd need a store (Redis, etc.)
 */
export async function consumeToken(token: string): Promise<boolean> {
  return verifyToken(token) !== null;
}