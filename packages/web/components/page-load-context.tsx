"use client";

import { createContext, useContext, useState, useCallback, ReactNode } from "react";

interface PageLoadContextType {
  /** Register that a page has started loading (e.g., beginning data fetch) */
  registerPageLoad: () => void;
  /** Register that a page has finished loading (all data fetched, UI ready) */
  registerPageReady: () => void;
  /** Current loading state - true if any registered page is still loading */
  isPageLoading: boolean;
}

/** Context for tracking page load completion across components */
const PageLoadContext = createContext<PageLoadContextType | null>(null);

/**
 * Provider that tracks page load state.
 * Pages call registerPageLoad() when starting async work,
 * and registerPageReady() when fully loaded.
 * The footer waits for isPageLoading to become false.
 */
export function PageLoadProvider({ children }: { children: ReactNode }) {
  const [loadingCount, setLoadingCount] = useState(0);

  const registerPageLoad = useCallback(() => {
    setLoadingCount((prev) => prev + 1);
  }, []);

  const registerPageReady = useCallback(() => {
    setLoadingCount((prev) => Math.max(0, prev - 1));
  }, []);

  const isPageLoading = loadingCount > 0;

  return (
    <PageLoadContext.Provider value={{ registerPageLoad, registerPageReady, isPageLoading }}>
      {children}
    </PageLoadContext.Provider>
  );
}

/**
 * Hook for pages/components to signal loading state.
 * Call registerPageLoad() when starting async operations.
 * Call registerPageReady() when all async operations complete.
 */
export function usePageLoad() {
  const context = useContext(PageLoadContext);
  if (!context) {
    throw new Error("usePageLoad must be used within a PageLoadProvider");
  }
  return context;
}

/**
 * Hook for components that want to wait until the page is fully loaded.
 * Returns true while page is still loading, false when ready.
 */
export function usePageLoadWait() {
  const { isPageLoading } = useContext(PageLoadContext) ?? { isPageLoading: false };
  return isPageLoading;
}