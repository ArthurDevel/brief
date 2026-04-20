import { llm } from "@livekit/agents";
import type { llm as llmNamespace } from "@livekit/agents";
import { Composio } from "@composio/core";
import type { AgentEnv } from "./env.js";
import type { WhatsAppCallerContext } from "./whatsappRuntime.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const TOOL_PAGE_LIMIT = 50;

// ============================================================================
// TYPES
// ============================================================================

interface HeaderEntry {
  name?: string;
  value?: string;
}

interface RawToolDefinition {
  slug?: string;
  name?: string;
  description?: string;
  inputParameters?: unknown;
  parameters?: unknown;
}

interface RawToolListResponse {
  items?: unknown[];
  nextCursor?: string;
  next_cursor?: string;
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

interface ToolExecutionResult {
  data?: unknown;
  error?: unknown;
  logId?: string;
}

interface RawToolListQuery {
  cursor?: string;
  limit: number;
  toolkits: string[];
}

function normalizeParametersSchema(tool: RawToolDefinition): Record<string, unknown> {
  const candidate = tool.inputParameters ?? tool.parameters;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return candidate as Record<string, unknown>;
  }

  return {
    type: "object",
    properties: {},
    additionalProperties: true
  };
}

function normalizeToolDescription(tool: RawToolDefinition, slug: string): string {
  return tool.description?.trim() || `Execute the Composio tool ${slug}.`;
}

function toToolKey(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeRawToolList(response: unknown): RawToolDefinition[] {
  if (Array.isArray(response)) {
    return response as RawToolDefinition[];
  }

  if (
    response
    && typeof response === "object"
    && Array.isArray((response as RawToolListResponse).items)
  ) {
    return (response as RawToolListResponse).items as RawToolDefinition[];
  }

  return [];
}

function getNextCursor(response: unknown): string | null {
  if (!response || typeof response !== "object") {
    return null;
  }

  const nextCursor = (response as RawToolListResponse).nextCursor;
  if (typeof nextCursor === "string" && nextCursor.trim()) {
    return nextCursor.trim();
  }

  const snakeCaseCursor = (response as RawToolListResponse).next_cursor;
  if (typeof snakeCaseCursor === "string" && snakeCaseCursor.trim()) {
    return snakeCaseCursor.trim();
  }

  return null;
}

function extractHeader(message: GmailMessage, name: string): string | undefined {
  const target = name.toLowerCase();
  return message.payload?.headers?.find((header) => header.name?.toLowerCase() === target)?.value?.trim();
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function summarizeGmailMessage(message: GmailMessage): Record<string, unknown> {
  const subject = message.subject?.trim()
    || message.preview?.subject?.trim()
    || extractHeader(message, "subject")
    || "(no subject)";
  const sender = message.sender?.trim() || extractHeader(message, "from") || "Unknown sender";
  const previewSource = message.preview?.body?.trim() || message.messageText?.trim() || "";
  const preview = previewSource ? truncate(compactWhitespace(previewSource), 240) : "";

  return {
    id: message.messageId,
    threadId: message.threadId,
    subject,
    sender,
    preview,
    receivedAt: message.messageTimestamp,
    unread: message.labelIds?.includes("UNREAD") ?? false,
    labels: (message.labelIds ?? []).filter((label) => label !== "UNREAD"),
    url: message.display_url
  };
}

function formatGmailFetchResult(result: ToolExecutionResult): string {
  const data = result.data;
  if (!data || typeof data !== "object") {
    return JSON.stringify(result);
  }

  const messages = Array.isArray((data as { messages?: unknown[] }).messages)
    ? ((data as { messages: unknown[] }).messages as GmailMessage[])
    : [];

  const formatted = {
    messages: messages.map(summarizeGmailMessage),
    nextPageToken:
      typeof (data as { nextPageToken?: unknown }).nextPageToken === "string"
        ? (data as { nextPageToken: string }).nextPageToken
        : undefined,
    resultSizeEstimate:
      typeof (data as { resultSizeEstimate?: unknown }).resultSizeEstimate === "number"
        ? (data as { resultSizeEstimate: number }).resultSizeEstimate
        : messages.length
  };

  return JSON.stringify(formatted);
}

function formatGmailLabelResult(result: ToolExecutionResult): string {
  const data = result.data;
  if (!data || typeof data !== "object") {
    return JSON.stringify(result);
  }

  const labels = Array.isArray((data as { labels?: unknown[] }).labels)
    ? (data as { labels: Array<{ id?: string; name?: string; type?: string }> }).labels.map((label) => ({
        id: label.id,
        name: label.name,
        type: label.type
      }))
    : [];

  return JSON.stringify({ labels });
}

function formatGmailSendResult(result: ToolExecutionResult): string {
  const data = result.data;
  if (!data || typeof data !== "object") {
    return JSON.stringify(result);
  }

  const payload = data as Record<string, unknown>;
  return JSON.stringify({
    id: payload.id,
    threadId: payload.threadId,
    labelIds: payload.labelIds
  });
}

function formatToolResult(toolSlug: string, result: ToolExecutionResult): string {
  if (result.error) {
    return JSON.stringify(result);
  }

  switch (toolSlug) {
    case "GMAIL_FETCH_EMAILS":
      return formatGmailFetchResult(result);
    case "GMAIL_LIST_LABELS":
      return formatGmailLabelResult(result);
    case "GMAIL_SEND_EMAIL":
      return formatGmailSendResult(result);
    default:
      return JSON.stringify(result.data ?? result);
  }
}

/**
 * Loads every raw tool definition for the caller's connected toolkits.
 * @param composio - Composio SDK client
 * @param toolkitSlugs - Connected toolkit slugs for the caller
 * @returns Raw tool definitions keyed by Composio slug
 */
async function getRawToolsForConnectedToolkits(
  composio: Composio,
  toolkitSlugs: string[]
): Promise<RawToolDefinition[]> {
  const toolsBySlug = new Map<string, RawToolDefinition>();
  let cursor: string | undefined;
  let pageNumber = 0;

  do {
    pageNumber += 1;
    const query: RawToolListQuery = {
      toolkits: toolkitSlugs,
      limit: TOOL_PAGE_LIMIT,
    };
    if (cursor) {
      query.cursor = cursor;
    }

    const pageStartedAt = Date.now();
    console.info("[whatsapp-agent] getRawComposioTools begin", {
      pageNumber,
      toolkitSlugs,
      cursor: cursor ?? null,
      limit: TOOL_PAGE_LIMIT,
    });
    const response = await composio.tools.getRawComposioTools(query);
    const pageTools = normalizeRawToolList(response);
    const nextCursor = getNextCursor(response);
    console.info("[whatsapp-agent] getRawComposioTools complete", {
      pageNumber,
      toolkitSlugs,
      toolCount: pageTools.length,
      nextCursor,
      responseKeys:
        response && typeof response === "object"
          ? Object.keys(response as unknown as Record<string, unknown>)
          : [],
      elapsedMs: Date.now() - pageStartedAt,
    });

    for (const tool of pageTools) {
      const slug = tool.slug?.trim();
      if (!slug) {
        continue;
      }

      toolsBySlug.set(slug, tool);
    }

    cursor = nextCursor ?? undefined;
  } while (cursor);

  return Array.from(toolsBySlug.values());
}

export async function createComposioTools(
  env: AgentEnv,
  callerContext: WhatsAppCallerContext
): Promise<llmNamespace.ToolContext> {
  const startedAt = Date.now();
  const toolkitSlugs = Object.keys(callerContext.connectedAccountsByToolkit);
  if (toolkitSlugs.length === 0) {
    throw new Error("No connected Composio accounts were found for this caller.");
  }
  console.info("[whatsapp-agent] createComposioTools start", {
    supabaseUserId: callerContext.supabaseUserId,
    toolkitSlugs,
  });

  const composio = new Composio({
    apiKey: env.composioApiKey
  });
  const sessionStartedAt = Date.now();
  const session = await composio.create(callerContext.supabaseUserId, {
    connectedAccounts: callerContext.connectedAccountsByToolkit,
    toolkits: toolkitSlugs,
    manageConnections: false
  });
  console.info("[whatsapp-agent] composio.create complete", {
    supabaseUserId: callerContext.supabaseUserId,
    toolkitSlugs,
    elapsedMs: Date.now() - sessionStartedAt,
    totalElapsedMs: Date.now() - startedAt,
    hasSession: Boolean(session),
  });

  const discoveryStartedAt = Date.now();
  const rawTools = await getRawToolsForConnectedToolkits(composio, toolkitSlugs);
  console.info("[whatsapp-agent] raw tool discovery complete", {
    supabaseUserId: callerContext.supabaseUserId,
    toolkitSlugs,
    rawToolCount: rawTools.length,
    rawToolSlugs: rawTools.map((tool) => tool.slug).filter(Boolean),
    elapsedMs: Date.now() - discoveryStartedAt,
    totalElapsedMs: Date.now() - startedAt,
  });

  if (rawTools.length === 0) {
    throw new Error("No Composio tools are available for the caller's connected apps.");
  }

  const tools = await Promise.all(
    rawTools.map(async (rawTool) => {
      const slug = rawTool.slug?.trim();
      if (!slug) {
        throw new Error("Composio returned a tool without a slug.");
      }

      const parameters = normalizeParametersSchema(rawTool);

      return [
        toToolKey(slug),
        llm.tool({
          description: normalizeToolDescription(rawTool, slug),
          parameters,
          execute: async (rawArguments) => {
            const result = await session.execute(
              slug,
              (rawArguments ?? {}) as Record<string, unknown>
            ) as ToolExecutionResult;

            return formatToolResult(slug, result);
          }
        })
      ] as const;
    })
  );
  console.info("[whatsapp-agent] tool registration complete", {
    supabaseUserId: callerContext.supabaseUserId,
    registeredToolCount: tools.length,
    registeredToolKeys: tools.map(([toolKey]) => toolKey),
    totalElapsedMs: Date.now() - startedAt,
  });

  return Object.fromEntries(tools) as llmNamespace.ToolContext;
}
