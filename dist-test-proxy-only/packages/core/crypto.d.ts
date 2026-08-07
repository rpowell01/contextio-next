/**
 * @contextio/core - Crypto utilities
 *
 * Shared cryptographic utilities for encryption/decryption used by
 * both the logger plugin and the redaction repository.
 */
/**
 * Derive a 32-byte AES-256 key from a password/passphrase using scrypt.
 * Uses a fixed salt for deterministic key derivation (salt is stored
 * alongside the ciphertext for decryption).
 */
export declare function deriveKey(password: string, salt: Buffer): Promise<Buffer>;
/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns a JSON-serializable object containing ciphertext, salt, and IV.
 * The same password can be used to decrypt with the returned salt and IV.
 */
export declare function encrypt(plaintext: string, password: string): Promise<{
    ciphertext: string;
    salt: string;
    iv: string;
}>;
/**
 * Decrypt ciphertext produced by `encrypt`.
 * Returns the original plaintext string.
 * Throws if decryption fails (wrong password, corrupted data, etc.).
 */
export declare function decrypt(payload: string | {
    ciphertext: string;
    salt: string;
    iv: string;
}, password: string): Promise<string>;
/**
 * Validate that a key string is suitable for encryption/decryption.
 * Returns true if the key is a non-empty string.
 */
export declare function validateKey(key: string): boolean;
export { deriveKey as deriveKeyFromPassword };
//# sourceMappingURL=crypto.d.ts.map