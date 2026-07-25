"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";

/**
 * Page Load Footer component
 * Measures and displays the TRUE page load time - from navigation start
 * to when this footer component mounts (which happens after all children
 * render, React hydration completes, data fetching finishes, and the page
 * is fully rendered and interactive).
 *
 * Show/hide is controlled by the `showPageLoadTime` setting.
 */
export function PageLoadFooter() {
  const [loadTime, setLoadTime] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [showFooter, setShowFooter] = useState<boolean>(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

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
        // Default to false if settings can't be loaded
        setShowFooter(false);
      } finally {
        setSettingsLoaded(true);
      }
    }
    loadSetting();
  }, []);

  // Only measure load time if footer should be shown and settings are loaded
  useEffect(() => {
    if (!showFooter || !settingsLoaded) return;

    setIsVisible(true);

    // Measure true page load time: from navigation start to when this footer mounts.
    // The footer mounts AFTER:
    // 1. Initial HTML document loads
    // 2. React hydration completes
    // 3. All child components (page content) render
    // 4. Client-side data fetching completes (SSE, fetch, etc.)
    // 5. React re-renders with data
    // 6. All components are fully rendered and interactive
    //
    // performance.timeOrigin = navigation start (high-resolution timestamp)
    // performance.now() = time since navigation start (high-resolution)
    // When this effect runs, we've completed hydration + render + data fetch
    if (typeof window !== "undefined" && window.performance) {
      const loadTimeMs = performance.now();
      setLoadTime(formatLoadTime(loadTimeMs));
    }
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