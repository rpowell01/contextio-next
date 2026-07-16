"use client";

import { createContext, useContext, useEffect, useState, ReactNode, useCallback, useRef } from "react";
import { apiClient } from "@/lib/api";
import type { Settings } from "@/lib/settings";

type Theme = "light" | "dark" | "system" | "high-contrast";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => Promise<void>;
  resolvedTheme: "light" | "dark" | "high-contrast";
  mounted: boolean;
  isOverridden: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

interface ThemeProviderProps {
  children: ReactNode;
  // Optional: server-resolved theme (from SSR) to prevent flash
  initialTheme?: Theme;
}

export function ThemeProvider({
  children,
  initialTheme = "system",
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark" | "high-contrast">("light");
  const [mounted, setMounted] = useState(false);
  const [isOverridden, setIsOverridden] = useState(false);
  const settingsRef = useRef<Settings | null>(null);
  const isLoadingRef = useRef(false);
  const mountedRef = useRef(true);

  // Resolve theme based on system preference
  const resolveTheme = useCallback((t: Theme): "light" | "dark" | "high-contrast" => {
    if (t === "system") {
      if (typeof window !== "undefined" && window.matchMedia) {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      return "light";
    }
    if (t === "high-contrast") {
      return "high-contrast";
    }
    return t;
  }, []);

  // Apply theme to document
  const applyTheme = useCallback((t: Theme) => {
    const resolved = resolveTheme(t);
    setResolvedTheme(resolved);
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", resolved);
    }
  }, [resolveTheme]);

  // Initialize theme from settings API
  useEffect(() => {
    mountedRef.current = true;

    async function loadTheme() {
      if (isLoadingRef.current) return;
      isLoadingRef.current = true;

      try {
        const response = await apiClient.getSettings();
        if (!mountedRef.current) return;
        if (response.settings) {
          const settings = response.settings as Settings;
          const metadata = response.metadata as Record<keyof Settings, { source: string; dynamic: boolean }> | undefined;

          settingsRef.current = settings;
          setThemeState(settings.theme);
          applyTheme(settings.theme);

          // Check if theme is overridden by environment variable
          const themeMeta = metadata?.theme;
          setIsOverridden(themeMeta?.source === "environment-variable");
        }
      } catch (error) {
        console.error("Failed to load theme from settings:", error);
        // Fallback to system theme
        if (mountedRef.current) {
          applyTheme("system");
        }
      } finally {
        if (mountedRef.current) {
          setMounted(true);
        }
        isLoadingRef.current = false;
      }
    }

    loadTheme();

    return () => {
      mountedRef.current = false;
    };
  }, [applyTheme]);

  // Listen for system theme changes
  useEffect(() => {
    if (!mounted || theme !== "system") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      applyTheme("system");
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme, mounted, applyTheme]);

  // Apply theme to document when it changes
  useEffect(() => {
    if (!mounted) return;
    applyTheme(theme);
  }, [theme, mounted, applyTheme]);

  const handleSetTheme = async (newTheme: Theme) => {
    setThemeState(newTheme);
    applyTheme(newTheme);

    try {
      // Fetch fresh settings to avoid race conditions with concurrent edits
      const response = await apiClient.getSettings();
      const currentSettings = response.settings as Settings;
      const merged = { ...currentSettings, theme: newTheme };

      await apiClient.saveSettings(merged);
      // Update cache
      settingsRef.current = merged;
    } catch (error) {
      console.error("Failed to save theme to settings:", error);
    }
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme: handleSetTheme, resolvedTheme, mounted, isOverridden }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}