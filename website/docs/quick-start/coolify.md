---
layout: doc
---

# Coolify Deployment

Coolify is a self-hosted PaaS. This guide shows how to deploy ContextIO-Next on Coolify.

## Persistent Directories

Configure these **Persistent Directories** mappings in Coolify:

| Source Path | Destination Path |
|-------------|------------------|
| `/data/coolify/applications/contextio-next/captures` | `/app/captures` |
| `/data/coolify/applications/contextio-next/policy` | `/app/custom-policy` |
| `/data/coolify/applications/contextio-next/settings` | `/home/node/.contextio-next` |

## Environment Variables

Set these in Coolify **Environment Variables**:

### Required (Coolify injects `CSRF_SECRET` automatically)
```env
CSRF_SECRET=<injected-by-coolify>
CONTEXTIO_LOGGER_ENCRYPTION_KEY=<your-generated-key>
```

### Optional Configuration
```env
# Redaction
REDACT_PRESET=pii
REDACT_REVERSIBLE=false

# Rate Limiting
RATE_LIMITER_ENABLED=true
CONTEXTIO_RATE_LIMIT_ANTHROPIC_MAX_REQUESTS=100
CONTEXTIO_RATE_LIMIT_OPENAI_MAX_REQUESTS=100

# Logging
LOGGER_CAPTURE_MAX_AGE=30
LOGGER_CAPTURE_CLEANUP_INTERVAL=24

# OIDC (if enabled)
CONTEXTIO_OIDC_ENABLED=true
CONTEXTIO_OIDC_ISSUER=https://accounts.google.com
CONTEXTIO_OIDC_CLIENT_ID=<your-client-id>
CONTEXTIO_OIDC_CLIENT_SECRET=<your-client-secret>
CONTEXTIO_OIDC_SESSION_SECRET=<your-session-secret>
CONTEXTIO_OIDC_PUBLIC_URL=https://your-domain.com
```

## Build Configuration

In Coolify **Build Pack**, use **Dockerfile**:

```
Dockerfile: Dockerfile
Build Context: .
```

## Ports

- **Port**: 4040
- **Protocol**: HTTP
- **Expose**: Yes

## Health Check

Coolify uses the built-in health check:

```yaml
test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:4040"]
interval: 30s
timeout: 10s
retries: 3
start_period: 10s
```

## Custom Domain

1. Add your domain in Coolify **Domains**
2. Set `NEXT_PUBLIC_SITE_URL=https://your-domain.com`
3. For OIDC, set `CONTEXTIO_OIDC_PUBLIC_URL=https://your-domain.com`

## Secrets Management

**Never** put secrets in the Coolify UI environment variables that are stored in settings.json. Use Coolify's **Secrets** feature for:
- `CSRF_SECRET`
- `CONTEXTIO_LOGGER_ENCRYPTION_KEY`
- `CONTEXTIO_OIDC_CLIENT_SECRET`
- `CONTEXTIO_OIDC_SESSION_SECRET`

## Docker Compose (Alternative)

If you prefer Docker Compose on Coolify:

```yaml
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
      # ... other env vars
    restart: unless-stopped

volumes:
  captures:
  policy:
  settings:
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| CSRF validation fails | Ensure `CSRF_SECRET` is set and matches across deployments |
| OIDC callback fails | Check `CONTEXTIO_OIDC_PUBLIC_URL` matches your Coolify domain exactly |
| Captures not persisting | Verify persistent directory mappings are correct |
| Port conflicts | Ensure port 4040 is not used by another service |

## Updating

Coolify will automatically pull the latest `main` image on redeploy. To pin a version:

```env
# In Coolify, set the image tag
IMAGE_TAG=v1.2.3
```

Or use a specific SHA:
```yaml
image: ghcr.io/rpowell01/contextio-next:main-sha-abc123
```