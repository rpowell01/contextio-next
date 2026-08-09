---
layout: doc
---

# Provider Configuration

Manage upstream provider settings via Web UI or programmatic API.

## Provider Settings

Stored in SQLite (`/app/custom-policy/contextio.db`) with `providers.json` fallback.

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier (`anthropic`, `openai`, etc.) |
| `name` | string | Yes | Display name |
| `enabled` | boolean | Yes | Whether provider is active |
| `baseUrl` | string | Yes | Upstream base URL |
| `apiKey` | string | No | API key (encrypted at rest) |
| `priority` | number | No | Routing priority (higher = preferred) |
| `allowBaseUrlOverride` | boolean | No | Allow `x-*-baseurl` headers (default: true) |
| `models` | string[] | No | Allowed models (empty = all) |
| `rateLimit` | object | No | Per-provider rate limit override |

### Default Providers

```json
{
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "enabled": true,
      "baseUrl": "https://api.anthropic.com",
      "priority": 100
    },
    {
      "id": "openai",
      "name": "OpenAI",
      "enabled": true,
      "baseUrl": "https://api.openai.com",
      "priority": 90
    },
    {
      "id": "gemini",
      "name": "Google Gemini",
      "enabled": true,
      "baseUrl": "https://generativelanguage.googleapis.com",
      "priority": 80
    },
    {
      "id": "vertex",
      "name": "Google Vertex AI",
      "enabled": true,
      "baseUrl": "https://us-central1-aiplatform.googleapis.com",
      "priority": 70
    },
    {
      "id": "nvidia",
      "name": "NVIDIA NIM",
      "enabled": true,
      "baseUrl": "https://integrate.api.nvidia.com",
      "priority": 60
    },
    {
      "id": "openrouter",
      "name": "OpenRouter",
      "enabled": true,
      "baseUrl": "https://openrouter.ai/api",
      "priority": 50
    },
    {
      "id": "chatgpt",
      "name": "ChatGPT",
      "enabled": true,
      "baseUrl": "https://chatgpt.com",
      "priority": 40
    },
    {
      "id": "kilo",
      "name": "Kilo Code Gateway",
      "enabled": true,
      "baseUrl": "https://api.kilo.ai/api/gateway",
      "priority": 30
    },
    {
      "id": "custom",
      "name": "Custom",
      "enabled": false,
      "baseUrl": "",
      "priority": 10
    }
  ]
}
```

## Web UI Management

Settings → **Providers** tab:
- ✅ Enable/disable providers
- ✏️ Edit base URL, API key
- 🔑 API keys encrypted at rest (AES-256-GCM)
- ⬆️⬇️ Drag to reorder priority
- ➕ Add custom provider

## API Access

```bash
# List providers
curl http://localhost:4040/admin/config/providers

# Get specific provider
curl http://localhost:4040/admin/config/providers/anthropic
```

Response:
```json
{
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "enabled": true,
      "baseUrl": "https://api.anthropic.com",
      "priority": 100,
      "hasApiKey": true,
      "models": [],
      "allowBaseUrlOverride": true,
      "rateLimit": { "maxRequests": 100, "windowMs": 60000 }
    }
  ]
}
```

## API Key Encryption

- Keys encrypted with `CONTEXTIO_LOGGER_ENCRYPTION_KEY`
- Same encryption as capture files
- Never returned in API responses (`hasApiKey` only)
- Decrypted only when forwarding request

## Environment Variable Overrides

Env vars take precedence over database:

```bash
# Override base URL
UPSTREAM_ANTHROPIC_URL=https://custom.anthropic.example.com

# Override rate limit
CONTEXTIO_RATE_LIMIT_ANTHROPIC_MAX_REQUESTS=200
CONTEXTIO_RATE_LIMIT_ANTHROPIC_WINDOW_MS=60000
```

## Custom Provider

Add via Web UI or `providers.json`:
```json
{
  "id": "my-llm",
  "name": "My Custom LLM",
  "enabled": true,
  "baseUrl": "https://my-llm.example.com",
  "apiKey": "sk-...",
  "priority": 5,
  "allowBaseUrlOverride": true
}
```

Then use with header:
```bash
curl -H "x-contextio-provider: custom" \
     -H "x-custom-baseurl: https://my-llm.example.com" \
     -H "x-api-key: sk-..." \
     http://localhost:4040/v1/chat/completions
```

## Routing Priority

1. **Source tag** — `/claude/...` → Anthropic, `/gemini/...` → Gemini
2. **Path pattern** — `/v1/messages` → Anthropic
3. **Override headers** — `x-nvidia-baseurl` → NVIDIA
4. **Auth pattern** — `Bearer sk-` → OpenAI, `Bearer nv-` → NVIDIA
5. **Priority order** — Highest priority enabled provider matching
6. **Default** → OpenAI (catch-all)

## Migration

Import from `providers.json`:
```bash
# CLI
ctxio migrate providers --providers-file ./providers.json

# Or auto-migrate on startup (if DB empty)
```