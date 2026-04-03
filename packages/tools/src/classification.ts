/**
 * Default tool classification logic.
 *
 * Determines whether a tool call is read-only, auto-executed, or queued
 * for manual approval based on the tool name.
 *
 * Responsibilities:
 * - Map each tool name to its default ActionClassification
 * - Provide the getDefaultClassification() lookup function
 */

import type { ToolName, ActionClassification } from "./types";

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_CLASSIFICATIONS: Record<ToolName, ActionClassification> = {
  list_inbox: "read_only",
  read_email: "read_only",
  read_thread: "read_only",
  search_emails: "read_only",
  save_memory: "read_only",
  submit_feature_request: "read_only",
  what_can_you_do: "read_only",
  mark_as_read: "mutating_auto",
  archive_email: "mutating_auto",
  draft_email: "mutating_auto",
  batch_archive_emails: "mutating_auto",
  list_folders: "read_only",
  move_to_folder: "mutating_auto",
  batch_delete_emails: "mutating_queued",
  delete_email: "mutating_queued",
  send_email: "mutating_queued",
  reply_email: "mutating_queued",
  get_newsletter_summary: "mutating_auto",
  set_newsletter_config: "mutating_auto",
};

// ============================================================================
// MAIN LOGIC
// ============================================================================

/**
 * Returns the default classification for a given tool name.
 * @param toolName - The tool to classify
 * @returns The default ActionClassification for this tool
 */
export function getDefaultClassification(toolName: ToolName): ActionClassification {
  return DEFAULT_CLASSIFICATIONS[toolName];
}
