---
layout: doc
---

# Required Secrets

These secrets **must** be provided via environment variables or Docker secrets. They are never read from the settings file.

## CSRF_SECRET

**Required** — Session cookie signing secret for the web UI.

- **Min length**: 32 characters
- **Used for**: Signing session cookies, CSRF protection
- **Generate**: `openssl rand -base64 32`

```bash
openssl rand -base64 32
# Example output: K7gNU6s8V9pL2jK4mN9qR3tY6uI8oP1aZ3xC5vB7nM=
```

> **Coolify**: Coolify injects this automatically at runtime. You don't need to set it manually.

## CONTEXTIO_LOGGER_ENCRYPTION_KEY

**Required** — AES-256-GCM encryption key for capture files at rest.

- **Min length**: 32 characters (256 bits)
- **Used for**: Deriving per-file encryption keys via PBKDF2 (100k iterations)
- **Generate**: `openssl rand -base64 32`

```bash
openssl rand -base64 32
# Example output: Q3wE6rT9yU2iO5pL8kJ1hG4fD7sA0zX3cV6bN9mQ2wE=
```

### How Encryption Works

1. Master key from `CONTEXTIO_LOGGER_ENCRYPTION_KEY`
2. Per-file: random salt (16 bytes) + PBKDF2 (100k iterations) → file key
3. Per-file: random nonce (12 bytes) + AES-256-GCM encryption
4. Format: `base64url(salt).base64url(nonce).base64url(ciphertext)`

The master key **never** leaves the container — it only exists in memory at runtime.

## OIDC Secrets (If Enabled)

When `CONTEXTIO_OIDC_ENABLED=true`, these are also required:

| Variable | Description |
|----------|-------------|
| `CONTEXTIO_OIDC_CLIENT_SECRET` | OAuth2 client secret from your OIDC provider |
| `CONTEXTIO_OIDC_SESSION_SECRET` | Session cookie signing secret (min 32 chars, separate from CSRF_SECRET) |

Generate session secret:
```bash
openssl rand -base64 32
```

## Docker Secrets

Instead of environment variables, you can use Docker secrets:

```yaml
# docker-compose.yml
services:
  contextio-next:
    image: ghcr.io/rpowell01/contextio-next:main
    secrets:
      - csrf_secret
      - encryption_key
      - oidc_client_secret
      - oidc_session_secret
    environment:
      - CSRF_SECRET_FILE=/run/secrets/csrf_secret
      - CONTEXTIO_LOGGER_ENCRYPTION_KEY_FILE=/run/secrets/encryption_key
      - CONTEXTIO_OIDC_CLIENT_SECRET_FILE=/run/secrets/oidc_client_secret
      - CONTEXTIO_OIDC_SESSION_SECRET_FILE=/run/secrets/oidc_session_secret

secrets:
  csrf_secret:
    file: ./secrets/csrf_secret.txt
  encryption_key:
    file: ./secrets/encryption_key.txt
  oidc_client_secret:
    file: ./secrets/oidc_client_secret.txt
  oidc_session_secret:
    file: ./secrets/oidc_session_secret.txt
```

## Security Best Practices

1. **Never commit secrets** to version control
2. **Use different secrets** for each environment (dev, staging, prod)
3. **Rotate secrets** periodically
4. **Use Docker secrets** or Kubernetes secrets in production
5. **Audit access** to secrets regularly

## Verification

Check that secrets are properly loaded:

```bash
# In container
docker exec -it contextio-next env | grep -E "CSRF_SECRET|ENCRYPTION_KEY|OIDC.*SECRET"

# Should show values (not empty)
```