/**
 * Modal that displays email action details (send_email or reply_email).
 *
 * Responsibilities:
 * - Show email fields from the action's arguments
 * - For send_email: show To, Subject, Body
 * - For reply_email: show replying-to email ID, Body, Reply All flag
 * - Render body with preserved line breaks (whitespace-pre-wrap)
 * - Offer Approve, Reject, and "Convert to Draft" buttons for pending actions
 * - Close on backdrop click, X button, or Escape key
 */

"use client";

import { useEffect, useCallback } from "react";
import { X } from "lucide-react";
import type { ActionRow } from "@dublin/tools/src/types";

// ============================================================================
// TYPES
// ============================================================================

interface SendEmailModalProps {
  /** The action to display, or null to hide the modal */
  action: ActionRow | null;
  /** Callback to close the modal */
  onClose: () => void;
  /** Callback when "Approve" is clicked, receives the action ID */
  onApprove: (id: string) => void;
  /** Callback when "Reject" is clicked, receives the action ID */
  onReject: (id: string) => void;
  /** Callback when "Convert to Draft" is clicked, receives the action ID */
  onConvert: (id: string) => void;
  /** Whether an async operation (approve, reject, convert) is in progress */
  isProcessing: boolean;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Extracts a string field from action arguments.
 * @param args - The action arguments object
 * @param field - The field name to extract
 * @returns The string value or "-" if not present
 */
function getField(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value === "string" && value.length > 0) return value;
  return "-";
}

// ============================================================================
// COMPONENTS
// ============================================================================

/**
 * Small inline spinner for the converting state.
 */
function Spinner() {
  return (
    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
  );
}

// ============================================================================
// RENDER
// ============================================================================

/**
 * Modal component that displays send_email or reply_email action details.
 * Returns null when no action is selected.
 * @param props - SendEmailModalProps
 * @returns JSX element or null
 */
export default function SendEmailModal({ action, onClose, onApprove, onReject, onConvert, isProcessing }: SendEmailModalProps) {
  // Close on Escape key
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (!action) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [action, handleKeyDown]);

  if (!action) return null;

  const isReply = action.toolName === "reply_email";
  const body = getField(action.arguments, "body");
  const isPending = action.status === "pending";

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      {/* Modal panel */}
      <div
        className="relative w-full max-w-lg mx-4 max-h-[80vh] overflow-y-auto"
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border-color)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4"
          style={{ borderBottom: "1px solid var(--border-color)" }}
        >
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
            {isReply ? "Reply Details" : "Email Details"}
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:opacity-70 transition-opacity"
            style={{ color: "var(--text-secondary)", background: "none", border: "none", cursor: "pointer" }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 flex flex-col gap-4">
          {isReply ? (
            <>
              {/* Replying to email ID */}
              <div>
                <label
                  className="block text-xs font-medium mb-1"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Replying To
                </label>
                <p className="text-[13px] m-0" style={{ color: "var(--text-primary)" }}>
                  Email #{getField(action.arguments, "email_id")}
                </p>
              </div>

              {/* Body field */}
              <div>
                <label
                  className="block text-xs font-medium mb-1"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Body
                </label>
                <p
                  className="text-[13px] m-0 whitespace-pre-wrap"
                  style={{ color: "var(--text-primary)" }}
                >
                  {body}
                </p>
              </div>

              {/* Reply All indicator -- only shown when reply_all is true */}
              {action.arguments.reply_all && (
                <div>
                  <label
                    className="block text-xs font-medium mb-1"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    Reply All
                  </label>
                  <p className="text-[13px] m-0" style={{ color: "var(--text-primary)" }}>
                    Yes
                  </p>
                </div>
              )}
            </>
          ) : (
            <>
              {/* To field */}
              <div>
                <label
                  className="block text-xs font-medium mb-1"
                  style={{ color: "var(--text-secondary)" }}
                >
                  To
                </label>
                <p className="text-[13px] m-0" style={{ color: "var(--text-primary)" }}>
                  {getField(action.arguments, "to")}
                </p>
              </div>

              {/* Subject field */}
              <div>
                <label
                  className="block text-xs font-medium mb-1"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Subject
                </label>
                <p className="text-[13px] m-0" style={{ color: "var(--text-primary)" }}>
                  {getField(action.arguments, "subject")}
                </p>
              </div>

              {/* Body field */}
              <div>
                <label
                  className="block text-xs font-medium mb-1"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Body
                </label>
                <p
                  className="text-[13px] m-0 whitespace-pre-wrap"
                  style={{ color: "var(--text-primary)" }}
                >
                  {body}
                </p>
              </div>
            </>
          )}
        </div>

        {/* Footer -- only show action buttons for pending actions */}
        {isPending && (
          <div
            className="px-6 py-4 flex justify-between items-center"
            style={{ borderTop: "1px solid var(--border-color)" }}
          >
            {/* Approve / Reject */}
            <div className="flex gap-2">
              <button
                onClick={() => onApprove(action.id)}
                disabled={isProcessing}
                style={{
                  background: "var(--btn-primary-bg)",
                  color: "var(--btn-primary-text)",
                  padding: "8px 16px",
                  fontSize: 13,
                  fontWeight: 500,
                  border: "none",
                  cursor: isProcessing ? "not-allowed" : "pointer",
                }}
                className="hover:bg-[var(--btn-primary-hover)] disabled:opacity-50 transition-colors inline-flex gap-2 items-center"
              >
                {isProcessing ? <Spinner /> : "Approve"}
              </button>
              <button
                onClick={() => onReject(action.id)}
                disabled={isProcessing}
                style={{
                  background: "var(--bg-main)",
                  color: "var(--text-primary)",
                  padding: "8px 16px",
                  fontSize: 13,
                  fontWeight: 500,
                  border: "1px solid var(--border-color)",
                  cursor: isProcessing ? "not-allowed" : "pointer",
                }}
                className="hover:bg-[var(--bg-hover)] disabled:opacity-50 transition-colors inline-flex gap-2 items-center"
              >
                Reject
              </button>
            </div>

            {/* Convert to Draft */}
            <button
              onClick={() => onConvert(action.id)}
              disabled={isProcessing}
              style={{
                background: "var(--bg-main)",
                color: "var(--text-primary)",
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 500,
                border: "1px solid var(--border-color)",
                cursor: isProcessing ? "not-allowed" : "pointer",
              }}
              className="hover:bg-[var(--bg-hover)] disabled:opacity-50 transition-colors inline-flex gap-2 items-center"
            >
              {isProcessing ? <Spinner /> : "Convert to Draft"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
