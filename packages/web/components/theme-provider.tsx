"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";

type Theme = "light" | "dark" | "system" | "high-contrast";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  setThemeWithoutPersist: (theme: Theme) => void;
  resolvedTheme: "light" | "dark" | "high-contrast";
  mounted: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({
  children,
  initialTheme = "system",
}: {
  children: ReactNode;
  initialTheme?: Theme;
}) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark" | "high-contrast">("light");
  const [mounted, setMounted] = useState(false);

  // Resolve theme based on system preference
  const resolveTheme = (t: Theme): "light" | "dark" | "high-contrast" => {
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
  };

  // Apply theme to document
  const applyTheme = (t: Theme) => {
    const resolved = resolveTheme(t);
    setResolvedTheme(resolved);
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", resolved);
    }
  };

  // Initialize theme from localStorage or use default
  useEffect(() => {
    setMounted(true);
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("contextio-theme") as Theme | null;
      if (saved) {
        setTheme(saved);
        applyTheme(saved);
      } else {
        applyTheme(initialTheme);
      }
    }
  }, [initialTheme]);

  // Listen for system theme changes
  useEffect(() => {
    if (!mounted) return;
    
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (theme === "system") {
        applyTheme("system");
      }
    };
    
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme, mounted]);

  // Apply theme to document when it changes (but don't persist to localStorage here)
  useEffect(() => {
    if (!mounted) return;
    applyTheme(theme);
  }, [theme, mounted]);

  const handleSetTheme = (newTheme: Theme) => {
    setTheme(newTheme);
    if (typeof window !== "undefined") {
      localStorage.setItem("contextio-theme", newTheme);
    }
  };

  const handleSetThemeWithoutPersist = (newTheme: Theme) => {
    setTheme(newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme: handleSetTheme, setThemeWithoutPersist: handleSetThemeWithoutPersist, resolvedTheme, mounted }}>
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