import { Buffer } from "node:buffer";
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
export declare function deriveKey(keyMaterial: string, salt?: Uint8Array, iterations?: number): Promise<{
    key: Buffer;
    salt: Uint8Array;
}>;
/**
 * Encrypt a UTF-8 string using AES-256-GCM.
 *
 * Returns base64url-encoded components. The output `ciphertext` contains:
 * - the 16-byte GCM authentication tag at the start
 * - followed by the AES-GCM ciphertext bytes
 */
export declare function encrypt(plaintext: string, keyMaterial: string, iterations?: number): Promise<{
    ciphertext: string;
    salt: string;
    iv: string;
    iterations: number;
}>;
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
export declare function decrypt(encryptedJson: string, keyMaterial: string, keyIterations?: number): Promise<string>;
/** Reject key material that is too short to be secure. */
export declare function validateKey(keyMaterial: string): boolean;
//# sourceMappingURL=crypto.d.ts.map