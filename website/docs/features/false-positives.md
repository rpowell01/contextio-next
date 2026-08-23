---
layout: doc
---

# False Positive Feedback System

When the redaction engine incorrectly flags a legitimate value (e.g., a test email like `test@example.com`, a placeholder token, or an internal reference), you can mark it as a **false positive** so it won't be redacted in future requests.

## Overview

The feedback system lets you build a personalized allowlist of values that should never be redacted, improving accuracy for your specific use case without modifying detection rules.

## How to Add False Positives

### Method 1: Click-to-Add from Session Diff (Recommended)

1. Open **Web UI → Sessions** and click a capture
2. In the detail view, click **"Show Diff"** for a request/response
3. Click any redaction badge (e.g., `[EMAIL_1]`, `[SSN_2]`) in the diff dialog
4. Click **"Add as False Positive"** in the tooltip
5. Configure options in the dialog and submit

### Method 2: Manual Entry via Redactions Page

1. Open **Web UI → Redactions** page
2. Click **"Add False Positive"** button
3. Fill in the form:
   - **Value** — the exact string to exempt (e.g., `test@example.com`)
   - **Rule ID** — which detection rule this applies to (e.g., `email`, `ssn`, `credit_card`, `presidio-ts`)
   - **Mode** — `exact` or `pattern`
   - **Session ID** — optional; leave blank for global, or enter a session ID to scope to one session
4. Submit

## Matching Modes

| Mode | Behavior | Example |
|------|----------|---------|
| **Exact** | Only the exact value is exempted | `test@example.com` exempts only `test@example.com` |
| **Pattern** | Glob-style pattern (`*` = any chars) | `test*@example.com` exempts `test1@example.com`, `test_user@example.com`, etc. |

## Scoping

| Scope | Behavior |
|-------|----------|
| **Global** (no session ID) | Applies to all sessions, all requests |
| **Session-scoped** | Only applies to requests with matching `sessionId` |

## Configuration

Configure the feedback store in **Web UI → Settings → Redaction** tab:

| Setting | Options | Description |
|---------|---------|-------------|
| **Enable Feedback Store** | `true` / `false` | Persist false positives across proxy restarts |
| **Storage Backend** | `sqlite` / `memory` | `sqlite` = persistent file; `memory` = lost on restart |
| **SQLite Path** | `/app/data/false-positives.db` | File path for SQLite backend (only used when backend is `sqlite`) |

> **Note**: Changes to storage backend require a proxy restart to take effect.

## Access Control (Admin Only)

False positive management is restricted to **admin users**:

1. Set `ADMIN_EMAILS` environment variable (comma-separated list of admin email addresses)
2. Configure OIDC authentication (required for user identity)
3. Only users whose email matches `ADMIN_EMAILS` can:
   - View the Redactions page false positive manager
   - Add/edit/delete false positives
   - Access the admin API endpoints

```bash
# Example .env
ADMIN_EMAILS=admin@company.com,security@company.com
CONTEXTIO_OIDC_ENABLED=true
# ... other OIDC config
```

## Admin API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/redact/false-positives` | List all false positives (paginated) |
| `POST` | `/admin/redact/false-positives` | Create new false positive entry |
| `DELETE` | `/admin/redact/false-positives` | Remove a false positive entry |
| `POST` | `/admin/redact/false-positives/clear` | Clear all false positives |

### Example: Create via API

```bash
curl -X POST http://localhost:4040/admin/redact/false-positives \
  -H "Content-Type: application/json" \
  -H "Cookie: <session-cookie>" \
  -d '{
    "value": "test@example.com",
    "ruleId": "email",
    "mode": "exact",
    "sessionId": null
  }'
```

### Example: List via API

```bash
curl http://localhost:4040/admin/redact/false-positives?page=1&limit=50 \
  -H "Cookie: <session-cookie>"
```

## How It Works Internally

1. When a request comes in, the redaction engine detects PII/secrets
2. Before applying redaction, it checks the feedback store for matching false positives
3. If a match is found (by value + ruleId + session scope), that detection is skipped
4. The value passes through unredacted
5. In reversible mode, no placeholder is inserted for false positive matches

## Best Practices

- **Use exact mode for specific values** — test emails, known placeholder tokens
- **Use pattern mode for families** — `dev-*@company.com`, `test-*@example.com`
- **Scope to session when possible** — reduces accidental over-matching in other contexts
- **Review periodically** — audit the false positives list to ensure they're still needed
- **Combine with custom policies** — for systematic over-detection, consider a custom redaction policy instead

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Access denied" when adding | Ensure your email is in `ADMIN_EMAILS` and you're logged in via OIDC |
| False positive not working | Check ruleId matches exactly (see detection logs for rule IDs) |
| Pattern not matching | Patterns use glob syntax: `*` = any chars, `?` = single char |
| Changes not persisting | Enable Feedback Store + set SQLite backend + restart proxy |
| Session-scoped not working | Verify sessionId matches exactly (check Sessions page for ID) |