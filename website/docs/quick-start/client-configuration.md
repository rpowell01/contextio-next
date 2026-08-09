---
layout: doc
---

# Client Configuration

Provider detection is **automatic** — the proxy classifies requests based on:
- **Path patterns** (`/v1/messages` → Anthropic, `/chat/completions` → OpenAI, `:generateContent` → Gemini)
- **Provider base URL override headers** (`x-anthropic-baseurl`, `x-openai-baseurl`, `x-nvidia-baseurl`, etc.)
- **Auth header patterns** (`Bearer sk-...` → OpenAI, `Bearer nv-...` → NVIDIA)
- **Explicit `x-target-url` header** (requires `CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE=1`)
- **Source-tagged paths** from CLI (`/claude/...`, `/gemini/...`)

No `x-contextio-provider` header is required.

## Required Headers

| Header | Values | Description |
|--------|--------|-------------|
| `x-api-key` | `sk-...` | Provider API key (if not configured in Settings → Providers) |

## Optional Headers

| Header | Description |
|--------|-------------|
| `x-contextio-redact` | `true`/`false` — Enable/disable redaction per-request |
| `x-contextio-log` | `true`/`false` — Enable/disable capture logging per-request |
| `x-anthropic-baseurl` | Override Anthropic base URL per-request |
| `x-openai-baseurl` | Override OpenAI base URL per-request |
| `x-google-baseurl` | Override Google/Gemini base URL per-request |
| `x-gemini-code-assist-baseurl` | Override Gemini Code Assist base URL per-request |
| `x-openrouter-baseurl` | Override OpenRouter base URL per-request |
| `x-nvidia-baseurl` | Override NVIDIA base URL per-request |
| `x-kilo-baseurl` | Override Kilo Code Gateway base URL per-request |
| `x-chatgpt-baseurl` | Override ChatGPT base URL per-request |
| `x-vertex-baseurl` | Override Vertex AI base URL per-request |
| `x-target-url` | Explicit upstream URL (requires `CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE=1`) |

## Per-Tool Configuration

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

## Override Provider Base URL (Per-Request)

```bash
# Route Anthropic through a different upstream
curl -H "x-anthropic-baseurl: https://fcc.sslip.mywire.org" \
     -H "x-api-key: sk-ant-..." \
     http://localhost:4040/v1/messages

# Explicit target URL (requires CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE=1)
curl -H "x-target-url: https://api.anthropic.com/v1/messages" \
     -H "x-api-key: sk-ant-..." \
     http://localhost:4040/any/path
```

## Docker / Remote Access

When running in Docker, replace `localhost` with your Docker host:

```bash
# macOS/Windows
export ANTHROPIC_BASE_URL=http://host.docker.internal:4040
export OPENAI_BASE_URL=http://host.docker.internal:4040/v1

# Linux (use host IP)
export ANTHROPIC_BASE_URL=http://172.17.0.1:4040
export OPENAI_BASE_URL=http://172.17.0.1:4040/v1
```

## Mitmproxy Tools (Codex, Copilot, OpenCode)

These tools ignore base URL overrides. They require mitmproxy:

```bash
pipx install mitmproxy
mitmdump --version  # generates CA cert

# Then run via contextio CLI (handles mitmproxy automatically)
ctxio proxy -- codex
ctxio proxy -- copilot
ctxio proxy -- opencode
```

Or manually:
```bash
export HTTPS_PROXY=http://host.docker.internal:8080
```