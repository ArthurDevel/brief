/**
 * Shared type definitions for the voice email assistant prototype.
 *
 * - Tool definition interfaces (schema + handler)
 * - OpenAI Realtime event type helpers
 */

// ============================================================================
// TOOL TYPES
// ============================================================================

/** JSON Schema definition for a tool parameter. */
export interface ToolParameterProperty {
  type: string;
  description: string;
  enum?: string[];
}

/** JSON Schema for tool parameters. */
export interface ToolParametersSchema {
  type: "object";
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

/** A tool definition sent to OpenAI Realtime API in session.update. */
export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: ToolParametersSchema;
}

/**
 * A tool with its definition and mock handler.
 * @param definition - The JSON Schema definition sent to OpenAI
 * @param handler - Function that takes parsed arguments and returns a JSON string response
 */
export interface Tool {
  definition: ToolDefinition;
  handler: (args: Record<string, unknown>) => string;
}

// ============================================================================
// OPENAI REALTIME EVENT TYPES (subset used by this prototype)
// ============================================================================

/** A function call item returned by OpenAI in response.output_item.done. */
export interface FunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

/** The response.output_item.done server event. */
export interface OutputItemDoneEvent {
  type: "response.output_item.done";
  item: FunctionCallItem | { type: string };
}
