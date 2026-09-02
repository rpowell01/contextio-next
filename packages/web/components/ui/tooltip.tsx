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
 * Usage with asChild (recommended - preserves child layout and accessibility):
 *   <Tooltip content="Tooltip text">
 *     <TooltipTrigger asChild>
 *       <button>Hover me</button>
 *     </TooltipTrigger>
 *   </Tooltip>
 * 
 * Usage without asChild (wraps child in a span):
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
  
  // Don't wrap in a div - let the child determine its own display
  // The child will receive aria-describedby via TooltipTrigger when asChild is used
  return (
    <TooltipContext.Provider value={contextValue}>
      <span
        className="relative inline-block"
        onMouseEnter={disabled ? undefined : showTooltip}
        onMouseLeave={disabled ? undefined : hideTooltip}
      >
        {child}
        {!disabled && isVisible && (
          <TooltipContent
            content={content}
            side={side}
            align={align}
            sideOffset={sideOffset}
            alignOffset={alignOffset}
          />
        )}
      </span>
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
    // Properly implement asChild pattern: clone element and merge props without wrapping
    if (!React.isValidElement(children)) {
      return children;
    }
    
    const child = children as React.ReactElement<any>;
    const childProps = child.props;
    
    // Merge event handlers: call both child's handler and our handler
    const mergeHandlers = <T extends (...args: unknown[]) => void>(
      childHandler: T | undefined,
      parentHandler: (...args: unknown[]) => void
    ): T => {
      return ((...args: unknown[]) => {
        childHandler?.(...args);
        parentHandler(...args);
      }) as T;
    };
    
    return React.cloneElement(child, {
      // Forward ref to the underlying DOM node - prevents double tab stops
      // when child is already focusable (e.g., button, link)
      ref: (child as any).ref,
      // Add aria-describedby when tooltip is visible
      "aria-describedby": isVisible ? tooltipId : undefined,
      // Merge mouse event handlers to show/hide tooltip (without double-firing)
      onMouseEnter: mergeHandlers(childProps.onMouseEnter, () => context.setIsVisible(true)),
      onMouseLeave: mergeHandlers(childProps.onMouseLeave, () => context.setIsVisible(false)),
      onFocus: mergeHandlers(childProps.onFocus, () => context.setIsVisible(true)),
      onBlur: mergeHandlers(childProps.onBlur, () => context.setIsVisible(false)),
      // Preserve any other existing props by spreading
      ...childProps,
    });
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