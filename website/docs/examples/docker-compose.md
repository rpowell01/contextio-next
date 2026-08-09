---
layout: doc
---

# Docker Compose Examples

Complete `docker-compose.yml` configurations for different scenarios.

## Basic (Default)

```yaml
# docker-compose.yml
services:
  contextio-next:
    image: ghcr.io/rpowell01/contextio-next:main
    ports:
      - "4040:4040"
    volumes:
      - captures:/app/captures
      - policy:/app/custom-policy
      - settings:/home/node/.contextio-next
    environment:
      - CSRF_SECRET=${CSRF_SECRET}
      - CONTEXTIO_LOGGER_ENCRYPTION_KEY=${CONTEXTIO_LOGGER_ENCRYPTION_KEY}
    restart: unless-stopped

volumes:
  captures:
  policy:
  settings:
```

```env
# .env
CSRF_SECRET=your-csrf-secret
CONTEXTIO_LOGGER_ENCRYPTION_KEY=your-encryption-key
```

## Production with All Features

```yaml
# docker-compose.yml
services:
  contextio-next:
    image: ghcr.io/rpowell01/contextio-next:main
    ports:
      - "4040:4040"
    volumes:
      - captures:/app/captures
      - policy:/app/custom-policy
      - settings:/home/node/.contextio-next
    environment:
      # Required
      - CSRF_SECRET=${CSRF_SECRET}
      - CONTEXTIO_LOGGER_ENCRYPTION_KEY=${CONTEXTIO_LOGGER_ENCRYPTION_KEY}
      
      # Core
      - CONTEXT_PROXY_PORT=4040
      - LOG_LEVEL=info
      - DEBUG_ROUTING=false
      
      # Logging
      - LOGGER_CAPTURE_DIR=/app/captures
      - LOGGER_CAPTURE_MAX_AGE=90
      - LOGGER_CAPTURE_CLEANUP_INTERVAL=24
      - LOGGER_CAPTURE_CLEANUP_ENABLED=true
      
      # Encryption
      - CONTEXTIO_LOGGER_ENCRYPTION_ENABLED=true
      
      # Redaction
      - REDACT_PRESET=pii
      - REDACT_REVERSIBLE=false
      - REDACT_GLINER_ENABLED=true
      - REDACT_GLINER_THRESHOLD=0.5
      
      # Rate Limiting
      - RATE_LIMITER_ENABLED=true
      - CONTEXTIO_RATE_LIMIT_ANTHROPIC_MAX_REQUESTS=100
      - CONTEXTIO_RATE_LIMIT_ANTHROPIC_WINDOW_MS=60000
      - CONTEXTIO_RATE_LIMIT_ANTHROPIC_BUFFER=20
      - CONTEXTIO_RATE_LIMIT_OPENAI_MAX_REQUESTS=100
      - CONTEXTIO_RATE_LIMIT_OPENAI_WINDOW_MS=60000
      - CONTEXTIO_RATE_LIMIT_OPENAI_BUFFER=20
      - CONTEXTIO_RATE_LIMIT_NVIDIA_MAX_REQUESTS=50
      - CONTEXTIO_RATE_LIMIT_NVIDIA_WINDOW_MS=60000
      - CONTEXTIO_RATE_LIMIT_NVIDIA_BUFFER=10
      
      # Retry
      - CONTEXTIO_RETRY_ENABLED=true
      - CONTEXTIO_RETRY_MAX_ATTEMPTS=3
      - CONTEXTIO_RETRY_BASE_DELAY_MS=500
      - CONTEXTIO_RETRY_MAX_DELAY_MS=30000
      
      # OIDC (uncomment to enable)
      # - CONTEXTIO_OIDC_ENABLED=true
      # - CONTEXTIO_OIDC_ISSUER=https://accounts.google.com
      # - CONTEXTIO_OIDC_CLIENT_ID=${OIDC_CLIENT_ID}
      # - CONTEXTIO_OIDC_CLIENT_SECRET=${OIDC_CLIENT_SECRET}
      # - CONTEXTIO_OIDC_SESSION_SECRET=${OIDC_SESSION_SECRET}
      # - CONTEXTIO_OIDC_PUBLIC_URL=https://contextio.example.com
      
      # Web UI
      - NEXT_PUBLIC_SITE_URL=https://contextio.example.com
      
      # Upstream URLs (override if needed)
      # - UPSTREAM_ANTHROPIC_URL=https://api.anthropic.com
      # - UPSTREAM_OPENAI_URL=https://api.openai.com
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:4040"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  captures:
  policy:
  settings:
```

## With Mitmproxy (for Codex/Copilot/OpenCode)

```yaml
# docker-compose.yml
services:
  contextio-next:
    image: ghcr.io/rpowell01/contextio-next:main
    ports:
      - "4040:4040"
    volumes:
      - captures:/app/captures
      - policy:/app/custom-policy
      - settings:/home/node/.contextio-next
      - ./mitmproxy:/home/node/.mitmproxy  # CA certs
    environment:
      - CSRF_SECRET=${CSRF_SECRET}
      - CONTEXTIO_LOGGER_ENCRYPTION_KEY=${CONTEXTIO_LOGGER_ENCRYPTION_KEY}
      - CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE=1
    restart: unless-stopped
    depends_on:
      - mitmproxy

  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    command: 
      - mitmdump
      - --mode
      - upstream:http://contextio-next:4040
      - --set
      - block_global=false
      - --ssl-insecure
      - -p
      - "8080"
    ports:
      - "8080:8080"
    volumes:
      - ./mitmproxy:/home/mitmproxy/.mitmproxy
    restart: unless-stopped

volumes:
  captures:
  policy:
  settings:
```

**Client config for mitmproxy:**
```bash
export HTTPS_PROXY=http://localhost:8080
# or for Docker:
export HTTPS_PROXY=http://host.docker.internal:8080
```

## With Custom Redaction Policy

```yaml
# docker-compose.yml
services:
  contextio-next:
    image: ghcr.io/rpowell01/contextio-next:main
    ports:
      - "4040:4040"
    volumes:
      - captures:/app/captures
      - policy:/app/custom-policy
      - settings:/home/node/.contextio-next
      - ./my-policy.jsonc:/app/custom-policy/custom-policy.json:ro
    environment:
      - CSRF_SECRET=${CSRF_SECRET}
      - CONTEXTIO_LOGGER_ENCRYPTION_KEY=${CONTEXTIO_LOGGER_ENCRYPTION_KEY}
      - REDACT_POLICY_FILE=/app/custom-policy/custom-policy.json
    restart: unless-stopped

volumes:
  captures:
  policy:
  settings:
```

## With OIDC (Google)

```yaml
# docker-compose.yml
services:
  contextio-next:
    image: ghcr.io/rpowell01/contextio-next:main
    ports:
      - "4040:4040"
    volumes:
      - captures:/app/captures
      - policy:/app/custom-policy
      - settings:/home/node/.contextio-next
    environment:
      - CSRF_SECRET=${CSRF_SECRET}
      - CONTEXTIO_LOGGER_ENCRYPTION_KEY=${CONTEXTIO_LOGGER_ENCRYPTION_KEY}
      
      # OIDC
      - CONTEXTIO_OIDC_ENABLED=true
      - CONTEXTIO_OIDC_ISSUER=https://accounts.google.com
      - CONTEXTIO_OIDC_CLIENT_ID=${OIDC_CLIENT_ID}
      - CONTEXTIO_OIDC_CLIENT_SECRET=${OIDC_CLIENT_SECRET}
      - CONTEXTIO_OIDC_SESSION_SECRET=${OIDC_SESSION_SECRET}
      - CONTEXTIO_OIDC_PUBLIC_URL=https://contextio.example.com
      - CONTEXTIO_OIDC_SCOPE=openid profile email
      
      - NEXT_PUBLIC_SITE_URL=https://contextio.example.com
    restart: unless-stopped

volumes:
  captures:
  policy:
  settings:
```

## With Docker Secrets (Production)

```yaml
# docker-compose.yml
services:
  contextio-next:
    image: ghcr.io/rpowell01/contextio-next:main
    ports:
      - "4040:4040"
    volumes:
      - captures:/app/captures
      - policy:/app/custom-policy
      - settings:/home/node/.contextio-next
    environment:
      - [SECRET_REDACTED]    - [SECRET_REDACTED]    - [SECRET_REDACTED]    - [SECRET_REDACTED]secrets:
  csrf_secret:
    file: ./secrets/csrf_secret.txt
  encryption_key:
    file: ./secrets/encryption_key.txt
  oidc_client_secret:
    file: ./secrets/oidc_client_secret.txt
  oidc_session_secret:
    file: ./secrets/oidc_session_secret.txt

volumes:
  captures:
  policy:
  settings:
```

## Coolify Optimized

```yaml
# docker-compose.yml (for Coolify)
services:
  contextio-next:
    image: ghcr.io/rpowell01/contextio-next:main
    ports:
      - "4040:4040"
    environment:
      - CSRF_SECRET=${CSRF_SECRET}
      - CONTEXTIO_LOGGER_ENCRYPTION_KEY=${CONTEXTIO_LOGGER_ENCRYPTION_KEY}
      - NEXT_PUBLIC_SITE_URL=https://${COOLIFY_DOMAIN}
      - CONTEXTIO_OIDC_PUBLIC_URL=https://${COOLIFY_DOMAIN}
      # OIDC vars from Coolify secrets
    restart: unless-stopped
    # Coolify handles volumes via Persistent Directories
    # No volumes section needed
```

## Development Override

Create `docker-compose.override.yml` (gitignored):

```yaml
# docker-compose.override.yml
services:
  contextio-next:
    environment:
      - LOG_LEVEL=debug
      - DEBUG_ROUTING=true
      - LOG_TRAFFIC=true
    build:
      context: .
      dockerfile: Dockerfile
    volumes:
      - ./packages:/app/packages  # Live reload source
    command: pnpm dev
```