/**
 * Dashboard overview page.
 *
 * Shows the most recent session with its pending actions,
 * followed by two previous session summary cards.
 *
 * Responsibilities:
 * - Fetch recent sessions from /api/sessions
 * - Fetch pending actions from /api/actions?status=pending
 * - Display most recent session with inline approve/reject
 * - Display previous session cards linking to their detail pages
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import type { SessionSummary } from "@/lib/types";
import type { ActionRow } from "@dublin/tools/src/types";

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
 * Summarizes action arguments into a short display string.
 * @param args - The action arguments object
 * @returns A short summary string
 */
function summarizeArguments(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "-";

  return entries
    .map(([key, value]) => {
      const strValue = typeof value === "string" ? value : JSON.stringify(value);
      const truncated = strValue.length > 40 ? strValue.substring(0, 40) + "..." : strValue;
      return `${key}: ${truncated}`;
    })
    .join(", ");
}

// ============================================================================
// COMPONENTS
// ============================================================================

/**
 * Displays the most recent session with its pending actions.
 * @param props.session - The most recent session summary
 * @param props.pendingActions - Pending actions for this session
 * @param props.processingId - ID of action currently being processed
 * @param props.onApprove - Callback to approve an action
 * @param props.onReject - Callback to reject an action
 */
function RecentSessionCard({
  session,
  pendingActions,
  processingId,
  onApprove,
  onReject,
}: {
  session: SessionSummary;
  pendingActions: ActionRow[];
  processingId: string | null;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
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

      {/* Pending actions for this session */}
      {pendingActions.length > 0 ? (
        <>
          <h3 className="mb-3 text-sm font-medium text-gray-700">
            Pending Actions ({pendingActions.length})
          </h3>
          <div
            className={
              pendingActions.length > MAX_VISIBLE_ACTIONS
                ? "max-h-[440px] overflow-y-auto"
                : ""
            }
          >
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-white">
                <tr className="border-b border-gray-200">
                  <th className="pb-2 font-medium text-gray-500">Tool</th>
                  <th className="pb-2 font-medium text-gray-500">Arguments</th>
                  <th className="pb-2 font-medium text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pendingActions.map((action) => (
                  <tr key={action.id} className="border-b border-gray-100">
                    <td className="py-3 font-mono text-xs">{action.toolName}</td>
                    <td className="py-3 text-gray-600">
                      {summarizeArguments(action.arguments)}
                    </td>
                    <td className="py-3">
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="text-sm text-gray-500">No pending actions for this session.</p>
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
  const [pendingActions, setPendingActions] = useState<ActionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [sessionsRes, actionsRes] = await Promise.all([
        fetch("/api/sessions"),
        fetch("/api/actions?status=pending"),
      ]);

      if (sessionsRes.ok) {
        const sessionsData: SessionSummary[] = await sessionsRes.json();
        setSessions(sessionsData.slice(0, 3));
      }

      if (actionsRes.ok) {
        const actionsData: ActionRow[] = await actionsRes.json();
        setPendingActions(actionsData);
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

  // Filter pending actions per session
  const mostRecentPending = mostRecent
    ? pendingActions.filter((a) => a.sessionId === mostRecent.id)
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
            pendingActions={mostRecentPending}
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
              hasPendingActions={pendingActions.some((a) => a.sessionId === session.id)}
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
