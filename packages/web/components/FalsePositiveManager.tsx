"use client";

// @ts-ignore - false positive: all imports in this file are used in JSX but flagged as unused in Docker build
import { useState, useEffect, useCallback } from "react";
// @ts-ignore
import type { FalsePositiveEntry } from "@/types/api";
// @ts-ignore
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
// @ts-ignore
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
// @ts-ignore
import { Button, Input, Label } from "@/components/ui";
// @ts-ignore
import {
  Loader2,
  Trash2,
  Edit2,
  Plus,
  ChevronDown,
  X,
} from "lucide-react";
// @ts-ignore
import { useSearchParams, useRouter } from "next/navigation";
// @ts-ignore
import { apiClient } from "@/lib/api";

type FalsePositiveForm = {
  value: string;
  ruleId: string;
  label: string;
  path: string;
  customPath?: string;
  sessionId?: string;
  matchMode?: "exact" | "pattern";
};

// All available redaction rule IDs from presets (secrets, pii, strict)
const RULE_OPTIONS: { value: string; label: string }[] = [
  // Secrets preset
  { value: "private-key", label: "Private Key (private-key)" },
  { value: "credential_aws_key", label: "AWS Access Key (credential_aws_key)" },
  { value: "aws-secret-key", label: "AWS Secret Key (aws-secret-key)" },
  { value: "credential_github", label: "GitHub Token (credential_github)" },
  { value: "credential_anthropic", label: "Anthropic API Key (credential_anthropic)" },
  { value: "credential_openai", label: "OpenAI API Key (credential_openai)" },
  { value: "credential_gcp_api_key", label: "GCP API Key (credential_gcp_api_key)" },
  { value: "credential_gcp_service_account", label: "GCP Service Account (credential_gcp_service_account)" },
  { value: "credential_gitlab", label: "GitLab Token (credential_gitlab)" },
  { value: "credential_jwt", label: "JWT Token (credential_jwt)" },
  { value: "credential_stripe", label: "Stripe Key (credential_stripe)" },
  { value: "credential_slack", label: "Slack Token (credential_slack)" },
  { value: "credential_huggingface", label: "Hugging Face Token (credential_huggingface)" },
  { value: "credential_databricks", label: "Databricks Token (credential_databricks)" },
  { value: "credential_npm", label: "NPM Token (credential_npm)" },
  { value: "credential_pypi", label: "PyPI Token (credential_pypi)" },
  { value: "credential_vault", label: "Vault Token (credential_vault)" },
  { value: "credential_sendgrid", label: "SendGrid Token (credential_sendgrid)" },
  { value: "credential_nvidia", label: "NVIDIA API Key (credential_nvidia)" },
  { value: "credential_openrouter", label: "OpenRouter API Key (credential_openrouter)" },
  { value: "credential_kilo", label: "Kilo API Key (credential_kilo)" },
  { value: "authorization-header", label: "Authorization Header (authorization-header)" },
  { value: "bearer-token", label: "Bearer Token (bearer-token)" },
  { value: "api-key-prefixed", label: "Prefixed API Key (api-key-prefixed)" },
  { value: "credential_generic", label: "Generic Secret (credential_generic)" },
  // PII preset
  { value: "email", label: "Email Address (email)" },
  { value: "ssn", label: "US SSN (ssn)" },
  { value: "credit-card", label: "Credit Card (credit-card)" },
  { value: "phone-us", label: "US Phone (phone-us)" },
  { value: "phone-eu", label: "EU Phone (phone-eu)" },
  { value: "iban", label: "IBAN (iban)" },
  // Strict preset
  { value: "ipv4", label: "IPv4 Address (ipv4)" },
  { value: "ipv6", label: "IPv6 Address (ipv6)" },
  { value: "date-of-birth", label: "Date of Birth (date-of-birth)" },
  { value: "bsn-dutch", label: "Dutch BSN (bsn-dutch)" },
  { value: "ni-number-uk", label: "UK NI Number (ni-number-uk)" },
  { value: "passport-number", label: "Passport Number (passport-number)" },
];

// Common JSON paths for LLM API requests
const PATH_OPTIONS: { value: string; label: string }[] = [
  { value: "messages[*].content", label: "messages[*].content (OpenAI/Anthropic)" },
  { value: "messages[*].tool_calls[*].function.arguments", label: "messages[*].tool_calls[*].function.arguments" },
  { value: "messages[*].tool_calls[*].function.name", label: "messages[*].tool_calls[*].function.name" },
  { value: "messages[*].tool_calls[*].id", label: "messages[*].tool_calls[*].id" },
  { value: "messages[*].function_call.arguments", label: "messages[*].function_call.arguments" },
  { value: "messages[*].function_call.name", label: "messages[*].function_call.name" },
  { value: "messages[*].content[*].text", label: "messages[*].content[*].text (Anthropic)" },
  { value: "messages[*].content[*].input", label: "messages[*].content[*].input (Anthropic)" },
  { value: "prompt", label: "prompt (legacy/completions)" },
  { value: "input", label: "input (various)" },
  { value: "tools[*].function.parameters", label: "tools[*].function.parameters" },
  { value: "tool_choice", label: "tool_choice" },
  { value: "system", label: "system message" },
  { value: "$.messages[*].content", label: "$.messages[*].content (JSONPath)" },
  { value: "$..content", label: "$..content (recursive)" },
  { value: "custom", label: "Custom path..." },
];

export function FalsePositiveManager({
  onEntryAdded,
  onEntryRemoved,
  onCleared,
  initialData,
  onClose,
}: {
  onEntryAdded?: (entry: FalsePositiveEntry) => void;
  onEntryRemoved?: (entry: FalsePositiveEntry) => void;
  onCleared?: (cleared: number) => void;
  initialData?: {
    value: string;
    ruleId: string;
    label: string;
    path: string;
  };
  onClose?: () => void;
}) {
  const [falsePositives, setFalsePositives] = useState<FalsePositiveEntry[]>([]);
  const [pagination, setPagination] = useState<{
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  }>({
    page: 1,
    pageSize: 50,
    total: 0,
    totalPages: 1,
  });
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [form, setForm] = useState<FalsePositiveForm>({
    value: "",
    ruleId: "",
    label: "",
    path: "",
    customPath: "",
  });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Dialog open state - controlled by initialData presence
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  // Populate form with initial data when provided
  useEffect(() => {
    if (initialData) {
      // Find the matching rule option to get the correct label
      const ruleOption = RULE_OPTIONS.find(r => r.value === initialData.ruleId);
      // Find the matching path option
      const pathOption = PATH_OPTIONS.find(p => p.value === initialData.path);
      
      setForm({
        value: initialData.value,
        ruleId: initialData.ruleId,
        label: ruleOption ? ruleOption.label.split(" (")[0] : initialData.label,
        path: pathOption ? initialData.path : "custom",
        customPath: pathOption ? "" : initialData.path,
      });
      setIsDialogOpen(true);
    }
  }, [initialData]);

  const [deleteTarget, setDeleteTarget] = useState<{
    value: string;
    ruleId: string;
    sessionId?: string;
  } | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Load false positives on mount (only when not in "add new entry" mode)
  useEffect(() => {
    if (!initialData) {
      loadFalsePositives();
    }
  }, [initialData]);

  const loadFalsePositives = async (
    page?: number,
    ruleId?: string,
    sessionId?: string,
  ) => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await apiClient.getFalsePositives({
        page: page || 1,
        ruleId,
        sessionId,
      });
      setFalsePositives(result.falsePositives);
      setPagination({
        page: result.pagination.page,
        pageSize: result.pagination.pageSize,
        total: result.pagination.total,
        totalPages: result.pagination.totalPages,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to load false positives:", error);
      // Provide helpful message for common error cases
      if (errorMessage.includes("403") || errorMessage.includes("admin role required")) {
        setLoadError("Access denied: Admin role required. Please configure ADMIN_EMAILS environment variable and ensure you are logged in with an admin account.");
      } else if (errorMessage.includes("401") || errorMessage.includes("Unauthorized")) {
        setLoadError("Authentication required. Please log in to access false positives.");
      } else {
        setLoadError(`Failed to load false positives: ${errorMessage}`);
      }
    } finally {
      setLoading(false);
    }
  };

  // Reload when pagination changes externally (only when not in "add new entry" mode)
  useEffect(
    () => {
      if (!initialData) {
        loadFalsePositives(pagination.page);
      }
    },
    [pagination.page, initialData],
  );

  // Handle form submit
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormErrors({});

      if (!form.value || !form.ruleId || !form.label || !form.path) {
        setFormErrors({ required: "All fields are required" });
        return;
      }

      setCreating(true);
      try {
        const options = form.sessionId || form.matchMode
          ? { sessionId: form.sessionId, matchMode: form.matchMode }
          : undefined;
        const result = await apiClient.createFalsePositive(
          form.value,
          form.ruleId,
          form.label,
          form.path,
          options,
          undefined,
        );

        if (result.success && onEntryAdded) {
          onEntryAdded(result.falsePositive);
          setForm({
            value: "",
            ruleId: "",
            label: "",
            path: "",
            customPath: "",
          });
          setFormErrors({});
          setIsDialogOpen(false);
          loadFalsePositives();
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.error("Failed to create false positive:", error);
        if (errorMessage.includes("403") || errorMessage.includes("admin role required")) {
          setActionError("Access denied: Admin role required to create false positives.");
        } else if (errorMessage.includes("401") || errorMessage.includes("Unauthorized")) {
          setActionError("Authentication required. Please log in.");
        } else {
          setActionError(`Failed to create false positive: ${errorMessage}`);
        }
      } finally {
        setCreating(false);
      }
    },
    [form, formErrors, creating, onEntryAdded, loadFalsePositives],
  );

  // Handle delete
  const handleDelete = useCallback(
    async () => {
      if (!deleteTarget) return;
      // Find the full entry from the list to get all required properties
      const fullEntry = falsePositives.find(
        (fp) =>
          fp.value === deleteTarget.value &&
          fp.ruleId === deleteTarget.ruleId &&
          fp.sessionId === deleteTarget.sessionId
      );
      setDeleting(true);
      try {
        const result = await apiClient.deleteFalsePositive(
          deleteTarget.value,
          deleteTarget.ruleId,
          deleteTarget.sessionId,
        );

        if (result.success && onEntryRemoved && fullEntry) {
          onEntryRemoved({
            ...fullEntry,
            id: Date.now().toString(),
            timestamp: Date.now(),
          });
        }
        setDeleteDialogOpen(false);
        setDeleteTarget(null);
        loadFalsePositives();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.error("Failed to delete false positive:", error);
        if (errorMessage.includes("403") || errorMessage.includes("admin role required")) {
          setActionError("Access denied: Admin role required to delete false positives.");
        } else if (errorMessage.includes("401") || errorMessage.includes("Unauthorized")) {
          setActionError("Authentication required. Please log in.");
        } else {
          setActionError(`Failed to delete false positive: ${errorMessage}`);
        }
      } finally {
        setDeleting(false);
      }
    },
    [deleteTarget, onEntryRemoved, loadFalsePositives],
  );

  // Handle clear all
  const handleClearAll = useCallback(
    async () => {
      setClearing(true);
      setActionError(null);
      try {
        const result = await apiClient.clearFalsePositives({});
        if (result.success && onCleared) {
          onCleared(result.cleared);
        }
        loadFalsePositives();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.error("Failed to clear false positives:", error);
        if (errorMessage.includes("403") || errorMessage.includes("admin role required")) {
          setActionError("Access denied: Admin role required to clear false positives.");
        } else if (errorMessage.includes("401") || errorMessage.includes("Unauthorized")) {
          setActionError("Authentication required. Please log in.");
        } else {
          setActionError(`Failed to clear false positives: ${errorMessage}`);
        }
      } finally {
        setClearing(false);
      }
    },
    [onCleared, loadFalsePositives],
  );

  // Update form field
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const { name, value: val } = e.target;
      setForm((prev) => ({ ...prev, [name]: val }));
    },
    [],
  );

  // Update ruleId
  const handleRuleIdChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm((prev) => ({ ...prev, ruleId: e.target.value }));
    },
    [],
  );

  return (
    <div className="space-y-4">
      {/* Toolbar/actions */}
      <div className="flex flex-col sm:flex-row gap-3">
        <Button
          variant="outline"
          onClick={() => setIsDialogOpen(true)}
          disabled={loading || creating}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add False Positive
        </Button>

        <Button
          variant="destructive"
          onClick={handleClearAll}
          disabled={loading || clearing}
        >
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {clearing ? "Clearing..." : "Clear All"}
        </Button>
      </div>

      {/* Action Error Display */}
      {actionError && (
        <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg flex items-center justify-between">
          <span>{actionError}</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setActionError(null)}
            className="text-red-600 hover:text-red-800"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="p-4 text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto" />
          <p className="mt-2 text-muted-foreground">Loading false positives...</p>
        </div>
      ) : loadError ? (
        <div className="p-4 text-center text-red-600 bg-red-50 border border-red-200 rounded-lg">
          <p className="font-medium">Failed to load false positives</p>
          <p className="mt-2 text-sm">{loadError}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Configure ADMIN_EMAILS environment variable in the proxy service and ensure you are logged in with an admin account.
          </p>
          <Button
            variant="outline"
            onClick={() => loadFalsePositives()}
            className="mt-4"
            disabled={loading}
          >
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Retry
          </Button>
        </div>
      ) : falsePositives.length === 0 ? (
        <div className="p-4 text-center text-muted-foreground">
          No false positives recorded yet.<br />
<Button
          variant="outline"
          onClick={() => setIsDialogOpen(true)}
        >
            <Plus className="mr-2 h-4 w-4" />
            Add your first false positive
          </Button>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border rounded">
            <thead className="bg-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Value</th>
                <th className="px-3 py-2 text-left font-medium">Rule ID</th>
                <th className="px-3 py-2 text-left font-medium">Label</th>
                <th className="px-3 py-2 text-left font-medium">Path</th>
                <th className="px-3 py-2 text-left font-medium">Session</th>
                <th className="px-3 py-2 text-left font-medium">Match Mode</th>
                <th className="px-3 py-2 text-left font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {falsePositives.map((entry) => (
                <tr key={entry.id} className="border-y hover:bg-accent/50">
                  <td className="px-3 py-2 font-mono text-primary">
                    {entry.value}
                  </td>
                  <td className="px-3 py-2 font-mono text-sm text-muted-foreground">
                    {entry.ruleId}
                  </td>
                  <td className="px-3 py-2 font-medium text-primary/80">
                    {entry.label}
                  </td>
                  <td className="px-3 py-2 text-sm text-muted-foreground">
                    {entry.path || "-"}
                  </td>
                  <td className="px-3 py-2 text-sm text-muted-foreground">
                    {entry.sessionId ? entry.sessionId : "global"}
                  </td>
                  <td className="px-3 py-2 text-sm text-muted-foreground">
                    {entry.matchMode === "pattern" ? "pattern" : "exact"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Edit"
                        onClick={() => {
                          // Could add edit functionality later
                        }}
                      >
                        <Edit2 className="h-3 w-3" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Delete"
                        onClick={() => {
                          setDeleteTarget({
                            value: entry.value,
                            ruleId: entry.ruleId,
                            sessionId: entry.sessionId,
                          });
                          setDeleteDialogOpen(true);
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {pagination.total > pagination.pageSize && (
        <div className="mt-4 flex justify-between items-center">
          <p className="text-xs text-muted-foreground">
            Showing {pagination.page} of {pagination.totalPages} pages ({pagination.total} total)
          </p>
        </div>
      )}

      /* Create False Positive Dialog */}
      {initialData && isDialogOpen && (
        <Dialog open={isDialogOpen} onOpenChange={(open) => {
          setIsDialogOpen(open);
          if (!open && onClose) onClose();
        }}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Add False Positive</DialogTitle>
              <DialogDescription>
                Record a value that should be exempt from redaction.
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="fp-value">Value</Label>
                  <Input
                    id="fp-value"
                    name="value"
                    type="text"
                    value={form.value}
                    onChange={handleChange}
                    placeholder="e.g., test@example.com"
                    required
                  />
                  {formErrors.required && (
                    <p className="mt-1 text-sm text-red-600">All fields are required</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="fp-ruleId">Rule ID</Label>
                  <select
                    id="fp-ruleId"
                    name="ruleId"
                    value={form.ruleId}
                    onChange={(e) => setForm((prev) => ({ ...prev, ruleId: e.target.value }))}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    required
                  >
                    <option value="">Select a rule...</option>
                    {RULE_OPTIONS.map((rule) => (
                      <option key={rule.value} value={rule.value}>
                        {rule.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="fp-label">Label</Label>
                  <Input
                    id="fp-label"
                    name="label"
                    type="text"
                    value={form.label}
                    onChange={handleChange}
                    placeholder="e.g., test email address"
                    required
                  />
                </div>

                <div>
                  <Label htmlFor="fp-path">JSON Path</Label>
                  <div className="space-y-2">
                    <div className="relative">
                      <select
                        id="fp-path-select"
                        name="pathSelect"
                        value={form.path === "custom" ? "custom" : form.path}
                        onChange={(e) => {
                          const value = e.target.value;
                          if (value === "custom") {
                            setForm((prev) => ({ ...prev, path: "custom" }));
                          } else {
                            setForm((prev) => ({ ...prev, path: value }));
                          }
                        }}
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 appearance-none pr-10"
                        required
                      >
                        {PATH_OPTIONS.map((path) => (
                          <option key={path.value} value={path.value}>
                            {path.label}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                    </div>
                    {form.path === "custom" && (
                      <Input
                        id="fp-path-custom"
                        name="path"
                        type="text"
                        value={form.customPath || ""}
                        onChange={(e) => setForm((prev) => ({ ...prev, customPath: e.target.value, path: e.target.value }))}
                        placeholder="e.g., messages[*].content"
                        required
                      />
                    )}
                    {(form.path !== "custom" && form.path !== "") && (
                      <p className="text-xs text-muted-foreground">Selected: {PATH_OPTIONS.find(p => p.value === form.path)?.label || form.path}</p>
                    )}
                    {form.path === "" && (
                      <p className="text-xs text-muted-foreground">Select a common path or choose "Custom path..." to enter your own</p>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <Label htmlFor="fp-sessionId">Session ID (optional)</Label>
                <Input
                  id="fp-sessionId"
                  name="sessionId"
                  type="text"
                  value={form.sessionId || ""}
                  onChange={handleChange}
                  placeholder="Leave blank for global false positive"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Global false positives apply to all sessions. Provide a session ID
                  to scope this false positive to a specific session.
                </p>
              </div>

              <div>
                <Label htmlFor="fp-matchMode">Match Mode</Label>
                <div className="flex gap-2">
                  <label>
                    <input
                      type="radio"
                      name="matchMode"
                      value="exact"
                      checked={form.matchMode !== "pattern"}
                      onChange={handleRuleIdChange}
                      className="peer hidden"
                    />
                    Exact
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="matchMode"
                      value="pattern"
                      checked={form.matchMode === "pattern"}
                      onChange={handleRuleIdChange}
                      className="peer hidden"
                    />
                    Pattern
                  </label>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Exact: matches the exact value. Pattern: uses regex-like matching.
                </p>
              </div>

              <DialogFooter className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowCreateDialog(false)}
                  disabled={creating}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={creating}
                >
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {creating ? "Saving..." : "Add False Positive"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {/* Delete Confirmation Dialog */}
      {deleteTarget && deleteDialogOpen && (
        <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove False Positive</DialogTitle>
              <DialogDescription>
                Are you sure you want to remove this false positive entry?
              </DialogDescription>
            </DialogHeader>
            <p className="mt-4 text-sm text-muted-foreground">
              Value: <strong>{deleteTarget.value}</strong>
              <br />
              Rule ID: <strong>{deleteTarget.ruleId}</strong>
              {deleteTarget.sessionId && (
                <>
                  <br />
                  <span className="text-xs text-muted-foreground">
                    Session: {deleteTarget.sessionId}
                  </span>
                </>
              )}
            </p>
            <DialogFooter className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDeleteDialogOpen(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={deleting}
              >
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {deleting ? "Removing..." : "Remove"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}