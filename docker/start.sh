#!/bin/sh
echo "Setting up runtime files..."
# Use CAPTURE_DIR from env or default to /app/captures
CAPTURE_DIR="${LOGGER_CAPTURE_DIR:-/app/captures}"
echo "Using capture directory: $CAPTURE_DIR"
# Policy file in mounted directory
POLICY_FILE="/app/custom-policy/custom-policy.json"
if [ ! -f "$POLICY_FILE" ]; then
    echo "Policy file not found at $POLICY_FILE, creating from default..."
    cp /app/default-policy.json "$POLICY_FILE"
fi
# Ensure policy file is writable by node user
chmod 666 "$POLICY_FILE" 2>/dev/null || true
# Ensure custom-policy directory is readable (for settings.json)
chmod 755 /app/custom-policy 2>/dev/null || true
echo "Using policy file: $POLICY_FILE"
# Log policy file status
if [ -f "/app/custom-policy/custom-policy.json" ] && [ ! -f "/app/custom-policy/custom-policy.json.default" ]; then
    echo "Custom policy file: LOADED (true)"
else
    echo "Custom policy file: LOADED (false) - using default"
fi
echo "Active policy contents:"
cat "$POLICY_FILE"
# Providers config file in mounted directory
PROVIDERS_FILE="/app/custom-policy/providers.json"
if [ ! -f "$PROVIDERS_FILE" ]; then
    echo "Providers file not found at $PROVIDERS_FILE, creating from default..."
    cp /app/default-providers.json "$PROVIDERS_FILE"
fi
chmod 600 "$PROVIDERS_FILE" 2>/dev/null || true
mkdir -p "$CAPTURE_DIR"
chmod 700 "$CAPTURE_DIR" 2>/dev/null || true
# Ensure Next.js cache directories exist and are writable
NEXT_CACHE="${NEXT_CACHE_DIR:-/app/captures/.next/cache}"
mkdir -p "$NEXT_CACHE" /app/packages/web/.next/cache
chmod 755 "$NEXT_CACHE" /app/packages/web/.next/cache 2>/dev/null || true
# Ensure database directory exists
mkdir -p /app/custom-policy
chmod 700 /app/custom-policy 2>/dev/null || true
echo "Starting ContextIO-Next (Proxy + Web UI) on port 4040..."
node dist/combined-entry.js