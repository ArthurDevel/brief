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
  UndoRecipe,
  UndoResult,
  ActionRow,
} from "./types";

export { toolDefinitions } from "./definitions";
export type { ToolDefinition } from "./definitions";

export { getDefaultClassification } from "./classification";
export { classifyAction, handleToolCall, executeAction, undoAction } from "./action-queue";
export { storeSecret, retrieveSecret, updateSecret, deleteSecret } from "./vault";
