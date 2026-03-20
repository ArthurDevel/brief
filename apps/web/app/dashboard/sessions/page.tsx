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
      <div>
        <h1 className="mb-8 text-3xl font-extrabold tracking-tight text-black">History</h1>
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-8 text-3xl font-extrabold tracking-tight text-black">History</h1>

      {error && (
        <div className="mb-6 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {sessions.length === 0 ? (
        <p className="text-gray-500">No call sessions yet.</p>
      ) : (
        <div className="border border-gray-200 bg-white p-6">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="pb-2 font-medium text-gray-500">Date/Time</th>
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
                      className="font-medium text-black hover:underline"
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
