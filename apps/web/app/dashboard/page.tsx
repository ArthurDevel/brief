/**
 * Dashboard overview page.
 *
 * Shows the most recent session with all its actions (pending on top,
 * then chronologically oldest first), followed by two previous session
 * summary cards.
 *
 * Responsibilities:
 * - Fetch recent sessions from /api/sessions
 * - Fetch all actions from /api/actions
 * - Display most recent session with inline approve/reject for pending actions
 * - Display previous session cards linking to their detail pages
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import type { SessionSummary } from "@/lib/types";
import type { ActionRow } from "@dublin/tools/src/types";
import { TOOL_LABELS } from "@dublin/tools/src/definitions";

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_VISIBLE_ACTIONS = 10;

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Formats a duration in seconds to a short string.
 * @param seconds - Duration in seconds, or null
 * @returns Formatted duration (e.g. "5m 30s")
 */
function formatDuration(seconds: number | null): string {
  if (seconds === null) return "In progress";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

/**
 * Formats a relative time description (e.g. "2 hours ago", "yesterday").
 * @param dateStr - ISO date string
 * @returns Human-readable relative time
 */
function formatRelativeTime(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
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
 * Sorts actions: pending first, then non-pending ordered by createdAt ascending (oldest first).
 * @param actions - Array of actions to sort
 * @returns Sorted copy of the array
 */
function sortActions(actions: ActionRow[]): ActionRow[] {
  return [...actions].sort((a, b) => {
    const aIsPending = a.status === "pending" ? 0 : 1;
    const bIsPending = b.status === "pending" ? 0 : 1;
    if (aIsPending !== bIsPending) return aIsPending - bIsPending;
    // Within the same group, sort oldest first
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

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

/** Status color mapping for action badges. */
const STATUS_STYLES: Record<string, string> = {
  approved: "bg-blue-100 text-blue-700",
  executed: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
  undone: "bg-gray-100 text-gray-600",
};

/**
 * Renders a colored badge for an action status.
 * @param props.status - The action status string
 */
function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? "bg-gray-100 text-gray-600";
  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-medium capitalize ${style}`}>
      {status}
    </span>
  );
}

/**
 * Displays the most recent session with all its actions.
 * Pending actions show approve/reject buttons; others show their status.
 * @param props.session - The most recent session summary
 * @param props.actions - All actions for this session, sorted (pending first)
 * @param props.processingId - ID of action currently being processed
 * @param props.onApprove - Callback to approve an action
 * @param props.onReject - Callback to reject an action
 */
function RecentSessionCard({
  session,
  actions,
  processingId,
  onApprove,
  onReject,
}: {
  session: SessionSummary;
  actions: ActionRow[];
  processingId: string | null;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const pendingCount = actions.filter((a) => a.status === "pending").length;

  return (
    <div className="border border-gray-200 bg-white p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-bold text-black">Most Recent Session</h2>
        <Link
          href={`/dashboard/sessions/${session.id}`}
          className="text-sm font-medium text-black hover:underline"
        >
          View full session
        </Link>
      </div>

      {/* Session metadata */}
      <div className="mb-4 flex gap-6 text-sm text-gray-600">
        <span>
          {new Date(session.startedAt).toLocaleDateString("en-US", DATE_FORMAT)}
          {" "}({formatRelativeTime(session.startedAt)})
        </span>
        <span>Duration: {formatDuration(session.durationSeconds)}</span>
        <span>{session.actionCount} action{session.actionCount !== 1 ? "s" : ""}</span>
      </div>

      {/* Actions for this session */}
      {actions.length > 0 ? (
        <>
          <h3 className="mb-3 text-sm font-medium text-gray-700">
            Actions ({actions.length}){pendingCount > 0 && ` -- ${pendingCount} pending`}
          </h3>
          <div
            className={
              actions.length > MAX_VISIBLE_ACTIONS
                ? "max-h-[440px] overflow-y-auto"
                : ""
            }
          >
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-white">
                <tr className="border-b border-gray-200">
                  <th className="whitespace-nowrap pb-2 font-medium text-gray-500">Tool</th>
                  <th className="pb-2 font-medium text-gray-500">From / To</th>
                  <th className="pb-2 font-medium text-gray-500">Subject</th>
                  <th className="whitespace-nowrap pb-2 font-medium text-gray-500">Status</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((action) => (
                  <tr key={action.id} className="border-b border-gray-100">
                    <td className="py-3 text-sm">{TOOL_LABELS[action.toolName] ?? action.toolName}</td>
                    <td className="max-w-xs truncate py-3 text-gray-600">{getContact(action.arguments)}</td>
                    <td className="max-w-xs truncate py-3 text-gray-600">{getSubject(action.arguments)}</td>
                    <td className="py-3">
                      {action.status === "pending" ? (
                        <div className="flex gap-2">
                          <button
                            onClick={() => onApprove(action.id)}
                            disabled={processingId === action.id}
                            className="bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                          >
                            {processingId === action.id ? "..." : "Approve"}
                          </button>
                          <button
                            onClick={() => onReject(action.id)}
                            disabled={processingId === action.id}
                            className="bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </div>
                      ) : (
                        <StatusBadge status={action.status} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="text-sm text-gray-500">No actions for this session.</p>
      )}
    </div>
  );
}

/**
 * A compact card for a previous session.
 * @param props.session - The session to display
 * @param props.hasPendingActions - Whether this session has pending actions
 */
function PreviousSessionCard({
  session,
  hasPendingActions,
}: {
  session: SessionSummary;
  hasPendingActions: boolean;
}) {
  return (
    <Link href={`/dashboard/sessions/${session.id}`} className="block">
      <div className="border border-gray-200 bg-white p-6 hover:border-black">
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">
            {new Date(session.startedAt).toLocaleDateString("en-US", DATE_FORMAT)}
          </span>
          {hasPendingActions && (
            <span className="bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">
              Pending actions
            </span>
          )}
        </div>
        <div className="mt-2 flex gap-4 text-sm text-gray-500">
          <span>{formatDuration(session.durationSeconds)}</span>
          <span>{session.actionCount} action{session.actionCount !== 1 ? "s" : ""}</span>
        </div>
      </div>
    </Link>
  );
}

// ============================================================================
// RENDER
// ============================================================================

export default function DashboardOverviewPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [allActions, setAllActions] = useState<ActionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [sessionsRes, actionsRes] = await Promise.all([
        fetch("/api/sessions"),
        fetch("/api/actions"),
      ]);

      if (sessionsRes.ok) {
        const sessionsData: SessionSummary[] = await sessionsRes.json();
        setSessions(sessionsData.slice(0, 3));
      }

      if (actionsRes.ok) {
        const actionsData: ActionRow[] = await actionsRes.json();
        setAllActions(actionsData);
      }
    } catch {
      // Non-fatal for overview
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleApprove = async (actionId: string) => {
    setProcessingId(actionId);
    try {
      const res = await fetch(`/api/actions/${actionId}/approve`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? "Failed to approve action");
        return;
      }
      await loadData();
    } catch {
      setError("Failed to approve action");
    } finally {
      setProcessingId(null);
    }
  };

  const handleReject = async (actionId: string) => {
    setProcessingId(actionId);
    try {
      const res = await fetch(`/api/actions/${actionId}/reject`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? "Failed to reject action");
        return;
      }
      await loadData();
    } catch {
      setError("Failed to reject action");
    } finally {
      setProcessingId(null);
    }
  };

  if (loading) {
    return (
      <div>
        <h1 className="mb-8 text-3xl font-extrabold tracking-tight text-black">Overview</h1>
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  const mostRecent = sessions[0] ?? null;
  const previousSessions = sessions.slice(1, 3);

  // Filter actions for the most recent session, sorted: pending first, then oldest first
  const mostRecentActions = mostRecent
    ? sortActions(allActions.filter((a) => a.sessionId === mostRecent.id))
    : [];

  return (
    <div>
      <h1 className="mb-8 text-3xl font-extrabold tracking-tight text-black">Overview</h1>

      {error && (
        <div className="mb-6 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}

      {/* Most recent session */}
      {mostRecent ? (
        <div className="mb-6">
          <RecentSessionCard
            session={mostRecent}
            actions={mostRecentActions}
            processingId={processingId}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        </div>
      ) : (
        <div className="mb-6 border border-gray-200 bg-white p-6">
          <p className="text-sm text-gray-500">No sessions yet.</p>
        </div>
      )}

      {/* Previous sessions */}
      {previousSessions.length > 0 && (
        <div className="mb-6 flex flex-col gap-4">
          {previousSessions.map((session) => (
            <PreviousSessionCard
              key={session.id}
              session={session}
              hasPendingActions={allActions.some((a) => a.sessionId === session.id && a.status === "pending")}
            />
          ))}
        </div>
      )}

      {/* All Sessions button */}
      <Link
        href="/dashboard/sessions"
        className="group inline-flex items-center gap-2 border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-gray-50"
      >
        All Sessions <span className="transition-transform group-hover:translate-x-1">&rarr;</span>
      </Link>
    </div>
  );
}
