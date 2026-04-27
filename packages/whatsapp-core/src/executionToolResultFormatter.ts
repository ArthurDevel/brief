/**
 * Shared formatter for WhatsApp execution-tool results.
 *
 * Responsibilities:
 * - Keep large Composio tool payloads small enough for execution-agent context
 * - Recursively format nested COMPOSIO_MULTI_EXECUTE_TOOL results
 * - Mark COMPOSIO_SEARCH_WEB summaries as source pointers, not verified data
 * - Preserve enough metadata for agents to continue with the right follow-up tool
 */

// ============================================================================
// TYPES
// ============================================================================

interface HeaderEntry {
  name?: string;
  value?: string;
}

interface GmailMessage {
  attachmentList?: unknown[];
  display_url?: string;
  labelIds?: string[];
  messageId?: string;
  messageText?: string;
  messageTimestamp?: string;
  payload?: {
    headers?: HeaderEntry[];
  };
  preview?: {
    body?: string;
    subject?: string;
  };
  sender?: string;
  subject?: string;
  threadId?: string;
  to?: string;
}

interface MultiExecuteToolInput {
  arguments?: Record<string, unknown>;
  tool_slug?: string;
}

interface MultiExecuteResult {
  index?: number;
  response?: {
    data?: unknown;
    [key: string]: unknown;
  };
  tool_slug?: string;
  [key: string]: unknown;
}

interface SearchCitation {
  title?: string;
  url?: string;
  [key: string]: unknown;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const COMPOSIO_MULTI_EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";
const COMPOSIO_SEARCH_FETCH_URL_CONTENT = "COMPOSIO_SEARCH_FETCH_URL_CONTENT";
const COMPOSIO_SEARCH_WEB = "COMPOSIO_SEARCH_WEB";
const GMAIL_FETCH_EMAILS = "GMAIL_FETCH_EMAILS";
const GMAIL_LIST_LABELS = "GMAIL_LIST_LABELS";
const GMAIL_SEND_EMAIL = "GMAIL_SEND_EMAIL";
const MAX_TEXT_PREVIEW_LENGTH = 240;

const SEARCH_WEB_SOURCE_VERIFICATION_INSTRUCTION = [
  "This COMPOSIO_SEARCH_WEB result is a search summary, not verified source data.",
  "If the current task requires specific information from a source, call COMPOSIO_SEARCH_FETCH_URL_CONTENT with the relevant citation URL or URLs before using that information in a final answer.",
].join(" ");

// ============================================================================
// MAIN FORMATTER
// ============================================================================

/**
 * Post-processes one tool result data payload before it is shown to an execution agent.
 * @param toolName - Composio tool name that produced the data
 * @param data - Raw result data from Composio
 * @param toolArguments - Original tool arguments used to execute the tool
 * @returns Formatted result data
 */
export function postProcessExecutionToolResultData(
  toolName: string,
  data: unknown,
  toolArguments: Record<string, unknown> = {}
): unknown {
  if (toolName === COMPOSIO_MULTI_EXECUTE_TOOL) {
    return formatMultiExecuteResult(data, toolArguments);
  }

  if (toolName === COMPOSIO_SEARCH_WEB) {
    return formatComposioSearchWebResult(data);
  }

  if (toolName === GMAIL_FETCH_EMAILS) {
    return formatGmailFetchResult(data);
  }

  if (toolName === GMAIL_LIST_LABELS) {
    return formatGmailLabelResult(data);
  }

  if (toolName === GMAIL_SEND_EMAIL) {
    return formatGmailSendResult(data);
  }

  return data;
}

// ============================================================================
// COMPOSIO SEARCH FORMATTERS
// ============================================================================

/**
 * Marks a COMPOSIO_SEARCH_WEB result as a summary that needs source fetching for specifics.
 * @param data - Raw COMPOSIO_SEARCH_WEB data
 * @returns Search data with source-verification guidance
 */
function formatComposioSearchWebResult(data: unknown): unknown {
  if (!isRecord(data)) {
    return data;
  }

  const citationUrls = extractCitationUrls(data);

  return {
    ...data,
    sourceVerification: {
      citationUrls,
      fetchTool: COMPOSIO_SEARCH_FETCH_URL_CONTENT,
      instruction: SEARCH_WEB_SOURCE_VERIFICATION_INSTRUCTION,
      requiredWhen: "the current task requires specific information from a source",
      searchResultType: "summary",
    },
  };
}

/**
 * Recursively post-processes nested COMPOSIO_MULTI_EXECUTE_TOOL results.
 * @param data - Raw multi-execute result data
 * @param toolArguments - Original multi-execute arguments
 * @returns Multi-execute result data with nested outputs formatted
 */
function formatMultiExecuteResult(
  data: unknown,
  toolArguments: Record<string, unknown>
): unknown {
  if (!isRecord(data) || !Array.isArray(data.results)) {
    return data;
  }

  const requestedTools = getMultiExecuteRequestedTools(toolArguments);

  return {
    ...data,
    results: data.results.map((result, arrayIndex) => (
      formatMultiExecuteNestedResult(result, requestedTools, arrayIndex)
    )),
  };
}

/**
 * Post-processes one nested result inside COMPOSIO_MULTI_EXECUTE_TOOL.
 * @param result - Raw nested result
 * @param requestedTools - Original nested tool requests
 * @param arrayIndex - Result array index
 * @returns Formatted nested result
 */
function formatMultiExecuteNestedResult(
  result: unknown,
  requestedTools: MultiExecuteToolInput[],
  arrayIndex: number
): unknown {
  if (!isRecord(result)) {
    return result;
  }

  const typedResult = result as MultiExecuteResult;
  const requestedTool = requestedTools[getResultToolIndex(typedResult, arrayIndex)];
  const nestedToolName = getNestedToolName(typedResult, requestedTool);
  if (!nestedToolName) {
    return result;
  }

  return {
    ...typedResult,
    response: formatNestedResponse(typedResult.response, nestedToolName, requestedTool?.arguments),
  };
}

/**
 * Post-processes a nested Composio response object when it has data.
 * @param response - Nested response object
 * @param nestedToolName - Real nested Composio tool slug
 * @param nestedArguments - Arguments used for the nested tool
 * @returns Formatted nested response
 */
function formatNestedResponse(
  response: MultiExecuteResult["response"],
  nestedToolName: string,
  nestedArguments: Record<string, unknown> | undefined
): MultiExecuteResult["response"] {
  if (!isRecord(response) || !Object.prototype.hasOwnProperty.call(response, "data")) {
    return response;
  }

  return {
    ...response,
    data: postProcessExecutionToolResultData(
      nestedToolName,
      response.data,
      nestedArguments ?? {}
    ),
  };
}

// ============================================================================
// GMAIL FORMATTERS
// ============================================================================

/**
 * Formats Gmail fetch results into a smaller JSON payload.
 * @param data - Raw Gmail fetch data
 * @returns Smaller Gmail fetch payload
 */
function formatGmailFetchResult(data: unknown): unknown {
  if (!isRecord(data)) {
    return data;
  }

  const messages = Array.isArray(data.messages)
    ? (data.messages as GmailMessage[])
    : [];

  return {
    messages: messages.map(summarizeGmailMessage),
    nextPageToken: typeof data.nextPageToken === "string" ? data.nextPageToken : undefined,
    resultSizeEstimate: typeof data.resultSizeEstimate === "number"
      ? data.resultSizeEstimate
      : messages.length,
  };
}

/**
 * Formats Gmail label results into a smaller payload.
 * @param data - Raw Gmail label data
 * @returns Smaller label payload
 */
function formatGmailLabelResult(data: unknown): unknown {
  if (!isRecord(data)) {
    return data;
  }

  const labels = Array.isArray(data.labels)
    ? (data.labels as Array<{ id?: string; name?: string; type?: string }>).map((label) => ({
        id: label.id,
        name: label.name,
        type: label.type,
      }))
    : [];

  return { labels };
}

/**
 * Formats Gmail send results into a smaller payload.
 * @param data - Raw Gmail send data
 * @returns Smaller send payload
 */
function formatGmailSendResult(data: unknown): unknown {
  if (!isRecord(data)) {
    return data;
  }

  return {
    id: data.id,
    threadId: data.threadId,
    labelIds: data.labelIds,
  };
}

/**
 * Maps one Gmail message into a smaller summary payload.
 * @param message - Raw Gmail message payload
 * @returns Simplified message summary
 */
function summarizeGmailMessage(message: GmailMessage): Record<string, unknown> {
  const subject = message.subject?.trim()
    || message.preview?.subject?.trim()
    || extractHeader(message, "subject")
    || "(no subject)";
  const sender = message.sender?.trim() || extractHeader(message, "from") || "Unknown sender";
  const previewSource = message.preview?.body?.trim() || message.messageText?.trim() || "";
  const preview = previewSource
    ? truncate(compactWhitespace(previewSource), MAX_TEXT_PREVIEW_LENGTH)
    : "";

  return {
    id: message.messageId,
    labels: (message.labelIds ?? []).filter((label) => label !== "UNREAD"),
    preview,
    receivedAt: message.messageTimestamp,
    sender,
    subject,
    threadId: message.threadId,
    unread: message.labelIds?.includes("UNREAD") ?? false,
    unsupportedAttachments: Array.isArray(message.attachmentList) && message.attachmentList.length > 0
      ? message.attachmentList.length
      : undefined,
    url: message.display_url,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Returns one named email header value.
 * @param message - Gmail message payload
 * @param name - Target header name
 * @returns Trimmed header value when present
 */
function extractHeader(message: GmailMessage, name: string): string | undefined {
  const target = name.toLowerCase();

  return message.payload?.headers
    ?.find((header) => header.name?.toLowerCase() === target)
    ?.value
    ?.trim();
}

/**
 * Compacts repeated whitespace into single spaces.
 * @param value - Raw text value
 * @returns Cleaned single-line text
 */
function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Extracts citation URLs from common COMPOSIO_SEARCH_WEB result shapes.
 * @param data - Search result data
 * @returns Citation URLs in original order
 */
function extractCitationUrls(data: Record<string, unknown>): string[] {
  const directCitations = Array.isArray(data.citations) ? data.citations : [];
  const nestedResults = isRecord(data.results) ? data.results : {};
  const nestedCitations = Array.isArray(nestedResults.citations) ? nestedResults.citations : [];

  return [...directCitations, ...nestedCitations]
    .map((citation) => isRecord(citation) ? (citation as SearchCitation).url : null)
    .filter((url): url is string => typeof url === "string" && url.trim().length > 0);
}

/**
 * Returns the original nested tool requests from multi-execute arguments.
 * @param toolArguments - Raw multi-execute arguments
 * @returns Original nested tool inputs
 */
function getMultiExecuteRequestedTools(
  toolArguments: Record<string, unknown>
): MultiExecuteToolInput[] {
  if (!Array.isArray(toolArguments.tools)) {
    return [];
  }

  return toolArguments.tools.filter((tool): tool is MultiExecuteToolInput => isRecord(tool));
}

/**
 * Returns the result index used to map a response back to the requested nested tool.
 * @param result - Nested multi-execute result
 * @param arrayIndex - Fallback result array index
 * @returns Requested tool index
 */
function getResultToolIndex(result: MultiExecuteResult, arrayIndex: number): number {
  return typeof result.index === "number" ? result.index : arrayIndex;
}

/**
 * Returns the real nested tool slug for a multi-execute result.
 * @param result - Nested multi-execute result
 * @param requestedTool - Matching original nested tool request
 * @returns Nested tool slug when known
 */
function getNestedToolName(
  result: MultiExecuteResult,
  requestedTool: MultiExecuteToolInput | undefined
): string | null {
  if (typeof result.tool_slug === "string" && result.tool_slug.trim()) {
    return result.tool_slug;
  }

  if (typeof requestedTool?.tool_slug === "string" && requestedTool.tool_slug.trim()) {
    return requestedTool.tool_slug;
  }

  return null;
}

/**
 * Returns whether a value is a non-array object.
 * @param value - Unknown value
 * @returns True when the value is a record
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Truncates a string for compact summaries.
 * @param value - Raw text value
 * @param maxLength - Maximum allowed string length
 * @returns Truncated string
 */
function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}...`;
}
