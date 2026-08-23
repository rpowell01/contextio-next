---
layout: doc
---

# Environment Variables

All configuration is via environment variables. **Environment variables always override settings file values** (`/app/custom-policy/settings.json`).

## Configuration Precedence

```
Highest: Programmatic overrides (in code)
         ↓
         Environment variables (CONTEXTIO_*, REDACT_*, RATE_LIMITER_*, etc.)
         ↓
         Web UI settings file (/app/custom-policy/settings.json)
         ↓
Lowest:  Defaults (hardcoded in source)
```

**Secrets** (`CSRF_SECRET`, `CONTEXTIO_LOGGER_ENCRYPTION_KEY`, `CONTEXTIO_OIDC_CLIENT_SECRET`, `CONTEXTIO_OIDC_SESSION_SECRET`) must be set via environment variables or Docker secrets — they are never read from the settings file.

## Required Secrets (No Defaults)

| Variable | Description |
|----------|-------------|
| `CSRF_SECRET` | Session cookie signing secret for web UI (min 32 chars). Generate: `openssl rand -base64 32` |
| `CONTEXTIO_LOGGER_ENCRYPTION_KEY` | AES-256-GCM encryption key for capture files at rest (min 32 chars). Generate: `openssl rand -base64 32` |
| `ADMIN_EMAILS` | Comma-separated list of admin email addresses for false positive management (required for OIDC admin access) |

## Core Proxy

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXT_PROXY_BIND_HOST` | `0.0.0.0` | Bind address |
| `CONTEXT_PROXY_PORT` | `4040` | Port for proxy + web UI |
| `CONTEXTIO_ENABLE_LOGGER` | `true` | Enable logger plugin |
| `CONTEXTIO_ENABLE_REDACT` | `true` | Enable redact plugin |
| `CONTEXTIO_ENABLE_RATE_LIMITER` | `true` | Enable rate limiter plugin (retry enabled when this is true) |
| `CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE` | `0` | Allow `x-target-url` header to override upstream |
| `STRICT_URL_FORWARDING` | `false` | Ignore upstream overrides from tool headers, use only configured upstreams |
| `LOG_TRAFFIC` | `false` | Log raw traffic to stdout (debug) |
| `DEBUG_ROUTING` | `false` | Log request classification/routing decisions |
| `LOG_LEVEL` | `info` | Log verbosity |

## Capture Logging (Logger Plugin)

| Variable | Default | Description |
|----------|---------|-------------|
| `LOGGER_CAPTURE_DIR` | `/app/captures` | Directory for capture JSON files |
| `LOGGER_MAX_SESSIONS` | `0` | Max sessions to retain (0 = unlimited) |
| `LOGGER_CAPTURE_MAX_AGE` | `0` | Max age in days (0 = disabled) |
| `LOGGER_CAPTURE_CLEANUP_INTERVAL` | `24` | Cleanup interval in hours |
| `LOGGER_CAPTURE_CLEANUP_ENABLED` | `true` (if maxAge > 0) | Enable time-based cleanup |

## Encryption at Rest

When enabled, all capture files are encrypted with **AES-256-GCM** (PBKDF2, 100k iterations, per-file nonces). The encryption key is derived from `CONTEXTIO_LOGGER_ENCRYPTION_KEY`.

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXTIO_LOGGER_ENCRYPTION_ENABLED` | `false` | Enable encryption |
| `CONTEXTIO_LOGGER_ENCRYPTION_KEY` | *(required if enabled)* | Master encryption key (base64, 32+ chars) |
| `CONTEXTIO_LOGGER_ENCRYPTION_KEY_PROVIDER` | `env` | Key source: `env` (from above), `static` (from `CONTEXTIO_LOGGER_ENCRYPTION_STATIC_KEY`) |
| `CONTEXTIO_LOGGER_ENCRYPTION_KEY_LENGTH` | `32` | Key length in bytes |
| `CONTEXTIO_LOGGER_ENCRYPTION_STATIC_KEY` | *(optional)* | Static key when provider=static |

> **Security**: Keys **must** come from environment variables or Docker secrets — never from the web UI settings file.

## Redaction (Redact Plugin)

| Variable | Default | Description |
|----------|---------|-------------|
| `REDACT_PRESET` | `pii` | Preset: `secrets`, `pii`, or `strict` |
| `REDACT_REVERSIBLE` | `false` | Restore originals in response stream using numbered placeholders |
| `REDACT_POLICY_FILE` | *(none)* | Path to custom policy JSON (overrides preset) |
| `REDACT_CAPTURE_DIR` | *(same as logger)* | Directory for redaction metadata sidecars |

### Presets
- **secrets** — API keys, tokens, private keys, AWS credentials
- **pii** — Everything in `secrets` + email, SSN, credit cards, US phone numbers
- **strict** — Everything in `pii` + IPv4 addresses, dates of birth

## False Positive Feedback System

The feedback store persists false positive entries so they survive proxy restarts. Configured via Web UI → Settings → Redaction tab (environment variables take precedence).

| Variable | Default | Description |
|----------|---------|-------------|
| `FEEDBACK_STORE_ENABLED` | `false` | Enable persistent feedback store for false positives |
| `FEEDBACK_STORE_TYPE` | `sqlite` | Storage backend: `sqlite` (persistent) or `memory` (in-memory, lost on restart) |
| `FEEDBACK_STORE_PATH` | `/app/data/false-positives.db` | SQLite file path (only used when type is `sqlite`) |

> **Note**: Changes to `FEEDBACK_STORE_TYPE` or `FEEDBACK_STORE_PATH` require a proxy restart to take effect.

## Rate Limiter (Built-In)

Token bucket per `(sessionId, provider)` with burst buffer and request queue.

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXTIO_ENABLE_RATE_LIMITER` | `true` | Master enable/disable |
| `CONTEXTIO_RATE_LIMIT_<PROVIDER>_MAX_REQUESTS` | `60` | Max requests per window |
| `CONTEXTIO_RATE_LIMIT_<PROVIDER>_WINDOW_MS` | `60000` | Window in milliseconds |
| `CONTEXTIO_RATE_LIMIT_<PROVIDER>_BUFFER` | `10` | Burst buffer capacity |

**Valid providers**: `openai`, `anthropic`, `chatgpt`, `gemini`, `vertex`, `nvidia`, `openrouter`, `kilo`, `unknown`

### Example — 100 req/min for Anthropic with 20 burst
```bash
CONTEXTIO_RATE_LIMIT_ANTHROPIC_MAX_REQUESTS=100
CONTEXTIO_RATE_LIMIT_ANTHROPIC_WINDOW_MS=60000
CONTEXTIO_RATE_LIMIT_ANTHROPIC_BUFFER=20
```

## Retry Plugin (Built-In)

Exponential backoff with jitter for 429/5xx responses, plus streaming SSE error detection. **Retry is automatically enabled when the rate limiter is enabled** (`CONTEXTIO_ENABLE_RATE_LIMITER=true`). There is no separate `CONTEXTIO_RETRY_ENABLED` variable.

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXTIO_RETRY_MAX_ATTEMPTS` | `3` | Max retry attempts |
| `CONTEXTIO_RETRY_BASE_DELAY_MS` | `500` | Base delay for exponential backoff |
| `CONTEXTIO_RETRY_MAX_DELAY_MS` | `30000` | Cap on delay |
| `CONTEXTIO_RETRY_JITTER_FACTOR` | `0.1` | Jitter (0-1) |
| `CONTEXTIO_RETRY_RETRYABLE_STATUS_CODES` | `429,500,502,503,504` | Status codes to retry |
| `CONTEXTIO_RETRY_PROVIDER_OVERRIDES` | *(JSON)* | Per-provider config overrides |

### NVIDIA Worker Retry
Special handling for NVIDIA `ResourceExhausted` errors — appends a `"continue"` user message to the request body and retries (configurable via provider overrides).

## Upstream Provider URLs

| Variable | Default |
|----------|---------|
| `UPSTREAM_OPENAI_URL` | `https://api.openai.com` |
| `UPSTREAM_ANTHROPIC_URL` | `https://api.anthropic.com` |
| `UPSTREAM_CHATGPT_URL` | `https://chatgpt.com` |
| `UPSTREAM_GEMINI_URL` | `https://generativelanguage.googleapis.com` |
| `UPSTREAM_GEMINI_CODE_ASSIST_URL` | `https://cloudcode-pa.googleapis.com` |
| `UPSTREAM_VERTEX_URL` | `https://us-central1-aiplatform.googleapis.com` |
| `UPSTREAM_NVIDIA_URL` | `https://integrate.api.nvidia.com` |
| `UPSTREAM_KILO_URL` | `https://api.kilo.ai/api/gateway` |
| `UPSTREAM_OPENROUTER_URL` | `https://openrouter.ai/api` |

> **Note**: Trailing `/v1` is automatically stripped from all upstream URLs (both environment variables and header overrides) at startup to avoid double-prefixing, since request paths already contain API version segments.

## OIDC Authentication

Optional SSO via any OIDC provider (Google, Microsoft, Okta, Auth0, Keycloak, etc.).

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXTIO_OIDC_ENABLED` | `false` | Enable OIDC |
| `CONTEXTIO_OIDC_ISSUER` | *(required)* | OIDC issuer URL (e.g., `https://accounts.google.com`) |
| `CONTEXTIO_OIDC_CLIENT_ID` | *(required)* | OAuth2 client ID |
| `CONTEXTIO_OIDC_CLIENT_SECRET` | *(required)* | OAuth2 client secret |
| `CONTEXTIO_OIDC_SESSION_SECRET` | *(required)* | Session cookie signing secret (min 32 chars) |
| `CONTEXTIO_OIDC_PUBLIC_URL` | *(required)* | Public callback URL (e.g., `https://contextio.example.com`) |
| `CONTEXTIO_OIDC_SCOPE` | `openid profile email` | Space-separated scopes |

> **Secrets** (`CLIENT_SECRET`, `SESSION_SECRET`) **must** come from environment variables — never from settings file.

### Legacy Vars (Deprecated)
All 5 required together: `OIDC_ENABLED`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SCOPE`

## Web UI

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:4040` | Public URL for web UI (used for API client connections) |
| `CONTEXTIO_DB_PATH` | `/app/custom-policy/contextio.db` | SQLite database path |

## Complete Example (.env)

```env
# Required
CSRF_SECRET=your-csrf-secret-here
CONTEXTIO_LOGGER_ENCRYPTION_KEY=your-encryption-key-here
ADMIN_EMAILS=admin@company.com,security@company.com

# Core
CONTEXT_PROXY_PORT=4040
LOG_LEVEL=info

# Logging
LOGGER_CAPTURE_DIR=/app/captures
LOGGER_CAPTURE_MAX_AGE=30
LOGGER_CAPTURE_CLEANUP_INTERVAL=24

# Encryption
CONTEXTIO_LOGGER_ENCRYPTION_ENABLED=true

# Redaction
REDACT_PRESET=pii
REDACT_REVERSIBLE=false

# False Positive Feedback Store
FEEDBACK_STORE_ENABLED=true
FEEDBACK_STORE_TYPE=sqlite
FEEDBACK_STORE_PATH=/app/data/false-positives.db

# Rate Limiter (retry enabled when rate limiter is enabled)
CONTEXTIO_ENABLE_LOGGER=true
CONTEXTIO_ENABLE_REDACT=true
CONTEXTIO_ENABLE_RATE_LIMITER=true
CONTEXTIO_RATE_LIMIT_ANTHROPIC_MAX_REQUESTS=100
CONTEXTIO_RATE_LIMIT_OPENAI_MAX_REQUESTS=100
CONTEXTIO_RATE_LIMIT_NVIDIA_MAX_REQUESTS=50

# Retry (enabled via CONTEXTIO_ENABLE_RATE_LIMITER)
CONTEXTIO_RETRY_MAX_ATTEMPTS=3

# OIDC (optional)
# CONTEXTIO_OIDC_ENABLED=true
# CONTEXTIO_OIDC_ISSUER=https://accounts.google.com
# CONTEXTIO_OIDC_CLIENT_ID=...
# CONTEXTIO_OIDC_CLIENT_SECRET=...
# CONTEXTIO_OIDC_SESSION_SECRET=...
# CONTEXTIO_OIDC_PUBLIC_URL=https://contextio.example.com

# Web UI
NEXT_PUBLIC_SITE_URL=http://localhost:4040
```