/**
 * Composio session helpers for the WhatsApp voice agent.
 *
 * Responsibilities:
 * - Create one Composio session per caller with connected accounts and custom tools
 * - Load session-native tool definitions through `session.tools()`
 * - Adapt Composio's OpenAI-style tool definitions into LiveKit function tools
 */

import { llm } from "@livekit/agents";
import type { llm as llmNamespace } from "@livekit/agents";
import { Composio } from "@composio/core";
import { postProcessExecutionToolResultData } from "@dublin/whatsapp-core";
import type { AgentEnv } from "./env.js";
import { createWhatsAppCustomTools } from "./whatsappCustomTools.js";
import type { WhatsAppCallerContext } from "./whatsappRuntime.js";

// ============================================================================
// TYPES
// ============================================================================

interface ToolExecutionResult {
  data?: unknown;
  error?: unknown;
  logId?: string;
}

interface SessionToolDefinition {
  type?: string;
  function?: {
    description?: string | null;
    name?: string | null;
    parameters?: unknown;
  };
}

interface SessionLike {
  sessionId: string;
  execute: (
    slug: string,
    arguments_: Record<string, unknown>
  ) => Promise<ToolExecutionResult>;
}

/**
 * User-scoped Composio session returned by `composio.create`.
 * Used to execute tools on behalf of the WhatsApp caller.
 */
export type ComposioUserSession = Awaited<ReturnType<Composio["create"]>>;

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Creates a user-scoped Composio session for the caller.
 * The session is required for both tool registration and direct tool execution
 * (for example fetching Gmail context before the main call starts).
 * @param env - Agent environment config
 * @param callerContext - Resolved caller context with connected toolkit accounts
 * @returns Composio user session ready to execute tools
 */
export async function createComposioSession(
  env: AgentEnv,
  callerContext: WhatsAppCallerContext
): Promise<ComposioUserSession> {
  const startedAt = Date.now();
  const toolkitSlugs = Object.keys(callerContext.connectedAccountsByToolkit);
  const customTools = createWhatsAppCustomTools(env, callerContext);

  console.info("[whatsapp-agent] createComposioSession start", {
    supabaseUserId: callerContext.supabaseUserId,
    toolkitSlugs,
    customToolSlugs: customTools.map((tool) => tool.slug),
  });

  const composio = new Composio({
    apiKey: env.composioApiKey,
  });
  const session = await composio.create(callerContext.supabaseUserId, {
    manageConnections: false,
    workbench: {
      enable: false,
    },
    connectedAccounts: callerContext.connectedAccountsByToolkit,
    experimental: {
      customTools,
    },
    ...(toolkitSlugs.length > 0 ? { toolkits: toolkitSlugs } : {}),
  });
  console.info("[whatsapp-agent] createComposioSession complete", {
    supabaseUserId: callerContext.supabaseUserId,
    toolkitSlugs,
    customToolSlugs: customTools.map((tool) => tool.slug),
    hasSession: Boolean(session),
    elapsedMs: Date.now() - startedAt,
  });

  return session;
}

/**
 * Wraps the caller's Composio session tools as LiveKit LLM tools.
 * Reuses the supplied user session so we do not re-authenticate per tool batch.
 * @param env - Agent environment config
 * @param callerContext - Resolved caller context with connected toolkit accounts
 * @param session - Active Composio user session created by `createComposioSession`
 * @returns LiveKit-compatible tool context for the LLM
 */
export async function createComposioTools(
  env: AgentEnv,
  callerContext: WhatsAppCallerContext,
  session: ComposioUserSession
): Promise<llmNamespace.ToolContext> {
  const startedAt = Date.now();
  const toolkitSlugs = Object.keys(callerContext.connectedAccountsByToolkit);
  console.info("[whatsapp-agent] createComposioTools start", {
    supabaseUserId: callerContext.supabaseUserId,
    toolkitSlugs,
  });

  const composio = new Composio({
    apiKey: env.composioApiKey,
  });

  const toolLoadStartedAt = Date.now();
  const sessionTools = (await session.tools()) as SessionToolDefinition[];
  const registeredCustomTools = session.customTools().map((tool) => tool.slug);
  console.info("[whatsapp-agent] session.tools complete", {
    supabaseUserId: callerContext.supabaseUserId,
    sessionToolCount: sessionTools.length,
    sessionToolNames: sessionTools
      .map((tool) => tool.function?.name?.trim())
      .filter((toolName): toolName is string => Boolean(toolName)),
    registeredCustomTools,
    elapsedMs: Date.now() - toolLoadStartedAt,
    totalElapsedMs: Date.now() - startedAt,
  });

  if (sessionTools.length === 0) {
    throw new Error("Composio did not return any tools for this caller.");
  }

  const tools = mapSessionToolsToLiveKitTools(sessionTools, composio, session);
  console.info("[whatsapp-agent] tool registration complete", {
    supabaseUserId: callerContext.supabaseUserId,
    registeredToolCount: Object.keys(tools).length,
    registeredToolKeys: Object.keys(tools),
    totalElapsedMs: Date.now() - startedAt,
  });

  return tools;
}

/**
 * Converts session-native Composio tools into the LiveKit tool registry.
 * @param sessionTools - OpenAI-style tool definitions returned by `session.tools()`
 * @param composio - Composio SDK client used for meta-tool execution
 * @param session - Composio session used to execute tool calls
 * @returns LiveKit tool context keyed by the Composio tool name
 */
export function mapSessionToolsToLiveKitTools(
  sessionTools: SessionToolDefinition[],
  composio: Composio,
  session: SessionLike
): llmNamespace.ToolContext {
  const toolEntries = sessionTools.map((tool) => {
    const slug = tool.function?.name?.trim();
    if (!slug) {
      throw new Error("Composio returned a session tool without a function name.");
    }

    return [
      slug,
      llm.tool({
        description: normalizeToolDescription(tool, slug),
        parameters: normalizeParametersSchema(tool),
        execute: async (rawArguments) => {
          const result = isComposioMetaTool(slug)
            ? await composio.tools.executeMetaTool(slug, {
                sessionId: session.sessionId,
                arguments: (rawArguments ?? {}) as Record<string, unknown>,
              })
            : await session.execute(
                slug,
                (rawArguments ?? {}) as Record<string, unknown>
              );

          return formatToolResult(
            slug,
            (rawArguments ?? {}) as Record<string, unknown>,
            result
          );
        },
      }),
    ] as const;
  });

  return Object.fromEntries(toolEntries) as llmNamespace.ToolContext;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Returns the JSON schema for one session-native tool.
 * @param tool - One OpenAI-style session tool definition
 * @returns JSON schema compatible with LiveKit tools
 */
function normalizeParametersSchema(tool: SessionToolDefinition): Record<string, unknown> {
  const candidate = tool.function?.parameters;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return candidate as Record<string, unknown>;
  }

  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

/**
 * Returns a safe fallback description for one session-native tool.
 * @param tool - One OpenAI-style session tool definition
 * @param slug - Composio tool slug
 * @returns Final tool description for LiveKit
 */
function normalizeToolDescription(tool: SessionToolDefinition, slug: string): string {
  return tool.function?.description?.trim() || `Execute the Composio tool ${slug}.`;
}

/**
 * Returns whether one session tool is a Composio meta tool.
 * @param toolSlug - Tool slug exposed by Composio
 * @returns True when the tool should execute through `executeMetaTool`
 */
function isComposioMetaTool(toolSlug: string): boolean {
  return toolSlug.startsWith("COMPOSIO_");
}

/**
/**
 * Formats selected Composio tool results into smaller spoken-friendly payloads.
 * @param toolSlug - Executed Composio tool slug
 * @param toolArguments - Tool arguments used for execution
 * @param result - Raw Composio execution result
 * @returns Stringified result payload for the LLM
 */
function formatToolResult(
  toolSlug: string,
  toolArguments: Record<string, unknown>,
  result: ToolExecutionResult
): string {
  if (result.error) {
    return JSON.stringify(result);
  }

  return JSON.stringify(
    postProcessExecutionToolResultData({
      toolArguments,
      toolName: toolSlug,
      toolResultData: result.data ?? result,
    })
  );
}
