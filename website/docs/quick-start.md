---
layout: doc
---

# Quick Start (Docker Compose)

## Prerequisites

- Docker 20.10+ or Docker Compose 2.0+
- Git

## 1. Clone the Repository

```bash
git clone https://github.com/rpowell01/contextio-next.git
cd contextio-next
```

## 2. Create Environment File

Copy the example and fill in the **required secrets**:

```bash
cp .env.example .env
```

Edit `.env` and add:

```env
# Required - generate with: openssl rand -base64 32
CSRF_SECRET=<your-32-char-secret>

# Required - generate with: openssl rand -base64 32
CONTEXTIO_LOGGER_ENCRYPTION_KEY=<your-32-char-secret>
```

### Generate Secrets

```bash
# CSRF_SECRET (web UI session signing)
openssl rand -base64 32

# CONTEXTIO_LOGGER_ENCRYPTION_KEY (capture file encryption at rest)
openssl rand -base64 32
```

## 3. Start the Stack

```bash
docker compose up -d
```

This starts the container with:
- Proxy + Web UI on port **4040**
- Named volumes for persistence (`captures`, `policy`, `settings`)
- Redaction and logger plugins enabled by default

## 4. Access the Web UI

Open `http://localhost:4040` in your browser.

You'll see the **Dashboard** with:
- Proxy status and build info
- Total redaction count
- Quick navigation to Sessions, Redactions, Metrics, Settings

## 5. Configure Your AI Tools

Point your AI tool at the proxy. Provider detection is **automatic** — no special headers required.

### Claude CLI
```bash
export ANTHROPIC_BASE_URL=http://localhost:4040
export ANTHROPIC_API_KEY=sk-ant-...
```

### OpenAI / Codex / Aider
```bash
export OPENAI_BASE_URL=http://localhost:4040/v1
export OPENAI_API_KEY=sk-...
```

### Gemini CLI
```bash
export GOOGLE_GEMINI_BASE_URL=http://localhost:4040
export GEMINI_API_KEY=...
```

### OpenRouter
```bash
export OPENROUTER_BASE_URL=http://localhost:4040/v1
export OPENROUTER_API_KEY=sk-or-...
```

### NVIDIA NIM
```bash
export NVIDIA_BASE_URL=http://localhost:4040/v1
export NVIDIA_API_KEY=...
```

### Kilo Code Gateway
```bash
export KILO_BASE_URL=http://localhost:4040/v1
export KILO_API_KEY=...
```

## 6. Verify It's Working

1. Make a request with your AI tool
2. Open the Web UI → **Sessions** tab
3. You should see the captured request/response

## Next Steps

- [Configure redaction](/configuration/environment-variables#redaction) — Enable PII/secrets detection
- [Set up rate limiting](/configuration/rate-limiter) — Protect upstream APIs
- [Enable encryption](/configuration/encryption) — Encrypt captures at rest
- [Set up OIDC](/configuration/oidc) — Add SSO authentication
- [View metrics](/features/metrics) — Monitor traffic and rate limits

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Web UI not loading | Check `docker compose logs -f` for errors |
| CSRF errors | Ensure `CSRF_SECRET` is set in `.env` |
| Captures not appearing | Verify `LOGGER_CAPTURE_DIR=/app/captures` and volume mount |
| Redaction not working | Check `REDACT_PRESET=pii` is set (default) |

## Docker Compose Override

For custom configuration, create `docker-compose.override.yml`:

```yaml
services:
  contextio-next:
    environment:
      - REDACT_PRESET=strict
      - LOG_LEVEL=debug
      - CONTEXTIO_RATE_LIMIT_ANTHROPIC_MAX_REQUESTS=100
    ports:
      - "4040:4040"
      - "8080:8080"  # if using mitmproxy for Codex/Copilot
```