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
import { Calendar, Check, ChevronRight, Clock, Lock, Mail, Phone, Timer, Zap } from "lucide-react";
import type { SessionSummary, UserSettings } from "@/lib/types";
import type { ActionRow } from "@dublin/tools/src/types";
import { TOOL_LABELS } from "@dublin/tools/src/definitions";
import SendEmailModal from "@/app/dashboard/components/SendEmailModal";
import { useEmailStatus } from "@/contexts/EmailStatusContext";
import {
  getDashboardOnboardingState,
  type DashboardOnboardingStep,
} from "@/lib/dashboard-onboarding";
import { getDashboardErrorMessage } from "@/lib/errors/dashboardErrors";
import {
  buildDashboardErrorFromResponse,
  logAndMapDashboardError,
} from "@/lib/errors/mapDashboardError";

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_VISIBLE_ACTIONS = 10;
const BULK_KEY = "__bulk__";

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

/**
 * Small inline spinner for loading states.
 */
function Spinner() {
  return (
    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
  );
}

const ONBOARDING_STEP_ICONS: Record<
  DashboardOnboardingStep["id"],
  typeof Phone
> = {
  phone: Phone,
  email: Mail,
  pin: Lock,
  schedule: Calendar,
};

// ============================================================================
// COMPONENTS
// ============================================================================

/** Status color mapping for action badges. */
const STATUS_STYLES: Record<string, string> = {
  approved: "bg-blue-100 text-blue-700",
  executed: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
  undone: "bg-gray-100 text-gray-600",
  converted: "bg-blue-100 text-blue-700",
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
 * @param props.processingIds - Set of action IDs currently being processed
 * @param props.onApprove - Callback to approve an action
 * @param props.onReject - Callback to reject an action
 * @param props.onBulk - Callback for bulk approve/reject
 */
function RecentSessionCard({
  session,
  actions,
  processingIds,
  onApprove,
  onReject,
  onBulk,
  onRowClick,
}: {
  session: SessionSummary;
  actions: ActionRow[];
  processingIds: Set<string>;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onBulk: (operation: "approve" | "reject") => void;
  onRowClick: (action: ActionRow) => void;
}) {
  const pendingCount = actions.filter((a) => a.status === "pending").length;
  const isBusy = processingIds.size > 0;
  const isBulkProcessing = processingIds.has(BULK_KEY);

  return (
    <div className="settings-panel">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px 0" }}>Most Recent Session</h2>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>View details and manage actions for your latest email recording.</p>
        </div>
        <Link
          href={`/dashboard/sessions/${session.id}`}
          className="text-[13px] font-medium text-[var(--accent-color)] hover:opacity-80 transition-colors mt-1"
        >
          View full session
        </Link>
      </div>

      {/* Session metadata badges */}
      <div className="mb-5 flex gap-2">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)]" style={{ background: "var(--bg-hover)", border: "1px solid var(--border-color)" }}>
          <Clock size={12} />
          {formatRelativeTime(session.startedAt)}
        </span>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)]" style={{ background: "var(--bg-hover)", border: "1px solid var(--border-color)" }}>
          <Timer size={12} />
          {formatDuration(session.durationSeconds)}
        </span>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)]" style={{ background: "var(--bg-hover)", border: "1px solid var(--border-color)" }}>
          <Zap size={12} />
          {session.actionCount} action{session.actionCount !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Actions for this session */}
      {actions.length > 0 ? (
        <>
          <div className="mb-3 flex items-center justify-between">
            <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
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
          <div
            className={
              actions.length > MAX_VISIBLE_ACTIONS
                ? "max-h-[440px] overflow-y-auto overflow-x-auto"
                : "overflow-x-auto"
            }
          >
            <table className="w-full text-left text-[13px] min-w-[600px] md:min-w-[800px]">
              <thead className="sticky top-0 bg-[var(--bg-surface)]">
                <tr className="border-b border-[var(--border-color)]">
                  <th className="whitespace-nowrap pb-4 pr-6 font-medium text-[var(--text-secondary)]">Tool</th>
                  <th className="pb-4 pr-6 font-medium text-[var(--text-secondary)]">From / To</th>
                  <th className="pb-4 pr-6 font-medium text-[var(--text-secondary)]">Subject</th>
                  <th className="whitespace-nowrap pb-4 font-medium text-[var(--text-secondary)]">Status</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((action) => {
                  const isProcessing = processingIds.has(action.id) || isBulkProcessing;
                  return (
                    <tr
                      key={action.id}
                      className={`border-b border-[var(--border-color)]${action.toolName === "send_email" || action.toolName === "reply_email" ? " cursor-pointer hover:bg-[var(--bg-hover)]" : ""}`}
                      onClick={(e) => {
                        if (action.toolName !== "send_email" && action.toolName !== "reply_email") return;
                        if ((e.target as HTMLElement).closest("button")) return;
                        onRowClick(action);
                      }}
                    >
                      <td className="py-3 pr-6 text-[13px]">{TOOL_LABELS[action.toolName] ?? action.toolName}</td>
                      <td className="max-w-xs truncate py-3 pr-6 text-[var(--text-secondary)]">{getContact(action.arguments)}</td>
                      <td className="max-w-xs truncate py-3 pr-6 text-[var(--text-secondary)]">{getSubject(action.arguments)}</td>
                      <td className="py-3 whitespace-nowrap">
                        {action.status === "pending" ? (
                          <div className="settings-actions !mt-0 !mb-0">
                            <button
                              onClick={() => onApprove(action.id)}
                              disabled={isProcessing}
                              style={{ background: "var(--btn-primary-bg)", color: "var(--btn-primary-text)", padding: "4px 12px", fontSize: 12, fontWeight: 500, border: "none" }}
                              className="hover:bg-[var(--btn-primary-hover)] disabled:opacity-50 transition-colors inline-flex gap-2 items-center"
                            >
                              {isProcessing ? <Spinner /> : "Approve"}
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
                        ) : (
                          <StatusBadge status={action.status} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="text-[13px] text-[var(--text-secondary)]">No actions for this session.</p>
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
    <Link href={`/dashboard/sessions/${session.id}`} style={{ textDecoration: "none" }} className="block">
      <div className="settings-panel hover:border-[var(--text-secondary)] transition-colors cursor-pointer" style={{ marginBottom: 16 }}>
        <div className="flex items-start justify-between">
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 8px 0" }}>
            {new Date(session.startedAt).toLocaleDateString("en-US", DATE_FORMAT)}
          </h2>
          {hasPendingActions && (
            <span style={{ color: "#d29922", fontWeight: 500, fontSize: 13 }}>
              Pending actions
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)]" style={{ background: "var(--bg-hover)", border: "1px solid var(--border-color)" }}>
            <Clock size={12} />
            {formatRelativeTime(session.startedAt)}
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)]" style={{ background: "var(--bg-hover)", border: "1px solid var(--border-color)" }}>
            <Timer size={12} />
            {formatDuration(session.durationSeconds)}
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)]" style={{ background: "var(--bg-hover)", border: "1px solid var(--border-color)" }}>
            <Zap size={12} />
            {session.actionCount} action{session.actionCount !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
    </Link>
  );
}

function OnboardingCard({ settings, emailStatus }: { settings: UserSettings; emailStatus: ReturnType<typeof useEmailStatus>["status"] }) {
  const onboardingState = getDashboardOnboardingState(settings, emailStatus);
  const completionPercent = (onboardingState.requiredCompleted / onboardingState.requiredTotal) * 100;

  if (onboardingState.isComplete) {
    return null;
  }

  return (
    <section className="settings-panel overflow-hidden" style={{ padding: 0 }}>
      <div
        aria-hidden="true"
        className="h-1 w-full"
        style={{ background: "rgba(22, 163, 74, 0.12)" }}
      >
        <div
          className="h-full transition-all duration-300"
          style={{ width: `${completionPercent}%`, background: "#16a34a" }}
        />
      </div>

      <div className="p-6 md:p-6">
        <div className="relative mb-5">
          <div style={{ maxWidth: 560 }}>
            <h2 style={{ margin: "0 0 6px 0" }}>Finish onboarding</h2>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
              You can explore the dashboard first. Finish these setup steps when you&apos;re ready to make calls,
              connect your inbox, and sign in securely.
            </p>
          </div>
          <span
            className="mt-3 inline-flex whitespace-nowrap px-2.5 py-1 text-xs font-medium md:absolute md:right-0 md:top-0 md:mt-0"
            style={{ background: "var(--bg-hover)", border: "1px solid var(--border-color)", color: "var(--text-secondary)" }}
          >
            {onboardingState.requiredCompleted} of {onboardingState.requiredTotal} required complete
          </span>
        </div>

        <div className="flex flex-col gap-3">
          {onboardingState.steps.map((step) => {
            const Icon = ONBOARDING_STEP_ICONS[step.id];
            return (
              <Link
                key={step.id}
                href={step.href}
                className="flex items-center gap-3 border p-3 transition-colors hover:bg-[var(--bg-hover)]"
                style={{ borderColor: "var(--border-color)", color: "inherit", textDecoration: "none" }}
              >
                <div
                  className="flex h-9 w-9 items-center justify-center shrink-0"
                  style={{
                    background: step.complete ? "rgba(22, 163, 74, 0.1)" : "var(--bg-hover)",
                    color: step.complete ? "#15803d" : "var(--text-secondary)",
                  }}
                >
                  {step.complete ? <Check size={16} strokeWidth={2.5} /> : <Icon size={16} strokeWidth={2} />}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2">
                    <span
                      className="text-[13px] font-medium"
                      style={{
                        color: step.complete ? "var(--text-secondary)" : "var(--text-primary)",
                        textDecoration: step.complete ? "line-through" : "none",
                      }}
                    >
                      {step.title}
                    </span>
                    {step.optional && (
                      <span
                        className="px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide"
                        style={{ background: "var(--bg-hover)", color: "var(--text-secondary)" }}
                      >
                        Optional
                      </span>
                    )}
                  </div>
                  <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0 }}>{step.description}</p>
                </div>

                <ChevronRight
                  size={16}
                  strokeWidth={2}
                  className="shrink-0"
                  style={{ color: "var(--text-secondary)" }}
                />
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// RENDER
// ============================================================================

export default function DashboardOverviewPage() {
  const { status: emailStatus } = useEmailStatus();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [allActions, setAllActions] = useState<ActionRow[]>([]);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [selectedAction, setSelectedAction] = useState<ActionRow | null>(null);
  const [isConverting, setIsConverting] = useState(false);

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

  const loadData = useCallback(async () => {
    try {
      const [sessionsRes, actionsRes, settingsRes] = await Promise.all([
        fetch("/api/sessions"),
        fetch("/api/actions"),
        fetch("/api/user/settings"),
      ]);

      if (sessionsRes.ok) {
        const sessionsData: SessionSummary[] = await sessionsRes.json();
        setSessions(sessionsData.slice(0, 3));
      }

      if (actionsRes.ok) {
        const actionsData: ActionRow[] = await actionsRes.json();
        setAllActions(actionsData);
      }

      if (settingsRes.ok) {
        const settingsData: UserSettings = await settingsRes.json();
        setSettings(settingsData);
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
    addProcessing(actionId);
    try {
      const res = await fetch(`/api/actions/${actionId}/approve`, { method: "POST" });
      if (!res.ok) {
        const apiError = await buildDashboardErrorFromResponse(res, {
          code: "ACTION_APPROVE_FAILED",
          error: "Failed to approve action",
        });
        setError(logAndMapDashboardError(apiError, "action-approve", "ACTION_APPROVE_FAILED"));
        return;
      }
      await loadData();
    } catch (err) {
      setError(logAndMapDashboardError(err, "action-approve", "ACTION_APPROVE_FAILED"));
    } finally {
      removeProcessing(actionId);
    }
  };

  const handleReject = async (actionId: string) => {
    addProcessing(actionId);
    try {
      const res = await fetch(`/api/actions/${actionId}/reject`, { method: "POST" });
      if (!res.ok) {
        const apiError = await buildDashboardErrorFromResponse(res, {
          code: "ACTION_REJECT_FAILED",
          error: "Failed to reject action",
        });
        setError(logAndMapDashboardError(apiError, "action-reject", "ACTION_REJECT_FAILED"));
        return;
      }
      await loadData();
    } catch (err) {
      setError(logAndMapDashboardError(err, "action-reject", "ACTION_REJECT_FAILED"));
    } finally {
      removeProcessing(actionId);
    }
  };

  /**
   * Bulk operation: approves or rejects all pending actions for the most recent session
   * via a single POST to /api/actions/bulk.
   * @param operation - "approve" or "reject"
   */
  const handleBulk = async (operation: "approve" | "reject") => {
    const mostRecentSession = sessions[0];
    if (!mostRecentSession) return;

    const pending = allActions.filter(
      (a) => a.sessionId === mostRecentSession.id && a.status === "pending"
    );
    if (pending.length === 0) return;

    addProcessing(BULK_KEY);
    try {
      const res = await fetch("/api/actions/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionIds: pending.map((a) => a.id), operation }),
      });

      if (!res.ok) {
        const apiError = await buildDashboardErrorFromResponse(res, {
          code: "BULK_ACTION_FAILED",
          error: `Failed to ${operation} actions`,
        });
        setError(logAndMapDashboardError(apiError, "action-bulk", "BULK_ACTION_FAILED"));
        return;
      }

      const result = await res.json();
      if (result.failed > 0) {
        console.error("[dashboard-error]", {
          context: "action-bulk",
          error: { operation, result },
        });
        setError(getDashboardErrorMessage("BULK_ACTION_PARTIAL_FAILURE"));
      }

      await loadData();
    } catch (err) {
      setError(logAndMapDashboardError(err, "action-bulk", "BULK_ACTION_FAILED"));
    } finally {
      removeProcessing(BULK_KEY);
    }
  };

  /**
   * Converts a pending send_email or reply_email action to a draft in the user's mailbox.
   * @param actionId - The action ID to convert
   */
  const handleConvertToDraft = async (actionId: string) => {
    setIsConverting(true);
    try {
      const res = await fetch(`/api/actions/${actionId}/convert-to-draft`, { method: "POST" });
      if (!res.ok) {
        const apiError = await buildDashboardErrorFromResponse(res, {
          code: "ACTION_DRAFT_FAILED",
          error: "Failed to convert to draft",
        });
        window.alert(logAndMapDashboardError(apiError, "action-draft", "ACTION_DRAFT_FAILED"));
        return;
      }
      await loadData();
      setSelectedAction(null);
    } catch (err) {
      window.alert(logAndMapDashboardError(err, "action-draft", "ACTION_DRAFT_FAILED"));
    } finally {
      setIsConverting(false);
    }
  };

  /** Approve action from modal, then close */
  const handleModalApprove = async (actionId: string) => {
    await handleApprove(actionId);
    setSelectedAction(null);
  };

  /** Reject action from modal, then close */
  const handleModalReject = async (actionId: string) => {
    await handleReject(actionId);
    setSelectedAction(null);
  };

  if (loading) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="page-header">
          <h1>Overview</h1>
          <p>Manage your Voice Email sessions and activities.</p>
        </div>
        <div className="page-content">
          <p className="text-[13px] text-[var(--text-secondary)]">Loading...</p>
        </div>
      </div>
    );
  }

  const mostRecent = sessions[0] ?? null;
  const previousSessions = sessions.slice(1, 3);
  const showOnboardingCard = settings ? !getDashboardOnboardingState(settings, emailStatus).isComplete : false;

  // Filter actions for the most recent session, sorted: pending first, then oldest first
  const mostRecentActions = mostRecent
    ? sortActions(allActions.filter((a) => a.sessionId === mostRecent.id))
    : [];

  return (
    <div className="flex-1 flex flex-col">
      <div className="page-header">
        <div className="flex items-center justify-between">
          <h1>Overview</h1>
          {!showOnboardingCard && (
            <Link
              href="/dashboard/sessions"
              style={{
                background: "var(--btn-primary-bg)",
                color: "var(--btn-primary-text)",
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 500,
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
              className="hover:opacity-90 transition-opacity"
            >
              All Sessions <span style={{ fontSize: 16 }}>&rsaquo;</span>
            </Link>
          )}
        </div>
        <p>Manage your Voice Email sessions and activities.</p>
      </div>

      <div className="page-content">
        {error && (
          <div className="mb-6 bg-red-50 p-4 text-sm text-red-700">{error}</div>
        )}

        {settings && <OnboardingCard settings={settings} emailStatus={emailStatus} />}

        {!showOnboardingCard && (
          <>
            {/* Most recent session */}
            {mostRecent ? (
              <div className="mb-6">
                <RecentSessionCard
                  session={mostRecent}
                  actions={mostRecentActions}
                  processingIds={processingIds}
                  onApprove={handleApprove}
                  onReject={handleReject}
                  onBulk={handleBulk}
                  onRowClick={setSelectedAction}
                />
              </div>
            ) : (
              <div className="settings-panel">
                <p className="text-[13px] text-[var(--text-secondary)]">No sessions yet.</p>
              </div>
            )}

            {/* Previous sessions */}
            {previousSessions.length > 0 && (
              <div className="mb-6 flex flex-col">
                {previousSessions.map((session) => (
                  <PreviousSessionCard
                    key={session.id}
                    session={session}
                    hasPendingActions={session.pendingActionCount > 0}
                  />
                ))}
              </div>
            )}
          </>
        )}

      </div>

      <SendEmailModal
        action={selectedAction}
        onClose={() => setSelectedAction(null)}
        onApprove={handleModalApprove}
        onReject={handleModalReject}
        onConvert={handleConvertToDraft}
        isProcessing={isConverting || (selectedAction ? processingIds.has(selectedAction.id) : false)}
      />
    </div>
  );
}
