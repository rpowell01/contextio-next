---
layout: doc
---

# Redaction

The redaction engine detects and replaces PII, secrets, and custom patterns in LLM requests before they leave your machine.

## Presets

| Preset | What It Catches |
|--------|-----------------|
| `secrets` | API keys, tokens, private keys, AWS credentials, generic secrets |
| `pii` | Everything in `secrets` + email, SSN, credit cards, US phone numbers |
| `strict` | Everything in `pii` + IPv4 addresses, dates of birth |

**Default**: `pii`

```bash
# Use preset
REDACT_PRESET=pii

# Or disable
REDACT_PRESET=
```

## Custom Policies

Create a JSONC policy file and reference it:

```bash
REDACT_POLICY_FILE=/app/custom-policy/my-policy.jsonc
```

### Policy Structure

```jsonc
{
  "extends": "pii",           // optional: inherit from preset
  "rules": [],                // custom rules
  "allowlist": {},            // values to never redact
  "paths": {}                 // scope to specific JSON paths
}
```

### Custom Rules

```jsonc
{
  "rules": [
    {
      "id": "employee-id",           // unique identifier
      "pattern": "EMP-\\d{5,}",      // regex (double-escaped)
      "replacement": "[EMPLOYEE_ID]", // replacement text
      "context": ["employee", "staff"], // context-gating words
      "contextWindow": 150            // character radius (default: 100)
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique name for logging and placeholders |
| `pattern` | Yes | Regex with global flag. Double-escape in JSON (`\\d`) |
| `replacement` | Yes | Replacement text. Supports `$1`, `$2` for capture groups |
| `context` | No | Rule only fires if context word appears nearby |
| `contextWindow` | No | Character radius for context search (default: 100) |

### Case-Insensitive Patterns

Prefix with `(?i)`:

```jsonc
{ "id": "project-name", "pattern": "(?i)project[- ]atlas", "replacement": "[PROJECT]" }
```

### Allowlist

Never redact these values:

```jsonc
{
  "allowlist": {
    "strings": ["support@mycompany.com"],
    "patterns": ["test-\\d+@example\\.com"]
  }
}
```

### Path Scoping

Limit redaction to specific JSON paths:

```jsonc
{
  "paths": {
    "only": ["messages[*].content", "system"],
    "skip": ["model", "max_tokens"]
  }
}
```

- `only` — Only redact these paths (everything else untouched)
- `skip` — Never redact these paths (checked first)

**Path syntax**: dot notation with `[*]` for array wildcards
- `messages[*].content` — every message's content
- `system` — top-level system field
- `metadata.user.name` — nested field

## Examples

### Secrets Only
```jsonc
{ "extends": "secrets" }
```

### PII + Org Rules
```jsonc
{
  "extends": "pii",
  "rules": [
    { "id": "employee-id", "pattern": "EMP-\\d{5,}", "replacement": "[EMPLOYEE_ID]" }
  ],
  "allowlist": {
    "strings": ["support@mycompany.com"]
  }
}
```

### Custom Rules Only
```jsonc
{
  "rules": [
    { "id": "internal-ip", "pattern": "10\\.\\d+\\.\\d+\\.\\d+", "replacement": "[INTERNAL_IP]" },
    {
      "id": "dutch-bsn",
      "pattern": "\\b\\d{9}\\b",
      "replacement": "[BSN]",
      "context": ["bsn", "burgerservicenummer"]
    }
  ]
}
```

### Scope to Message Content
```jsonc
{
  "extends": "strict",
  "paths": {
    "only": ["messages[*].content", "system"],
    "skip": ["model"]
  }
}
```

## Testing Your Policy

### 1. Quick Test (Node.js)
```bash
node -e "
const policy = require('./my-policy.jsonc');
const { redactWithPolicy } = require('@contextio/redact');
const test = 'Contact [EMAIL_REDACTED] or [EMPLOYEE_ID]';
console.log(redactWithPolicy(test, policy));
"
```

### 2. Test with Proxy
```bash
ctxio proxy --redact-policy ./my-policy.jsonc --verbose
# In another terminal:
curl -X POST http://127.0.0.1:4040/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"messages":[{"role":"user","content":"My email is test@example.com"}]}'
```

### 3. Validate JSON Syntax
```bash
node -e "
const fs = require('fs');
const policy = JSON.parse(fs.readFileSync('./my-policy.jsonc', 'utf8')
  .replace(/\\/\\/.*$/gm, '')
  .replace(/,\\s*([\\]\\}])/g, '\$1'));
console.log('Valid:', JSON.stringify(policy, null, 2));
"
```

## Web UI Configuration

Settings → **Redaction** tab:
- Select preset or upload custom policy
- Toggle reversible mode
- Configure GLiNER detector
- View redaction statistics

## JSON Schema

For IDE autocomplete and validation:

```json
{
  "$schema": "https://contextio-next.dev/schemas/redaction-policy.json"
}
```

Or download: `https://github.com/rpowell01/contextio-next/raw/main/schemas/redaction-policy.schema.json`

### VS Code Integration
```json
{
  "json.schemas": [
    {
      "fileMatch": ["*.contextio.json", "*-policy.json"],
      "url": "./schemas/redaction-policy.schema.json"
    }
  ]
}
```