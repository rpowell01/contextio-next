import * as React from "react";
import * as AlertDialogPrimitives from "@radix-ui/react-alert-dialog";
import { cn } from "@/lib/utils";

const AlertDialog = AlertDialogPrimitives.Root;
const AlertDialogTrigger = AlertDialogPrimitives.Trigger;
const AlertDialogPortal = AlertDialogPrimitives.Portal;
const AlertDialogOverlay = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitives.Overlay>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitives.Overlay>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitives.Overlay
    className={cn(
      "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
    ref={ref}
  />
));
AlertDialogOverlay.displayName = AlertDialogPrimitives.Overlay.displayName;

const AlertDialogContent = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitives.Content>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitives.Content>
>(({ className, ...props }, ref) => (
  <AlertDialogPortal>
    <AlertDialogOverlay />
    <AlertDialogPrimitives.Content
      ref={ref}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
        className
      )}
      {...props}
    />
  </AlertDialogPortal>
));
AlertDialogContent.displayName = AlertDialogPrimitives.Content.displayName;

const AlertDialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-2 text-center sm:text-left",
      className
    )}
    {...props}
  />
);
AlertDialogHeader.displayName = "AlertDialogHeader";

const AlertDialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
);
AlertDialogFooter.displayName = "AlertDialogFooter";

const AlertDialogTitle = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitives.Title>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitives.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitives.Title
    ref={ref}
    className={cn("text-lg font-semibold", className)}
    {...props}
  />
));
AlertDialogTitle.displayName = AlertDialogPrimitives.Title.displayName;

const AlertDialogDescription = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitives.Description>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitives.Description>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitives.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
AlertDialogDescription.displayName = AlertDialogPrimitives.Description.displayName;

const AlertDialogAction = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitives.Action>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitives.Action>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitives.Action
    ref={ref}
    type="button"
    className={cn("bg-primary text-primary-foreground hover:bg-primary/90", className)}
    {...props}
  />
));
AlertDialogAction.displayName = AlertDialogPrimitives.Action.displayName;

const AlertDialogCancel = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitives.Cancel>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitives.Cancel>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitives.Cancel
    ref={ref}
    className={cn("border border-input bg-background hover:bg-accent hover:text-accent-foreground", className)}
    {...props}
  />
));
AlertDialogCancel.displayName = AlertDialogPrimitives.Cancel.displayName;

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};
