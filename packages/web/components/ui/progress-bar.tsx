"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

interface ProgressBarProps {
  /** Progress value (0-100). Ignored if indeterminate is true */
  value?: number;
  /** Show indeterminate (animated) progress */
  indeterminate?: boolean;
  /** Height in pixels */
  height?: number;
  /** Additional CSS classes */
  className?: string;
  /** ID for accessibility (auto-generated if not provided) */
  id?: string;
}

/**
 * ProgressBar component
 * Supports both determinate (value 0-100) and indeterminate (animated) modes
 */
export function ProgressBar({
  value = 0,
  indeterminate = false,
  height = 4,
  className,
  id,
}: ProgressBarProps) {
  const generatedId = useId();
  const progressId = id || generatedId;
  const progressValue = indeterminate ? undefined : Math.max(0, Math.min(100, value));

  return (
    <div
      id={progressId}
      role="progressbar"
      aria-valuenow={progressValue}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-busy={indeterminate}
      aria-live="polite"
      className={cn(
        "relative overflow-hidden bg-muted rounded-full",
        className
      )}
      style={{ height: `${height}px` }}
    >
      <div
        className={cn(
          "h-full bg-primary transition-all duration-300 ease-out",
          indeterminate
            ? "animate-progress-indeterminate w-1/4"
            : "w-full"
        )}
        style={{
          width: indeterminate ? "25%" : `${progressValue}%`,
        }}
      />
    </div>
  );
}