# PBKDF2 Performance Benchmarks

## Implementation Details
- **Default operation**: 100,000 iterations for both encryption and decryption (runtime optimized)
- **Hardened key generation**: 600,000 iterations available via explicit parameters
- **Backward compatibility**: Existing encrypted data continues to work

## Performance Comparison (measured on Apple M2, Node.js 22.12.0)
| Operation  | 100k iterations (default) | 600k iterations (hardened) |
|------------|---------------------------|----------------------------|
| Key derive | ~17.5 ms                  | ~100 ms                    |
| Encryption | ~18 ms (derive + AES-GCM) | ~100 ms (derive + AES-GCM) |
| Decryption | ~18 ms (derive + AES-GCM) | ~100 ms (derive + AES-GCM) |

*Measurements include PBKDF2 key derivation + AES-GCM encryption/decryption. Numbers are approximate (Apple M2, Node.js 22.12.0) and vary by hardware. The 600k iteration count is 6× the default, and key derivation time scales approximately linearly with iteration count.*

## Analysis
1. Default 100k iterations provides ~18ms total runtime for encryption/decryption
2. 600k iterations (6× iterations) takes ~6× longer (~100ms) — scales linearly as expected
3. Cache key includes full key material, salt, and iteration count to prevent collisions
4. Maintains backward compatibility with existing encrypted data (falls back to 100k)

## Usage
```typescript
// Default usage (100k iterations for both encrypt/decrypt)
const { ciphertext, salt, iv, iterations } = await encrypt(plaintext, keyMaterial);
const decrypted = await decrypt(JSON.stringify({ ciphertext, salt, iv, iterations }), keyMaterial);

// Hardened key generation (explicit 600k iterations)
const { key, salt } = await deriveKey(keyMaterial, undefined, 600000);

// Explicit encryption with hardened parameters
const { ciphertext, salt, iv, iterations } = await encrypt(plaintext, keyMaterial, 600000);
const decrypted = await decrypt(JSON.stringify({ ciphertext, salt, iv, iterations }), keyMaterial, 600000);
```

## Conclusion
The implementation reduces runtime cryptographic overhead while maintaining flexibility for enhanced security requirements. Default operations use 100,000 iterations for optimal performance (~18ms), with 600,000 iterations available when stronger key derivation is needed (~100ms).
