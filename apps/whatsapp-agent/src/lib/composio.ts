import { llm } from "@livekit/agents";
import type { llm as llmNamespace } from "@livekit/agents";
import { Composio } from "@composio/core";
import type { AgentEnv } from "./env.js";

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

function toToolkitSlug(toolSlug: string): string {
  return toolSlug.split("_")[0]?.toLowerCase() || toolSlug.toLowerCase();
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

export async function createComposioTools(env: AgentEnv): Promise<llmNamespace.ToolContext> {
  const composio = new Composio({
    apiKey: env.composioApiKey
  });
  const toolsByToolkit = env.composioAllowedTools.reduce<Record<string, string[]>>((acc, slug) => {
    const toolkitSlug = toToolkitSlug(slug);
    acc[toolkitSlug] ??= [];
    acc[toolkitSlug].push(slug);
    return acc;
  }, {});
  const connectedAccounts: Record<string, string> = {};
  if (env.composioConnectedAccountId) {
    connectedAccounts.gmail = env.composioConnectedAccountId;
  }
  const session = await composio.create(env.composioUserId, {
    connectedAccounts,
    tools: toolsByToolkit,
    manageConnections: false
  });

  const tools = await Promise.all(
    env.composioAllowedTools.map(async (slug) => {
      const rawTool = await composio.tools.getRawComposioToolBySlug(slug) as RawToolDefinition;
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

  return Object.fromEntries(tools) as llmNamespace.ToolContext;
}
