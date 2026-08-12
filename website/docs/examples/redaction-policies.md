---
layout: doc
---

# Redaction Policy Examples

Practical examples for common redaction scenarios.

## 1. Secrets Only (No PII)

```jsonc
{
  "extends": "secrets"
}
```

Redacts: API keys, tokens, private keys, AWS credentials, generic secrets.
Leaves: emails, phone numbers, names, SSNs.

## 2. PII with Company-Specific Rules

```jsonc
{
  "extends": "pii",
  "rules": [
    { "id": "employee-id", "pattern": "EMP-\\d{5,}", "replacement": "[EMPLOYEE_ID]" },
    { "id": "project-code", "pattern": "PRJ-[A-Z]{3}-\\d{4}", "replacement": "[PROJECT_CODE]" },
    { "id": "internal-host", "pattern": "\\b(internal|corp|prod|staging)\\.example\\.com\\b", "replacement": "[INTERNAL_HOST]" }
  ],
  "allowlist": {
    "strings": ["support@mycompany.com", "security@mycompany.com"],
    "patterns": ["test-\\d+@example\\.com", "ci-.*@mycompany\\.com"]
  }
}
```

## 3. Strict + Healthcare

```jsonc
{
  "extends": "strict",
  "rules": [
    { "id": "mrn", "pattern": "\\bMRN[-\\s]?\\d{6,}\\b", "replacement": "[MRN]" },
    { "id": "npi", "pattern": "\\b\\d{10}\\b", "replacement": "[NPI]", "context": ["npi", "provider"] },
    { "id": "dei", "pattern": "\\bDEA[-\\s]?[A-Z]{2}\\d{7}\\b", "replacement": "[DEA]" }
  ],
  "paths": {
    "only": ["messages[*].content", "system"],
    "skip": ["model", "max_tokens", "temperature"]
  }
}
```

## 4. Financial Services

```jsonc
{
  "extends": "strict",
  "rules": [
    { "id": "swift", "pattern": "\\b[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?\\b", "replacement": "[SWIFT]" },
    { "id": "iban", "pattern": "\\b[A-Z]{2}\\d{2}[A-Z0-9]{4}\\d{7}([A-Z0-9]?){0,16}\\b", "replacement": "[IBAN]" },
    { "id": "routing", "pattern": "\\b\\d{9}\\b", "replacement": "[ROUTING]", "context": ["routing", "aba", "transit"] },
    { "id": "account", "pattern": "\\b\\d{10,17}\\b", "replacement": "[ACCOUNT]", "context": ["account", "acct"] }
  ],
  "allowlist": {
    "patterns": ["^4111\\d{12}$", "^5555\\d{12}$"]  // Test card numbers
  }
}
```

## 5. Code/Technical Content

```jsonc
{
  "extends": "secrets",
  "rules": [
    { "id": "aws-key", "pattern": "AKIA[0-9A-Z]{16}", "replacement": "[AWS_ACCESS_KEY]" },
    { "id": "aws-secret", "pattern": "[A-Za-z0-9/+=]{40}", "replacement": "[AWS_SECRET_KEY]", "context": ["aws", "secret", "key"] },
    { "id": "github-token", "pattern": "gh[pousr]_[A-Za-z0-9]{36}", "replacement": "[GITHUB_TOKEN]" },
    { "id": "gitlab-token", "pattern": "glpat-[A-Za-z0-9\\-_]{20}", "replacement": "[GITLAB_TOKEN]" },
    { "id": "docker-token", "pattern": "dckr_pat_[A-Za-z0-9]{32}", "replacement": "[DOCKER_TOKEN]" },
    { "id": "k8s-token", "pattern": "k8s-[A-Za-z0-9\\-_]{24}", "replacement": "[K8S_TOKEN]" },
    { "id": "jwt", "pattern": "eyJ[A-Za-z0-9\\-_=]+\\.eyJ[A-Za-z0-9\\-_=]+\\.[A-Za-z0-9\\-_=]+", "replacement": "[JWT]" }
  ],
  "paths": {
    "skip": ["model", "temperature", "max_tokens", "top_p"]
  }
}
```

## 6. Minimal - Only Explicit Markers

```jsonc
{
  "rules": [
    { "id": "email-marker", "pattern": "\\[EMAIL_REDACTED\\]", "replacement": "[EMAIL]" },
    { "id": "ssn-marker", "pattern": "\\[SSN_REDACTED\\]", "replacement": "[SSN]" },
    { "id": "key-marker", "pattern": "\\[API_KEY_REDACTED\\]", "replacement": "[API_KEY]" }
  ]
}
```

## 7. Path-Scoped (Message Content Only)

```jsonc
{
  "extends": "pii",
  "paths": {
    "only": ["messages[*].content", "system"],
    "skip": [
      "model",
      "max_tokens",
      "temperature",
      "top_p",
      "stop",
      "stream",
      "metadata",
      "tools",
      "tool_choice"
    ]
  }
}
```

## 8. Reversible Mode Policy

```jsonc
{
  "extends": "pii",
  "reversible": true,
  "rules": [
    { "id": "customer-id", "pattern": "CUST-\\d{8}", "replacement": "[CUSTOMER_ID]" }
  ]
}
```

### With Reversible Mode
```bash
REDACT_REVERSIBLE=true
REDACT_POLICY_FILE=/app/custom-policy/reversible-policy.jsonc
```

## 9. Context-Gated Rules

```jsonc
{
  "extends": "secrets",
  "rules": [
    {
      "id": "generic-id",
      "pattern": "\\b[A-Z]{3}-\\d{6}\\b",
      "replacement": "[REF_ID]",
      "context": ["ref", "reference", "ticket", "issue", "id"],
      "contextWindow": 100
    },
    {
      "id": "version",
      "pattern": "\\bv\\d+\\.\\d+\\.\\d+\\b",
      "replacement": "[VERSION]",
      "context": ["version", "release", "deploy"]
    }
  ]
}
```

## Testing Policies

```bash
# Quick syntax check
node -e "
const policy = require('./my-policy.jsonc');
console.log('Valid:', JSON.stringify(policy, null, 2));
"

# Test with proxy
ctxio proxy --redact-policy ./my-policy.jsonc --verbose

# In another terminal
curl -X POST http://localhost:4040/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"My EMP-12345 and email@company.com"}]}'
```

## Common Patterns Reference

| Pattern | Regex (JSON-escaped) |
|---------|---------------------|
| Email | `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}` |
| US Phone | `\\(?\\d{3}\\)?[-.\\s]?\\d{3}[-.\\s]?\\d{4}` |
| SSN | `\\d{3}-\\d{2}-\\d{4}` |
| Credit Card | `\\b\\d{4}[-.\\s]?\\d{4}[-.\\s]?\\d{4}[-.\\s]?\\d{4}\\b` |
| IPv4 | `\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b` |
| UUID | `\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b` |
| AWS Key | `AKIA[0-9A-Z]{16}` |
| GitHub Token | `gh[pousr]_[A-Za-z0-9]{36}` |