---
layout: doc
---

# Encryption at Rest

Capture files are encrypted with **AES-256-GCM** using a key derived from `CONTEXTIO_LOGGER_ENCRYPTION_KEY` via PBKDF2 (100,000 iterations). Each file gets a unique nonce.

## How It Works

```
Master Key (CONTEXTIO_LOGGER_ENCRYPTION_KEY)
       │
       ▼
┌──────────────────┐
│   Per File       │
│  ┌────────────┐  │
│  │ Salt (16B) │──┼──► PBKDF2 (100k iter) ──► File Key (32B)
│  └────────────┘  │
│  ┌────────────┐  │
│  │ Nonce (12B)│──┼──► AES-256-GCM encrypt
│  └────────────┘  │
│  ┌────────────┐  │
│  │Ciphertext  │  │
│  └────────────┘  │
└──────────────────┘
       │
       ▼
Stored as: base64url(salt).base64url(nonce).base64url(ciphertext)
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXTIO_LOGGER_ENCRYPTION_ENABLED` | `false` | Enable encryption |
| `CONTEXTIO_LOGGER_ENCRYPTION_KEY` | *(required if enabled)* | Master encryption key (base64, 32+ chars) |
| `CONTEXTIO_LOGGER_ENCRYPTION_KEY_PROVIDER` | `env` | Key source: `env` or `static` |
| `CONTEXTIO_LOGGER_ENCRYPTION_KEY_LENGTH` | `32` | Key length in bytes |
| `CONTEXTIO_LOGGER_ENCRYPTION_STATIC_KEY` | *(optional)* | Static key when provider=static |

## Enable Encryption

```bash
# 1. Generate key
openssl rand -base64 32
# Output: K7gNU6s8V9pL2jK4mN9qR3tY6uI8oP1aZ3xC5vB7nM=

# 2. Add to .env
CONTEXTIO_LOGGER_ENCRYPTION_ENABLED=true
CONTEXTIO_LOGGER_ENCRYPTION_KEY=K7gNU6s8V9pL2jK4mN9qR3tY6uI8oP1aZ3xC5vB7nM=
```

## Key Provider Options

### `env` (Default)
Reads key from `CONTEXTIO_LOGGER_ENCRYPTION_KEY` environment variable. Recommended for Docker/Kubernetes secrets.

### `static`
Uses `CONTEXTIO_LOGGER_ENCRYPTION_STATIC_KEY` directly without PBKDF2. **Not recommended** — less secure.

```env
CONTEXTIO_LOGGER_ENCRYPTION_KEY_PROVIDER=static
CONTEXTIO_LOGGER_ENCRYPTION_STATIC_KEY=your-raw-32-byte-hex-key
```

## File Format

Encrypted capture files have the extension `.json.enc` (or `.json` with encrypted content).

```
claude_a1b2c3d4_1739000000000-000001.json.enc
```

Content (base64url encoded):
```
c2FsdF9oZXJl.bm9uY2VfaGVyZQ.encrypted_ciphertext_here
```

## Decryption

Files are decrypted **transparently** when read via:
- Web UI (Sessions, Redactions pages)
- CLI (`ctxio inspect`, `ctxio export`, `ctxio replay`)
- Direct API calls to `/admin/captures/*`

The encryption key **never** leaves the container — it only exists in memory at runtime.

## Key Rotation

To rotate the encryption key:

1. **Decrypt all existing files** with old key
2. **Generate new key**: `openssl rand -base64 32`
3. **Update environment** with new key
4. **Restart container** — new captures use new key
5. **Re-encrypt old files** (optional, or keep dual-read capability)

CLI helper for migration:
```bash
# Decrypt all captures with old key
ctxio decrypt-captures --key-old <old-key> --key-new <new-key>
```

## Verification

Check encryption is working:
```bash
# List capture files
ls -la /app/captures/

# Encrypted files are smaller (compressed) and have .enc extension
# Or check file command:
file /app/captures/claude_*.json
# Output: data (not JSON text)
```

## Security Notes

- **Key strength**: 256-bit key via PBKDF2 (100k iterations) — resistant to brute force
- **Unique nonce**: 12-byte random nonce per file — prevents nonce reuse
- **Authenticated encryption**: GCM mode provides integrity + confidentiality
- **Key isolation**: Master key never written to disk, only in memory
- **No key in settings**: Keys never stored in `/app/custom-policy/settings.json`

## Performance

- Encryption adds ~1-2ms per capture file (negligible)
- PBKDF2 only runs once per file (key derivation)
- AES-GCM is hardware-accelerated on modern CPUs (AES-NI)

## Docker Secrets

Use Docker secrets instead of environment variables:

```yaml
services:
  contextio-next:
    secrets:
      - encryption_key
    environment:
      - CONTEXTIO_LOGGER_ENCRYPTION_KEY_FILE=/run/secrets/encryption_key
secrets:
  encryption_key:
    file: ./secrets/encryption_key.txt
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Encryption key not set` | Ensure `CONTEXTIO_LOGGER_ENCRYPTION_KEY` is set when `ENABLED=true` |
| `Failed to decrypt` | Key mismatch — use the same key that encrypted the files |
| `Corrupted ciphertext` | File may be truncated or corrupted — check disk space |
| Performance issues | Ensure AES-NI is available (check `lscpu \| grep aes`) |