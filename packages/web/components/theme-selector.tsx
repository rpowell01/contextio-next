"use client";

import { useState, useRef, useEffect, KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

interface ThemeSelectorProps {
  className?: string;
  value: "light" | "dark" | "system" | "high-contrast";
  onChange: (theme: "light" | "dark" | "system" | "high-contrast") => void;
}

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: "☀️" },
  { value: "dark", label: "Dark", icon: "🌙" },
  { value: "system", label: "System", icon: "💻" },
  { value: "high-contrast", label: "High Contrast", icon: "🌓" },
] as const;

export function ThemeSelector({ className, value, onChange }: ThemeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const selectedIndexRef = useRef(THEME_OPTIONS.findIndex((t) => t.value === value));

  // Check if theme is overridden by environment variable
  const isEnvOverridden = typeof window !== "undefined" && !!localStorage.getItem("contextio-theme-env-override");
  
  // Update selected index when value changes
  useEffect(() => {
    selectedIndexRef.current = THEME_OPTIONS.findIndex((t) => t.value === value);
  }, [value]);

  // Handle keyboard navigation
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement | HTMLUListElement>) => {
    if (!isOpen && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      setIsOpen(true);
      return;
    }

    if (isOpen) {
      let newIndex = selectedIndexRef.current;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          newIndex = (selectedIndexRef.current + 1) % THEME_OPTIONS.length;
          break;
        case "ArrowUp":
          event.preventDefault();
          newIndex = (selectedIndexRef.current - 1 + THEME_OPTIONS.length) % THEME_OPTIONS.length;
          break;
        case "Home":
          event.preventDefault();
          newIndex = 0;
          break;
        case "End":
          event.preventDefault();
          newIndex = THEME_OPTIONS.length - 1;
          break;
        case "Enter":
        case " ":
          event.preventDefault();
          handleSelect(THEME_OPTIONS[selectedIndexRef.current].value);
          break;
        case "Escape":
          event.preventDefault();
          setIsOpen(false);
          buttonRef.current?.focus();
          break;
        case "Tab":
          setIsOpen(false);
          break;
      }
      
      // Update selected index and focus the new option
      if (newIndex !== selectedIndexRef.current) {
        selectedIndexRef.current = newIndex;
        if (listRef.current) {
          const option = listRef.current.querySelector(`[data-index="${newIndex}"]`) as HTMLElement;
          option?.focus();
        }
      }
    }
  };

  // Focus the selected option when open
  useEffect(() => {
    if (isOpen && listRef.current) {
      const option = listRef.current.querySelector(`[data-index="${selectedIndexRef.current}"]`) as HTMLElement;
      option?.focus();
    }
  }, [isOpen]);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (isOpen && buttonRef.current && !buttonRef.current.contains(event.target as Node) &&
          listRef.current && !listRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleSelect = (theme: "light" | "dark" | "system" | "high-contrast") => {
    onChange(theme);
    setIsOpen(false);
    buttonRef.current?.focus();
  };

  const selectedTheme = THEME_OPTIONS.find((t) => t.value === value) || THEME_OPTIONS[2];

  return (
    <div className={cn("relative inline-block", className)}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        disabled={isEnvOverridden}
        className={cn(
          "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          "bg-background border border-border hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring",
          "min-w-[140px] justify-between",
          isEnvOverridden && "opacity-50 cursor-not-allowed"
        )}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label="Select theme"
      >
        <span className="flex items-center gap-2">
          <span aria-hidden="true">{selectedTheme.icon}</span>
          <span>{selectedTheme.label}</span>
        </span>
        <svg
          className={cn("h-4 w-4 transition-transform", isOpen && "rotate-180")}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <>
          <ul
            ref={listRef}
            className="absolute z-50 mt-1 min-w-[140px] rounded-md border border-border bg-popover p-1 shadow-lg"
            role="listbox"
            aria-label="Theme options"
            onKeyDown={handleKeyDown}
          >
            {THEME_OPTIONS.map((theme, index) => (
              <li key={theme.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={theme.value === value}
                  tabIndex={-1}
                  data-index={index}
                  onClick={() => handleSelect(theme.value)}
                  disabled={isEnvOverridden}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-3 py-2 text-sm font-medium transition-colors",
                    theme.value === value
                      ? "bg-accent text-accent-foreground"
                      : "text-popover-foreground hover:bg-accent hover:text-accent-foreground",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    isEnvOverridden && "opacity-50 cursor-not-allowed"
                  )}
                >
                  <span aria-hidden="true">{theme.icon}</span>
                  <span>{theme.label}</span>
                  {theme.value === value && (
                    <svg
                      className="ml-auto h-4 w-4 text-primary"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}