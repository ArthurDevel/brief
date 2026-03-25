/**
 * History page -- list of past call sessions.
 *
 * Shows a table of sessions with date/time, duration, and action count.
 * Each row links to the session detail page.
 *
 * Responsibilities:
 * - Fetch sessions from /api/sessions
 * - Display sessions in a table
 * - Link to individual session detail pages
 */

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { SessionSummary } from "@/lib/types";

// ============================================================================
// CONSTANTS
// ============================================================================

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Formats a duration in seconds to a human-readable string.
 * @param seconds - Duration in seconds, or null if session is still active
 * @returns Formatted duration string (e.g. "5m 30s")
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

export default function HistoryPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/sessions");
        if (!res.ok) throw new Error("Failed to fetch sessions");
        const data: SessionSummary[] = await res.json();
        setSessions(data);
      } catch {
        setError("Failed to load session history");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex-1 flex flex-col h-full">
        <div className="page-header">
          <h1>History</h1>
          <p>Past call sessions and interactions.</p>
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
        <h1>History</h1>
        <p>Past call sessions and interactions.</p>
      </div>

      <div className="page-content">
        {error && (
          <div className="mb-6 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {sessions.length === 0 ? (
          <p className="text-[13px] text-[var(--text-secondary)]">No call sessions yet.</p>
        ) : (
          <div className="settings-panel">
            <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-[var(--border-color)]">
                <th className="pb-2 font-medium text-[var(--text-secondary)]">Date/Time</th>
                <th className="pb-2 font-medium text-[var(--text-secondary)]">Duration</th>
                <th className="pb-2 font-medium text-[var(--text-secondary)]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id} className="border-b border-[var(--border-color)]">
                  <td className="py-3 text-[13px]">
                    <Link
                      href={`/dashboard/sessions/${session.id}`}
                      className="font-medium text-[var(--text-primary)] hover:underline"
                    >
                      {new Date(session.startedAt).toLocaleDateString("en-US", DATE_FORMAT)}
                    </Link>
                  </td>
                  <td className="py-3 text-[var(--text-secondary)]">
                    {formatDuration(session.durationSeconds)}
                  </td>
                  <td className="py-3 text-[var(--text-secondary)]">{session.actionCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </div>
    </div>
  );
}
