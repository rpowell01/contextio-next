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
 * prepended to ciphertext bytes), `salt`, and `iv`. The caller **must**
 * persist the salt alongside the ciphertext and provide it back to `decrypt`.
 *
 * Key derivation: PBKDF2 + HMAC-SHA256, 600 000 iterations, 32-byte key.
 */

import {
  pbkdf2,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { Buffer } from "node:buffer";

const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // 96 bits — recommended for GCM
const SALT_LENGTH = 16;

// OWASP (2023) recommends >= 600,000 iterations for PBKDF2-HMAC-SHA256
// to provide adequate resistance against GPU-based password cracking.
// See: https://cheatsheetseries.owasp.org/cheatsheets/Password_Based_Key_Derivation_Cheat_Sheet.html
const PBKDF2_ITERATIONS = 600_000;
const DIGEST_ALGO = "sha256";

/**
 * Derive a 256-bit symmetric key from a passphrase using PBKDF2.
 *
 * If no salt is provided a fresh random salt is generated and returned.
 * The caller must persist this salt with the ciphertext.
 *
 * Uses the async `pbkdf2` variant to avoid blocking the event loop
 * during the expensive key-derivation operation.
 */
export async function deriveKey(
  keyMaterial: string,
  salt?: Uint8Array,
): Promise<{ key: Buffer; salt: Uint8Array }> {
  const resolvedSalt = salt ?? randomBytes(SALT_LENGTH);
  const key = await pbkdf2(
    keyMaterial,
    resolvedSalt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    DIGEST_ALGO,
  );
  return { key, salt: resolvedSalt };
}

/**
 * Encrypt a UTF-8 string using AES-256-GCM.
 *
 * Returns base64url-encoded components. The output `ciphertext` contains:
 * - the 16-byte GCM authentication tag at the start
 * - followed by the AES-GCM ciphertext bytes
 */
export async function encrypt(
  plaintext: string,
  keyMaterial: string,
): Promise<{ ciphertext: string; salt: string; iv: string }> {
  validateKey(keyMaterial);

  const { key, salt } = await deriveKey(keyMaterial);
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
  };
}

/**
 * Decrypt a payload produced by `encrypt`.
 *
 * Parses the JSON, re-derives the key using the stored salt, verifies the
 * authentication tag, and returns the plaintext.
 * Throws on auth failure or tampering.
 */
export async function decrypt(
  encryptedJson: string,
  keyMaterial: string,
): Promise<string> {
  validateKey(keyMaterial);

  let payload: { ciphertext: string; salt: string; iv: string };
  try {
    payload = JSON.parse(encryptedJson) as {
      ciphertext: string;
      salt: string;
      iv: string;
    };
  } catch {
    throw new Error("Invalid encrypted payload: expected JSON");
  }

  const { ciphertext, salt, iv } = payload;
  if (!ciphertext || !salt || !iv) {
    throw new Error("Invalid encrypted payload: missing required fields");
  }

  const sealed = fromBase64url(ciphertext);
  const saltBuf = fromBase64url(salt);
  const ivFromPayload = fromBase64url(iv);

  // Need auth tag (16 bytes); empty plaintext is valid so 16 is the minimum
  if (sealed.length < 16) {
    throw new Error("Invalid encrypted payload: ciphertext too short");
  }

  const tag = sealed.subarray(0, 16);
  const actualCiphertext = sealed.subarray(16);

  // Derive the key using the stored salt
  const { key } = await deriveKey(keyMaterial, saltBuf);
const decipher = createDecipheriv("aes-256-gcm", key, ivFromPayload);
  decipher.setAuthTag(tag);
  try {
    return decipher.update(actualCiphertext, undefined, "utf8") + decipher.final();
  } catch {
    throw new Error(
      "Decryption failed: authentication tag mismatch (wrong key or tampered ciphertext)",
    );
  }
}

/** Reject key material that is too short to be secure. */
export function validateKey(keyMaterial: string): boolean {
  if (keyMaterial.length < 32) {
    throw new Error(
      `Key material must be at least 32 characters (got ${keyMaterial.length})`,
    );
  }
  return true;
}

/* ----------------------------------------------------------------------- */
/* Helpers */
/* ----------------------------------------------------------------------- */

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromBase64url(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, "base64url"));
}
