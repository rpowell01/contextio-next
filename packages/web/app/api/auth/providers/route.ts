import { NextResponse } from "next/server";
import { getSettings } from "@contextio/core/db";
import { createSuccessResponse } from "@contextio/core";

export async function GET(): Promise<NextResponse> {
  // Check if OIDC is enabled via environment variable or database settings
  const settings = getSettings();
  const oidcEnabled = process.env.CONTEXTIO_OIDC_ENABLED === "true" || settings?.oidcEnabled;
  const issuer = process.env.CONTEXTIO_OIDC_ISSUER;

  if (!oidcEnabled || !issuer) {
    return NextResponse.json(createSuccessResponse({ providers: [] }));
  }

  // Single provider configuration - authUrl points to proxy's auth handler
  // The redirect will be handled by the proxy's handleLogin which sets the redirect cookie
  const providers = [
    {
      id: "oidc",
      name: "OpenID Connect",
      authUrl: `/login?redirect=`,
    },
  ];

  return NextResponse.json(createSuccessResponse({ providers }));
}