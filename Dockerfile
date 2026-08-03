# =============================================================================
# Build stage: Prepare GLiNER model using Python (Debian-based for onnxruntime)
# =============================================================================
# GLiNER version pin - change this to rebuild the model with a new version
ARG GLINER_VERSION=0.2.28

FROM python:3.11-slim AS model-builder
WORKDIR /models

ARG GLINER_VERSION=0.2.28

# Install GLiNER, Optimum CLI with ONNX support, and huggingface_hub for downloading
RUN pip install --no-cache-dir gliner==${GLINER_VERSION} optimum[onnx] onnxruntime huggingface_hub

# Export to ONNX using GLiNER's built-in export_to_onnx method
RUN echo "from huggingface_hub import snapshot_download" > /download_model.py && \
    echo "snapshot_download(" >> /download_model.py && \
    echo "    repo_id='urchade/gliner_small-v2.1'," >> /download_model.py && \
    echo "    local_dir='./gliner-small-v2.1'," >> /download_model.py && \
    echo "    local_dir_use_symlinks=False," >> /download_model.py && \
    echo "    allow_patterns=['*.json', '*.txt', '*.model', 'config.json', 'vocab.txt', 'tokenizer*', 'special_tokens*', '*.bin', '*.safetensors']" >> /download_model.py && \
    echo ")" >> /download_model.py && \
    echo "print('Model files downloaded')" >> /download_model.py && \
    python /download_model.py && ls -la ./gliner-small-v2.1/ && \
    echo "from gliner import GLiNER" > /export_model.py && \
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
    python /export_model.py && ls -la ./gliner-small-v2.1/onnx/ && \
    echo "import json" > /fix_config.py && \
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
# Placeholder ARG to catch Coolify-injected build args
# IMPORTANT: This MUST come AFTER model-builder stage so Coolify's injected ARGs
# don't invalidate the model-builder cache
ARG COOLIFY_ARGS_PLACEHOLDER

FROM node:22-slim AS build
WORKDIR /app

# Build args for version info
ARG BUILDTIME
ARG VERSION
ARG REVISION
# CSRF secret for runtime (passed as build arg so Coolify can inject it)
ARG CSRF_SECRET

# Enable corepack and configure pnpm
RUN corepack enable && \
    export PATH="$PATH:/root/.local/share/pnpm/bin" && \
    pnpm config set minimum-release-age 0 --global

# Copy root package files and all packages for pnpm install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc ./
COPY packages/ packages/

# Install dependencies (no cache mount - works with legacy builder)
RUN export PATH="$PATH:/root/.local/share/pnpm/bin" && \
    pnpm install --ignore-scripts --frozen-lockfile && \
    pnpm rebuild sharp unrs-resolver onnxruntime-node

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

ENV NODE_ENV=production
ENV CONTEXT_PROXY_BIND_HOST=0.0.0.0
ENV CONTEXT_PROXY_PORT=4040
ENV CONTEXT_PROXY_PLUGINS=/app/redact-plugin.js,/app/logger-plugin.js
ENV LOG_TRAFFIC=false
ENV DEBUG_ROUTING=false
ENV LOGGER_CAPTURE_DIR=/app/captures
ENV REDACT_POLICY_FILE=/app/custom-policy/custom-policy.json
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
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
RUN rm -rf /app/packages/web

# Copy proxy dist to root for combined entry
COPY --from=build /app/packages/proxy/dist ./dist

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

# Copy GLiNER model from model-builder stage (cacheable - only rebuilds when GLINER_VERSION changes)
COPY --from=model-builder /models/gliner-small-v2.1/onnx /app/models/gliner-small-v2.1

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

# Fix permissions for node user
RUN chown node:node /app/logger-plugin.js /app/redact-plugin.js /app/rate-limiter-plugin.js /app/start.sh /app/default-policy.json /app/default-providers.json /app/captures /app/custom-policy /home/node/.contextio-next /app/captures/.next/cache /app/packages/web/.next/cache

USER node
EXPOSE 4040

CMD ["/app/start.sh"]