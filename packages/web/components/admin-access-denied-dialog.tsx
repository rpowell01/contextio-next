"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Shield, Lock, User, Mail, AlertCircle } from "lucide-react";

interface AdminAccessDeniedDialogProps {
  open: boolean;
  onClose: () => void;
  userEmail?: string;
  isAuthenticated?: boolean;
}

/**
 * Dialog shown when a user tries to access admin-protected pages but doesn't have
 * the required admin privileges (email not in ADMIN_EMAILS or not authenticated).
 */
export function AdminAccessDeniedDialog({
  open,
  onClose,
  userEmail,
  isAuthenticated,
}: AdminAccessDeniedDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertCircle className="h-6 w-6" />
            </div>
            <div>
              <DialogTitle className="text-xl font-semibold">Admin Access Required</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                This page requires administrator privileges
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        
        <div className="space-y-4">
          <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4">
            <div className="flex items-center gap-2 text-destructive mb-2">
              <Lock className="h-4 w-4" />
              <span className="font-medium">Access Denied</span>
            </div>
            <p className="text-sm">
              You are trying to access a protected administrative page. Access is restricted to
              users with administrator privileges.
            </p>
          </div>

          <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
            <div className="flex items-center gap-2 text-primary mb-3">
              <Shield className="h-4 w-4" />
              <span className="font-medium">Requirements for Access</span>
            </div>
            <ul className="space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <User className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                <span>
                  <strong>OIDC Authentication must be enabled</strong> on the server
                  (CONTEXTIO_OIDC_ENABLED=true)
                </span>
              </li>
              <li className="flex items-start gap-2">
                <Mail className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                <span>
                  <strong>Your account email must be listed</strong> in the ADMIN_EMAILS
                  environment variable on the server
                </span>
              </li>
              <li className="flex items-start gap-2">
                <Lock className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                <span>
                  <strong>You must be signed in</strong> with an account that meets the above criteria
                </span>
              </li>
            </ul>
          </div>

          {isAuthenticated && userEmail && (
            <div className="rounded-lg border border-amber/20 bg-amber/5 p-4">
              <div className="flex items-center gap-2 text-amber mb-2">
                <AlertCircle className="h-4 w-4" />
                <span className="font-medium">Your Current Account</span>
              </div>
              <p className="text-sm text-muted-foreground">
                You are signed in as: <code className="font-mono bg-background px-1 rounded">{userEmail}</code>
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                This email is not in the ADMIN_EMAILS list. Contact your server administrator
                to request admin access.
              </p>
            </div>
          )}

          {!isAuthenticated && (
            <div className="rounded-lg border border-blue/20 bg-blue/5 p-4">
              <div className="flex items-center gap-2 text-blue mb-2">
                <Lock className="h-4 w-4" />
                <span className="font-medium">Not Signed In</span>
              </div>
              <p className="text-sm text-muted-foreground">
                You are not currently signed in. Please sign in with an account that has
                administrator privileges.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => {
            onClose();
            // Navigate back to the previous page instead of staying on blank screen
            if (typeof window !== "undefined") {
              window.history.back();
            }
          }}>
            Close
          </Button>
          <Button onClick={() => window.location.href = "/auth/login"}>
            Sign In
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}