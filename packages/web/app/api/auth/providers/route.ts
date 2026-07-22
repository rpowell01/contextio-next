import { NextResponse } from "next/server";

export async function GET(): Promise<NextResponse> {
  // Check if OIDC is enabled via environment variable
  const oidcEnabled = process.env.CONTEXTIO_OIDC_ENABLED === "true";
  const issuer = process.env.CONTEXTIO_OIDC_ISSUER;

  if (!oidcEnabled || !issuer) {
    return NextResponse.json({ providers: [] });
  }

  // Single provider configuration - authUrl points to proxy's auth handler
  // The redirect will be handled by the proxy's handleLogin which sets the redirect cookie
  const providers = [
    {
      id: "oidc",
      name: "OpenID Connect",
      authUrl: `/auth/login?redirect=`,
    },
  ];

  return NextResponse.json({ providers });
}