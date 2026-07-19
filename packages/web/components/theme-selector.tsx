"use client";

import { useState, useRef, useEffect, KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/components/theme-provider";

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
  const [focusedIndex, setFocusedIndex] = useState(
    THEME_OPTIONS.findIndex((t) => t.value === value)
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeAheadRef = useRef<string>("");
  const typeAheadTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const selectedIndexRef = useRef(THEME_OPTIONS.findIndex((t) => t.value === value));
  const { isOverridden } = useTheme();

// Build stable, unique IDs for each listbox option.
// aria-activedescendant always points to the currently focused option.
const optionIds: string[] = THEME_OPTIONS.map((_, i) => `theme-option-${i}`);
const activeDescendantId = `theme-option-${focusedIndex}`;

// Update selected index when value changes, but don't move focus while open
  useEffect(() => {
    selectedIndexRef.current = THEME_OPTIONS.findIndex((t) => t.value === value);
    if (!isOpen) {
      setFocusedIndex(selectedIndexRef.current);
    }
  }, [value, isOpen]);

  // Focus the listbox when opened, scroll focused option into view
  useEffect(() => {
    if (isOpen && listRef.current) {
      listRef.current.focus();
      const option = listRef.current.querySelector(
        `[data-index="${focusedIndex}"]`
      ) as HTMLElement | null;
      option?.scrollIntoView({ block: "nearest" });
    }
  }, [isOpen, focusedIndex]);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        isOpen &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node) &&
        listRef.current &&
        !listRef.current.contains(event.target as Node)
      ) {
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

  // Type-ahead search: match first item starting with typed characters, cycling through matches
  const handleTypeAhead = (char: string): number => {
    typeAheadRef.current += char.toLowerCase();
    clearTimeout(typeAheadTimerRef.current);
    typeAheadTimerRef.current = setTimeout(() => {
      typeAheadRef.current = "";
    }, 500);

    const typed = typeAheadRef.current;
    const start = focusedIndex + 1;
    // Search forward from current position, then wrap
    for (let i = start; i < start + THEME_OPTIONS.length; i++) {
      const idx = i % THEME_OPTIONS.length;
      if (THEME_OPTIONS[idx].label.toLowerCase().startsWith(typed)) {
        return idx;
      }
    }
    return -1;
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (!isOpen) return;

    let newIndex = focusedIndex;

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        newIndex = (focusedIndex + 1) % THEME_OPTIONS.length;
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        newIndex =
          (focusedIndex - 1 + THEME_OPTIONS.length) % THEME_OPTIONS.length;
        break;
      }
      case "Home": {
        event.preventDefault();
        newIndex = 0;
        break;
      }
      case "End": {
        event.preventDefault();
        newIndex = THEME_OPTIONS.length - 1;
        break;
      }
      case "Enter":
      case " ": {
        event.preventDefault();
        handleSelect(THEME_OPTIONS[focusedIndex].value);
        return;
      }
      case "Escape": {
        event.preventDefault();
        setIsOpen(false);
        buttonRef.current?.focus();
        return;
      }
      case "Tab": {
        setIsOpen(false);
        return;
      }
      default:
        // Type-ahead on printable characters
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          const match = handleTypeAhead(event.key);
          if (match !== -1) {
            setFocusedIndex(match);
          }
        }
        return;
    }

    if (newIndex !== focusedIndex) {
      setFocusedIndex(newIndex);
    }
  };

  const selectedTheme = THEME_OPTIONS.find((t) => t.value === value) || THEME_OPTIONS[2];

  return (
    <div className={cn("relative inline-block", className)}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={(e) => {
          // Open on ArrowDown/ArrowUp/Enter/Space when closed
          if (
            !isOpen &&
            (e.key === "ArrowDown" ||
              e.key === "ArrowUp" ||
              e.key === "Enter" ||
              e.key === " ")
          ) {
            e.preventDefault();
            setIsOpen(true);
            return;
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? "theme-listbox" : undefined}
        aria-activedescendant={isOpen ? activeDescendantId : undefined}
        aria-label="Select theme"
        disabled={isOverridden}
        className={cn(
          "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          "bg-background border border-border hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring",
          "min-w-[140px] justify-between",
          isOverridden && "opacity-50 cursor-not-allowed"
        )}
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
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {isOpen && (
        <ul
          id="theme-listbox"
          ref={listRef}
          tabIndex={0}
          role="listbox"
          aria-label="Theme options"
          onKeyDown={handleListKeyDown}
          className={cn(
            "absolute z-50 mt-1 min-w-[140px] rounded-md border border-border bg-popover p-1 shadow-lg",
            "max-h-60 overflow-y-auto"
          )}
        >
          {THEME_OPTIONS.map((theme, index) => (
            <li
              key={theme.value}
              role="option"
              id={optionIds[index]}
              aria-selected={theme.value === value}
              data-index={index}
              aria-setsize={THEME_OPTIONS.length}
              aria-posinset={index + 1}
            >
              <button
                type="button"
                tabIndex={-1}
onClick={() => handleSelect(theme.value)}
              disabled={isOverridden}
              className={cn(
                  "flex w-full items-center gap-2 rounded px-3 py-2 text-sm font-medium transition-colors",
                  index === focusedIndex
                    ? "bg-accent text-accent-foreground"
                    : "text-popover-foreground hover:bg-accent hover:text-accent-foreground",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  isOverridden && "opacity-50 cursor-not-allowed"
                )}
                onMouseEnter={() => setFocusedIndex(index)}
                onFocus={() => setFocusedIndex(index)}
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
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
