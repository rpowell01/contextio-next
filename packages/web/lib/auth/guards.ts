/**
 * Authentication guards for Next.js API routes.
 *
 * Provides Higher-Order Function (HOF) wrappers to protect API routes
 * with OIDC session authentication.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getSession, type AuthSession } from "./session";

/** Options for auth guards. */
export interface AuthGuardOptions {
  /** Custom redirect URL for unauthenticated requests (default: /login). */
  loginUrl?: string;
  /** Whether to return 401 JSON instead of redirecting (default: false for API routes). */
  returnJson?: boolean;
  /** Custom error message for unauthenticated requests. */
  errorMessage?: string;
}

/**
 * Extract the params type from a handler's context parameter.
 */
type ExtractParams<T> = T extends (
  request: NextRequest,
  context: { params: infer P }
) => any
  ? P
  : never;

/**
 * Higher-Order Function that wraps an API route handler with required authentication.
 *
 * If the user is not authenticated, returns 401 Unauthorized (JSON) by default
 * or redirects to login URL if configured.
 *
 * @param handler - The API route handler to protect
 * @param options - Configuration options
 * @returns Wrapped handler that validates session before calling the original handler
 *
 * @example
 * ```typescript
 * export const GET = withAuth(async (request, { params, session }) => {
 *   // session is guaranteed to be valid here
 *   return Response.json({ user: session.email });
 * });
 * ```
 */
export function withAuth<
  T extends (request: NextRequest, context: { params: any; session: AuthSession }) => Promise<Response>
>(
  handler: T,
  options: AuthGuardOptions = {}
): (request: NextRequest, context: { params: ExtractParams<T> }) => Promise<Response> {
  const { loginUrl = "/login", returnJson = true, errorMessage = "Unauthorized" } = options;

  return async (request: NextRequest, context: { params: ExtractParams<T> }) => {
    const session = await getSession();

    if (!session) {
      if (returnJson) {
        return NextResponse.json(
          { error: errorMessage, loginUrl },
          { status: 401 }
        );
      }
      // Redirect to login with current URL as redirect parameter
      const redirectUrl = new URL(loginUrl, request.url);
      redirectUrl.searchParams.set("redirect", request.nextUrl.pathname + request.nextUrl.search);
      return NextResponse.redirect(redirectUrl);
    }

    // Attach session to context for the handler
    return handler(request, { ...context, session });
  };
}

/**
 * Higher-Order Function that wraps an API route handler with optional authentication.
 *
 * The handler receives the session (or null if not authenticated), allowing
 * different behavior based on auth state.
 *
 * @param handler - The API route handler to wrap
 * @returns Wrapped handler that provides session if available
 *
 * @example
 * ```typescript
 * export const GET = withOptionalAuth(async (request, { params, session }) => {
 *   if (session) {
 *     return Response.json({ user: session.email, admin: true });
 *   }
 *   return Response.json({ public: true });
 * });
 * ```
 */
export function withOptionalAuth<
  T extends (request: NextRequest, context: { params: any; session: AuthSession | null }) => Promise<Response>
>(
  handler: T
): (request: NextRequest, context: { params: ExtractParams<T> }) => Promise<Response> {
  return async (request: NextRequest, context: { params: ExtractParams<T> }) => {
    const session = await getSession();

    return handler(request, { ...context, session });
  };
}

/**
 * Type helper to extract the context from a handler wrapped with withAuth.
 */
export type WithAuthContext<TParams extends Record<string, string> = Record<string, string>> = {
  params: Promise<TParams>;
  session: AuthSession;
};

/**
 * Type helper to extract the context from a handler wrapped with withOptionalAuth.
 */
export type WithOptionalAuthContext<TParams extends Record<string, string> = Record<string, string>> = {
  params: Promise<TParams>;
  session: AuthSession | null;
};