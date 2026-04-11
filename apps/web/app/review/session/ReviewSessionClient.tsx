/**
 * Minimal client UI for token-backed session review.
 *
 * This page lets a recap email recipient approve or reject pending actions
 * without exposing the full authenticated dashboard.
 *
 * Responsibilities:
 * - Load minimal review data from the token-scoped API
 * - Approve/reject single pending actions
 * - Approve/reject all pending actions
 * - Refresh review data after each mutation
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock, Timer, Zap } from "lucide-react";
import type { BulkActionResponse } from "@dublin/tools";
import type {
  SessionReviewAction,
  SessionReviewResponse,
} from "@/lib/session-review";

// ============================================================================
// CONSTANTS
// ============================================================================

const BULK_KEY = "__bulk__";

// ============================================================================
// TYPES
// ============================================================================

interface ReviewSessionClientProps {
  token: string;
  focusActionId: string | null;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * Renders the minimal session review UI.
 * @param props - Review token and optional focused action ID
 * @returns React component
 */
export default function ReviewSessionClient({
  token,
  focusActionId,
}: ReviewSessionClientProps) {
  const [review, setReview] = useState<SessionReviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());

  const loadReview = useCallback(async () => {
    try {
      const response = await fetch(`/api/session-review?token=${encodeURIComponent(token)}`);
      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error ?? "Failed to load session review");
      }

      const data = await response.json() as SessionReviewResponse;
      setReview(data);
      setError(null);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Failed to load session review";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadReview();
  }, [loadReview]);

  const pendingActions = useMemo(
    () => review?.actions.filter((action) => action.status === "pending") ?? [],
    [review]
  );

  /**
   * Adds an action ID to the processing set.
   * @param id - Action ID or bulk marker
   */
  const addProcessing = (id: string) => {
    setProcessingIds((current) => new Set(current).add(id));
  };

  /**
   * Removes an action ID from the processing set.
   * @param id - Action ID or bulk marker
   */
  const removeProcessing = (id: string) => {
    setProcessingIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  /**
   * Sends a token-scoped approve or reject request.
   * @param actionIds - Action IDs to mutate
   * @param operation - Approve or reject operation
   * @param processingKey - Key to mark as processing
   */
  const mutateActions = async (
    actionIds: string[],
    operation: "approve" | "reject",
    processingKey: string
  ) => {
    addProcessing(processingKey);
    setError(null);

    try {
      const response = await fetch("/api/session-review/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, operation, actionIds }),
      });

      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }

      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error ?? `Failed to ${operation} actions`);
      }

      const result = await response.json() as BulkActionResponse;
      if (result.failed > 0) {
        setError(`${result.failed} of ${result.total} actions failed to ${operation}`);
      }

      await loadReview();
    } catch (mutationError) {
      const message = mutationError instanceof Error
        ? mutationError.message
        : `Failed to ${operation} actions`;
      setError(message);
    } finally {
      removeProcessing(processingKey);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="page-header">
          <div style={{ maxWidth: 700, margin: "0 auto" }}>
            <h1>Session Review</h1>
            <p>Approve or reject the actions from this voice session.</p>
          </div>
        </div>
        <div className="page-content">
          <div style={{ maxWidth: 700, margin: "0 auto" }}>
            <div className="settings-panel">
              <p className="text-[13px] text-[var(--text-secondary)]">Loading session review...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!review) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="page-header">
          <div style={{ maxWidth: 700, margin: "0 auto" }}>
            <h1>Session Review</h1>
            <p>Approve or reject the actions from this voice session.</p>
          </div>
        </div>
        <div className="page-content">
          <div style={{ maxWidth: 700, margin: "0 auto" }}>
            <div className="settings-panel">
              <p className="bg-red-50 p-4 text-sm text-red-700">
                {error ?? "Session review could not be loaded."}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const isBulkProcessing = processingIds.has(BULK_KEY);
  const isBusy = processingIds.size > 0;

  return (
    <div className="flex-1 flex flex-col">
      <div className="page-header">
        <div style={{ maxWidth: 700, margin: "0 auto" }}>
          <h1>Session Review</h1>
          <p>Approve or reject the actions from this voice session.</p>
        </div>
      </div>

      <div className="page-content">
        <div style={{ maxWidth: 700, margin: "0 auto" }}>
          <div className="mb-6 flex gap-2">
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)]"
              style={{ background: "var(--bg-hover)", border: "1px solid var(--border-color)" }}
            >
              <Clock size={12} />
              {formatRelativeTime(review.startedAt)}
            </span>
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)]"
              style={{ background: "var(--bg-hover)", border: "1px solid var(--border-color)" }}
            >
              <Timer size={12} />
              {formatDuration(review.durationSeconds)}
            </span>
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)]"
              style={{ background: "var(--bg-hover)", border: "1px solid var(--border-color)" }}
            >
              <Zap size={12} />
              {review.actions.length} action{review.actions.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="settings-panel">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 style={{ margin: "0 0 4px 0" }}>Actions</h2>
                <p className="text-[13px] text-[var(--text-secondary)]">
                  {formatDate(review.startedAt)} - {pendingActions.length} pending action{pendingActions.length === 1 ? "" : "s"} remaining
                </p>
              </div>

              {pendingActions.length > 0 && (
                <div className="settings-actions !mt-0 !mb-0">
                  <button
                    onClick={() => mutateActions(pendingActions.map((action) => action.id), "approve", BULK_KEY)}
                    disabled={isBusy}
                  >
                    {isBulkProcessing ? "Approving..." : "Approve All"}
                  </button>
                  <button
                    onClick={() => mutateActions(pendingActions.map((action) => action.id), "reject", BULK_KEY)}
                    disabled={isBusy}
                    style={{
                      background: "var(--btn-secondary-bg)",
                      color: "var(--btn-secondary-text)",
                      border: "1px solid var(--btn-secondary-border)",
                    }}
                  >
                    {isBulkProcessing ? "Rejecting..." : "Reject All"}
                  </button>
                </div>
              )}
            </div>

            {error && (
              <div className="mb-6 bg-red-50 p-4 text-sm text-red-700">
                {error}
              </div>
            )}

            {pendingActions.length > 0 ? (
              <ActionsTable
                actions={review.actions}
                focusActionId={focusActionId}
                processingIds={processingIds}
                isBulkProcessing={isBulkProcessing}
                onApprove={(actionId) => mutateActions([actionId], "approve", actionId)}
                onReject={(actionId) => mutateActions([actionId], "reject", actionId)}
              />
            ) : (
              <div
                className="p-6"
                style={{ background: "var(--bg-hover)", border: "1px solid var(--border-color)" }}
              >
                <h2 style={{ margin: "0 0 8px 0" }}>All set!</h2>
                <p className="text-sm text-[var(--text-secondary)]">
                  There are no pending actions left for this session.
                </p>
              </div>
            )}

            <div className="settings-actions">
              <a
                href="/dashboard"
                style={{
                  background: "var(--btn-primary-bg)",
                  color: "var(--btn-primary-text)",
                  padding: "8px 16px",
                  fontSize: 13,
                  fontWeight: 500,
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                }}
                className="hover:opacity-90 transition-opacity"
              >
                Go to dashboard
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// COMPONENTS
// ============================================================================

/**
 * Renders the minimal action table.
 * @param props - Action rows and handlers
 * @returns React component
 */
function ActionsTable({
  actions,
  focusActionId,
  processingIds,
  isBulkProcessing,
  onApprove,
  onReject,
}: {
  actions: SessionReviewAction[];
  focusActionId: string | null;
  processingIds: Set<string>;
  isBulkProcessing: boolean;
  onApprove: (actionId: string) => void;
  onReject: (actionId: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--border-color)]">
            <th className="px-4 py-3 font-medium text-[var(--text-secondary)]">Action</th>
            <th className="px-4 py-3 font-medium text-[var(--text-secondary)]">From / To</th>
            <th className="px-4 py-3 font-medium text-[var(--text-secondary)]">Subject</th>
            <th className="px-4 py-3 font-medium text-[var(--text-secondary)]">Status</th>
            <th className="px-4 py-3 font-medium text-[var(--text-secondary)]">Review</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((action) => {
            const isPending = action.status === "pending";
            const isProcessing = processingIds.has(action.id) || isBulkProcessing;
            const isFocused = focusActionId === action.id;

            return (
              <tr
                key={action.id}
                className={`border-b border-[var(--border-color)] last:border-b-0 ${isFocused ? "bg-yellow-50" : ""}`}
              >
                <td className="px-4 py-3 font-medium text-[var(--text-primary)]">
                  {action.label}
                </td>
                <td className="max-w-xs truncate px-4 py-3 text-[var(--text-secondary)]">
                  {action.contact}
                </td>
                <td className="max-w-sm truncate px-4 py-3 text-[var(--text-secondary)]">
                  {action.subject}
                </td>
                <td className="px-4 py-3">
                  <span className={getStatusClassName(action.status)}>
                    {action.status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {isPending ? (
                    <div className="flex gap-2">
                      <button
                        onClick={() => onApprove(action.id)}
                        disabled={isProcessing}
                        style={{
                          background: "var(--btn-primary-bg)",
                          color: "var(--btn-primary-text)",
                          padding: "6px 12px",
                          fontSize: 12,
                          fontWeight: 500,
                          border: "none",
                        }}
                        className="hover:bg-[var(--btn-primary-hover)] disabled:opacity-50 transition-colors"
                      >
                        {processingIds.has(action.id) ? "Approving..." : "Approve"}
                      </button>
                      <button
                        onClick={() => onReject(action.id)}
                        disabled={isProcessing}
                        style={{
                          background: "var(--btn-secondary-bg)",
                          color: "var(--btn-secondary-text)",
                          padding: "6px 12px",
                          fontSize: 12,
                          fontWeight: 500,
                          border: "1px solid var(--btn-secondary-border)",
                        }}
                        className="hover:bg-[var(--btn-secondary-hover)] disabled:opacity-50 transition-colors"
                      >
                        Reject
                      </button>
                    </div>
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
// HELPER FUNCTIONS
// ============================================================================

/**
 * Formats a session date for display.
 * @param value - ISO timestamp
 * @returns Human-readable date
 */
function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/**
 * Formats a short relative time label for the session badges.
 * @param value - ISO timestamp
 * @returns Relative time string
 */
function formatRelativeTime(value: string): string {
  const now = new Date();
  const date = new Date(value);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "Yesterday";
  return `${diffDays} days ago`;
}

/**
 * Formats session duration.
 * @param seconds - Duration in seconds or null
 * @returns Short duration label
 */
function formatDuration(seconds: number | null): string {
  if (seconds === null) return "In progress";

  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);

  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

/**
 * Returns status badge classes.
 * @param status - Action status
 * @returns CSS class list
 */
function getStatusClassName(status: SessionReviewAction["status"]): string {
  const base = "px-2 py-0.5 text-xs font-bold";

  if (status === "pending") {
    return `${base} bg-amber-100 text-amber-700`;
  }

  if (status === "executed") {
    return `${base} bg-green-100 text-green-700`;
  }

  if (status === "rejected") {
    return `${base} bg-red-100 text-red-700`;
  }

  if (status === "failed") {
    return `${base} bg-orange-100 text-orange-700`;
  }

  return `${base} bg-gray-100 text-gray-600`;
}
