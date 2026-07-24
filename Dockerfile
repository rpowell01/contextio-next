FROM node:22-alpine AS build
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


FROM node:22-alpine AS runtime
WORKDIR /app

ARG CSRF_SECRET
ENV CSRF_SECRET=${CSRF_SECRET}

ENV NODE_ENV=production
ENV CONTEXT_PROXY_BIND_HOST=0.0.0.0
ENV CONTEXT_PROXY_PORT=4040
ENV CONTEXT_PROXY_PLUGINS=/app/redact-plugin.js,/app/logger-plugin.js
ENV LOG_TRAFFIC=false
ENV DEBUG_ROUTING=false
ENV LOGGER_CAPTURE_DIR=/app/captures
ENV REDACT_POLICY_FILE=/app/custom-policy/custom-policy.json

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

# Copy bundled default policy file
COPY --from=build /app/packages/web/public/default-policy.json /app/default-policy.json

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

# Create directories at build time with proper permissions
# This avoids permission issues when volumes are mounted by external tools like Coolify
RUN mkdir -p /app/captures /app/custom-policy /home/node/.contextio-next && \
    chmod 700 /app/captures /app/custom-policy /home/node/.contextio-next && \
    ls -la /app/captures /app/custom-policy /home/node/.contextio-next

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
    echo 'echo "Starting ContextIO-Next (Proxy + Web UI) on port 4040..."' >> /app/start.sh && \
    echo 'node dist/combined-entry.js' >> /app/start.sh && \
    chmod +x /app/start.sh

# Fix permissions for node user (after all files are created)
# Only change ownership of files we control, not mounted volumes
RUN chown node:node /app/logger-plugin.js /app/redact-plugin.js /app/start.sh /app/default-policy.json /app/captures /app/custom-policy /home/node/.contextio-next && \
    chmod +x /app/start.sh

USER node
EXPOSE 4040

CMD ["/app/start.sh"]