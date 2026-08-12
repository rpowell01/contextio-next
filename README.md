# ContextIO-Next

[![CI](https://github.com/rpowell01/contextio-next/actions/workflows/ci.yml/badge.svg)](https://github.com/rpowell01/contextio-next/actions/workflows/ci.yml)
![Docker Pulls](https://img.shields.io/docker/pulls/ghcr.io/rpowell01/contextio-next)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

## MIT License and Attribution

This project is a fork of [contextio](https://github.com/larsderidder/contextio) by larsderidder, released under the MIT License. The original copyright and license are preserved in [LICENSE](LICENSE). This fork is maintained as **ContextIO-Next** at `github.com/rpowell01/contextio-next`.

---

## Overview

ContextIO-Next is a single-port Docker proxy that sits between your AI coding tools (Claude CLI, Aider, Gemini CLI, Codex, Copilot, OpenCode, etc.) and LLM provider APIs (Anthropic, OpenAI, Google, NVIDIA, OpenRouter, etc.). It provides:

- **Transparent proxy** — Zero-config routing based on request headers and paths
- **Web UI** — Dashboard, session inspection, redaction viewer, metrics, and settings all on port 4040
- **Redaction** — PII/secrets detection with built-in presets, custom policies, and reversible mode
- **Capture logging** — Every request/response written to disk with AES-256-GCM encryption at rest
- **Rate limiting** — Per-session, per-provider token bucket with burst buffering
- **Retry with backoff** — Exponential backoff for 429/5xx, plus NVIDIA `ResourceExhausted` special handling
- **OIDC Authentication** — Optional SSO via Google, Microsoft, Okta, or any OIDC provider

All configuration is via environment variables. The web UI settings persist to a SQLite database and JSON file, but **environment variables always take precedence** over settings file values.

---

## Quick Start (Docker Compose)

```bash
# 1. Clone and enter
git clone https://github.com/rpowell01/contextio-next.git
cd contextio-next

# 2. Create environment file with required secrets
cp .env.example .env
# Edit .env and fill in:
#   CSRF_SECRET=<32+ char random string>
#   CONTEXTIO_LOGGER_ENCRYPTION_KEY=<32+ char random string>

# 3. Start the stack
docker compose up -d

# 4. Access Web UI
open http://localhost:4040
```

### Generate Required Secrets

```bash
# CSRF_SECRET (web UI session signing)
openssl rand -base64 32

# CONTEXTIO_LOGGER_ENCRYPTION_KEY (capture file encryption at rest)
openssl rand -base64 32
```

---

## Docker Deployment

### Pre-Built Images

Images are published to GitHub Container Registry:

| Tag | Description |
|-----|-------------|
| `ghcr.io/rpowell01/contextio-next:main` | Latest build from `main` branch |
| `ghcr.io/rpowell01/contextio-next:vX.Y.Z` | Specific version (semver) |
| `ghcr.io/rpowell01/contextio-next:main-sha-<sha>` | Specific commit |

### Docker Compose (Recommended)

The included `docker-compose.yml` uses the pre-built image with named volumes for persistence:

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
      # See Environment Variables section below
    restart: unless-stopped
```

### Docker Run (Standalone)

```bash
docker run -d -p 4040:4040 \
  -v captures:/app/captures \
  -v policy:/app/custom-policy \
  -v settings:/home/node/.contextio-next \
  -e CSRF_SECRET=<your-secret> \
  -e CONTEXTIO_LOGGER_ENCRYPTION_KEY=<your-key> \
  ghcr.io/rpowell01/contextio-next:main
```

### Coolify Deployment

When deploying to Coolify, configure these **Persistent Directories**:

| Source Path | Destination Path |
|-------------|------------------|
| `/data/coolify/applications/contextio-next/captures` | `/app/captures` |
| `/data/coolify/applications/contextio-next/policy` | `/app/custom-policy` |
| `/data/coolify/applications/contextio-next/settings` | `/home/node/.contextio-next` |

Set `CSRF_SECRET` in Coolify environment variables (it injects this at runtime).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    ContextIO-Next (port 4040)               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ HTTP Reverse Proxy                                   │   │
│  │  • Provider classification (Anthropic, OpenAI, etc.) │   │
│  │  • Request/Response routing                          │   │
│  │  • Built-in plugins: rate-limiter → retry → logger → redact │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Next.js Web UI (same port, path-based routing)      │   │
│  │  /admin/*    → Proxy admin API                      │   │
│  │  /chat/*     → Proxy streaming endpoints            │   │
│  │  /v1/*       → Proxy OpenAI-compat endpoints        │   │
│  │  /*          → Next.js app (Dashboard, Sessions,    │   │
│  │                Redactions, Metrics, Settings)       │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ SQLite Database (/app/custom-policy/contextio.db)   │   │
│  │  • Provider configurations (API keys, base URLs)    │   │
│  │  • Capture metadata index                           │   │
│  │  • Redaction placeholder mappings (reversible mode) │   │
│  │  • Settings persistence                             │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
   anthrophic.com      api.openai.com      generativelanguage.googleapis.com
   integrate.api.nvidia.com  openrouter.ai/api  ...etc
```

Single Node.js process. Zero npm dependencies in the proxy core. Plugins are separate packages loaded at startup.

---

## Environment Variables

All configuration is via environment variables. **Environment variables always override settings file values** (`/app/custom-policy/settings.json`).

### Required Secrets (No Defaults)

| Variable | Description |
|----------|-------------|
| `CSRF_SECRET` | Session cookie signing secret for web UI (min 32 chars). Generate: `openssl rand -base64 32` |
| `CONTEXTIO_LOGGER_ENCRYPTION_KEY` | AES-256-GCM encryption key for capture files at rest (min 32 chars). Generate: `openssl rand -base64 32` |

### Core Proxy

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

### Capture Logging (Logger Plugin)

| Variable | Default | Description |
|----------|---------|-------------|
| `LOGGER_CAPTURE_DIR` | `/app/captures` | Directory for capture JSON files |
| `LOGGER_MAX_SESSIONS` | `0` | Max sessions to retain (0 = unlimited) |
| `LOGGER_CAPTURE_MAX_AGE` | `0` | Max age in days (0 = disabled) |
| `LOGGER_CAPTURE_CLEANUP_INTERVAL` | `24` | Cleanup interval in hours |
| `LOGGER_CAPTURE_CLEANUP_ENABLED` | `true` (if maxAge > 0) | Enable time-based cleanup |

### Encryption at Rest

When enabled, all capture files are encrypted with **AES-256-GCM** (PBKDF2, 100k iterations, per-file nonces). The encryption key is derived from `CONTEXTIO_LOGGER_ENCRYPTION_KEY`.

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXTIO_LOGGER_ENCRYPTION_ENABLED` | `false` | Enable encryption |
| `CONTEXTIO_LOGGER_ENCRYPTION_KEY` | *(required if enabled)* | Master encryption key (base64, 32+ chars) |
| `CONTEXTIO_LOGGER_ENCRYPTION_KEY_PROVIDER` | `env` | Key source: `env` (from above), `static` (from `CONTEXTIO_LOGGER_ENCRYPTION_STATIC_KEY`) |
| `CONTEXTIO_LOGGER_ENCRYPTION_KEY_LENGTH` | `32` | Key length in bytes |
| `CONTEXTIO_LOGGER_ENCRYPTION_STATIC_KEY` | *(optional)* | Static key when provider=static |

> **Security**: Keys **must** come from environment variables or Docker secrets — never from the web UI settings file.

### Redaction (Redact Plugin)

| Variable | Default | Description |
|----------|---------|-------------|
| `REDACT_PRESET` | `pii` | Preset: `secrets`, `pii`, or `strict` |
| `REDACT_REVERSIBLE` | `false` | Restore originals in response stream using numbered placeholders |
| `REDACT_POLICY_FILE` | *(none)* | Path to custom policy JSON (overrides preset) |
| `REDACT_CAPTURE_DIR` | *(same as logger)* | Directory for redaction metadata sidecars |

**Presets:**
- `secrets` — API keys, tokens, private keys, AWS credentials
- `pii` — Everything in `secrets` + email, SSN, credit cards, US phone numbers
- `strict` — Everything in `pii` + IPv4 addresses, dates of birth

### Rate Limiter (Built-In)

Token bucket per `(sessionId, provider)` with burst buffer and request queue.

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXTIO_ENABLE_RATE_LIMITER` | `true` | Master enable/disable |
| `CONTEXTIO_RATE_LIMIT_<PROVIDER>_MAX_REQUESTS` | `60` | Max requests per window |
| `CONTEXTIO_RATE_LIMIT_<PROVIDER>_WINDOW_MS` | `60000` | Window in milliseconds |
| `CONTEXTIO_RATE_LIMIT_<PROVIDER>_BUFFER` | `10` | Burst buffer capacity |

Valid providers: `openai`, `anthropic`, `chatgpt`, `gemini`, `vertex`, `nvidia`, `openrouter`, `kilo`, `unknown`.

**Example** — 100 req/min for Anthropic with 20 burst:
```bash
CONTEXTIO_RATE_LIMIT_ANTHROPIC_MAX_REQUESTS=100
CONTEXTIO_RATE_LIMIT_ANTHROPIC_WINDOW_MS=60000
CONTEXTIO_RATE_LIMIT_ANTHROPIC_BUFFER=20
```

### Retry Plugin (Built-In)

Exponential backoff with jitter for 429/5xx responses, plus streaming SSE error detection. **Retry is automatically enabled when the rate limiter is enabled** (`CONTEXTIO_ENABLE_RATE_LIMITER=true`).

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXTIO_RETRY_MAX_ATTEMPTS` | `3` | Max retry attempts |
| `CONTEXTIO_RETRY_BASE_DELAY_MS` | `500` | Base delay for exponential backoff |
| `CONTEXTIO_RETRY_MAX_DELAY_MS` | `30000` | Cap on delay |
| `CONTEXTIO_RETRY_JITTER_FACTOR` | `0.1` | Jitter (0-1) |
| `CONTEXTIO_RETRY_RETRYABLE_STATUS_CODES` | `429,500,502,503,504` | Status codes to retry |
| `CONTEXTIO_RETRY_PROVIDER_OVERRIDES` | *(JSON)* | Per-provider config overrides |

**NVIDIA Worker Retry**: Special handling for NVIDIA `ResourceExhausted` errors — appends a `"continue"` user message to the request body and retries (configurable via provider overrides).

### Upstream Provider URLs

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

> Trailing `/v1` is stripped at startup to avoid double-prefixing.

### OIDC Authentication

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

**Legacy vars (deprecated, all 5 required together):**
`OIDC_ENABLED`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SCOPE`

### Web UI

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:4040` | Public URL for web UI (used for API client connections) |
| `CONTEXTIO_DB_PATH` | `/app/custom-policy/contextio.db` | SQLite database path |

---

## Client Configuration

Point your AI tool at the proxy. **Provider detection is automatic** — the proxy classifies requests based on URL path patterns, standard headers, and optional override headers. No `x-contextio-provider` header is required.

### How Provider Detection Works

| Method | Examples |
|--------|----------|
| **Path-based** | `/v1/messages` → Anthropic; `/chat/completions` → OpenAI; `:generateContent` → Gemini; `/v1/.../publishers/google` → Vertex |
| **Provider base URL headers** | `x-anthropic-baseurl`, `x-openai-baseurl`, `x-google-baseurl`, `x-openrouter-baseurl`, `x-nvidia-baseurl`, `x-kilo-baseurl`, `x-chatgpt-baseurl`, `x-vertex-baseurl`, `x-gemini-code-assist-baseurl` |
| **Auth header patterns** | `Bearer sk-...` → OpenAI; `Bearer nv-...` → NVIDIA |
| **Explicit target URL** | `x-target-url: https://api.anthropic.com/v1/messages` |
| **Source-tagged paths** | `/claude/v1/messages`, `/gemini/ab12cd34/v1/...` (set by CLI) |

### Required Headers

| Header | Values | Description |
|--------|--------|-------------|
| `x-api-key` | `sk-...` | Provider API key (if not configured in Settings → Providers) |

### Optional Headers

| Header | Values | Description |
|--------|--------|-------------|
| `x-contextio-redact` | `true`, `false` | Enable/disable redaction per-request (overrides global) |
| `x-contextio-log` | `true`, `false` | Enable/disable capture logging per-request |
| `x-anthropic-baseurl` | `https://...` | Override Anthropic base URL per-request |
| `x-openai-baseurl` | `https://...` | Override OpenAI base URL per-request |
| `x-google-baseurl` | `https://...` | Override Google/Gemini base URL per-request |
| `x-gemini-code-assist-baseurl` | `https://...` | Override Gemini Code Assist base URL per-request |
| `x-openrouter-baseurl` | `https://...` | Override OpenRouter base URL per-request |
| `x-nvidia-baseurl` | `https://...` | Override NVIDIA base URL per-request |
| `x-kilo-baseurl` | `https://...` | Override Kilo Code Gateway base URL per-request |
| `x-chatgpt-baseurl` | `https://...` | Override ChatGPT base URL per-request |
| `x-vertex-baseurl` | `https://...` | Override Vertex AI base URL per-request |
| `x-target-url` | `https://...` | Explicit upstream URL (enables `CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE=1`) |

### Per-Tool Examples

**Claude CLI:**
```bash
export ANTHROPIC_BASE_URL=http://localhost:4040
export ANTHROPIC_API_KEY=sk-ant-...
# Proxy detects Anthropic from /v1/messages path
```

**OpenAI / Codex / Aider:**
```bash
export OPENAI_BASE_URL=http://localhost:4040/v1
export OPENAI_API_KEY=sk-...
# Proxy detects OpenAI from /chat/completions or /responses path
```

**Gemini CLI:**
```bash
export GOOGLE_GEMINI_BASE_URL=http://localhost:4040
export GEMINI_API_KEY=...
# Proxy detects Gemini from :generateContent path or x-goog-api-key header
```

**OpenRouter:**
```bash
export OPENROUTER_BASE_URL=http://localhost:4040/v1
export OPENROUTER_API_KEY=sk-or-...
# Proxy detects OpenRouter from x-openrouter-baseurl header or openrouter.ai hostname in x-target-url
```

**NVIDIA NIM:**
```bash
export NVIDIA_BASE_URL=http://localhost:4040/v1
export NVIDIA_API_KEY=...
# Proxy detects NVIDIA from x-nvidia-baseurl header or Bearer nv-... auth
```

**Override Provider Base URL (per-request):**
```bash
# Example: Route Anthropic through a different upstream
curl -H "x-anthropic-baseurl: https://fcc.sslip.mywire.org" \
     -H "x-api-key: sk-ant-..." \
     http://localhost:4040/v1/messages

# Example: Explicit target URL (requires CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE=1)
curl -H "x-target-url: https://api.anthropic.com/v1/messages" \
     -H "x-api-key: sk-ant-..." \
     http://localhost:4040/any/path
```

---

## Web UI

Access at `http://localhost:4040` (or your configured `NEXT_PUBLIC_SITE_URL`).

### Dashboard
- Proxy status and build info
- Total redaction count (click to refresh)
- Quick navigation to Sessions, Redactions, Metrics, Settings
- Docker Quick Start guide

### Sessions
- List all captured sessions with request/response pairs
- View full request/response bodies, headers, timings, token counts
- Filter by session, provider, date range
- Streaming response reconstruction

### Redactions
- Overview of all redactions by type
- Per-session breakdown with placeholder mapping (reversible mode)
- Diff dialog showing original vs redacted content
- Pagination for large datasets

### Metrics
- **Rate Limiter tab**: Active buckets, tokens remaining, upstream 429s, NVIDIA retries, queue depths
- **Traffic tab**: Request volume, latency percentiles, error rates, tokens/sec

### Settings (6 Tabs)
1. **Logging** — Capture directory, retention (max sessions, max age, cleanup interval)
2. **Redaction** — Preset or custom policy, reversible mode
3. **Security** — OIDC configuration, encryption at rest toggle
4. **Rate Limiter** — Per-provider limits (max requests, window, buffer)
5. **Appearance** — Theme (light/dark/system)
6. **Providers** — Manage provider API keys and custom base URLs (encrypted at rest in SQLite)

Settings persist to `/app/custom-policy/settings.json` inside the container. **Environment variables take precedence** over these values.

---

## Features Deep Dive

### Encryption at Rest

Capture files are encrypted with **AES-256-GCM** using a key derived from `CONTEXTIO_LOGGER_ENCRYPTION_KEY` via PBKDF2 (100,000 iterations). Each file gets a unique nonce. The encrypted format:

```
<base64url(salt)>.<base64url(nonce)>.<base64url(ciphertext)>
```

Files are decrypted transparently when read via the web UI or CLI. The encryption key **never** leaves the container — it only exists in memory at runtime.

### Reversible Redaction

When `REDACT_REVERSIBLE=true`:
1. Request: Original values → numbered placeholders (`[EMAIL_1]`, `[SSN_2]`)
2. LLM responds with placeholders
3. Response: Placeholders → original values restored in stream

Mappings stored per-session in SQLite. Works across Anthropic, OpenAI, and Gemini streaming formats (SSE, chunked, ndjson).

### Rate Limiting

Per `(sessionId, provider)` token bucket:
- `maxRequests` tokens refill over `windowMs`
- `bufferCapacity` extra tokens for bursts
- Requests queued when exhausted (up to buffer capacity)
- HTTP 429 with `Retry-After` header (seconds) and `rateLimitInfo` JSON (milliseconds)
- LRU eviction + TTL cleanup (max 10,000 buckets by default)

Metrics visible in Web UI → Metrics → Rate Limiter tab.

### Built-In Retry with NVIDIA Special Handling

Exponential backoff (base 500ms, max 30s, jitter 0.1) for:
- HTTP 429, 500, 502, 503, 504
- Streaming SSE `event: error` with `rate_limit_error` type

**NVIDIA `ResourceExhausted`**: The retry plugin detects this error in the response body, appends a `"continue"` user message to the `messages` array, and retries the request. Configurable per-provider.

### Capture Logging

Each request/response pair written as JSON:
```
claude_a1b2c3d4_1739000000000-000001.json
```

Contains: timestamp, sessionId, source, provider, apiFormat, targetUrl, request/response bodies, status, streaming flag, timings, token estimates. Sensitive headers stripped before write.

**Retention**: Time-based (`LOGGER_CAPTURE_MAX_AGE`, `LOGGER_CAPTURE_CLEANUP_INTERVAL`) or count-based (`LOGGER_MAX_SESSIONS`).

### Provider Configuration

Providers stored in SQLite (`/app/custom-policy/contextio.db`) with `providers.json` fallback. Configured via Web UI → Settings → Providers tab:

- API keys encrypted at rest
- Custom base URLs per provider
- Enabled/disabled toggle
- Priority ordering for routing

---

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

---

## License

MIT. Copyright (c) Russell Powell and contributors.

This project is forked from [contextio](https://github.com/larsderidder/contextio) by larsderidder. The original project and its authorship are acknowledged and preserved in compliance with the MIT License.