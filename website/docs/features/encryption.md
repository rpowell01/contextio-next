---
layout: doc
---

# Encryption at Rest (Feature)

Capture files encrypted with AES-256-GCM, keys derived via PBKDF2 (100k iterations).

## Threat Model

| Threat | Mitigation |
|--------|------------|
| Disk theft | Files unreadable without key |
| Container escape | Key only in memory |
| Backup leakage | Encrypted at rest |
| Insider access | Key not in settings/logs |
| Key rotation | PBKDF2 allows re-derivation |

## Encryption Process

```
┌────────────────────────────────────────────────────────────┐
│  For each capture file:                                    │
│                                                            │
│  1. Random salt (16 bytes)                                 │
│  2. PBKDF2(masterKey, salt, 100k, SHA-256) → fileKey     │
│  3. Random nonce (12 bytes)                                │
│  4. AES-256-GCM(fileKey, nonce, plaintext) → ciphertext  │
│  5. Encode: base64url(salt).base64url(nonce).base64url(ct)│
└────────────────────────────────────────────────────────────┘
```

## File Format

```
claude_a1b2c3d4_1739000000000-000001.json.enc
```

Content:
```
c2FsdF9oZXJl.bm9uY2VfaGVyZQ.encrypted_ciphertext_and_auth_tag
```

| Component | Size | Encoding |
|-----------|------|----------|
| Salt | 16 bytes | base64url |
| Nonce | 12 bytes | base64url |
| Ciphertext + Tag | variable | base64url |

## Configuration

```env
# Required
CONTEXTIO_LOGGER_ENCRYPTION_ENABLED=true
CONTEXTIO_LOGGER_ENCRYPTION_KEY=<32+ char base64>

# Optional
CONTEXTIO_LOGGER_ENCRYPTION_KEY_PROVIDER=env    # or 'static'
CONTEXTIO_LOGGER_ENCRYPTION_KEY_LENGTH=32       # bytes
CONTEXTIO_LOGGER_ENCRYPTION_STATIC_KEY=...      # if provider=static
```

### Generate Key
```bash
openssl rand -base64 32
# K7gNU6s8V9pL2jK4mN9qR3tY6uI8oP1aZ3xC5vB7nM=
```

## Key Providers

### `env` (Default, Recommended)
- Reads from `CONTEXTIO_LOGGER_ENCRYPTION_KEY` env var
- Works with Docker secrets, Kubernetes secrets
- Key never written to disk

### `static` (Not Recommended)
- Uses `CONTEXTIO_LOGGER_ENCRYPTION_STATIC_KEY` directly
- Bypasses PBKDF2 — less secure
- For testing only

## Decryption

**Transparent** — happens automatically on read:
- Web UI (Sessions, Redactions, Export)
- CLI (`ctxio inspect`, `export`, `replay`)
- Admin API (`/admin/captures/*`)

No user action required — same API, files decrypted on-the-fly.

## Key Rotation

```bash
# 1. Decrypt all with old key
ctxio decrypt-captures --key-old <old-key> --output-dir /tmp/decrypted

# 2. Generate new key
openssl rand -base64 32

# 3. Update env, restart container
#    New captures use new key automatically

# 4. Re-encrypt old files (optional)
ctxio encrypt-captures --key-new <new-key> --input-dir /tmp/decrypted
```

## Performance

| Operation | Time (typical) |
|-----------|----------------|
| Encrypt (10KB) | ~1-2ms |
| Decrypt (10KB) | ~1-2ms |
| PBKDF2 (100k) | ~50ms (once per file) |

- AES-GCM hardware accelerated (AES-NI)
- PBKDF2 only on write (key derivation)
- Negligible impact on proxy throughput

## Security Properties

| Property | Value |
|----------|-------|
| Algorithm | AES-256-GCM |
| Key derivation | PBKDF2-HMAC-SHA256 |
| Iterations | 100,000 |
| Salt | 16 bytes (random per file) |
| Nonce | 12 bytes (random per file) |
| Auth tag | 16 bytes (included in ciphertext) |
| Key in memory | Yes (never on disk) |
| Key in settings | No (never) |
| Key in logs | No (never) |

## Verification

```bash
# Check files are encrypted
file /app/captures/*.json
# data (not "JSON text")

# Verify with key
node -e "
const fs = require('fs');
const { decryptCapture } = require('@contextio/logger');
const file = fs.readdirSync('/app/captures').find(f => f.endsWith('.enc'));
decryptCapture('/app/captures/' + file, process.env.CONTEXTIO_LOGGER_ENCRYPTION_KEY)
  .then(c => console.log('Decrypted OK:', c.sessionId));
"
```

## Docker Secrets

```yaml
services:
  contextio-next:
    secrets:
      - encryption_key
    environment:
      - [SECRET_REDACTED]secrets:
  encryption_key:
    file: ./secrets/encryption_key.txt
```

## Compliance

| Standard | Status |
|----------|--------|
| AES-256 | ✓ FIPS 197 |
| GCM mode | ✓ NIST SP 800-38D |
| PBKDF2 | ✓ NIST SP 800-132 |
| Key rotation | ✓ Supported |
| Audit trail | ✓ Capture metadata unencrypted |

## Limitations

- **Metadata not encrypted**: `sessionId`, `provider`, `timestamp`, `apiFormat` in SQLite index
- **No forward secrecy**: Compromised master key → all files decryptable
- **Single key**: All files use same master key (per-container)
- **No HSM support**: Key in process memory

## Migration from Unencrypted

```bash
# 1. Enable encryption
CONTEXTIO_LOGGER_ENCRYPTION_ENABLED=true
CONTEXTIO_LOGGER_ENCRYPTION_KEY=<new-key>

# 2. Restart — new captures encrypted
# 3. Old captures remain unencrypted (readable)
# 4. Optional: re-encrypt old files
ctxio migrate-captures --encrypt --key <new-key>
```