/**
 * Session detail page -- transcript and actions for a single call session.
 *
 * Shows a header with session metadata (date, duration), followed by
 * the transcript entries styled by role, interleaved with action cards
 * showing when tools were called during the session.
 *
 * Responsibilities:
 * - Fetch session detail from /api/sessions/[id]
 * - Display session header with metadata
 * - Display transcript entries styled by role (user/assistant)
 * - Display actions interleaved in the timeline
 */

"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { SessionDetail, TranscriptEntry } from "@/lib/types";
import type { ActionRow } from "@dublin/tools/src/types";

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
 * @param seconds - Duration in seconds, or null
 * @returns Formatted duration string
 */
function formatDuration(seconds: number | null): string {
  if (seconds === null) return "In progress";

  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);

  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

// ============================================================================
// TYPES
// ============================================================================

/** A timeline item is either a transcript entry or an action. */
interface TimelineItem {
  type: "transcript" | "action";
  timestamp: string;
  data: TranscriptEntry | ActionRow;
}

/**
 * Merges transcript entries and actions into a single timeline sorted by timestamp.
 * @param transcript - Array of transcript entries
 * @param actions - Array of action rows
 * @returns Sorted timeline items
 */
function buildTimeline(transcript: TranscriptEntry[], actions: ActionRow[]): TimelineItem[] {
  const items: TimelineItem[] = [];

  for (const entry of transcript) {
    items.push({ type: "transcript", timestamp: entry.timestamp, data: entry });
  }

  for (const action of actions) {
    items.push({ type: "action", timestamp: action.createdAt, data: action });
  }

  items.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return items;
}

// ============================================================================
// COMPONENTS
// ============================================================================

/**
 * Renders a single transcript entry with role-based styling.
 * @param props.entry - The transcript entry to display
 */
function TranscriptBubble({ entry }: { entry: TranscriptEntry }) {
  const isUser = entry.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[70%] rounded-lg px-4 py-2 text-sm ${
          isUser
            ? "bg-blue-600 text-white"
            : "bg-gray-100 text-gray-800"
        }`}
      >
        <p className="mb-1 text-xs font-medium opacity-70">
          {isUser ? "You" : "Assistant"}
        </p>
        <p>{entry.text}</p>
      </div>
    </div>
  );
}

/**
 * Renders an action card in the timeline.
 * @param props.action - The action row to display
 */
function ActionCard({ action }: { action: ActionRow }) {
  return (
    <div className="flex justify-center">
      <div className="rounded-md border border-gray-300 bg-gray-50 px-4 py-2 text-xs text-gray-600">
        <span className="font-mono font-medium">{action.toolName}</span>
        <span className="ml-2 text-gray-400">({action.status})</span>
      </div>
    </div>
  );
}

// ============================================================================
// RENDER
// ============================================================================

export default function SessionDetailPage() {
  const params = useParams<{ sessionId: string }>();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/sessions/${params.sessionId}`);
        if (!res.ok) throw new Error("Failed to fetch session");
        const data: SessionDetail = await res.json();
        setSession(data);
      } catch {
        setError("Failed to load session");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [params.sessionId]);

  if (loading) {
    return (
      <div>
        <h1 className="mb-8 text-2xl font-bold text-gray-900">Session Detail</h1>
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div>
        <h1 className="mb-8 text-2xl font-bold text-gray-900">Session Detail</h1>
        <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
          {error ?? "Session not found"}
        </div>
      </div>
    );
  }

  const timeline = buildTimeline(session.transcript, session.actions);

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold text-gray-900">Session Detail</h1>

      {/* Session header */}
      <div className="mb-8 rounded-lg border border-gray-200 bg-white p-6">
        <div className="flex gap-8 text-sm text-gray-600">
          <div>
            <span className="font-medium text-gray-500">Date: </span>
            {new Date(session.startedAt).toLocaleDateString("en-US", DATE_FORMAT)}
          </div>
          <div>
            <span className="font-medium text-gray-500">Duration: </span>
            {formatDuration(session.durationSeconds)}
          </div>
          <div>
            <span className="font-medium text-gray-500">Actions: </span>
            {session.actions.length}
          </div>
        </div>
      </div>

      {/* Timeline */}
      <div className="space-y-3">
        {timeline.length === 0 ? (
          <p className="text-sm text-gray-500">No transcript or actions recorded.</p>
        ) : (
          timeline.map((item, index) => (
            <div key={index}>
              {item.type === "transcript" ? (
                <TranscriptBubble entry={item.data as TranscriptEntry} />
              ) : (
                <ActionCard action={item.data as ActionRow} />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
