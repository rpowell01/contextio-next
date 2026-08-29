"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface TooltipProps {
  children: React.ReactNode;
  delayDuration?: number;
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
  className?: string;
}

export function Tooltip({
  children,
  delayDuration = 200,
  disabled = false,
}: TooltipProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [timeoutId, setTimeoutId] = React.useState<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = React.useRef<HTMLElement>(null);
  const contentRef = React.useRef<HTMLElement>(null);
  const contentId = React.useId();

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

  React.useEffect(() => {
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [timeoutId]);

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
      contentId,
    }}>
      <div className="inline-block relative">{children}</div>
    </TooltipContext.Provider>
  );
}

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
  contentId: string;
} | null>(null);

function useTooltipContext() {
  const context = React.useContext(TooltipContext);
  if (!context) {
    throw new Error("Tooltip components must be used within a Tooltip");
  }
  return context;
}

function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined | null>): React.RefCallback<T> {
  return (value) => {
    refs.forEach((ref) => {
      if (typeof ref === "function") {
        ref(value);
      } else if (ref && typeof ref === "object") {
        (ref as React.MutableRefObject<T | null>).current = value;
      }
    });
  };
}

export function TooltipTrigger({ children, asChild = false }: TooltipTriggerProps) {
  const { showTooltip, hideTooltip, triggerRef, handleKeyDown, contentId } = useTooltipContext();

  const child = React.Children.only(children);
  const childProps = child.props as React.HTMLAttributes<HTMLElement>;

  if (asChild) {
    const clonedElement = React.cloneElement(child, {
      ref: mergeRefs(triggerRef, child.ref),
      tabIndex: 0,
      onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
        childProps.onMouseEnter?.(e);
        showTooltip();
      },
      onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
        childProps.onMouseLeave?.(e);
        hideTooltip();
      },
      onFocus: (e: React.FocusEvent<HTMLElement>) => {
        childProps.onFocus?.(e);
        showTooltip();
      },
      onBlur: (e: React.FocusEvent<HTMLElement>) => {
        childProps.onBlur?.(e);
        hideTooltip();
      },
      onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
        childProps.onKeyDown?.(e);
        handleKeyDown(e);
      },
      "aria-describedby": contentId,
    });
    return clonedElement;
  }

  return (
    <span
      ref={triggerRef}
      tabIndex={0}
      onMouseEnter={(e) => {
        childProps.onMouseEnter?.(e);
        showTooltip();
      }}
      onMouseLeave={(e) => {
        childProps.onMouseLeave?.(e);
        hideTooltip();
      }}
      onFocus={(e) => {
        childProps.onFocus?.(e);
        showTooltip();
      }}
      onBlur={(e) => {
        childProps.onBlur?.(e);
        hideTooltip();
      }}
      onKeyDown={(e) => {
        childProps.onKeyDown?.(e);
        handleKeyDown(e);
      }}
      style={{ display: 'inline-flex' }}
      aria-describedby={contentId}
    >
      {child}
    </span>
  );
}

export function TooltipContent({ 
  children, 
  side = "top", 
  align = "center", 
  sideOffset = 4, 
  className,
}: TooltipContentProps) {
  const { isOpen, contentRef, disabled, contentId } = useTooltipContext();

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

  const tooltipStyle: React.CSSProperties = {
    ...sideStyles[side],
    ...(align !== "center" ? alignStyles[align] : {}),
    zIndex: 50,
  };

  if (!isOpen) return null;

  return (
    <div
      ref={contentRef}
      id={contentId}
      className={cn(
        "fixed z-[100] px-3 py-2 text-xs font-medium text-popover-foreground bg-popover border border-border rounded-lg shadow-lg animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        "max-w-[300px] whitespace-normal break-words",
        className
      )}
      style={tooltipStyle}
      role="tooltip"
      data-state={isOpen ? "open" : "closed"}
    >
      {children}
    </div>
  );
}

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}