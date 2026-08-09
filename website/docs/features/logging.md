---
layout: doc
---

# Capture Logging

Every request/response passing through the proxy is captured to disk as a JSON file.

## File Format

```
claude_a1b2c3d4_1739000000000-000001.json
```

### Structure

```json
{
  "timestamp": "2026-02-15T20:50:00.815Z",
  "sessionId": "67bb9e8f",
  "source": "claude",
  "provider": "anthropic",
  "apiFormat": "anthropic-messages",
  "targetUrl": "https://api.anthropic.com/v1/messages",
  "requestBody": {
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "..."}]
  },
  "responseStatus": 200,
  "responseIsStreaming": true,
  "responseBody": "data: {\"type\":\"content_block_delta\",...}",
  "timings": { "total_ms": 2002 },
  "requestHeaders": {...},
  "responseHeaders": {...},
  "requestSize": 1024,
  "responseSize": 4096
}
```

### Fields

| Field | Description |
|-------|-------------|
| `timestamp` | ISO 8601 timestamp |
| `sessionId` | 8-char hex session identifier |
| `source` | Tool name (claude, gemini, codex, etc.) |
| `provider` | Upstream provider (anthropic, openai, gemini, etc.) |
| `apiFormat` | API format variant |
| `targetUrl` | Full upstream URL |
| `requestBody` | Parsed request JSON (sensitive headers stripped) |
| `responseStatus` | HTTP status code |
| `responseIsStreaming` | Boolean |
| `responseBody` | Raw response (streaming: concatenated chunks) |
| `timings` | Latency breakdown |

## Retention Policies

### Time-Based
```env
LOGGER_CAPTURE_MAX_AGE=30          # Delete captures older than 30 days
LOGGER_CAPTURE_CLEANUP_INTERVAL=24  # Run cleanup every 24 hours
LOGGER_CAPTURE_CLEANUP_ENABLED=true
```

### Count-Based
```env
LOGGER_MAX_SESSIONS=100  # Keep max 100 sessions (0 = unlimited)
```

On startup, oldest sessions are pruned if limit exceeded.

## Encryption

Enable AES-256-GCM encryption:
```env
CONTEXTIO_LOGGER_ENCRYPTION_ENABLED=true
CONTEXTIO_LOGGER_ENCRYPTION_KEY=<your-key>
```

Encrypted files have `.enc` extension and are decrypted transparently on read.

## Capture Directory

```env
LOGGER_CAPTURE_DIR=/app/captures  # Default
```

In Docker, mount a volume:
```yaml
volumes:
  - captures:/app/captures
```

## Sensitive Data Handling

**Automatically stripped** before writing:
- `Authorization` header
- `x-api-key` header
- `cookie` / `set-cookie` headers
- Any header matching `*secret*`, `*token*`, `*key*`

## CLI Access

```bash
# List sessions
ctxio inspect

# Show session details
ctxio inspect a1b2c3d4

# Token stats
ctxio inspect a1b2c3d4 --stats

# Export session
ctxio export a1b2c3d4

# Replay request
ctxio replay capture-file.json
```

## Web UI

View captures at `http://localhost:4040/sessions`:
- Filter by session, provider, date
- View full request/response
- Streaming reconstruction
- Token counts and timings

## Programmatic Access

```typescript
import { listCaptureFiles, loadSessionCaptures } from '@contextio/cli/captures';

// List all captures
const files = await listCaptureFiles();

// Load session
const captures = await loadSessionCaptures('a1b2c3d4');
```

## SQLite Index

For large capture sets, SQLite metadata index speeds up queries:
- `captures_metadata` table: filepath, sessionId, provider, timestamp, model, status, tokens
- Auto-migration on startup
- CLI: `ctxio migrate captures` or `ctxio captures reindex`

## Disk Usage

Typical sizes:
- **Simple request**: ~2-5 KB
- **Streaming response**: ~10-50 KB
- **Large context**: ~100-500 KB

With 1000 sessions/day × 50 KB = ~50 MB/day

## Cleanup

Manual cleanup:
```bash
# Delete all captures
rm -rf /app/captures/*

# Or via CLI
ctxio captures cleanup --older-than 30d
```

Automatic cleanup runs on:
- Container startup
- Interval (`LOGGER_CAPTURE_CLEANUP_INTERVAL`)
- When `LOGGER_MAX_SESSIONS` exceeded