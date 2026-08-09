---
layout: doc
---

# Reversible Redaction

When enabled, original values are replaced with numbered placeholders in the request, then **restored in the response stream** so you see the original content.

## How It Works

```
Your Input:     "My email is [EMAIL_REDACTED] and SSN is [SSN_REDACTED]"
                    │
                    ▼
LLM Receives:   "My email is [EMAIL_1] and SSN is [SSN_1]"
                    │
                    ▼
LLM Responds:   "I've noted [EMAIL_1] and [SSN_1] for your records"
                    │
                    ▼
You See:        "I've noted [EMAIL_REDACTED] and [SSN_REDACTED] for your records"
```

## Enable

```bash
REDACT_REVERSIBLE=true
```

Or in Web UI: Settings → Redaction → **Reversible Mode**

## Key Properties

| Property | Behavior |
|----------|----------|
| **Per-session** | Mappings stored per session ID in SQLite |
| **Consistent** | Same value → same placeholder within a session |
| **Streaming** | Works with SSE, chunked, and ndjson responses |
| **Multi-provider** | Anthropic, OpenAI, Gemini formats supported |
| **In-memory** | Originals kept in memory during request/response |

## Placeholder Format

- **Request**: `[TYPE_N]` where TYPE = entity type, N = sequence number
- **Response**: Automatically restored to original `[TYPE_REDACTED]` format

Example:
```
Original:     "sk-ant-api03-abc123...", "user@example.com"
Request:      "[API_KEY_1]", "[EMAIL_1]"
Response:     "Your key [API_KEY_1] is valid" → "Your key [API_KEY_REDACTED] is valid"
```

## Storage

Mappings stored in SQLite at `/app/custom-policy/contextio.db`:

```sql
-- redaction_placeholders table
session_id | placeholder | original_value | entity_type
abc123     | EMAIL_1     | user@test.com  | email
abc123     | API_KEY_1   | sk-ant-...     | api_key
```

- Encrypted at rest (same as captures)
- TTL: cleared with session cleanup
- Never logged or exported

## Streaming Support

Works with all streaming formats:

| Provider | Format | Supported |
|----------|--------|-----------|
| Anthropic | SSE (`data: {...}`) | ✓ |
| OpenAI | SSE (`data: {...}`) | ✓ |
| Gemini | SSE / ndjson | ✓ |
| OpenRouter | SSE | ✓ |
| Custom | ndjson / chunked | ✓ |

The plugin reconstructs SSE events on-the-fly, replacing placeholders in `content_block_delta`, `message_delta`, and similar events.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `REDACT_REVERSIBLE` | `false` | Enable reversible mode |

Can also be overridden per-request:
```bash
# Enable for single request
curl -H "x-contextio-redact: true" \
     -H "x-contextio-reversible: true" \
     ...
```

## Limitations

| Limitation | Details |
|------------|---------|
| **Memory** | Originals kept in memory during request/response cycle |
| **Session scope** | Mappings don't persist across sessions |
| **New in response** | Values only in response (not in request) aren't restored |
| **Encoding** | Requires valid UTF-8 in response stream |

## Debugging

Enable debug logging:
```bash
LOG_LEVEL=debug
```

Look for:
```
[REDACT] Reversible: mapped [EMAIL_REDACTED] → [EMAIL_1]
[REDACT] Reversible: restoring [EMAIL_1] → [EMAIL_REDACTED] in response
```

## Use Cases

- **Code review**: Share LLM conversations without exposing secrets
- **Compliance**: Audit trail with redacted logs, readable responses
- **Development**: Debug LLM outputs with real data, safely
- **Training**: Collect datasets with PII protected

## Example Flow

```bash
# 1. Start proxy with reversible redaction
docker run -e REDACT_REVERSIBLE=true ...

# 2. Send request with PII
curl -X POST http://localhost:4040/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"messages":[{"role":"user","content":"My SSN is 123-45-6789 and email is john@doe.com"}]}'

# 3. LLM sees: "My SSN is [SSN_1] and email is [EMAIL_1]"
# 4. LLM responds: "Thanks for sharing [SSN_1] and [EMAIL_1]"
# 5. You see: "Thanks for sharing [SSN_REDACTED] and [EMAIL_REDACTED]"

# 4. Check captures in Web UI → Sessions
# Shows both redacted request and restored response
```