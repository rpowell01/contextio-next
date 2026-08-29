"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface TooltipProps {
  children: React.ReactNode;
  delayDuration?: number;
  skipDelayDuration?: number;
  disabled?: boolean;
}

interface TooltipTriggerProps {
  children: React.ReactElement;
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
 * Simple CSS-based Tooltip component following Radix UI compound pattern.
 * Usage:
 *   <Tooltip>
 *     <TooltipTrigger asChild>
 *       <button>Hover me</button>
 *     </TooltipTrigger>
 *     <TooltipContent side="top">
 *       Tooltip content
 *     </TooltipContent>
 *   </Tooltip>
 */
export function Tooltip({
  children,
  delayDuration = 200,
  disabled = false,
}: TooltipProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [timeoutId, setTimeoutId] = React.useState<NodeJS.Timeout | null>(null);
  const triggerRef = React.useRef<HTMLElement>(null);
  const contentRef = React.useRef<HTMLElement>(null);

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

  return (
    <TooltipContext.Provider value={{
      isOpen,
      setIsOpen,
      showTooltip,
      hideTooltip,
      triggerRef,
      contentRef,
      delayDuration,
      disabled,
      handleKeyDown,
    }}>
      <div className="inline-block relative">{children}</div>
    </TooltipContext.Provider>
  );
}

// Context for sharing state between Tooltip, TooltipTrigger, and TooltipContent
const TooltipContext = React.createContext<{
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  showTooltip: () => void;
  hideTooltip: () => void;
  triggerRef: React.RefObject<HTMLElement | null>;
  contentRef: React.RefObject<HTMLElement | null>;
  delayDuration: number;
  disabled: boolean;
  handleKeyDown: (e: React.KeyboardEvent) => void;
} | null>(null);

function useTooltipContext() {
  const context = React.useContext(TooltipContext);
  if (!context) {
    throw new Error("Tooltip components must be used within a Tooltip");
  }
  return context;
}

export function TooltipTrigger({ children }: TooltipTriggerProps) {
  const { showTooltip, hideTooltip, triggerRef, handleKeyDown } = useTooltipContext();
  
  const child = React.Children.only(children);
  const childProps = child.props as React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> };

  const mergedRef = React.useCallback(
    (node: HTMLElement) => {
      triggerRef.current = node;
      const childRef = childProps.ref;
      if (typeof childRef === "function") {
        childRef(node);
      } else if (childRef && typeof childRef === "object") {
        (childRef as React.MutableRefObject<HTMLElement>).current = node;
      }
    },
    [childProps.ref, triggerRef]
  );

  return (
    <React.Fragment>
      {React.cloneElement(child, {
        ref: mergedRef,
        onMouseEnter: (e: React.MouseEvent) => {
          childProps.onMouseEnter?.(e);
          showTooltip();
        },
        onMouseLeave: (e: React.MouseEvent) => {
          childProps.onMouseLeave?.(e);
          hideTooltip();
        },
        onFocus: (e: React.FocusEvent) => {
          childProps.onFocus?.(e);
          showTooltip();
        },
        onBlur: (e: React.FocusEvent) => {
          childProps.onBlur?.(e);
          hideTooltip();
        },
        onKeyDown: (e: React.KeyboardEvent) => {
          childProps.onKeyDown?.(e);
          handleKeyDown(e);
        },
        tabIndex: 0,
      })}
    </React.Fragment>
  );
}

export function TooltipContent({ 
  children, 
  side = "top", 
  align = "center", 
  sideOffset = 4, 
  alignOffset = 0,
  className,
}: TooltipContentProps) {
  const { isOpen, contentRef, delayDuration, disabled } = useTooltipContext();
  
  if (disabled) return null;

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

  if (!isOpen) return null;

  return (
    <div
      ref={contentRef}
      className={cn(
        "fixed z-[100] px-3 py-2 text-xs font-medium text-popover-foreground bg-popover border border-border rounded-lg shadow-lg animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        "max-w-[300px] whitespace-normal break-words",
        className
      )}
      style={tooltipStyle}
      role="tooltip"
      onMouseEnter={() => {}}
      onMouseLeave={() => {}}
    >
      {children}
    </div>
  );
}

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}