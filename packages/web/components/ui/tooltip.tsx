"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface TooltipProps {
  children: React.ReactNode;
  content: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  delayDuration?: number;
  disabled?: boolean;
}

interface TooltipTriggerProps {
  children: React.ReactElement;
  asChild?: boolean;
}

interface TooltipContentProps {
  content: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  alignOffset?: number;
  className?: string;
}

/**
 * Simple CSS-based Tooltip component.
 * Uses pure CSS for positioning and visibility - no complex ref handling needed.
 * 
 * Usage:
 *   <Tooltip content="Tooltip text">
 *     <TooltipTrigger asChild>
 *       <button>Hover me</button>
 *     </TooltipTrigger>
 *   </Tooltip>
 * 
 * Or without asChild:
 *   <Tooltip content="Tooltip text">
 *     <TooltipTrigger>
 *       <span>Hover me</span>
 *     </TooltipTrigger>
 *   </Tooltip>
 */
export function Tooltip({
  children,
  content,
  side = "top",
  align = "center",
  delayDuration = 200,
  disabled = false,
}: TooltipProps) {
  const child = React.Children.only(children);
  
  // State for tooltip visibility
  const [isVisible, setIsVisible] = React.useState(false);
  const [timeoutId, setTimeoutId] = React.useState<ReturnType<typeof setTimeout> | null>(null);

  const showTooltip = () => {
    const id = setTimeout(() => {
      setIsVisible(true);
    }, delayDuration);
    setTimeoutId(id);
  };

  const hideTooltip = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      setTimeoutId(null);
    }
    setIsVisible(false);
  };

  React.useEffect(() => {
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [timeoutId]);
  
  // Wrap the child in a tooltip container
  return (
    <div 
      className="relative inline-block"
      style={{ display: 'inline-block' }}
      onMouseEnter={disabled ? undefined : showTooltip}
      onMouseLeave={disabled ? undefined : hideTooltip}
    >
      {child}
      {!disabled && isVisible && (
        <TooltipContent
          content={content}
          side={side}
          align={align}
        />
      )}
    </div>
  );
}



export function TooltipTrigger({ children, asChild = true }: TooltipTriggerProps) {
  // For simplicity, just render the child directly
  // The Tooltip component handles the wrapper
  return asChild ? children : <span>{children}</span>;
}

export function TooltipContent({ 
  content,
  side = "top",
  align = "center",
  className,
}: TooltipContentProps & { content: React.ReactNode; side?: "top" | "right" | "bottom" | "left"; align?: "start" | "center" | "end" }) {
  
  const sideStyles: Record<string, React.CSSProperties> = {
    top: { bottom: "100%", left: "50%", transform: "translateX(-50%)", marginBottom: 4 },
    bottom: { top: "100%", left: "50%", transform: "translateX(-50%)", marginTop: 4 },
    left: { right: "100%", top: "50%", transform: "translateY(-50%)", marginRight: 4 },
    right: { left: "100%", top: "50%", transform: "translateY(-50%)", marginLeft: 4 },
  };

  const alignStyles: Record<string, React.CSSProperties> = {
    start: { left: 0, transform: "translateX(0)" },
    end: { right: 0, transform: "translateX(0)" },
    center: {},
  };

  const tooltipStyle: React.CSSProperties = {
    ...sideStyles[side],
    ...(align !== "center" ? alignStyles[align] : {}),
    position: "absolute",
    zIndex: 50,
    whiteSpace: "normal",
  };

  return (
    <div
      className={cn("z-[100] px-3 py-2 text-xs font-medium text-popover-foreground bg-popover border border-border rounded-lg shadow-lg max-w-[300px] whitespace-normal break-words animate-in fade-in-0 zoom-in-95", className)}
      style={tooltipStyle}
      role="tooltip"
    >
      {content}
    </div>
  );
}

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}