---
layout: doc
---

# Custom Providers Examples

Examples for adding and configuring custom LLM providers.

## Adding a Custom Provider via Web UI

1. Go to Settings → Providers
2. Click **+ Add Provider**
3. Fill in the fields:
   - **ID**: Unique identifier (e.g., `my-llm`)
   - **Name**: Display name
   - **Base URL**: Upstream API endpoint
   - **API Key**: Optional, encrypted at rest
   - **Priority**: Routing priority (higher = preferred)
   - **Allowed Models**: Optional, restrict to specific models
   - **Allow Base URL Override**: Allow client to override via headers

## Programmatic Configuration (providers.json)

Create `providers.json` in your custom policy directory:

```json
{
  "providers": [
    {
      "id": "my-llm",
      "name": "My Custom LLM",
      "enabled": true,
      "baseUrl": "https://my-llm.example.com",
      "apiKey": "sk-...",
      "priority": 5,
      "allowBaseUrlOverride": true,
      "models": ["model-a", "model-b"],
      "rateLimit": {
        "maxRequests": 100,
        "windowMs": 60000
      }
    }
  ]
}
```

Mount it in docker-compose:
```yaml
volumes:
  - ./providers.json:/app/custom-policy/providers.json:ro
```

## Client Usage with Custom Provider

Use the `x-contextio-provider` header to route to your custom provider:

```bash
curl -X POST http://localhost:4040/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-contextio-provider: my-llm" \
  -H "x-my-llm-baseurl: https://my-llm.example.com" \
  -H "x-api-key: sk-..." \
  -d '{"model":"model-a","messages":[{"role":"user","content":"Hello"}]}'
```

## Overriding Provider Base URL

Any enabled provider can have its base URL overridden per-request:

```bash
# Override Anthropic
curl -H "x-anthropic-baseurl: https://custom-anthropic.example.com" ...

# Override OpenAI
curl -H "x-openai-baseurl: https://custom-openai.example.com" ...

# Override custom provider (uses provider ID in header name)
curl -H "x-my-llm-baseurl: https://custom-my-llm.example.com" ...
```

The header format is `x-{provider-id}-baseurl` (lowercase, hyphens preserved).

## OpenAI-Compatible Provider Example

For providers implementing the OpenAI API spec:

```json
{
  "providers": [
    {
      "id": "together",
      "name": "Together AI",
      "enabled": true,
      "baseUrl": "https://api.together.xyz",
      "apiKey": "sk-...",
      "priority": 45,
      "rateLimit": { "maxRequests": 50, "windowMs": 60000 }
    },
    {
      "id": "groq",
      "name": "Groq",
      "enabled": true,
      "baseUrl": "https://api.groq.com/openai",
      "apiKey": "gsk_...",
      "priority": 44,
      "rateLimit": { "maxRequests": 30, "windowMs": 60000 }
    },
    {
      "id": "perplexity",
      "name": "Perplexity",
      "enabled": true,
      "baseUrl": "https://api.perplexity.ai",
      "apiKey": "pplx-...",
      "priority": 43,
      "rateLimit": { "maxRequests": 20, "windowMs": 60000 }
    }
  ]
}
```

Client usage:
```bash
curl -X POST http://localhost:4040/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-contextio-provider: together" \
  -H "x-together-baseurl: https://api.together.xyz" \
  -H "x-api-key: sk-..." \
  -d '{"model":"meta-llama/Llama-3-70b","messages":[{"role":"user","content":"Hello"}]}'
```

## Local / Self-Hosted Model Example

For local models (Ollama, vLLM, TGI, etc.):

```json
{
  "providers": [
    {
      "id": "ollama",
      "name": "Ollama",
      "enabled": true,
      "baseUrl": "http://host.docker.internal:11434",
      "priority": 20,
      "allowBaseUrlOverride": true,
      "rateLimit": { "maxRequests": 10, "windowMs": 60000 }
    },
    {
      "id": "vllm",
      "name": "vLLM",
      "enabled": true,
      "baseUrl": "http://host.docker.internal:8000",
      "priority": 15,
      "allowBaseUrlOverride": true,
      "rateLimit": { "maxRequests": 20, "windowMs": 60000 }
    }
  ]
}
```

> **Note**: Use `host.docker.internal` to reach host services from within the container.

Client usage:
```bash
# Ollama
curl -X POST http://localhost:4040/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-contextio-provider: ollama" \
  -H "x-ollama-baseurl: http://host.docker.internal:11434" \
  -d '{"model":"llama3","messages":[{"role":"user","content":"Hello"}]}'

# vLLM
curl -X POST http://localhost:4040/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-contextio-provider: vllm" \
  -H "x-vllm-baseurl: http://host.docker.internal:8000" \
  -d '{"model":"meta-llama/Llama-3-8b","messages":[{"role":"user","content":"Hello"}]}'
```

## Azure OpenAI Example

```json
{
  "providers": [
    {
      "id": "azure-openai",
      "name": "Azure OpenAI",
      "enabled": true,
      "baseUrl": "https://my-resource.openai.azure.com",
      "apiKey": "sk-...",
      "priority": 85,
      "models": ["gpt-4", "gpt-35-turbo"],
      "rateLimit": { "maxRequests": 100, "windowMs": 60000 }
    }
  ]
}
```

Client usage (requires deployment name in model):
```bash
curl -X POST http://localhost:4040/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-contextio-provider: azure-openai" \
  -H "x-azure-openai-baseurl: https://my-resource.openai.azure.com" \
  -H "x-api-key: sk-..." \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hello"}]}'
```

## Priority & Routing

Providers are matched in this order:
1. **`x-contextio-provider` header** — Explicit provider selection
2. **Source tag** — `/claude/...` → Anthropic, `/gemini/...` → Gemini, `/codex/...` → ChatGPT
3. **Path pattern** — `/v1/messages` → Anthropic, `/v1/chat/completions` → OpenAI
4. **Auth pattern** — `Bearer sk-` → OpenAI, `Bearer nv-` → NVIDIA
5. **Priority order** — Highest priority enabled provider matching the request format
6. **Default** → OpenAI (catch-all for chat completions)

Higher priority wins when multiple providers match.

## Migrating from providers.json to Database

```bash
# CLI migration
ctxio migrate providers --providers-file ./providers.json

# Or auto-migrate on startup (if database is empty)
```

## Environment Variable Overrides

Env vars take precedence over database settings:

```bash
# Override base URL
UPSTREAM_ANTHROPIC_URL=https://custom.anthropic.example.com
UPSTREAM_OPENAI_URL=https://custom.openai.example.com

# Override rate limits
CONTEXTIO_RATE_LIMIT_ANTHROPIC_MAX_REQUESTS=200
CONTEXTIO_RATE_LIMIT_ANTHROPIC_WINDOW_MS=60000
```