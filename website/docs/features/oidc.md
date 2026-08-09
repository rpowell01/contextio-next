---
layout: doc
---

# OIDC Authentication (Feature)

Single Sign-On via any OpenID Connect provider.

## Architecture

```
User → ContextIO-Next → OIDC Provider → Callback → Session Cookie
```

Flow:
1. User accesses `/` → redirect to `/auth/signin`
2. Proxy builds auth URL with `state` + `nonce` → redirect to provider
3. User authenticates at provider
4. Provider redirects to `/api/auth/callback?code=...&state=...`
5. Proxy exchanges code for tokens, validates ID token
6. Session cookie set → redirect to `/`

## Supported Providers

| Provider | Issuer | Notes |
|----------|--------|-------|
| **Google** | `https://accounts.google.com` | Most tested |
| **Microsoft Entra ID** | `https://login.microsoftonline.com/{tenant}/v2.0` | Requires v2.0 endpoint |
| **Okta** | `https://{domain}.okta.com` | Standard OIDC |
| **Auth0** | `https://{domain}.auth0.com` | Standard OIDC |
| **Keycloak** | `https://{host}/realms/{realm}` | Check realm config |
| **Generic** | Any OIDC issuer | Must have `.well-known/openid-configuration` |

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `CONTEXTIO_OIDC_ENABLED` | Yes | `true` to enable |
| `CONTEXTIO_OIDC_ISSUER` | Yes | OIDC issuer URL |
| `CONTEXTIO_OIDC_CLIENT_ID` | Yes | OAuth2 client ID |
| `CONTEXTIO_OIDC_CLIENT_SECRET` | Yes | OAuth2 client secret (**secret**) |
| `CONTEXTIO_OIDC_SESSION_SECRET` | Yes | Cookie signing key, 32+ chars (**secret**) |
| `CONTEXTIO_OIDC_PUBLIC_URL` | Yes | Public callback URL |
| `CONTEXTIO_OIDC_SCOPE` | No | Scopes (default: `openid profile email`) |

## Session Management

- **Storage**: Encrypted cookies (not server-side sessions)
- **Signing**: `CONTEXTIO_OIDC_SESSION_SECRET` (HS256)
- **Cookie options**:
  - `HttpOnly: true`
  - `Secure: true` (HTTPS required in production)
  - `SameSite: 'lax'`
  - `MaxAge: 24 hours` (or token expiry)

## Secrets Handling

**Never in settings file:**
```env
# ✓ Environment variables (or Docker secrets)
CONTEXTIO_OIDC_CLIENT_SECRET=...
CONTEXTIO_OIDC_SESSION_SECRET=...

# ✗ Never in web UI settings
# Settings → Security → OIDC (client secret not stored here)
```

## User Info

On successful auth, user info available in templates/context:
```json
{
  "sub": "user-id",
  "email": "user@example.com",
  "name": "User Name",
  "picture": "https://...",
  "email_verified": true,
  "hd": "example.com"  // Google: hosted domain
}
```

## Role-Based Access (Optional)

Map OIDC claims to roles via `settings.json`:
```json
{
  "oidc": {
    "roles": {
      "admin": { "claims": { "hd": "mycompany.com" } },
      "user": { "claims": { "email_verified": true } }
    }
  }
}
```
*Currently: authentication only, authorization via proxy config*

## Multi-Provider

Only **one** OIDC provider at a time. For multiple:
- Use a provider that supports identity federation (Auth0, Keycloak)
- Or deploy multiple ContextIO instances behind a reverse proxy

## Logout

```bash
# Global logout
GET /api/auth/signout

# Provider logout (if supported)
GET /api/auth/signout?provider=true
# Redirects to provider's end-session endpoint
```

## Web UI Integration

- **Sign In** button in header (when not authenticated)
- **User avatar** + dropdown with Sign Out (when authenticated)
- **Settings → Security** tab shows OIDC status

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `redirect_uri_mismatch` | Callback URL mismatch | Exact match: `CONTEXTIO_OIDC_PUBLIC_URL` + `/api/auth/callback` |
| `invalid_client` | Bad credentials | Check `CLIENT_ID` / `CLIENT_SECRET` |
| `state_mismatch` | CSRF/cookie issue | Same `SESSION_SECRET`, HTTPS, correct domain |
| `nonce_failed` | Replay attack detected | Normal on retry — user should re-initiate |
| `issuer_not_found` | Wrong issuer URL | Verify `.well-known/openid-configuration` accessible |

## Debug Mode

```bash
LOG_LEVEL=debug
```

Log output:
```
[OIDC] Initiating auth: issuer=google.com, state=abc123
[OIDC] Callback received: code=xyz, state=abc123
[OIDC] Token exchange successful: sub=user123
[OIDC] Session cookie set for user123
```

## Legacy Variables

Deprecated but supported (all 5 required):
```env
OIDC_ENABLED=true
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
OIDC_SCOPE=openid profile email
```