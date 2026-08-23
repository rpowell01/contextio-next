---
layout: doc
---

# Features Overview

ContextIO-Next provides a comprehensive set of features for observing, securing, and managing LLM API traffic.

## Core Features

| Feature | Description |
|---------|-------------|
| **Transparent Proxy** | Zero-config routing for Anthropic, OpenAI, Gemini, NVIDIA, OpenRouter, and custom providers |
| **Automatic Provider Detection** | Path-based, header-based, and auth-pattern detection — no manual config needed |
| **Single-Port Architecture** | Proxy + Web UI on port 4040 via path-based routing |

## Privacy & Security

| Feature | Description |
|---------|-------------|
| **Redaction Engine** | Presets (secrets, PII, strict), custom policies, context-gated rules, path scoping |
| **False Positive Feedback** | Click-to-add exemptions from redaction diffs, exact/pattern modes, session-scoped, admin-only |
| **Reversible Redaction** | Numbered placeholders restored in response stream — LLM sees `[EMAIL_1]`, you see `[EMAIL_REDACTED]` |
| **Encryption at Rest** | AES-256-GCM with PBKDF2 (100k iterations), per-file nonces, keys never leave container |
| **OIDC Authentication** | SSO via Google, Microsoft, Okta, Auth0, Keycloak, or any OIDC provider |

## Observability

| Feature | Description |
|---------|-------------|
| **Capture Logging** | Every request/response written to disk with timestamps, token counts, timings |
| **Session Management** | Automatic session grouping by source tag or session ID |
| **Web UI Dashboard** | Sessions, Redactions, Metrics, Settings — all in one place |
| **Metrics & Monitoring** | Rate limiter buckets, upstream 429s, NVIDIA retries, latency percentiles, throughput |

## Reliability

| Feature | Description |
|---------|-------------|
| **Rate Limiting** | Per-session, per-provider token bucket with burst buffer and request queue |
| **Built-in Retry** | Exponential backoff with jitter for 429/5xx + streaming SSE error detection |
| **NVIDIA Worker Retry** | Special handling for `ResourceExhausted` — appends "continue" message and retries |
| **Capture Retention** | Time-based (max age) and count-based (max sessions) automated cleanup |

## Deployment

| Feature | Description |
|---------|-------------|
| **Docker Native** | Pre-built images on ghcr.io, multi-stage build |
| **Coolify Ready** | Persistent directory mappings for captures, policy, settings |
| **Configuration** | Environment variables (override settings file), web UI settings persistence |
| **Provider Management** | SQLite-backed provider configs with API keys encrypted at rest |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    ContextIO-Next (port 4040)               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ HTTP Reverse Proxy                                   │   │
│  │  • Provider classification                           │   │
│  │  • Request/Response routing                          │   │
│  │  • Plugin pipeline: redact → logger → rate-limiter   │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Next.js Web UI (same port, path-based routing)      │   │
│  │  /admin/*    → Proxy admin API                      │   │
│  │  /chat/*     → Proxy streaming endpoints            │   │
│  │  /v1/*       → Proxy OpenAI-compat endpoints        │   │
│  │  /*          → Next.js app                          │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ SQLite Database (/app/custom-policy/contextio.db)   │   │
│  │  • Provider configurations                          │   │
│  │  • Capture metadata index                           │   │
│  │  • Redaction placeholder mappings                   │   │
│  │  • Settings persistence                             │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Supported AI Tools

| Tool | Method | Redaction | Logging |
|------|--------|-----------|---------|
| **Claude CLI** | `ANTHROPIC_BASE_URL` | ✓ | ✓ |
| **Aider** | `ANTHROPIC_BASE_URL` + `OPENAI_BASE_URL` | ✓ | ✓ |
| **Gemini CLI** | `GOOGLE_GEMINI_BASE_URL` + `CODE_ASSIST_ENDPOINT` | ✓ | ✓ |
| **Pi** | `OPENAI_BASE_URL` | ✓ | ✓ |
| **Codex CLI** | mitmproxy + proxy chain | ✓ | ✓ |
| **Copilot CLI** | mitmproxy + proxy chain | ✓ | ✓ |
| **OpenCode** | mitmproxy + proxy chain | ✓ | ✓ |
| **OpenRouter** | `OPENROUTER_BASE_URL` | ✓ | ✓ |
| **NVIDIA NIM** | `NVIDIA_BASE_URL` | ✓ | ✓ |
| **Kilo Code Gateway** | `KILO_BASE_URL` | ✓ | ✓ |

Tools that accept base URL overrides (Claude, Aider, Pi, Gemini) route directly. Tools that don't (Codex, Copilot, OpenCode) go through mitmproxy first for TLS termination, then chain into ContextIO-Next.

## Next Steps

- [Quick Start](/quick-start) — Get running in 5 minutes
- [Configuration](/configuration/environment-variables) — All environment variables
- [Features Deep Dive](/features/overview) — Individual feature guides