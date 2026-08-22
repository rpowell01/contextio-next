import { NextResponse } from "next/server";
import { getSettings, isDbInitialized } from "@contextio/core/db";
import { createSuccessResponse } from "@contextio/core";

export async function GET(): Promise<NextResponse> {
  // Check if OIDC is enabled via environment variable or database settings
  console.log("[providers] DB initialized:", isDbInitialized());
  console.log("[providers] CONTEXTIO_OIDC_ENABLED env:", process.env.CONTEXTIO_OIDC_ENABLED);
  console.log("[providers] CONTEXTIO_OIDC_ISSUER env:", process.env.CONTEXTIO_OIDC_ISSUER ? "SET" : "NOT SET");
  console.log("[providers] CONTEXTIO_OIDC_PUBLIC_URL env:", process.env.CONTEXTIO_OIDC_PUBLIC_URL);
  
  const settings = getSettings();
  console.log("[providers] DB settings:", JSON.stringify(settings, null, 2));
  
  const oidcEnabled = process.env.CONTEXTIO_OIDC_ENABLED === "true" || settings?.oidcEnabled;
  const oidcPublicUrl = process.env.CONTEXTIO_OIDC_PUBLIC_URL || settings?.oidcPublicUrl || "";
  const issuer = process.env.CONTEXTIO_OIDC_ISSUER || settings?.oidcIssuer || "";

  console.log("[providers] oidcEnabled:", oidcEnabled, "issuer:", issuer ? "SET" : "EMPTY");

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
      publicUrl: oidcPublicUrl,
    },
  ];

  return NextResponse.json(createSuccessResponse({ providers }));
}