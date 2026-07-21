# ContextIO Next

[![CI](https://github.com/larsderidder/contextio-next/actions/workflows/ci.yml/badge.svg)](https://github.com/larsderidder/contextio-next/actions/workflows/ci.yml)
![npm](https://img.shields.io/npm/v/@contextio/cli)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

## MIT License and Attribution

This project is forked from [contextio](https://github.com/larsderidder/contextio) by larsderidder, which is released under the MIT License. The original copyright and license are preserved in [LICENSE](LICENSE).

This project is now maintained as **ContextIO Next**. All code, documentation, and references to the project identity on `github.com/larsderidder/contextio-next` reflect this fork.

A local proxy that sits between your AI coding tools and the LLM APIs they call. Logs every request and response, optionally strips PII and secrets before anything leaves your machine.

I built this because I get nervous sending data I don't see to LLMs. Now at least I know if they are gossiping about me.

All your stuff passes through this thing, so the proxy has zero external dependencies. Read the code, it's small.

**Looking for full observability?** Check out [Context Lens](https://github.com/larsderidder/context-lens), a web-based tracing and analytics platform built on top of contextio-next.

## What's Included

- **@contextio/cli**: CLI that wraps your tools with proxy + redaction + logging
- **@contextio/proxy**: HTTP reverse proxy for LLM APIs with plugin system. Zero deps
- **@contextio/redact**: Privacy and redaction plugin: presets, custom policies, reversible mode
- **@contextio/logger**: Capture-to-disk plugin with atomic writes and session retention
- **@contextio/core**: Shared types, routing, headers, token estimation, security scanning
- **@contextio/web**: Next.js web UI for monitoring, inspection, and configuration (served on the same port as the proxy)

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Running as a Docker Container](#running-as-a-docker-container)
- [Docker Compose & Coolify](#docker-compose--coolify)
- [AI Tool Configuration](#ai-tool-configuration)
- [Proxy Commands (CLI)](#proxy-commands-cli)
- [Environment Variables](#environment-variables)
- [Architecture](#architecture)
- [Tool Support](#tool-support)
- [Redaction](#redaction)
- [Logging](#logging)
- [Web UI](#web-ui)
- [Development](#development)
- [License](#license)

---

## Installation

### CLI (recommended for local development)

```bash
npm install -g @contextio/cli
```

### From Source

```bash
git clone https://github.com/larsderidder/contextio-next.git
cd contextio-next
pnpm install
pnpm build
```

---

## Quick Start

### Log everything

```bash
ctxio proxy -- claude
```

### Log and redact PII

```bash
ctxio proxy --redact -- claude
```

### Log, redact, and restore originals in responses

```bash
ctxio proxy --redact-reversible -- claude
```

### Works with multiple tools at once

```bash
ctxio proxy --redact # start the proxy
ctxio attach claude # in another terminal
ctxio attach gemini # in another terminal
```

### Run in the background

```bash
ctxio proxy -d --redact
ctxio attach claude
ctxio proxy stop
```

`contextio-next` is the longer alias for `ctxio` for those who just _love_ typing.

---

## Running as a Docker Container

A pre-built Docker image is published to GitHub Container Registry.

### Prerequisites

- Docker 20.10+ or Docker Compose 2.0+
- (Optional, for some tools) `pipx install mitmproxy`

### Using Docker Directly

```bash
# Pull the latest image
docker pull ghcr.io/larsderidder/contextio-next:latest

# Run with default settings (logging + web UI, redaction off)
docker run -d -p 4040:4040 \
  ghcr.io/larsderidder/contextio-next:latest

# Enable redaction (PII preset)
docker run -d -p 4040:4040 \
  -e CONTEXT_PROXY_PLUGINS=/app/redact-plugin.js,/app/logger-plugin.js \
  -e REDACT_PRESET=pii \
  ghcr.io/larsderidder/contextio-next:latest

# Mount a volume to persist captures
docker run -d -p 4040:4040 \
  -v $(pwd)/captures:/app/captures \
  -v $(pwd)/policy:/app/custom-policy \
  ghcr.io/larsderidder/contextio-next:latest

# With a custom redaction policy
docker run -d -p 4040:4040 \
  -e CONTEXT_PROXY_PLUGINS=/app/redact-plugin.js,/app/logger-plugin.js \
  -e REDACT_POLICY_FILE=/app/custom-policy/custom-policy.json \
  -v $(pwd)/my-policy.json:/app/custom-policy/custom-policy.json:ro \
  ghcr.io/larsderidder/contextio-next:latest
```

> **Note:** The web UI and proxy API run on the **same port (4040)**. The container exposes only port 4040.

### Available Image Tags

| Tag | Description |
|:---|:---|
| `latest` | Latest build from `main` branch |
| `v0.1.1` | Specific version (semver) |
| `0.1` | Minor version (auto-updates patch) |
| `0` | Major version (auto-updates minor/patch) |
| `main` | Latest commit on `main` branch |
| `main-sha-abc123` | Specific commit SHA |

---

## Docker Compose & Coolify

A `docker-compose.yml` is included at the repository root.

```bash
docker compose up -d
```

See [docker/README.md](docker/README.md) for full Docker-specific documentation.

### Coolify Deployment

When deploying to Coolify, configure these **Persistent Directories** mappings:

| Source Path | Destination Path |
|:---|:---|
| `/data/coolify/applications/contextio-next/captures` | `/app/captures` |
| `/data/coolify/applications/contextio-next/policy` | `/app/custom-policy` |
| `/data/coolify/applications/contextio-next/settings` | `/home/node/.contextio-next` |

Set the following environment variable in Coolify:

```
CSRF_SECRET=<your-generated-secret>
```

Coolify injects `CSRF_SECRET` at runtime. Without it, CSRF protection will fail in production.

---

## AI Tool Configuration

Each tool has a specific way to point it at the proxy. The proxy classifies requests by provider and routes them accordingly.

### Claude CLI

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:4040/claude ctxio proxy -- claude
```

**What ContextIO-Next does:** Sets `ANTHROPIC_BASE_URL` to `http://127.0.0.1:4040/claude`. The proxy strips the `/claude` source tag and forwards to `https://api.anthropic.com`.

### Aider

```bash
ctxio proxy -- aider
```

**What ContextIO-Next does:** Sets both `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` to `http://127.0.0.1:4040/aider`.

### Gemini CLI

```bash
ctxio proxy -- gemini
```

**What ContextIO-Next does:** Sets:
- `GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:4040/gemini/`
- `CODE_ASSIST_ENDPOINT=http://127.0.0.1:4040/gemini`

### Pi

Pi uses the OpenAI-compatible provider. Configure the base URL:

```bash
OPENAI_BASE_URL=http://127.0.0.1:4040/pi ctxio proxy -- pi
```

### Codex CLI (OpenAI)

Codex ignores base URL env vars. It requires mitmproxy for TLS termination.

```bash
pipx install mitmproxy
mitmdump --version # run once to generate CA cert

ctxio proxy -- codex
```

**What ContextIO-Next does:** Starts mitmproxy in upstream mode and chains traffic through the ContextIO-Next proxy. No env vars needed on the child process.

### Copilot CLI

Same as Codex — requires mitmproxy.

```bash
pipx install mitmproxy
ctxio proxy -- copilot
```

### OpenCode

Same as Codex and Copilot — requires mitmproxy.

```bash
pipx install mitmproxy
ctxio proxy -- opencode
```

### Other / Custom Tools

For tools not explicitly listed, the CLI sets both `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` to `http://127.0.0.1:4040/<tool-name>`. This covers most tools that respect those env vars.

### Manual Docker / External Tool Configuration

When running the proxy in Docker, configure your AI tools to point at the proxy:

```
ANTHROPIC_BASE_URL=http://host.docker.internal:4040/claude
OPENAI_BASE_URL=http://host.docker.internal:4040/claude
```

Replace `host.docker.internal` with your Docker host IP if on Linux.

For tools using mitmproxy (Codex, Copilot, OpenCode), set:

```
HTTPS_PROXY=http://host.docker.internal:8080
```

---

## Proxy Commands (CLI)

### Start the Proxy (Standalone)

Runs until you press Ctrl+C:

```bash
ctxio proxy [--redact] [--log-dir ./captures]
```

### Wrap a Tool

Starts proxy, runs tool, cleans up when tool exits:

```bash
ctxio proxy [flags] -- claude
ctxio proxy --redact -- aider
```

### Background Mode (Detached)

```bash
ctxio proxy -d --redact # start in background
ctxio proxy status # check if running
ctxio proxy stop # stop background proxy
```

### Attach

Connect a tool to an already-running proxy:

```bash
ctxio attach <tool>
```

Works with both standalone and background proxies. Multiple tools can attach to the same proxy.

### Monitor

Live view of traffic passing through the proxy:

```bash
ctxio monitor # watch all traffic
ctxio monitor a1b2c3d4 # filter to one session ID
```

Shows request/response pairs as they arrive, with timing, token counts, and streaming status. Press Ctrl+C to exit.

### Inspect

Analyze captured sessions:

```bash
ctxio inspect # list all sessions
ctxio inspect a1b2c3d4 # show session details
ctxio inspect a1b2c3d4 --stats # token stats per request
```

### Replay

Re-send a captured request to the API (experimental):

```bash
ctxio replay capture-file.json
```

Requires the correct API key for the provider. Shows the new response and highlights any differences from the original.

### Export

Bundle session captures into a shareable tarball (experimental):

```bash
ctxio export # export all sessions
ctxio export a1b2c3d4 # export one session
ctxio export --redact # strip PII before bundling
```

Creates `contextio-next-export-YYYY-MM-DD-HHMMSS.tar.gz` with all matching capture files.

### Doctor

Check environment and configuration:

```bash
ctxio doctor
```

Verifies:
- mitmproxy installation and CA cert (if needed)
- Capture directory permissions
- Port availability (4040, 8080)
- Lockfile state
- Background proxy status

---

## Environment Variables

All configuration for the Docker image is via environment variables.

### Required

| Env Var | Description |
|:---|:---|
| `CSRF_SECRET` | A secret string for CSRF protection in production. **Required when running behind a public-facing load balancer or reverse proxy.** Coolify injects this automatically. Without it, CSRF validation will fail for write operations in the web UI. |

### Core Proxy

| Env Var | Default | Description |
|:---|:---|:---|
| `CONTEXT_PROXY_BIND_HOST` | `0.0.0.0` | Bind address. In CLI mode, the default is `127.0.0.1`. |
| `CONTEXT_PROXY_PORT` | `4040` | Port the proxy (and web UI) listen on. |
| `CONTEXT_PROXY_PLUGINS` | `/app/logger-plugin.js` | Comma-separated plugin paths to load at startup. |
| `CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE` | `0` | Allow requests to override the target URL via `x-target-url` header. |
| `STRICT_URL_FORWARDING` | `false` | When `true`, ignore upstream URL overrides from tool headers and use only configured upstreams. |
| `LOG_TRAFFIC` | `false` | Log all raw traffic to stdout (debug). |
| `DEBUG_ROUTING` | `false` | Log detailed request classification and routing decisions. |
| `LOG_LEVEL` | `info` | Logging verbosity. |

### Logging (Plugin)

| Env Var | Default | Description |
|:---|:---|:---|
| `LOGGER_CAPTURE_DIR` | `/app/captures` | Directory where capture JSON files are written. |
| `LOGGER_MAX_SESSIONS` | `0` | Max sessions to retain. `0` = unlimited. |
| `LOGGER_CAPTURE_MAX_AGE` | `0` | Max age of captures in days. `0` = disabled. |
| `LOGGER_CAPTURE_CLEANUP_INTERVAL` | `24` | Cleanup interval in hours. |
| `LOGGER_CAPTURE_CLEANUP_ENABLED` | `true` (if maxAge > 0) | Enable automatic time-based cleanup. |

### Redaction (Plugin)

| Env Var | Default | Description |
|:---|:---|:---|
| `REDACT_PRESET` | `pii` | Preset: `secrets`, `pii`, or `strict`. |
| `REDACT_REVERSIBLE` | `false` | Restore original values in the response stream using numbered placeholders. |
| `REDACT_POLICY_FILE` | _(none)_ | Path to a custom policy JSON file. Overrides `REDACT_PRESET` when set. |
| `REDACT_CAPTURE_DIR` | _(same as logger)_ | Directory for redaction metadata. Defaults to `LOGGER_CAPTURE_DIR`. |

### Encryption at Rest

| Env Var | Default | Description |
|:---|:---|:---|
| `CONTEXTIO_LOGGER_ENCRYPTION_ENABLED` | `false` | Enable AES-256 encryption for capture files on disk. |
| `CONTEXTIO_LOGGER_ENCRYPTION_KEY` | _(none)_ | Encryption key. **Required when encryption is enabled.** |

Optional encryption overrides:

| Env Var | Default | Description |
|:---|:---|:---|
| `CONTEXTIO_LOGGER_ENCRYPTION_KEY_PROVIDER` | `env` | Key material source: `env` reads from `CONTEXTIO_LOGGER_ENCRYPTION_KEY`; `static` uses `CONTEXTIO_LOGGER_ENCRYPTION_STATIC_KEY`. |
| `CONTEXTIO_LOGGER_ENCRYPTION_KEY_LENGTH` | `32` | Key length in bytes. |
| `CONTEXTIO_LOGGER_ENCRYPTION_STATIC_KEY` | _(none)_ | Static key value (only when `keyProvider=static`). |

### Upstream Providers

| Env Var | Default | Description |
|:---|:---|:---|
| `UPSTREAM_OPENAI_URL` | `https://api.openai.com` | OpenAI platform API base URL. |
| `UPSTREAM_ANTHROPIC_URL` | `https://api.anthropic.com` | Anthropic API base URL. |
| `UPSTREAM_CHATGPT_URL` | `https://chatgpt.com` | ChatGPT backend API base URL. |
| `UPSTREAM_GEMINI_URL` | `https://generativelanguage.googleapis.com` | Gemini API base URL. |
| `UPSTREAM_GEMINI_CODE_ASSIST_URL` | `https://cloudcode-pa.googleapis.com` | Gemini Code Assist base URL. |
| `UPSTREAM_VERTEX_URL` | `https://us-central1-aiplatform.googleapis.com` | Google Vertex AI base URL. |
| `UPSTREAM_NVIDIA_URL` | `https://integrate.api.nvidia.com` | NVIDIA NIM API base URL. |
| `UPSTREAM_KILO_URL` | `https://api.kilo.ai/api/gateway` | Kilo Code Gateway base URL. |
| `UPSTREAM_OPENROUTER_URL` | `https://openrouter.ai/api` | OpenRouter base URL. |

> **Note:** The proxy strips any trailing `/v1` from these URLs at startup to avoid double-prefixing API paths.

### Web UI

| Env Var | Default | Description |
|:---|:---|:---|
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:4041` | Public URL for the web UI (used for API client connections and display). |

---

## Architecture

```
Tool ─HTTP─▶ Proxy (:4040) ─HTTPS─▶ api.anthropic.com / api.openai.com / generativelanguage.googleapis.com
│  plugin pipeline
│  (redact → log)
│
│  capture files on disk
│
└── Web UI (Next.js) served on the same port 4040
```

The proxy is a single Node.js process combining:
1. **HTTP reverse proxy** — classifies requests by provider (Anthropic, OpenAI, Gemini, etc.) and forwards them
2. **Plugin pipeline** — runs `onRequest`, `onResponse`, and `onCapture` hooks
3. **Next.js web UI** — served on the same port via path-based routing:
   - `/admin/*` → Proxy admin API
   - `/chat/*`, `/v1/*` → Proxy routing
   - Everything else → Next.js app (`/api/*` endpoints and UI)

The proxy has zero npm dependencies (Node.js built-ins + `@contextio/core` only). Plugins like redact and logger are separate packages that hook into the proxy's request/response lifecycle.

### Packages

| Package | Description |
|:---|:---|
| [`@contextio/cli`](packages/cli) | CLI that wraps your tools with proxy + redaction + logging |
| [`@contextio/proxy`](packages/proxy) | HTTP reverse proxy for LLM APIs with plugin system. Zero deps |
| [`@contextio/redact`](packages/redact) | Privacy and redaction plugin: presets, custom policies, reversible mode |
| [`@contextio/logger`](packages/logger) | Capture-to-disk plugin with atomic writes and session retention |
| [`@contextio/core`](packages/core) | Shared types, routing, headers, token estimation, security scanning |
| [`@contextio/web`](packages/web) | Next.js web UI for monitoring, inspection, and configuration |

---

## Tool Support

| Tool | Method | Redaction | Logging |
|:---|:---|:---|:---|
| Claude CLI | `ANTHROPIC_BASE_URL` | ✓ | ✓ |
| Aider | `ANTHROPIC_BASE_URL` + `OPENAI_BASE_URL` | ✓ | ✓ |
| Gemini CLI | `GOOGLE_GEMINI_BASE_URL` + `CODE_ASSIST_ENDPOINT` | ✓ | ✓ |
| Pi | `OPENAI_BASE_URL` | ✓ | ✓ |
| Codex CLI | mitmproxy + proxy chain | ✓ | ✓ |
| OpenCode | mitmproxy + proxy chain | ✓ | ✓ |
| Copilot CLI | mitmproxy + proxy chain | ✓ | ✓ |

Tools that accept a base URL override (Claude, Aider, Pi, Gemini) get routed through the proxy directly. Tools that don't (Codex, Copilot, OpenCode) go through mitmproxy first to terminate TLS, then chain into the ContextIO Next proxy for redaction and logging. ContextIO Next handles starting and stopping mitmproxy automatically.

Codex, OpenCode, and Copilot require mitmproxy to be installed:

```bash
pipx install mitmproxy
mitmdump --version # run once to generate the CA cert
```

Any tool not in this list falls through to a default that sets both `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`, which covers most tools that respect those env vars.

---

## Redaction

Three built-in presets, or bring your own policy file.

### Presets

| Preset | What it catches |
|:---|:---|
| `secrets` | API keys, tokens, private keys, AWS credentials |
| `pii` | Everything in `secrets`, plus email, SSN, credit cards, US phone numbers |
| `strict` | Everything in `pii`, plus IPv4 addresses, dates of birth |

### Usage

```bash
ctxio proxy --redact # "pii" preset (default)
ctxio proxy --redact-preset secrets # API keys and tokens only
ctxio proxy --redact-preset strict # PII + IPs, dates of birth
ctxio proxy --redact-policy ./my-rules.json # custom rules
```

Rules are context-gated where it makes sense. `[SSN_REDACTED]` on its own is left alone; `My SSN is [SSN_REDACTED]` gets redacted.

### Reversible Mode

```bash
ctxio proxy --redact-reversible -- claude
```

Replaces values with numbered placeholders, then restores them in the response stream:

```
You: "My email is [EMAIL_REDACTED]"
LLM sees: "My email is [EMAIL_1]"
LLM says: "I've noted [EMAIL_1] as your contact"
You see: "I've noted [EMAIL_REDACTED] as your contact"
```

Same value always maps to the same placeholder within a session. Works across Anthropic, OpenAI, and Gemini streaming formats.

This is opt-in. It keeps originals in memory and reconstructs SSE events on the fly. Stable enough for daily use, but it hasn't had months of production mileage yet.

### Custom Policies

```jsonc
{
  "extends": "pii",
  "rules": [
    { "id": "employee-id", "pattern": "EMP-\\d{5,}", "replacement": "[EMPLOYEE_ID]" }
  ],
  "allowlist": {
    "strings": ["support@mycompany.com"],
    "patterns": ["test-\\d+@example\\.com"]
  },
  "paths": {
    "only": ["messages[*].content", "system"],
    "skip": ["model", "max_tokens"]
  }
}
```

Full reference in [docs/redaction-policy.md](docs/redaction-policy.md). Examples in [examples/](examples/).

See [docs/FAQ.md](docs/FAQ.md) for common questions about redaction, troubleshooting, and usage patterns.

---

## Logging

On by default. Disable with `--no-log`.

```bash
ctxio proxy --log-dir ./my-captures -- claude # custom directory
ctxio proxy --log-max-sessions 10 -- claude # prune old sessions on startup
```

### Capture Files

Each capture file is a complete request/response pair:

```
claude_a1b2c3d4_1739000000000-000001.json
```

```json
{
  "timestamp": "2026-02-15T20:50:00.815Z",
  "sessionId": "67bb9e8f",
  "source": "claude",
  "provider": "anthropic",
  "apiFormat": "anthropic-messages",
  "targetUrl": "https://api.anthropic.com/v1/messages",
  "requestBody": { "model": "claude-sonnet-4-20250514", "messages": ["..."] },
  "responseStatus": 200,
  "responseIsStreaming": true,
  "responseBody": "data: {\"type\":\"content_block_delta\",...}",
  "timings": { "total_ms": 2002 }
}
```

Actual files include headers, byte counts, and detailed timings. Sensitive headers (`Authorization`, `x-api-key`, `cookie`, `set-cookie`, etc.) are stripped before writing.

### Retention

Set a session retention limit:

```bash
ctxio proxy --log-max-sessions 10 -- claude
```

On startup, the oldest sessions are pruned if the total exceeds the limit.

Or delete manually:

```bash
rm -rf ~/.contextio-next/captures/
```

### Automated Cleanup

Configure time-based retention via environment variables or via the web UI settings:

```bash
LOGGER_CAPTURE_MAX_AGE=7        # Delete captures older than 7 days
LOGGER_CAPTURE_CLEANUP_INTERVAL=24  # Run cleanup every 24 hours
LOGGER_CAPTURE_CLEANUP_ENABLED=true # Enable cleanup
```

The web UI writes settings to `/app/custom-policy/settings.json` inside the container. Environment variables take precedence over the web UI settings.

---

## Web UI

The web UI is served on the same port as the proxy (default 4040). In the Docker image, it runs on Node.js with no separate frontend build server.

Access it at:

```
http://localhost:4040
```

Features:
- **Dashboard**: Overview of proxy status and quick actions
- **Sessions**: View and inspect captured API requests/responses
- **Environment Variables**: View and edit proxy configuration (falls back to env defaults if proxy is unreachable)
- **Settings**: Configure logging and redaction options

The web UI connects to the ContextIO-Next proxy admin API at `http://localhost:4040/admin` by default. Configure via `NEXT_PUBLIC_SITE_URL` environment variable.

### Docker Web UI Access

```bash
docker run -d -p 4040:4040 \
  -e NEXT_PUBLIC_SITE_URL=http://localhost:4040 \
  -v $(pwd)/captures:/app/captures \
  -v $(pwd)/policy:/app/custom-policy \
  -v $(pwd)/settings:/home/node/.contextio-next \
  ghcr.io/larsderidder/contextio-next:latest
```

Then open `http://localhost:4040`.

---

## Development

### Prerequisites

- Node.js 22+
- pnpm 11.9.0+
- TypeScript 5.7+
- (Optional) pipx + mitmproxy for testing tools that require TLS interception

### Build

```bash
pnpm install
pnpm build
pnpm test
```

### Development Mode

```bash
pnpm dev
```

### Lint

```bash
pnpm lint
```

### Project Structure

```
contextio-next/
├── packages/
│   ├── cli/         # CLI entry point (ctxio)
│   ├── core/        # Zero-dep shared types, routing, token estimation, security
│   ├── proxy/       # Zero-dep HTTP reverse proxy + plugin system
│   ├── redact/      # PII/secrets redaction plugin
│   ├── logger/      # Capture-to-disk plugin
│   └── web/         # Next.js web UI
├── docs/            # FAQ, redaction policy reference, performance notes
├── examples/        # Custom redaction policy examples
├── docker/          # Docker-specific documentation
├── Dockerfile       # Multi-stage Docker build
├── docker-compose.yml
└── turbo.json       # Turborepo config
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for dependency policy and guidelines.

---

## License

MIT. Copyright (c) larsderidder and contributors.

This project is forked from [contextio](https://github.com/larsderidder/contextio) by larsderidder. The original project and its authorship are acknowledged and preserved in compliance with the MIT License.
