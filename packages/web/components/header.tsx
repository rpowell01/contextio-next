"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { getNavigationItems, NavigationConfig } from "@/lib/nav-config";

interface UserInfo {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

export interface HeaderProps {
  navigationConfig?: NavigationConfig;
}

export function Header({ navigationConfig }: HeaderProps) {
  const pathname = usePathname();
  const navigation = getNavigationItems(navigationConfig);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [showMenu, setShowMenu] = useState(false);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Fetch OIDC configuration on mount
  async function fetchOidcConfig() {
    try {
      const response = await fetch("/api/auth/providers");
      console.log("[Header] fetchOidcConfig: providers response status:", response.status);
      if (response.ok) {
        const data = await response.json();
        console.log("[Header] fetchOidcConfig: providers response data:", JSON.stringify(data, null, 2));
        // API returns { providers: [...], service: "..." } directly (no success/data wrapper)
        const hasProviders = Array.isArray(data.providers) && data.providers.length > 0;
        console.log("[Header] fetchOidcConfig: setting oidcEnabled to:", hasProviders);
        setOidcEnabled(hasProviders);
      }
    } catch (error) {
      console.debug("OIDC config fetch failed:", error);
    }
  }

  // Fetch user session on mount (only if OIDC is enabled)
  async function fetchSession() {
    console.log("[Header] fetchSession called, oidcEnabled:", oidcEnabled);
    if (!oidcEnabled) {
      console.log("[Header] fetchSession: oidcEnabled is false, returning early");
      setLoading(false);
      return;
    }
    try {
      // Using the proxy's /auth/session endpoint via the combined server
      console.log("[Header] fetchSession: fetching /auth/session with credentials: include");
      const response = await fetch("/auth/session", {
        credentials: "include", // Include cookies
      });
      console.log("[Header] fetchSession: /auth/session response status:", response.status);
      if (response.ok) {
        const data = await response.json();
        console.log("[Header] fetchSession: session data:", JSON.stringify(data, null, 2));
        if (data.authenticated && data.user) {
          console.log("[Header] fetchSession: setting user:", data.user);
          setUser(data.user);
        } else {
          console.log("[Header] fetchSession: not authenticated or no user");
        }
      }
    } catch (error) {
      console.debug("Session fetch failed:", error);
    } finally {
      setLoading(false);
    }
  }

  // Fetch admin status when user changes
  useEffect(() => {
    fetchAdminStatus();
  }, [user]);

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
      setUser(null);
      setIsAdmin(false);
      // Redirect to proxy's /auth/logout which will clear proxy session
      // and redirect to OIDC provider logout, then to /auth/logged-out
      window.location.href = "/auth/logout?redirect=" + encodeURIComponent("/auth/logged-out");
    } catch (error) {
      console.error("Logout failed:", error);
    }
    setShowMenu(false);
  }

  // Fetch admin status when user is authenticated
  async function fetchAdminStatus() {
    if (!user) {
      setIsAdmin(false);
      return;
    }
    try {
      const response = await fetch("/api/auth/check-admin", {
        credentials: "include",
      });
      if (response.ok) {
        const data = await response.json();
        setIsAdmin(data.isAdmin === true);
      } else {
        // Non-ok response (403, 401, 500, etc.) - user is not admin
        setIsAdmin(false);
      }
    } catch (error) {
      console.debug("Admin status fetch failed:", error);
      setIsAdmin(false);
    }
  }

  // Fetch OIDC config first, then session
  useEffect(() => {
    console.log("[Header] useEffect triggered, pathname:", pathname);
    fetchOidcConfig().then(() => {
      console.log("[Header] fetchOidcConfig resolved, calling fetchSession");
      fetchSession();
    });
  }, [pathname]);

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      {/* Debug: log render state */}
      {(() => { console.log("[Header] render:", { oidcEnabled, loading, user, isAdmin, showMenu }); return null; })()}
      <div className="container flex h-14 items-center justify-between">
        <div className="flex items-center gap-2">
          <img
            src="/ContextIO-Next-32x32.png"
            alt="ContextIO-Next logo"
            className="h-8 w-8"
          />
          <span className="font-bold">ContextIO-Next</span>
        </div>
        <nav className="flex items-center space-x-2">
          {/* Navigation items */}
          {navigation.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                {item.icon}
                <span>{item.name}</span>
              </Link>
            );
          })}

          {/* Auth section - only show if OIDC is enabled */}
          {oidcEnabled && (
            <>
              {loading ? (
                <div className="flex h-8 w-20 animate-pulse items-center justify-center rounded-md bg-muted" />
              ) : user ? (
                <div className="relative">
                  <button
                    onClick={() => setShowMenu(!showMenu)}
                    className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                    aria-expanded={showMenu}
                    aria-haspopup="true"
                  >
                    {user.picture ? (
                      <img
                        src={user.picture}
                        alt=""
                        className="h-6 w-6 rounded-full"
                      />
                    ) : (
                      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
                        {user.name?.[0] || user.email?.[0] || "U"}
                      </div>
                    )}
                    <span className="hidden sm:block flex items-center gap-1.5">
                      {user.name || user.email || "User"}
                      {isAdmin && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-900 dark:text-green-200">
                          <svg className="h-2.5 w-2.5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3 3a.75.75 0 001.06 1.061l1.72-1.72 1.72 1.72a.75.75 0 101.06-1.06l-3-3z" clipRule="evenodd" />
                          </svg>
                          Admin
                        </span>
                      )}
                    </span>
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {showMenu && (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => setShowMenu(false)}
                        aria-hidden="true"
                      />
                      <div className="absolute right-0 z-50 mt-2 w-56 origin-top-right rounded-md bg-popover border shadow-lg focus:outline-none animate-in fade-in-0 zoom-in-95">
                        <div className="px-4 py-3 border-b">
                          {user.picture ? (
                            <img src={user.picture} alt="" className="h-8 w-8 rounded-full" />
                          ) : (
                            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-medium">
                              {user.name?.[0] || user.email?.[0] || "U"}
                            </div>
                          )}
                          <p className="mt-1 text-sm font-medium">{user.name || "User"}</p>
                          <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                          {isAdmin && (
                            <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900 dark:text-green-200">
                              <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3 3a.75.75 0 001.06 1.061l1.72-1.72 1.72 1.72a.75.75 0 101.06-1.06l-3-3z" clipRule="evenodd" />
                              </svg>
                              Admin
                            </span>
                          )}
                        </div>
                        <button
                          onClick={handleLogout}
                          className="flex w-full items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-accent hover:text-red-600"
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                          </svg>
                          <span>Sign out</span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <a
                  href="/auth/login"
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  Sign in
                </a>
              )}
            </>
          )}
        </nav>
      </div>
    </header>
  );
}