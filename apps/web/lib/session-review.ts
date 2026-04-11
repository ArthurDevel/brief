/**
 * Shared types and mapping helpers for minimal session review.
 *
 * The public review page only needs a small subset of session/action data.
 * These helpers keep the token-backed API from returning full action arguments
 * or dashboard-only fields.
 *
 * Responsibilities:
 * - Define session review DTOs
 * - Map action rows to safe review rows
 * - Extract display-only contact and subject fields
 */

import { getDefaultClassification, TOOL_LABELS } from "@dublin/tools";
import type { ActionRow, ToolName } from "@dublin/tools";

// ============================================================================
// TYPES
// ============================================================================

export interface SessionReviewAction {
  id: string;
  toolName: ToolName;
  label: string;
  contact: string;
  subject: string;
  status: ActionRow["status"];
  createdAt: string;
}

export interface SessionReviewResponse {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  actions: SessionReviewAction[];
}

// ============================================================================
// MAIN LOGIC
// ============================================================================

/**
 * Returns whether an action should appear in review surfaces.
 * @param toolName - Tool name from the action row
 * @returns True when the tool is not read-only
 */
export function isVisibleReviewAction(toolName: ToolName): boolean {
  return getDefaultClassification(toolName) !== "read_only";
}

/**
 * Maps a raw action row object to the minimal review DTO.
 * @param row - Database action row with snake_case columns
 * @returns Safe action DTO for the review page
 */
export function mapReviewAction(row: Record<string, unknown>): SessionReviewAction {
  const toolName = row.tool_name as ToolName;
  const args = row.arguments as Record<string, unknown>;

  return {
    id: row.id as string,
    toolName,
    label: TOOL_LABELS[toolName] ?? toolName,
    contact: getContact(args),
    subject: getSubject(args),
    status: row.status as ActionRow["status"],
    createdAt: row.created_at as string,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Extracts the display contact from action arguments.
 * @param args - Action arguments
 * @returns Contact text or "-"
 */
function getContact(args: Record<string, unknown>): string {
  const value = (args.from ?? args.to) as string | undefined;
  return value ?? "-";
}

/**
 * Extracts the display subject from action arguments.
 * @param args - Action arguments
 * @returns Subject text or "-"
 */
function getSubject(args: Record<string, unknown>): string {
  const value = args.subject as string | undefined;
  return value ?? "-";
}
