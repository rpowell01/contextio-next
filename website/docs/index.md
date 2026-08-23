---
layout: home

hero:
  name: ContextIO-Next
  text: Single-Port Docker Proxy for LLM APIs
  tagline: Transparent proxy with redaction, logging, rate limiting, retry, and OIDC auth — all on port 4040
  image:
    src: /contextio-next-brand.png
    alt: ContextIO-Next
  actions:
    - theme: brand
      text: Quick Start
      link: /quick-start
    - theme: alt
      text: View on GitHub
      link: https://github.com/rpowell01/contextio-next
    - theme: alt
      text: Docker Image
      link: https://github.com/rpowell01/contextio-next/pkgs/container/contextio-next

features:
  - title: Transparent Proxy
    details: Zero-config routing based on URL paths and headers. Works with Anthropic, OpenAI, Google, NVIDIA, OpenRouter, Kilo Code Gateway, and custom providers.
    icon: 🔀
  - title: PII & Secrets Redaction
    details: Built-in presets (secrets, pii, strict), custom policies, and reversible mode.
    icon: 🛡️
  - title: Capture Logging
    details: Every request/response written to disk with AES-256-GCM encryption at rest. Time-based and count-based retention.
    icon: 📝
  - title: Rate Limiting
    details: Per-session, per-provider token bucket with burst buffering. HTTP 429 with Retry-After headers.
    icon: 🚦
  - title: Built-in Retry
    details: Exponential backoff with jitter for 429/5xx. Streaming SSE error detection. NVIDIA ResourceExhausted special handling.
    icon: 🔄
  - title: OIDC Authentication
    details: Optional SSO via Google, Microsoft, Okta, Auth0, Keycloak, or any OIDC provider. Secrets stay in env vars.
    icon: 🔐
  - title: Web UI Dashboard
    details: Sessions, Redactions, Metrics, Settings — all served on the same port 4040. Dark/light theme support.
    icon: 📊
  - title: Docker Native
    details: Pre-built images on ghcr.io. Multi-stage build. Coolify-ready with persistent directories.
    icon: 🐳
  - title: New Provider Support
    details: First-class support for NVIDIA NIM, OpenRouter, and Kilo Code Gateway with automatic detection and per-provider configuration.
    icon: ✨
---

<script setup>
import { VPTeamPage, VPTeamPageTitle } from 'vitepress/theme'

const contributors = [
  {
    avatar: 'https://github.com/rpowell01.png',
    name: 'Russell Powell',
    title: 'Maintainer',
    links: [
      { icon: 'github', link: 'https://github.com/rpowell01' },
    ],
  },
  {
    avatar: 'https://github.com/larsderidder.png',
    name: 'Lars de Ridder',
    title: 'Original Author',
    links: [
      { icon: 'github', link: 'https://github.com/larsderidder' },
    ],
  },
]
</script>

## Get Started

```bash
# 1. Clone and enter
git clone https://github.com/rpowell01/contextio-next.git
cd contextio-next

# 2. Create environment file with required secrets
cp .env.example .env
# Edit .env with:
#   CSRF_SECRET=<32+ char random string>
#   CONTEXTIO_LOGGER_ENCRYPTION_KEY=<32+ char random string>

# 3. Start the stack
docker compose up -d

# 4. Access Web UI
open http://localhost:4040
```

## Generate Required Secrets

```bash
# CSRF_SECRET (web UI session signing)
openssl rand -base64 32

# CONTEXTIO_LOGGER_ENCRYPTION_KEY (capture file encryption at rest)
openssl rand -base64 32
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    ContextIO-Next (port 4040)               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ HTTP Reverse Proxy                                   │   │
│  │  • Provider classification (Anthropic, OpenAI, etc.) │   │
│  │  • Request/Response routing                          │   │
│  │  • Plugin pipeline: redact → logger → rate-limiter   │   │
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
▼                    ▼                    ▼                    ▼
    anthrophic.com      api.openai.com      generativelanguage.googleapis.com
    integrate.api.nvidia.com  openrouter.ai/api  api.kilo.ai  ...etc
```

## Pre-Built Docker Images

| Tag | Description |
|-----|-------------|
| `ghcr.io/rpowell01/contextio-next:main` | Latest build from `main` branch |
| `ghcr.io/rpowell01/contextio-next:vX.Y.Z` | Specific version (semver) |
| `ghcr.io/rpowell01/contextio-next:main-sha-<sha>` | Specific commit |

## License

MIT. Copyright (c) Russell Powell and contributors.

This project is a fork of [contextio](https://github.com/larsderidder/contextio) by larsderidder. The original project and its authorship are acknowledged and preserved in compliance with the MIT License.