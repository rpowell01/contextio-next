"use client";

import { useState, useEffect, useCallback } from "react";

interface AdminAuthState {
  oidcEnabled: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  loading: boolean;
  userEmail?: string;
}

/**
 * Hook to check if the current user is an admin (authenticated via OIDC with email in ADMIN_EMAILS).
 * This should be used to protect admin-only pages when OIDC is enabled.
 */
export function useAdminAuth(): AdminAuthState {
  const [state, setState] = useState<AdminAuthState>({
    oidcEnabled: false,
    isAuthenticated: false,
    isAdmin: false,
    loading: true,
  });

  const checkAuth = useCallback(async () => {
    try {
      // First check if OIDC is enabled
      const providersRes = await fetch("/api/auth/providers");
      if (!providersRes.ok) {
        setState((prev) => ({ ...prev, oidcEnabled: false, loading: false }));
        return;
      }
      const providersData = await providersRes.json();
      const oidcEnabled = Array.isArray(providersData.providers) && providersData.providers.length > 0;

      if (!oidcEnabled) {
        setState((prev) => ({ ...prev, oidcEnabled: false, loading: false }));
        return;
      }

      // OIDC is enabled, check session
      const sessionRes = await fetch("/auth/session", { credentials: "include" });
      if (!sessionRes.ok) {
        setState((prev) => ({ ...prev, oidcEnabled: true, isAuthenticated: false, isAdmin: false, loading: false }));
        return;
      }
      const sessionData = await sessionRes.json();
      const isAuthenticated = sessionData.authenticated === true && !!sessionData.user?.email;

      if (!isAuthenticated) {
        setState((prev) => ({ ...prev, oidcEnabled: true, isAuthenticated: false, isAdmin: false, loading: false }));
        return;
      }

      // User is authenticated, check admin status
      const adminRes = await fetch("/api/auth/check-admin", { credentials: "include" });
      if (!adminRes.ok) {
        setState((prev) => ({ ...prev, oidcEnabled: true, isAuthenticated: true, isAdmin: false, userEmail: sessionData.user?.email, loading: false }));
        return;
      }
      const adminData = await adminRes.json();
      setState({
        oidcEnabled: true,
        isAuthenticated: true,
        isAdmin: adminData.isAdmin === true,
        userEmail: adminData.email,
        loading: false,
      });
    } catch (error) {
      console.error("Admin auth check failed:", error);
      setState((prev) => ({ ...prev, loading: false }));
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return state;
}

/**
 * Hook for protecting admin-only content. Returns an object with:
 * - showContent: boolean indicating if the protected content should be rendered
 * - showAccessDenied: boolean indicating if the access denied dialog should be shown
 * - authState: the full auth state for more granular control
 */
export function useAdminProtection() {
  const authState = useAdminAuth();
  const [showAccessDenied, setShowAccessDenied] = useState(false);

  // Determine if content should be shown
  const showContent = !authState.loading && (!authState.oidcEnabled || (authState.isAuthenticated && authState.isAdmin));
  
  // Show access denied dialog if OIDC is enabled but user is not admin
  useEffect(() => {
    if (!authState.loading && authState.oidcEnabled && (!authState.isAuthenticated || !authState.isAdmin)) {
      setShowAccessDenied(true);
    } else {
      setShowAccessDenied(false);
    }
  }, [authState.loading, authState.oidcEnabled, authState.isAuthenticated, authState.isAdmin]);

  return {
    showContent,
    showAccessDenied,
    authState,
    setShowAccessDenied,
  };
}