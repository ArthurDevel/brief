/**
 * Session detail page -- transcript and actions for a single call session.
 *
 * Shows a header with session metadata (date, duration), an actions summary
 * with approve/reject/undo controls, followed by the transcript entries
 * styled by role, interleaved with action cards.
 *
 * Responsibilities:
 * - Fetch session detail from /api/sessions/[id]
 * - Display session header with metadata
 * - Display actions summary with pending/completed sections and bulk actions
 * - Display transcript entries styled by role (user/assistant)
 * - Display actions interleaved in the timeline
 */

"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
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

/**
 * Summarizes action result into a short display string.
 * @param result - The action result object
 * @returns A short summary string
 */
function summarizeResult(result: Record<string, unknown> | null): string {
  if (!result) return "-";

  const entries = Object.entries(result);
  if (entries.length === 0) return "-";

  return entries
    .map(([key, value]) => {
      if (typeof value === "boolean") return `${key}: ${value}`;
      if (typeof value === "string") {
        const truncated = value.length > 30 ? value.substring(0, 30) + "..." : value;
        return `${key}: ${truncated}`;
      }
      return `${key}: ${JSON.stringify(value).substring(0, 30)}`;
    })
    .join(", ");
}

/**
 * Sends a POST request to an action endpoint and reloads session data.
 * @param actionId - The action ID
 * @param endpoint - The endpoint suffix (approve, reject, undo)
 * @returns The response
 */
async function postActionRequest(actionId: string, endpoint: string): Promise<Response> {
  return fetch(`/api/actions/${actionId}/${endpoint}`, { method: "POST" });
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

/**
 * Actions summary section showing pending and completed actions with controls.
 * @param props.actions - All actions for this session
 * @param props.processingId - ID of the action currently being processed, or "bulk" for bulk ops
 * @param props.onApprove - Callback to approve a single action
 * @param props.onReject - Callback to reject a single action
 * @param props.onUndo - Callback to undo a single action
 * @param props.onApproveAll - Callback to approve all pending actions
 * @param props.onRejectAll - Callback to reject all pending actions
 */
function ActionsSummary({
  actions,
  processingId,
  onApprove,
  onReject,
  onUndo,
  onApproveAll,
  onRejectAll,
}: {
  actions: ActionRow[];
  processingId: string | null;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onUndo: (id: string) => void;
  onApproveAll: () => void;
  onRejectAll: () => void;
}) {
  const pendingActions = actions.filter((a) => a.status === "pending");
  const completedActions = actions.filter(
    (a) => a.status === "executed" || a.status === "undone" || a.status === "rejected"
  );

  if (actions.length === 0) return null;

  const isBulkProcessing = processingId === "bulk";

  return (
    <div className="mb-8 space-y-6">
      {/* Pending actions */}
      {pendingActions.length > 0 && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-yellow-800">
              Pending Actions ({pendingActions.length})
            </h2>
            <div className="flex gap-2">
              <button
                onClick={onApproveAll}
                disabled={isBulkProcessing}
                className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                {isBulkProcessing ? "..." : "Approve All"}
              </button>
              <button
                onClick={onRejectAll}
                disabled={isBulkProcessing}
                className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {isBulkProcessing ? "..." : "Reject All"}
              </button>
            </div>
          </div>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-yellow-200">
                <th className="pb-2 font-medium text-yellow-700">Tool</th>
                <th className="pb-2 font-medium text-yellow-700">Arguments</th>
                <th className="pb-2 font-medium text-yellow-700">Created</th>
                <th className="pb-2 font-medium text-yellow-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pendingActions.map((action) => (
                <tr key={action.id} className="border-b border-yellow-100">
                  <td className="py-3 font-mono text-xs">{action.toolName}</td>
                  <td className="py-3 text-gray-600">{summarizeArguments(action.arguments)}</td>
                  <td className="py-3 text-gray-500">
                    {new Date(action.createdAt).toLocaleDateString("en-US", DATE_FORMAT)}
                  </td>
                  <td className="py-3">
                    <div className="flex gap-2">
                      <button
                        onClick={() => onApprove(action.id)}
                        disabled={processingId !== null}
                        className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                      >
                        {processingId === action.id ? "..." : "Approve"}
                      </button>
                      <button
                        onClick={() => onReject(action.id)}
                        disabled={processingId !== null}
                        className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        {processingId === action.id ? "..." : "Reject"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Completed actions */}
      {completedActions.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h2 className="mb-4 text-sm font-semibold text-gray-700">
            Completed Actions ({completedActions.length})
          </h2>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="pb-2 font-medium text-gray-500">Tool</th>
                <th className="pb-2 font-medium text-gray-500">Arguments</th>
                <th className="pb-2 font-medium text-gray-500">Result</th>
                <th className="pb-2 font-medium text-gray-500">Status</th>
                <th className="pb-2 font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody>
              {completedActions.map((action) => (
                <tr key={action.id} className="border-b border-gray-100">
                  <td className="py-3 font-mono text-xs">{action.toolName}</td>
                  <td className="py-3 text-gray-600">{summarizeArguments(action.arguments)}</td>
                  <td className="py-3 text-gray-600">{summarizeResult(action.result)}</td>
                  <td className="py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        action.status === "executed"
                          ? "bg-green-100 text-green-700"
                          : action.status === "undone"
                            ? "bg-yellow-100 text-yellow-700"
                            : "bg-red-100 text-red-700"
                      }`}
                    >
                      {action.status}
                    </span>
                  </td>
                  <td className="py-3">
                    {action.undoRecipe && action.status === "executed" ? (
                      <button
                        onClick={() => onUndo(action.id)}
                        disabled={processingId !== null}
                        className="rounded bg-yellow-600 px-3 py-1 text-xs font-medium text-white hover:bg-yellow-700 disabled:opacity-50"
                      >
                        {processingId === action.id ? "..." : "Undo"}
                      </button>
                    ) : (
                      <span className="text-xs text-gray-400">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// RENDER
// ============================================================================

export default function SessionDetailPage() {
  const params = useParams<{ sessionId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const emailActionHandled = useRef(false);

  const loadSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${params.sessionId}`);
      if (!res.ok) throw new Error("Failed to fetch session");
      const data: SessionDetail = await res.json();
      setSession(data);
      setError(null);
    } catch {
      setError("Failed to load session");
    } finally {
      setLoading(false);
    }
  }, [params.sessionId]);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  // Handle action/actionId query params from email links
  useEffect(() => {
    if (emailActionHandled.current || !session || loading) return;

    const action = searchParams.get("action");
    const actionId = searchParams.get("actionId");
    if (!action || !actionId) return;

    emailActionHandled.current = true;

    // Strip query params from the URL so a refresh doesn't re-trigger
    router.replace(`/dashboard/sessions/${params.sessionId}`);

    if (actionId === "all") {
      handleBulk(action);
    } else {
      handleAction(actionId, action);
    }
  }, [session, loading, searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Handles a single action operation (approve, reject, or undo).
   * @param actionId - The action ID
   * @param endpoint - The API endpoint suffix
   */
  const handleAction = async (actionId: string, endpoint: string) => {
    setProcessingId(actionId);
    try {
      const res = await postActionRequest(actionId, endpoint);
      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? `Failed to ${endpoint} action`);
        return;
      }
      await loadSession();
    } catch {
      setError(`Failed to ${endpoint} action`);
    } finally {
      setProcessingId(null);
    }
  };

  /**
   * Processes all pending actions with the given endpoint (approve or reject).
   * @param endpoint - "approve" or "reject"
   */
  const handleBulk = async (endpoint: string) => {
    if (!session) return;
    const pending = session.actions.filter((a) => a.status === "pending");
    if (pending.length === 0) return;

    setProcessingId("bulk");
    try {
      for (const action of pending) {
        const res = await postActionRequest(action.id, endpoint);
        if (!res.ok) {
          const body = await res.json();
          setError(body.error ?? `Failed to ${endpoint} action ${action.toolName}`);
          break;
        }
      }
      await loadSession();
    } catch {
      setError(`Failed to ${endpoint} all actions`);
    } finally {
      setProcessingId(null);
    }
  };

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
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6">
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

      {/* Actions summary with controls */}
      {error && (
        <div className="mb-6 rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}

      <ActionsSummary
        actions={session.actions}
        processingId={processingId}
        onApprove={(id) => handleAction(id, "approve")}
        onReject={(id) => handleAction(id, "reject")}
        onUndo={(id) => handleAction(id, "undo")}
        onApproveAll={() => handleBulk("approve")}
        onRejectAll={() => handleBulk("reject")}
      />

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
