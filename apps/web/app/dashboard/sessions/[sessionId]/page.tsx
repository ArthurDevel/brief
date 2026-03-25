/**
 * Session detail page -- transcript and actions for a single call session.
 *
 * Shows a header with session metadata (date, duration), a unified actions
 * table with approve/reject/undo controls and bulk actions, followed by
 * the transcript entries styled by role, interleaved with action cards.
 *
 * Responsibilities:
 * - Fetch session detail from /api/sessions/[id]
 * - Display session header with metadata
 * - Display unified actions table (pending first, then completed) with bulk actions
 * - Display transcript entries styled by role (user/assistant)
 * - Display actions interleaved in the timeline
 */

"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import type { SessionDetail, TranscriptEntry } from "@/lib/types";
import type { ActionRow } from "@dublin/tools/src/types";
import { TOOL_LABELS } from "@dublin/tools/src/definitions";

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

const BULK_KEY = "__bulk__";
const MAX_VISIBLE_ROWS = 10;

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
 * Sends a POST request to an action endpoint.
 * @param actionId - The action ID
 * @param endpoint - The endpoint suffix (approve, reject, undo)
 * @returns The response
 */
async function postActionRequest(actionId: string, endpoint: string): Promise<Response> {
  return fetch(`/api/actions/${actionId}/${endpoint}`, { method: "POST" });
}

/**
 * Sorts actions: pending first, then by createdAt ascending.
 * @param actions - Array of actions to sort
 * @returns Sorted copy of the array
 */
function sortActions(actions: ActionRow[]): ActionRow[] {
  return [...actions].sort((a, b) => {
    const aIsPending = a.status === "pending" ? 0 : 1;
    const bIsPending = b.status === "pending" ? 0 : 1;
    if (aIsPending !== bIsPending) return aIsPending - bIsPending;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
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
        className={`max-w-[70%] px-4 py-2 text-sm ${
          isUser
            ? "bg-black text-white"
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
    <div className="flex justify-start">
      <div className="border border-gray-300 bg-gray-50 px-4 py-2 text-xs text-gray-600">
        <span className="font-medium">{TOOL_LABELS[action.toolName] ?? action.toolName}</span>
        <span className="ml-2 text-gray-400">({action.status})</span>
      </div>
    </div>
  );
}

/** Status color mapping for action badges. */
const STATUS_STYLES: Record<string, string> = {
  executed: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
  undone: "bg-yellow-100 text-yellow-700",
};

/**
 * Unified actions table showing all actions sorted with pending first.
 * Pending rows show approve/reject buttons, completed rows show status badge + optional undo.
 * @param props.actions - All actions for this session
 * @param props.processingIds - Set of action IDs currently being processed
 * @param props.onApprove - Callback to approve a single action
 * @param props.onReject - Callback to reject a single action
 * @param props.onUndo - Callback to undo a single action
 * @param props.onBulk - Callback for bulk approve/reject
 */
function ActionsSummary({
  actions,
  processingIds,
  onApprove,
  onReject,
  onUndo,
  onBulk,
}: {
  actions: ActionRow[];
  processingIds: Set<string>;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onUndo: (id: string) => void;
  onBulk: (operation: "approve" | "reject") => void;
}) {
  if (actions.length === 0) return null;

  const sorted = sortActions(actions);
  const pendingCount = actions.filter((a) => a.status === "pending").length;
  const isBulkProcessing = processingIds.has(BULK_KEY);
  const isBusy = processingIds.size > 0;

  return (
    <div className="settings-panel mb-8">
      <div className="mb-4 flex items-center justify-between">
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px 0" }}>
          Actions ({actions.length}){pendingCount > 0 && ` -- ${pendingCount} pending`}
        </h2>
        {pendingCount > 0 && (
          <div className="settings-actions !mt-0 !mb-0">
            <button
              onClick={() => onBulk("approve")}
              disabled={isBusy}
              style={{ background: "var(--btn-primary-bg)", color: "var(--btn-primary-text)", padding: "8px 16px", fontSize: 13, fontWeight: 500, border: "none" }}
              className="hover:bg-[var(--btn-primary-hover)] disabled:opacity-50 transition-colors inline-flex gap-2 items-center"
            >
              {isBulkProcessing ? <Spinner /> : "Approve All"}
            </button>
            <button
              onClick={() => onBulk("reject")}
              disabled={isBusy}
              style={{ background: "var(--btn-primary-bg)", color: "var(--btn-primary-text)", padding: "8px 16px", fontSize: 13, fontWeight: 500, border: "none" }}
              className="hover:bg-[var(--btn-primary-hover)] disabled:opacity-50 transition-colors inline-flex gap-2 items-center"
            >
              {isBulkProcessing ? <Spinner /> : "Reject All"}
            </button>
          </div>
        )}
      </div>
      <div className={sorted.length > MAX_VISIBLE_ROWS ? "max-h-[440px] overflow-y-auto" : ""}>
      <table className="w-full text-left text-[13px]">
        <thead className="sticky top-0 bg-white">
          <tr className="border-b border-[var(--border-color)]">
            <th className="whitespace-nowrap pb-2 font-medium text-[var(--text-secondary)]">Tool</th>
            <th className="pb-2 font-medium text-[var(--text-secondary)]">From / To</th>
            <th className="pb-2 font-medium text-[var(--text-secondary)]">Subject</th>
            <th className="whitespace-nowrap pb-2 font-medium text-[var(--text-secondary)]">Status</th>
            <th className="whitespace-nowrap pb-2 font-medium text-[var(--text-secondary)]">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((action) => {
            const isProcessing = processingIds.has(action.id) || isBulkProcessing;
            const isPending = action.status === "pending";

            return (
              <tr key={action.id} className="border-b border-[var(--border-color)]">
                <td className="py-3 text-[13px]">{TOOL_LABELS[action.toolName] ?? action.toolName}</td>
                <td className="max-w-xs truncate py-3 text-[var(--text-secondary)]">{getContact(action.arguments)}</td>
                <td className="max-w-xs truncate py-3 text-[var(--text-secondary)]">{getSubject(action.arguments)}</td>
                <td className="py-3">
                  {isPending ? (
                    <span className="bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">
                      pending
                    </span>
                  ) : (
                    <span
                      className={`px-2 py-0.5 text-xs font-bold ${
                        STATUS_STYLES[action.status] ?? "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {action.status}
                    </span>
                  )}
                </td>
                <td className="py-3">
                  {isPending ? (
                    <div className="settings-actions !mt-0 !mb-0">
                      <button
                        onClick={() => onApprove(action.id)}
                        disabled={isProcessing}
                        style={{ background: "var(--btn-primary-bg)", color: "var(--btn-primary-text)", padding: "4px 12px", fontSize: 12, fontWeight: 500, border: "none" }}
                        className="hover:bg-[var(--btn-primary-hover)] disabled:opacity-50 transition-colors inline-flex gap-2 items-center"
                      >
                        {processingIds.has(action.id) ? <Spinner /> : "Approve"}
                      </button>
                      <button
                        onClick={() => onReject(action.id)}
                        disabled={isProcessing}
                        style={{ background: "var(--bg-main)", color: "var(--text-primary)", padding: "4px 12px", fontSize: 12, fontWeight: 500, border: "1px solid var(--border-color)" }}
                        className="hover:bg-[var(--bg-hover)] disabled:opacity-50 transition-colors inline-flex gap-2 items-center"
                      >
                        Reject
                      </button>
                    </div>
                  ) : action.undoRecipe && action.status === "executed" ? (
                    <div className="settings-actions !mt-0 !mb-0">
                      <button
                        onClick={() => onUndo(action.id)}
                        disabled={isProcessing}
                        style={{ background: "var(--bg-main)", color: "var(--text-primary)", padding: "4px 12px", fontSize: 12, fontWeight: 500, border: "1px solid var(--border-color)" }}
                        className="hover:bg-[var(--bg-hover)] disabled:opacity-50 transition-colors inline-flex gap-2 items-center"
                      >
                        {processingIds.has(action.id) ? <Spinner /> : "Undo"}
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs text-gray-400">-</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
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
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const emailActionHandled = useRef(false);

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
      handleBulk(action as "approve" | "reject");
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
    addProcessing(actionId);
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
      removeProcessing(actionId);
    }
  };

  /**
   * Processes all pending actions with the given operation (approve or reject).
   * @param operation - "approve" or "reject"
   */
  const handleBulk = async (operation: "approve" | "reject") => {
    if (!session) return;
    const pending = session.actions.filter((a) => a.status === "pending");
    if (pending.length === 0) return;

    addProcessing(BULK_KEY);
    try {
      for (const action of pending) {
        const res = await postActionRequest(action.id, operation);
        if (!res.ok) {
          const body = await res.json();
          setError(body.error ?? `Failed to ${operation} action ${action.toolName}`);
          break;
        }
      }
      await loadSession();
    } catch {
      setError(`Failed to ${operation} all actions`);
    } finally {
      removeProcessing(BULK_KEY);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col h-full">
        <div style={{ padding: "48px 64px 24px", flexShrink: 0 }}>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-0.5px", margin: 0 }}>Session Detail</h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4, margin: 0 }}>View transcripts and actions for this session.</p>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 64px 48px" }}>
          <p className="text-[13px] text-[var(--text-secondary)]">Loading...</p>
        </div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="flex-1 flex flex-col h-full">
        <div style={{ padding: "48px 64px 24px", flexShrink: 0 }}>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-0.5px", margin: 0 }}>Session Detail</h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4, margin: 0 }}>View transcripts and actions for this session.</p>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 64px 48px" }}>
          <div className="bg-red-50 p-4 text-sm text-red-700">
            {error ?? "Session not found"}
          </div>
        </div>
      </div>
    );
  }

  const timeline = buildTimeline(session.transcript, session.actions);

  return (
    <div className="flex-1 flex flex-col h-full">
      <div style={{ padding: "48px 64px 24px", flexShrink: 0 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-0.5px", margin: 0 }}>Session Detail</h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4, margin: 0 }}>View transcripts and actions for this session.</p>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 64px 48px" }}>
        {/* Session header */}
        <div className="settings-panel mb-6">
        <div className="flex gap-8 text-[13px] text-[var(--text-primary)]">
          <div>
            <span className="font-medium text-[var(--text-secondary)]">Date: </span>
            {new Date(session.startedAt).toLocaleDateString("en-US", DATE_FORMAT)}
          </div>
          <div>
            <span className="font-medium text-[var(--text-secondary)]">Duration: </span>
            {formatDuration(session.durationSeconds)}
          </div>
          <div>
            <span className="font-medium text-[var(--text-secondary)]">Actions: </span>
            {session.actions.length}
          </div>
        </div>
      </div>

      {/* Actions summary with controls */}
      {error && (
        <div className="mb-6 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}

      <ActionsSummary
        actions={session.actions}
        processingIds={processingIds}
        onApprove={(id) => handleAction(id, "approve")}
        onReject={(id) => handleAction(id, "reject")}
        onUndo={(id) => handleAction(id, "undo")}
        onBulk={handleBulk}
      />

      {/* Timeline */}
      <div className="settings-panel">
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px 0" }}>Transcript</h2>
        <div className="space-y-3 mt-4">
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
      </div>
    </div>
  );
}
