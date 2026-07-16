const keyCache = new Map<string, Buffer>();

/**
 * Cache derived PBKDF2 keys by salt to avoid recalculating for repeated salts.
 * Process-wide singleton keyed by base64url-encoded salt.
 */
const keyCache = new Map<string, Buffer>();

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
  const saltKey = base64url(Buffer.from(resolvedSalt));

  const cachedKey = keyCache.get(saltKey);
  if (cachedKey) {
    return { key: cachedKey, salt: resolvedSalt };
  }

  const key = await pbkdf2Async(
    keyMaterial,
    saltKey,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    DIGEST_ALGO,
  );
  keyCache.set(saltKey, key);
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

  // Validate decoded buffer lengths to catch malformed/corrupt payloads early
  if (ivFromPayload.length !== IV_LENGTH) {
    throw new Error(
      `Invalid encrypted payload: IV must be ${IV_LENGTH} bytes (got ${ivFromPayload.length})`,
    );
  }
  if (saltBuf.length !== SALT_LENGTH) {
    throw new Error(
      `Invalid encrypted payload: salt must be ${SALT_LENGTH} bytes (got ${saltBuf.length})`,
    );
  }

  keyCache.set(saltStr, key);

  return { key, salt: saltKey };
}

// ...rest of the file remains unchanged...