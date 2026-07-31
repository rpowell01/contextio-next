# =============================================================================
# Build stage: Prepare GLiNER model using Python (Debian-based for onnxruntime)
# =============================================================================
# Placeholder ARG to catch Coolify-injected build args before the first FROM
# Coolify prepends ARGs to the Dockerfile, so this prevents them from breaking the model-builder stage
ARG COOLIFY_ARGS_PLACEHOLDER

FROM python:3.11-slim AS model-builder
WORKDIR /models

# Install GLiNER, Optimum CLI with ONNX support, and huggingface_hub for downloading
RUN pip install --no-cache-dir gliner optimum[onnx] onnxruntime huggingface_hub

# Download all model files from HuggingFace Hub (including tokenizer and model weights)
RUN echo "from huggingface_hub import snapshot_download" > /download_model.py && \
    echo "snapshot_download(" >> /download_model.py && \
    echo "    repo_id='urchade/gliner_small-v2.1'," >> /download_model.py && \
    echo "    local_dir='./gliner-small-v2.1'," >> /download_model.py && \
    echo "    local_dir_use_symlinks=False," >> /download_model.py && \
    echo "    allow_patterns=['*.json', '*.txt', '*.model', 'config.json', 'vocab.txt', 'tokenizer*', 'special_tokens*', '*.bin', '*.safetensors']" >> /download_model.py && \
    echo ")" >> /download_model.py && \
    echo "print('Model files downloaded')" >> /download_model.py && \
    python /download_model.py && ls -la ./gliner-small-v2.1/

# Export to ONNX using GLiNER's built-in export_to_onnx method
RUN echo "from gliner import GLiNER" > /export_model.py && \
    echo "import os" >> /export_model.py && \
    echo "import json" >> /export_model.py && \
    echo "" >> /export_model.py && \
    echo "# Load model from local files" >> /export_model.py && \
    echo "model = GLiNER.from_pretrained('./gliner-small-v2.1')" >> /export_model.py && \
    echo "os.makedirs('./gliner-small-v2.1/onnx', exist_ok=True)" >> /export_model.py && \
    echo "" >> /export_model.py && \
    echo "# Export using GLiNER's built-in export_to_onnx" >> /export_model.py && \
    echo "model.export_to_onnx('./gliner-small-v2.1/onnx')" >> /export_model.py && \
    echo "print('ONNX export complete')" >> /export_model.py && \
    python /export_model.py && ls -la ./gliner-small-v2.1/onnx/

# Fix model_type in the exported config (GLiNER export leaves it as null)
RUN echo "import json" > /fix_config.py && \
    echo "with open('./gliner-small-v2.1/onnx/gliner_config.json', 'r') as f:" >> /fix_config.py && \
    echo "    config = json.load(f)" >> /fix_config.py && \
    echo "config['model_type'] = 'gliner'" >> /fix_config.py && \
    echo "with open('./gliner-small-v2.1/onnx/gliner_config.json', 'w') as f:" >> /fix_config.py && \
    echo "    json.dump(config, f, indent=2)" >> /fix_config.py && \
    echo "print('Fixed model_type in config')" >> /fix_config.py && \
    python /fix_config.py && cat ./gliner-small-v2.1/onnx/gliner_config.json | grep model_type


# =============================================================================
# Build stage: Build all TypeScript packages
# =============================================================================
FROM node:22-slim AS build
WORKDIR /app

# Build args for version info
ARG BUILDTIME
ARG VERSION
ARG REVISION
# CSRF secret for runtime (passed as build arg so Coolify can inject it)
ARG CSRF_SECRET

# Copy root package files for pnpm install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc ./

# Copy all package.json files for workspace resolution
COPY packages/core/package.json packages/core/package.json
COPY packages/proxy/package.json packages/proxy/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/redact/package.json packages/redact/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/cli/package.json packages/cli/package.json

# Enable corepack and install dependencies
# Set PNPM_MINIMUM_RELEASE_AGE=0 to allow newer packages in lockfile
# Export PATH to include pnpm global bin directory
# Use --ignore-scripts then rebuild for native modules (sharp, unrs-resolver)
RUN corepack enable && \
    export PATH="$PATH:/root/.local/share/pnpm/bin" && \
    pnpm config set minimum-release-age 0 --global && \
    pnpm install --ignore-scripts && \
    pnpm rebuild sharp unrs-resolver onnxruntime-node

# Copy source files
COPY packages/core/src packages/core/src
COPY packages/core/tsconfig.json packages/core/tsconfig.json
COPY packages/proxy/src packages/proxy/src
COPY packages/proxy/tsconfig.json packages/proxy/tsconfig.json
COPY packages/logger/src packages/logger/src
COPY packages/logger/tsconfig.json packages/logger/tsconfig.json
COPY packages/redact/src packages/redact/src
COPY packages/redact/tsconfig.json packages/redact/tsconfig.json
COPY packages/web/next.config.mjs packages/web/next.config.mjs
COPY packages/web/postcss.config.cjs packages/web/postcss.config.cjs
COPY packages/web/tailwind.config.js packages/web/tailwind.config.js
COPY packages/web/tsconfig.json packages/web/tsconfig.json
COPY packages/web/app packages/web/app
COPY packages/web/components packages/web/components
COPY packages/web/lib packages/web/lib
COPY packages/web/types packages/web/types
COPY packages/web/globals.css packages/web/globals.css
COPY packages/web/config packages/web/config
COPY packages/web/middleware.ts packages/web/middleware.ts
COPY packages/web/public packages/web/public

# Copy cli package source files
COPY packages/cli/src packages/cli/src
COPY packages/cli/tsconfig.json packages/cli/tsconfig.json

# Build all packages with build-time env vars for version info
RUN GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown") \
    BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
    VERSION=$(cat package.json | grep '"version"' | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/') \
    && export GIT_COMMIT BUILD_TIME VERSION \
    && pnpm exec turbo build


# =============================================================================
# Runtime stage
# =============================================================================
FROM node:22-slim AS runtime
WORKDIR /app

ARG CSRF_SECRET
ENV CSRF_SECRET=${CSRF_SECRET}

ENV NODE_ENV=production
ENV CONTEXT_PROXY_BIND_HOST=0.0.0.0
ENV CONTEXT_PROXY_PORT=4040
ENV CONTEXT_PROXY_PLUGINS=/app/redact-plugin.js,/app/logger-plugin.js,/app/rate-limiter-plugin.js
ENV LOG_TRAFFIC=false
ENV DEBUG_ROUTING=false
ENV LOGGER_CAPTURE_DIR=/app/captures
ENV REDACT_POLICY_FILE=/app/custom-policy/custom-policy.json
# Next.js cache directory for ISR (Incremental Static Regeneration)
# Set to a location writable by the node user (UID 1000)
ENV NEXT_CACHE_DIR=/app/captures/.next/cache

LABEL org.opencontainers.image.title="contextio-next"
LABEL org.opencontainers.image.description="LLM API proxy with redaction, logging, and web UI. Zero external dependencies."
LABEL org.opencontainers.image.url="https://github.com/larsderidder/contextio-next"
LABEL org.opencontainers.image.source="https://github.com/larsderidder/contextio-next"
LABEL org.opencontainers.image.vendor="Lars de Ridder"
LABEL org.opencontainers.image.licenses="MIT"

# Enable corepack for pnpm in runtime
RUN corepack enable

# Copy node_modules and packages directory (symlinks in node_modules point here)
# Exclude web package since we use standalone output
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
RUN rm -rf /app/packages/web

# Copy proxy dist to root for combined entry
COPY --from=build /app/packages/proxy/dist ./dist

# Copy Next.js standalone build output (includes server.js, public folder, .next/static)
COPY --from=build /app/packages/web/.next/standalone/packages/web ./packages/web

# Copy Next.js static assets
COPY --from=build /app/packages/web/.next/static ./packages/web/.next/static

# Copy public folder to standalone output (Next.js copies public to standalone during build)
# This is needed because standalone output doesn't always include public
COPY --from=build /app/packages/web/public ./packages/web/public

# Create Next.js cache directory at the expected location (/app/packages/web/.next/cache)
# This is where Next.js writes ISR/prerender cache by default when using standalone output.
# Also create the backup location (/app/captures/.next/cache) for NEXT_CACHE_DIR env var fallback.
RUN mkdir -p /app/packages/web/.next/cache /app/captures/.next/cache && \
    chmod 755 /app/packages/web/.next/cache /app/captures/.next/cache && \
    ls -la /app/packages/web/.next/cache /app/captures/.next/cache

# Copy bundled default policy file
COPY --from=build /app/packages/web/public/default-policy.json /app/default-policy.json

# Copy GLiNER model from model-builder stage (ONNX export is in onnx/ subdirectory)
COPY --from=model-builder /models/gliner-small-v2.1/onnx /app/models/gliner-small-v2.1

# Create plugin files at build time (they don't change at runtime)
# Use defaults that work without env vars being set
RUN echo 'import { createLoggerPlugin } from "@contextio/logger";' > /app/logger-plugin.js && \
    echo 'const captureDir = process.env.LOGGER_CAPTURE_DIR || "/app/captures";' >> /app/logger-plugin.js && \
    echo 'const maxSessions = process.env.LOGGER_MAX_SESSIONS ? parseInt(process.env.LOGGER_MAX_SESSIONS, 10) : 0;' >> /app/logger-plugin.js && \
    echo '// Encryption at rest configuration' >> /app/logger-plugin.js && \
    echo '// Required: CONTEXTIO_LOGGER_ENCRYPTION_ENABLED=true' >> /app/logger-plugin.js && \
    echo '// Required: CONTEXTIO_LOGGER_ENCRYPTION_KEY=<actual_key_value>' >> /app/logger-plugin.js && \
    echo '// Optional overrides (have defaults in proxy config):' >> /app/logger-plugin.js && \
    echo '//   CONTEXTIO_LOGGER_ENCRYPTION_KEY_PROVIDER (default: "env")' >> /app/logger-plugin.js && \
    echo '//   CONTEXTIO_LOGGER_ENCRYPTION_KEY_LENGTH (default: 32)' >> /app/logger-plugin.js && \
    echo '//   CONTEXTIO_LOGGER_ENCRYPTION_STATIC_KEY (only if keyProvider="static")' >> /app/logger-plugin.js && \
    echo 'const encryptionEnabled = process.env.CONTEXTIO_LOGGER_ENCRYPTION_ENABLED === "true";' >> /app/logger-plugin.js && \
    echo 'const keyProvider = process.env.CONTEXTIO_LOGGER_ENCRYPTION_KEY_PROVIDER || "env";' >> /app/logger-plugin.js && \
    echo 'const staticKey = process.env.CONTEXTIO_LOGGER_ENCRYPTION_STATIC_KEY;' >> /app/logger-plugin.js && \
    echo 'const keyEnvVar = "CONTEXTIO_LOGGER_ENCRYPTION_KEY";' >> /app/logger-plugin.js && \
    echo 'const keyLength = process.env.CONTEXTIO_LOGGER_ENCRYPTION_KEY_LENGTH ? parseInt(process.env.CONTEXTIO_LOGGER_ENCRYPTION_KEY_LENGTH, 10) : 32;' >> /app/logger-plugin.js && \
    echo 'let encryption = undefined;' >> /app/logger-plugin.js && \
    echo 'if (encryptionEnabled) {' >> /app/logger-plugin.js && \
    echo '  encryption = { enabled: true, keyProvider, staticKey, keyEnvVar, keyLength };' >> /app/logger-plugin.js && \
    echo '}' >> /app/logger-plugin.js && \
    echo 'console.log("Logger plugin: captureDir =", captureDir);' >> /app/logger-plugin.js && \
    echo 'console.log("Logger plugin: encryptionEnabled =", encryptionEnabled);' >> /app/logger-plugin.js && \
    echo 'if (encryptionEnabled) {' >> /app/logger-plugin.js && \
    echo '  console.log("[startup] Encryption at rest configuration:");' >> /app/logger-plugin.js && \
    echo '  console.log("  enabled: true");' >> /app/logger-plugin.js && \
    echo '  console.log("  keyProvider:", keyProvider);' >> /app/logger-plugin.js && \
    echo '  console.log("  keyEnvVar:", keyEnvVar);' >> /app/logger-plugin.js && \
    echo '  console.log("  keyLength:", keyLength, "bytes");' >> /app/logger-plugin.js && \
    echo '  console.log("  staticKey provided:", !!staticKey);' >> /app/logger-plugin.js && \
    echo '  const keyValue = process.env[keyEnvVar];' >> /app/logger-plugin.js && \
    echo '  console.log(`  ${keyEnvVar} environment variable:`, keyValue ? "SET" : "NOT SET");' >> /app/logger-plugin.js && \
    echo '  if (keyValue) console.log(`  ${keyEnvVar} length:`, keyValue.length, "chars");' >> /app/logger-plugin.js && \
    echo '}' >> /app/logger-plugin.js && \
    echo 'export default () => createLoggerPlugin({ captureDir, maxSessions, encryption });' >> /app/logger-plugin.js

RUN echo 'import { createRedactPlugin } from "@contextio/redact";' > /app/redact-plugin.js && \
    echo 'const preset = process.env.REDACT_PRESET || "pii";' >> /app/redact-plugin.js && \
    echo 'const reversible = process.env.REDACT_REVERSIBLE === "true";' >> /app/redact-plugin.js && \
    echo 'const policyFile = process.env.REDACT_POLICY_FILE || "/app/custom-policy/custom-policy.json";' >> /app/redact-plugin.js && \
    echo 'const captureDir = process.env.REDACT_CAPTURE_DIR || process.env.LOGGER_CAPTURE_DIR || "/app/captures";' >> /app/redact-plugin.js && \
    echo 'console.log("Redact plugin: policyFile =", policyFile);' >> /app/redact-plugin.js && \
    echo 'console.log("Redact plugin: captureDir =", captureDir);' >> /app/redact-plugin.js && \
    echo 'const config = policyFile ? { policyFile, reversible, captureDir } : { preset, reversible, captureDir };' >> /app/redact-plugin.js && \
    echo 'export default () => createRedactPlugin(config);' >> /app/redact-plugin.js

RUN echo 'import { createRateLimiterPlugin } from "@contextio/proxy";' > /app/rate-limiter-plugin.js && \
    echo 'const maxRequests = process.env.RATE_LIMITER_MAX_REQUESTS ? parseInt(process.env.RATE_LIMITER_MAX_REQUESTS, 10) : 60;' >> /app/rate-limiter-plugin.js && \
    echo 'const windowMs = process.env.RATE_LIMITER_WINDOW_MS ? parseInt(process.env.RATE_LIMITER_WINDOW_MS, 10) : 60000;' >> /app/rate-limiter-plugin.js && \
    echo 'const bufferCapacity = process.env.RATE_LIMITER_BUFFER_CAPACITY ? parseInt(process.env.RATE_LIMITER_BUFFER_CAPACITY, 10) : 10;' >> /app/rate-limiter-plugin.js && \
    echo 'const enabled = process.env.RATE_LIMITER_ENABLED !== "false";' >> /app/rate-limiter-plugin.js && \
    echo 'console.log("Rate limiter plugin: maxRequests =", maxRequests);' >> /app/rate-limiter-plugin.js && \
    echo 'console.log("Rate limiter plugin: windowMs =", windowMs);' >> /app/rate-limiter-plugin.js && \
    echo 'console.log("Rate limiter plugin: bufferCapacity =", bufferCapacity);' >> /app/rate-limiter-plugin.js && \
    echo 'console.log("Rate limiter plugin: enabled =", enabled);' >> /app/rate-limiter-plugin.js && \
    echo 'export default () => createRateLimiterPlugin({ defaults: { maxRequests, windowMs, bufferCapacity }, enabled });' >> /app/rate-limiter-plugin.js

# Create directories at build time with proper permissions
# This avoids permission issues when volumes are mounted by external tools like Coolify
# Create both Next.js cache locations:
# - /app/packages/web/.next/cache (expected location for standalone output)
# - /app/captures/.next/cache (NEXT_CACHE_DIR fallback)
RUN mkdir -p /app/captures /app/custom-policy /home/node/.contextio-next /app/captures/.next/cache /app/packages/web/.next/cache && \
    chmod 700 /app/captures /app/custom-policy /home/node/.contextio-next && \
    chmod 755 /app/captures/.next/cache /app/packages/web/.next/cache && \
    ls -la /app/captures /app/custom-policy /home/node/.contextio-next /app/captures/.next/cache /app/packages/web/.next/cache

# Single entry point: combined proxy + web UI on port 4040
RUN echo '#!/bin/sh' > /app/start.sh && \
    echo 'echo "Setting up runtime files..."' >> /app/start.sh && \
    echo '# Use CAPTURE_DIR from env or default to /app/captures' >> /app/start.sh && \
    echo 'CAPTURE_DIR="${LOGGER_CAPTURE_DIR:-/app/captures}"' >> /app/start.sh && \
    echo 'echo "Using capture directory: $CAPTURE_DIR"' >> /app/start.sh && \
    echo '# Policy file in mounted directory' >> /app/start.sh && \
    echo 'POLICY_FILE="/app/custom-policy/custom-policy.json"' >> /app/start.sh && \
    echo 'if [ ! -f "$POLICY_FILE" ]; then' >> /app/start.sh && \
    echo '    echo "Policy file not found at $POLICY_FILE, creating from default..."' >> /app/start.sh && \
    echo '    cp /app/default-policy.json "$POLICY_FILE"' >> /app/start.sh && \
    echo 'fi' >> /app/start.sh && \
    echo '# Ensure policy file is writable by node user' >> /app/start.sh && \
    echo 'chmod 666 "$POLICY_FILE" 2>/dev/null || true' >> /app/start.sh && \
    echo '# Ensure custom-policy directory is readable (for settings.json)' >> /app/start.sh && \
    echo 'chmod 755 /app/custom-policy 2>/dev/null || true' >> /app/start.sh && \
    echo 'echo "Using policy file: $POLICY_FILE"' >> /app/start.sh && \
    echo '# Log policy file status' >> /app/start.sh && \
    echo 'if [ -f "/app/custom-policy/custom-policy.json" ] && [ ! -f "/app/custom-policy/custom-policy.json.default" ]; then' >> /app/start.sh && \
    echo '    echo "Custom policy file: LOADED (true)"' >> /app/start.sh && \
    echo 'else' >> /app/start.sh && \
    echo '    echo "Custom policy file: LOADED (false) - using default"' >> /app/start.sh && \
    echo 'fi' >> /app/start.sh && \
    echo 'echo "Active policy contents:"' >> /app/start.sh && \
    echo 'cat "$POLICY_FILE"' >> /app/start.sh && \
    echo 'mkdir -p "$CAPTURE_DIR"' >> /app/start.sh && \
    echo 'chmod 700 "$CAPTURE_DIR" 2>/dev/null || true' >> /app/start.sh && \
    echo '# Ensure Next.js cache directories exist and are writable' >> /app/start.sh && \
    echo 'NEXT_CACHE="${NEXT_CACHE_DIR:-/app/captures/.next/cache}"' >> /app/start.sh && \
    echo 'mkdir -p "$NEXT_CACHE" /app/packages/web/.next/cache' >> /app/start.sh && \
    echo 'chmod 755 "$NEXT_CACHE" /app/packages/web/.next/cache 2>/dev/null || true' >> /app/start.sh && \
    echo 'echo "Starting ContextIO-Next (Proxy + Web UI) on port 4040..."' >> /app/start.sh && \
    echo 'node dist/combined-entry.js' >> /app/start.sh && \
    chmod +x /app/start.sh

# Fix permissions for node user (after all files are created)
# Only change ownership of files we control, not mounted volumes
RUN chown node:node /app/logger-plugin.js /app/redact-plugin.js /app/rate-limiter-plugin.js /app/start.sh /app/default-policy.json /app/captures /app/custom-policy /home/node/.contextio-next /app/captures/.next/cache /app/packages/web/.next/cache && \
    chmod +x /app/start.sh

USER node
EXPOSE 4040

CMD ["/app/start.sh"]