"use client";

import { useEffect, useState, useRef } from "react";
import { usePathname } from "next/navigation";
import { apiClient } from "@/lib/api";

/**
 * Page Load Footer component
 * Measures and displays the TRUE page load time - from navigation start
 * to when this footer component mounts (which happens after all children
 * render, React hydration completes, data fetching finishes, and the page
 * is fully rendered and interactive).
 *
 * Show/hide is controlled by the `showPageLoadTime` setting.
 *
 * For client-side navigations in Next.js, we track route changes using usePathname
 * and record the navigation start time ourselves, since Navigation Timing API
 * doesn't capture soft navigations.
 */
export function PageLoadFooter() {
  const [loadTime, setLoadTime] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [showFooter, setShowFooter] = useState<boolean>(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const pathname = usePathname();

  // Store navigation start time for the current route
  // We use a ref so it persists across renders but doesn't trigger re-renders
  const navStartRef = useRef<number>(performance.now());

  // Fetch the showPageLoadTime setting on mount
  useEffect(() => {
    async function loadSetting() {
      try {
        const data = await apiClient.getSettings();
        if (data.settings && typeof data.settings.showPageLoadTime === "boolean") {
          setShowFooter(data.settings.showPageLoadTime);
        }
      } catch (error) {
        console.error("Failed to load page load time setting:", error);
        setShowFooter(false);
      } finally {
        setSettingsLoaded(true);
      }
    }
    loadSetting();
  }, []);

  // Reset navigation start time when route changes
  // This runs when pathname changes (client-side navigation)
  useEffect(() => {
    navStartRef.current = performance.now();
  }, [pathname]);

  // Measure load time when footer should be shown and settings are loaded
  useEffect(() => {
    if (!showFooter || !settingsLoaded) return;

    setIsVisible(true);

    // Calculate time since navigation started (either hard or soft navigation)
    // navStartRef.current was set either at initial load or at the last route change
    const loadTimeMs = performance.now() - navStartRef.current;
    setLoadTime(formatLoadTime(loadTimeMs));
  }, [showFooter, settingsLoaded]);

  if (!showFooter || !isVisible || loadTime === null) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-2 left-2 z-50 text-xs text-muted-foreground bg-background/80 backdrop-blur-sm px-2 py-1 rounded border"
      aria-label={`Page fully loaded in: ${loadTime}`}
      title="Time from navigation start to fully interactive page (hydration + data fetch + render complete)"
    >
      Page fully loaded in {loadTime}
    </div>
  );
}

function formatLoadTime(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}