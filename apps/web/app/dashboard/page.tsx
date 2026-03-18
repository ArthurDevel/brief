/**
 * Dashboard overview page.
 *
 * Shows a summary of the user's recent activity, pending approvals,
 * and current usage. Fetches real data from API endpoints.
 *
 * Responsibilities:
 * - Fetch recent sessions from /api/sessions
 * - Fetch pending actions count from /api/actions?status=pending
 * - Fetch usage from /api/billing/usage
 * - Display summary cards
 */

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { UsageInfo, SessionSummary } from "@/lib/types";
import type { ActionRow } from "@dublin/tools/src/types";

// ============================================================================
// CONSTANTS
// ============================================================================

const RECENT_SESSIONS_LIMIT = 3;

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

// ============================================================================
// RENDER
// ============================================================================

export default function DashboardOverviewPage() {
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        // Fetch all data in parallel
        const [usageRes, sessionsRes, actionsRes] = await Promise.all([
          fetch("/api/billing/usage"),
          fetch("/api/sessions"),
          fetch("/api/actions?status=pending"),
        ]);

        if (usageRes.ok) {
          const usageData: UsageInfo = await usageRes.json();
          setUsage(usageData);
        }

        if (sessionsRes.ok) {
          const sessionsData: SessionSummary[] = await sessionsRes.json();
          setSessions(sessionsData.slice(0, RECENT_SESSIONS_LIMIT));
        }

        if (actionsRes.ok) {
          const actionsData: ActionRow[] = await actionsRes.json();
          setPendingCount(actionsData.length);
        }
      } catch {
        // Errors are non-fatal for the overview -- display what we can
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div>
        <h1 className="mb-8 text-2xl font-bold text-gray-900">Overview</h1>
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  const usagePercent = usage && usage.hoursLimit > 0
    ? Math.round((usage.hoursUsed / usage.hoursLimit) * 100)
    : 0;

  return (
    <div>
      <h1 className="mb-8 text-2xl font-bold text-gray-900">Overview</h1>

      {/* Summary cards */}
      <div className="mb-8 grid grid-cols-1 gap-6 md:grid-cols-3">
        {/* Recent Calls */}
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="text-sm font-medium text-gray-500">Recent Calls</h3>
          <p className="mt-2 text-3xl font-bold text-gray-900">{sessions.length}</p>
          <p className="mt-1 text-sm text-gray-500">
            {sessions.length === RECENT_SESSIONS_LIMIT ? `last ${RECENT_SESSIONS_LIMIT}` : "this period"}
          </p>
        </div>

        {/* Pending Approvals */}
        <Link href="/dashboard/actions" className="block">
          <div className="rounded-lg border border-gray-200 bg-white p-6 hover:border-blue-300">
            <h3 className="text-sm font-medium text-gray-500">Pending Approvals</h3>
            <p className="mt-2 text-3xl font-bold text-gray-900">{pendingCount}</p>
            <p className="mt-1 text-sm text-gray-500">actions awaiting review</p>
          </div>
        </Link>

        {/* Usage */}
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="text-sm font-medium text-gray-500">
            Usage ({usage?.plan ?? "free"} plan)
          </h3>
          <p className="mt-2 text-3xl font-bold text-gray-900">
            {(usage?.hoursUsed ?? 0).toFixed(1)}h
          </p>
          <p className="mt-1 text-sm text-gray-500">
            of {usage?.hoursLimit ?? 1}h used ({(usage?.hoursRemaining ?? 1).toFixed(1)}h remaining)
          </p>
          <div className="mt-3 h-2 w-full rounded-full bg-gray-200">
            <div
              className="h-2 rounded-full bg-blue-600"
              style={{ width: `${usagePercent}%` }}
            />
          </div>
        </div>
      </div>

      {/* Recent sessions list */}
      {sessions.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-800">Recent Sessions</h2>
            <Link href="/dashboard/sessions" className="text-sm text-blue-600 hover:underline">
              View all
            </Link>
          </div>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="pb-2 font-medium text-gray-500">Date</th>
                <th className="pb-2 font-medium text-gray-500">Duration</th>
                <th className="pb-2 font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id} className="border-b border-gray-100">
                  <td className="py-3">
                    <Link
                      href={`/dashboard/sessions/${session.id}`}
                      className="text-blue-600 hover:underline"
                    >
                      {new Date(session.startedAt).toLocaleDateString("en-US", DATE_FORMAT)}
                    </Link>
                  </td>
                  <td className="py-3 text-gray-600">
                    {formatDuration(session.durationSeconds)}
                  </td>
                  <td className="py-3 text-gray-600">{session.actionCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
