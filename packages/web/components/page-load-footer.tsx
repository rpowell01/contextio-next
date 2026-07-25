"use client";

import { useEffect, useState } from "react";

/**
 * Page Load Footer component
 * Measures and displays page load time in the bottom-left corner.
 * Only shows in development mode or when explicitly enabled via NEXT_PUBLIC_CONTEXTIO_SHOW_LOAD_TIME env var.
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

    // Use Performance API to measure full page load time
    // Use PerformanceNavigationTiming (Navigation Timing Level 2) instead of deprecated performance.timing
    if (typeof window !== "undefined" && window.performance) {
      const entries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
      const entry = entries[0];

      if (entry) {
        // entry.loadEventEnd and entry.startTime are high-resolution timestamps
        const loadTimeMs = entry.loadEventEnd - entry.startTime;
        setLoadTime(formatLoadTime(loadTimeMs));
      } else {
        // Fallback: use performance.now()
        const loadTimeMs = performance.now();
        setLoadTime(formatLoadTime(loadTimeMs));
      }
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
      aria-label={`Page load time: ${loadTime}`}
    >
      Page loaded in {loadTime}
    </div>
  );
}

function formatLoadTime(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}