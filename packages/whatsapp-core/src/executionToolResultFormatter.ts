/**
 * Shared execution-tool result post-processing.
 *
 * Responsibilities:
 * - Shrink large tool payloads before they are stored or replayed
 * - Apply tool-specific shaping for Gmail and future toolkit integrations
 * - Keep tool-result post-processing in one shared place for text and voice runtimes
 */

// ============================================================================
// TYPES
// ============================================================================

interface ExecutionToolResultFormatterInputDto {
  toolArguments: Record<string, unknown>;
  toolName: string;
  toolResultData: unknown;
}

interface HeaderEntry {
  name?: string;
  value?: string;
}

interface GmailMessageDto {
  cc?: string;
  display_url?: string;
  labelIds?: string[];
  messageId?: string;
  messageText?: string;
  messageTimestamp?: string;
  payload?: {
    body?: {
      data?: string;
    };
    headers?: HeaderEntry[];
    mimeType?: string;
    parts?: GmailPayloadPartDto[];
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

interface GmailFullMessageDto {
  from: string;
  fullText: string;
  id: string | null;
  receivedAt: string | null;
  subject: string;
  threadId: string | null;
  to: string | null;
  cc: string | null;
}

interface GmailFullThreadDto {
  messages: GmailFullMessageDto[];
  threadId: string | null;
}

interface GmailPayloadPartDto {
  body?: {
    attachmentId?: string;
    data?: string;
  };
  mimeType?: string;
  parts?: GmailPayloadPartDto[];
}

interface GmailMessageSummaryDto {
  from: string;
  id: string | null;
  labels: string[];
  preview: string;
  receivedAt: string | null;
  subject: string;
  threadId: string | null;
  to: string | null;
  unread: boolean;
  url: string | null;
}

interface ComposioRequestedToolDto {
  arguments?: Record<string, unknown>;
  tool_slug?: string;
}

type ExecutionToolResultFormatter = (
  input: ExecutionToolResultFormatterInputDto
) => unknown;

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_GMAIL_PREVIEW_LENGTH = 240;
const MAX_TOOL_RESULT_CHARACTERS = 20000;
const TOOL_RESULT_TRUNCATION_MARKER = "[tool result truncuated due to size constraints]";

const TOOL_RESULT_FORMATTERS: Partial<Record<string, ExecutionToolResultFormatter>> = {
  COMPOSIO_MULTI_EXECUTE_TOOL: formatComposioMultiExecuteToolResult,
  GMAIL_FETCH_EMAILS: formatGmailFetchEmailsResult,
  GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID: formatGmailFetchMessageByMessageIdResult,
  GMAIL_FETCH_MESSAGE_BY_THREAD_ID: formatGmailFetchMessageByThreadIdResult,
  GMAIL_GET_ATTACHMENT: formatGmailGetAttachmentResult,
  GMAIL_LIST_LABELS: formatGmailListLabelsResult,
  GMAIL_SEND_EMAIL: formatGmailSendEmailResult,
};

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Post-processes one tool result payload before it is stored or replayed.
 * @param input - Tool name, arguments, and raw tool result data
 * @returns Tool-specific compacted result data
 */
export function postProcessExecutionToolResultData(
  input: ExecutionToolResultFormatterInputDto
): unknown {
  const formatter = TOOL_RESULT_FORMATTERS[input.toolName];
  const formattedResult = formatter ? formatter(input) : input.toolResultData;
  return truncateToolResultForAgent(formattedResult);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Formats Gmail fetch results into a smaller email-summary payload.
 * @param input - Tool result formatter input
 * @returns Reduced Gmail fetch data
 */
function formatGmailFetchEmailsResult(
  input: ExecutionToolResultFormatterInputDto
): unknown {
  const data = asRecord(input.toolResultData);
  if (!data) {
    return input.toolResultData;
  }

  const messages = Array.isArray(data.messages)
    ? data.messages.filter(isRecord).map(summarizeGmailMessage)
    : [];

  return {
    messages,
    ...(typeof data.nextPageToken === "string"
      ? { nextPageToken: data.nextPageToken }
      : {}),
    resultSizeEstimate:
      typeof data.resultSizeEstimate === "number"
        ? data.resultSizeEstimate
        : messages.length,
  };
}

/**
 * Formats Gmail label-list results into a smaller payload.
 * @param input - Tool result formatter input
 * @returns Reduced Gmail label data
 */
function formatGmailListLabelsResult(
  input: ExecutionToolResultFormatterInputDto
): unknown {
  const data = asRecord(input.toolResultData);
  if (!data) {
    return input.toolResultData;
  }

  const labels = Array.isArray(data.labels)
    ? data.labels.filter(isRecord).map((label) => ({
        id: getOptionalString(label.id),
        name: getOptionalString(label.name),
        type: getOptionalString(label.type),
      }))
    : [];

  return { labels };
}

/**
 * Formats Gmail send results into a smaller payload.
 * @param input - Tool result formatter input
 * @returns Reduced Gmail send data
 */
function formatGmailSendEmailResult(
  input: ExecutionToolResultFormatterInputDto
): unknown {
  const data = asRecord(input.toolResultData);
  if (!data) {
    return input.toolResultData;
  }

  return {
    id: getOptionalString(data.id),
    labelIds: Array.isArray(data.labelIds) ? data.labelIds : [],
    threadId: getOptionalString(data.threadId),
  };
}

/**
 * Formats one full Gmail message fetch into readable email text only.
 * @param input - Tool result formatter input
 * @returns Full Gmail message text plus identifying metadata
 */
function formatGmailFetchMessageByMessageIdResult(
  input: ExecutionToolResultFormatterInputDto
): unknown {
  const data = asRecord(input.toolResultData);
  if (!data) {
    return input.toolResultData;
  }

  return buildFullGmailMessage(data as GmailMessageDto);
}

/**
 * Formats one Gmail thread fetch into full text for each returned message.
 * @param input - Tool result formatter input
 * @returns Full Gmail thread content
 */
function formatGmailFetchMessageByThreadIdResult(
  input: ExecutionToolResultFormatterInputDto
): unknown {
  const data = asRecord(input.toolResultData);
  if (!data) {
    return input.toolResultData;
  }

  const rawMessages = Array.isArray(data.messages)
    ? data.messages.filter(isRecord).map((message) => message as GmailMessageDto)
    : [];
  const messages = rawMessages
    .slice()
    .sort(compareGmailMessagesByTimestamp)
    .map(buildFullGmailMessage);

  return {
    messages,
    threadId: messages[0]?.threadId ?? getOptionalString(data.threadId),
  } satisfies GmailFullThreadDto;
}

/**
 * Formats Gmail attachments as unsupported for agent execution.
 * @returns Unsupported attachment marker
 */
function formatGmailGetAttachmentResult(): string {
  return "attachments not supported yet";
}

/**
 * Formats Composio multi-execute results by shrinking each nested tool result.
 * @param input - Tool result formatter input
 * @returns Reduced multi-execute data
 */
function formatComposioMultiExecuteToolResult(
  input: ExecutionToolResultFormatterInputDto
): unknown {
  const data = asRecord(input.toolResultData);
  if (!data || !Array.isArray(data.results)) {
    return input.toolResultData;
  }

  const requestedTools = getRequestedComposioTools(input.toolArguments);
  const formattedResults = data.results.map((resultEntry, fallbackIndex) =>
    formatComposioMultiExecuteResultEntry(resultEntry, requestedTools, fallbackIndex)
  );

  return {
    ...data,
    results: formattedResults,
  };
}

/**
 * Formats one nested Composio multi-execute result entry.
 * @param resultEntry - One raw result entry from Composio
 * @param requestedTools - Original requested tool descriptors
 * @param fallbackIndex - Array index used when Composio omits the entry index
 * @returns Reduced nested result entry
 */
function formatComposioMultiExecuteResultEntry(
  resultEntry: unknown,
  requestedTools: ComposioRequestedToolDto[],
  fallbackIndex: number
): unknown {
  const entry = asRecord(resultEntry);
  if (!entry) {
    return resultEntry;
  }

  const resultIndex =
    typeof entry.index === "number" && Number.isInteger(entry.index)
      ? entry.index
      : fallbackIndex;
  const requestedTool = requestedTools[resultIndex];
  if (!requestedTool?.tool_slug) {
    return resultEntry;
  }

  const response = asRecord(entry.response);
  if (!response || !Object.prototype.hasOwnProperty.call(response, "data")) {
    return {
      ...entry,
      toolSlug: requestedTool.tool_slug,
    };
  }

  return {
    ...entry,
    toolSlug: requestedTool.tool_slug,
    response: {
      ...response,
      data: postProcessExecutionToolResultData({
        toolArguments: requestedTool.arguments ?? {},
        toolName: requestedTool.tool_slug,
        toolResultData: response.data,
      }),
    },
  };
}

/**
 * Summarizes one Gmail message into a compact replay-safe shape.
 * @param message - Raw Gmail message payload
 * @returns Reduced Gmail message summary
 */
function summarizeGmailMessage(message: Record<string, unknown>): GmailMessageSummaryDto {
  const gmailMessage = message as GmailMessageDto;
  const subject = gmailMessage.subject?.trim()
    || gmailMessage.preview?.subject?.trim()
    || extractHeader(gmailMessage, "subject")
    || "(no subject)";
  const from = getGmailFrom(gmailMessage);
  const to = getGmailTo(gmailMessage);
  const previewSource = gmailMessage.preview?.body?.trim()
    || stripHtml(gmailMessage.messageText?.trim() || "");
  const preview = previewSource
    ? truncate(compactWhitespace(previewSource), MAX_GMAIL_PREVIEW_LENGTH)
    : "";

  return {
    from,
    id: gmailMessage.messageId ?? null,
    labels: Array.isArray(gmailMessage.labelIds)
      ? gmailMessage.labelIds.filter((label) => label !== "UNREAD")
      : [],
    preview,
    receivedAt: gmailMessage.messageTimestamp ?? null,
    subject,
    threadId: gmailMessage.threadId ?? null,
    to,
    unread: gmailMessage.labelIds?.includes("UNREAD") ?? false,
    url: gmailMessage.display_url ?? null,
  };
}

/**
 * Builds one full Gmail message DTO with readable text.
 * @param message - Raw Gmail message payload
 * @returns Full Gmail message content
 */
function buildFullGmailMessage(message: GmailMessageDto): GmailFullMessageDto {
  return {
    cc: getGmailCc(message),
    from: getGmailFrom(message),
    fullText: extractFullEmailText(message),
    id: message.messageId ?? null,
    receivedAt: message.messageTimestamp ?? null,
    subject: getGmailSubject(message),
    threadId: message.threadId ?? null,
    to: getGmailTo(message),
  };
}

/**
 * Extracts the best readable full-text body from one Gmail message payload.
 * @param message - Raw Gmail message payload
 * @returns Readable email text
 */
function extractFullEmailText(message: GmailMessageDto): string {
  const plainTextFromPayload = extractDecodedPayloadText(message.payload, "text/plain");
  if (plainTextFromPayload) {
    return normalizePlainText(plainTextFromPayload);
  }

  const htmlTextFromPayload = extractDecodedPayloadText(message.payload, "text/html");
  if (htmlTextFromPayload) {
    return normalizeHtmlToText(htmlTextFromPayload);
  }

  if (message.messageText?.trim()) {
    return looksLikeHtml(message.messageText)
      ? normalizeHtmlToText(message.messageText)
      : normalizePlainText(message.messageText);
  }

  if (message.preview?.body?.trim()) {
    return normalizePlainText(message.preview.body);
  }

  return "";
}

/**
 * Returns the normalized subject for one Gmail message.
 * @param message - Raw Gmail message payload
 * @returns Message subject
 */
function getGmailSubject(message: GmailMessageDto): string {
  return message.subject?.trim()
    || message.preview?.subject?.trim()
    || extractHeader(message, "subject")
    || "(no subject)";
}

/**
 * Returns the normalized sender for one Gmail message.
 * @param message - Raw Gmail message payload
 * @returns Message sender
 */
function getGmailFrom(message: GmailMessageDto): string {
  return message.sender?.trim()
    || extractHeader(message, "from")
    || "Unknown sender";
}

/**
 * Returns the normalized To recipients for one Gmail message.
 * @param message - Raw Gmail message payload
 * @returns To recipients or null
 */
function getGmailTo(message: GmailMessageDto): string | null {
  return message.to?.trim() || extractHeader(message, "to") || null;
}

/**
 * Returns the normalized Cc recipients for one Gmail message.
 * @param message - Raw Gmail message payload
 * @returns Cc recipients or null
 */
function getGmailCc(message: GmailMessageDto): string | null {
  return message.cc?.trim() || extractHeader(message, "cc") || null;
}

/**
 * Returns the requested nested tools from one Composio multi-execute call.
 * @param toolArguments - Raw outer meta-tool arguments
 * @returns Ordered requested tool descriptors
 */
function getRequestedComposioTools(
  toolArguments: Record<string, unknown>
): ComposioRequestedToolDto[] {
  if (!Array.isArray(toolArguments.tools)) {
    return [];
  }

  return toolArguments.tools.filter(isRecord).map((tool) => ({
    arguments: isRecord(tool.arguments) ? tool.arguments : undefined,
    tool_slug: typeof tool.tool_slug === "string" ? tool.tool_slug : undefined,
  }));
}

/**
 * Sorts Gmail messages by their receive timestamp, oldest first.
 * @param left - Left Gmail message
 * @param right - Right Gmail message
 * @returns Sort order
 */
function compareGmailMessagesByTimestamp(
  left: GmailMessageDto,
  right: GmailMessageDto
): number {
  const leftTimestamp = getGmailMessageSortTimestamp(left);
  const rightTimestamp = getGmailMessageSortTimestamp(right);
  return leftTimestamp - rightTimestamp;
}

/**
 * Returns a sortable timestamp for one Gmail message.
 * @param message - Gmail message payload
 * @returns Milliseconds since epoch, or positive infinity when unavailable
 */
function getGmailMessageSortTimestamp(message: GmailMessageDto): number {
  if (!message.messageTimestamp) {
    return Number.POSITIVE_INFINITY;
  }

  const parsedTimestamp = Date.parse(message.messageTimestamp);
  return Number.isFinite(parsedTimestamp) ? parsedTimestamp : Number.POSITIVE_INFINITY;
}

/**
 * Applies one global size limit to the final agent-visible tool result.
 * @param value - Final formatted tool result
 * @returns Truncated value when the serialized form exceeds the global cap
 */
function truncateToolResultForAgent(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateSerializedToolResult(value);
  }

  const serializedValue = JSON.stringify(value);
  if (serializedValue.length <= MAX_TOOL_RESULT_CHARACTERS) {
    return value;
  }

  return truncateSerializedToolResult(serializedValue);
}

/**
 * Truncates one serialized tool result string to the global cap.
 * @param value - Serialized tool result
 * @returns Truncated serialized result with a marker suffix
 */
function truncateSerializedToolResult(value: string): string {
  if (value.length <= MAX_TOOL_RESULT_CHARACTERS) {
    return value;
  }

  const allowedPrefixLength =
    MAX_TOOL_RESULT_CHARACTERS - TOOL_RESULT_TRUNCATION_MARKER.length - 1;
  if (allowedPrefixLength <= 0) {
    return TOOL_RESULT_TRUNCATION_MARKER;
  }

  return `${value.slice(0, allowedPrefixLength)} ${TOOL_RESULT_TRUNCATION_MARKER}`;
}

/**
 * Extracts one named header value from a Gmail message.
 * @param message - Gmail message payload
 * @param name - Target header name
 * @returns Trimmed header value when present
 */
function extractHeader(message: GmailMessageDto, name: string): string | undefined {
  const targetName = name.toLowerCase();
  return message.payload?.headers
    ?.find((header) => header.name?.toLowerCase() === targetName)
    ?.value?.trim();
}

/**
 * Collapses repeated whitespace into single spaces.
 * @param value - Raw text
 * @returns Cleaned one-line text
 */
function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Removes simple HTML tags from a string.
 * @param value - Raw text or HTML string
 * @returns Plain-text approximation
 */
function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

/**
 * Returns decoded payload text for the requested MIME type when present.
 * @param payload - Gmail payload root
 * @param targetMimeType - MIME type to extract
 * @returns Decoded text body or null
 */
function extractDecodedPayloadText(
  payload: GmailMessageDto["payload"],
  targetMimeType: string
): string | null {
  if (!payload) {
    return null;
  }

  const directMimeType = payload.mimeType?.toLowerCase();
  const directBodyData = payload.body?.data;
  if (directMimeType === targetMimeType && typeof directBodyData === "string") {
    return decodeBase64UrlToUtf8(directBodyData);
  }

  return extractDecodedPayloadPartText(payload.parts ?? [], targetMimeType);
}

/**
 * Recursively searches nested Gmail payload parts for one MIME type.
 * @param parts - Nested Gmail MIME parts
 * @param targetMimeType - MIME type to extract
 * @returns Decoded text body or null
 */
function extractDecodedPayloadPartText(
  parts: GmailPayloadPartDto[],
  targetMimeType: string
): string | null {
  for (const part of parts) {
    const mimeType = part.mimeType?.toLowerCase();
    const partBodyData = part.body?.data;
    if (mimeType === targetMimeType && typeof partBodyData === "string") {
      return decodeBase64UrlToUtf8(partBodyData);
    }

    if (Array.isArray(part.parts) && part.parts.length > 0) {
      const nestedMatch = extractDecodedPayloadPartText(part.parts, targetMimeType);
      if (nestedMatch) {
        return nestedMatch;
      }
    }
  }

  return null;
}

/**
 * Decodes one Gmail base64url body into UTF-8 text.
 * @param value - Gmail base64url-encoded body
 * @returns Decoded UTF-8 text
 */
function decodeBase64UrlToUtf8(value: string): string {
  const normalizedValue = value.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (normalizedValue.length % 4)) % 4;
  const paddedValue = `${normalizedValue}${"=".repeat(paddingLength)}`;
  return Buffer.from(paddedValue, "base64").toString("utf8");
}

/**
 * Returns whether the string looks like HTML.
 * @param value - Raw text value
 * @returns True when the value appears to be HTML
 */
function looksLikeHtml(value: string): boolean {
  return /<[^>]+>/.test(value);
}

/**
 * Normalizes plain text while keeping paragraph breaks readable.
 * @param value - Raw plain-text body
 * @returns Cleaned plain-text body
 */
function normalizePlainText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ \u00A0]+\n/g, "\n")
    .replace(/\n[ \u00A0]+/g, "\n")
    .replace(/[ \u00A0]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Converts HTML email content into readable plain text.
 * @param value - Raw HTML body
 * @returns Readable text body
 */
function normalizeHtmlToText(value: string): string {
  const withoutScripts = value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withLineBreakHints = withoutScripts
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|tr|table|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ");
  const decodedEntities = decodeHtmlEntities(stripHtml(withLineBreakHints));
  return normalizePlainText(decodedEntities);
}

/**
 * Decodes a small set of common HTML entities.
 * @param value - Text containing HTML entities
 * @returns Decoded text
 */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

/**
 * Truncates a string to the requested maximum length.
 * @param value - Raw text
 * @param maxLength - Maximum output length
 * @returns Truncated text
 */
function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Casts an unknown value to a plain record when possible.
 * @param value - Unknown value
 * @returns Plain object record or null
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  return value;
}

/**
 * Returns whether a value is a plain object record.
 * @param value - Unknown value
 * @returns True when the value is a non-array object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Returns a string value when the candidate is a string.
 * @param value - Unknown value
 * @returns String value or null
 */
function getOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
