"use client";

import { useEffect, useState } from "react";

/**
 * Page Load Footer component
 * Measures and displays the TRUE page load time - from navigation start
 * to when this footer component mounts (which happens after all children
 * render, React hydration completes, data fetching finishes, and the page
 * is fully rendered and interactive).
 *
 * Only shows in development mode or when explicitly enabled via
 * NEXT_PUBLIC_CONTEXTIO_SHOW_LOAD_TIME env var.
 */
export function PageLoadFooter() {
  const [loadTime, setLoadTime] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  // Check if we should display the load time at component level
  // This avoids mounting the effect and state when disabled
  const isDev = process.env.NODE_ENV === "development";
  const isEnabled = process.env.NEXT_PUBLIC_CONTEXTIO_SHOW_LOAD_TIME === "true";

  if (!isDev && !isEnabled) {
    return null;
  }

  useEffect(() => {
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
  }, []);

  if (!isVisible || loadTime === null) {
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