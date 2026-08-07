/**
 * @contextio/core - Crypto utilities
 *
 * Shared cryptographic utilities for encryption/decryption used by
 * both the logger plugin and the redaction repository.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
const scryptAsync = promisify(scrypt);
/**
 * Derive a 32-byte AES-256 key from a password/passphrase using scrypt.
 * Uses a fixed salt for deterministic key derivation (salt is stored
 * alongside the ciphertext for decryption).
 */
export async function deriveKey(password, salt) {
    return scryptAsync(password, salt, 32);
}
/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns a JSON-serializable object containing ciphertext, salt, and IV.
 * The same password can be used to decrypt with the returned salt and IV.
 */
export async function encrypt(plaintext, password) {
    const salt = randomBytes(16);
    const key = await deriveKey(password, salt);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        ciphertext: Buffer.concat([ciphertext, authTag]).toString("base64"),
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
    };
}
/**
 * Decrypt ciphertext produced by `encrypt`.
 * Returns the original plaintext string.
 * Throws if decryption fails (wrong password, corrupted data, etc.).
 */
export async function decrypt(payload, password) {
    let ciphertext;
    let salt;
    let iv;
    if (typeof payload === "string") {
        try {
            const parsed = JSON.parse(payload);
            if (typeof parsed.ciphertext !== "string" || typeof parsed.salt !== "string" || typeof parsed.iv !== "string") {
                throw new Error("Invalid encrypted payload format");
            }
            ciphertext = Buffer.from(parsed.ciphertext, "base64");
            salt = Buffer.from(parsed.salt, "base64");
            iv = Buffer.from(parsed.iv, "base64");
        }
        catch {
            throw new Error("Invalid encrypted payload format");
        }
    }
    else {
        ciphertext = Buffer.from(payload.ciphertext, "base64");
        salt = Buffer.from(payload.salt, "base64");
        iv = Buffer.from(payload.iv, "base64");
    }
    const key = await deriveKey(password, salt);
    const authTag = ciphertext.slice(-16);
    const actualCiphertext = ciphertext.slice(0, -16);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(actualCiphertext), decipher.final()]);
    return plaintext.toString("utf8");
}
/**
 * Validate that a key string is suitable for encryption/decryption.
 * Returns true if the key is a non-empty string.
 */
export function validateKey(key) {
    return typeof key === "string" && key.length > 0;
}
export { deriveKey as deriveKeyFromPassword };
//# sourceMappingURL=crypto.js.map