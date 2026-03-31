/**
 * Type definitions for the tool/action system.
 *
 * Defines the core types used across the action pipeline: tool names,
 * action statuses, classification levels, approval configs, and the
 * data structures for action inputs, results, undo recipes, and DB rows.
 *
 * Responsibilities:
 * - ToolName union of all available tool names
 * - ActionStatus lifecycle states for actions
 * - ActionClassification determines whether an action auto-executes or queues
 * - ToolApprovalConfig per-user override map
 * - ActionInput/ActionResult for the action pipeline
 * - UndoRecipe/UndoResult for reversible actions
 * - ActionRow mirrors the actions DB table
 */

// ============================================================================
// TOOL NAME + STATUS
// ============================================================================

/** All available tool names in the system. */
export type ToolName =
  | "list_inbox"
  | "read_email"
  | "read_thread"
  | "search_emails"
  | "mark_as_read"
  | "draft_email"
  | "delete_email"
  | "archive_email"
  | "send_email"
  | "reply_email"
  | "batch_archive_emails"
  | "batch_delete_emails"
  | "list_folders"
  | "move_to_folder"
  | "save_memory"
  | "submit_feature_request";

/** Lifecycle status of an action in the queue. */
export type ActionStatus = "pending" | "approved" | "executed" | "undone" | "rejected" | "failed";

// ============================================================================
// CLASSIFICATION + APPROVAL
// ============================================================================

/** How an action is classified for approval purposes. */
export type ActionClassification = "read_only" | "mutating_auto" | "mutating_queued";

/**
 * Per-user override map for tool classifications.
 * Keys are tool names, values override the default classification.
 */
export interface ToolApprovalConfig {
  [toolName: string]: ActionClassification;
}

// ============================================================================
// ACTION INPUT + RESULT
// ============================================================================

/** Input to the action pipeline when a tool is called. */
export interface ActionInput {
  userId: string;
  sessionId: string;
  toolName: ToolName;
  arguments: Record<string, unknown>;
}

/** Result returned after processing a tool call. */
export interface ActionResult {
  actionId: string;
  status: ActionStatus;
  result: Record<string, unknown> | null;
  message: string;
}

// ============================================================================
// UNDO SYSTEM
// ============================================================================

/**
 * Serializable recipe describing how to reverse an action.
 * Stored in the actions table as JSONB.
 */
export interface UndoRecipe {
  operation: "move_email" | "delete_draft" | "delete_memory" | "delete_feature_request";
  params: Record<string, unknown>;
}

/** Result of attempting to undo an action. */
export interface UndoResult {
  success: boolean;
  message: string;
}

// ============================================================================
// QUEUED SEND
// ============================================================================

/** A queued outgoing email awaiting approval or already approved. */
export interface QueuedSend {
  to: string;
  subject: string;
  status: string; // "pending" | "approved"
}

// ============================================================================
// ACTION ROW (DB)
// ============================================================================

/** Mirrors the actions table in the database. */
export interface ActionRow {
  id: string;
  userId: string;
  sessionId: string;
  toolName: ToolName;
  arguments: Record<string, unknown>;
  result: Record<string, unknown> | null;
  status: ActionStatus;
  requiresApproval: boolean;
  undoRecipe: UndoRecipe | null;
  undoDeadline: string | null;
  createdAt: string;
  executedAt: string | null;
}
