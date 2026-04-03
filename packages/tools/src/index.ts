/**
 * Barrel export for @dublin/tools package.
 *
 * Re-exports all types, tool definitions, classification logic,
 * action queue handlers, and vault helpers.
 */

export type {
  ToolName,
  ActionStatus,
  ActionClassification,
  ToolApprovalConfig,
  ActionInput,
  ActionResult,
  QueuedSend,
  UndoRecipe,
  UndoResult,
  ActionRow,
  BulkActionResult,
  BulkActionResponse,
} from "./types";

export { toolDefinitions, TOOL_LABELS, CAPABILITIES_MARKDOWN } from "./definitions";
export type { ToolDefinition } from "./definitions";

export { getDefaultClassification } from "./classification";
export {
  classifyAction,
  handleToolCall,
  executeAction,
  convertActionToDraft,
  undoAction,
  bulkExecuteActions,
  fetchPendingEmailIds,
  fetchQueuedSends,
  formatQueuedSends,
} from "./action-queue";
export { storeSecret, retrieveSecret, updateSecret, deleteSecret } from "./vault";
