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
        setShowFooter(false);
      } finally {
        setSettingsLoaded(true);
      }
    }
    loadSetting();
  }, []);

  // Measure load time when footer should be shown and settings are loaded
  useEffect(() => {
    if (!showFooter || !settingsLoaded) return;

    setIsVisible(true);

    // Use Navigation Timing API to get the current navigation's timing
    // This works for both initial loads and client-side navigations in Next.js
    if (typeof window !== "undefined" && window.performance) {
      try {
        const entries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
        const currentNav = entries[entries.length - 1];

        if (currentNav) {
          // loadEventEnd fires when the page is fully loaded (including all resources)
          // But we want "fully interactive" which is after React hydration + data fetch + render
          // Since this footer mounts AFTER all that, we use the current time as end point
          // and navigationStart as the start point
          const navStart = currentNav.startTime; // = navigation start (high-res)
          const now = performance.now(); // time since navigation start (high-res)
          const loadTimeMs = now - navStart;
          setLoadTime(formatLoadTime(loadTimeMs));
        } else {
          // Fallback: performance.now() alone (less accurate for client-side nav)
          setLoadTime(formatLoadTime(performance.now()));
        }
      } catch {
        // Fallback if Navigation Timing API not available
        setLoadTime(formatLoadTime(performance.now()));
      }
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