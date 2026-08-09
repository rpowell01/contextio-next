---
layout: doc
---

# OIDC Authentication

Optional Single Sign-On via any OIDC provider (Google, Microsoft, Okta, Auth0, Keycloak, etc.).

## Quick Setup (Google Example)

### 1. Create OAuth2 Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project or select existing
3. **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**
4. Application type: **Web application**
5. Authorized redirect URIs: `https://your-domain.com/api/auth/callback`
6. Save and copy **Client ID** and **Client Secret**

### 2. Configure Environment Variables

```env
CONTEXTIO_OIDC_ENABLED=true
CONTEXTIO_OIDC_ISSUER=https://accounts.google.com
CONTEXTIO_OIDC_CLIENT_ID=your-client-id.apps.googleusercontent.com
CONTEXTIO_OIDC_CLIENT_SECRET=GOCSPX-your-client-secret
CONTEXTIO_OIDC_SESSION_SECRET=your-32-char-session-secret
CONTEXTIO_OIDC_PUBLIC_URL=https://your-domain.com
CONTEXTIO_OIDC_SCOPE=openid profile email
```

Generate session secret:
```bash
openssl rand -base64 32
```

### 3. Deploy and Test

1. Deploy with the environment variables
2. Visit `https://your-domain.com`
3. Click **Sign In** — you'll be redirected to Google
4. After consent, you're redirected back and signed in

## Supported Providers

| Provider | Issuer URL |
|----------|------------|
| Google | `https://accounts.google.com` |
| Microsoft Entra ID | `https://login.microsoftonline.com/{tenant-id}/v2.0` |
| Okta | `https://{your-domain}.okta.com` |
| Auth0 | `https://{your-domain}.auth0.com` |
| Keycloak | `https://{keycloak-host}/realms/{realm}` |
| Generic OIDC | Your provider's issuer URL |

## Required Variables

| Variable | Description |
|----------|-------------|
| `CONTEXTIO_OIDC_ENABLED` | Set to `true` to enable |
| `CONTEXTIO_OIDC_ISSUER` | OIDC issuer URL (must have `.well-known/openid-configuration`) |
| `CONTEXTIO_OIDC_CLIENT_ID` | OAuth2 client ID |
| `CONTEXTIO_OIDC_CLIENT_SECRET` | OAuth2 client secret (**secret**) |
| `CONTEXTIO_OIDC_SESSION_SECRET` | Session cookie signing secret, min 32 chars (**secret**) |
| `CONTEXTIO_OIDC_PUBLIC_URL` | Public callback URL (e.g., `https://contextio.example.com`) |
| `CONTEXTIO_OIDC_SCOPE` | Space-separated scopes (default: `openid profile email`) |

## Secrets Must Be in Environment

**Never** put these in the web UI settings file:
- `CONTEXTIO_OIDC_CLIENT_SECRET`
- `CONTEXTIO_OIDC_SESSION_SECRET`

Use Docker secrets or Kubernetes secrets in production.

## Legacy Variables (Deprecated)

These still work but require **all 5** to be set together:
```env
OIDC_ENABLED=true
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
OIDC_SCOPE=openid profile email
```

**Prefer** the `CONTEXTIO_OIDC_*` variables.

## How It Works

1. User visits `/` → redirected to `/auth/signin`
2. Proxy initiates OIDC flow → redirects to provider
3. User authenticates at provider
4. Provider redirects to `/api/auth/callback` with authorization code
4. Proxy exchanges code for tokens, validates ID token
5. Session cookie set → user redirected to `/`

## Session Management

- Sessions stored in encrypted cookies (signed with `CONTEXTIO_OIDC_SESSION_SECRET`)
- Cookie options: `HttpOnly`, `Secure` (HTTPS), `SameSite: 'lax'`
- Session expires per provider's token lifetime or 24 hours

## Logout

Visit `/api/auth/signout` to clear session and redirect to provider logout (if supported).

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `redirect_uri_mismatch` | Ensure `CONTEXTIO_OIDC_PUBLIC_URL` matches exactly (including trailing slash) |
| `invalid_client` | Check `CLIENT_ID` and `CLIENT_SECRET` are correct |
| `CSRF mismatch` | Ensure `CONTEXTIO_OIDC_SESSION_SECRET` is set and matches |
| Infinite redirect loop | Check `NEXT_PUBLIC_SITE_URL` matches `CONTEXTIO_OIDC_PUBLIC_URL` |
| Provider not found | Verify issuer URL has `.well-known/openid-configuration` accessible |

## Microsoft Entra ID Specific

For Microsoft, use the v2.0 endpoint:
```env
CONTEXTIO_OIDC_ISSUER=https://login.microsoftonline.com/{tenant-id}/v2.0
CONTEXTIO_OIDC_SCOPE=openid profile email User.Read
```

## Keycloak Specific

Ensure your realm has:
- **Valid Redirect URIs**: `https://your-domain.com/api/auth/callback`
- **Web Origins**: `https://your-domain.com`
- **Client Authentication**: On
- **Standard Flow**: On