"use client";

import { useState, useEffect, useCallback } from "react";
import type { FalsePositiveEntry } from "@/types/api";
// @ts-ignore - false positive: imports used in JSX
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
// @ts-ignore - false positive: imports used in JSX
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button, Input, Label } from "@/components/ui";
import {
  Loader2,
  Trash2,
  Edit2,
  Plus,
} from "lucide-react";
import { useSearchParams, useRouter } from "next/navigation";
import { apiClient } from "@/lib/api";

type FalsePositiveForm = {
  value: string;
  ruleId: string;
  label: string;
  path: string;
  sessionId?: string;
  matchMode?: "exact" | "pattern";
};

export function FalsePositiveManager({
  onEntryAdded,
  onEntryRemoved,
  onCleared,
}: {
  onEntryAdded?: (entry: FalsePositiveEntry) => void;
  onEntryRemoved?: (entry: FalsePositiveEntry) => void;
  onCleared?: (cleared: number) => void;
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
  });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    value: string;
    ruleId: string;
    sessionId?: string;
  } | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Load false positives on mount
  useEffect(() => {
    loadFalsePositives();
  }, []);

  const loadFalsePositives = async (
    page?: number,
    ruleId?: string,
    sessionId?: string,
  ) => {
    setLoading(true);
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
      console.error("Failed to load false positives:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(loadFalsePositives, []);

  // Reload when pagination changes externally
  useEffect(
    () => {
      loadFalsePositives(pagination.page);
    },
    [pagination.page],
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
          });
          setFormErrors({});
          setShowCreateDialog(false);
          loadFalsePositives();
        }
      } catch (error) {
        console.error("Failed to create false positive:", error);
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
      setDeleting(true);
      try {
        const result = await apiClient.deleteFalsePositive(
          deleteTarget.value,
          deleteTarget.ruleId,
          deleteTarget.sessionId,
        );

        if (result.success && onEntryRemoved) {
          onEntryRemoved({
            ...deleteTarget,
            id: Date.now().toString(),
            timestamp: Date.now(),
          });
        }
        setDeleteDialogOpen(false);
        setDeleteTarget(null);
        loadFalsePositives();
      } catch (error) {
        console.error("Failed to delete false positive:", error);
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
      try {
        const result = await apiClient.clearFalsePositives({});
        if (result.success && onCleared) {
          onCleared(result.cleared);
        }
        loadFalsePositives();
      } catch (error) {
        console.error("Failed to clear false positives:", error);
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
          onClick={() => setShowCreateDialog(true)}
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

      {/* Table */}
      {loading ? (
        <div className="p-4 text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto" />
          <p className="mt-2 text-muted-foreground">Loading false positives...</p>
        </div>
      ) : falsePositives.length === 0 ? (
        <div className="p-4 text-center text-muted-foreground">
          No false positives recorded yet.<br />
          <Button
            variant="outline"
            onClick={() => setShowCreateDialog(true)}
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

      {/* Create False Positive Dialog */}
      {showCreateDialog && (
        <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
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
                  <Input
                    id="fp-ruleId"
                    name="ruleId"
                    type="text"
                    value={form.ruleId}
                    onChange={handleRuleIdChange}
                    placeholder="e.g., email"
                    required
                  />
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
                  <Input
                    id="fp-path"
                    name="path"
                    type="text"
                    value={form.path}
                    onChange={handleChange}
                    placeholder="e.g., messages[*].content"
                    required
                  />
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