/**
 * Actions page -- single chronological table of all actions.
 *
 * Responsibilities:
 * - Fetch actions from /api/actions
 * - Approve, reject, and undo individual actions via API calls
 * - Display all actions in one table with status badges
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import type { ActionRow } from "@dublin/tools/src/types";
import { TOOL_LABELS } from "@dublin/tools/src/definitions";
import SendEmailModal from "../components/SendEmailModal";

// ============================================================================
// CONSTANTS
// ============================================================================

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

const STATUS_STYLES: Record<string, string> = {
  executed: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
  undone: "bg-yellow-100 text-yellow-700",
  failed: "bg-orange-100 text-orange-700",
  converted: "bg-blue-100 text-blue-700",
};

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Fetches all actions from the API.
 * @returns Array of ActionRow DTOs
 */
async function fetchActions(): Promise<ActionRow[]> {
  const res = await fetch("/api/actions");
  if (!res.ok) {
    throw new Error("Failed to fetch actions");
  }
  return res.json();
}

/**
 * Approves a pending action.
 * @param actionId - The action ID to approve
 * @returns The API response
 */
async function approveAction(actionId: string): Promise<Response> {
  return fetch(`/api/actions/${actionId}/approve`, { method: "POST" });
}

/**
 * Rejects a pending action.
 * @param actionId - The action ID to reject
 * @returns The API response
 */
async function rejectAction(actionId: string): Promise<Response> {
  return fetch(`/api/actions/${actionId}/reject`, { method: "POST" });
}

/**
 * Undoes an executed action.
 * @param actionId - The action ID to undo
 * @returns The API response
 */
async function undoActionRequest(actionId: string): Promise<Response> {
  return fetch(`/api/actions/${actionId}/undo`, { method: "POST" });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Extracts the "from" or "to" field from action arguments.
 * @param args - The action arguments object
 * @returns The from/to string or "-"
 */
function getContact(args: Record<string, unknown>): string {
  const value = (args.from ?? args.to) as string | undefined;
  return value ?? "-";
}

/**
 * Extracts the subject field from action arguments.
 * @param args - The action arguments object
 * @returns The subject string or "-"
 */
function getSubject(args: Record<string, unknown>): string {
  const value = args.subject as string | undefined;
  return value ?? "-";
}

/**
 * Small inline spinner for loading states.
 */
function Spinner() {
  return (
    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
  );
}

// ============================================================================
// COMPONENTS
// ============================================================================

/**
 * Single table of all actions sorted chronologically (newest first).
 * @param props.actions - All actions
 * @param props.onApprove - Callback when approve is clicked
 * @param props.onReject - Callback when reject is clicked
 * @param props.onUndo - Callback when undo is clicked
 * @param props.processingIds - Set of action IDs currently being processed
 * @param props.onRowClick - Callback when a send_email row is clicked
 */
function ActionsTable({
  actions,
  onApprove,
  onReject,
  onUndo,
  processingIds,
  onRowClick,
}: {
  actions: ActionRow[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onUndo: (id: string) => void;
  processingIds: Set<string>;
  onRowClick: (action: ActionRow) => void;
}) {
  if (actions.length === 0) {
    return <p className="text-[13px] text-[var(--text-secondary)]">No actions.</p>;
  }

  // Sort chronologically, newest first
  const sorted = [...actions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px] min-w-[800px]">
        <thead>
          <tr className="border-b border-[var(--border-color)]">
            <th className="whitespace-nowrap pb-2 pr-6 font-medium text-[var(--text-secondary)]">Tool</th>
            <th className="pb-2 pr-6 font-medium text-[var(--text-secondary)]">From / To</th>
            <th className="pb-2 pr-6 font-medium text-[var(--text-secondary)]">Subject</th>
            <th className="whitespace-nowrap pb-2 pr-6 font-medium text-[var(--text-secondary)]">Status</th>
            <th className="whitespace-nowrap pb-2 pr-6 font-medium text-[var(--text-secondary)]">Date</th>
            <th className="whitespace-nowrap pb-2 font-medium text-[var(--text-secondary)]">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((action) => {
            const isProcessing = processingIds.has(action.id);
            const isSendEmail = action.toolName === "send_email";
            return (
              <tr
                key={action.id}
                className={`border-b border-[var(--border-color)]${isSendEmail ? " cursor-pointer hover:bg-[var(--bg-hover)]" : ""}`}
                onClick={(e) => {
                  if (!isSendEmail) return;
                  if ((e.target as HTMLElement).closest("button")) return;
                  onRowClick(action);
                }}
              >
                <td className="py-3 pr-6 text-[13px]">{TOOL_LABELS[action.toolName] ?? action.toolName}</td>
                <td className="max-w-xs truncate py-3 pr-6 text-[var(--text-secondary)]">{getContact(action.arguments)}</td>
                <td className="max-w-xs truncate py-3 pr-6 text-[var(--text-secondary)]">{getSubject(action.arguments)}</td>
                <td className="py-3 pr-6">
                  <span
                    className={`px-2 py-0.5 text-xs font-bold ${STATUS_STYLES[action.status] ?? "bg-gray-100 text-gray-600"}`}
                    title={action.status === "failed" ? (action.result?.error as string) : undefined}
                  >
                    {action.status}
                  </span>
                </td>
                <td className="py-3 pr-6 text-[var(--text-secondary)] whitespace-nowrap">
                  {new Date(action.createdAt).toLocaleDateString("en-US", DATE_FORMAT)}
                </td>
                <td className="py-3 whitespace-nowrap">
                  {action.status === "pending" ? (
                    <div className="flex gap-2">
                      <button
                        onClick={() => onApprove(action.id)}
                        disabled={isProcessing}
                        className="inline-flex items-center gap-1 bg-[var(--btn-primary-bg)] px-3 py-1 text-xs font-medium text-[var(--btn-primary-text)] hover:bg-[var(--btn-primary-hover)] disabled:opacity-50"
                      >
                        {isProcessing ? <Spinner /> : "Approve"}
                      </button>
                      <button
                        onClick={() => onReject(action.id)}
                        disabled={isProcessing}
                        className="inline-flex items-center gap-1 bg-[var(--btn-secondary-bg)] px-3 py-1 text-xs font-medium text-[var(--btn-secondary-text)] border border-[var(--btn-secondary-border)] hover:bg-[var(--btn-secondary-hover)] disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </div>
                  ) : action.undoRecipe && action.status === "executed" ? (
                    <button
                      onClick={() => onUndo(action.id)}
                      disabled={isProcessing}
                      className="inline-flex items-center gap-1 bg-[var(--btn-secondary-bg)] px-3 py-1 text-xs font-medium text-[var(--btn-secondary-text)] border border-[var(--btn-secondary-border)] hover:bg-[var(--btn-secondary-hover)] disabled:opacity-50"
                    >
                      {isProcessing ? <Spinner /> : "Undo"}
                    </button>
                  ) : (
                    <span className="text-xs text-[var(--text-secondary)]">-</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================================
// RENDER
// ============================================================================

export default function ActionsPage() {
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [selectedAction, setSelectedAction] = useState<ActionRow | null>(null);
  const [isConverting, setIsConverting] = useState(false);

  /**
   * Adds an ID to the processing set.
   * @param id - The action ID to mark as processing
   */
  const addProcessing = (id: string) => {
    setProcessingIds((prev) => new Set(prev).add(id));
  };

  /**
   * Removes an ID from the processing set.
   * @param id - The action ID to remove from processing
   */
  const removeProcessing = (id: string) => {
    setProcessingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const loadActions = useCallback(async () => {
    try {
      const data = await fetchActions();
      setActions(data);
      setError(null);
    } catch {
      setError("Failed to load actions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadActions();
  }, [loadActions]);

  const handleApprove = async (actionId: string) => {
    addProcessing(actionId);
    try {
      await approveAction(actionId);
      await loadActions();
    } catch {
      setError("Failed to approve action");
    } finally {
      removeProcessing(actionId);
    }
  };

  const handleReject = async (actionId: string) => {
    addProcessing(actionId);
    try {
      await rejectAction(actionId);
      await loadActions();
    } catch {
      setError("Failed to reject action");
    } finally {
      removeProcessing(actionId);
    }
  };

  const handleUndo = async (actionId: string) => {
    addProcessing(actionId);
    try {
      await undoActionRequest(actionId);
      await loadActions();
    } catch {
      setError("Failed to undo action");
    } finally {
      removeProcessing(actionId);
    }
  };

  /**
   * Converts a pending send_email action to a draft in the user's mailbox.
   * @param actionId - The action ID to convert
   */
  const handleConvertToDraft = async (actionId: string) => {
    setIsConverting(true);
    try {
      const res = await fetch(`/api/actions/${actionId}/convert-to-draft`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json();
        alert(body.error ?? "Failed to convert to draft");
        return;
      }
      await loadActions();
      setSelectedAction(null);
    } catch {
      alert("Failed to convert to draft");
    } finally {
      setIsConverting(false);
    }
  };

  /** Approve action from modal, then close */
  const handleModalApprove = async (actionId: string) => {
    await handleApprove(actionId);
    setSelectedAction(null);
  };

  /** Reject action from modal, then close */
  const handleModalReject = async (actionId: string) => {
    await handleReject(actionId);
    setSelectedAction(null);
  };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="page-header">
          <h1>Actions</h1>
          <p>Manage your actions.</p>
        </div>
        <div className="page-content">
          <p className="text-[13px] text-[var(--text-secondary)]">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col">
      <div className="page-header">
        <h1>Actions</h1>
        <p>Manage your actions.</p>
      </div>

      <div className="page-content">
        {error && (
          <div className="mb-6 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        <section className="settings-panel">
          <ActionsTable
            actions={actions}
            onApprove={handleApprove}
            onReject={handleReject}
            onUndo={handleUndo}
            processingIds={processingIds}
            onRowClick={setSelectedAction}
          />
        </section>
      </div>

      <SendEmailModal
        action={selectedAction}
        onClose={() => setSelectedAction(null)}
        onApprove={handleModalApprove}
        onReject={handleModalReject}
        onConvert={handleConvertToDraft}
        isProcessing={isConverting || (selectedAction ? processingIds.has(selectedAction.id) : false)}
      />
    </div>
  );
}
