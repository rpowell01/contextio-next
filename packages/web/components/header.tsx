"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { getNavigationItems, NavigationConfig } from "@/lib/nav-config";
import { getSession, clearSession } from "@/lib/auth/session";

interface UserInfo {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

interface HeaderProps {
  navigationConfig?: NavigationConfig;
}

export function Header({ navigationConfig }: HeaderProps) {
  const pathname = usePathname();
  const router = useRouter();
  const navigation = getNavigationItems(navigationConfig);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [showMenu, setShowMenu] = useState(false);

  // Fetch user session on mount
  // In a real app, this would be done server-side or via an API route
  // For now, we'll use a client-side fetch to /api/auth/session
  async function fetchSession() {
    try {
      // Using the proxy's /auth/session endpoint via the combined server
      const response = await fetch("/auth/session", {
        credentials: "include", // Include cookies
      });
      if (response.ok) {
        const data = await response.json();
        if (data.authenticated && data.user) {
          setUser(data.user);
        }
      }
    } catch (error) {
      console.debug("Session fetch failed:", error);
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
      setUser(null);
      router.push("/auth/login");
      router.refresh();
    } catch (error) {
      console.error("Logout failed:", error);
    }
    setShowMenu(false);
  }

  // Fetch session on mount and when pathname changes (e.g., after login redirect)
  useEffect(() => {
    fetchSession();
  }, [pathname]);

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-label="ContextIO-Next logo">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12H3m12 0l-3 3m3-3l-3-3" />
            </svg>
          </div>
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

          {/* Auth section */}
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
                <span className="hidden sm:block">{user.name || user.email || "User"}</span>
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
            <Link
              href="/auth/login"
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}