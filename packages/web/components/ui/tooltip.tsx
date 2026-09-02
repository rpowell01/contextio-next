"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface TooltipProps {
  children: React.ReactNode;
  content: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  delayDuration?: number;
  sideOffset?: number;
  alignOffset?: number;
  disabled?: boolean;
}

interface TooltipContextValue {
  tooltipId: string;
  isVisible: boolean;
  setIsVisible: React.Dispatch<React.SetStateAction<boolean>>;
}

const TooltipContext = React.createContext<TooltipContextValue | null>(null);

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
  sideOffset = 4,
  alignOffset = 0,
  disabled = false,
}: TooltipProps) {
  const child = React.Children.only(children);
  const tooltipId = React.useId();
  
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
  
  const contextValue: TooltipContextValue = {
    tooltipId,
    isVisible,
    setIsVisible,
  };
  
  // Apply aria-describedby to the child when tooltip is visible
  const childWithAria = React.isValidElement(child)
    ? React.cloneElement(child as React.ReactElement<Record<string, unknown>>, {
        "aria-describedby": isVisible ? tooltipId : undefined,
      })
    : child;
  
  // Wrap the child in a tooltip container
  return (
    <TooltipContext.Provider value={contextValue}>
      <div 
        className="relative inline-block"
        style={{ display: 'inline-block' }}
        onMouseEnter={disabled ? undefined : showTooltip}
        onMouseLeave={disabled ? undefined : hideTooltip}
      >
        {childWithAria}
        {!disabled && isVisible && (
          <TooltipContent
            content={content}
            side={side}
            align={align}
            sideOffset={sideOffset}
            alignOffset={alignOffset}
          />
        )}
      </div>
    </TooltipContext.Provider>
  );
}



export function TooltipTrigger({ children, asChild = true }: TooltipTriggerProps) {
  const context = React.useContext(TooltipContext);
  
  if (!context) {
    // TooltipTrigger must be used within a Tooltip component
    return asChild ? children : <span>{children}</span>;
  }
  
  const { tooltipId, isVisible } = context;
  
  if (asChild) {
    // Clone the child element and add aria-describedby when tooltip is visible
    return React.isValidElement(children)
      ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
          "aria-describedby": isVisible ? tooltipId : undefined,
        })
      : children;
  }
  
  return (
    <span aria-describedby={isVisible ? tooltipId : undefined}>
      {children}
    </span>
  );
}

export function TooltipContent({ 
  content,
  side = "top",
  align = "center",
  sideOffset = 4,
  alignOffset = 0,
  className,
}: TooltipContentProps & { content: React.ReactNode; side?: "top" | "right" | "bottom" | "left"; align?: "start" | "center" | "end" }) {
  const context = React.useContext(TooltipContext);
  const tooltipId = context?.tooltipId;
  
  const sideStyles: Record<string, React.CSSProperties> = {
    top: { bottom: "100%", left: "50%", transform: "translateX(-50%)", marginBottom: sideOffset },
    bottom: { top: "100%", left: "50%", transform: "translateX(-50%)", marginTop: sideOffset },
    left: { right: "100%", top: "50%", transform: "translateY(-50%)", marginRight: sideOffset },
    right: { left: "100%", top: "50%", transform: "translateY(-50%)", marginLeft: sideOffset },
  };

  const alignStyles: Record<string, React.CSSProperties> = {
    start: { left: alignOffset, transform: "translateX(0)" },
    end: { right: alignOffset, transform: "translateX(0)" },
    center: {},
  };

  const tooltipStyle: React.CSSProperties = {
    ...sideStyles[side],
    ...(align !== "center" ? alignStyles[align] : {}),
    position: "absolute",
    // z-index and whitespace handled by className to avoid conflicts
  };

  return (
    <div
      id={tooltipId}
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