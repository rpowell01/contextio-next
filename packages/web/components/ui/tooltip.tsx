"use client";

import * as React from "react";
import * as ReactDOM from "react-dom";
import { cn } from "@/lib/utils";

/**
 * Throttle function using requestAnimationFrame to limit the rate of function calls.
 * Ensures the callback is called at most once per animation frame.
 */
function rafThrottle<T extends (...args: unknown[]) => void>(callback: T): T & { cancel: () => void } {
  let rafId: number | null = null;
  let lastArgs: unknown[] | null = null;

  const throttled = (...args: unknown[]) => {
    lastArgs = args;
    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (lastArgs !== null) {
          callback(...lastArgs);
        }
      });
    }
  };

  // Add a cancel method to clean up pending RAF
  throttled.cancel = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  return throttled as T & { cancel: () => void };
}

interface TooltipProps {
  children: React.ReactNode;
  content: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  delayDuration?: number;
  sideOffset?: number;
  alignOffset?: number;
  disabled?: boolean;
  maxWidth?: string | number;
}

interface TooltipContextValue {
  tooltipId: string;
  isVisible: boolean;
  setIsVisible: React.Dispatch<React.SetStateAction<boolean>>;
  triggerRef: React.RefObject<HTMLSpanElement | null>;
  side: "top" | "right" | "bottom" | "left";
  align: "start" | "center" | "end";
  sideOffset: number;
  alignOffset: number;
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
  maxWidth,
}: TooltipProps) {
  const child = React.Children.only(children);
  const tooltipId = React.useId();
  
  // State for tooltip visibility
  const [isVisible, setIsVisible] = React.useState(false);
  const [timeoutId, setTimeoutId] = React.useState<ReturnType<typeof setTimeout> | null>(null);
  // Ref to the trigger element for position calculation
  const triggerRef = React.useRef<HTMLSpanElement>(null);

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
    triggerRef,
    side,
    align,
    sideOffset,
    alignOffset,
  };
  
  // Don't wrap in a div - let the child determine its own display
  // The child will receive aria-describedby via TooltipTrigger when asChild is used
  return (
    <TooltipContext.Provider value={contextValue}>
      <span
        ref={triggerRef}
        className="relative inline-block"
        onMouseEnter={disabled ? undefined : showTooltip}
        onMouseLeave={disabled ? undefined : hideTooltip}
        aria-describedby={isVisible ? tooltipId : undefined}
      >
        {child}
        {!disabled && isVisible && triggerRef.current && (
          <TooltipPortal
            content={content}
            tooltipId={tooltipId}
            triggerRef={triggerRef}
            side={side}
            align={align}
            sideOffset={sideOffset}
            alignOffset={alignOffset}
            maxWidth={maxWidth}
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
      // Preserve all child props first
      ...childProps,
      // Add aria-describedby when tooltip is visible
      "aria-describedby": isVisible ? tooltipId : undefined,
      // Merge mouse event handlers to show/hide tooltip (without double-firing)
      // These override child's handlers to ensure tooltip behavior works
      onMouseEnter: mergeHandlers(childProps.onMouseEnter, () => context.setIsVisible(true)),
      onMouseLeave: mergeHandlers(childProps.onMouseLeave, () => context.setIsVisible(false)),
      onFocus: mergeHandlers(childProps.onFocus, () => context.setIsVisible(true)),
      onBlur: mergeHandlers(childProps.onBlur, () => context.setIsVisible(false)),
    });
  }
  
  return (
    <span aria-describedby={isVisible ? tooltipId : undefined}>
      {children}
    </span>
  );
}

interface TooltipPortalProps {
  content: React.ReactNode;
  tooltipId: string;
  triggerRef: React.RefObject<HTMLSpanElement | null>;
  side: "top" | "right" | "bottom" | "left";
  align: "start" | "center" | "end";
  sideOffset: number;
  alignOffset: number;
}

function TooltipPortal({
  content,
  tooltipId,
  triggerRef,
  side,
  align,
  sideOffset,
  alignOffset,
  maxWidth,
}: TooltipPortalProps & { maxWidth?: string | number }) {
  const [position, setPosition] = React.useState<{ top?: number; left?: number; right?: number; bottom?: number; transform?: string } | null>(null);

  React.useEffect(() => {
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;

      const rect = trigger.getBoundingClientRect();
      let top: number | undefined = 0;
      let left: number | undefined;
      let right: number | undefined;
      let bottom: number | undefined;
      let transform: string | undefined;

      switch (side) {
        case "top":
          top = rect.top - sideOffset;
          if (align === "center") {
            left = rect.left + rect.width / 2;
            transform = "translateX(-50%)";
          } else if (align === "start") {
            left = rect.left + alignOffset;
            transform = "translateX(0)";
          } else { // end
            right = window.innerWidth - rect.right + alignOffset;
            transform = "translateX(0)";
          }
          break;
        case "bottom":
          top = rect.bottom + sideOffset;
          if (align === "center") {
            left = rect.left + rect.width / 2;
            transform = "translateX(-50%)";
          } else if (align === "start") {
            left = rect.left + alignOffset;
            transform = "translateX(0)";
          } else { // end
            right = window.innerWidth - rect.right + alignOffset;
            transform = "translateX(0)";
          }
          break;
        case "left":
          if (align === "center") {
            top = rect.top + rect.height / 2;
            transform = "translateY(-50%)";
          } else if (align === "start") {
            top = rect.top + alignOffset;
            transform = "translateY(0)";
          } else { // end
            bottom = window.innerHeight - rect.bottom + alignOffset;
            transform = "translateY(0)";
            top = undefined;
          }
          left = rect.left - sideOffset;
          break;
        case "right":
          if (align === "center") {
            top = rect.top + rect.height / 2;
            transform = "translateY(-50%)";
          } else if (align === "start") {
            top = rect.top + alignOffset;
            transform = "translateY(0)";
          } else { // end
            bottom = window.innerHeight - rect.bottom + alignOffset;
            transform = "translateY(0)";
            top = undefined;
          }
          left = rect.right + sideOffset;
          break;
      }

      setPosition({ top, left, right, bottom, transform });
    };

    // Throttle position updates to once per animation frame
    const throttledUpdatePosition = rafThrottle(updatePosition);

    updatePosition();
    // Update position on scroll/resize (throttled)
    window.addEventListener("scroll", throttledUpdatePosition, true);
    window.addEventListener("resize", throttledUpdatePosition);
    return () => {
      window.removeEventListener("scroll", throttledUpdatePosition, true);
      window.removeEventListener("resize", throttledUpdatePosition);
      throttledUpdatePosition.cancel();
    };
  }, [triggerRef, side, align, sideOffset, alignOffset]);

  if (!position) return null;

  const tooltipStyle: React.CSSProperties = {
    position: "fixed",
    top: position.top,
    left: position.left,
    right: position.right,
    bottom: position.bottom,
    transform: position.transform,
    pointerEvents: "none",
    zIndex: 100,
  };

  return ReactDOM.createPortal(
    <div
      id={tooltipId}
      className={cn("px-3 py-2 text-xs font-medium text-popover-foreground bg-popover border border-border rounded-lg shadow-lg whitespace-normal break-words animate-in fade-in-0 zoom-in-95")}
      style={{ ...tooltipStyle, maxWidth: maxWidth ? (typeof maxWidth === "number" ? `${maxWidth}px` : maxWidth) : "500px" }}
      role="tooltip"
    >
      {content}
    </div>,
    document.body
  );
}

export function TooltipContent({ 
  content,
  side = "top",
  align = "center",
  sideOffset = 4,
  alignOffset = 0,
  className,
  tooltipId,
  maxWidth,
}: TooltipContentProps & { content: React.ReactNode; side?: "top" | "right" | "bottom" | "left"; align?: "start" | "center" | "end"; tooltipId: string; maxWidth?: string | number }) {
  const sideStyles: Record<string, React.CSSProperties> = {
    top: { bottom: "100%", left: "50%", transform: "translateX(-50%)", marginBottom: sideOffset },
    bottom: { top: "100%", left: "50%", transform: "translateX(-50%)", marginTop: sideOffset },
    left: { right: "100%", top: "50%", transform: "translateY(-50%)", marginRight: sideOffset },
    right: { left: "100%", top: "50%", transform: "translateY(-50%)", marginLeft: sideOffset },
  };

  const isVerticalSide = side === "left" || side === "right";
  const alignStyles: Record<string, React.CSSProperties> = {
    start: { left: alignOffset, transform: isVerticalSide ? "translateX(0) translateY(-50%)" : "translateX(0)" },
    end: { right: alignOffset, transform: isVerticalSide ? "translateX(0) translateY(-50%)" : "translateX(0)" },
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
      className={cn("z-[100] px-3 py-2 text-xs font-medium text-popover-foreground bg-popover border border-border rounded-lg shadow-lg whitespace-normal break-words animate-in fade-in-0 zoom-in-95", className)}
      style={{ ...tooltipStyle, maxWidth: maxWidth ? (typeof maxWidth === "number" ? `${maxWidth}px` : maxWidth) : "500px" }}
      role="tooltip"
    >
      {content}
    </div>
  );
}

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}