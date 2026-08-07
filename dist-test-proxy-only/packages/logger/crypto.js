/**
 * AES-256-GCM encryption utilities for @contextio/logger.
 *
 * Uses Node.js built-in `node:crypto` — zero external dependencies.
 *
 * All crypto operations are async (deriveKey, encrypt, decrypt) using the
 * non-blocking `pbkdf2` API. This aligns with the parent spec (contextio-mol-6rd)
 * and avoids blocking the event loop during PBKDF2 key derivation (see
 * contextio-mol-6rd.2 hardening bead).
 *
 * Wire format: JSON object with base64url-encoded `ciphertext` (GCM auth tag
 * prepended to ciphertext bytes), `salt`, `iv`, and optional `iterations`.
 * The caller **must** persist the salt alongside the ciphertext and provide it
 * back to `decrypt`.
 *
 * Key derivation: PBKDF2 + HMAC-SHA256, 100 000 iterations for runtime
 * encryption/decryption, 600 000 iterations available for hardened key generation.
 */
import { promisify } from "node:util";
import { pbkdf2, randomBytes, createCipheriv, createDecipheriv, } from "node:crypto";
import { Buffer } from "node:buffer";
const pbkdf2Async = promisify(pbkdf2);
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // 96 bits — recommended for GCM
const SALT_LENGTH = 16;
const DIGEST_ALGO = "sha256";
/**
 * Cache derived PBKDF2 keys by salt to avoid recalculating for repeated salts.
 * Process-wide singleton keyed by base64url-encoded salt + iterations + keyMaterial.
 */
const keyCache = new Map();
/**
 * Derive a 256-bit symmetric key from a passphrase using PBKDF2.
 *
 * If no salt is provided a fresh random salt is generated and returned.
 * The caller must persist this salt with the ciphertext.
 *
 * Uses the async `pbkdf2` variant to avoid blocking the event loop
 * during the expensive key-derivation operation.
 *
 * @param iterations - PBKDF2 iteration count (default: 100,000 for runtime).
 *                     Pass 600,000 for hardened key generation.
 */
export async function deriveKey(keyMaterial, salt, iterations = 100000) {
    const resolvedSalt = salt ?? randomBytes(SALT_LENGTH);
    const saltKey = base64url(Buffer.from(resolvedSalt));
    // Cache key includes delimiter to prevent collisions between different keyMaterial/iterations/salt combinations
    const cacheKey = `${keyMaterial}|${iterations}|${saltKey}`;
    const cachedKey = keyCache.get(cacheKey);
    if (cachedKey) {
        return { key: cachedKey, salt: resolvedSalt };
    }
    const key = await pbkdf2Async(keyMaterial, resolvedSalt, iterations, KEY_LENGTH, DIGEST_ALGO);
    keyCache.set(cacheKey, key);
    return { key, salt: resolvedSalt };
}
/**
 * Encrypt a UTF-8 string using AES-256-GCM.
 *
 * Returns base64url-encoded components. The output `ciphertext` contains:
 * - the 16-byte GCM authentication tag at the start
 * - followed by the AES-GCM ciphertext bytes
 */
export async function encrypt(plaintext, keyMaterial, iterations) {
    validateKey(keyMaterial);
    const actualIterations = iterations ?? 100000;
    const { key, salt } = await deriveKey(keyMaterial, undefined, actualIterations);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Prepend auth tag to ciphertext
    const sealed = Buffer.concat([tag, ciphertext]);
    return {
        ciphertext: base64url(sealed),
        salt: base64url(Buffer.from(salt)),
        iv: base64url(Buffer.from(iv)),
        iterations: actualIterations,
    };
}
/**
 * Decrypt a payload produced by `encrypt`.
 *
 * Parses the JSON, re-derives the key using the stored salt and iteration count,
 * verifies the authentication tag, and returns the plaintext.
 * Throws on auth failure or tampering.
 *
 * @param keyIterations - Override the iteration count stored in the payload.
 *                        Useful for testing or if payload lacks iteration info.
 */
export async function decrypt(encryptedJson, keyMaterial, keyIterations) {
    validateKey(keyMaterial);
    let payload;
    try {
        payload = JSON.parse(encryptedJson);
    }
    catch {
        throw new Error("Invalid encrypted payload: expected JSON");
    }
    const { ciphertext, salt, iv, iterations } = payload;
    if (!ciphertext || !salt || !iv) {
        throw new Error("Invalid encrypted payload: missing required fields");
    }
    // Use explicit keyIterations if provided, otherwise fall back to payload iterations or default 100k
    const actualIterations = keyIterations ?? iterations ?? 100000;
    const sealed = fromBase64url(ciphertext);
    const saltBuf = fromBase64url(salt);
    const ivFromPayload = fromBase64url(iv);
    // Validate decoded buffer lengths to catch malformed/corrupt payloads early
    if (ivFromPayload.length !== IV_LENGTH) {
        throw new Error(`Invalid encrypted payload: IV must be ${IV_LENGTH} bytes (got ${ivFromPayload.length})`);
    }
    if (saltBuf.length !== SALT_LENGTH) {
        throw new Error(`Invalid encrypted payload: salt must be ${SALT_LENGTH} bytes (got ${saltBuf.length})`);
    }
    // Need auth tag (16 bytes); empty plaintext is valid so 16 is the minimum
    if (sealed.length < 16) {
        throw new Error("Invalid encrypted payload: ciphertext too short");
    }
    const tag = sealed.subarray(0, 16);
    const actualCiphertext = sealed.subarray(16);
    // Derive the key using the stored salt and iteration count
    // Cache key includes iteration count to prevent key collisions
    try {
        const { key } = await deriveKey(keyMaterial, saltBuf, actualIterations);
        const decipher = createDecipheriv("aes-256-gcm", key, ivFromPayload);
        decipher.setAuthTag(tag);
        return (decipher.update(actualCiphertext, undefined, "utf8") + decipher.final("utf8"));
    }
    catch {
        throw new Error("Decryption failed: authentication tag mismatch (wrong key or tampered ciphertext)");
    }
}
/** Reject key material that is too short to be secure. */
export function validateKey(keyMaterial) {
    if (keyMaterial.length < 32) {
        throw new Error(`Key material must be at least 32 characters (got ${keyMaterial.length})`);
    }
    return true;
}
/* ----------------------------------------------------------------------- */
/* Helpers */
/* ----------------------------------------------------------------------- */
function base64url(buf) {
    return buf.toString("base64url");
}
function fromBase64url(str) {
    return new Uint8Array(Buffer.from(str, "base64url"));
}
//# sourceMappingURL=crypto.js.map