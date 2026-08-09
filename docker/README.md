# ContextIO-Next Docker Image

Minimal Docker image for `@contextio/proxy` with logging and redaction plugins pre-installed.

## What's Included

- **@contextio/proxy**: HTTP proxy server (port 4040)
- **@contextio/logger**: Capture-to-disk plugin (**enabled by default via CONTEXTIO_ENABLE_LOGGER=true**)
- **@contextio/redact**: PII/secrets redaction plugin (**enabled by default via CONTEXTIO_ENABLE_REDACT=true**)
- **Built-in rate limiter**: Enabled by default via CONTEXTIO_ENABLE_RATE_LIMITER=true
- **Built-in retry**: Enabled automatically when rate limiter is enabled

## Quick Start

### Using Pre-built Image (GitHub Container Registry)

```bash
# Pull from ghcr.io
docker pull ghcr.io/larsderidder/contextio-next:latest

# Run with default settings (logging, redaction, rate limiter all enabled)
docker run --rm -p 4040:4040 ghcr.io/larsderidder/contextio-next:latest

# Disable a plugin
docker run --rm -p 4040:4040 \
  -e CONTEXTIO_ENABLE_REDACT=false \
  ghcr.io/larsderidder/contextio-next:latest

# Mount a volume to persist captures
docker run --rm -p 4040:4040 \
  -v $(pwd)/captures:/home/node/.contextio-next/captures \
  ghcr.io/larsderidder/contextio-next:latest
```

### Building Locally

```bash
# Build the image
docker build -t contextio-next-proxy .

# Run with default settings
docker run --rm -p 4040:4040 contextio-next-proxy

# Mount a volume to persist captures
docker run --rm -p 4040:4040 \
  -v $(pwd)/captures:/home/node/.contextio-next/captures \
  contextio-next-proxy
```

### Available Tags

- `:latest` - Latest build from `main` branch
- `:v0.1.1` - Specific version (semver)
- `:0.1` - Minor version (auto-updates patch versions)
- `:0` - Major version (auto-updates minor/patch versions)
- `:main` - Latest commit on `main` branch
- `:main-sha-abc123` - Specific commit SHA

## Configuration

All configuration is via environment variables.

### Quick Reference

| Env Var | Default | Description |
|:--------|:--------|:------------|
| `CONTEXTIO_ENABLE_LOGGER` | `true` | Enable logger plugin |
| `CONTEXTIO_ENABLE_REDACT` | `true` | Enable redact plugin |
| `CONTEXTIO_ENABLE_RATE_LIMITER` | `true` | Enable rate limiter (retry enabled when true) |
| `CONTEXT_PROXY_BIND_HOST` | `0.0.0.0` | Bind address |
| `CONTEXT_PROXY_PORT` | `4040` | Port to listen on |
| `LOGGER_CAPTURE_DIR` | `/app/captures` | Capture output directory |
| `LOGGER_MAX_SESSIONS` | `0` (unlimited) | Max sessions to retain |
| `REDACT_PRESET` | `pii` | Preset: `secrets`, `pii`, `strict` |
| `REDACT_REVERSIBLE` | `false` | Restore originals in responses |
| `REDACT_POLICY_FILE` | _(none)_ | Path to custom policy JSON |

### Detailed Configuration

### Proxy Settings

- `CONTEXT_PROXY_BIND_HOST`: Bind address (default: `0.0.0.0`)
- `CONTEXT_PROXY_PORT`: Port to listen on (default: `4040`)
- `CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE`: Allow `x-target-url` header (default: `0`)

### Upstream URLs

- `UPSTREAM_OPENAI_URL`: OpenAI API endpoint (default: `https://api.openai.com/v1`)
- `UPSTREAM_ANTHROPIC_URL`: Anthropic API endpoint (default: `https://api.anthropic.com`)
- `UPSTREAM_GEMINI_URL`: Gemini API endpoint (default: `https://generativelanguage.googleapis.com`)

### Plugin Enable/Disable

By default, **all plugins are enabled**: logger, redact, rate limiter, and retry.

```bash
# Disable redaction
docker run --rm -p 4040:4040 \
  -e CONTEXTIO_ENABLE_REDACT=false \
  ghcr.io/larsderidder/contextio-next:latest

# Disable rate limiter (also disables retry)
docker run --rm -p 4040:4040 \
  -e CONTEXTIO_ENABLE_RATE_LIMITER=false \
  ghcr.io/larsderidder/contextio-next:latest

# Disable logger
docker run --rm -p 4040:4040 \
  -e CONTEXTIO_ENABLE_LOGGER=false \
  ghcr.io/larsderidder/contextio-next:latest

# Enable only rate limiter (no logger, no redaction)
docker run --rm -p 4040:4040 \
  -e CONTEXTIO_ENABLE_LOGGER=false \
  -e CONTEXTIO_ENABLE_REDACT=false \
  ghcr.io/larsderidder/contextio-next:latest
```

#### Redaction Presets

```bash
# Secrets only (API keys, tokens)
docker run --rm -p 4040:4040 \
  -e REDACT_PRESET=secrets \
  ghcr.io/larsderidder/contextio-next:latest

# PII (default: email, SSN, credit cards, phone numbers)
docker run --rm -p 4040:4040 \
  -e REDACT_PRESET=pii \
  ghcr.io/larsderidder/contextio-next:latest

# Strict (PII + IP addresses, dates of birth)
docker run --rm -p 4040:4040 \
  -e REDACT_PRESET=strict \
  ghcr.io/larsderidder/contextio-next:latest
```

#### Logger Configuration

- `LOGGER_CAPTURE_DIR`: Directory for captures (default: `~/.contextio-next/captures`)
- `LOGGER_MAX_SESSIONS`: Max sessions to retain, 0 = unlimited (default: `0`)

```bash
# Custom capture directory with session limit
docker run --rm -p 4040:4040 \
  -e LOGGER_CAPTURE_DIR=/app/captures \
  -e LOGGER_MAX_SESSIONS=50 \
  -v ./captures:/app/captures \
  ghcr.io/larsderidder/contextio-next:latest
```

#### Redaction Configuration

- `REDACT_PRESET`: Built-in preset (`secrets`, `pii`, `strict`) (default: `pii`)
- `REDACT_REVERSIBLE`: Restore originals in responses (`true`/`false`) (default: `false`)
- `REDACT_POLICY_FILE`: Path to custom policy JSON (default: `/app/custom-policy/custom-policy.json`, overrides `REDACT_PRESET`)

```bash
# Custom redaction policy
docker run --rm -p 4040:4040 \
  -e REDACT_POLICY_FILE=/app/custom-policy/custom-policy.json \
  -v $(pwd)/my-policy.json:/app/custom-policy/custom-policy.json:ro \
  ghcr.io/larsderidder/contextio-next:latest
```

## Capture Persistence

Captures are persisted in named volumes mounted at `/app/captures` inside the container. The container creates these directories at build time with proper permissions for the non-root `node` user.

### Using Docker Compose (Recommended)

A `docker-compose.yml` file is included in the repository root with pre-configured volumes:

```bash
docker compose up -d
```

This creates named volumes (`captures` and `policy`) that are managed by Docker and persist automatically.

### Coolify Deployment

When deploying to Coolify, use these persistent storage mappings:

| Source Path | Destination Path |
|-------------|------------------|
| `/data/coolify/applications/contextio-next/captures` | `/app/captures` |
| `/data/coolify/applications/contextio-next/policy` | `/app/custom-policy` |

Configure in Coolify's **Persistent Directories** settings:
- **Captures**: Host path `/data/coolify/applications/contextio-next/captures` → Container path `/app/captures`
- **Policy**: Host path `/data/coolify/applications/contextio-next/policy` → Container path `/app/custom-policy`

### Manual Docker Run

```bash
docker run --rm -p 4040:4040 -p 4041:4041 \
  -v ./captures:/app/captures \
  contextio-next-proxy
```

Files on the host will be owned by UID `1000` (the `node` user inside the container).

## Docker Compose Example

```yaml
version: "3.8"
services:
  contextio-next:
    build: .
    ports:
      - "4040:4040"
      - "4041:4041"
    volumes:
      # Captures directory - writable by node user (UID 1000)
      - captures:/app/captures
      # Policy directory - writable by node user
      - policy:/app/custom-policy
    environment:
      LOGGER_CAPTURE_DIR: /app/captures
      CONTEXTIO_ENABLE_LOGGER: "true"
      CONTEXTIO_ENABLE_REDACT: "true"
      CONTEXTIO_ENABLE_RATE_LIMITER: "true"
    restart: unless-stopped

volumes:
  captures:
  policy:
```

With custom policy:

```yaml
services:
  contextio-next-proxy:
    image: ghcr.io/larsderidder/contextio-next:latest
    ports:
      - "4040:4040"
    volumes:
      - ./captures:/app/captures
      - ./my-policy.json:/app/custom-policy/custom-policy.json:ro
    environment:
      CONTEXTIO_ENABLE_LOGGER: "true"
      CONTEXTIO_ENABLE_REDACT: "true"
      CONTEXTIO_ENABLE_RATE_LIMITER: "true"
      REDACT_POLICY_FILE: /app/custom-policy/custom-policy.json
      REDACT_REVERSIBLE: "false"
    restart: unless-stopped
```

## What's NOT Included

This image contains only the proxy server and plugins. The CLI tools (`ctxio`, `inspect`, `monitor`, etc.) are **not included**.

For the full CLI experience, install `@contextio/cli` via npm instead:

```bash
npm install -g @contextio/cli
```

## Image Size

- Build stage: ~500MB (includes build tools, source, dependencies)
- Runtime stage: ~200MB (Node 22 Alpine + compiled output only)

## Security Notes

- Runs as non-root user (`node`, UID 1000)
- Zero production npm dependencies beyond `@contextio/*` workspace packages
- All packages use only Node.js built-ins (no external network calls from the proxy itself)
- API keys pass through the proxy but are never logged by default (redaction plugin strips them if enabled)

## Troubleshooting

**Plugin not loading:**
```
Failed to load plugin "...": ...
```
Check that the corresponding `CONTEXTIO_ENABLE_*` environment variable is set to `true` (default). The image includes all plugins built-in; they are enabled/disabled via environment variables.

**Port already in use:**
```
Error: listen EADDRINUSE: address already in use 0.0.0.0:4040
```
Change the port with `-p 4041:4040` or set `CONTEXT_PROXY_PORT=4041`.

**Captures not persisting:**
Mount a volume to `/app/captures`. Without a volume, captures are lost when the container stops.