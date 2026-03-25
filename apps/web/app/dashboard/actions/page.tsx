/**
 * Actions page -- pending action queue and executed action history.
 *
 * Shows two sections:
 * - Pending Actions: table with approve/reject buttons + bulk approve/reject
 * - Executed Actions: table with undo button (when undoable)
 *
 * Responsibilities:
 * - Fetch actions from /api/actions
 * - Approve, reject, and undo individual actions via API calls (supports concurrent ops)
 * - Display actions in categorized tables with loading spinners
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import type { ActionRow } from "@dublin/tools/src/types";
import { TOOL_LABELS } from "@dublin/tools/src/definitions";

// ============================================================================
// CONSTANTS
// ============================================================================

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
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
 * @returns The from/to string, truncated, or "-"
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
 * Table of pending actions with approve/reject buttons.
 * @param props.actions - Array of pending actions
 * @param props.onApprove - Callback when approve is clicked
 * @param props.onReject - Callback when reject is clicked
 * @param props.processingIds - Set of action IDs currently being processed
 */
function PendingActionsTable({
  actions,
  onApprove,
  onReject,
  processingIds,
}: {
  actions: ActionRow[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  processingIds: Set<string>;
}) {
  if (actions.length === 0) {
    return <p className="text-[13px] text-[var(--text-secondary)]">No pending actions.</p>;
  }

  return (
    <table className="w-full text-left text-[13px]">
      <thead>
        <tr className="border-b border-[var(--border-color)]">
          <th className="whitespace-nowrap pb-2 font-medium text-[var(--text-secondary)]">Tool</th>
          <th className="pb-2 font-medium text-[var(--text-secondary)]">From / To</th>
          <th className="pb-2 font-medium text-[var(--text-secondary)]">Subject</th>
          <th className="whitespace-nowrap pb-2 font-medium text-[var(--text-secondary)]">Created</th>
          <th className="whitespace-nowrap pb-2 font-medium text-[var(--text-secondary)]">Actions</th>
        </tr>
      </thead>
      <tbody>
        {actions.map((action) => {
          const isProcessing = processingIds.has(action.id);
          return (
            <tr key={action.id} className="border-b border-[var(--border-color)]">
              <td className="py-3 text-[13px]">{TOOL_LABELS[action.toolName] ?? action.toolName}</td>
              <td className="max-w-xs truncate py-3 text-[var(--text-secondary)]">{getContact(action.arguments)}</td>
              <td className="max-w-xs truncate py-3 text-[var(--text-secondary)]">{getSubject(action.arguments)}</td>
              <td className="py-3 text-[var(--text-secondary)]">
                {new Date(action.createdAt).toLocaleDateString("en-US", DATE_FORMAT)}
              </td>
              <td className="py-3">
                <div className="flex gap-2">
                  <button
                    onClick={() => onApprove(action.id)}
                    disabled={isProcessing}
                    className="inline-flex items-center gap-1 bg-[var(--btn-primary-bg)] px-3 py-1 text-xs font-medium text-[var(--btn-primary-text)] hover:bg-[var(--btn-primary-hover)] disabled:opacity-50"
                  >
                    {processingIds.has(action.id) ? <Spinner /> : "Approve"}
                  </button>
                  <button
                    onClick={() => onReject(action.id)}
                    disabled={isProcessing}
                    className="inline-flex items-center gap-1 bg-[var(--btn-secondary-bg)] px-3 py-1 text-xs font-medium text-[var(--btn-secondary-text)] border border-[var(--btn-secondary-border)] hover:bg-[var(--btn-secondary-hover)] disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Table of executed actions with optional undo button.
 * @param props.actions - Array of executed actions
 * @param props.onUndo - Callback when undo is clicked
 * @param props.processingIds - Set of action IDs currently being processed
 */
function ExecutedActionsTable({
  actions,
  onUndo,
  processingIds,
}: {
  actions: ActionRow[];
  onUndo: (id: string) => void;
  processingIds: Set<string>;
}) {
  if (actions.length === 0) {
    return <p className="text-[13px] text-[var(--text-secondary)]">No executed actions.</p>;
  }

  return (
    <table className="w-full text-left text-[13px]">
      <thead>
        <tr className="border-b border-[var(--border-color)]">
          <th className="w-[12%] pb-2 font-medium text-[var(--text-secondary)]">Tool</th>
          <th className="w-[25%] pb-2 font-medium text-[var(--text-secondary)]">From / To</th>
          <th className="w-[33%] pb-2 font-medium text-[var(--text-secondary)]">Subject</th>
          <th className="w-[15%] pb-2 font-medium text-[var(--text-secondary)]">Executed</th>
          <th className="w-[15%] pb-2 font-medium text-[var(--text-secondary)]">Actions</th>
        </tr>
      </thead>
      <tbody>
        {actions.map((action) => {
          const isProcessing = processingIds.has(action.id);
          return (
            <tr key={action.id} className="border-b border-[var(--border-color)]">
              <td className="py-3 text-[13px]">{TOOL_LABELS[action.toolName] ?? action.toolName}</td>
              <td className="max-w-xs truncate py-3 text-[var(--text-secondary)]">{getContact(action.arguments)}</td>
              <td className="max-w-xs truncate py-3 text-[var(--text-secondary)]">{getSubject(action.arguments)}</td>
              <td className="py-3 text-[var(--text-secondary)]">
                {action.executedAt
                  ? new Date(action.executedAt).toLocaleDateString("en-US", DATE_FORMAT)
                  : "-"}
              </td>
              <td className="py-3">
                {action.undoRecipe && action.status === "executed" ? (
                  <button
                    onClick={() => onUndo(action.id)}
                    disabled={isProcessing}
                    className="inline-flex items-center gap-1 bg-[var(--btn-secondary-bg)] px-3 py-1 text-xs font-medium text-[var(--btn-secondary-text)] border border-[var(--btn-secondary-border)] hover:bg-[var(--btn-secondary-hover)] disabled:opacity-50"
                  >
                    {isProcessing ? <Spinner /> : "Undo"}
                  </button>
                ) : (
                  <span className="text-xs text-[var(--text-secondary)]">
                    {action.status === "undone" ? "Undone" : "-"}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
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
      const res = await approveAction(actionId);
      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? "Failed to approve action");
        return;
      }
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
      const res = await rejectAction(actionId);
      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? "Failed to reject action");
        return;
      }
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
      const res = await undoActionRequest(actionId);
      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? "Failed to undo action");
        return;
      }
      await loadActions();
    } catch {
      setError("Failed to undo action");
    } finally {
      removeProcessing(actionId);
    }
  };

  const pendingActions = actions.filter((a) => a.status === "pending");
  const executedActions = actions.filter((a) => a.status === "executed" || a.status === "undone");

  if (loading) {
    return (
      <div className="flex-1 flex flex-col h-full">
        <div className="page-header">
          <h1>Actions</h1>
          <p>Manage the pending and executed actions of your session.</p>
        </div>
        <div className="page-content">
          <p className="text-[13px] text-[var(--text-secondary)]">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="page-header">
        <h1>Actions</h1>
        <p>Manage the pending and executed actions of your session.</p>
      </div>

      <div className="page-content">
        {error && (
          <div className="mb-6 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Pending Actions */}
        <section className="settings-panel">
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px 0" }}>
            Pending Actions ({pendingActions.length})
          </h2>
          <PendingActionsTable
            actions={pendingActions}
            onApprove={handleApprove}
            onReject={handleReject}
            processingIds={processingIds}
          />
        </section>

        {/* Executed Actions */}
        <section className="settings-panel">
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px 0" }}>
            Executed Actions ({executedActions.length})
          </h2>
          <ExecutedActionsTable
            actions={executedActions}
            onUndo={handleUndo}
            processingIds={processingIds}
          />
        </section>
      </div>
    </div>
  );
}
