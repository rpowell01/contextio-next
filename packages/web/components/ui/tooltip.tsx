"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface TooltipProps {
  children: React.ReactNode;
  content: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  alignOffset?: number;
  delayDuration?: number;
  skipDelayDuration?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}

interface TooltipTriggerProps {
  children: React.ReactElement;
  asChild?: boolean;
}

interface TooltipContentProps {
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  alignOffset?: number;
  className?: string;
}

/**
 * Simple CSS-based Tooltip component.
 * Uses a hover/focus trigger to show a tooltip with the content.
 * No external dependencies - pure CSS positioning.
 */
export function Tooltip({
  children,
  content,
  side = "top",
  align = "center",
  sideOffset = 4,
  delayDuration = 200,
  disabled = false,
}: TooltipProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [timeoutId, setTimeoutId] = React.useState<NodeJS.Timeout | null>(null);
  const triggerRef = React.useRef<HTMLElement>(null);

  const showTooltip = () => {
    if (disabled) return;
    const id = setTimeout(() => {
      setIsOpen(true);
    }, delayDuration);
    setTimeoutId(id);
  };

  const hideTooltip = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      setTimeoutId(null);
    }
    setIsOpen(false);
  };

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [timeoutId]);

  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Tab") {
      hideTooltip();
    }
  };

  const child = React.Children.only(children);
  const childProps = child.props as React.HTMLAttributes<HTMLElement>;

  const mergedRef = React.useCallback(
    (node: HTMLElement) => {
      triggerRef.current = node;
      if (typeof childProps.ref === "function") {
        childProps.ref(node);
      } else if (childProps.ref && typeof childProps.ref === "object") {
        (childProps.ref as React.MutableRefObject<HTMLElement>).current = node;
      }
    },
    [childProps.ref]
  );

  const sideStyles: Record<string, React.CSSProperties> = {
    top: { bottom: "100%", left: "50%", transform: "translateX(-50%)", marginBottom: sideOffset },
    bottom: { top: "100%", left: "50%", transform: "translateX(-50%)", marginTop: sideOffset },
    left: { right: "100%", top: "50%", transform: "translateY(-50%)", marginRight: sideOffset },
    right: { left: "100%", top: "50%", transform: "translateY(-50%)", marginLeft: sideOffset },
  };

  const alignStyles: Record<string, React.CSSProperties> = {
    start: { left: 0, transform: "none" },
    end: { right: 0, transform: "none" },
    center: {},
  };

  // Merge side and align styles
  const tooltipStyle: React.CSSProperties = {
    ...sideStyles[side],
    ...(align !== "center" ? alignStyles[align] : {}),
    position: "absolute",
    zIndex: 50,
    whiteSpace: "nowrap",
  };

  return (
    <div
      ref={mergedRef}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={showTooltip}
      onBlur={hideTooltip}
      onKeyDown={handleKeyDown}
      className="inline-block relative"
      tabIndex={0}
      {...childProps}
    >
      {child}
      {isOpen && (
        <div
          className={cn(
            "fixed z-[100] px-3 py-2 text-xs font-medium text-popover-foreground bg-popover border border-border rounded-lg shadow-lg animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
            "max-w-[300px] whitespace-normal break-words"
          )}
          style={tooltipStyle}
          role="tooltip"
        >
          {content}
        </div>
      )}
    </div>
  );
}

export function TooltipTrigger({ children, asChild = true }: TooltipTriggerProps) {
  return asChild ? children : <span>{children}</span>;
}

export function TooltipContent({ children, className, ...props }: TooltipContentProps) {
  return (
    <div className={cn("relative", className)} {...props}>
      {children}
    </div>
  );
}

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}