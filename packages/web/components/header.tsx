"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { getNavigationItems, NavigationConfig } from "@/lib/nav-config";

export interface HeaderProps {
  /**
   * Optional navigation configuration to override default navigation items.
   * Set enabled: false on individual items to hide them.
   */
  navigationConfig?: NavigationConfig;
}

export function Header({ navigationConfig }: HeaderProps) {
  const pathname = usePathname();
  const navigation = getNavigationItems(navigationConfig);

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" role="img" aria-label="ContextIO-Next logo">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12H3m12 0l-3 3m3-3l-3-3" />
            </svg>
          </div>
          <span className="font-bold">ContextIO-Next</span>
        </div>
        <nav className="flex items-center space-x-2">
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
        </nav>
      </div>
    </header>
  );
}