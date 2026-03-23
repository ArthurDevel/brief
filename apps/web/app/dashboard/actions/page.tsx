/**
 * Actions page -- pending action queue and executed action history.
 *
 * Shows two sections:
 * - Pending Actions: table with approve/reject buttons
 * - Executed Actions: table with undo button (when undoable)
 *
 * Responsibilities:
 * - Fetch actions from /api/actions
 * - Approve, reject, and undo actions via API calls
 * - Display actions in categorized tables
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


// ============================================================================
// COMPONENTS
// ============================================================================

/**
 * Table of pending actions with approve/reject buttons.
 * @param props.actions - Array of pending actions
 * @param props.onApprove - Callback when approve is clicked
 * @param props.onReject - Callback when reject is clicked
 * @param props.loadingId - ID of the action currently being processed
 */
function PendingActionsTable({
  actions,
  onApprove,
  onReject,
  loadingId,
}: {
  actions: ActionRow[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  loadingId: string | null;
}) {
  if (actions.length === 0) {
    return <p className="text-sm text-gray-500">No pending actions.</p>;
  }

  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-gray-200">
          <th className="whitespace-nowrap pb-2 font-medium text-gray-500">Tool</th>
          <th className="pb-2 font-medium text-gray-500">From / To</th>
          <th className="pb-2 font-medium text-gray-500">Subject</th>
          <th className="whitespace-nowrap pb-2 font-medium text-gray-500">Created</th>
          <th className="whitespace-nowrap pb-2 font-medium text-gray-500">Actions</th>
        </tr>
      </thead>
      <tbody>
        {actions.map((action) => (
          <tr key={action.id} className="border-b border-gray-100">
            <td className="py-3 text-sm">{TOOL_LABELS[action.toolName] ?? action.toolName}</td>
            <td className="max-w-xs truncate py-3 text-gray-600">{getContact(action.arguments)}</td>
            <td className="max-w-xs truncate py-3 text-gray-600">{getSubject(action.arguments)}</td>
            <td className="py-3 text-gray-500">
              {new Date(action.createdAt).toLocaleDateString("en-US", DATE_FORMAT)}
            </td>
            <td className="py-3">
              <div className="flex gap-2">
                <button
                  onClick={() => onApprove(action.id)}
                  disabled={loadingId === action.id}
                  className="bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {loadingId === action.id ? "..." : "Approve"}
                </button>
                <button
                  onClick={() => onReject(action.id)}
                  disabled={loadingId === action.id}
                  className="bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Table of executed actions with optional undo button.
 * @param props.actions - Array of executed actions
 * @param props.onUndo - Callback when undo is clicked
 * @param props.loadingId - ID of the action currently being processed
 */
function ExecutedActionsTable({
  actions,
  onUndo,
  loadingId,
}: {
  actions: ActionRow[];
  onUndo: (id: string) => void;
  loadingId: string | null;
}) {
  if (actions.length === 0) {
    return <p className="text-sm text-gray-500">No executed actions.</p>;
  }

  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-gray-200">
          <th className="w-[12%] pb-2 font-medium text-gray-500">Tool</th>
          <th className="w-[25%] pb-2 font-medium text-gray-500">From / To</th>
          <th className="w-[33%] pb-2 font-medium text-gray-500">Subject</th>
          <th className="w-[15%] pb-2 font-medium text-gray-500">Executed</th>
          <th className="w-[15%] pb-2 font-medium text-gray-500">Actions</th>
        </tr>
      </thead>
      <tbody>
        {actions.map((action) => (
          <tr key={action.id} className="border-b border-gray-100">
            <td className="py-3 text-sm">{TOOL_LABELS[action.toolName] ?? action.toolName}</td>
            <td className="max-w-xs truncate py-3 text-gray-600">{getContact(action.arguments)}</td>
            <td className="max-w-xs truncate py-3 text-gray-600">{getSubject(action.arguments)}</td>
            <td className="py-3 text-gray-500">
              {action.executedAt
                ? new Date(action.executedAt).toLocaleDateString("en-US", DATE_FORMAT)
                : "-"}
            </td>
            <td className="py-3">
              {action.undoRecipe && action.status === "executed" ? (
                <button
                  onClick={() => onUndo(action.id)}
                  disabled={loadingId === action.id}
                  className="bg-yellow-600 px-3 py-1 text-xs font-medium text-white hover:bg-yellow-700 disabled:opacity-50"
                >
                  {loadingId === action.id ? "..." : "Undo"}
                </button>
              ) : (
                <span className="text-xs text-gray-400">
                  {action.status === "undone" ? "Undone" : "-"}
                </span>
              )}
            </td>
          </tr>
        ))}
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
  const [processingId, setProcessingId] = useState<string | null>(null);

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
    setProcessingId(actionId);
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
      setProcessingId(null);
    }
  };

  const handleReject = async (actionId: string) => {
    setProcessingId(actionId);
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
      setProcessingId(null);
    }
  };

  const handleUndo = async (actionId: string) => {
    setProcessingId(actionId);
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
      setProcessingId(null);
    }
  };

  const pendingActions = actions.filter((a) => a.status === "pending");
  const executedActions = actions.filter((a) => a.status === "executed" || a.status === "undone");

  if (loading) {
    return (
      <div>
        <h1 className="mb-8 text-3xl font-extrabold tracking-tight text-black">Actions</h1>
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-8 text-3xl font-extrabold tracking-tight text-black">Actions</h1>

      {error && (
        <div className="mb-6 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Pending Actions */}
      <section className="mb-10">
        <h2 className="mb-4 text-lg font-bold text-black">
          Pending Actions ({pendingActions.length})
        </h2>
        <div className="border border-gray-200 bg-white p-6">
          <PendingActionsTable
            actions={pendingActions}
            onApprove={handleApprove}
            onReject={handleReject}
            loadingId={processingId}
          />
        </div>
      </section>

      {/* Executed Actions */}
      <section>
        <h2 className="mb-4 text-lg font-bold text-black">
          Executed Actions ({executedActions.length})
        </h2>
        <div className="border border-gray-200 bg-white p-6">
          <ExecutedActionsTable
            actions={executedActions}
            onUndo={handleUndo}
            loadingId={processingId}
          />
        </div>
      </section>
    </div>
  );
}
