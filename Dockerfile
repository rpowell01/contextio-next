# =============================================================================
# Main Dockerfile for Coolify
# =============================================================================

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
# Encryption key for logger plugin (passed as build arg so Coolify can inject it)
ARG CONTEXTIO_LOGGER_ENCRYPTION_KEY

# Enable corepack and configure pnpm
RUN corepack enable && \
    export PATH="$PATH:/root/.local/share/pnpm/bin" && \
    pnpm config set minimum-release-age 0 --global

# Install build dependencies for native modules (better-sqlite3 needs python3, make, g++, sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

# Approve native module builds
RUN export PATH="$PATH:/root/.local/share/pnpm/bin" && \
    pnpm approve-builds better-sqlite3

# Copy root package files and all packages for pnpm install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc ./
COPY packages/ packages/

# Install dependencies with scripts allowed for approved packages
RUN export PATH="$PATH:/root/.local/share/pnpm/bin" && \
    pnpm install --frozen-lockfile

# Build all packages with build-time env vars for version info
RUN export PATH="$PATH:/root/.local/share/pnpm/bin" && \
    GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown") \
    BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
    VERSION=$(cat package.json | grep '"version"' | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/') \
    && export GIT_COMMIT BUILD_TIME VERSION \
    && pnpm exec turbo build

# Copy default providers config to a known location that persists in the build stage
RUN cp /app/packages/proxy/public/default-providers.json /app/default-providers.json


# =============================================================================
# Runtime stage
# =============================================================================
FROM node:22-slim AS runtime
WORKDIR /app

ARG CSRF_SECRET
ENV CSRF_SECRET=${CSRF_SECRET}
# Encryption key for logger plugin
ARG CONTEXTIO_LOGGER_ENCRYPTION_KEY
ENV CONTEXTIO_LOGGER_ENCRYPTION_KEY=${CONTEXTIO_LOGGER_ENCRYPTION_KEY}

ENV NODE_ENV=production
ENV CONTEXT_PROXY_BIND_HOST=0.0.0.0
ENV CONTEXT_PROXY_PORT=4040
ENV CONTEXT_PROXY_PLUGINS=/app/redact-plugin.js,/app/logger-plugin.js
ENV LOG_TRAFFIC=false
ENV DEBUG_ROUTING=false
ENV LOGGER_CAPTURE_DIR=/app/captures
ENV REDACT_POLICY_FILE=/app/custom-policy/custom-policy.json
ENV NEXT_CACHE_DIR=/app/captures/.next/cache
ENV CONTEXTIO_DB_PATH=/app/custom-policy/contextio.db

LABEL org.opencontainers.image.title="contextio-next"
LABEL org.opencontainers.image.description="LLM API proxy with redaction, logging, and web UI. Zero external dependencies."
LABEL org.opencontainers.image.url="https://github.com/larsderidder/contextio-next"
LABEL org.opencontainers.image.source="https://github.com/larsderidder/contextio-next"
LABEL org.opencontainers.image.vendor="Lars de Ridder"
LABEL org.opencontainers.image.licenses="MIT"

# Enable corepack for pnpm in runtime
RUN corepack enable

# Copy node_modules and packages directory (symlinks in node_modules point here)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
RUN rm -rf /app/packages/web

# Copy proxy dist to root for combined entry
COPY --from=build /app/packages/proxy/dist ./dist

# Copy core dist for migrations (migration runner looks at dist/db/migrations)
COPY --from=build /app/packages/core/dist ./packages/core/dist

# Verify migrations were copied (fail build if missing)
RUN ls -la /app/packages/core/dist/db/migrations/ && \
    test -f /app/packages/core/dist/db/migrations/014_add_feature_flags_and_advanced_config.sql && \
    test -f /app/packages/core/dist/db/migrations/015_add_upstream_urls.sql

# Copy Next.js standalone build output
COPY --from=build /app/packages/web/.next/standalone/packages/web ./packages/web
COPY --from=build /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=build /app/packages/web/public ./packages/web/public

# Create Next.js cache directories
RUN mkdir -p /app/packages/web/.next/cache /app/captures/.next/cache && \
    chmod 755 /app/packages/web/.next/cache /app/captures/.next/cache

# Copy bundled default policy file
COPY --from=build /app/packages/web/public/default-policy.json /app/default-policy.json
COPY --from=build /app/default-providers.json /app/default-providers.json

# Copy pre-built plugin files and start script
COPY docker/plugins/logger-plugin.js /app/logger-plugin.js
COPY docker/plugins/redact-plugin.js /app/redact-plugin.js
COPY docker/plugins/rate-limiter-plugin.js /app/rate-limiter-plugin.js
COPY docker/start.sh /app/start.sh

# Create directories at build time with proper permissions
RUN mkdir -p /app/captures /app/custom-policy /home/node/.contextio-next /app/captures/.next/cache /app/packages/web/.next/cache && \
    chmod 700 /app/captures /app/custom-policy /home/node/.contextio-next && \
    chmod 755 /app/captures/.next/cache /app/packages/web/.next/cache && \
    chmod +x /app/start.sh

# Create default settings.json if it doesn't exist
RUN echo '{"captureCleanupEnabled":true,"captureCleanupIntervalHours":24,"captureCleanupMaxAgeDays":7,"oidcEnabled":false}' > /app/custom-policy/settings.json && \
    chown node:node /app/custom-policy/settings.json

# Fix permissions for node user
RUN chown node:node /app/logger-plugin.js /app/redact-plugin.js /app/rate-limiter-plugin.js /app/start.sh /app/default-policy.json /app/default-providers.json /app/captures /app/custom-policy /home/node/.contextio-next /app/captures/.next/cache /app/packages/web/.next/cache

USER node
EXPOSE 4040

CMD ["/app/start.sh"]